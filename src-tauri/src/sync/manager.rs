//! The mappings at work: one worker per mapping (a watcher plus a timer), live status for the
//! page and the menu bar, and the commands.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{mpsc, Mutex};

use super::{
    config::{load_config, new_overlap, norm_prefix, save_config, Direction, SyncConfig, SyncMapping},
    local::{self, make_watcher, Dirty, Watcher},
    plan::Side,
    runner::{self, Engine, RunResult, Tick},
    state::{PendingDelete, SyncDb},
};
use crate::{
    state::{err, load_profiles, AppState, Profile},
    storage::{self, s3::S3Backend, ConnKind, Conn, Storage},
};

/// Retry sooner than the normal interval after a failed run.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// What a new "Keep on this device" folder leaves out.
const DEFAULT_IGNORE: [&str; 8] = [".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", "*.swp", "~$*", ".git/", "node_modules/"];

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
    /// conflict copies waiting to be looked at
    pub conflicts: u32,
    /// deletions held until the user confirms them
    pub pending_deletes: u32,
}

struct Worker {
    cancel: Arc<AtomicBool>,
    tx: mpsc::Sender<bool>,
    _watcher: Option<Watcher>,
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
    db: std::sync::Mutex<Option<Arc<SyncDb>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOverview {
    paused_all: bool,
    mappings: Vec<SyncMapping>,
    statuses: Vec<SyncStatus>,
}

/// A conflict copy, with the files on disk to open or show.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    path: String,
    copy: String,
    created_at: i64,
    /// the version that kept the name (from the other side)
    local_path: String,
    /// this computer's version
    copy_local_path: String,
}

// ---------------------------------------------------------------- database

fn legacy_json<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("sync").join(format!("{id}.json")))
}

impl SyncManager {
    /// sync.db, opened on first use.
    pub fn db<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<SyncDb>, String> {
        let mut slot = self.db.lock().unwrap();
        if let Some(db) = slot.as_ref() {
            return Ok(db.clone());
        }
        let path = app.path().app_data_dir().map_err(err)?.join("sync.db");
        let db = Arc::new(SyncDb::open(&path)?);
        *slot = Some(db.clone());
        Ok(db)
    }

    fn update<R: Runtime>(&self, app: &AppHandle<R>, id: &str, f: impl FnOnce(&mut SyncStatus)) {
        let snapshot = {
            let mut map = self.status.lock().unwrap();
            let s = map.entry(id.to_string()).or_insert_with(|| SyncStatus { id: id.to_string(), state: "idle".into(), ..Default::default() });
            f(s);
            s.clone()
        };
        let _ = app.emit("sync-status", snapshot);
        crate::app::tray::refresh(app);
    }

    pub fn statuses(&self) -> Vec<SyncStatus> {
        self.status.lock().unwrap().values().cloned().collect()
    }

    fn run_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.run_locks.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    async fn mapping(&self, id: &str) -> Result<SyncMapping, String> {
        self.config.lock().await.mappings.iter().find(|m| m.id == id).cloned().ok_or_else(|| "This sync folder no longer exists.".into())
    }

    /// Asks the mapping's worker for a run (false: quick, true: full).
    async fn kick(&self, id: &str, full: bool) -> bool {
        match self.workers.lock().await.get(id) {
            Some(w) => {
                let _ = w.tx.try_send(full);
                true
            }
            None => false,
        }
    }
}

/// Forgets everything a mapping knew about its files (it was removed, or points elsewhere now).
pub fn forget_db<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = try_forget_db(app, id);
}

/// [`forget_db`], saying when the sync database couldn't be changed.
fn try_forget_db<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let forgot = app.state::<SyncManager>().db(app).and_then(|db| db.forget(id));
    if let Some(p) = legacy_json(app, id) {
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(p.with_extension("json.bak"));
    }
    forgot
}

// ---------------------------------------------------------------- one run

/// The connection a mapping syncs with, through the same backends the browser uses. S3 goes
/// through its adapter (multipart uploads, resuming downloads), everything else through its own.
async fn open_remote<R: Runtime>(app: &AppHandle<R>, profile_id: &str) -> Result<Arc<dyn Storage>, String> {
    let state = app.state::<AppState>();
    match storage::connect(app, &state, profile_id).await? {
        Conn::S3(client) => {
            let profile = load_profiles(app)
                .ok()
                .and_then(|ps| ps.into_iter().find(|p| p.id == profile_id))
                .unwrap_or_else(|| Profile { id: profile_id.to_string(), provider: "custom".into(), ..Default::default() });
            Ok(Arc::new(S3Backend::new(client, &profile)))
        }
        Conn::Other(s) => Ok(s),
    }
}

/// Runs `f` with the engine of mapping `m`, its progress going to the mapping's status.
async fn with_engine<R: Runtime, T>(
    app: &AppHandle<R>,
    m: &SyncMapping,
    cancel: &Arc<AtomicBool>,
    f: impl AsyncFnOnce(&Engine<'_>) -> Result<T, String>,
) -> Result<T, String> {
    let mgr = app.state::<SyncManager>();
    let db = mgr.db(app)?;
    let remote = open_remote(app, &m.profile_id).await?;
    let mgr_ref: &SyncManager = &mgr;
    let report = move |t: Tick| {
        mgr_ref.update(app, &m.id, |s| {
            s.state = "syncing".into();
            s.done = t.done;
            s.total = t.total;
            s.bytes = t.bytes;
            s.total_bytes = t.total_bytes;
            s.current = t.current;
        })
    };
    let engine = Engine {
        id: m.id.clone(),
        local_root: local::sync_root(&m.local_path),
        remote,
        root: m.bucket.clone(),
        prefix: norm_prefix(&m.prefix),
        ignore: m.ignore.clone(),
        mirror_deletes: m.mirror_deletes,
        remote_trash: m.remote_trash(),
        delete_guard: m.delete_guard,
        local_trash: true,
        db: &db,
        cancel: cancel.clone(),
        report: &report,
    };
    f(&engine).await
}

#[cfg(test)]
pub async fn run_upload<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, full: bool, cancel: &Arc<AtomicBool>) -> Result<RunResult, String> {
    run_upload_dirty(app, m, full, None, cancel).await
}

async fn run_upload_dirty<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, full: bool, dirty: Option<HashSet<PathBuf>>, cancel: &Arc<AtomicBool>) -> Result<RunResult, String> {
    with_engine(app, m, cancel, async |e| e.upload(full, dirty).await).await
}

pub async fn run_download<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, cancel: &Arc<AtomicBool>) -> Result<RunResult, String> {
    with_engine(app, m, cancel, async |e| e.download().await).await
}

pub async fn run_twoway<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, full: bool, dirty: Option<HashSet<PathBuf>>, cancel: &Arc<AtomicBool>) -> Result<RunResult, String> {
    with_engine(app, m, cancel, async |e| e.twoway(full, dirty).await).await
}

/// How a run ended, for when the next one is due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunEnd {
    Ok,
    /// its only problem is deletions held for the user (confirming them starts a run)
    Waiting,
    Failed,
}

impl RunEnd {
    fn of(r: &RunResult) -> Self {
        match r.errors.len() {
            0 => RunEnd::Ok,
            1 if r.pending > 0 => RunEnd::Waiting,
            _ => RunEnd::Failed,
        }
    }
}

/// When the next timed (full) run is due: the mapping's interval, or sooner after a failure,
/// waiting twice as long after each failure in a row so a problem that stays doesn't list
/// everything every minute.
fn next_wait(end: RunEnd, fails_in_a_row: u32, interval: Duration) -> Duration {
    match end {
        RunEnd::Ok | RunEnd::Waiting => interval,
        RunEnd::Failed => RETRY_AFTER.saturating_mul(1 << fails_in_a_row.saturating_sub(1).min(16)).min(interval),
    }
}

/// Runs one sync of a mapping and reports the outcome.
async fn run_and_report<R: Runtime>(app: &AppHandle<R>, m: &SyncMapping, full: bool, dirty: Option<HashSet<PathBuf>>, cancel: &Arc<AtomicBool>) -> RunEnd {
    let mgr = app.state::<SyncManager>();
    let lock = mgr.run_lock(&m.id);
    let _guard = lock.lock().await;
    if cancel.load(Ordering::Relaxed) {
        return RunEnd::Ok;
    }
    mgr.update(app, &m.id, |s| {
        s.state = "scanning".into();
        s.current = None;
        s.done = 0;
        s.total = 0;
    });
    let result = match m.direction {
        Direction::Upload => run_upload_dirty(app, m, full, dirty, cancel).await,
        Direction::Download => run_download(app, m, cancel).await,
        Direction::Twoway => run_twoway(app, m, full, dirty, cancel).await,
    };
    if cancel.load(Ordering::Relaxed) {
        return RunEnd::Ok;
    }
    match result {
        Ok(r) => {
            let end = RunEnd::of(&r);
            let failed = !r.errors.is_empty();
            let error = match r.errors.len() {
                0 => None,
                1 => Some(r.errors[0].clone()),
                n => Some(format!("{n} problems. {}\n\n{}", r.errors[0], r.errors.join("\n"))),
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
                s.conflicts = r.conflicts as u32;
                s.pending_deletes = r.pending as u32;
                s.last_sync = Some(local::now_ms());
                if !r.summary.is_empty() {
                    s.summary = Some(r.summary);
                }
            });
            end
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
            RunEnd::Failed
        }
    }
}

// ---------------------------------------------------------------- workers

fn spawn_worker<R: Runtime>(app: AppHandle<R>, m: SyncMapping) -> Worker {
    let (tx, mut rx) = mpsc::channel::<bool>(16);
    let cancel = Arc::new(AtomicBool::new(false));
    let dirty = Arc::new(std::sync::Mutex::new(Dirty::default()));
    // a download mirror only follows the other side; the others react to local changes at once
    let watcher = if m.direction != Direction::Download { make_watcher(&local::sync_root(&m.local_path), tx.clone(), dirty.clone()) } else { None };
    let c = cancel.clone();
    tauri::async_runtime::spawn(async move {
        let interval = Duration::from_secs(u64::from(m.interval_mins.max(1)) * 60);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut wait: Option<Duration> = None; // None = run right away (first pass)
        let mut fails = 0u32;
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
            // a full run scans everything anyway; a quick one only what the watcher saw
            let taken = dirty.lock().unwrap().take();
            let seen = if full { None } else { taken };
            let end = run_and_report(&app, &m, full, seen.clone(), &c).await;
            if end != RunEnd::Ok
                && let Some(paths) = seen
            {
                // not handled: the next quick run looks at them again
                dirty.lock().unwrap().paths.extend(paths);
            }
            fails = if end == RunEnd::Failed { fails.saturating_add(1) } else { 0 };
            wait = Some(next_wait(end, fails, interval));
        }
    });
    Worker { cancel, tx, _watcher: watcher }
}

pub async fn stop_worker(mgr: &SyncManager, id: &str) {
    if let Some(w) = mgr.workers.lock().await.remove(id) {
        w.cancel.store(true, Ordering::Relaxed);
    }
}

/// (Re)starts the worker of a mapping to match its config.
pub async fn apply<R: Runtime>(app: &AppHandle<R>, mgr: &SyncManager, m: &SyncMapping, paused_all: bool) {
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

/// What sync.db knows about a mapping, for its status before the first run.
fn known_state<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<(Option<i64>, usize, usize, usize)> {
    let db = app.state::<SyncManager>().db(app).ok()?;
    if let Some(json) = legacy_json(app, id)
        && let Err(e) = db.import_legacy(id, &json)
    {
        eprintln!("sync: keeping {} for later: {e}", json.display());
    }
    Some((db.cursor(id).ok()?.last_sync, db.base_count(id).ok()?, db.conflicts(id).ok()?.len(), db.pending(id).ok()?.len()))
}

/// Loads saved mappings and starts syncing. Called once at startup.
pub async fn init<R: Runtime>(app: AppHandle<R>) {
    let mgr = app.state::<SyncManager>();
    let cfg = load_config(&app);
    for m in &cfg.mappings {
        let known = known_state(&app, &m.id);
        mgr.update(&app, &m.id, |s| {
            if let Some((last, files, conflicts, pending)) = known {
                s.last_sync = last;
                s.files = files as u32;
                s.conflicts = conflicts as u32;
                s.pending_deletes = pending as u32;
            }
        });
    }
    mgr.paused_flag.store(cfg.paused_all, Ordering::Relaxed);
    *mgr.config.lock().await = cfg.clone();
    for m in &cfg.mappings {
        apply(&app, &mgr, m, cfg.paused_all).await;
    }
    crate::app::tray::refresh(&app);
}

/// Kicks off a full sync of every running mapping (tray "Sync now").
pub async fn sync_all_now(mgr: &SyncManager) {
    for w in mgr.workers.lock().await.values() {
        let _ = w.tx.try_send(true);
    }
}

/// Changes the sync settings: a copy is changed by `f` and saved, and only then takes the place
/// of the one in memory, so a failed save changes nothing (the page is told it failed, and the
/// running app must not act as if it hadn't). `f`'s answer comes back with the new settings.
async fn change_config<R: Runtime, T>(app: &AppHandle<R>, mgr: &SyncManager, f: impl FnOnce(&mut SyncConfig) -> Result<T, String>) -> Result<(T, SyncConfig), String> {
    let mut cfg = mgr.config.lock().await;
    let mut next = cfg.clone();
    let out = f(&mut next)?;
    save_config(app, &next)?;
    *cfg = next.clone();
    mgr.paused_flag.store(next.paused_all, Ordering::Relaxed);
    Ok((out, next))
}

pub async fn set_paused_all<R: Runtime>(app: &AppHandle<R>, mgr: &SyncManager, paused: bool) -> Result<(), String> {
    let cfg = change_config(app, mgr, |cfg| {
        cfg.paused_all = paused;
        Ok(())
    })
    .await?
    .1;
    for m in &cfg.mappings {
        apply(app, mgr, m, paused).await;
    }
    crate::app::tray::refresh(app);
    Ok(())
}

/// Connections whose one root has no name ("bucket" is "").
fn single_root(kind: ConnKind) -> bool {
    matches!(kind, ConnKind::Ftp | ConnKind::Sftp | ConnKind::Webdav | ConnKind::Dropbox | ConnKind::BoxCom)
}

/// Checks and saves a mapping, and (re)starts its worker.
async fn save_mapping<R: Runtime>(app: &AppHandle<R>, mgr: &SyncManager, mapping: SyncMapping) -> Result<SyncMapping, String> {
    let mut m = mapping;
    m.prefix = norm_prefix(&m.prefix);
    m.local_path = m.local_path.trim().trim_end_matches('/').to_string();
    if m.local_path.is_empty() || !Path::new(&m.local_path).is_dir() {
        return Err("Choose an existing local folder.".into());
    }
    let kind = load_profiles(app).ok().and_then(|ps| ps.into_iter().find(|p| p.id == m.profile_id)).map(|p| p.kind);
    m.bucket = m.bucket.trim().to_string();
    if m.bucket.is_empty() && !kind.is_some_and(single_root) {
        return Err("Choose a bucket.".into());
    }
    m.ignore = m.ignore.iter().map(|l| l.trim_end().to_string()).filter(|l| !l.trim().is_empty()).collect();
    m.interval_mins = m.interval_mins.clamp(1, 1440);

    // B4-3 (round 5): new places for a mapping drop what it knew about the old ones before the
    // new places are saved, with its runs stopped meanwhile. Saved first, a quit or a failed drop
    // in between would leave the new places with the old base, and the next run would take every
    // old file for one deleted over there. Dropped first, the worst left is the old places with
    // no base, which only merges.
    let (moving, paused_all) = {
        let cfg = mgr.config.lock().await;
        if let Some(other) = new_overlap(&cfg.mappings, &m) {
            return Err(format!("{} is already synced (or inside a synced folder). Pick a different folder.", other.local_path));
        }
        let old = if m.id.is_empty() { None } else { cfg.mappings.iter().find(|o| o.id == m.id && o.places() != m.places()).cloned() };
        (old, cfg.paused_all)
    };
    let lock = mgr.run_lock(&m.id);
    let held = match &moving {
        Some(old) => {
            stop_worker(mgr, &m.id).await;
            let g = lock.lock().await; // wait for a run in progress to stop
            if let Err(e) = try_forget_db(app, &m.id) {
                drop(g);
                apply(app, mgr, old, paused_all).await;
                return Err(format!("Couldn't change this sync folder: {e}"));
            }
            Some(g)
        }
        None => None,
    };

    let changed = change_config(app, mgr, |cfg| {
        if let Some(other) = new_overlap(&cfg.mappings, &m) {
            return Err(format!("{} is already synced (or inside a synced folder). Pick a different folder.", other.local_path));
        }
        let mut reset = false;
        if m.id.is_empty() {
            m.id = uuid::Uuid::new_v4().to_string();
            cfg.mappings.push(m.clone());
        } else if let Some(slot) = cfg.mappings.iter_mut().find(|o| o.id == m.id) {
            // what we know about synced files is only valid for the same two places (a new
            // direction keeps it: the base means the same whichever way files go)
            reset = slot.places() != m.places();
            *slot = m.clone();
        } else {
            return Err("This sync folder no longer exists.".into());
        }
        Ok(reset)
    })
    .await;
    let (reset, cfg) = match changed {
        Ok(r) => r,
        Err(e) => {
            if let Some(old) = &moving {
                // the old places, now with no base: the next run only merges
                drop(held);
                apply(app, mgr, old, paused_all).await;
            }
            return Err(e);
        }
    };
    if reset {
        stop_worker(mgr, &m.id).await;
        if held.is_none() {
            // changed meanwhile by another save: dropped now, the old way
            let _g = lock.lock().await;
            forget_db(app, &m.id);
        }
        mgr.update(app, &m.id, |s| {
            s.files = 0;
            s.last_sync = None;
            s.summary = None;
            s.error = None;
            s.conflicts = 0;
            s.pending_deletes = 0;
        });
    }
    apply(app, mgr, &m, cfg.paused_all).await;
    Ok(m)
}

/// A file or folder name made from something the user named (a connection, a bucket).
fn safe_name(s: &str) -> String {
    let clean: String = s.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '-' } else { c }).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "Files".into() } else { clean }
}

/// Where "Keep on this device" puts a folder: ~/Kybl/<connection>/<bucket>/<folder>.
fn offline_folder(home: &Path, connection: &str, bucket: &str, prefix: &str) -> PathBuf {
    let mut p = home.join("Kybl").join(safe_name(connection));
    if !bucket.is_empty() {
        p.push(safe_name(bucket));
    }
    for part in prefix.split('/').filter(|s| !s.is_empty()) {
        p.push(safe_name(part));
    }
    p
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn sync_list(mgr: State<'_, SyncManager>) -> Result<SyncOverview, String> {
    let cfg = mgr.config.lock().await.clone();
    Ok(SyncOverview { paused_all: cfg.paused_all, mappings: cfg.mappings, statuses: mgr.statuses() })
}

#[tauri::command]
pub async fn sync_save(app: AppHandle, mgr: State<'_, SyncManager>, mapping: SyncMapping) -> Result<SyncMapping, String> {
    save_mapping(&app, &mgr, mapping).await
}

#[tauri::command]
pub async fn sync_delete(app: AppHandle, mgr: State<'_, SyncManager>, id: String) -> Result<(), String> {
    // out of the saved settings first: a failed save leaves the folder syncing as it was
    change_config(&app, &mgr, |cfg| {
        cfg.mappings.retain(|m| m.id != id);
        Ok(())
    })
    .await?;
    stop_worker(&mgr, &id).await;
    forget_db(&app, &id);
    mgr.status.lock().unwrap().remove(&id);
    crate::app::tray::refresh(&app);
    Ok(())
}

#[tauri::command]
pub async fn sync_now(mgr: State<'_, SyncManager>, id: String) -> Result<(), String> {
    if mgr.kick(&id, true).await { Ok(()) } else { Err("This folder is paused. Resume it first.".into()) }
}

#[tauri::command]
pub async fn sync_set_paused(app: AppHandle, mgr: State<'_, SyncManager>, id: String, paused: bool) -> Result<(), String> {
    let (m, cfg) = change_config(&app, &mgr, |cfg| {
        let slot = cfg.mappings.iter_mut().find(|m| m.id == id).ok_or("This sync folder no longer exists.")?;
        slot.paused = paused;
        Ok(slot.clone())
    })
    .await?;
    apply(&app, &mgr, &m, cfg.paused_all).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_pause_all(app: AppHandle, mgr: State<'_, SyncManager>, paused: bool) -> Result<(), String> {
    set_paused_all(&app, &mgr, paused).await
}

/// The conflict copies of a mapping, newest first.
#[tauri::command]
pub async fn sync_conflicts(app: AppHandle, mgr: State<'_, SyncManager>, id: String) -> Result<Vec<ConflictInfo>, String> {
    let m = mgr.mapping(&id).await?;
    let root = PathBuf::from(&m.local_path);
    Ok(mgr
        .db(&app)?
        .conflicts(&id)?
        .into_iter()
        .map(|c| ConflictInfo {
            local_path: local::local_path_of(&root, &c.path).to_string_lossy().into_owned(),
            copy_local_path: local::local_path_of(&root, &c.copy).to_string_lossy().into_owned(),
            path: c.path,
            copy: c.copy,
            created_at: c.created_at,
        })
        .collect())
}

/// Settles a conflict: `keep` is "both", "original" (the version that kept the name) or "copy"
/// (this computer's version). The next run sends the outcome to the other side.
#[tauri::command]
pub async fn sync_resolve_conflict(app: AppHandle, mgr: State<'_, SyncManager>, id: String, copy: String, keep: String) -> Result<(), String> {
    let m = mgr.mapping(&id).await?;
    let db = mgr.db(&app)?;
    let lock = mgr.run_lock(&id);
    {
        let _g = lock.lock().await;
        let root = PathBuf::from(&m.local_path);
        let (db2, id2) = (db.clone(), id.clone());
        tokio::task::spawn_blocking(move || runner::resolve_conflict(&db2, &id2, &root, &copy, &keep, true)).await.map_err(err)??;
    }
    let n = db.conflicts(&id)?.len() as u32;
    mgr.update(&app, &id, |s| s.conflicts = n);
    mgr.kick(&id, false).await;
    Ok(())
}

/// Deletions the guard is holding for the user.
#[tauri::command]
pub async fn sync_pending(app: AppHandle, mgr: State<'_, SyncManager>, id: String) -> Result<Vec<PendingDelete>, String> {
    mgr.db(&app)?.pending(&id)
}

/// One held deletion as the user saw it.
#[derive(Deserialize)]
pub struct ConfirmItem {
    pub path: String,
    pub side: Side,
}

/// "Delete them": the held deletions the user was shown (`items`) go ahead on the next run,
/// which starts now. If a run changed the list meanwhile nothing is confirmed, and the UI is
/// told to show the list again.
#[tauri::command]
pub async fn sync_confirm_deletes(app: AppHandle, mgr: State<'_, SyncManager>, id: String, items: Vec<ConfirmItem>) -> Result<(), String> {
    let items: Vec<(String, Side)> = items.into_iter().map(|i| (i.path, i.side)).collect();
    if !mgr.db(&app)?.confirm_exact(&id, &items)? {
        return Err("The list of files changed since you looked. Check it again, then confirm.".into());
    }
    if !mgr.kick(&id, true).await {
        return Err("This folder is paused. Resume it to delete the files.".into());
    }
    Ok(())
}

/// "Keep the files": the held deletions are dropped and the files are copied back where they
/// were deleted.
#[tauri::command]
pub async fn sync_restore_deletes(app: AppHandle, mgr: State<'_, SyncManager>, id: String) -> Result<(), String> {
    let db = mgr.db(&app)?;
    {
        let lock = mgr.run_lock(&id);
        let _g = lock.lock().await;
        db.restore_pending(&id)?;
    }
    mgr.update(&app, &id, |s| {
        s.pending_deletes = 0;
        if s.state == "error" {
            s.state = "idle".into();
            s.error = None;
        }
    });
    mgr.kick(&id, true).await;
    Ok(())
}

/// "Keep on this device": a two-way synced copy of a remote folder in `local_path`, or by
/// default in ~/Kybl/<connection>/<bucket>/<folder>. A folder already kept is returned as it is.
#[tauri::command]
pub async fn sync_keep_offline(
    app: AppHandle,
    mgr: State<'_, SyncManager>,
    profile_id: String,
    bucket: String,
    prefix: String,
    local_path: Option<String>,
) -> Result<SyncMapping, String> {
    let prefix = norm_prefix(&prefix);
    if let Some(m) = mgr
        .config
        .lock()
        .await
        .mappings
        .iter()
        .find(|m| m.direction == Direction::Twoway && m.profile_id == profile_id && m.bucket == bucket && m.prefix == prefix)
    {
        return Ok(m.clone());
    }
    let dir = match local_path.filter(|p| !p.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let name = load_profiles(&app)?.into_iter().find(|p| p.id == profile_id).map(|p| p.name).unwrap_or_else(|| "Kybl".into());
            offline_folder(&app.path().home_dir().map_err(err)?, &name, &bucket, &prefix)
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let m = SyncMapping {
        id: String::new(),
        profile_id,
        bucket,
        prefix,
        local_path: dir.to_string_lossy().into_owned(),
        direction: Direction::Twoway,
        ignore: DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect(),
        mirror_deletes: true,
        interval_mins: 5,
        paused: false,
        remote_trash: Some(true),
        delete_guard: true,
    };
    save_mapping(&app, &mgr, m).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_runs_back_off_and_held_deletions_wait_for_the_user() {
        let r = |errors: &[&str], pending: usize| RunResult { errors: errors.iter().map(|e| e.to_string()).collect(), pending, ..Default::default() };
        assert_eq!(RunEnd::of(&r(&[], 0)), RunEnd::Ok);
        assert_eq!(RunEnd::of(&r(&["waiting for you to confirm"], 3)), RunEnd::Waiting);
        assert_eq!(RunEnd::of(&r(&["waiting", "a.txt: denied"], 3)), RunEnd::Failed);
        assert_eq!(RunEnd::of(&r(&["a.txt: denied"], 0)), RunEnd::Failed);
        let day = Duration::from_secs(24 * 3600);
        assert_eq!(next_wait(RunEnd::Waiting, 0, day), day, "no re-listing every minute while the user decides");
        assert_eq!(next_wait(RunEnd::Ok, 0, day), day);
        let waits: Vec<u64> = (1..=6).map(|n| next_wait(RunEnd::Failed, n, day).as_secs()).collect();
        assert_eq!(waits, [60, 120, 240, 480, 960, 1920]);
        assert_eq!(next_wait(RunEnd::Failed, 40, day), day, "never past the interval");
        assert_eq!(next_wait(RunEnd::Failed, 1, Duration::from_secs(30)), Duration::from_secs(30));
    }

    #[test]
    fn offline_folders_get_plain_names() {
        let p = offline_folder(Path::new("/Users/me"), "Work: S3", "photos", "2026/trips/");
        assert_eq!(p, PathBuf::from("/Users/me/Kybl/Work- S3/photos/2026/trips"));
        let p = offline_folder(Path::new("/Users/me"), "My server", "", "");
        assert_eq!(p, PathBuf::from("/Users/me/Kybl/My server"));
        assert_eq!(safe_name(".."), "Files");
    }
}
