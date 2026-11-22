//! One-way folder sync between a local folder and an S3 prefix.
//!
//! * **Upload** mappings back a local folder up to S3. The folder is watched, so changes go up a
//!   couple of seconds after they happen, and a full comparison with the bucket runs on an interval.
//! * **Download** mappings keep a local mirror of an S3 folder, polled on an interval (S3 can't
//!   push changes to us).
//!
//! A small per-mapping database remembers what was synced last time (size + mtime locally, ETag
//! remotely). That is what lets us tell "deleted" from "never synced", spot local edits in a
//! download mirror, and keep both copies when the two sides disagree. Nothing is ever deleted for
//! good: deletions only happen with "mirror deletions" on, local files go to the system Trash,
//! and both directions refuse to mass-delete when one side suddenly looks empty (an unmounted
//! drive, a wrong prefix).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aws_sdk_s3::Client;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::RecommendedWatcher;
use notify_debouncer_full::{
    new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer, RecommendedCache,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::{
    sync::{mpsc, Mutex},
    task::JoinSet,
};

use crate::{
    commands::list_all,
    state::{client_for, err, sdk_err_brief, AppState},
    multipart::upload_file,
    transfers::{download_file, Outcome},
};

/// Parallel transfers per mapping.
const CONCURRENCY: usize = 4;
/// Patterns that are always ignored: our own partial downloads and conflict scratch files.
const ALWAYS_IGNORED: [&str; 2] = ["*.s3part", ".s3sync-*"];
/// Retry sooner than the normal interval after a failed run.
const RETRY_AFTER: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

fn default_interval() -> u32 {
    5
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncMapping {
    #[serde(default)]
    pub id: String,
    pub profile_id: String,
    pub bucket: String,
    /// remote folder: "" for the bucket root, otherwise ends with "/"
    #[serde(default)]
    pub prefix: String,
    pub local_path: String,
    pub direction: Direction,
    /// gitignore-style patterns
    #[serde(default)]
    pub ignore: Vec<String>,
    /// propagate deletions (upload: delete on S3; download: move local files to the Trash)
    #[serde(default)]
    pub mirror_deletes: bool,
    /// minutes between full comparisons with the bucket
    #[serde(default = "default_interval")]
    pub interval_mins: u32,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct SyncConfig {
    #[serde(default)]
    paused_all: bool,
    #[serde(default)]
    mappings: Vec<SyncMapping>,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub id: String,
    /// idle | scanning | syncing | error | paused
    pub state: String,
    pub last_sync: Option<i64>,
    pub error: Option<String>,
    /// file being transferred right now
    pub current: Option<String>,
    pub done: u32,
    pub total: u32,
    /// files tracked as in sync
    pub files: u32,
    /// what the last run did, e.g. "3 uploaded · 1 deleted"
    pub summary: Option<String>,
    /// bytes transferred so far in this run (finished files + what running ones have sent)
    pub bytes: u64,
    /// bytes this run has to transfer in total
    pub total_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Tracked {
    size: u64,
    mtime: i64,
    #[serde(default)]
    etag: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Db {
    #[serde(default)]
    last_sync: Option<i64>,
    #[serde(default)]
    files: HashMap<String, Tracked>,
}

struct Worker {
    cancel: Arc<AtomicBool>,
    tx: mpsc::Sender<bool>,
    _watcher: Option<Debouncer<RecommendedWatcher, RecommendedCache>>,
}

#[derive(Default)]
pub struct SyncManager {
    config: Mutex<SyncConfig>,
    status: std::sync::Mutex<HashMap<String, SyncStatus>>,
    workers: Mutex<HashMap<String, Worker>>,
    /// one run at a time per mapping, even across a worker restart
    run_locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// mirror of `config.paused_all` readable without awaiting (tray)
    pub paused_flag: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOverview {
    paused_all: bool,
    mappings: Vec<SyncMapping>,
    statuses: Vec<SyncStatus>,
}

// ---------------------------------------------------------------- persistence

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("sync.json"))
}

fn load_config<R: Runtime>(app: &AppHandle<R>) -> SyncConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(err)?;
    std::fs::rename(&tmp, path).map_err(err)
}

fn save_config<R: Runtime>(app: &AppHandle<R>, cfg: &SyncConfig) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(cfg).map_err(err)?;
    write_atomic(&config_path(app)?, &raw)
}

fn db_path<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?.join("sync");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(format!("{id}.json")))
}

fn load_db<R: Runtime>(app: &AppHandle<R>, id: &str) -> Db {
    db_path(app, id)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_db<R: Runtime>(app: &AppHandle<R>, id: &str, db: &Db) -> Result<(), String> {
    let raw = serde_json::to_vec(db).map_err(err)?;
    write_atomic(&db_path(app, id)?, &raw)
}

fn forget_db<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Ok(p) = db_path(app, id) {
        let _ = std::fs::remove_file(p);
    }
}

// ---------------------------------------------------------------- helpers

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn norm_prefix(p: &str) -> String {
    let t = p.trim().trim_matches('/');
    if t.is_empty() {
        String::new()
    } else {
        format!("{t}/")
    }
}

fn build_ignore(root: &Path, lines: &[String]) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    for l in lines {
        let l = l.trim();
        if !l.is_empty() && !l.starts_with('#') {
            let _ = b.add_line(None, l);
        }
    }
    for l in ALWAYS_IGNORED {
        let _ = b.add_line(None, l);
    }
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

fn is_ignored(gi: &Gitignore, rel: &str) -> bool {
    gi.matched_path_or_any_parents(Path::new(rel), false).is_ignore()
}

/// Rejects keys that would escape the local folder or can't be a file name.
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains('\0')
        && rel.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

fn rel_key(p: &Path) -> String {
    p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

fn local_path_of(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// "photo.jpg" -> "photo (local copy).jpg", numbered if that exists too.
fn conflict_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    for n in 1.. {
        let label = if n == 1 { "local copy".to_string() } else { format!("local copy {n}") };
        let candidate = dir.join(format!("{stem} ({label}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

struct LocalFile {
    size: u64,
    mtime: i64,
}

fn scan_local(root: &Path, gi: &Gitignore) -> HashMap<String, LocalFile> {
    let mut out = HashMap::new();
    let walker = walkdir::WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        match e.path().strip_prefix(root) {
            Ok(rel) => !gi.matched(rel, e.file_type().is_dir()).is_ignore(),
            Err(_) => false,
        }
    });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        out.insert(rel_key(rel), LocalFile { size: meta.len(), mtime: mtime_ms(&meta) });
    }
    out
}

struct RemoteFile {
    size: u64,
    etag: String,
    modified: i64,
}

async fn scan_remote(
    client: &Client,
    bucket: &str,
    prefix: &str,
    gi: &Gitignore,
) -> Result<HashMap<String, RemoteFile>, String> {
    let mut out = HashMap::new();
    for o in list_all(client, bucket, prefix).await? {
        if o.key.ends_with('/') || !o.key.starts_with(prefix) {
            continue;
        }
        let rel = &o.key[prefix.len()..];
        if !safe_rel(rel) || is_ignored(gi, rel) {
            continue;
        }
        out.insert(
            rel.to_string(),
            RemoteFile {
                size: o.size.max(0) as u64,
                etag: o.etag.unwrap_or_default(),
                modified: o.modified.unwrap_or(0),
            },
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------- status

impl SyncManager {
    fn update<R: Runtime>(&self, app: &AppHandle<R>, id: &str, f: impl FnOnce(&mut SyncStatus)) {
        let snapshot = {
            let mut map = self.status.lock().unwrap();
            let s = map.entry(id.to_string()).or_insert_with(|| SyncStatus {
                id: id.to_string(),
                state: "idle".into(),
                ..Default::default()
            });
            f(s);
            s.clone()
        };
        let _ = app.emit("sync-status", snapshot);
        crate::tray::refresh(app);
    }

    pub fn statuses(&self) -> Vec<SyncStatus> {
        self.status.lock().unwrap().values().cloned().collect()
    }

    fn run_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.run_locks.lock().unwrap().entry(id.to_string()).or_default().clone()
    }
}

// ---------------------------------------------------------------- one run

#[derive(Default)]
struct RunResult {
    summary: String,
    errors: Vec<String>,
    files: usize,
}

enum Job {
    Up { rel: String, path: PathBuf, key: String, size: u64, mtime: i64 },
    Down { rel: String, key: String, dest: PathBuf, etag: String, size: u64, keep_local: bool },
}

impl Job {
    fn rel(&self) -> &str {
        match self {
            Job::Up { rel, .. } | Job::Down { rel, .. } => rel,
        }
    }
    fn size(&self) -> u64 {
        match self {
            Job::Up { size, .. } | Job::Down { size, .. } => *size,
        }
    }
}

/// Byte progress of one run: finished files plus what the running transfers have sent so far.
#[derive(Default)]
struct RunBytes {
    finished: AtomicU64,
    /// rel -> (bytes sent, size) of transfers in flight
    active: std::sync::Mutex<HashMap<String, (u64, u64)>>,
}

impl RunBytes {
    fn total(&self) -> u64 {
        self.finished.load(Ordering::Relaxed) + self.active.lock().unwrap().values().map(|(s, _)| *s).sum::<u64>()
    }
    /// The in-flight file with the most left to go: the one everybody is waiting for.
    fn slowest(&self) -> Option<String> {
        self.active
            .lock()
            .unwrap()
            .iter()
            .max_by_key(|(_, (sent, size))| size.saturating_sub(*sent))
            .map(|(rel, _)| rel.clone())
    }
}

async fn exec_job(job: Job, client: Client, bucket: String, cancel: Arc<AtomicBool>, bytes: Arc<RunBytes>) -> (String, Result<Option<Tracked>, String>) {
    let rel = job.rel().to_string();
    let size = job.size();
    bytes.active.lock().unwrap().insert(rel.clone(), (0, size));
    let (b, r) = (bytes.clone(), rel.clone());
    let progress = move |sent: u64, total: u64| {
        b.active.lock().unwrap().insert(r.clone(), (sent, total.max(size)));
    };
    let out = exec_transfer(job, client, bucket, cancel, &progress).await;
    bytes.active.lock().unwrap().remove(&rel);
    if matches!(out.1, Ok(Some(_))) {
        bytes.finished.fetch_add(size, Ordering::Relaxed);
    }
    out
}

async fn exec_transfer(
    job: Job,
    client: Client,
    bucket: String,
    cancel: Arc<AtomicBool>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> (String, Result<Option<Tracked>, String>) {
    match job {
        Job::Up { rel, path, key, size, mtime } => {
            let r = upload_file(&client, &bucket, &key, &path.to_string_lossy(), &cancel, progress).await;
            let r = r.map(|o| match o {
                // record what was scanned: an edit made during the upload is picked up next run
                Outcome::Done => Some(Tracked { size, mtime, etag: String::new() }),
                Outcome::Cancelled => None,
            });
            (rel, r)
        }
        Job::Down { rel, key, dest, etag, keep_local, .. } => {
            if keep_local && dest.exists() {
                if let Err(e) = std::fs::rename(&dest, conflict_path(&dest)) {
                    return (rel, Err(format!("could not keep the local copy: {e}")));
                }
            }
            let r = download_file(&client, &bucket, &key, &dest.to_string_lossy(), &cancel, progress).await;
            let r = match r {
                Ok(Outcome::Done) => match std::fs::metadata(&dest) {
                    Ok(m) => Ok(Some(Tracked { size: m.len(), mtime: mtime_ms(&m), etag })),
                    Err(e) => Err(err(e)),
                },
                Ok(Outcome::Cancelled) => Ok(None),
                Err(e) => Err(e),
            };
            (rel, r)
        }
    }
}

/// Runs the transfers with limited parallelism, updating the database and the status as they finish.
async fn run_jobs<R: Runtime>(
    app: &AppHandle<R>,
    m: &SyncMapping,
    client: &Client,
    jobs: Vec<Job>,
    db: &mut Db,
    cancel: &Arc<AtomicBool>,
    done_before: u32,
    total: u32,
    errors: &mut Vec<String>,
) -> usize {
    let mgr = app.state::<SyncManager>();
    let total_bytes: u64 = jobs.iter().map(Job::size).sum();
    let bytes = Arc::new(RunBytes::default());
    let mut set = JoinSet::new();
    let mut queue = jobs.into_iter();
    let mut done = done_before;
    let mut ok = 0usize;
    let mut since_save = 0usize;
    // a single big file can take many minutes: report byte progress on a timer, not only per file
    let mut tick = tokio::time::interval(Duration::from_millis(400));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        while set.len() < CONCURRENCY && !cancel.load(Ordering::Relaxed) {
            let Some(job) = queue.next() else { break };
            set.spawn(exec_job(job, client.clone(), m.bucket.clone(), cancel.clone(), bytes.clone()));
        }
        if set.is_empty() {
            break;
        }
        tokio::select! {
            joined = set.join_next() => {
                let Some(joined) = joined else { break };
                done += 1;
                if let Ok((rel, res)) = joined {
                    match res {
                        Ok(Some(t)) => {
                            db.files.insert(rel, t);
                            ok += 1;
                            since_save += 1;
                        }
                        Ok(None) => {}
                        Err(e) => errors.push(format!("{rel}: {e}")),
                    }
                }
                if since_save >= 100 {
                    let _ = save_db(app, &m.id, db);
                    since_save = 0;
                }
                continue;
            }
            _ = tick.tick() => {}
        }
        let (sent, current) = (bytes.total(), bytes.slowest());
        mgr.update(app, &m.id, |s| {
            s.done = done;
            s.total = total;
            s.bytes = sent;
            s.total_bytes = total_bytes;
            s.current = current;
        });
    }
    ok
}

async fn run_upload<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, full: bool, cancel: &Arc<AtomicBool>) -> Result<RunResult, String> {
    let mgr = app.state::<SyncManager>();
    let root = PathBuf::from(&m.local_path);
    if !root.is_dir() {
        return Err(format!("The folder {} is missing. Is the drive connected?", m.local_path));
    }
    let gi = build_ignore(&root, &m.ignore);
    let (r2, g2) = (root.clone(), gi.clone());
    let local = tokio::task::spawn_blocking(move || scan_local(&r2, &g2)).await.map_err(err)?;

    let state = app.state::<AppState>();
    let client = client_for(app, &state, &m.profile_id).await?;
    let prefix = norm_prefix(&m.prefix);
    let mut db = load_db(app, &m.id);
    let remote = if full || db.files.is_empty() {
        Some(scan_remote(&client, &m.bucket, &prefix, &gi).await?)
    } else {
        None
    };

    let mut jobs = Vec::new();
    for (rel, lf) in &local {
        let tracked = db.files.get(rel);
        let unchanged = tracked.is_some_and(|t| t.size == lf.size && t.mtime == lf.mtime);
        let need = match &remote {
            Some(r) => {
                let rf = r.get(rel);
                if unchanged {
                    // gone from S3 or replaced there: local is the source of truth
                    rf.is_none_or(|rf| rf.size != lf.size)
                } else if tracked.is_none() && rf.is_some_and(|rf| rf.size == lf.size && rf.modified >= lf.mtime) {
                    // first run over an existing copy: adopt it instead of uploading again
                    let etag = rf.map(|rf| rf.etag.clone()).unwrap_or_default();
                    db.files.insert(rel.clone(), Tracked { size: lf.size, mtime: lf.mtime, etag });
                    false
                } else {
                    true
                }
            }
            None => !unchanged,
        };
        if need {
            jobs.push(Job::Up {
                rel: rel.clone(),
                path: local_path_of(&root, rel),
                key: format!("{prefix}{rel}"),
                size: lf.size,
                mtime: lf.mtime,
            });
        }
    }

    // tracked files that disappeared locally
    let gone: Vec<String> = db.files.keys().filter(|k| !local.contains_key(*k)).cloned().collect();
    let mut deletes = Vec::new();
    for rel in gone {
        if m.mirror_deletes && !is_ignored(&gi, &rel) {
            deletes.push(rel);
        } else {
            db.files.remove(&rel);
        }
    }
    let mut errors = Vec::new();
    if !deletes.is_empty() && local.is_empty() {
        errors.push(format!(
            "The folder is empty, so {} on S3 were kept. If you really emptied it, delete them in the browser.",
            plural(deletes.len(), "file")
        ));
        deletes.clear();
    }

    let total = (jobs.len() + deletes.len()) as u32;
    if total > 0 {
        mgr.update(app, &m.id, |s| {
            s.state = "syncing".into();
            s.done = 0;
            s.total = total;
        });
    }
    let uploaded = run_jobs(app, m, &client, jobs, &mut db, cancel, 0, total, &mut errors).await;

    let mut deleted = 0;
    for rel in &deletes {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let key = format!("{prefix}{rel}");
        match client.delete_object().bucket(&m.bucket).key(&key).send().await {
            Ok(_) => {
                db.files.remove(rel);
                deleted += 1;
            }
            Err(e) => errors.push(format!("{rel}: {}", sdk_err_brief(e))),
        }
    }

    if !cancel.load(Ordering::Relaxed) {
        db.last_sync = Some(now_ms());
    }
    save_db(app, &m.id, &db)?;
    let mut parts = Vec::new();
    if uploaded > 0 {
        parts.push(format!("{uploaded} uploaded"));
    }
    if deleted > 0 {
        parts.push(format!("{deleted} deleted on S3"));
    }
    Ok(RunResult { summary: parts.join(" · "), errors, files: db.files.len() })
}

async fn run_download<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, cancel: &Arc<AtomicBool>) -> Result<RunResult, String> {
    let mgr = app.state::<SyncManager>();
    let root = PathBuf::from(&m.local_path);
    if !root.is_dir() {
        return Err(format!("The folder {} is missing. Is the drive connected?", m.local_path));
    }
    let gi = build_ignore(&root, &m.ignore);
    let state = app.state::<AppState>();
    let client = client_for(app, &state, &m.profile_id).await?;
    let prefix = norm_prefix(&m.prefix);
    let remote = scan_remote(&client, &m.bucket, &prefix, &gi).await?;
    let (r2, g2) = (root.clone(), gi.clone());
    let local = tokio::task::spawn_blocking(move || scan_local(&r2, &g2)).await.map_err(err)?;
    let mut db = load_db(app, &m.id);

    let mut jobs = Vec::new();
    let mut kept_edits = 0;
    let mut conflicts = 0;
    for (rel, rf) in &remote {
        let tracked = db.files.get(rel);
        let lf = local.get(rel);
        let local_matches = |t: &Tracked| lf.is_some_and(|l| l.size == t.size && l.mtime == t.mtime);
        // None = nothing to do, Some(keep_local) = download, keeping the local file aside if true
        let action = match tracked {
            Some(t) if t.etag == rf.etag => match lf {
                None => Some(false), // deleted locally: the mirror puts it back
                Some(_) => {
                    if !local_matches(t) {
                        kept_edits += 1;
                    }
                    None
                }
            },
            Some(t) => match lf {
                None => Some(false),
                Some(_) if local_matches(t) => Some(false),
                Some(_) => Some(true), // changed on both sides
            },
            None => match lf {
                None => Some(false),
                Some(l) if l.size == rf.size => {
                    db.files.insert(rel.clone(), Tracked { size: l.size, mtime: l.mtime, etag: rf.etag.clone() });
                    None
                }
                Some(_) => Some(true),
            },
        };
        if let Some(keep_local) = action {
            if keep_local {
                conflicts += 1;
            }
            jobs.push(Job::Down {
                rel: rel.clone(),
                key: format!("{prefix}{rel}"),
                dest: local_path_of(&root, rel),
                etag: rf.etag.clone(),
                size: rf.size,
                keep_local,
            });
        }
    }

    let gone: Vec<String> = db.files.keys().filter(|k| !remote.contains_key(*k)).cloned().collect();
    let mut errors = Vec::new();
    let mut trash = Vec::new();
    for rel in gone {
        let t = db.files.remove(&rel).unwrap_or_default();
        if !m.mirror_deletes || is_ignored(&gi, &rel) {
            continue;
        }
        // only remove a file the user hasn't touched since it was downloaded
        if local.get(&rel).is_some_and(|l| l.size == t.size && l.mtime == t.mtime) {
            trash.push(local_path_of(&root, &rel));
        }
    }
    if !trash.is_empty() && remote.is_empty() {
        errors.push(format!(
            "The folder on S3 looks empty, so {} here were kept.",
            plural(trash.len(), "local file")
        ));
        trash.clear();
    }

    let total = (jobs.len() + trash.len()) as u32;
    if total > 0 {
        mgr.update(app, &m.id, |s| {
            s.state = "syncing".into();
            s.done = 0;
            s.total = total;
        });
    }
    let downloaded = run_jobs(app, m, &client, jobs, &mut db, cancel, 0, total, &mut errors).await;

    let mut trashed = 0;
    if !trash.is_empty() && !cancel.load(Ordering::Relaxed) {
        let n = trash.len();
        let res = tokio::task::spawn_blocking(move || trash::delete_all(&trash)).await.map_err(err)?;
        match res {
            Ok(()) => trashed = n,
            Err(e) => errors.push(format!("Could not move removed files to the Trash: {e}")),
        }
    }

    if !cancel.load(Ordering::Relaxed) {
        db.last_sync = Some(now_ms());
    }
    save_db(app, &m.id, &db)?;
    let mut parts = Vec::new();
    if downloaded > 0 {
        parts.push(format!("{downloaded} downloaded"));
    }
    if trashed > 0 {
        parts.push(format!("{trashed} moved to Trash"));
    }
    if conflicts > 0 {
        parts.push(format!("{} kept as local copies", plural(conflicts, "edited file")));
    }
    if kept_edits > 0 {
        parts.push(format!("{} not overwritten", plural(kept_edits, "local edit")));
    }
    Ok(RunResult { summary: parts.join(" · "), errors, files: db.files.len() })
}

/// Runs one sync of a mapping and reports the outcome. Returns false when it failed.
async fn run_and_report<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, full: bool, cancel: &Arc<AtomicBool>) -> bool {
    let mgr = app.state::<SyncManager>();
    let lock = mgr.run_lock(&m.id);
    let _guard = lock.lock().await;
    if cancel.load(Ordering::Relaxed) {
        return true;
    }
    mgr.update(app, &m.id, |s| {
        s.state = "scanning".into();
        s.current = None;
        s.done = 0;
        s.total = 0;
    });
    let result = match m.direction {
        Direction::Upload => run_upload(app, m, full, cancel).await,
        Direction::Download => run_download(app, m, cancel).await,
    };
    if cancel.load(Ordering::Relaxed) {
        return true;
    }
    match result {
        Ok(r) => {
            let failed = !r.errors.is_empty();
            let error = match r.errors.len() {
                0 => None,
                1 => Some(r.errors[0].clone()),
                n => Some(format!("{n} problems. {}", r.errors[0])),
            };
            mgr.update(app, &m.id, |s| {
                s.state = if failed { "error" } else { "idle" }.into();
                s.error = error;
                s.current = None;
                s.done = 0;
                s.total = 0;
                s.bytes = 0;
                s.total_bytes = 0;
                s.files = r.files as u32;
                s.last_sync = Some(now_ms());
                if !r.summary.is_empty() {
                    s.summary = Some(r.summary);
                }
            });
            !failed
        }
        Err(e) => {
            mgr.update(app, &m.id, |s| {
                s.state = "error".into();
                s.error = Some(e);
                s.current = None;
                s.done = 0;
                s.total = 0;
                s.bytes = 0;
                s.total_bytes = 0;
            });
            false
        }
    }
}

// ---------------------------------------------------------------- workers

fn make_watcher(path: &str, tx: mpsc::Sender<bool>) -> Option<Debouncer<RecommendedWatcher, RecommendedCache>> {
    let mut d = new_debouncer(Duration::from_secs(2), None, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let relevant = events.iter().any(|e| {
            !e.kind.is_access()
                && e.paths.iter().any(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
                    !name.ends_with(".s3part") && name != ".DS_Store"
                })
        });
        if relevant {
            let _ = tx.try_send(false);
        }
    })
    .ok()?;
    d.watch(Path::new(path), RecursiveMode::Recursive).ok()?;
    Some(d)
}

fn spawn_worker<R: Runtime>(app: AppHandle<R>, m: SyncMapping) -> Worker {
    let (tx, mut rx) = mpsc::channel::<bool>(16);
    let cancel = Arc::new(AtomicBool::new(false));
    let watcher = if m.direction == Direction::Upload { make_watcher(&m.local_path, tx.clone()) } else { None };
    let c = cancel.clone();
    tauri::async_runtime::spawn(async move {
        let interval = Duration::from_secs(u64::from(m.interval_mins.max(1)) * 60);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut wait: Option<Duration> = None; // None = run right away (first pass)
        loop {
            if c.load(Ordering::Relaxed) {
                break;
            }
            let mut full = match wait {
                None => true,
                Some(d) => tokio::select! {
                    t = rx.recv() => match t { Some(f) => f, None => break },
                    _ = tokio::time::sleep(d) => true,
                },
            };
            // let a burst of changes settle into one run
            while let Ok(f) = rx.try_recv() {
                full |= f;
            }
            if c.load(Ordering::Relaxed) {
                break;
            }
            let ok = run_and_report(&app, &m, full, &c).await;
            wait = Some(if ok { interval } else { RETRY_AFTER.min(interval) });
        }
    });
    Worker { cancel, tx, _watcher: watcher }
}

async fn stop_worker(mgr: &SyncManager, id: &str) {
    if let Some(w) = mgr.workers.lock().await.remove(id) {
        w.cancel.store(true, Ordering::Relaxed);
    }
}

/// (Re)starts the worker of a mapping to match its config.
async fn apply<R: Runtime>(app: &AppHandle<R>, mgr: &SyncManager, m: &SyncMapping, paused_all: bool) {
    stop_worker(mgr, &m.id).await;
    if m.paused || paused_all {
        mgr.update(app, &m.id, |s| {
            s.state = "paused".into();
            s.current = None;
            s.done = 0;
            s.total = 0;
        });
        return;
    }
    mgr.update(app, &m.id, |s| {
        if s.state == "paused" {
            s.state = "idle".into();
        }
    });
    let w = spawn_worker(app.clone(), m.clone());
    mgr.workers.lock().await.insert(m.id.clone(), w);
}

/// Loads saved mappings and starts syncing. Called once at startup.
pub async fn init<R: Runtime>(app: AppHandle<R>) {
    let mgr = app.state::<SyncManager>();
    let cfg = load_config(&app);
    for m in &cfg.mappings {
        let db = load_db(&app, &m.id);
        mgr.update(&app, &m.id, |s| {
            s.last_sync = db.last_sync;
            s.files = db.files.len() as u32;
        });
    }
    mgr.paused_flag.store(cfg.paused_all, Ordering::Relaxed);
    *mgr.config.lock().await = cfg.clone();
    for m in &cfg.mappings {
        apply(&app, &mgr, m, cfg.paused_all).await;
    }
    crate::tray::refresh(&app);
}

/// Kicks off a full sync of every running mapping (tray "Sync now").
pub async fn sync_all_now(mgr: &SyncManager) {
    for w in mgr.workers.lock().await.values() {
        let _ = w.tx.try_send(true);
    }
}

pub async fn set_paused_all<R: Runtime>(app: &AppHandle<R>, mgr: &SyncManager, paused: bool) -> Result<(), String> {
    let cfg = {
        let mut cfg = mgr.config.lock().await;
        cfg.paused_all = paused;
        save_config(app, &cfg)?;
        mgr.paused_flag.store(paused, Ordering::Relaxed);
        cfg.clone()
    };
    for m in &cfg.mappings {
        apply(app, mgr, m, paused).await;
    }
    crate::tray::refresh(app);
    Ok(())
}

fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (Path::new(a), Path::new(b));
    a.starts_with(b) || b.starts_with(a)
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn sync_list(mgr: State<'_, SyncManager>) -> Result<SyncOverview, String> {
    let cfg = mgr.config.lock().await.clone();
    Ok(SyncOverview { paused_all: cfg.paused_all, mappings: cfg.mappings, statuses: mgr.statuses() })
}

#[tauri::command]
pub async fn sync_save(app: AppHandle, mgr: State<'_, SyncManager>, mapping: SyncMapping) -> Result<SyncMapping, String> {
    let mut m = mapping;
    m.prefix = norm_prefix(&m.prefix);
    m.local_path = m.local_path.trim().trim_end_matches('/').to_string();
    if m.local_path.is_empty() || !Path::new(&m.local_path).is_dir() {
        return Err("Choose an existing local folder.".into());
    }
    if m.bucket.trim().is_empty() {
        return Err("Choose a bucket.".into());
    }
    m.ignore = m.ignore.iter().map(|l| l.trim_end().to_string()).filter(|l| !l.trim().is_empty()).collect();
    m.interval_mins = m.interval_mins.clamp(1, 1440);

    let (cfg, reset) = {
        let mut cfg = mgr.config.lock().await;
        if let Some(other) = cfg.mappings.iter().find(|o| o.id != m.id && overlaps(&o.local_path, &m.local_path)) {
            return Err(format!("{} is already synced (or inside a synced folder). Pick a different folder.", other.local_path));
        }
        let mut reset = false;
        if m.id.is_empty() {
            m.id = uuid::Uuid::new_v4().to_string();
            cfg.mappings.push(m.clone());
        } else if let Some(slot) = cfg.mappings.iter_mut().find(|o| o.id == m.id) {
            // what we know about synced files is only valid for the same two places
            reset = slot.local_path != m.local_path
                || slot.profile_id != m.profile_id
                || slot.bucket != m.bucket
                || slot.prefix != m.prefix
                || slot.direction != m.direction;
            *slot = m.clone();
        } else {
            return Err("This sync folder no longer exists.".into());
        }
        save_config(&app, &cfg)?;
        (cfg.clone(), reset)
    };
    if reset {
        stop_worker(&mgr, &m.id).await;
        let lock = mgr.run_lock(&m.id);
        let _g = lock.lock().await; // wait for a run in progress to stop
        forget_db(&app, &m.id);
        mgr.update(&app, &m.id, |s| {
            s.files = 0;
            s.last_sync = None;
            s.summary = None;
            s.error = None;
        });
    }
    apply(&app, &mgr, &m, cfg.paused_all).await;
    Ok(m)
}

#[tauri::command]
pub async fn sync_delete(app: AppHandle, mgr: State<'_, SyncManager>, id: String) -> Result<(), String> {
    stop_worker(&mgr, &id).await;
    {
        let mut cfg = mgr.config.lock().await;
        cfg.mappings.retain(|m| m.id != id);
        save_config(&app, &cfg)?;
    }
    forget_db(&app, &id);
    mgr.status.lock().unwrap().remove(&id);
    crate::tray::refresh(&app);
    Ok(())
}

#[tauri::command]
pub async fn sync_now(mgr: State<'_, SyncManager>, id: String) -> Result<(), String> {
    match mgr.workers.lock().await.get(&id) {
        Some(w) => {
            let _ = w.tx.try_send(true);
            Ok(())
        }
        None => Err("This folder is paused. Resume it first.".into()),
    }
}

#[tauri::command]
pub async fn sync_set_paused(app: AppHandle, mgr: State<'_, SyncManager>, id: String, paused: bool) -> Result<(), String> {
    let (m, paused_all) = {
        let mut cfg = mgr.config.lock().await;
        let slot = cfg.mappings.iter_mut().find(|m| m.id == id).ok_or("This sync folder no longer exists.")?;
        slot.paused = paused;
        let m = slot.clone();
        save_config(&app, &cfg)?;
        (m, cfg.paused_all)
    };
    apply(&app, &mgr, &m, paused_all).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_pause_all(app: AppHandle, mgr: State<'_, SyncManager>, paused: bool) -> Result<(), String> {
    set_paused_all(&app, &mgr, paused).await
}

/// End-to-end tests against a real S3 endpoint. They need a throwaway server, e.g.
/// `rclone serve s3 --auth-key testkey,testsecret --addr 127.0.0.1:9123 <dir>` with a
/// `testbucket` folder in `<dir>`, and run with `KYBL_TEST_ENDPOINT=http://127.0.0.1:9123`.
/// Without that variable they are skipped.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};
    use std::fs;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    const PID: &str = "test-profile";
    const BUCKET: &str = "testbucket";

    fn app() -> Option<tauri::App<MockRuntime>> {
        let endpoint = std::env::var("KYBL_TEST_ENDPOINT").ok()?;
        let app = mock_builder()
            .manage(AppState::default())
            .manage(SyncManager::default())
            .build(mock_context(noop_assets()))
            .unwrap();
        let profile = Profile {
            id: PID.into(),
            name: "test".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
        };
        let client = build_client(&profile, "testsecret");
        tauri::async_runtime::block_on(async {
            app.state::<AppState>().clients.lock().await.insert(PID.into(), client);
        });
        Some(app)
    }

    fn mapping(id: &str, local: &Path, prefix: &str, direction: Direction, mirror: bool) -> SyncMapping {
        SyncMapping {
            id: id.into(),
            profile_id: PID.into(),
            bucket: BUCKET.into(),
            prefix: prefix.into(),
            local_path: local.to_string_lossy().into(),
            direction,
            ignore: vec!["*.tmp".into(), "node_modules/".into(), ".DS_Store".into()],
            mirror_deletes: mirror,
            interval_mins: 5,
            paused: false,
        }
    }

    async fn remote_keys(app: &tauri::App<MockRuntime>, prefix: &str) -> Vec<String> {
        let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
        let mut keys: Vec<String> = list_all(&client, BUCKET, prefix).await.unwrap().into_iter().map(|o| o.key).collect();
        keys.sort();
        keys
    }

    async fn put(app: &tauri::App<MockRuntime>, key: &str, body: &str) {
        let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
        client
            .put_object()
            .bucket(BUCKET)
            .key(key)
            .body(aws_sdk_s3::primitives::ByteStream::from(body.as_bytes().to_vec()))
            .send()
            .await
            .unwrap();
    }

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("s3b-sync-test-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn upload_mapping() {
        let Some(app) = app() else { return eprintln!("skipped: KYBL_TEST_ENDPOINT not set") };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("up");
            let prefix = format!("up-{}/", uuid::Uuid::new_v4());
            write(&dir.join("a.txt"), "hello");
            write(&dir.join("sub/b.txt"), "world");
            write(&dir.join("scratch.tmp"), "ignored");
            write(&dir.join("node_modules/x.js"), "ignored");
            write(&dir.join(".DS_Store"), "ignored");
            let m = mapping("t-up", &dir, &prefix, Direction::Upload, true);
            forget_db(&h, &m.id);

            let r = run_upload(&h, &m, true, &cancel()).await.unwrap();
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            assert_eq!(r.summary, "2 uploaded");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt"), format!("{prefix}sub/b.txt")]);

            // nothing changed: nothing to do, quick and full
            assert_eq!(run_upload(&h, &m, false, &cancel()).await.unwrap().summary, "");
            assert_eq!(run_upload(&h, &m, true, &cancel()).await.unwrap().summary, "");

            // an edit goes up on a quick (watcher) run
            std::thread::sleep(Duration::from_millis(20));
            write(&dir.join("a.txt"), "hello again");
            assert_eq!(run_upload(&h, &m, false, &cancel()).await.unwrap().summary, "1 uploaded");

            // removed on S3 behind our back: a full run restores it
            let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
            client.delete_object().bucket(BUCKET).key(format!("{prefix}sub/b.txt")).send().await.unwrap();
            assert_eq!(run_upload(&h, &m, true, &cancel()).await.unwrap().summary, "1 uploaded");

            // mirrored deletion
            fs::remove_file(dir.join("sub/b.txt")).unwrap();
            assert_eq!(run_upload(&h, &m, false, &cancel()).await.unwrap().summary, "1 deleted on S3");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt")]);

            // newly ignored files are forgotten, not deleted
            let mut m2 = m.clone();
            m2.ignore.push("a.txt".into());
            let r = run_upload(&h, &m2, false, &cancel()).await.unwrap();
            assert_eq!(r.summary, "");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt")]);

            // an emptied folder (unmounted drive...) never wipes the bucket
            let r = run_upload(&h, &m, true, &cancel()).await.unwrap(); // re-track a.txt
            assert!(r.errors.is_empty());
            fs::remove_file(dir.join("a.txt")).unwrap();
            let r = run_upload(&h, &m, false, &cancel()).await.unwrap();
            assert_eq!(r.errors.len(), 1, "expected the safety stop");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt")]);

            // a missing folder is an error, not "everything was deleted"
            let gone = mapping("t-up-gone", &dir.join("nope"), &prefix, Direction::Upload, true);
            assert!(run_upload(&h, &gone, true, &cancel()).await.is_err());

            forget_db(&h, &m.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn upload_adopts_existing_copy() {
        let Some(app) = app() else { return };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("adopt");
            let prefix = format!("adopt-{}/", uuid::Uuid::new_v4());
            write(&dir.join("same.txt"), "12345");
            std::thread::sleep(Duration::from_millis(1100));
            put(&app, &format!("{prefix}same.txt"), "12345").await; // newer, same size
            let m = mapping("t-adopt", &dir, &prefix, Direction::Upload, false);
            forget_db(&h, &m.id);
            let r = run_upload(&h, &m, true, &cancel()).await.unwrap();
            assert_eq!(r.summary, "", "an identical copy on S3 must not be uploaded again");
            assert_eq!(r.files, 1);
            forget_db(&h, &m.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn download_mapping() {
        let Some(app) = app() else { return };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("down");
            let prefix = format!("down-{}/", uuid::Uuid::new_v4());
            put(&app, &format!("{prefix}one.txt"), "one").await;
            put(&app, &format!("{prefix}deep/two.txt"), "two").await;
            put(&app, &format!("{prefix}skip.tmp"), "ignored").await;
            // (folder markers like "dir/" can't be tested here: rclone stores them as plain files)
            let m = mapping("t-down", &dir, &prefix, Direction::Download, false);
            forget_db(&h, &m.id);

            let r = run_download(&h, &m, &cancel()).await.unwrap();
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            assert_eq!(r.summary, "2 downloaded");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "one");
            assert_eq!(fs::read_to_string(dir.join("deep/two.txt")).unwrap(), "two");
            assert!(!dir.join("skip.tmp").exists());
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "");

            // changed remotely, untouched locally: overwritten
            put(&app, &format!("{prefix}one.txt"), "one v2").await;
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "1 downloaded");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "one v2");

            // edited locally only: left alone
            std::thread::sleep(Duration::from_millis(20));
            write(&dir.join("one.txt"), "my local edit");
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "1 local edit not overwritten");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "my local edit");

            // edited on both sides: the local edit is kept as a copy
            put(&app, &format!("{prefix}one.txt"), "one v3").await;
            let r = run_download(&h, &m, &cancel()).await.unwrap();
            assert_eq!(r.summary, "1 downloaded · 1 edited file kept as local copies");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "one v3");
            assert_eq!(fs::read_to_string(dir.join("one (local copy).txt")).unwrap(), "my local edit");

            // deleted locally: the mirror restores it
            fs::remove_file(dir.join("deep/two.txt")).unwrap();
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "1 downloaded");
            assert!(dir.join("deep/two.txt").exists());

            // removed remotely without mirror deletions: local copy stays
            let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
            client.delete_object().bucket(BUCKET).key(format!("{prefix}deep/two.txt")).send().await.unwrap();
            run_download(&h, &m, &cancel()).await.unwrap();
            assert!(dir.join("deep/two.txt").exists());

            // with mirror deletions an empty listing never empties the local folder
            let mut wipe = mapping("t-down-wipe", &dir, &format!("{prefix}deep/"), Direction::Download, true);
            wipe.ignore.clear();
            forget_db(&h, &wipe.id);
            put(&app, &format!("{prefix}deep/three.txt"), "3").await;
            run_download(&h, &wipe, &cancel()).await.unwrap();
            client.delete_object().bucket(BUCKET).key(format!("{prefix}deep/three.txt")).send().await.unwrap();
            let r = run_download(&h, &wipe, &cancel()).await.unwrap();
            assert_eq!(r.errors.len(), 1, "expected the safety stop");
            assert!(dir.join("three.txt").exists());

            forget_db(&h, &m.id);
            forget_db(&h, &wipe.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn watcher_uploads_changes() {
        let Some(app) = app() else { return };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("watch");
            let prefix = format!("watch-{}/", uuid::Uuid::new_v4());
            let m = mapping("t-watch", &dir, &prefix, Direction::Upload, false);
            forget_db(&h, &m.id);
            let mgr = h.state::<SyncManager>();
            apply(&h, &mgr, &m, false).await;
            tokio::time::sleep(Duration::from_secs(4)).await; // first full run
            write(&dir.join("new.txt"), "watched");
            let mut ok = false;
            for _ in 0..30 {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if remote_keys(&app, &prefix).await.contains(&format!("{prefix}new.txt")) {
                    ok = true;
                    break;
                }
            }
            stop_worker(&mgr, &m.id).await;
            assert!(ok, "the watcher should upload a new file within seconds");
            let st = mgr.statuses().into_iter().find(|s| s.id == m.id).unwrap();
            assert_eq!(st.state, "idle");
            forget_db(&h, &m.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }
}
