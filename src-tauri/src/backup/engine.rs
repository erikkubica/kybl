//! The backup engine, without Tauri: the phone offers what it has, the engine says what must go
//! up and where, and uploads one item at a time when the phone hands it over.
//!
//! A run, as the native worker drives it (Android `BackupWorker.kt`, iOS `BackupRunner.swift`):
//! `run_start` → `offer` (in batches, as it enumerates) → `pending` → `upload` per item (or
//! `fail` / `gone` when the phone can't read it) → `run_end`. The same calls serve "Back up now",
//! the periodic and content-change wakeups and the iOS background tasks.

use std::{
    collections::{HashMap, HashSet},
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use bytes::Bytes;
use rusqlite::Connection;

use super::{
    index,
    naming::{self, Context},
    types::*,
};
use crate::storage::{ByteStream, ErrKind, FolderMode, Reopen, SResult, Storage, StorageError, WriteOpts, WriteOutcome, WriteSource};

/// What the engine needs from around it, so tests run it without Tauri or a phone.
#[async_trait]
pub trait Host: Send + Sync + 'static {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>>;
    /// A set's status changed (the `backup-status` event).
    fn emit(&self, _s: &SetStatus) {}
    /// On mobile data or a metered network right now.
    fn metered(&self) -> bool {
        false
    }
}

/// What an upload reads from: an exported file (iOS, folders), or a file descriptor the phone
/// opened (Android MediaStore and SAF documents, streamed without a copy in the cache).
pub enum Source {
    #[cfg_attr(target_os = "android", allow(dead_code))]
    Path(PathBuf),
    #[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
    File(std::fs::File),
}

/// A run in progress (in memory: a run that died with the process simply isn't running).
struct Live {
    stop: Arc<AtomicBool>,
    /// a worker is running the set (the state may say why it waits)
    active: bool,
    state: RunState,
    current: Option<Current>,
    done: u64,
    total: u64,
    error: Option<String>,
    seen: Instant,
}

/// A run nobody has touched for this long was left behind by a worker that died: another may
/// take over.
const STALE: Duration = Duration::from_secs(20 * 60);
/// How many pending items one `pending` call hands out (the next run gets the rest).
pub const PENDING_BATCH: usize = 5000;

pub struct Core {
    db: Mutex<Connection>,
    host: Arc<dyn Host>,
    device: Mutex<String>,
    live: Mutex<HashMap<String, Live>>,
    /// folders already made this session, so each is made once ("profile|root|dir")
    made: Mutex<HashSet<String>>,
    last_emit: Mutex<HashMap<String, Instant>>,
}

fn not_found(id: &str) -> String {
    format!("There's no backup with the id {id}. It may have been removed.")
}

impl Core {
    pub fn new(conn: Connection, host: Arc<dyn Host>) -> Self {
        Self {
            db: Mutex::new(conn),
            host,
            device: Mutex::new(String::new()),
            live: Default::default(),
            made: Default::default(),
            last_emit: Default::default(),
        }
    }

    /// The phone's name, for the `{device}` token.
    pub fn set_device(&self, name: &str) {
        if !name.trim().is_empty() {
            *self.device.lock().unwrap() = name.trim().to_string();
        }
    }

    // ------------------------------------------------------------ sets

    pub fn sets(&self) -> Result<Vec<BackupSet>, String> {
        index::sets(&self.db.lock().unwrap())
    }

    fn set(&self, id: &str) -> Result<BackupSet, String> {
        index::set(&self.db.lock().unwrap(), id)?.ok_or_else(|| not_found(id))
    }

    /// Adds or changes a set. A new one gets an id; its destination folder is tidied.
    pub fn save_set(&self, mut s: BackupSet) -> Result<BackupSet, String> {
        if s.profile_id.is_empty() || s.root.is_empty() {
            return Err("Choose where the backup goes.".into());
        }
        if s.id.is_empty() {
            s.id = uuid::Uuid::new_v4().to_string();
        }
        if s.created == 0 {
            s.created = index::now_ms();
        }
        let p = s.dest_prefix.trim().trim_matches('/');
        s.dest_prefix = if p.is_empty() { String::new() } else { format!("{p}/") };
        if s.template.trim().is_empty() {
            s.template = naming::DEFAULT_TEMPLATE.into();
        }
        index::save_set(&self.db.lock().unwrap(), &s)?;
        if !s.enabled {
            self.cancel(Some(&s.id));
        }
        self.emit_now(&s.id);
        Ok(s)
    }

    pub fn delete_set(&self, id: &str) -> Result<(), String> {
        self.cancel(Some(id));
        self.live.lock().unwrap().remove(id);
        index::delete_set(&self.db.lock().unwrap(), id)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<BackupSet, String> {
        let mut s = self.set(id)?;
        s.enabled = enabled;
        self.save_set(s)
    }

    // ------------------------------------------------------------ status

    pub fn status(&self, id: &str) -> Result<SetStatus, String> {
        let set = self.set(id)?;
        let c = self.db.lock().unwrap();
        let (backed_up, pending, failed) = index::counts(&c, id)?;
        let (last_run, last_error) = index::last_run(&c, id)?;
        drop(c);
        let mut st = SetStatus { set, backed_up, pending, failed, last_run, last_error, ..Default::default() };
        if let Some(l) = self.live.lock().unwrap().get(id) {
            st.state = l.state;
            st.current = l.current.clone();
            st.run_done = l.done;
            st.run_total = l.total;
            if l.error.is_some() {
                st.last_error = l.error.clone();
            }
        }
        if !st.set.enabled && st.state == RunState::Idle {
            st.state = RunState::Paused;
        }
        Ok(st)
    }

    pub fn statuses(&self) -> Result<Vec<SetStatus>, String> {
        self.sets()?.iter().map(|s| self.status(&s.id)).collect()
    }

    fn emit_now(&self, id: &str) {
        self.last_emit.lock().unwrap().insert(id.to_string(), Instant::now());
        if let Ok(st) = self.status(id) {
            self.host.emit(&st);
        }
    }

    /// Progress goes out at most 4 times a second per set.
    fn emit_soon(&self, id: &str) {
        let due = self.last_emit.lock().unwrap().get(id).is_none_or(|t| t.elapsed() >= Duration::from_millis(250));
        if due {
            self.emit_now(id);
        }
    }

    fn with_live<T>(&self, id: &str, f: impl FnOnce(&mut Live) -> T) -> Option<T> {
        self.live.lock().unwrap().get_mut(id).map(|l| {
            l.seen = Instant::now();
            f(l)
        })
    }

    // ------------------------------------------------------------ runs

    /// Starts a run of a set. False when it is paused or another worker is running it.
    pub fn run_start(&self, id: &str) -> Result<bool, String> {
        let set = self.set(id)?;
        if !set.enabled {
            return Ok(false);
        }
        {
            let mut live = self.live.lock().unwrap();
            if let Some(l) = live.get(id)
                && l.active
                && l.seen.elapsed() < STALE
            {
                return Ok(false);
            }
            live.insert(
                id.to_string(),
                Live { stop: Arc::new(AtomicBool::new(false)), active: true, state: RunState::Running, current: None, done: 0, total: 0, error: None, seen: Instant::now() },
            );
        }
        index::run_started(&self.db.lock().unwrap(), id)?;
        self.emit_now(id);
        Ok(true)
    }

    /// Ends a run. `error` says why it stopped early (shown under the set); `state` keeps
    /// "waiting for Wi-Fi" or "needs sign-in" showing after the run.
    pub fn run_end(&self, id: &str, error: Option<String>) -> Result<(), String> {
        let ended = self.live.lock().unwrap().get_mut(id).map(|l| {
            let state = match l.state {
                RunState::Running => RunState::Idle,
                s => s,
            };
            l.state = state;
            l.active = false;
            l.current = None;
            let err = error.clone().or_else(|| l.error.clone());
            l.error = err.clone();
            (state, err)
        });
        let (_, err) = ended.unwrap_or((RunState::Idle, error));
        index::run_ended(&self.db.lock().unwrap(), id, err.as_deref())?;
        self.emit_now(id);
        Ok(())
    }

    /// Stops a set's run (or every run): the upload in flight ends, the phone's loop stops at the
    /// next item.
    pub fn cancel(&self, id: Option<&str>) {
        for (k, l) in self.live.lock().unwrap().iter() {
            if id.is_none_or(|i| i == k) {
                l.stop.store(true, Ordering::Relaxed);
            }
        }
    }

    fn stop_flag(&self, id: &str) -> Arc<AtomicBool> {
        self.live.lock().unwrap().get(id).map(|l| l.stop.clone()).unwrap_or_else(|| Arc::new(AtomicBool::new(false)))
    }

    fn stopped(&self, id: &str) -> bool {
        self.live.lock().unwrap().get(id).is_some_and(|l| l.stop.load(Ordering::Relaxed))
    }

    // ------------------------------------------------------------ offers

    /// The phone's items for a set: what needs uploading (new, or changed since it went up) is
    /// queued and returned with where it goes. Items already backed up, filtered out by the
    /// set's options, or older than "only new from now" are not.
    pub fn offer(&self, id: &str, items: &[Item]) -> Result<Vec<Offer>, String> {
        let set = self.set(id)?;
        if !set.enabled {
            return Ok(vec![]);
        }
        let device = self.device.lock().unwrap().clone();
        let ctx = Context { device: &device };
        let mut out = Vec::new();
        let mut c = self.db.lock().unwrap();
        let tx = c.transaction().map_err(|e| e.to_string())?;
        for item in items {
            if item.source_id.is_empty() {
                continue;
            }
            match item.kind {
                ItemKind::Video if !set.include_videos && set.source.is_camera_roll() => continue,
                ItemKind::LivePhotoVideo if !set.live_photo_video => continue,
                _ => {}
            }
            let vkey = item.version_key();
            let known = index::backed_up(&tx, id, &item.source_id)?;
            let remote = match &known {
                // backed up and unchanged
                Some((v, _)) if *v == vkey => continue,
                // changed since: the new version replaces the one backed up
                Some((_, path)) => path.clone(),
                None => {
                    let when = item.created.or(item.modified).unwrap_or(i64::MAX);
                    if set.since.is_some_and(|since| when < since) {
                        continue;
                    }
                    naming::join(&set.dest_prefix, &naming::render(&set.template, item, &ctx))
                }
            };
            index::queue(&tx, id, item, &vkey, &remote)?;
            out.push(Offer { source_id: item.source_id.clone(), remote_path: remote, name: item.name.clone(), kind: item.kind, size: item.size });
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(c);
        let queued = index::counts(&self.db.lock().unwrap(), id)?.1;
        self.with_live(id, |l| l.total = l.done + queued);
        self.emit_soon(id);
        Ok(out)
    }

    /// Everything the set still has to upload (this run's offers and earlier ones not done yet).
    pub fn pending(&self, id: &str, limit: usize) -> Result<Vec<Offer>, String> {
        let set = self.set(id)?;
        if !set.enabled {
            return Ok(vec![]);
        }
        let list = index::to_upload(&self.db.lock().unwrap(), id, limit.clamp(1, PENDING_BATCH))?;
        self.with_live(id, |l| l.total = l.total.max(l.done + list.len() as u64));
        Ok(list)
    }

    /// The phone couldn't read an item (it says why).
    pub fn fail(&self, id: &str, source_id: &str, error: &str) -> Result<(), String> {
        index::fail(&self.db.lock().unwrap(), id, source_id, error)?;
        self.with_live(id, |l| l.done += 1);
        self.emit_soon(id);
        Ok(())
    }

    /// An item vanished from the phone before it went up: nothing to do.
    pub fn gone(&self, id: &str, source_id: &str) -> Result<(), String> {
        index::forget(&self.db.lock().unwrap(), id, source_id)?;
        self.with_live(id, |l| l.done += 1);
        self.emit_soon(id);
        Ok(())
    }

    pub fn failures(&self, id: &str) -> Result<Vec<Failure>, String> {
        index::failures(&self.db.lock().unwrap(), id, 500)
    }

    pub fn retry_failed(&self, id: &str) -> Result<usize, String> {
        let n = index::retry_failed(&self.db.lock().unwrap(), id)?;
        self.with_live(id, |l| l.error = None);
        self.emit_now(id);
        Ok(n)
    }

    // ------------------------------------------------------------ uploads

    fn set_state(&self, id: &str, state: RunState, error: Option<String>) {
        self.with_live(id, |l| {
            l.state = state;
            if error.is_some() {
                l.error = error;
            }
        });
    }

    /// Uploads one pending item from `src` (`size` bytes, modified `mtime` ms). Where it lands:
    /// - a changed item replaces its earlier version;
    /// - otherwise the planned name, unless something is there: the same size (and not another
    ///   item's backup) counts as this file already backed up (a first run against an existing
    ///   folder adopts it); anything else gets "name (2).ext", "(3)"…
    pub async fn upload(&self, id: &str, source_id: &str, src: Source, size: i64, mtime: Option<i64>) -> UploadResult {
        let r = self.upload_inner(id, source_id, src, size, mtime).await;
        self.with_live(id, |l| l.current = None);
        self.emit_soon(id);
        r
    }

    async fn upload_inner(&self, id: &str, source_id: &str, src: Source, size: i64, mtime: Option<i64>) -> UploadResult {
        let set = match self.set(id) {
            Ok(s) => s,
            Err(e) => return UploadResult::err("skipped", e),
        };
        if !set.enabled || self.stopped(id) {
            return UploadResult::of("cancelled");
        }
        let row = match index::pending_row(&self.db.lock().unwrap(), id, source_id) {
            Ok(Some(r)) => r,
            Ok(None) => return UploadResult::of("skipped"),
            Err(e) => return UploadResult::err("failed", e),
        };
        if set.wifi_only && self.host.metered() {
            self.set_state(id, RunState::WaitingWifi, None);
            return UploadResult::of("waitingWifi");
        }
        let size = if size > 0 { size } else { row.size.max(0) };
        self.with_live(id, |l| {
            l.state = RunState::Running;
            l.current = Some(Current { name: row.name.clone(), done: 0, total: size as u64 });
        });
        self.emit_now(id);

        let dst = match self.host.open(&set.profile_id).await {
            Ok(d) => d,
            Err(e) => return self.classify(id, source_id, e),
        };
        let replacing = index::backed_up(&self.db.lock().unwrap(), id, source_id).ok().flatten().map(|(_, p)| p);
        let target = match &replacing {
            Some(p) => p.clone(),
            None => match self.free_path(&*dst, &set, source_id, &row.remote_path, size).await {
                Ok(Place::Free(p)) => p,
                Ok(Place::Adopt(p)) => {
                    let _ = index::record(&self.db.lock().unwrap(), id, source_id, &row.version_key, &p, size);
                    self.with_live(id, |l| l.done += 1);
                    return UploadResult::at("adopted", &p);
                }
                Err(e) => return self.classify(id, source_id, e),
            },
        };

        if dst.caps().folders == FolderMode::Real {
            let dir = naming::parent(&target).to_string();
            let key = format!("{}|{}|{dir}", set.profile_id, set.root);
            if !dir.is_empty() && !self.made.lock().unwrap().contains(&key) {
                match dst.mkdir(&set.root, &dir).await {
                    Ok(()) => {
                        self.made.lock().unwrap().insert(key);
                    }
                    // already there is fine; anything else shows up in the write below
                    Err(e) if e.kind == ErrKind::Exists => {
                        self.made.lock().unwrap().insert(key);
                    }
                    Err(_) => {}
                }
            }
        }

        let stop = self.stop_flag(id);
        let write_src = match open_source(src, size as u64) {
            Ok(s) => s,
            Err(e) => {
                let _ = index::fail(&self.db.lock().unwrap(), id, source_id, &e.to_string());
                return UploadResult::err("failed", e.to_string());
            }
        };
        let progress = |done: u64, total: u64| {
            self.with_live(id, |l| {
                if let Some(c) = l.current.as_mut() {
                    c.done = done;
                    if total > 0 {
                        c.total = total;
                    }
                }
            });
            self.emit_soon(id);
        };
        let opts = WriteOpts { modified: mtime, ..Default::default() };
        match dst.write(&set.root, &target, write_src, opts, &progress, &stop).await {
            Ok(WriteOutcome::Done(e)) => {
                let landed = if e.size > 0 { e.size } else { size };
                if let Err(err) = index::record(&self.db.lock().unwrap(), id, source_id, &row.version_key, &target, landed) {
                    return UploadResult::err("failed", err);
                }
                self.with_live(id, |l| l.done += 1);
                UploadResult::at("done", &target)
            }
            Ok(WriteOutcome::Cancelled) => UploadResult::of("cancelled"),
            Ok(WriteOutcome::Conflict(_)) => self.classify(id, source_id, StorageError::conflict()),
            Err(e) => self.classify(id, source_id, e),
        }
    }

    /// What an error means for the run: stop and try later (network, sign-in, "Wi-Fi only"), or
    /// record this item as failed and go on with the next.
    fn classify(&self, id: &str, source_id: &str, e: StorageError) -> UploadResult {
        if e.is_cancelled() || self.stopped(id) {
            return UploadResult::of("cancelled");
        }
        let say = e.message.clone();
        match e.kind {
            ErrKind::NeedsAuth => {
                self.set_state(id, RunState::NeedsAuth, Some(say.clone()));
                UploadResult::err("needsAuth", say)
            }
            ErrKind::Network | ErrKind::RateLimited => {
                self.set_state(id, RunState::WaitingNetwork, Some(say.clone()));
                UploadResult::err("retryLater", say)
            }
            _ => {
                let _ = index::fail(&self.db.lock().unwrap(), id, source_id, &say);
                self.with_live(id, |l| l.done += 1);
                UploadResult::err("failed", say)
            }
        }
    }

    async fn free_path(&self, dst: &dyn Storage, set: &BackupSet, source_id: &str, planned: &str, size: i64) -> SResult<Place> {
        for n in 1..=999u32 {
            let path = naming::numbered(planned, n);
            match dst.stat(&set.root, &path).await? {
                None => return Ok(Place::Free(path)),
                Some(e) if e.is_dir() => continue,
                Some(e) => {
                    let claimed = index::path_claimed(&self.db.lock().unwrap(), &set.id, &path, source_id).map_err(StorageError::other)?;
                    if !claimed && size > 0 && e.size == size {
                        return Ok(Place::Adopt(path));
                    }
                }
            }
        }
        Err(StorageError::other("Too many files with this name are already there."))
    }
}

enum Place {
    Free(String),
    /// the same file is already there (name and size): count it as backed up
    Adopt(String),
}

// ---------------------------------------------------------------- reading the source

const CHUNK: usize = 256 * 1024;

// The bandwidth cap is applied by the backends' writers (multipart, s3_stream, net, extras), so
// the source is read as fast as they take it.
fn open_source(src: Source, size: u64) -> io::Result<WriteSource> {
    match src {
        Source::Path(p) => Ok(WriteSource::Path(p)),
        Source::File(f) => from_file(f, size),
    }
}

/// A file descriptor as a write source. A regular file is read with positioned reads, so the
/// upload can re-read any part (S3 sends several parts at once and retries failed ones) without
/// the parts sharing one file offset. Anything else (a pipe from a cloud-backed document) is
/// read once, front to back: it can't resume, which is fine for those.
fn from_file(f: std::fs::File, size: u64) -> io::Result<WriteSource> {
    let meta = f.metadata().ok();
    let regular = meta.as_ref().is_some_and(|m| m.is_file());
    if regular {
        let len = meta.map(|m| m.len()).unwrap_or(size);
        let f = Arc::new(f);
        let body = pread_stream(f.clone(), 0);
        let reopen: Reopen = Box::new(move |off| {
            let f = f.clone();
            Box::pin(async move { Ok(pread_stream(f, off)) })
        });
        return Ok(WriteSource::Stream { len: Some(len), body, reopen: Some(reopen) });
    }
    let file = tokio::fs::File::from_std(f);
    let body: ByteStream = Box::pin(futures_util::stream::unfold(file, |mut f| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; CHUNK];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    }));
    Ok(WriteSource::Stream { len: Some(size).filter(|&s| s > 0), body, reopen: None })
}

/// Reads `f` from `off` to its end with positioned reads.
fn pread_stream(f: Arc<std::fs::File>, off: u64) -> ByteStream {
    Box::pin(futures_util::stream::unfold(Some((f, off)), |st| async move {
        let (f, off) = st?;
        let f2 = f.clone();
        let r = tokio::task::spawn_blocking(move || {
            let mut buf = vec![0u8; CHUNK];
            let n = read_at(&f2, &mut buf, off)?;
            buf.truncate(n);
            Ok::<_, io::Error>(buf)
        })
        .await
        .map_err(io::Error::other)
        .and_then(|r| r);
        match r {
            Ok(buf) if buf.is_empty() => None,
            Ok(buf) => {
                let n = buf.len() as u64;
                Some((Ok(Bytes::from(buf)), Some((f, off + n))))
            }
            Err(e) => Some((Err(e), None)),
        }
    }))
}

#[cfg(unix)]
fn read_at(f: &std::fs::File, buf: &mut [u8], off: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    loop {
        match f.read_at(buf, off) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            r => return r,
        }
    }
}

#[cfg(windows)]
fn read_at(f: &std::fs::File, buf: &mut [u8], off: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    f.seek_read(buf, off)
}
