//! Copying and moving between connections ("Copy to another connection…", migrations): jobs
//! that plan, copy, verify and, for moves, delete the originals, kept in `jobs.db` so they carry
//! on after a crash, a quit or a phone killing the app.
//!
//! - A job first walks the source (`plan`), then copies its files a few at a time (the transfer
//!   settings' "files at the same time"), each by the best route (`copy`): a native move or a
//!   server-side copy inside one connection, otherwise the bytes stream through (ranged parts in
//!   parallel into S3), within one memory budget (`storage::s3_stream`).
//! - Bandwidth: the shared limiter of the transfer settings. "Wi-Fi only" on phones and network
//!   drops put a job in `waitingNetwork`; it carries on by itself.
//! - Progress goes out as `job-progress` events, at most 4 a second per job.
//! - Desktop: jobs keep running with the window closed (the app stays in the menu bar) and the
//!   quit prompt counts them. Phones: a running job keeps the transfer notification (Android's
//!   foreground service, iOS's background task) like a transfer does.
//! - Startup resumes jobs that were running; S3 uploads carry on from their confirmed parts.
//! - A mirror (`mirror.rs`) is a job made with its list of copies and deletions already planned.

mod copy;
pub mod db;
mod hash;
mod host;
mod ignore;
mod live;
pub mod mirror;
mod plan;
mod run;
pub mod types;

#[cfg(test)]
pub(crate) mod mock_s3;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;

pub use host::Host;
use live::idle_progress;
use run::start_job;
use types::*;

pub type Db = Arc<Mutex<Connection>>;

/// Job runners alive right now (planning, copying or waiting for the network).
static RUNNING: AtomicUsize = AtomicUsize::new(0);

/// Jobs at work, for the quit prompt.
#[cfg_attr(mobile, allow(dead_code))]
pub fn running_count() -> usize {
    RUNNING.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------- control

/// What a running job asks of its runner.
const WANT_NONE: u8 = 0;
const WANT_PAUSE: u8 = 1;
const WANT_CANCEL: u8 = 2;
const WANT_DELETE: u8 = 3;
/// set by the runner itself: a connection needs signing in again
const WANT_AUTH: u8 = 4;
/// paused, and Resume pressed before the pause finished: run again once stopped
const WANT_RESTART: u8 = 5;

struct Ctl {
    stop: Arc<AtomicBool>,
    want: AtomicU8,
    #[cfg_attr(not(test), allow(dead_code))]
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

// ---------------------------------------------------------------- the manager

/// Managed state: every job, and the runners of those at work.
#[derive(Clone)]
pub struct JobManager {
    inner: Arc<Inner>,
}

struct Inner {
    db: Db,
    host: Arc<dyn Host>,
    live: Mutex<HashMap<String, Arc<Ctl>>>,
    /// the last progress of each job that ran in this session
    last: Mutex<HashMap<String, JobProgress>>,
    /// "try now": the app came back to the front, or the network may be back
    wake: Notify,
}

fn summary_of(row: &db::JobRow, progress: JobProgress) -> Option<JobSummary> {
    let spec: JobSpec = serde_json::from_str(&row.spec_json).ok()?;
    Some(JobSummary { id: row.id.clone(), title: spec.title.clone(), spec, created: row.created, updated: row.updated, progress })
}

fn default_title(spec: &JobSpec) -> String {
    let verb = if spec.mode == JobMode::Move { "Move" } else { "Copy" };
    match spec.src.items.as_slice() {
        [one] if one.path.is_empty() => format!("{verb} everything"),
        [one] => format!("{verb} {}", plan::base_name(&one.path)),
        many => format!("{verb} {} items", many.len()),
    }
}

impl JobManager {
    /// Opens (or creates) the job database. `None` keeps it in memory (tests).
    pub fn open(path: Option<&Path>, host: Arc<dyn Host>) -> Result<Self, String> {
        let conn = match path {
            Some(p) => crate::db::open(p, db::MIGRATIONS)?,
            None => crate::db::open_in_memory(db::MIGRATIONS)?,
        };
        Ok(Self {
            inner: Arc::new(Inner { db: Arc::new(Mutex::new(conn)), host, live: Default::default(), last: Default::default(), wake: Notify::new() }),
        })
    }

    /// Carries on with the jobs that were at work when the app last stopped.
    pub fn resume_all(&self) -> Result<(), String> {
        let ids: Vec<String> = {
            let c = self.inner.db.lock().unwrap();
            db::reset_running(&c, None)?;
            db::jobs(&c)?.into_iter().filter(|j| j.state.is_live()).map(|j| j.id).collect()
        };
        for id in ids {
            self.start(&id);
        }
        Ok(())
    }

    /// Jobs waiting for the network try again now.
    pub fn wake(&self) {
        self.inner.wake.notify_waiters();
    }

    pub fn create(&self, mut spec: JobSpec) -> Result<String, String> {
        if spec.mirror.is_some() {
            return self.create_mirror(spec);
        }
        if spec.src.items.is_empty() {
            return Err("Pick something to copy first.".into());
        }
        if spec.src.profile_id.is_empty() || spec.dst.profile_id.is_empty() {
            return Err("Pick where to copy to first.".into());
        }
        spec.dst.dir = plan::normalize_dir(&spec.dst.dir);
        if spec.src.profile_id == spec.dst.profile_id && spec.src.root == spec.dst.root {
            for it in spec.src.items.iter().filter(|i| i.is_dir) {
                let dir = plan::normalize_dir(&it.path);
                if spec.dst.dir.starts_with(&dir) {
                    return Err("A folder can't be copied into itself. Pick another destination.".into());
                }
            }
            // each item that would land on itself is left out (moving it "there" must not delete
            // it); the copier checks every file again, for places that are one under two names
            let dst_dir = spec.dst.dir.clone();
            spec.src.items.retain(|i| {
                let path = if i.is_dir { plan::normalize_dir(&i.path) } else { i.path.clone() };
                plan::dst_base(&i.path, i.is_dir, &dst_dir) != path
            });
            if spec.src.items.is_empty() {
                return Err("These are already there. Pick another destination.".into());
            }
        }
        if spec.id.is_empty() {
            spec.id = uuid::Uuid::new_v4().to_string();
        }
        if spec.title.trim().is_empty() {
            spec.title = default_title(&spec);
        }
        let json = serde_json::to_string(&spec).map_err(|e| e.to_string())?;
        db::insert_job(&self.inner.db.lock().unwrap(), &spec.id, &json, JobState::Planning)?;
        self.start(&spec.id);
        Ok(spec.id)
    }

    pub fn list(&self) -> Result<Vec<JobSummary>, String> {
        let c = self.inner.db.lock().unwrap();
        let live = self.inner.live.lock().unwrap();
        let last = self.inner.last.lock().unwrap();
        let mut out = Vec::new();
        for row in db::jobs(&c)? {
            let progress = match (last.get(&row.id), live.get(&row.id)) {
                (Some(p), Some(ctl)) => {
                    let mut p = p.clone();
                    // asked to pause or stop: say so while the copies under way wind down
                    match ctl.want.load(Ordering::SeqCst) {
                        WANT_PAUSE => p.state = JobState::Paused,
                        WANT_CANCEL | WANT_DELETE => p.state = JobState::Cancelled,
                        _ => {}
                    }
                    p
                }
                _ => idle_progress(&row.id, row.state, row.error.clone(), &db::counts(&c, &row.id)?),
            };
            out.extend(summary_of(&row, progress));
        }
        Ok(out)
    }

    fn state_of(&self, id: &str) -> Result<db::JobRow, String> {
        db::job(&self.inner.db.lock().unwrap(), id)?.ok_or_else(|| "This job isn't there any more.".to_string())
    }

    fn ask(&self, id: &str, want: u8) -> bool {
        match self.inner.live.lock().unwrap().get(id) {
            Some(ctl) => {
                ctl.want.store(want, Ordering::SeqCst);
                ctl.stop.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn pause(&self, id: &str) -> Result<(), String> {
        if self.ask(id, WANT_PAUSE) {
            return Ok(());
        }
        let row = self.state_of(id)?;
        if row.state.is_live() {
            self.set_idle_state(id, JobState::Paused, None)?;
        }
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<(), String> {
        if let Some(ctl) = self.inner.live.lock().unwrap().get(id) {
            // still winding down from a pause: run again right after
            let _ = ctl.want.compare_exchange(WANT_PAUSE, WANT_RESTART, Ordering::SeqCst, Ordering::SeqCst);
            return Ok(());
        }
        let row = self.state_of(id)?;
        match row.state {
            JobState::Done | JobState::Cancelled => Err("This job has ended. Start a new one to copy again.".into()),
            _ => {
                self.start(id);
                Ok(())
            }
        }
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        if self.ask(id, WANT_CANCEL) {
            return Ok(());
        }
        let row = self.state_of(id)?;
        if row.state.is_finished() {
            return Ok(());
        }
        self.set_idle_state(id, JobState::Cancelled, None)?;
        self.abort_uploads_later(id, &row);
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        if self.ask(id, WANT_DELETE) {
            return Ok(());
        }
        let row = self.state_of(id)?;
        self.abort_uploads_later(id, &row);
        db::delete_job(&mut self.inner.db.lock().unwrap(), id)?;
        self.inner.last.lock().unwrap().remove(id);
        Ok(())
    }

    pub fn failures(&self, id: &str, offset: u64, limit: u64) -> Result<Vec<Failure>, String> {
        db::failures(&self.inner.db.lock().unwrap(), id, offset, limit.min(1000))
    }

    pub fn retry_failed(&self, id: &str) -> Result<(), String> {
        let row = self.state_of(id)?;
        if row.state == JobState::Cancelled {
            return Err("This job was stopped. Start a new one to copy again.".into());
        }
        db::retry_failed(&self.inner.db.lock().unwrap(), id)?;
        if !self.inner.live.lock().unwrap().contains_key(id) {
            self.start(id);
        }
        Ok(())
    }

    fn set_idle_state(&self, id: &str, state: JobState, error: Option<&str>) -> Result<(), String> {
        let c = self.inner.db.lock().unwrap();
        db::set_state(&c, id, state, error)?;
        let p = idle_progress(id, state, error.map(str::to_string), &db::counts(&c, id)?);
        drop(c);
        self.inner.last.lock().unwrap().insert(id.to_string(), p.clone());
        self.inner.host.emit(&p);
        Ok(())
    }

    /// Unfinished multipart uploads of a job that won't resume, aborted in the background.
    fn abort_uploads_later(&self, id: &str, row: &db::JobRow) {
        let Ok(uploads) = db::open_uploads(&self.inner.db.lock().unwrap(), id) else { return };
        let _ = db::clear_uploads(&self.inner.db.lock().unwrap(), id);
        let Ok(spec) = serde_json::from_str::<JobSpec>(&row.spec_json) else { return };
        if uploads.is_empty() {
            return;
        }
        let host = self.inner.host.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(dst) = host.open(&spec.dst.profile_id).await
                && let Some(s3) = dst.as_s3()
            {
                for (key, upload_id) in uploads {
                    crate::storage::s3_stream::abort(s3, &spec.dst.root, &key, &upload_id).await;
                }
            }
        });
    }

    /// Starts the runner of a job (nothing if it is already running).
    fn start(&self, id: &str) {
        start_job(&self.inner, id);
    }

    /// Kills every runner without letting it record anything, like a crash (tests).
    #[cfg(test)]
    fn crash(&self) {
        for ctl in self.inner.live.lock().unwrap().values() {
            if let Some(h) = ctl.handle.lock().unwrap().take() {
                h.abort();
            }
        }
    }

    #[cfg(test)]
    fn is_running(&self, id: &str) -> bool {
        self.inner.live.lock().unwrap().contains_key(id)
    }
}

// ---------------------------------------------------------------- app wiring and commands

/// Whether `e` says the file isn't a database at all (damaged), as opposed to one made by a
/// newer build, or one that's just locked for the moment: those are left as they are.
fn is_damaged(e: &str) -> bool {
    e.contains("file is not a database") || e.contains("malformed")
}

/// Opens the job database. A damaged file is moved aside (`jobs.db.unreadable-<time>`) and a fresh
/// one started, instead of running without a file on every start from then on.
fn open_or_start_over(path: &Path, host: Arc<dyn Host>) -> Result<JobManager, String> {
    match JobManager::open(Some(path), host.clone()) {
        Err(e) if is_damaged(&e) => {
            let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let aside = path.with_file_name(format!("jobs.db.unreadable-{secs}"));
            std::fs::rename(path, &aside).map_err(|r| format!("{e} (and the file couldn't be set aside: {r})"))?;
            // its write-ahead files belong to it
            for ext in ["-wal", "-shm"] {
                let mut side = path.as_os_str().to_owned();
                side.push(ext);
                let mut to = aside.as_os_str().to_owned();
                to.push(ext);
                let _ = std::fs::rename(side, to);
            }
            JobManager::open(Some(path), host)
        }
        r => r,
    }
}

/// Opens jobs.db, resumes the jobs that were at work and listens for the app coming back.
pub fn setup(app: &AppHandle) {
    let host: Arc<dyn Host> = Arc::new(host::TauriHost { app: app.clone() });
    let path = app.path().app_data_dir().ok().map(|d| d.join("jobs.db"));
    let mut failed = None;
    let manager = match path.as_deref().map(|p| open_or_start_over(p, host.clone())) {
        Some(Ok(m)) => m,
        other => {
            // keep the feature working for this session rather than failing every command
            if let Some(Err(e)) = other {
                eprintln!("jobs.db: {e}");
                failed = Some(e);
            }
            JobManager::open(None, host).expect("an in-memory database opens")
        }
    };
    // jobs queued now would be gone at quit, which their "resume after restart" says they aren't:
    // say so once, instead of looking normal
    if let Some(e) = failed {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        app.dialog()
            .message(format!("Copy and move jobs can't be saved this time, so they won't resume after a restart: {e}"))
            .title("Kybl")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
    }
    if let Err(e) = manager.resume_all() {
        eprintln!("jobs: {e}");
    }
    use tauri::Listener;
    let m = manager.clone();
    app.listen_any("app-resumed", move |_| m.wake());
    app.manage(manager);
}

#[tauri::command]
pub async fn job_create(jobs: State<'_, JobManager>, spec: JobSpec) -> Result<String, String> {
    jobs.create(spec)
}

#[tauri::command]
pub async fn job_list(jobs: State<'_, JobManager>) -> Result<Vec<JobSummary>, String> {
    jobs.list()
}

#[tauri::command]
pub async fn job_pause(jobs: State<'_, JobManager>, id: String) -> Result<(), String> {
    jobs.pause(&id)
}

#[tauri::command]
pub async fn job_resume(jobs: State<'_, JobManager>, id: String) -> Result<(), String> {
    jobs.resume(&id)
}

#[tauri::command]
pub async fn job_cancel(jobs: State<'_, JobManager>, id: String) -> Result<(), String> {
    jobs.cancel(&id)
}

#[tauri::command]
pub async fn job_delete(jobs: State<'_, JobManager>, id: String) -> Result<(), String> {
    jobs.delete(&id)
}

#[tauri::command]
pub async fn job_failures(jobs: State<'_, JobManager>, id: String, offset: Option<u64>, limit: Option<u64>) -> Result<Vec<Failure>, String> {
    jobs.failures(&id, offset.unwrap_or(0), limit.unwrap_or(100))
}

#[tauri::command]
pub async fn job_retry_failed(jobs: State<'_, JobManager>, id: String) -> Result<(), String> {
    jobs.retry_failed(&id)
}
