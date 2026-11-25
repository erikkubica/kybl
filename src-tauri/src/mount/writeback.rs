//! Write-back for a mounted drive: what Finder (or any app) saves lands in a local file first and
//! is uploaded in the background, so saving never waits on the network.
//!
//! - Each saved file becomes a [`Pending`] upload, kept in `app_data_dir/mounts/<id>/uploads/`
//!   with a `pending.json` beside it (app data, not the cache folder: these are the user's only
//!   copy until they're uploaded). Pending uploads survive quitting and carry on next start.
//! - Until it is uploaded, the drive shows the local copy (size, time, contents).
//! - Uploads start shortly after the last save ([`SETTLE`]): Finder creates a file empty and fills
//!   it a moment later, and apps save in several steps. A newer save of the same file replaces
//!   the older one, stopping its upload if one is under way.
//! - Conflicts: each upload remembers what was on the server when the edit began (`base`). If the
//!   server's file changed since, the edit is uploaded beside it as
//!   `name (conflict 2026-11-22 19.30).ext` instead of replacing someone else's work. This is
//!   checked by reading first, which is not atomic, but the store's own conditional writes behave
//!   differently per provider (see BACKENDS.md), so one rule for all is the safer bet.
//! - Failures retry with a growing pause, forever: giving up would lose the user's work.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::storage::{Entry, ErrKind, SResult, Storage, WriteOpts, WriteOutcome, WriteSource};

/// How long a saved file sits still before its upload starts.
pub const SETTLE: Duration = Duration::from_millis(1500);
/// An empty new file waits longer: it is usually filled in a moment.
pub const SETTLE_EMPTY: Duration = Duration::from_secs(20);
/// How long our own upload counts as "what's on the server" when a listing hasn't caught up.
const RECENT: Duration = Duration::from_secs(60);
/// Uploads at a time per drive.
pub const WORKERS: usize = 2;

/// What was on the server when an edit began.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BaseState {
    pub etag: Option<String>,
    pub size: i64,
    pub modified: Option<i64>,
}

impl BaseState {
    pub fn of(e: &Entry) -> Self {
        Self { etag: e.etag.clone(), size: e.size, modified: e.modified }
    }

    /// Still the same file? Etags when both sides have one, else size and time.
    pub fn matches(&self, now: &Entry) -> bool {
        let trim = |s: &str| s.trim_matches('"').to_string();
        match (&self.etag, &now.etag) {
            (Some(a), Some(b)) => trim(a) == trim(b),
            _ => self.size == now.size && (self.modified.is_none() || now.modified.is_none() || self.modified == now.modified),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub root: String,
    pub key: String,
    /// file name inside the uploads folder
    pub file: String,
    pub size: u64,
    /// ms since the epoch
    pub modified: i64,
    /// None: nothing was there when the edit began
    pub base: Option<BaseState>,
    pub seq: u64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(skip)]
    not_before: Option<Instant>,
    #[serde(skip)]
    uploading: bool,
}

/// What happened, for the drive's status line and its listing cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// the queue or an upload's progress changed
    Changed,
    /// `key` is on the server now (or was saved beside it): listings of its folder are stale
    Uploaded { root: String, key: String },
    /// saved under another name because the server's copy changed meanwhile
    Conflict { root: String, key: String, saved_as: String },
}

pub type Listener = Arc<dyn Fn(Event) + Send + Sync>;

#[derive(Default)]
struct State {
    pending: BTreeMap<(String, String), Pending>,
    seq: u64,
    /// our last finished uploads: (root, key) → (what is there now, when)
    recent: HashMap<(String, String), (BaseState, Instant)>,
    /// the uploads under way, one per key at most: a newer save of a key waits for the older
    /// upload to stop before its own starts
    running: HashMap<(String, String), Run>,
}

/// One upload under way.
#[derive(Clone, Default)]
struct Run {
    stop: Arc<AtomicBool>,
    /// bytes it has sent
    sent: Arc<AtomicU64>,
}

pub struct WriteBack {
    dir: PathBuf,
    state: Mutex<State>,
    wake: tokio::sync::Notify,
    stopped: AtomicBool,
    /// bumped by each `stop`: a worker runs only in the generation it started in
    generation: AtomicU64,
    listener: Mutex<Option<Listener>>,
    /// pending.json couldn't be written: the queue lives on in memory, but would not survive a
    /// quit, so the status line says so
    persist_error: Mutex<Option<String>>,
}

/// Where saves are kept aside when Kybl can't tell which file they belong to (pending.json
/// unreadable, or a crash between a save and its record). Never deleted by Kybl.
pub const RECOVERED: &str = "recovered";

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `a/b/name.ext` → `a/b/name (conflict 2026-11-22 19.30).ext`
pub fn conflict_name(key: &str, ms: i64) -> String {
    let (dir, name) = match key.rfind('/') {
        Some(i) => (&key[..=i], &key[i + 1..]),
        None => ("", key),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let secs = ms / 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil(days);
    format!("{dir}{stem} (conflict {y:04}-{m:02}-{d:02} {:02}.{:02}){ext}", rem / 3600, rem % 3600 / 60)
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (UTC).
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// A waiting save's base after its file was moved on the server (a rename of it or of a folder
/// above it). `pre` is what the server had at the old name just before the move, `post` what it
/// has at the new name after it. If the save built on what was there (or nothing was there
/// either way), it now builds on the moved file, whose ETag or time the move may have changed;
/// if someone else had changed the file already, the old base stays, so that edit is still
/// noticed and the save goes up beside it.
pub fn rebase(base: Option<&BaseState>, pre: Option<&Entry>, post: Option<&Entry>) -> Option<BaseState> {
    match (base, pre) {
        (Some(b), Some(pre)) if b.matches(pre) => post.map(BaseState::of),
        (None, None) => post.map(BaseState::of),
        _ => base.cloned(),
    }
}

fn backoff(attempts: u32) -> Duration {
    Duration::from_secs(match attempts {
        0 | 1 => 5,
        2 => 15,
        3 => 60,
        4 => 300,
        _ => 600,
    })
}

impl WriteBack {
    /// Opens the queue in `dir`, picking up what an earlier run left.
    ///
    /// The saved files are the user's only copy until they're uploaded, so nothing that might
    /// be one is ever deleted here: a `pending.json` that can't be read is set aside, and saved
    /// files no record refers to are moved to [`RECOVERED`] instead. Only unfinished saves
    /// (`.part`) are removed.
    pub fn open(dir: PathBuf) -> Self {
        // the user's saves, not uploaded yet: this account only
        let _ = crate::files::filecache::private_dir(&dir);
        let mut st = State::default();
        let json = dir.join("pending.json");
        match std::fs::read(&json) {
            Ok(raw) => match serde_json::from_slice::<Vec<Pending>>(&raw) {
                Ok(list) => {
                    for p in list {
                        if dir.join(&p.file).is_file() {
                            st.seq = st.seq.max(p.seq);
                            st.pending.insert((p.root.clone(), p.key.clone()), p);
                        }
                    }
                }
                Err(e) => {
                    let aside = dir.join(format!("pending.json.bad-{}", now_ms()));
                    eprintln!("drive uploads: pending.json couldn't be read ({e}); set aside, saved files kept in {RECOVERED}/");
                    let _ = std::fs::rename(&json, aside);
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("drive uploads: pending.json couldn't be read ({e}); saved files kept in {RECOVERED}/"),
        }
        let keep: Vec<String> = st.pending.values().map(|p| p.file.clone()).collect();
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if keep.contains(&name) || !e.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let record_tmp = name == "pending.json.tmp" || (name.starts_with(".pending.json.") && name.ends_with(".tmp"));
            if name.ends_with(".part") || record_tmp {
                // a save that never finished (or a record never moved into place)
                let _ = std::fs::remove_file(e.path());
            } else if name.ends_with(".bin") {
                let rec = dir.join(RECOVERED);
                let _ = std::fs::create_dir_all(&rec);
                if let Err(err) = std::fs::rename(e.path(), rec.join(&name)) {
                    eprintln!("drive uploads: couldn't keep {name} aside: {err}");
                }
            }
        }
        Self {
            dir,
            state: Mutex::new(st),
            wake: Default::default(),
            stopped: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            listener: Mutex::new(None),
            persist_error: Mutex::new(None),
        }
    }

    /// Saved files kept aside in [`RECOVERED`] (see [`open`](Self::open)).
    pub fn recovered(&self) -> usize {
        std::fs::read_dir(self.dir.join(RECOVERED)).map(|rd| rd.flatten().count()).unwrap_or(0)
    }

    pub fn set_listener(&self, l: Listener) {
        *self.listener.lock().unwrap() = Some(l);
    }

    fn emit(&self, e: Event) {
        let l = self.listener.lock().unwrap().clone();
        if let Some(l) = l {
            l(e);
        }
    }

    pub fn path_of(&self, p: &Pending) -> PathBuf {
        self.dir.join(&p.file)
    }

    /// A fresh file to write a save into (not yet a pending upload).
    pub fn new_temp(&self) -> std::io::Result<PathBuf> {
        let p = self.dir.join(format!("{}.part", uuid::Uuid::new_v4()));
        crate::files::filecache::private_file(&p)?;
        Ok(p)
    }

    /// Writes pending.json: to a temporary file, flushed to the disk, then moved into place, so
    /// a crash leaves the old record or the new one, never half of one. A failure is logged and
    /// shown on the status line until a later write works.
    fn persist(&self, st: &State) {
        let res = (|| -> std::io::Result<()> {
            let list: Vec<&Pending> = st.pending.values().collect();
            crate::state::write_atomic(&self.dir.join("pending.json"), &serde_json::to_vec(&list)?)
        })();
        let mut err = self.persist_error.lock().unwrap();
        match res {
            Ok(()) => *err = None,
            Err(e) => {
                if err.is_none() {
                    eprintln!("drive uploads: pending.json couldn't be saved: {e}");
                }
                *err = Some(format!("Kybl couldn't note the waiting uploads on this computer ({e}). Keep Kybl open until they're done."));
            }
        }
    }

    /// What an edit of `key` starts from: a pending upload's base, else our own recent upload
    /// when the caller's listing doesn't show the file yet, else what the caller saw.
    pub fn base_for(&self, root: &str, key: &str, seen: Option<BaseState>) -> Option<BaseState> {
        let st = self.state.lock().unwrap();
        let k = (root.to_string(), key.to_string());
        if let Some(p) = st.pending.get(&k) {
            return p.base.clone();
        }
        if seen.is_none()
            && let Some((b, at)) = st.recent.get(&k)
            && at.elapsed() < RECENT
        {
            return Some(b.clone());
        }
        seen
    }

    /// Makes the finished save in `temp` the pending upload of `key`, replacing an older one.
    pub fn commit(&self, root: &str, key: &str, temp: &Path, base: Option<BaseState>) -> std::io::Result<Pending> {
        let size = std::fs::metadata(temp)?.len();
        let mut st = self.state.lock().unwrap();
        st.seq += 1;
        let seq = st.seq;
        let file = format!("{seq}-{}.bin", uuid::Uuid::new_v4().simple());
        std::fs::rename(temp, self.dir.join(&file))?;
        let k = (root.to_string(), key.to_string());
        let base = match st.pending.get(&k) {
            Some(old) => old.base.clone(),
            None => base,
        };
        let settle = if size == 0 { SETTLE_EMPTY } else { SETTLE };
        let p = Pending {
            root: root.into(),
            key: key.into(),
            file,
            size,
            modified: now_ms(),
            base,
            seq,
            attempts: 0,
            error: None,
            not_before: Some(Instant::now() + settle),
            uploading: false,
        };
        if let Some(old) = st.pending.insert(k.clone(), p.clone()) {
            self.drop_old(&mut st, &k, &old);
        }
        self.persist(&st);
        drop(st);
        self.wake.notify_waiters();
        self.emit(Event::Changed);
        Ok(p)
    }

    /// An older version is gone from the queue: stop its upload, or remove its file.
    fn drop_old(&self, st: &mut State, k: &(String, String), old: &Pending) {
        match st.running.get(k) {
            // the upload removes its own file when it stops
            Some(run) if old.uploading => run.stop.store(true, Ordering::SeqCst),
            _ => {
                let _ = std::fs::remove_file(self.dir.join(&old.file));
            }
        }
    }

    pub fn get(&self, root: &str, key: &str) -> Option<Pending> {
        self.state.lock().unwrap().pending.get(&(root.to_string(), key.to_string())).cloned()
    }

    /// Pending files directly inside the folder `dir` ("" or ending with `/`).
    pub fn in_dir(&self, root: &str, dir: &str) -> Vec<Pending> {
        self.state
            .lock()
            .unwrap()
            .pending
            .values()
            .filter(|p| p.root == root && p.key.strip_prefix(dir).is_some_and(|rest| !rest.is_empty() && !rest.contains('/')))
            .cloned()
            .collect()
    }

    /// Pending files anywhere below the folder `dir`.
    pub fn any_under(&self, root: &str, dir: &str) -> bool {
        self.state.lock().unwrap().pending.values().any(|p| p.root == root && p.key.starts_with(dir))
    }

    /// The file was deleted: forget its pending upload. True when there was one.
    pub fn remove(&self, root: &str, key: &str) -> bool {
        let mut st = self.state.lock().unwrap();
        let k = (root.to_string(), key.to_string());
        let Some(old) = st.pending.remove(&k) else { return false };
        self.drop_old(&mut st, &k, &old);
        st.recent.remove(&k);
        self.persist(&st);
        drop(st);
        self.emit(Event::Changed);
        true
    }

    /// The folder `dir` was deleted: forget the pending uploads inside it.
    pub fn remove_under(&self, root: &str, dir: &str) {
        let keys: Vec<String> = {
            let st = self.state.lock().unwrap();
            st.pending.values().filter(|p| p.root == root && p.key.starts_with(dir)).map(|p| p.key.clone()).collect()
        };
        for k in keys {
            self.remove(root, &k);
        }
    }

    /// The file was renamed before (or while) it was uploaded: it goes up under the new name.
    /// `base` is what is at `to` on the server (the rename replaces it).
    pub fn rename(&self, root: &str, from: &str, to: &str, base: Option<BaseState>) -> bool {
        let mut st = self.state.lock().unwrap();
        let k = (root.to_string(), from.to_string());
        let Some(mut p) = st.pending.remove(&k) else { return false };
        if p.uploading {
            // the upload under the old name stops; its file is still needed
            if let Some(run) = st.running.get(&k) {
                run.stop.store(true, Ordering::SeqCst);
            }
            // a copy, so the stopped upload can remove the original
            let file = format!("{}-{}.bin", p.seq, uuid::Uuid::new_v4().simple());
            if std::fs::copy(self.dir.join(&p.file), self.dir.join(&file)).is_err() {
                st.pending.insert(k, p);
                return false;
            }
            p.file = file;
        }
        let to_k = (root.to_string(), to.to_string());
        p.key = to.to_string();
        p.base = base;
        p.uploading = false;
        p.not_before = Some(Instant::now() + SETTLE);
        if let Some(old) = st.pending.insert(to_k.clone(), p) {
            self.drop_old(&mut st, &to_k, &old);
        }
        self.persist(&st);
        drop(st);
        self.wake.notify_waiters();
        self.emit(Event::Changed);
        true
    }

    /// (files waiting or uploading, their bytes, bytes sent of the ones uploading)
    pub fn stats(&self) -> (usize, u64, u64) {
        let st = self.state.lock().unwrap();
        (st.pending.len(), st.pending.values().map(|p| p.size).sum(), st.running.values().map(|r| r.sent.load(Ordering::Relaxed)).sum())
    }

    /// The latest error of a waiting upload (or of noting them down), for the status line.
    pub fn last_error(&self) -> Option<String> {
        if let Some(e) = self.persist_error.lock().unwrap().clone() {
            return Some(e);
        }
        if let Some(e) = self.state.lock().unwrap().pending.values().find_map(|p| p.error.clone()) {
            return Some(e);
        }
        match self.recovered() {
            0 => None,
            n => Some(format!(
                "Kybl kept {n} saved {} it couldn't match to a file on the drive. They're in the drive's uploads folder, under “{RECOVERED}”.",
                if n == 1 { "file" } else { "files" }
            )),
        }
    }

    /// Clears the stop of [`stop`](Self::stop), so [`run`](Self::run) workers can start again
    /// (after a quit that was called off).
    pub fn rearm(&self) {
        self.stopped.store(false, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn pending(&self) -> Vec<Pending> {
        self.state.lock().unwrap().pending.values().cloned().collect()
    }

    /// Stops the workers and the uploads under way (they carry on next start).
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // workers started before this stop never come back, even after a `rearm`
        self.generation.fetch_add(1, Ordering::SeqCst);
        for run in self.state.lock().unwrap().running.values() {
            run.stop.store(true, Ordering::SeqCst);
        }
        self.wake.notify_waiters();
    }

    /// Next upload due (with its stop flag and byte counter), or how long until one is.
    fn take_next(&self) -> Result<(Pending, Run), Option<Duration>> {
        let mut st = self.state.lock().unwrap();
        let now = Instant::now();
        let mut soonest: Option<Duration> = None;
        let mut pick = None;
        for (k, p) in st.pending.iter() {
            // one upload per key: a newer save waits until the older upload has stopped, so
            // two workers never write the same key at once
            if p.uploading || st.running.contains_key(k) {
                continue;
            }
            match p.not_before {
                Some(t) if t > now => {
                    let wait = t - now;
                    soonest = Some(soonest.map_or(wait, |s| s.min(wait)));
                }
                _ => {
                    pick = Some(k.clone());
                    break;
                }
            }
        }
        let Some(k) = pick else { return Err(soonest) };
        let p = st.pending.get_mut(&k).expect("picked");
        p.uploading = true;
        let p = p.clone();
        let run = Run::default();
        st.running.insert(k, run.clone());
        Ok((p, run))
    }

    /// One upload worker; runs until [`stop`](Self::stop). `open` hands out the connection.
    pub async fn run<F, Fut>(self: Arc<Self>, open: F)
    where
        F: Fn() -> Fut + Send + Sync,
        Fut: std::future::Future<Output = Result<Arc<dyn Storage>, String>> + Send,
    {
        let generation = self.generation.load(Ordering::SeqCst);
        loop {
            if self.stopped.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let (p, run) = match self.take_next() {
                Ok(x) => x,
                Err(wait) => {
                    let notified = self.wake.notified();
                    match wait {
                        Some(d) => {
                            let _ = tokio::time::timeout(d, notified).await;
                        }
                        None => notified.await,
                    }
                    continue;
                }
            };
            let result = match open().await {
                Ok(s) => {
                    let r = self.upload(&*s, &p, &run).await;
                    if let Ok(done) = &r {
                        self.undo_if_deleted(&*s, &p, done, &run).await;
                    }
                    r
                }
                Err(e) => Err(crate::storage::StorageError::new(ErrKind::Network, e)),
            };
            self.finish(&p, result, &run);
        }
    }

    /// The file was deleted (or renamed away) while its upload was finishing: the write went
    /// through anyway, so the key just written is deleted again rather than bring the file
    /// back. A newer save of the same key, if one came meanwhile, keeps it.
    async fn undo_if_deleted(&self, s: &dyn Storage, p: &Pending, done: &Done, run: &Run) {
        let gone = run.stop.load(Ordering::SeqCst) && self.get(&p.root, &p.key).is_none();
        if gone {
            let cancel = Arc::new(AtomicBool::new(false));
            if let Err(e) = s.delete(&p.root, std::slice::from_ref(&done.key), &[], &cancel, &|_, _| {}).await {
                eprintln!("drive uploads: a file deleted during its upload is still on the server: {}", e.message);
            }
        }
    }

    /// Sends one pending file: checks for a conflict, then writes.
    async fn upload(&self, s: &dyn Storage, p: &Pending, run: &Run) -> SResult<Done> {
        let now = s.stat(&p.root, &p.key).await?;
        let conflict = match (&p.base, &now) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(b), Some(n)) => !b.matches(n),
        };
        let key = if conflict { conflict_name(&p.key, p.modified) } else { p.key.clone() };
        let sent = run.sent.clone();
        let progress = move |done: u64, _total: u64| {
            sent.store(done, Ordering::Relaxed);
        };
        let opts = WriteOpts { modified: Some(p.modified), ..Default::default() };
        match s.write(&p.root, &key, WriteSource::Path(self.path_of(p)), opts, &progress, &run.stop).await? {
            WriteOutcome::Done(_) => {}
            WriteOutcome::Cancelled => return Err(crate::storage::StorageError::cancelled()),
            WriteOutcome::Conflict(_) => return Err(crate::storage::StorageError::conflict()),
        }
        // what is there now, for the next save of the same file (a newer one may already wait)
        let after = s.stat(&p.root, &key).await.ok().flatten().map(|e| BaseState::of(&e));
        Ok(Done { key, conflict, after })
    }

    fn finish(&self, p: &Pending, result: SResult<Done>, run: &Run) {
        let stop = &run.stop;
        let k = (p.root.clone(), p.key.clone());
        let mut st = self.state.lock().unwrap();
        // only our own entry: never another upload's stop flag
        if st.running.get(&k).is_some_and(|r| Arc::ptr_eq(&r.stop, &run.stop)) {
            st.running.remove(&k);
        }
        let current_seq = st.pending.get(&k).map(|c| c.seq);
        let ours = current_seq == Some(p.seq);
        let mut events = vec![Event::Changed];
        match result {
            Ok(done) => {
                if !done.conflict
                    && let Some(after) = &done.after
                {
                    st.recent.insert(k.clone(), (after.clone(), Instant::now()));
                }
                if ours {
                    st.pending.remove(&k);
                } else if let Some(newer) = st.pending.get_mut(&k) {
                    // a newer save of the same file waits: it now builds on what we just sent
                    if !done.conflict {
                        newer.base = done.after.clone();
                    }
                }
                let _ = std::fs::remove_file(self.dir.join(&p.file));
                events.push(Event::Uploaded { root: p.root.clone(), key: done.key.clone() });
                if done.conflict {
                    events.push(Event::Conflict { root: p.root.clone(), key: p.key.clone(), saved_as: done.key });
                }
            }
            Err(e) if e.is_cancelled() || stop.load(Ordering::SeqCst) => {
                if ours {
                    // stopped for quitting: tried again next time
                    if let Some(c) = st.pending.get_mut(&k) {
                        c.uploading = false;
                    }
                } else if !st.pending.values().any(|x| x.file == p.file) {
                    // replaced, deleted or renamed meanwhile
                    let _ = std::fs::remove_file(self.dir.join(&p.file));
                }
            }
            Err(e) => {
                if ours {
                    if let Some(c) = st.pending.get_mut(&k) {
                        c.uploading = false;
                        c.attempts += 1;
                        c.error = Some(e.message.clone());
                        c.not_before = Some(Instant::now() + backoff(c.attempts));
                    }
                } else if !st.pending.values().any(|x| x.file == p.file) {
                    let _ = std::fs::remove_file(self.dir.join(&p.file));
                }
            }
        }
        st.recent.retain(|_, (_, at)| at.elapsed() < RECENT);
        self.persist(&st);
        drop(st);
        self.wake.notify_waiters();
        for e in events {
            self.emit(e);
        }
    }

    /// Waits until nothing is pending, or `limit` passes. True when the queue is empty.
    pub async fn drain(&self, limit: Duration) -> bool {
        let until = Instant::now() + limit;
        // uploads waiting to settle can go right away
        {
            let mut st = self.state.lock().unwrap();
            for p in st.pending.values_mut() {
                if !p.uploading {
                    p.not_before = None;
                }
            }
        }
        self.wake.notify_waiters();
        loop {
            if self.state.lock().unwrap().pending.is_empty() {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

struct Done {
    /// where it went: the file's own key, or the conflict copy's
    key: String,
    conflict: bool,
    after: Option<BaseState>,
}

/// Whether the uploads folder `dir` holds saves Kybl kept aside ([`RECOVERED`], or a record set
/// aside as `pending.json.bad-*`).
pub fn has_kept(dir: &Path) -> bool {
    let recovered = std::fs::read_dir(dir.join(RECOVERED)).is_ok_and(|mut rd| rd.next().is_some());
    recovered || std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| e.file_name().to_string_lossy().starts_with("pending.json.bad-"))
}

/// Moves every save in the uploads folder `dir` that could be the user's only copy into `to`,
/// before the folder is deleted: saves still waiting to upload under their own path
/// (`to/<root>/<key>`), files in [`RECOVERED`] and other saves no record names under
/// `to/recovered/`, and a set-aside record as it is. Answers how many files moved; an error
/// when one couldn't (then the folder must stay).
pub fn rescue(dir: &Path, to: &Path) -> Result<usize, String> {
    let mut moved = 0;
    let mut put = |from: &Path, rel: &str| -> Result<(), String> {
        let mut dst = to.to_path_buf();
        for part in rel.split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..") {
            dst.push(part.replace(['\\', ':'], "_"));
        }
        if dst == to {
            dst.push("unnamed");
        }
        if dst.exists() {
            let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            dst.set_file_name(format!("{name} (kept {})", now_ms()));
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        // another disk: copy, and only then remove
        if std::fs::rename(from, &dst).is_err() {
            std::fs::copy(from, &dst).map_err(|e| format!("{}: {e}", dst.display()))?;
            let _ = std::fs::remove_file(from);
        }
        moved += 1;
        Ok(())
    };
    let pending: Vec<Pending> = std::fs::read(dir.join("pending.json")).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default();
    let mut named = std::collections::HashSet::new();
    for p in &pending {
        let f = dir.join(&p.file);
        if f.is_file() && named.insert(p.file.clone()) {
            put(&f, &format!("{}/{}", p.root, p.key))?;
        }
    }
    for e in std::fs::read_dir(dir.join(RECOVERED)).into_iter().flatten().flatten() {
        if e.file_type().is_ok_and(|t| t.is_file()) {
            put(&e.path(), &format!("{RECOVERED}/{}", e.file_name().to_string_lossy()))?;
        }
    }
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.file_type().is_ok_and(|t| t.is_file()) || named.contains(&name) {
            continue;
        }
        if name.starts_with("pending.json.bad-") {
            put(&e.path(), &name)?;
        } else if name.ends_with(".bin") {
            put(&e.path(), &format!("{RECOVERED}/{name}"))?;
        }
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_saves_move_out_before_the_folder_goes() {
        let dir = tmp();
        let to = tmp();
        {
            let wb = WriteBack::open(dir.clone());
            save(&wb, "docs/a.txt", b"waiting");
        }
        assert!(!has_kept(&dir));
        std::fs::create_dir_all(dir.join(RECOVERED)).unwrap();
        std::fs::write(dir.join(RECOVERED).join("7.bin"), b"recovered").unwrap();
        std::fs::write(dir.join("pending.json.bad-1"), b"{broken").unwrap();
        assert!(has_kept(&dir));
        assert_eq!(rescue(&dir, &to).unwrap(), 3);
        assert_eq!(std::fs::read(to.join("r/docs/a.txt")).unwrap(), b"waiting");
        assert_eq!(std::fs::read(to.join(RECOVERED).join("7.bin")).unwrap(), b"recovered");
        assert!(to.join("pending.json.bad-1").is_file());
        assert!(!has_kept(&dir));
        // a second rescue into the same place doesn't overwrite what's there
        std::fs::write(dir.join(RECOVERED).join("7.bin"), b"again").unwrap();
        rescue(&dir, &to).unwrap();
        assert_eq!(std::fs::read(to.join(RECOVERED).join("7.bin")).unwrap(), b"recovered");
        assert_eq!(std::fs::read_dir(to.join(RECOVERED)).unwrap().count(), 2);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(to);
    }

    #[test]
    fn conflict_names_keep_the_extension_and_folder() {
        // 2026-11-22 19:30 UTC
        let ms = 1_795_375_800_000;
        assert_eq!(conflict_name("docs/report.pdf", ms), "docs/report (conflict 2026-11-22 19.30).pdf");
        assert_eq!(conflict_name("Makefile", ms), "Makefile (conflict 2026-11-22 19.30)");
        assert_eq!(conflict_name(".env", ms), ".env (conflict 2026-11-22 19.30)");
        assert_eq!(conflict_name("a.tar.gz", ms), "a.tar (conflict 2026-11-22 19.30).gz");
    }

    #[test]
    fn bases_compare_etags_then_size_and_time() {
        let e = Entry { key: "a".into(), size: 3, modified: Some(5), etag: Some("\"x\"".into()), ..Default::default() };
        assert!(BaseState { etag: Some("x".into()), size: 9, modified: None }.matches(&e));
        assert!(!BaseState { etag: Some("y".into()), size: 3, modified: Some(5) }.matches(&e));
        let e = Entry { etag: None, ..e };
        assert!(BaseState { etag: Some("y".into()), size: 3, modified: Some(5) }.matches(&e));
        assert!(!BaseState { etag: None, size: 3, modified: Some(6) }.matches(&e));
    }

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("kybl-wbu-{}", uuid::Uuid::new_v4()))
    }

    fn save(wb: &WriteBack, key: &str, body: &[u8]) -> Pending {
        let t = wb.new_temp().unwrap();
        std::fs::write(&t, body).unwrap();
        let p = wb.commit("r", key, &t, None).unwrap();
        // due at once
        wb.state.lock().unwrap().pending.values_mut().for_each(|p| p.not_before = None);
        p
    }

    #[test]
    fn a_newer_save_waits_for_the_older_upload_of_the_same_file() {
        let dir = tmp();
        let wb = WriteBack::open(dir.clone());
        save(&wb, "a.txt", b"one");
        let (p1, run1) = wb.take_next().ok().unwrap();
        // saved again while the first upload runs: it is stopped, and the second waits
        save(&wb, "a.txt", b"two");
        assert!(run1.stop.load(Ordering::SeqCst));
        assert!(wb.take_next().is_err(), "never two uploads of one key at once");
        run1.sent.store(2, Ordering::Relaxed);
        assert_eq!(wb.stats().2, 2, "bytes are counted per upload");
        wb.finish(&p1, Err(crate::storage::StorageError::cancelled()), &run1);
        let (p2, run2) = wb.take_next().ok().unwrap();
        assert_eq!(std::fs::read(wb.path_of(&p2)).unwrap(), b"two");
        // a late finish of the first upload can't take the second one's stop flag away
        wb.finish(&p1, Err(crate::storage::StorageError::cancelled()), &run1);
        assert!(wb.state.lock().unwrap().running.get(&("r".to_string(), "a.txt".to_string())).is_some_and(|r| Arc::ptr_eq(&r.stop, &run2.stop)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_record_never_costs_a_saved_file() {
        let dir = tmp();
        {
            let wb = WriteBack::open(dir.clone());
            save(&wb, "a.txt", b"only copy");
        }
        std::fs::write(dir.join("pending.json"), b"{ not json").unwrap();
        let wb = WriteBack::open(dir.clone());
        assert!(wb.pending().is_empty());
        let kept: Vec<_> = std::fs::read_dir(dir.join(RECOVERED)).unwrap().flatten().map(|e| std::fs::read(e.path()).unwrap()).collect();
        assert_eq!(kept, vec![b"only copy".to_vec()]);
        assert!(std::fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("pending.json.bad-")));
        assert!(wb.last_error().unwrap().contains("kept 1 saved file"));
        // and no record at all (a crash right after a save) keeps it too
        let dir2 = tmp();
        {
            let wb = WriteBack::open(dir2.clone());
            save(&wb, "b.txt", b"also mine");
        }
        std::fs::remove_file(dir2.join("pending.json")).unwrap();
        let _ = WriteBack::open(dir2.clone());
        assert_eq!(std::fs::read_dir(dir2.join(RECOVERED)).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn a_moved_file_rebases_the_waiting_save() {
        let at = |etag: &str| Entry { key: "k".into(), size: 3, etag: Some(etag.into()), ..Default::default() };
        let b = BaseState::of(&at("old"));
        // built on what was there: now builds on the moved file (with its new ETag)
        assert_eq!(rebase(Some(&b), Some(&at("old")), Some(&at("moved"))), Some(BaseState::of(&at("moved"))));
        // someone else had changed it already: the old base stays, so it is still a conflict
        assert_eq!(rebase(Some(&b), Some(&at("theirs")), Some(&at("moved"))), Some(b.clone()));
        // a new file that was never on the server stays new
        assert_eq!(rebase(None, None, None), None);
        assert_eq!(rebase(None, Some(&at("x")), Some(&at("y"))), None);
    }

    #[test]
    fn a_file_deleted_while_its_upload_finished_is_not_brought_back() {
        use crate::storage::{local::LocalBackend, RootKind};
        let dir = tmp();
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let s = LocalBackend::with_roots(vec![("d".into(), RootKind::Folder, data.clone())], false);
            let root = s.roots().await.unwrap()[0].id.clone();
            let wb = WriteBack::open(dir.join("uploads"));
            let t = wb.new_temp().unwrap();
            std::fs::write(&t, b"x").unwrap();
            wb.commit(&root, "gone.txt", &t, None).unwrap();
            wb.state.lock().unwrap().pending.values_mut().for_each(|p| p.not_before = None);
            let (p, run) = wb.take_next().ok().unwrap();
            // the write lands on the server just as the file is deleted on the drive
            std::fs::write(data.join("gone.txt"), b"x").unwrap();
            assert!(wb.remove(&root, "gone.txt"));
            let done = Done { key: "gone.txt".into(), conflict: false, after: None };
            wb.undo_if_deleted(&s, &p, &done, &run).await;
            assert!(!data.join("gone.txt").exists());
            // a newer save of the same name meanwhile keeps it
            let t = wb.new_temp().unwrap();
            std::fs::write(&t, b"y").unwrap();
            wb.commit(&root, "kept.txt", &t, None).unwrap();
            wb.state.lock().unwrap().pending.values_mut().for_each(|p| p.not_before = None);
            let (p, run) = wb.take_next().ok().unwrap();
            std::fs::write(data.join("kept.txt"), b"y").unwrap();
            save_as(&wb, &root, "kept.txt");
            wb.undo_if_deleted(&s, &p, &Done { key: "kept.txt".into(), conflict: false, after: None }, &run).await;
            assert!(data.join("kept.txt").exists());
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn save_as(wb: &WriteBack, root: &str, key: &str) {
        let t = wb.new_temp().unwrap();
        std::fs::write(&t, b"newer").unwrap();
        wb.commit(root, key, &t, None).unwrap();
    }
}
