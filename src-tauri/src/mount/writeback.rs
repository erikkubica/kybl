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
    /// stop flags of the uploads under way
    running: HashMap<(String, String), Arc<AtomicBool>>,
}

pub struct WriteBack {
    dir: PathBuf,
    state: Mutex<State>,
    wake: tokio::sync::Notify,
    stopped: AtomicBool,
    /// bytes sent by the uploads under way
    sent: AtomicU64,
    listener: Mutex<Option<Listener>>,
}

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
    pub fn open(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let mut st = State::default();
        if let Some(list) = std::fs::read(dir.join("pending.json")).ok().and_then(|raw| serde_json::from_slice::<Vec<Pending>>(&raw).ok()) {
            for p in list {
                if dir.join(&p.file).is_file() {
                    st.seq = st.seq.max(p.seq);
                    st.pending.insert((p.root.clone(), p.key.clone()), p);
                }
            }
        }
        // files no pending upload refers to: a save that never finished
        let keep: Vec<String> = st.pending.values().map(|p| p.file.clone()).collect();
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name != "pending.json" && !keep.contains(&name) {
                let _ = std::fs::remove_file(e.path());
            }
        }
        Self { dir, state: Mutex::new(st), wake: Default::default(), stopped: AtomicBool::new(false), sent: AtomicU64::new(0), listener: Mutex::new(None) }
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
        std::fs::File::create(&p)?;
        Ok(p)
    }

    fn persist(&self, st: &State) {
        let list: Vec<&Pending> = st.pending.values().collect();
        if let Ok(raw) = serde_json::to_vec(&list) {
            let tmp = self.dir.join("pending.json.tmp");
            if std::fs::write(&tmp, raw).is_ok() {
                let _ = std::fs::rename(&tmp, self.dir.join("pending.json"));
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
            Some(stop) if old.uploading => stop.store(true, Ordering::SeqCst),
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
            if let Some(stop) = st.running.get(&k) {
                stop.store(true, Ordering::SeqCst);
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
        (st.pending.len(), st.pending.values().map(|p| p.size).sum(), self.sent.load(Ordering::Relaxed))
    }

    /// The latest error of a waiting upload, for the status line.
    pub fn last_error(&self) -> Option<String> {
        self.state.lock().unwrap().pending.values().find_map(|p| p.error.clone())
    }

    pub fn pending(&self) -> Vec<Pending> {
        self.state.lock().unwrap().pending.values().cloned().collect()
    }

    /// Stops the workers and the uploads under way (they carry on next start).
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        for stop in self.state.lock().unwrap().running.values() {
            stop.store(true, Ordering::SeqCst);
        }
        self.wake.notify_waiters();
    }

    /// Next upload due, or how long until one is.
    fn take_next(&self) -> Result<Pending, Option<Duration>> {
        let mut st = self.state.lock().unwrap();
        let now = Instant::now();
        let mut soonest: Option<Duration> = None;
        let mut pick = None;
        for (k, p) in st.pending.iter() {
            if p.uploading {
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
        st.running.insert(k, Arc::new(AtomicBool::new(false)));
        Ok(p)
    }

    /// One upload worker; runs until [`stop`](Self::stop). `open` hands out the connection.
    pub async fn run<F, Fut>(self: Arc<Self>, open: F)
    where
        F: Fn() -> Fut + Send + Sync,
        Fut: std::future::Future<Output = Result<Arc<dyn Storage>, String>> + Send,
    {
        loop {
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            let p = match self.take_next() {
                Ok(p) => p,
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
            let k = (p.root.clone(), p.key.clone());
            let stop = self.state.lock().unwrap().running.get(&k).cloned().unwrap_or_default();
            let result = match open().await {
                Ok(s) => self.upload(&*s, &p, &stop).await,
                Err(e) => Err(crate::storage::StorageError::new(ErrKind::Network, e)),
            };
            self.finish(&p, result, &stop);
        }
    }

    /// Sends one pending file: checks for a conflict, then writes.
    async fn upload(&self, s: &dyn Storage, p: &Pending, stop: &Arc<AtomicBool>) -> SResult<Done> {
        let now = s.stat(&p.root, &p.key).await?;
        let conflict = match (&p.base, &now) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(b), Some(n)) => !b.matches(n),
        };
        let key = if conflict { conflict_name(&p.key, p.modified) } else { p.key.clone() };
        self.sent.store(0, Ordering::Relaxed);
        let sent = &self.sent;
        let progress = move |done: u64, _total: u64| {
            sent.store(done, Ordering::Relaxed);
        };
        let opts = WriteOpts { modified: Some(p.modified), ..Default::default() };
        match s.write(&p.root, &key, WriteSource::Path(self.path_of(p)), opts, &progress, stop).await? {
            WriteOutcome::Done(_) => {}
            WriteOutcome::Cancelled => return Err(crate::storage::StorageError::cancelled()),
            WriteOutcome::Conflict(_) => return Err(crate::storage::StorageError::conflict()),
        }
        // what is there now, for the next save of the same file (a newer one may already wait)
        let after = s.stat(&p.root, &key).await.ok().flatten().map(|e| BaseState::of(&e));
        Ok(Done { key, conflict, after })
    }

    fn finish(&self, p: &Pending, result: SResult<Done>, stop: &AtomicBool) {
        let k = (p.root.clone(), p.key.clone());
        let mut st = self.state.lock().unwrap();
        st.running.remove(&k);
        self.sent.store(0, Ordering::Relaxed);
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
