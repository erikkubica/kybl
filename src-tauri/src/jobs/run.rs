//! The runner of one job: plan, copy a few files at a time, delete the originals of a move,
//! and record how it ended (or why it stopped).

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;

use super::{
    copy::{self, Ctx, Outcome},
    db, plan,
    live::Live,
    types::*,
    Ctl, Inner, RUNNING, WANT_AUTH, WANT_CANCEL, WANT_DELETE, WANT_NONE, WANT_RESTART,
};
use crate::storage::{ErrKind, SResult, Storage, StorageError};

/// How often progress goes out.
const TICK: Duration = Duration::from_millis(250);
/// Items taken from the database at a time.
const BATCH: usize = 256;
/// Originals of a move deleted per request.
const DELETE_BATCH: usize = 500;
/// A file whose network drops keep coming back is counted as a real failure after this many.
const NET_RETRIES: u32 = 20;

/// Starts the runner of a job (nothing if it is already running).
pub(super) fn start_job(inner: &Arc<Inner>, id: &str) {
    let mut live = inner.live.lock().unwrap();
    if live.contains_key(id) {
        return;
    }
    let ctl = Arc::new(Ctl { stop: Arc::new(AtomicBool::new(false)), want: AtomicU8::new(WANT_NONE), handle: Mutex::new(None) });
    live.insert(id.to_string(), ctl.clone());
    RUNNING.fetch_add(1, Ordering::SeqCst);
    drop(live);
    let (inner2, id2, ctl2) = (inner.clone(), id.to_string(), ctl.clone());
    let handle = tauri::async_runtime::spawn(async move {
        // whatever happens to the runner, it is no longer at work afterwards
        struct Gone(Arc<Inner>, String);
        impl Drop for Gone {
            fn drop(&mut self) {
                self.0.live.lock().unwrap().remove(&self.1);
                RUNNING.fetch_sub(1, Ordering::SeqCst);
            }
        }
        {
            let _gone = Gone(inner2.clone(), id2.clone());
            run(&inner2, &id2, &ctl2).await;
        }
        // Resume was pressed while it was still pausing: start it again now that it has stopped
        if ctl2.want.load(Ordering::SeqCst) == WANT_RESTART {
            start_job(&inner2, &id2);
        }
    });
    *ctl.handle.lock().unwrap() = Some(handle);
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
            let res = ticking(r, plan::plan(&*src, dst.kind(), spec, &inner.db, &id, &ctl.stop, &on_page)).await;
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
        let copied = db::copied(&inner.db.lock().unwrap(), &ctx.job_id, DELETE_BATCH).unwrap_or_default();
        if copied.is_empty() {
            break;
        }
        // right before each original goes: its copy must still be the one written, and the
        // original still the one copied
        let checked: Vec<(db::CopiedFile, Option<String>)> =
            futures_util::stream::iter(copied.into_iter().map(|f| async move {
                let why = keep_reason(ctx, &f).await;
                (f, why)
            }))
            .buffer_unordered(16)
            .collect()
            .await;
        let mut batch = Vec::new();
        {
            let c = inner.db.lock().unwrap();
            for (f, why) in checked {
                match why {
                    None => batch.push(f.src_path),
                    Some(why) => {
                        let _ = db::fail(&c, &ctx.job_id, &f.src_path, &why);
                    }
                }
            }
        }
        if batch.is_empty() {
            r.reload();
            continue;
        }
        match delete_files(&*ctx.src, &ctx.spec, &batch, &ctl.stop).await {
            Ok(kept) => {
                let mut c = inner.db.lock().unwrap();
                for (p, why) in &kept {
                    let _ = db::fail(&c, &ctx.job_id, p, &format!("Copied, but the original couldn't be deleted: {why}"));
                }
                let gone: Vec<String> = batch.into_iter().filter(|p| !kept.iter().any(|(k, _)| k == p)).collect();
                let _ = db::deleted(&mut c, &ctx.job_id, &gone);
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

/// Why the original of a copied file must stay (None: it may be deleted). The copy is stat'ed
/// again and compared with what was recorded when it was written (a later copy may have landed
/// on it, e.g. "Photo.jpg" over "photo.jpg" where case doesn't count), and the original with
/// what was copied.
async fn keep_reason(ctx: &Ctx, f: &db::CopiedFile) -> Option<String> {
    match ctx.dst.stat(&ctx.spec.dst.root, &f.dst_path).await {
        Err(e) => return Some(format!("The copy couldn't be checked, so the original was kept: {e}")),
        Ok(None) => return Some("The copy isn't at the destination any more, so the original was kept.".into()),
        Ok(Some(d)) => {
            let etag_differs = matches!((&f.dst_etag, &d.etag), (Some(a), Some(b)) if a.trim_matches('"') != b.trim_matches('"'));
            if d.is_dir() || d.size != f.dst_size.unwrap_or(f.size) || etag_differs {
                return Some("The copy changed before the original was deleted (another file may have replaced it), so the original was kept.".into());
            }
        }
    }
    match ctx.src.stat(&ctx.spec.src.root, &f.src_path).await {
        Ok(None) => None,
        Ok(Some(now)) => {
            let was = db::Item { size: f.size, etag: f.src_etag.clone(), mtime: f.src_mtime, ..Default::default() };
            (!copy::unchanged(&was, &now)).then(|| "The original changed after it was copied, so it was kept.".to_string())
        }
        Err(e) => Some(format!("The original couldn't be checked, so it was kept: {e}")),
    }
}

/// The real folders (or files) selected on this device's disk, links resolved.
fn selected_on_disk(src: &dyn Storage, spec: &JobSpec) -> Vec<(String, bool, std::path::PathBuf)> {
    spec.src
        .items
        .iter()
        .filter_map(|s| {
            let key = if s.is_dir { plan::normalize_dir(&s.path) } else { s.path.clone() };
            let real = std::fs::canonicalize(src.local_path(&spec.src.root, &key)?).ok()?;
            Some((key, s.is_dir, real))
        })
        .collect()
}

/// A file to delete really lies inside what was selected: by its key, and on disk with links
/// resolved (a folder reached through a link may be anywhere; its files are never deleted).
fn inside_selection(selected: &[(String, bool, std::path::PathBuf)], key: &str, path: &std::path::Path) -> bool {
    let Some(parent) = path.parent().and_then(|p| std::fs::canonicalize(p).ok()) else { return false };
    selected.iter().any(|(sel, is_dir, real)| {
        if *is_dir {
            key.starts_with(sel.as_str()) && parent.starts_with(real)
        } else {
            key == sel && real.parent().is_some_and(|rp| rp == parent)
        }
    })
}

/// Originals on this device's disk are removed outright (not sent to the Trash): their copies
/// were verified, as moving between disks in Finder or Explorer does. Only files inside what was
/// selected are removed, and a link is removed itself, never what it points to. Elsewhere, the
/// store's delete. Answers the files that were kept, with why.
async fn delete_files(src: &dyn Storage, spec: &JobSpec, files: &[String], stop: &AtomicBool) -> SResult<Vec<(String, String)>> {
    let root = spec.src.root.as_str();
    if src.caps().local_paths {
        let selected = selected_on_disk(src, spec);
        let mut kept = Vec::new();
        for f in files {
            if stop.load(Ordering::Relaxed) {
                // what wasn't reached stays copied, to delete when the job carries on
                return Err(StorageError::cancelled());
            }
            let Some(p) = src.local_path(root, f) else {
                kept.push((f.clone(), "This file is outside the folder being moved.".to_string()));
                continue;
            };
            if !inside_selection(&selected, f, &p) {
                kept.push((f.clone(), "This file is outside the folder being moved (it's reached through a link), so it was kept.".to_string()));
                continue;
            }
            match tokio::fs::remove_file(&p).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => kept.push((f.clone(), StorageError::from(e).to_string())),
            }
        }
        return Ok(kept);
    }
    src.delete(root, files, &[], stop, &|_, _| {}).await.map(|_| vec![])
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

