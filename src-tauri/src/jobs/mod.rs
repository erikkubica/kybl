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

mod copy;
pub mod db;
mod hash;
mod ignore;
mod plan;
pub mod types;

#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;

use crate::storage::{ErrKind, SResult, Storage, StorageError};
use copy::{Ctx, Outcome};
use db::{Counts, End};
use types::*;

pub type Db = Arc<Mutex<Connection>>;

/// How often progress goes out.
const TICK: Duration = Duration::from_millis(250);
/// Items taken from the database at a time.
const BATCH: usize = 256;
/// Originals of a move deleted per request.
const DELETE_BATCH: usize = 500;
/// A file whose network drops keep coming back is counted as a real failure after this many.
const NET_RETRIES: u32 = 20;

/// Job runners alive right now (planning, copying or waiting for the network).
static RUNNING: AtomicUsize = AtomicUsize::new(0);

/// Jobs at work, for the quit prompt.
#[cfg_attr(mobile, allow(dead_code))]
pub fn running_count() -> usize {
    RUNNING.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------- host

/// What the engine needs from the app: tests run it without Tauri.
#[async_trait]
pub trait Host: Send + Sync + 'static {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>>;
    fn emit(&self, _p: &JobProgress) {}
    /// a job began working (`stop` pauses it)
    fn started(&self, _id: &str, _title: &str, _stop: &Arc<AtomicBool>) {}
    fn tick(&self, _id: &str, _done: u64, _total: u64) {}
    /// Some(true) done, Some(false) done with failures or failed, None paused or stopped
    fn ended(&self, _id: &str, _ok: Option<bool>) {}
    /// transfers must wait (on mobile data with "Wi-Fi only" on)
    fn network_blocked(&self) -> bool {
        false
    }
}

struct TauriHost {
    app: AppHandle,
}

#[async_trait]
impl Host for TauriHost {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>> {
        let state = self.app.state::<crate::state::AppState>();
        crate::storage::registry::open(&self.app, &state, profile_id).await.map_err(StorageError::from)
    }

    fn emit(&self, p: &JobProgress) {
        use tauri::Emitter;
        let _ = self.app.emit("job-progress", p);
    }

    fn started(&self, id: &str, title: &str, _stop: &Arc<AtomicBool>) {
        crate::transfer_notice::queued(&self.app, id, crate::transfer_notice::Dir::Upload, title);
        // Android: the notification's Cancel pauses the job (it stops whatever is in `cancels`).
        // Not on computers: quitting stops those, and a job interrupted by quitting must stay
        // "running" so the next start resumes it.
        #[cfg(target_os = "android")]
        {
            let (app, id, stop) = (self.app.clone(), id.to_string(), _stop.clone());
            tauri::async_runtime::spawn(async move {
                app.state::<crate::state::AppState>().cancels.lock().await.insert(id, stop);
            });
        }
    }

    fn tick(&self, id: &str, done: u64, total: u64) {
        crate::transfer_notice::progress(&self.app, id, done, total);
    }

    fn ended(&self, id: &str, ok: Option<bool>) {
        crate::transfer_notice::finished(&self.app, id, ok);
        #[cfg(target_os = "android")]
        {
            let (app, id) = (self.app.clone(), id.to_string());
            tauri::async_runtime::spawn(async move {
                app.state::<crate::state::AppState>().cancels.lock().await.remove(&id);
            });
        }
    }

    fn network_blocked(&self) -> bool {
        crate::tuning::wifi_only() && crate::platform::on_metered_network()
    }
}

// ---------------------------------------------------------------- live progress

/// What a running job asks of its runner.
const WANT_NONE: u8 = 0;
const WANT_PAUSE: u8 = 1;
const WANT_CANCEL: u8 = 2;
const WANT_DELETE: u8 = 3;
/// set by the runner itself: a connection needs signing in again
const WANT_AUTH: u8 = 4;

struct Ctl {
    stop: Arc<AtomicBool>,
    want: AtomicU8,
    #[cfg_attr(not(test), allow(dead_code))]
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Default)]
struct Live {
    files_total: AtomicU64,
    bytes_total: AtomicU64,
    files_done: AtomicU64,
    bytes_done: AtomicU64,
    files_skipped: AtomicU64,
    bytes_skipped: AtomicU64,
    files_failed: AtomicU64,
    bytes_failed: AtomicU64,
    /// bytes actually sent by finished files (skipped ones aren't), for the rate
    moved: AtomicU64,
    current: Mutex<BTreeMap<String, Arc<AtomicU64>>>,
    rate: Mutex<Rate>,
}

#[derive(Default)]
struct Rate {
    at: Option<Instant>,
    moved: u64,
    bps: f64,
}

impl Live {
    fn load(&self, n: &Counts) {
        self.files_total.store(n.files_total, Ordering::Relaxed);
        self.bytes_total.store(n.bytes_total, Ordering::Relaxed);
        self.files_done.store(n.files_done, Ordering::Relaxed);
        self.bytes_done.store(n.bytes_done, Ordering::Relaxed);
        self.files_skipped.store(n.files_skipped, Ordering::Relaxed);
        self.bytes_skipped.store(n.bytes_skipped, Ordering::Relaxed);
        self.files_failed.store(n.files_failed, Ordering::Relaxed);
        self.bytes_failed.store(n.bytes_failed, Ordering::Relaxed);
    }

    fn snapshot(&self, id: &str, state: JobState, phase: Phase, error: Option<String>) -> JobProgress {
        let (current, in_flight) = {
            let cur = self.current.lock().unwrap();
            (cur.keys().take(3).cloned().collect::<Vec<_>>(), cur.values().map(|b| b.load(Ordering::Relaxed)).sum::<u64>())
        };
        let total = self.bytes_total.load(Ordering::Relaxed);
        let finished = self.bytes_done.load(Ordering::Relaxed) + self.bytes_skipped.load(Ordering::Relaxed);
        let bytes_done = (finished + in_flight).min(total);
        let moved = self.moved.load(Ordering::Relaxed) + in_flight;
        let bps = {
            let mut r = self.rate.lock().unwrap();
            let now = Instant::now();
            if state != JobState::Running {
                r.bps = 0.0;
                r.at = None;
            } else if let Some(at) = r.at {
                let dt = now.duration_since(at).as_secs_f64();
                if dt >= 0.2 {
                    let inst = moved.saturating_sub(r.moved) as f64 / dt;
                    r.bps = if r.bps == 0.0 { inst } else { r.bps * 0.7 + inst * 0.3 };
                    r.at = Some(now);
                    r.moved = moved;
                }
            } else {
                r.at = Some(now);
                r.moved = moved;
            }
            r.bps
        };
        let left = total.saturating_sub(bytes_done + self.bytes_failed.load(Ordering::Relaxed));
        JobProgress {
            id: id.to_string(),
            state,
            phase,
            files_done: self.files_done.load(Ordering::Relaxed),
            files_total: self.files_total.load(Ordering::Relaxed),
            files_failed: self.files_failed.load(Ordering::Relaxed),
            files_skipped: self.files_skipped.load(Ordering::Relaxed),
            bytes_done,
            bytes_total: total,
            rate_bps: bps as u64,
            eta_secs: (state == JobState::Running && bps >= 1.0 && phase == Phase::Copying).then(|| (left as f64 / bps).ceil() as u64),
            current,
            error,
        }
    }

    fn count(&self, item: &db::Item, end: End) {
        let size = item.size.max(0) as u64;
        match end {
            End::Done | End::Copied => {
                self.files_done.fetch_add(1, Ordering::Relaxed);
                self.bytes_done.fetch_add(size, Ordering::Relaxed);
                self.moved.fetch_add(size, Ordering::Relaxed);
            }
            End::Skipped | End::SkippedCopied => {
                self.files_skipped.fetch_add(1, Ordering::Relaxed);
                self.bytes_skipped.fetch_add(size, Ordering::Relaxed);
            }
        }
    }

    fn failed(&self, item: &db::Item) {
        self.files_failed.fetch_add(1, Ordering::Relaxed);
        self.bytes_failed.fetch_add(item.size.max(0) as u64, Ordering::Relaxed);
    }
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

fn idle_progress(id: &str, state: JobState, error: Option<String>, n: &Counts) -> JobProgress {
    JobProgress {
        id: id.to_string(),
        state,
        phase: match state {
            JobState::Planning => Phase::Planning,
            s if s.is_finished() => Phase::Finished,
            _ => Phase::Copying,
        },
        files_done: n.files_done,
        files_total: n.files_total,
        files_failed: n.files_failed,
        files_skipped: n.files_skipped,
        bytes_done: n.bytes_done + n.bytes_skipped,
        bytes_total: n.bytes_total,
        rate_bps: 0,
        eta_secs: None,
        current: vec![],
        error,
    }
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
            if spec.mode == JobMode::Move && spec.src.items.iter().all(|i| plan::dst_base(&i.path, i.is_dir, &spec.dst.dir) == i.path) {
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
            let progress = match last.get(&row.id) {
                Some(p) if live.contains_key(&row.id) => p.clone(),
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
        if self.inner.live.lock().unwrap().contains_key(id) {
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
        let mut live = self.inner.live.lock().unwrap();
        if live.contains_key(id) {
            return;
        }
        let ctl = Arc::new(Ctl { stop: Arc::new(AtomicBool::new(false)), want: AtomicU8::new(WANT_NONE), handle: Mutex::new(None) });
        live.insert(id.to_string(), ctl.clone());
        RUNNING.fetch_add(1, Ordering::SeqCst);
        drop(live);
        let (inner, id2, ctl2) = (self.inner.clone(), id.to_string(), ctl.clone());
        let handle = tauri::async_runtime::spawn(async move {
            // whatever happens to the runner, it is no longer at work afterwards
            struct Gone(Arc<Inner>, String);
            impl Drop for Gone {
                fn drop(&mut self) {
                    self.0.live.lock().unwrap().remove(&self.1);
                    RUNNING.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let _gone = Gone(inner.clone(), id2.clone());
            run(&inner, &id2, &ctl2).await;
        });
        *ctl.handle.lock().unwrap() = Some(handle);
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

// ---------------------------------------------------------------- the runner

struct Runner<'a> {
    inner: &'a Inner,
    id: &'a str,
    live: Arc<Live>,
    state: JobState,
    phase: Phase,
    error: Option<String>,
}

impl Runner<'_> {
    fn emit(&mut self, force: bool) {
        let p = self.live.snapshot(self.id, self.state, self.phase, self.error.clone());
        let mut last = self.inner.last.lock().unwrap();
        if !force && last.get(self.id).is_some_and(|q| *q == p) {
            return;
        }
        last.insert(self.id.to_string(), p.clone());
        drop(last);
        self.inner.host.emit(&p);
        self.inner.host.tick(self.id, p.bytes_done, p.bytes_total);
    }

    fn set(&mut self, state: JobState, phase: Phase, error: Option<String>) {
        let changed = state != self.state || phase != self.phase || error != self.error;
        if state != self.state || error != self.error {
            let _ = db::set_state(&self.inner.db.lock().unwrap(), self.id, state, error.as_deref());
        }
        (self.state, self.phase, self.error) = (state, phase, error);
        if changed {
            self.emit(true);
        }
    }

    fn reload(&self) {
        if let Ok(n) = db::counts(&self.inner.db.lock().unwrap(), self.id) {
            self.live.load(&n);
        }
    }
}

/// Runs `fut`, sending progress every [`TICK`] meanwhile.
async fn ticking<T>(r: &mut Runner<'_>, fut: impl std::future::Future<Output = T>) -> T {
    tokio::pin!(fut);
    let mut tick = tokio::time::interval(TICK);
    loop {
        tokio::select! {
            out = &mut fut => return out,
            _ = tick.tick() => r.emit(false),
        }
    }
}

/// Waits `d`, or less if woken or stopped.
async fn nap(inner: &Inner, stop: &AtomicBool, d: Duration) {
    let until = Instant::now() + d;
    while Instant::now() < until && !stop.load(Ordering::Relaxed) {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(250).min(until - Instant::now())) => {}
            _ = inner.wake.notified() => return,
        }
    }
}

async fn run(inner: &Arc<Inner>, id: &str, ctl: &Arc<Ctl>) {
    let Ok(Some(row)) = db::job(&inner.db.lock().unwrap(), id) else { return };
    let Ok(spec) = serde_json::from_str::<JobSpec>(&row.spec_json) else { return };
    let spec = Arc::new(spec);
    let mut r = Runner { inner: inner.as_ref(), id, live: Arc::new(Live::default()), state: row.state, phase: Phase::Copying, error: row.error.clone() };
    r.reload();
    inner.host.started(id, &spec.title, &ctl.stop);
    let end = work(&mut r, &spec, ctl).await;
    let ok = match end {
        JobState::Done => Some(r.live.files_failed.load(Ordering::Relaxed) == 0),
        JobState::Failed => Some(false),
        _ => None,
    };
    inner.host.ended(id, ok);
}

/// The job from wherever it stands to its end (or until it's paused); returns the state it is in.
async fn work(r: &mut Runner<'_>, spec: &Arc<JobSpec>, ctl: &Arc<Ctl>) -> JobState {
    let inner = r.inner;
    let id = r.id.to_string();
    let open = async {
        let src = inner.host.open(&spec.src.profile_id).await?;
        let dst = if spec.dst.profile_id == spec.src.profile_id { src.clone() } else { inner.host.open(&spec.dst.profile_id).await? };
        SResult::Ok((src, dst))
    };
    let (src, dst) = match open.await {
        Ok(c) => c,
        Err(e) if e.kind == ErrKind::NeedsAuth => {
            r.set(JobState::NeedsAuth, Phase::Copying, Some(e.to_string()));
            return JobState::NeedsAuth;
        }
        Err(e) => {
            r.set(JobState::Failed, Phase::Finished, Some(e.to_string()));
            return JobState::Failed;
        }
    };
    let ctx = Arc::new(Ctx {
        job_id: id.clone(),
        spec: spec.clone(),
        src: src.clone(),
        dst: dst.clone(),
        same_conn: spec.src.profile_id == spec.dst.profile_id,
        db: inner.db.clone(),
        stop: ctl.stop.clone(),
    });

    // 1. plan
    let planned = db::job(&inner.db.lock().unwrap(), &id).ok().flatten().is_some_and(|j| j.planned);
    if !planned {
        r.set(JobState::Planning, Phase::Planning, None);
        let mut backoff = Duration::from_secs(5);
        loop {
            let live = r.live.clone();
            let on_page = move |files: u64, bytes: u64| {
                live.files_total.fetch_add(files, Ordering::Relaxed);
                live.bytes_total.fetch_add(bytes, Ordering::Relaxed);
            };
            let res = ticking(r, plan::plan(&*src, spec, &inner.db, &id, &ctl.stop, &on_page)).await;
            r.reload();
            match res {
                Ok(true) => break,
                Ok(false) => return stopped(r, ctl, &ctx).await,
                Err(_) if ctl.stop.load(Ordering::Relaxed) => return stopped(r, ctl, &ctx).await,
                Err(e) if e.kind == ErrKind::NeedsAuth => {
                    r.set(JobState::NeedsAuth, Phase::Planning, Some(e.to_string()));
                    return JobState::NeedsAuth;
                }
                Err(e) if e.kind == ErrKind::Network => {
                    r.set(JobState::WaitingNetwork, Phase::Planning, Some(e.to_string()));
                    nap(inner, &ctl.stop, backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(120));
                    if ctl.stop.load(Ordering::Relaxed) {
                        return stopped(r, ctl, &ctx).await;
                    }
                    r.set(JobState::Planning, Phase::Planning, None);
                }
                Err(e) => {
                    r.set(JobState::Failed, Phase::Finished, Some(e.to_string()));
                    return JobState::Failed;
                }
            }
        }
    }

    // 2. copy
    let _ = db::reset_running(&inner.db.lock().unwrap(), Some(&id));
    r.reload();
    r.set(JobState::Running, Phase::Copying, None);
    let mut queue: VecDeque<db::Item> = VecDeque::new();
    let mut set: tokio::task::JoinSet<(db::Item, Outcome)> = tokio::task::JoinSet::new();
    let mut tick = tokio::time::interval(TICK);
    let mut wait_until: Option<Instant> = None;
    let mut backoff = Duration::from_secs(5);
    let mut net_retries: HashMap<String, u32> = HashMap::new();
    let mut drained = false;
    loop {
        if ctl.stop.load(Ordering::Relaxed) {
            break;
        }
        let waiting = wait_until.is_some_and(|t| Instant::now() < t);
        let blocked = waiting || inner.host.network_blocked();
        if blocked && r.state == JobState::Running {
            let why = if waiting { r.error.clone() } else { Some("Waiting for Wi-Fi.".to_string()) };
            r.set(JobState::WaitingNetwork, Phase::Copying, why);
        } else if !blocked && r.state == JobState::WaitingNetwork {
            r.set(JobState::Running, Phase::Copying, None);
        }
        if !blocked {
            while set.len() < crate::tuning::concurrency() {
                if queue.is_empty() && !drained {
                    match db::take_pending(&mut inner.db.lock().unwrap(), &id, BATCH) {
                        Ok(items) if items.is_empty() => drained = true,
                        Ok(items) => queue.extend(items),
                        Err(e) => {
                            r.set(JobState::Failed, Phase::Finished, Some(e));
                            ctl.stop.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
                let Some(item) = queue.pop_front() else { break };
                let inflight = Arc::new(AtomicU64::new(0));
                if !item.is_dir {
                    r.live.current.lock().unwrap().insert(item.src_path.clone(), inflight.clone());
                }
                let ctx = ctx.clone();
                set.spawn(async move {
                    let o = copy::copy_item(&ctx, item.clone(), inflight).await;
                    (item, o)
                });
            }
        }
        if set.is_empty() && queue.is_empty() && !blocked {
            if drained {
                // requeued items (retries, network drops) are pending again: look once more
                drained = false;
                match db::take_pending(&mut inner.db.lock().unwrap(), &id, BATCH) {
                    Ok(items) if items.is_empty() => break,
                    Ok(items) => {
                        queue.extend(items);
                        continue;
                    }
                    Err(_) => break,
                }
            }
            continue;
        }
        tokio::select! {
            Some(joined) = set.join_next(), if !set.is_empty() => {
                let Ok((item, outcome)) = joined else { continue };
                r.live.current.lock().unwrap().remove(&item.src_path);
                let c = inner.db.lock().unwrap();
                match outcome {
                    Outcome::Ended(end) => {
                        let _ = db::finish(&c, &id, &item.src_path, end, None);
                        if !item.is_dir {
                            r.live.count(&item, end);
                        }
                        backoff = Duration::from_secs(5);
                        net_retries.remove(&item.src_path);
                    }
                    Outcome::Retry(e) => {
                        if item.attempts + 1 >= copy::MAX_ATTEMPTS {
                            let _ = db::fail(&c, &id, &item.src_path, &e);
                            r.live.failed(&item);
                        } else {
                            let _ = db::requeue(&c, &id, &item.src_path, true, Some(&e));
                        }
                    }
                    Outcome::Failed(e) => {
                        let _ = db::fail(&c, &id, &item.src_path, &e);
                        r.live.failed(&item);
                    }
                    Outcome::Network(e) => {
                        let n = net_retries.entry(item.src_path.clone()).or_default();
                        *n += 1;
                        if *n > NET_RETRIES {
                            let _ = db::fail(&c, &id, &item.src_path, &e);
                            r.live.failed(&item);
                        } else {
                            let _ = db::requeue(&c, &id, &item.src_path, false, Some(&e));
                            wait_until = Some(Instant::now() + backoff);
                            backoff = (backoff * 2).min(Duration::from_secs(120));
                            drop(c);
                            r.error = Some(e);
                        }
                    }
                    Outcome::NeedsAuth(e) => {
                        let _ = db::requeue(&c, &id, &item.src_path, false, None);
                        drop(c);
                        r.error = Some(e);
                        ctl.want.store(WANT_AUTH, Ordering::SeqCst);
                        ctl.stop.store(true, Ordering::SeqCst);
                    }
                    Outcome::Stopped => {
                        let _ = db::requeue(&c, &id, &item.src_path, false, None);
                    }
                }
            }
            _ = tick.tick() => r.emit(false),
            _ = inner.wake.notified() => wait_until = None,
        }
    }
    if ctl.stop.load(Ordering::Relaxed) {
        // let the copies under way notice and put themselves back in line
        while let Some(joined) = set.join_next().await {
            if let Ok((item, outcome)) = joined {
                let c = inner.db.lock().unwrap();
                match outcome {
                    Outcome::Ended(end) => {
                        let _ = db::finish(&c, &id, &item.src_path, end, None);
                    }
                    _ => {
                        let _ = db::requeue(&c, &id, &item.src_path, false, None);
                    }
                }
            }
        }
        r.live.current.lock().unwrap().clear();
        if r.state == JobState::Failed {
            return JobState::Failed;
        }
        return stopped(r, ctl, &ctx).await;
    }

    // 3. a move deletes the originals it copied (each one verified)
    if spec.mode == JobMode::Move {
        r.set(JobState::Running, Phase::Deleting, None);
        if let Err(state) = delete_originals(r, &ctx, ctl).await {
            return state;
        }
    }
    r.reload();
    r.live.current.lock().unwrap().clear();
    r.set(JobState::Done, Phase::Finished, None);
    JobState::Done
}

/// Deletes copied originals in batches, then the source folders the move emptied.
async fn delete_originals(r: &mut Runner<'_>, ctx: &Ctx, ctl: &Arc<Ctl>) -> Result<(), JobState> {
    let inner = r.inner;
    let root = &ctx.spec.src.root;
    loop {
        if ctl.stop.load(Ordering::Relaxed) {
            return Err(stopped(r, ctl, ctx).await);
        }
        let batch = db::copied(&inner.db.lock().unwrap(), &ctx.job_id, DELETE_BATCH).unwrap_or_default();
        if batch.is_empty() {
            break;
        }
        match delete_files(&*ctx.src, root, &batch, &ctl.stop).await {
            Ok(()) => {
                let _ = db::deleted(&mut inner.db.lock().unwrap(), &ctx.job_id, &batch);
            }
            Err(e) if ctl.stop.load(Ordering::Relaxed) || e.is_cancelled() => return Err(stopped(r, ctl, ctx).await),
            Err(e) => {
                let msg = format!("Copied, but the original couldn't be deleted: {e}");
                let c = inner.db.lock().unwrap();
                for p in &batch {
                    let _ = db::fail(&c, &ctx.job_id, p, &msg);
                }
            }
        }
        r.reload();
        r.emit(false);
    }
    // folders, deepest first, once nothing is left in them
    let dirs = db::moved_dirs(&inner.db.lock().unwrap(), &ctx.job_id).unwrap_or_default();
    for d in &dirs {
        remove_if_empty(&*ctx.src, root, d).await;
    }
    let _ = db::deleted(&mut inner.db.lock().unwrap(), &ctx.job_id, &dirs);
    Ok(())
}

/// Originals on this device's disk are removed outright (not sent to the Trash): their copies
/// were verified, as moving between disks in Finder or Explorer does. Elsewhere, the store's delete.
async fn delete_files(src: &dyn Storage, root: &str, files: &[String], stop: &AtomicBool) -> SResult<()> {
    if src.caps().local_paths {
        for f in files {
            if stop.load(Ordering::Relaxed) {
                return Err(StorageError::cancelled());
            }
            let p = src.local_path(root, f).ok_or_else(|| StorageError::other("This file is outside the folder being moved."))?;
            match tokio::fs::remove_file(&p).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        return Ok(());
    }
    src.delete(root, files, &[], stop, &|_, _| {}).await.map(|_| ())
}

async fn remove_if_empty(src: &dyn Storage, root: &str, dir: &str) {
    if dir.is_empty() {
        return;
    }
    if src.caps().local_paths {
        // only removes an empty folder
        if let Some(p) = src.local_path(root, dir) {
            let _ = tokio::fs::remove_dir(&p).await;
        }
        return;
    }
    if let Ok(page) = src.list(root, dir, None).await
        && page.folders.is_empty()
        && page.objects.is_empty()
    {
        let never = AtomicBool::new(false);
        // on prefix stores (S3) this removes the folder marker
        let _ = src.delete(root, &[], &[dir.to_string()], &never, &|_, _| {}).await;
    }
}

/// The runner was asked to stop: record why.
async fn stopped(r: &mut Runner<'_>, ctl: &Arc<Ctl>, ctx: &Ctx) -> JobState {
    let inner = r.inner;
    let _ = db::reset_running(&inner.db.lock().unwrap(), Some(r.id));
    r.live.current.lock().unwrap().clear();
    match ctl.want.load(Ordering::SeqCst) {
        WANT_CANCEL | WANT_DELETE => {
            let uploads = db::open_uploads(&inner.db.lock().unwrap(), r.id).unwrap_or_default();
            if let Some(s3) = ctx.dst.as_s3() {
                for (key, upload_id) in &uploads {
                    crate::storage::s3_stream::abort(s3, &ctx.spec.dst.root, key, upload_id).await;
                }
            }
            let _ = db::clear_uploads(&inner.db.lock().unwrap(), r.id);
            if ctl.want.load(Ordering::SeqCst) == WANT_DELETE {
                let _ = db::delete_job(&mut inner.db.lock().unwrap(), r.id);
                inner.last.lock().unwrap().remove(r.id);
                return JobState::Cancelled;
            }
            r.set(JobState::Cancelled, Phase::Finished, None);
            JobState::Cancelled
        }
        WANT_AUTH => {
            let e = r.error.clone();
            r.set(JobState::NeedsAuth, r.phase, e);
            JobState::NeedsAuth
        }
        // asked to pause, or stopped from outside (a phone's notification)
        _ => {
            r.set(JobState::Paused, r.phase, None);
            JobState::Paused
        }
    }
}

// ---------------------------------------------------------------- app wiring and commands

/// Opens jobs.db, resumes the jobs that were at work and listens for the app coming back.
pub fn setup(app: &AppHandle) {
    let host: Arc<dyn Host> = Arc::new(TauriHost { app: app.clone() });
    let path = app.path().app_data_dir().ok().map(|d| d.join("jobs.db"));
    let manager = match path.as_deref().map(|p| JobManager::open(Some(p), host.clone())) {
        Some(Ok(m)) => m,
        other => {
            // keep the feature working for this session rather than failing every command
            if let Some(Err(e)) = other {
                eprintln!("jobs.db: {e}");
            }
            JobManager::open(None, host).expect("an in-memory database opens")
        }
    };
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
