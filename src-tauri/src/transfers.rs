//! The upload / download queue: each transfer runs in its turn per connection (`state::Slots`),
//! can be paused and carried on (also after a restart, see `resume`), keeps to the download and
//! upload caps (`tuning`), and is checked once done when the settings ask (`verify`).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};

use aws_sdk_s3::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::dest;
use crate::multipart::{self, PAUSED};
use crate::resume::{self, Saved};
use crate::state::{err, sdk_err, AppState};
use crate::storage::{self, generic_cmds::{self, Dl}, Conn, PartRecord, ResumeState, WriteOpts};
use crate::transfer_notice::{self as notice, Dir};
use crate::tuning::DOWN;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TransferEvent {
    id: String,
    /// queued | running | paused | done | error | cancelled
    state: &'static str,
    bytes: u64,
    total: u64,
    error: Option<String>,
    /// it carried on from this byte instead of starting over (said once, as it ends or pauses)
    #[serde(skip_serializing_if = "Option::is_none")]
    resumed_from: Option<u64>,
    /// it had got somewhere before, but had to start over
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    restarted: bool,
    /// done and checked: what was compared ("size", "md5", "etag", "sha256", "quickxor", "dropbox")
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<&'static str>,
    /// a download as it ends: the path it really is at (a free name it was given, "x (1).jpg",
    /// or one it moved to because a file turned up at its own while it ran)
    #[serde(skip_serializing_if = "Option::is_none")]
    local: Option<String>,
    /// done, but Cancel (or Quit) stopped the check the settings ask for: the data is in place,
    /// unverified, and the user asked for it to stop
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    check_stopped: bool,
    /// paused with the download's whole file in place, only its check left (Resume checks it)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    check_pending: bool,
    /// it moved to `local` because a file turned up at its own name while it ran
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    moved: bool,
}

fn emit(app: &AppHandle, id: &str, state: &'static str, bytes: u64, total: u64, error: Option<String>) {
    let _ = app.emit("transfer", TransferEvent { id: id.to_string(), state, bytes, total, error, ..Default::default() });
}

/// A transfer that has not ended, as `active_transfers` reports it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTransfer {
    id: String,
    kind: &'static str,
    name: String,
    /// queued | running
    state: &'static str,
    bytes: u64,
    total: u64,
    profile_id: String,
    bucket: String,
    key: String,
    local: String,
    /// a download: the path the page asked for, and whether it replaces a file there
    #[serde(skip)]
    requested: String,
    #[serde(skip)]
    overwrite: bool,
}

/// Every transfer that has not ended. The page only learns of transfers it started; on Android
/// the process (and its transfers) can outlive the page, and a page opened again asks for these.
static ACTIVE: LazyLock<Mutex<HashMap<String, ActiveTransfer>>> = LazyLock::new(Default::default);

/// The pause flag of every transfer that has not ended: set together with its cancel flag, it
/// stops the transfer but keeps what it did, to carry on later.
static PAUSES: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

/// How many transfers have not ended (for the quit prompt).
#[cfg_attr(mobile, allow(dead_code))]
pub fn active_count() -> usize {
    ACTIVE.lock().unwrap().len()
}

fn track(id: &str, f: impl FnOnce(&mut ActiveTransfer)) {
    if let Some(t) = ACTIVE.lock().unwrap().get_mut(id) {
        f(t);
    }
}

#[tauri::command]
pub fn active_transfers() -> Vec<ActiveTransfer> {
    ACTIVE.lock().unwrap().values().cloned().collect()
}

/// Transfers kept from an earlier run or paused in this one (and not running now), for the page
/// to show as paused or failed: Resume / Retry starts them again under the same id.
#[tauri::command]
pub fn kept_transfers() -> Vec<Saved> {
    let running = ACTIVE.lock().unwrap();
    resume::list().into_iter().filter(|s| !running.contains_key(&s.id)).collect()
}

/// Pauses a transfer: it stops, keeping what it did (the partial file, the parts sent, the
/// server's upload session), and carries on from there when started again. One still waiting
/// for its turn just stops waiting.
#[tauri::command]
pub async fn pause_transfer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    pause(&state, &id).await;
    Ok(())
}

/// Pauses every transfer that hasn't ended.
#[tauri::command]
pub async fn pause_all_transfers(state: State<'_, AppState>) -> Result<usize, String> {
    let ids: Vec<String> = ACTIVE.lock().unwrap().keys().cloned().collect();
    for id in &ids {
        pause(&state, id).await;
    }
    Ok(ids.len())
}

async fn pause(state: &AppState, id: &str) {
    let flag = PAUSES.lock().unwrap().get(id).cloned();
    if let (Some(p), Some(c)) = (flag, state.cancels.lock().await.get(id)) {
        p.store(true, Ordering::Relaxed);
        c.store(true, Ordering::Relaxed);
    }
}

/// Moves a transfer still waiting for its turn to the front of its connection's queue. False
/// when it isn't waiting (running already, or ended).
#[tauri::command]
pub async fn move_transfer_to_top(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let profile = ACTIVE.lock().unwrap().get(&id).map(|t| t.profile_id.clone());
    let Some(profile) = profile else { return Ok(false) };
    Ok(state.transfer_slots(&profile).await.to_front(&id))
}

pub(crate) enum Outcome {
    Done,
    Cancelled,
}

/// Progress callback: (bytes done, total bytes).
pub(crate) type Progress<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// Told (bytes done, total) when a transfer pauses for "Wi-Fi only" on mobile data; progress
/// after that means it runs again. None: never pauses (sync on a computer).
pub(crate) type Hold<'a> = Option<&'a (dyn Fn(u64, u64) + Send + Sync)>;

/// How many times in a row a download picks up again after the connection drops, waiting a
/// little longer each time (1 s, 2 s, 4 s … up to 30 s) before it gives up.
const RESUME_ATTEMPTS: u32 = 8;

/// Whether the server answered a request with a refusal that asking again won't change: a
/// client error (403, 404, 412 for an object replaced under `If-Match`), other than the ones
/// that mean "later" (408, 429). Errors with no answer at all (network) and 5xx are retried.
fn will_not_change<E>(e: &aws_sdk_s3::error::SdkError<E, aws_sdk_s3::config::http::HttpResponse>) -> bool {
    e.raw_response().is_some_and(|r| {
        let code = r.status().as_u16();
        (400..500).contains(&code) && code != 408 && code != 429
    })
}

/// A download whose connection sends nothing for this long is taken as dropped and resumed.
pub(crate) const STALL: Duration = Duration::from_secs(60);

/// The wait before resume attempt `n` (1-based).
fn resume_delay(n: u32) -> Duration {
    Duration::from_secs((1u64 << (n - 1).min(5)).min(30))
}

pub(crate) const STALLED: &str = "The connection stopped sending data.";

/// How a network wait raced against Pause/Cancel and [`STALL`] ended.
pub(crate) enum Raced<T> {
    Got(T),
    /// paused or cancelled meanwhile
    Stopped,
    /// nothing came for `STALL`
    Stalled,
}

/// Waits for `fut` (a body read, a request), checking Pause/Cancel every 200 ms and giving up
/// after `STALL`: a server that accepts the connection and then says nothing (a dead Wi-Fi, a
/// NAT that dropped the flow) neither keeps the download "running" nor ignores Pause/Cancel.
pub(crate) async fn race<T>(fut: impl std::future::Future<Output = T>, cancel: &AtomicBool) -> Raced<T> {
    let deadline = tokio::time::Instant::now() + STALL;
    let fut = tokio::time::timeout_at(deadline, fut);
    tokio::pin!(fut);
    loop {
        tokio::select! {
            r = &mut fut => return r.map_or(Raced::Stalled, Raced::Got),
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if cancel.load(Ordering::Relaxed) {
                    return Raced::Stopped;
                }
            }
        }
    }
}

/// Waits for `fut` while checking Pause/Cancel every 200 ms, with no time limit (for a wait that
/// may rightly take long, such as a checksum the server works out). None when stopped.
async fn race_unlimited<T>(fut: impl std::future::Future<Output = T>, cancel: &AtomicBool) -> Option<T> {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            r = &mut fut => return Some(r),
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
            }
        }
    }
}

/// What a transfer that went through becomes when Pause, Cancel or Quit stops its check.
#[derive(Debug, PartialEq, Eq)]
enum StoppedCheck {
    /// paused with the whole file kept; Resume only checks it again
    PauseRecheck,
    /// done, unverified: never an error, and nothing already sent is discarded
    DoneUnverified,
}

/// A download that was paused can come back for its check; an upload has no "check only" run,
/// and its object is complete on the server, so it ends done, unverified (as does a cancelled
/// download, whose file is whole).
fn stopped_check(kind: &Kind, paused: bool) -> StoppedCheck {
    match kind {
        Kind::Download { .. } if paused => StoppedCheck::PauseRecheck,
        _ => StoppedCheck::DoneUnverified,
    }
}

/// Downloads to `dest`, replacing a file already there, as sync does. Nothing is kept if it fails.
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) async fn download_file(
    client: &Client,
    bucket: &str,
    key: &str,
    dest: &str,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<Outcome, String> {
    // held like any download's name: never two writers on one file (sync runs several at once)
    let _held = dest::hold_exact(Path::new(dest))?;
    let mut dl = Dl { replace: true, ..Default::default() };
    download_to(client, bucket, key, Path::new(dest), None, false, cancel, progress, None, &mut dl).await
}

/// Opens the partial file of an earlier attempt to carry on from its end, asking the server for
/// the rest of the same version of the object. None when that can't work (no partial file, the
/// object changed, or the server ignores ranges); the download then starts over.
async fn resume_from(
    client: &Client,
    bucket: &str,
    key: &str,
    part: &Path,
    etag: &str,
) -> Option<(tokio::fs::File, u64, aws_sdk_s3::operation::get_object::GetObjectOutput)> {
    let (file, have) = dest::open_part(part).await?;
    if have == 0 {
        return None;
    }
    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .range(format!("bytes={have}-"))
        .if_match(etag)
        .send()
        .await
        .ok()?;
    out.content_range()?;
    Some((file, have, out))
}

/// The download itself, into `<dest>.s3part` and renamed onto `dest` once whole. With
/// `resume_etag`, a partial file from an earlier attempt is continued. With `keep_partial`, a
/// failed download leaves its partial file for a later retry (a cancelled one never does, a
/// paused one does: see [`Dl`]). `dl.etag` receives the object's ETag, which a retry needs.
#[allow(clippy::too_many_arguments)]
async fn download_to(
    client: &Client,
    bucket: &str,
    key: &str,
    dest: &Path,
    resume_etag: Option<&str>,
    keep_partial: bool,
    cancel: &AtomicBool,
    progress: Progress<'_>,
    hold: Hold<'_>,
    dl: &mut Dl<'_>,
) -> Result<Outcome, String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(err)?;
    }
    let part_path = dest::part_path(dest);
    // the requests before the read loop race Pause/Cancel and a silent server too: a pooled
    // connection that died without a word (the laptop slept, the Wi-Fi changed) would otherwise
    // hold the download, and its turn, for as long as the system takes to notice
    let resumed = match resume_etag {
        Some(tag) => match race(resume_from(client, bucket, key, &part_path, tag), cancel).await {
            Raced::Got(r) => r,
            Raced::Stopped => return Ok(Outcome::Cancelled),
            // the fresh request below tells whether the server is there at all
            Raced::Stalled => None,
        },
        None => None,
    };
    let (mut file, mut got, mut out, total, etag) = match resumed {
        Some((file, have, out)) => {
            let total = have + out.content_length().unwrap_or(0).max(0) as u64;
            (file, have, out, total, resume_etag.map(str::to_string))
        }
        None => {
            let mut stalls = 0;
            let out = loop {
                match race(client.get_object().bucket(bucket).key(key).send(), cancel).await {
                    Raced::Got(r) => break r.map_err(sdk_err)?,
                    Raced::Stopped => return Ok(Outcome::Cancelled),
                    // once more, on a new connection (the silent one was dropped with the request)
                    Raced::Stalled if stalls == 0 => stalls += 1,
                    Raced::Stalled => return Err(STALLED.into()),
                }
            };
            let total = out.content_length().unwrap_or(0).max(0) as u64;
            // A resumed request asks for the same version of the object, so a file changed
            // meanwhile fails cleanly instead of being stitched together from two versions.
            let etag = out.e_tag().map(str::to_string);
            let file = dest::create_part(&part_path).await.map_err(err)?;
            crate::leftovers::partial_started(&part_path);
            (file, 0, out, total, etag)
        }
    };
    dl.etag.clone_from(&etag);
    dl.from = got;
    if let Some(seen) = dl.seen {
        seen(etag.as_deref());
    }
    progress(got, total);

    let mut last_emit = Instant::now();
    let mut checked_at = got;
    let mut lane = DOWN.lane();
    let result: Result<bool, String> = async {
        let mut failures = 0u32;
        'read: loop {
            // the read races Pause/Cancel, and a connection silent for `STALL` counts as dropped,
            // so the resume below picks it up
            let next = match race(out.body.try_next(), cancel).await {
                Raced::Got(r) => r.map_err(err),
                Raced::Stopped => return Ok(false),
                Raced::Stalled => Err(STALLED.to_string()),
            };
            match next {
                Ok(Some(chunk)) => {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(false);
                    }
                    file.write_all(&chunk).await.map_err(err)?;
                    got += chunk.len() as u64;
                    failures = 0;
                    if last_emit.elapsed() > Duration::from_millis(150) {
                        progress(got, total);
                        last_emit = Instant::now();
                    }
                    lane.throttle_unless(chunk.len(), Some(cancel)).await;
                    // "Wi-Fi only" and the phone moved to mobile data: let go of the connection,
                    // keep what arrived, and ask for the rest once it is back on Wi-Fi
                    if let Some(paused) = hold
                        && got - checked_at >= crate::tuning::WIFI_CHECK_BYTES
                        && got < total
                    {
                        checked_at = got;
                        if crate::tuning::hold_for_wifi() {
                            out.body = Default::default();
                            file.flush().await.map_err(err)?;
                            paused(got, total);
                            if !crate::tuning::wait_for_wifi(cancel).await {
                                return Ok(false);
                            }
                            let mut req = client.get_object().bucket(bucket).key(key).range(format!("bytes={got}-"));
                            if let Some(tag) = &etag {
                                req = req.if_match(tag);
                            }
                            match race(req.send(), cancel).await {
                                Raced::Got(Ok(rest)) if rest.content_range().is_some() => out = rest,
                                Raced::Got(Ok(_)) => return Err("The server can't carry on this download where it paused. Try again.".into()),
                                Raced::Got(Err(e)) => return Err(sdk_err(e)),
                                Raced::Stopped => return Ok(false),
                                Raced::Stalled => return Err(STALLED.into()),
                            }
                            progress(got, total);
                        }
                    }
                }
                Ok(None) => break,
                // every byte is in and only the end of the stream went wrong (a reset after the
                // last byte, a stall waiting for the close): the file is whole
                Err(_) if total > 0 && got >= total => break 'read,
                // The connection dropped mid-file: the phone went to the background, the network
                // changed, the server hung up. Ask for the rest of the file and carry on.
                Err(e) => loop {
                    failures += 1;
                    if failures > RESUME_ATTEMPTS {
                        return Err(e);
                    }
                    if let Raced::Stopped = race(tokio::time::sleep(resume_delay(failures)), cancel).await {
                        return Ok(false);
                    }
                    let mut req = client.get_object().bucket(bucket).key(key).range(format!("bytes={got}-"));
                    if let Some(tag) = &etag {
                        req = req.if_match(tag);
                    }
                    // the request races Pause/Cancel too, and one left unanswered counts as failed
                    match race(req.send(), cancel).await {
                        Raced::Got(Ok(rest)) if rest.content_range().is_some() || got == 0 => {
                            out = rest;
                            break;
                        }
                        // the server ignored the range and sent the whole file again: can't resume
                        Raced::Got(Ok(_)) => return Err(e),
                        // an answer that can never change (the object was replaced, deleted, or the
                        // key lost access): no point waiting out the retries
                        Raced::Got(Err(again)) if failures >= RESUME_ATTEMPTS || will_not_change(&again) => return Err(sdk_err(again)),
                        Raced::Stalled if failures >= RESUME_ATTEMPTS => return Err(STALLED.into()),
                        Raced::Got(Err(_)) | Raced::Stalled => continue,
                        Raced::Stopped => return Ok(false),
                    }
                },
            }
        }
        progress(got, total);
        file.flush().await.map_err(err)?;
        Ok(true)
    }
    .await;
    // flushed to disk before anything else looks at it
    let _ = file.sync_all().await;
    // still held while it is renamed into place, so no other download takes it for a leftover
    let held = file.into_std().await;
    let paused = dl.pause.is_some_and(|p| p.load(Ordering::Relaxed));
    match result {
        Ok(true) => {
            let r = dl.finish(&part_path, dest);
            drop(held);
            r.map_err(err)?;
            // (a partial file removed anywhere is dropped from the list when it is next saved)
            crate::leftovers::partial_ended(&part_path);
            Ok(Outcome::Done)
        }
        // paused: what arrived stays, to carry on from (the same version, asked by its ETag)
        Ok(false) if paused && etag.is_some() => Err(PAUSED.into()),
        Ok(false) => {
            drop(held);
            dest::remove_part(&part_path);
            Ok(Outcome::Cancelled)
        }
        Err(e) => {
            drop(held);
            if !keep_partial {
                dest::remove_part(&part_path);
            }
            Err(e)
        }
    }
}

/// A download that failed or was paused, kept so Retry / Resume (the same transfer id) continues
/// its partial file under the name it was given.
struct PendingDownload {
    profile_id: String,
    bucket: String,
    key: String,
    /// the path the page asked for
    requested: String,
    /// the path actually written (a free name unless overwriting)
    chosen: PathBuf,
    etag: Option<String>,
    /// it came in whole, but its check couldn't run: its file at `chosen` as it was then
    finished: Option<multipart::FileStamp>,
}

/// A local file's size and modified time (ms), to tell whether it changed since.
fn stamp_of(p: &Path) -> Option<multipart::FileStamp> {
    let m = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
    let ms = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    Some((m.len(), ms))
}

/// How Retry of a kept download goes on (see [`retry_kept`]).
struct RetryPlan {
    chosen: PathBuf,
    /// carry on the partial file of this version
    etag: Option<String>,
    /// only check the file it downloaded whole before
    recheck: bool,
    /// kept again if the retry can't even start
    kept: Option<PendingDownload>,
}

/// Retry of the kept download `p`, which holds its name again (`dest::resume`). One that came in
/// whole and only couldn't be checked has that same file checked again; a file changed there
/// since is somebody's file now and is left alone, as is any file that turned up meanwhile
/// (`dest::recheck_retry`); otherwise its partial file is carried on.
fn retry_kept(p: PendingDownload, wanted: &Path, overwrite: bool) -> RetryPlan {
    if p.finished.is_some() && stamp_of(&p.chosen) == p.finished {
        return RetryPlan { chosen: p.chosen.clone(), etag: None, recheck: true, kept: Some(p) };
    }
    let (chosen, partial) = dest::recheck_retry(p.chosen, wanted, overwrite);
    let etag = if partial { p.etag } else { None };
    let kept = partial.then(|| PendingDownload { profile_id: p.profile_id, bucket: p.bucket, key: p.key, requested: p.requested, chosen: chosen.clone(), etag: etag.clone(), finished: None });
    RetryPlan { chosen, etag, recheck: false, kept }
}

static PENDING_DOWNLOADS: LazyLock<Mutex<HashMap<String, PendingDownload>>> = LazyLock::new(Default::default);

/// Takes in a transfer kept from an earlier run (`resume::start`): a download gets its name and
/// partial file back, so starting it again carries on.
pub fn adopt(s: &Saved) {
    if !s.is_download() || s.local.is_empty() {
        return;
    }
    let chosen = PathBuf::from(&s.local);
    dest::park(&chosen, &s.id);
    let kept = PendingDownload { profile_id: s.profile_id.clone(), bucket: s.bucket.clone(), key: s.key.clone(), requested: s.requested.clone(), chosen, etag: s.version.clone(), finished: s.stamp };
    PENDING_DOWNLOADS.lock().unwrap().insert(s.id.clone(), kept);
}

/// Forgets the failed download `id` and removes its partial file, unless that file isn't its own
/// any more (a download that replaces the file can take a name a failed download left behind).
fn forget_download(id: &str, p: PendingDownload) {
    if dest::unpark(&p.chosen, id) {
        dest::remove_part(&dest::part_path(&p.chosen));
    }
}

/// Where an upload reads from.
enum Source {
    Path(String),
    /// A file picked on Android (`content://…`): only readable through the system, so it is
    /// opened right away, while the app is on screen. Android's file and path APIs go through
    /// the app's screen, which may be gone (swiped away) by the time the upload's turn comes.
    Picked { file: std::fs::File, cache: std::path::PathBuf, uri: String },
}

/// Copies of picked files kept after a failed upload, by transfer id: (picked URI, its size, the
/// copy's folder). Retry uploads the same copy, so the parts already sent still match and the
/// upload carries on instead of starting over.
static PICKED_COPIES: LazyLock<Mutex<HashMap<String, (String, u64, PathBuf)>>> = LazyLock::new(Default::default);

/// Drops the kept copy of a picked file (its upload finished, or was given up).
fn forget_picked(id: &str) {
    if let Some((_, _, dir)) = PICKED_COPIES.lock().unwrap().remove(id) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The cache folder for a transfer's copy: its id, when that is a plain name.
fn copy_dir_name(id: &str) -> String {
    let plain = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if plain { id.to_string() } else { uuid::Uuid::new_v4().to_string() }
}

/// A file picked on a phone comes as a URL, not a path: `content://…` on Android (a document
/// another app hands over, only readable through the system) or `file://…` on iOS. A file URL is
/// just a path; anything else is opened now and copied when its upload starts.
async fn open_source(app: &AppHandle, local: &str) -> Result<Source, String> {
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
    if !local.contains("://") {
        return Ok(Source::Path(local.to_string()));
    }
    let fp: FilePath = local.parse().map_err(err)?;
    if let FilePath::Url(u) = &fp {
        if u.scheme() == "file" {
            let p = u.to_file_path().map_err(|_| format!("Not a file: {local}"))?;
            return Ok(Source::Path(p.to_string_lossy().into_owned()));
        }
    }
    // this run's own folder: a start of another Kybl removes only what ended runs left there
    let cache = crate::instance_dir::claim(&app.path().app_cache_dir().map_err(err)?.join("uploads")).map_err(err)?;
    let app = app.clone();
    let uri = local.to_string();
    tokio::task::spawn_blocking(move || {
        let mut opts = OpenOptions::new();
        opts.read(true);
        let file = app.fs().open(fp, opts).map_err(|e| format!("Could not read the picked file: {e}"))?;
        Ok(Source::Picked { file, cache, uri })
    })
    .await
    .map_err(err)?
}

/// The path to upload from. A picked file is copied into the cache (`uploads/<run>/<transfer id>/`)
/// under the object's own name, so its content type still reads right; the second value is the
/// copy, removed once the upload is done or given up (a failed one keeps it for Retry, which
/// reuses it while the picked file is the same one, the same size).
async fn local_source(source: Source, key: &str, id: &str) -> Result<(String, Option<std::path::PathBuf>), String> {
    let (mut src, cache, uri) = match source {
        Source::Path(p) => return Ok((p, None)),
        Source::Picked { file, cache, uri } => (file, cache, uri),
    };
    let name = key.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("upload").to_string();
    let size = src.metadata().map(|m| m.len()).ok();
    // the copy keeps the picked file's time, so a kept upload of it is carried on after a restart
    // (its record compares size and time with the copy made then)
    let modified = src.metadata().and_then(|m| m.modified()).ok();
    let kept = PICKED_COPIES.lock().unwrap().get(id).cloned();
    if let Some((was, was_size, dir)) = kept {
        let copy = dir.join(&name);
        let same_copy = std::fs::metadata(&copy).is_ok_and(|m| Some(m.len()) == size);
        if was == uri && Some(was_size) == size && same_copy {
            return Ok((copy.to_string_lossy().into_owned(), Some(copy)));
        }
        forget_picked(id);
    }
    let dir = cache.join(copy_dir_name(id));
    let dest = dir.join(&name);
    let (dir2, dest2) = (dir.clone(), dest.clone());
    let copied = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let _ = std::fs::remove_dir_all(&dir2);
        std::fs::create_dir_all(&dir2).map_err(err)?;
        let mut out = std::fs::File::create(&dest2).map_err(err)?;
        let n = std::io::copy(&mut src, &mut out).map_err(err)?;
        if let Some(t) = modified {
            let _ = out.set_modified(t);
        }
        Ok(n)
    })
    .await
    .map_err(err)?;
    let copied = match copied {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(e);
        }
    };
    PICKED_COPIES.lock().unwrap().insert(id.to_string(), (uri, size.unwrap_or(copied), dir));
    Ok((dest.to_string_lossy().into_owned(), Some(dest)))
}

#[derive(Clone, Copy)]
enum Kind {
    Upload,
    /// `resume`: continue the partial file of an earlier attempt; `recheck`: the file came in
    /// whole before and only its check couldn't run, so it is only checked again
    Download { resume: bool, recheck: bool },
}

/// What the transfer reports as it ends: carried on from where it stopped, or started over.
/// `prior`: bytes reported done before this run; `kept`: bytes of it kept to carry on from (the
/// partial file, the parts the server has), 0 when unknown; `first`: the first progress above
/// zero in this run. A run that carries on reports what it kept straight away; one starting over
/// climbs from zero.
fn resume_note(prior: u64, kept: u64, first: u64) -> (Option<u64>, bool) {
    let base = if kept > 0 { kept } else { prior };
    if base == 0 || first == 0 {
        return (None, false);
    }
    if first as f64 >= base as f64 * 0.9 {
        (Some(first.min(base.max(prior))), false)
    } else {
        (None, true)
    }
}

/// How much of a transfer kept from before can be carried on from, where that is known without
/// asking the server: a download's partial file, the parts of an S3 multipart upload or of a
/// cloud drive's upload session. 0 otherwise (a server's temporary file: `prior` stands in).
fn kept_bytes(kind: Kind, local: &str, kept: Option<&Saved>) -> u64 {
    match kind {
        Kind::Download { recheck: true, .. } => std::fs::metadata(local).map_or(0, |m| m.len()),
        Kind::Download { resume: true, .. } => std::fs::metadata(dest::part_path(Path::new(local))).map_or(0, |m| m.len()),
        Kind::Download { resume: false, .. } => 0,
        Kind::Upload => match kept.and_then(|k| k.upload.as_ref().map(|u| (k.via.as_str(), u))) {
            Some(("s3" | "drive", u)) => u.parts.iter().map(|p| p.size).sum(),
            _ => 0,
        },
    }
}

/// The resume state an upload's backend reports through `on_part`: the temporary file on an
/// SFTP / FTP server (announced as part 0), or a cloud drive's upload session (each piece).
fn collect_part(st: &mut Option<(ResumeState, &'static str)>, p: PartRecord) {
    let via = if p.number == 0 { "server" } else { "drive" };
    match st {
        Some((rs, _)) if rs.upload_id == p.etag => {
            if p.number > 0 {
                rs.parts.retain(|q| q.number != p.number);
                rs.parts.push(p);
            }
        }
        _ => {
            let parts = if p.number > 0 { vec![p.clone()] } else { vec![] };
            *st = Some((ResumeState { upload_id: p.etag, part_size: p.size, parts }, via));
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn spawn_transfer(
    app: AppHandle,
    state: &AppState,
    kind: Kind,
    id: String,
    profile_id: String,
    bucket: String,
    key: String,
    local: String,
    requested: String,
    overwrite: bool,
    resume_etag: Option<String>,
    listed: Option<crate::filecache::Ident>,
) -> Result<(), String> {
    // S3 goes the way it always did; other kinds of connection read and write through their backend
    let conn = storage::connect(&app, state, &profile_id).await?;
    let source = match kind {
        Kind::Upload => Some(open_source(&app, &local).await?),
        Kind::Download { .. } => None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let pause = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(id.clone(), cancel.clone());
    PAUSES.lock().unwrap().insert(id.clone(), pause.clone());
    let slots = state.transfer_slots(&profile_id).await;
    emit(&app, &id, "queued", 0, 0, None);
    let dir = match kind {
        Kind::Upload => Dir::Upload,
        Kind::Download { .. } => Dir::Download,
    };
    let kind_name = match kind {
        Kind::Upload => "upload",
        Kind::Download { .. } => "download",
    };
    let name = key.rsplit('/').find(|n| !n.is_empty()).unwrap_or(&key).to_string();
    notice::queued(&app, &id, dir, &name);
    // what an earlier run (or pause) kept of it
    let kept = resume::get(&id).filter(|s| s.kind == kind_name && s.profile_id == profile_id && s.bucket == bucket && s.key == key);
    let prior = kept.as_ref().map_or(0, |s| s.bytes);
    let kept_now = kept_bytes(kind, &local, kept.as_ref());
    ACTIVE.lock().unwrap().insert(
        id.clone(),
        ActiveTransfer {
            id: id.clone(),
            kind: kind_name,
            name: name.clone(),
            state: "queued",
            bytes: prior,
            total: kept.as_ref().map_or(0, |s| s.total),
            profile_id: profile_id.clone(),
            bucket: bucket.clone(),
            key: key.clone(),
            local: local.clone(),
            requested: requested.clone(),
            overwrite,
        },
    );

    tauri::async_runtime::spawn(async move {
        // a transfer cancelled while it waits for its turn ends right away, not when its turn comes
        let permit = tokio::select! {
            p = slots.acquire_as(&id) => Some(p),
            _ = async {
                while !cancel.load(Ordering::Relaxed) {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            } => None,
        };
        // "Wi-Fi only": hold the turn (still shown as waiting) until the phone is off mobile data
        if permit.is_some() {
            while crate::tuning::wifi_only() && crate::platform::on_metered_network() && !cancel.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
        // written down while it runs, so a crash or quit mid-way finds it again on the next start
        let mut record = kept.clone().unwrap_or_default();
        record.id = id.clone();
        record.kind = kind_name.into();
        record.name = name.clone();
        record.profile_id = profile_id.clone();
        record.bucket = bucket.clone();
        record.key = key.clone();
        record.local = local.clone();
        record.requested = requested.clone();
        record.overwrite = overwrite;
        record.state = "running".into();
        record.error = None;
        // a download whose file came in whole but couldn't be checked: that file as it was then
        // (size, modified), so Retry checks it again rather than downloading it once more. A
        // run that only re-checks it keeps it until the check has an answer.
        let mut unverified = match kind {
            Kind::Download { recheck: true, .. } => kept.as_ref().and_then(|k| k.stamp),
            _ => None,
        };
        if let Kind::Download { .. } = kind {
            record.stamp = unverified;
        }
        // a download fetched (not copied from the file cache) goes into the cache once checked
        let mut to_cache = false;
        let mut done_bytes = 0u64;
        let first = AtomicU64::new(0);
        let mut verify_part_size: Option<u64> = None;
        let mut checked: Option<&'static str> = None;
        let mut check_stopped = false;
        let mut local_done: Option<PathBuf> = None;
        // an upload read from a copy of a file picked on Android
        let mut picked = false;
        // a download's version is written down as soon as it is known
        let seen = |v: Option<&str>| {
            let v = v.map(str::to_string);
            resume::update(&id, |s| s.version = v);
        };
        let mut dl = Dl { pause: Some(&pause), seen: Some(&seen), replace: overwrite, ..Default::default() };
        // where the file is: a download that doesn't replace files lands under a free name when
        // one turned up at its own while it ran
        let mut local = local;
        let mut moved_to: Option<String> = None;
        let result = if permit.is_none() || cancel.load(Ordering::Relaxed) {
            Ok(Outcome::Cancelled)
        } else {
            resume::put(record.clone());
            let report = |done: u64, total: u64| {
                if done > 0 {
                    let _ = first.compare_exchange(0, done, Ordering::Relaxed, Ordering::Relaxed);
                }
                emit(&app, &id, "running", done, total, None);
                notice::progress(&app, &id, done, total);
                track(&id, |t| {
                    t.state = "running";
                    t.bytes = done;
                    t.total = total;
                });
            };
            // paused for "Wi-Fi only": shown as waiting again, with what's done so far
            let paused = |done: u64, total: u64| {
                emit(&app, &id, "queued", done, total, None);
                track(&id, |t| {
                    t.state = "queued";
                    t.bytes = done;
                    t.total = total;
                });
            };
            match kind {
                Kind::Upload => match local_source(source.expect("an upload has a source"), &key, &id).await {
                    Ok((path, temp)) => {
                        let now = multipart::stamp(&path).await.ok();
                        let r = match &conn {
                            Conn::S3(client) => {
                                // parts an earlier run sent, for the same file unchanged
                                if let Some(s) = &kept
                                    && s.via == "s3"
                                    && let (Some(rs), Some(st)) = (&s.upload, s.stamp)
                                    && multipart::kept(&id).is_none()
                                    && s.local == local
                                {
                                    multipart::adopt(&id, client, &profile_id, &bucket, &key, &path, st, rs);
                                } else if let Some(s) = kept.as_ref().filter(|s| s.via == "s3" && s.upload.is_some())
                                    && multipart::kept(&id).is_none()
                                {
                                    // not carried on (another file): the old upload goes, it would
                                    // be recorded nowhere once the new one starts
                                    resume::give_up(&app, s);
                                }
                                let part_size = Mutex::new(None);
                                let total = now.map_or(0, |n| n.0);
                                let on_state = |m: &multipart::Multipart| {
                                    *part_size.lock().unwrap() = Some(m.part_size());
                                    let rs = m.to_resume(total);
                                    resume::update(&id, |s| {
                                        s.via = "s3".into();
                                        s.upload = Some(rs);
                                        s.stamp = now;
                                    });
                                };
                                let r = multipart::upload_resumable(client, &id, &profile_id, &bucket, &key, &path, &cancel, &report, Some(&paused), &pause, Some(&on_state)).await;
                                verify_part_size = *part_size.lock().unwrap();
                                r
                            }
                            Conn::Other(s) => {
                                // a cloud drive's session or a server's temporary file kept from
                                // before, for the same file unchanged
                                let resume_state = kept
                                    .as_ref()
                                    .filter(|k| (k.via == "drive" || k.via == "server") && k.stamp.is_some() && k.stamp == now && k.local == local)
                                    .and_then(|k| k.upload.clone());
                                // not carried on (the file changed): what the old one left on the
                                // server goes, it would be recorded nowhere once this one starts
                                if resume_state.is_none()
                                    && let Some(k) = kept.as_ref().filter(|k| (k.via == "drive" || k.via == "server") && k.upload.is_some())
                                {
                                    resume::give_up(&app, k);
                                }
                                let st: Mutex<Option<(ResumeState, &'static str)>> = Mutex::new(None);
                                let on_part = |p: PartRecord| {
                                    let mut g = st.lock().unwrap();
                                    collect_part(&mut g, p);
                                    if let Some((rs, via)) = g.as_ref() {
                                        let (rs, via) = (rs.clone(), *via);
                                        resume::update(&id, |s| {
                                            s.via = via.into();
                                            s.upload = Some(rs);
                                            s.stamp = now;
                                        });
                                    }
                                };
                                let opts = WriteOpts { resume: resume_state, on_part: Some(&on_part), ..Default::default() };
                                let r = generic_cmds::upload_with(&**s, &bucket, &key, &path, opts, &cancel, &report).await;
                                // a pause keeps the session / temporary file; Done needs nothing kept
                                match &r {
                                    Ok(Outcome::Cancelled) if pause.load(Ordering::Relaxed) => Err(PAUSED.to_string()),
                                    _ => r,
                                }
                            }
                        };
                        if let Ok(Outcome::Done) = r {
                            done_bytes = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
                            local_done = Some(PathBuf::from(&path));
                        }
                        // a failed upload keeps its copy of a picked file for Retry (dropped below,
                        // after the check that reads it)
                        picked = temp.is_some();
                        r
                    }
                    Err(e) => Err(e),
                },
                Kind::Download { resume, recheck } => {
                    let mut chosen = PathBuf::from(&local);
                    let tag = if resume { resume_etag.as_deref() } else { None };
                    // the same version opened or downloaded before is copied from the file
                    // cache instead of fetched again (a retry carrying on its partial file isn't);
                    // a file downloaded whole before, whose check couldn't run, is only checked
                    let served = match resume {
                        _ if recheck => Some(Ok(Outcome::Done)),
                        false => crate::filecache::serve_download(&app, &conn, &profile_id, &bucket, &key, listed.as_ref(), &chosen, &cancel, &report, &mut dl).await,
                        true => None,
                    };
                    let fetched = served.is_none();
                    let r = match served {
                        Some(r) => r,
                        None => match &conn {
                            Conn::S3(client) => download_to(client, &bucket, &key, &chosen, tag, true, &cancel, &report, Some(&paused), &mut dl).await,
                            Conn::Other(s) => generic_cmds::download_resumable(&**s, &bucket, &key, &chosen, tag, true, &cancel, &report, Some(&paused), &mut dl).await,
                        },
                    };
                    // a file turned up at its name while it ran and was kept: the download is
                    // under the next free name now (which it holds instead), and says so
                    if let Some(at) = dl.landed.take() {
                        chosen = at;
                        local = chosen.to_string_lossy().into_owned();
                        record.local.clone_from(&local);
                        resume::update(&id, |s| s.local.clone_from(&local));
                        track(&id, |t| t.local.clone_from(&local));
                        moved_to = Some(local.clone());
                    }
                    if let Ok(Outcome::Done) = r {
                        done_bytes = tokio::fs::metadata(&chosen).await.map(|m| m.len()).unwrap_or(0);
                        if recheck {
                            report(done_bytes, done_bytes);
                        }
                        // into the file cache once its check passed (below)
                        to_cache = fetched;
                        // from somewhere else: the system checks it before it runs, as with a
                        // browser's downloads (a file of this computer is no download)
                        let from_here = profile_id == crate::storage::registry::LOCAL_ID || matches!(&conn, Conn::Other(s) if s.local_path(&bucket, &key).is_some());
                        if !from_here {
                            crate::platform::quarantine::mark(&chosen);
                        }
                        local_done = Some(chosen);
                    }
                    r
                }
            }
        };
        let mut paused_now = pause.load(Ordering::Relaxed) && !matches!(result, Ok(Outcome::Done));
        // checked once done, as the settings ask; a copy that doesn't match fails
        let mut result = result;
        if let (Ok(Outcome::Done), Some(path)) = (&result, &local_done) {
            // the check races Cancel (a server that never answers would hold the transfer and its
            // turn). Stopped there, the transfer itself still went through: see `stopped_check`.
            let check = race_unlimited(crate::verify::check(&app, &conn, &profile_id, &bucket, &key, path, verify_part_size), &cancel).await;
            match check {
                None => match stopped_check(&kind, pause.load(Ordering::Relaxed)) {
                    // a download paused (or the app quit) mid-check: paused with the file kept
                    // whole, and Resume only checks it
                    StoppedCheck::PauseRecheck => {
                        unverified = stamp_of(path);
                        to_cache = false;
                        paused_now = true;
                        result = Ok(Outcome::Cancelled);
                    }
                    // done but unchecked: the data is in place (an upload's object is complete
                    // on the server, nothing to send again), it just wasn't verified
                    StoppedCheck::DoneUnverified => {
                        to_cache = false;
                        checked = None;
                        check_stopped = true;
                    }
                },
                Some(Ok(c)) => checked = c,
                // a re-check of a file that came in whole earlier: it was checked against the
                // file on the server as it is now, which may have changed since. That copy is
                // the user's to keep; Retry downloads the server's file next to it.
                Some(Err(e @ crate::verify::CheckErr::Mismatch(_))) if matches!(kind, Kind::Download { recheck: true, .. }) => {
                    unverified = None;
                    result = Err(format!("{e} The file on the server may have changed since it was downloaded, so the downloaded file was kept. Retry to download the server's file again."));
                }
                Some(Err(e @ crate::verify::CheckErr::Mismatch(_))) => {
                    if matches!(kind, Kind::Download { .. }) {
                        // a download that came out different is no use to anyone
                        let _ = tokio::fs::remove_file(path).await;
                        unverified = None;
                    }
                    result = Err(format!("{e} Retry to transfer it again."));
                }
                // the check itself couldn't run: nothing says the copy is wrong, so it stays, and
                // Retry checks that file again (as it is now) instead of downloading it once more
                Some(Err(e @ crate::verify::CheckErr::Unverified(_))) => {
                    result = Err(match kind {
                        Kind::Download { .. } => {
                            unverified = stamp_of(path);
                            format!("{e} The downloaded file was kept; Retry to check it again.")
                        }
                        Kind::Upload => format!("{e} Retry to transfer it again."),
                    });
                }
            }
        }
        if picked && result.is_ok() {
            forget_picked(&id);
        }
        // only a copy that passed its check (or wasn't asked to be checked) goes into the cache
        if to_cache
            && let (Ok(Outcome::Done), Some(path)) = (&result, &local_done)
        {
            crate::filecache::remember_download(&app, conn.clone(), profile_id.clone(), bucket.clone(), key.clone(), dl.etag.clone(), path.clone());
        }
        drop(permit);
        let last = ACTIVE.lock().unwrap().get(&id).map(|t| (t.bytes, t.total)).unwrap_or((0, 0));
        match (kind, &result) {
            (Kind::Download { .. }, r) => {
                let chosen = PathBuf::from(&local);
                // a failed or paused download keeps its name (and partial file) for Retry;
                // otherwise the name is free for others again
                let keep = r.is_err() || paused_now;
                if keep {
                    dest::park(&chosen, &id);
                } else {
                    dest::release(&chosen);
                }
                match r {
                    _ if keep => {
                        let etag = dl.etag.clone().or_else(|| kept.as_ref().and_then(|k| k.version.clone()));
                        let kept = PendingDownload { profile_id: profile_id.clone(), bucket: bucket.clone(), key: key.clone(), requested, chosen, etag, finished: unverified };
                        PENDING_DOWNLOADS.lock().unwrap().insert(id.clone(), kept);
                    }
                    // stopped before its turn came: a partial file from an earlier attempt goes too
                    Ok(Outcome::Cancelled) => {
                        dest::remove_part(&dest::part_path(&chosen));
                    }
                    _ => {}
                }
            }
            // stopped (not paused) before or while it ran: what it left on the server goes too
            (Kind::Upload, Ok(Outcome::Cancelled)) if !paused_now => {
                multipart::forget(&id);
                forget_picked(&id);
                if let Some(s) = resume::get(&id) {
                    resume::give_up(&app, &s);
                }
            }
            _ => {}
        }
        // kept for later (paused, failed), or forgotten (done, cancelled)
        match &result {
            _ if paused_now => {
                let download = matches!(kind, Kind::Download { .. });
                resume::update_or_put(&id, record.clone(), |s| {
                    s.state = "paused".into();
                    (s.bytes, s.total) = (last.0.max(s.bytes), last.1.max(s.total));
                    s.error = None;
                    // a download paused while its whole file was being checked: Resume checks it
                    if download && unverified.is_some() {
                        s.stamp = unverified;
                    }
                })
            }
            Err(e) => {
                let e = e.clone();
                // it went through but didn't match: nothing of it is left to carry on from
                let finished = local_done.is_some();
                let download = matches!(kind, Kind::Download { .. });
                resume::update_or_put(&id, record.clone(), |s| {
                    s.state = "error".into();
                    (s.bytes, s.total) = last;
                    s.error = Some(e);
                    if finished {
                        s.upload = None;
                        s.version = None;
                    }
                    // a download kept whole but unchecked: what its file was like, for Retry
                    if download {
                        s.stamp = unverified;
                    }
                })
            }
            Ok(_) => {
                resume::remove(&id);
            }
        }
        ACTIVE.lock().unwrap().remove(&id);
        PAUSES.lock().unwrap().remove(&id);
        notice::finished(
            &app,
            &id,
            match result {
                // stopped on purpose: no "done" notice for it
                Ok(Outcome::Done) if check_stopped => None,
                Ok(Outcome::Done) => Some(true),
                _ if paused_now => None,
                Ok(Outcome::Cancelled) => None,
                Err(_) => Some(false),
            },
        );
        let (resumed_from, restarted) = resume_note(prior, kept_now, first.load(Ordering::Relaxed));
        // as kept for Resume above: a paused download whose file came in whole
        let check_pending = paused_now && matches!(kind, Kind::Download { .. }) && unverified.is_some();
        let ev = |state: &'static str, bytes: u64, total: u64, error: Option<String>| TransferEvent {
            id: id.clone(),
            state,
            bytes,
            total,
            error,
            resumed_from,
            restarted,
            verified: checked,
            local: matches!(kind, Kind::Download { .. }).then(|| local.clone()),
            moved: moved_to.is_some(),
            check_stopped,
            check_pending: state == "paused" && check_pending,
        };
        let _ = app.emit(
            "transfer",
            match result {
                Ok(Outcome::Done) => ev("done", done_bytes, done_bytes, None),
                _ if paused_now => ev("paused", last.0.max(prior), last.1, None),
                Ok(Outcome::Cancelled) => ev("cancelled", 0, 0, None),
                Err(e) => ev("error", 0, 0, Some(e)),
            },
        );
        app.state::<AppState>().cancels.lock().await.remove(&id);
    });
    Ok(())
}

#[tauri::command]
pub async fn start_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    profile_id: String,
    bucket: String,
    key: String,
    local_path: String,
) -> Result<(), String> {
    if state.cancels.lock().await.contains_key(&id) {
        return Err("This upload is already running.".into());
    }
    let requested = local_path.clone();
    spawn_transfer(app, &state, Kind::Upload, id, profile_id, bucket, key, local_path, requested, false, None, None).await
}

/// Starts a download and answers with the local path it writes to: `dest_path` itself when
/// `overwrite`, else the first free name ("photo (1).jpg") if a file is already there. Starting
/// the same id again after it failed or was paused continues its partial file under the same
/// name (also after a restart). `etag` and `size` are the version the listing showed, if the
/// page knows it: when the file cache holds that version it is copied without asking the server
/// (see `filecache::serve_download`). `base` is the folder the user picked when the rest of
/// `dest_path` comes from remote names (a folder download): no part below it may be a link
/// (`local_links`), so a remote `Documents/x` never lands in a linked `~/Documents`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    profile_id: String,
    bucket: String,
    key: String,
    dest_path: String,
    overwrite: Option<bool>,
    etag: Option<String>,
    size: Option<u64>,
    base: Option<String>,
) -> Result<String, String> {
    // the name stays whole (a drag-out promise or a save dialog chose that exact path); only a
    // number added to a free name, or a partial file, is fitted to the length limit
    let wanted = dest::validate(&dest_path)?;
    if let Some(base) = base.as_deref().filter(|b| !b.is_empty()) {
        crate::local_links::safe_write_target(Path::new(base), &wanted)?;
    }
    let listed = match (etag, size) {
        (Some(e), Some(n)) => Some(crate::filecache::Ident::new(Some(&e), n, None)).filter(|l| l.etag.is_some()),
        _ => None,
    };
    if state.cancels.lock().await.contains_key(&id) {
        return Err("This download is already running.".into());
    }
    let overwrite = overwrite.unwrap_or(false);
    let kept = PENDING_DOWNLOADS.lock().unwrap().remove(&id);
    // a retry carrying on from its partial file: kept again when it can't even start
    let mut retried: Option<PendingDownload> = None;
    let mut recheck = false;
    let (chosen, resume_etag) = match kept {
        // the same download again: same name, carrying on from its partial file (unless another
        // download took the name meanwhile, or a file turned up there)
        Some(p) if p.profile_id == profile_id && p.bucket == bucket && p.key == key && p.requested == dest_path && dest::resume(&p.chosen, &id) => {
            let r = retry_kept(p, &wanted, overwrite);
            (recheck, retried) = (r.recheck, r.kept);
            (r.chosen, r.etag)
        }
        other => {
            if let Some(p) = other {
                forget_download(&id, p);
            }
            (dest::reserve(&wanted, overwrite)?, None)
        }
    };
    let local = chosen.to_string_lossy().into_owned();
    let kind = Kind::Download { resume: resume_etag.is_some(), recheck };
    if let Err(e) = spawn_transfer(app, &state, kind, id.clone(), profile_id, bucket, key, local.clone(), dest_path, overwrite, resume_etag, listed).await {
        match retried {
            // couldn't start (offline, server down, keychain locked): the partial file stays for
            // the next Retry, as it was
            Some(p) => {
                dest::park(&chosen, &id);
                PENDING_DOWNLOADS.lock().unwrap().insert(id, p);
            }
            None => {
                dest::release(&chosen);
                dest::remove_part(&dest::part_path(&chosen));
            }
        }
        return Err(e);
    }
    Ok(local)
}

/// Stops a transfer. For one that already failed or was paused (and was kept for Retry) it drops
/// what was kept: the partial download file, the multipart upload or temporary file on the server.
#[tauri::command]
pub async fn cancel_transfer(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().await.get(&id) {
        flag.store(true, Ordering::Relaxed);
        return Ok(());
    }
    if let Some(p) = PENDING_DOWNLOADS.lock().unwrap().remove(&id) {
        forget_download(&id, p);
    }
    let aborted = multipart::forget(&id);
    forget_picked(&id);
    if let Some(s) = resume::remove(&id)
        && !(aborted && s.via == "s3")
    {
        resume::give_up(&app, &s);
    }
    Ok(())
}

/// How long Quit waits for running transfers to settle before saving them.
const SETTLE: Duration = Duration::from_millis(1500);

/// On quit: every transfer still queued or running is paused and kept for the next start (with
/// what it did: partial files, the parts sent); bucket operations stop. Multipart uploads and
/// partial files nothing keeps are cleaned up as before (waiting at most `limit`).
#[cfg_attr(mobile, allow(dead_code))]
pub async fn shutdown(state: &AppState, limit: Duration) {
    let running: Vec<ActiveTransfer> = ACTIVE.lock().unwrap().values().cloned().collect();
    for p in PAUSES.lock().unwrap().values() {
        p.store(true, Ordering::Relaxed);
    }
    for flag in state.cancels.lock().await.values() {
        flag.store(true, Ordering::Relaxed);
    }
    for t in &running {
        let fresh = Saved {
            id: t.id.clone(),
            kind: t.kind.into(),
            name: t.name.clone(),
            profile_id: t.profile_id.clone(),
            bucket: t.bucket.clone(),
            key: t.key.clone(),
            local: t.local.clone(),
            requested: if t.requested.is_empty() { t.local.clone() } else { t.requested.clone() },
            overwrite: t.overwrite,
            ..Default::default()
        };
        // Written while the transfer is still listed as running: one that finished meanwhile
        // has already dropped its record, and a new "paused" one would make the next start
        // download or upload the finished file a second time. A transfer leaves `ACTIVE` only
        // after it removed its record, so this one check closes the gap.
        let active = ACTIVE.lock().unwrap();
        if active.contains_key(&t.id) {
            resume::update_or_put(&t.id, fresh, |s| {
                s.state = "paused".into();
                s.bytes = s.bytes.max(t.bytes);
                s.total = s.total.max(t.total);
            });
        }
    }
    // each transfer notices the flags within a moment and writes what it really ended as (a
    // check stopped midway: "paused, only check it again", or done); that is what gets saved
    let settle = Instant::now();
    while !ACTIVE.lock().unwrap().is_empty() && settle.elapsed() < SETTLE {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let parts: Vec<PathBuf> = running
        .iter()
        .filter(|t| t.kind == "download")
        .map(|t| dest::part_path(Path::new(&t.local)))
        .chain(PENDING_DOWNLOADS.lock().unwrap().drain().map(|(_, p)| dest::part_path(&p.chosen)))
        .filter(|p| !resume::keeps_partial(p))
        .collect();
    multipart::abort_all(limit).await;
    for p in parts {
        dest::remove_part(&p);
    }
    resume::save();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};
    use std::sync::Mutex;

    /// Pause, Cancel or Quit during the check after a transfer went through: never an error, and
    /// nothing already sent is discarded. A paused download comes back to be checked only; an
    /// upload (complete on the server) and a cancelled download end done, unverified.
    #[test]
    fn a_stopped_check_never_fails_a_finished_transfer() {
        let dl = Kind::Download { resume: false, recheck: false };
        assert_eq!(stopped_check(&dl, true), StoppedCheck::PauseRecheck);
        assert_eq!(stopped_check(&dl, false), StoppedCheck::DoneUnverified);
        assert_eq!(stopped_check(&Kind::Upload, true), StoppedCheck::DoneUnverified);
        assert_eq!(stopped_check(&Kind::Upload, false), StoppedCheck::DoneUnverified);
    }

    #[test]
    fn a_transfer_says_whether_it_carried_on_or_started_over() {
        // nothing before: nothing to say
        assert_eq!(resume_note(0, 0, 5000), (None, false));
        // carried on from the kept partial file
        assert_eq!(resume_note(4000, 3000, 3000), (Some(3000), false));
        // a server temp file: what was reported before stands in
        assert_eq!(resume_note(4000, 0, 4000), (Some(4000), false));
        // climbed from zero although bytes were kept: started over
        assert_eq!(resume_note(4000, 3000, 64), (None, true));
        // no progress yet: nothing to say
        assert_eq!(resume_note(4000, 3000, 0), (None, false));
    }

    #[test]
    fn the_resume_state_follows_what_the_backend_announces() {
        let mut st = None;
        collect_part(&mut st, PartRecord { number: 0, size: 100, etag: ".a.kybl-1.tmp".into() });
        let (rs, via) = st.clone().unwrap();
        assert_eq!((rs.upload_id.as_str(), rs.part_size, rs.parts.len(), via), (".a.kybl-1.tmp", 100, 0, "server"));
        // a drive session: one record per piece, the latest of each number kept
        let mut st = None;
        for (n, size) in [(1, 10), (2, 10), (2, 12)] {
            collect_part(&mut st, PartRecord { number: n, size, etag: "session".into() });
        }
        let (rs, via) = st.clone().unwrap();
        assert_eq!(via, "drive");
        assert_eq!(rs.parts.iter().map(|p| (p.number, p.size)).collect::<Vec<_>>(), vec![(1, 10), (2, 12)]);
        // a new session replaces the old one
        collect_part(&mut st, PartRecord { number: 1, size: 5, etag: "other".into() });
        assert_eq!(st.unwrap().0.parts.len(), 1);
    }

    #[test]
    fn a_picked_files_copy_lives_in_a_folder_named_after_its_transfer() {
        assert_eq!(copy_dir_name("3f2a-91_b"), "3f2a-91_b");
        for odd in ["", "../x", "a/b", "a\\b", "..", &"x".repeat(65)] {
            let d = copy_dir_name(odd);
            assert!(uuid::Uuid::parse_str(&d).is_ok(), "{odd:?} gets a fresh name, not {d}");
        }
    }

    /// A server that hangs up halfway through the file, then honours the ranged request for the
    /// rest: the download carries on from where it was and the file arrives whole.
    #[test]
    fn a_download_picks_up_where_a_dropped_connection_left_it() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let served = data.clone();
            let requests = Arc::new(Mutex::new(Vec::<String>::new()));
            let seen = requests.clone();
            tokio::spawn(async move {
                for n in 0.. {
                    let (mut sock, _) = listener.accept().await.unwrap();
                    let mut buf = vec![0u8; 8192];
                    let len = sock.read(&mut buf).await.unwrap();
                    let req = String::from_utf8_lossy(&buf[..len]).to_lowercase();
                    seen.lock().unwrap().push(req.clone());
                    let total = served.len();
                    if n == 0 {
                        let head = format!("HTTP/1.1 200 OK\r\ncontent-length: {total}\r\netag: \"v1\"\r\nconnection: close\r\n\r\n");
                        sock.write_all(head.as_bytes()).await.unwrap();
                        sock.write_all(&served[..total / 2]).await.unwrap();
                        // hang up mid-body
                    } else {
                        let from: usize = req.split("range: bytes=").nth(1).unwrap().split('-').next().unwrap().trim().parse().unwrap();
                        let head = format!(
                            "HTTP/1.1 206 Partial Content\r\ncontent-length: {}\r\ncontent-range: bytes {from}-{}/{total}\r\netag: \"v1\"\r\nconnection: close\r\n\r\n",
                            total - from,
                            total - 1
                        );
                        sock.write_all(head.as_bytes()).await.unwrap();
                        sock.write_all(&served[from..]).await.unwrap();
                    }
                    let _ = sock.shutdown().await;
                }
            });
            let p = Profile {
                id: "t".into(),
                name: "t".into(),
                provider: "custom".into(),
                endpoint,
                region: "us-east-1".into(),
                access_key_id: "k".into(),
                bucket: None,
                path_style: true,
                ..Default::default()
            };
            let client = build_client(&p, "s");
            let dir = std::env::temp_dir().join(format!("kybl-resume-{}", std::process::id()));
            let dest = dir.join("file.bin");
            let last = Mutex::new((0u64, 0u64));
            let r = download_file(&client, "b", "file.bin", dest.to_str().unwrap(), &AtomicBool::new(false), &|d, t| {
                *last.lock().unwrap() = (d, t);
            })
            .await;
            assert!(matches!(r, Ok(Outcome::Done)), "download failed: {:?}", r.err());
            assert_eq!(std::fs::read(&dest).unwrap(), data, "the resumed file is whole and in order");
            assert_eq!(*last.lock().unwrap(), (data.len() as u64, data.len() as u64), "progress ends at 100%");
            let reqs = requests.lock().unwrap();
            assert_eq!(reqs.len(), 2, "one resume");
            assert!(reqs[1].contains("if-match: \"v1\""), "asks for the same version: {}", reqs[1]);
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /// Retry of a failed download: the partial file from the first attempt is continued with a
    /// ranged request for the same version, not fetched again from the start.
    #[test]
    fn a_retried_download_continues_its_partial_file() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let data: Vec<u8> = (0..200_000u32).map(|i| (i % 249) as u8).collect();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let served = data.clone();
            let requests = Arc::new(Mutex::new(Vec::<String>::new()));
            let seen = requests.clone();
            tokio::spawn(async move {
                loop {
                    let (mut sock, _) = listener.accept().await.unwrap();
                    let mut buf = vec![0u8; 8192];
                    let len = sock.read(&mut buf).await.unwrap();
                    let req = String::from_utf8_lossy(&buf[..len]).to_lowercase();
                    seen.lock().unwrap().push(req.clone());
                    let total = served.len();
                    let from: usize = req.split("range: bytes=").nth(1).unwrap().split('-').next().unwrap().trim().parse().unwrap();
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\ncontent-length: {}\r\ncontent-range: bytes {from}-{}/{total}\r\netag: \"v1\"\r\nconnection: close\r\n\r\n",
                        total - from,
                        total - 1
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    sock.write_all(&served[from..]).await.unwrap();
                    let _ = sock.shutdown().await;
                }
            });
            let p = Profile {
                id: "t".into(),
                name: "t".into(),
                provider: "custom".into(),
                endpoint,
                region: "us-east-1".into(),
                access_key_id: "k".into(),
                bucket: None,
                path_style: true,
                ..Default::default()
            };
            let client = build_client(&p, "s");
            let dir = std::env::temp_dir().join(format!("kybl-retry-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("file.bin");
            // what the failed first attempt left behind
            std::fs::write(dest::part_path(&dest), &data[..70_000]).unwrap();
            let mut dl = Dl::default();
            let r = download_to(&client, "b", "file.bin", &dest, Some("\"v1\""), true, &AtomicBool::new(false), &|_, _| {}, None, &mut dl).await;
            assert!(matches!(r, Ok(Outcome::Done)), "download failed: {:?}", r.err());
            assert_eq!(std::fs::read(&dest).unwrap(), data, "the continued file is whole and in order");
            assert!(!dest::part_path(&dest).exists());
            let reqs = requests.lock().unwrap();
            assert_eq!(reqs.len(), 1);
            assert!(reqs[0].contains("range: bytes=70000-"), "{}", reqs[0]);
            assert!(reqs[0].contains("if-match: \"v1\""), "{}", reqs[0]);
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /// The connection drops halfway and the server then accepts the reconnect but never answers:
    /// Cancel still ends the download promptly, instead of it hanging on the request.
    #[test]
    fn cancel_ends_a_download_stuck_on_its_reconnect() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move {
                let mut held = Vec::new();
                for n in 0.. {
                    let (mut sock, _) = listener.accept().await.unwrap();
                    let mut buf = vec![0u8; 8192];
                    let _ = sock.read(&mut buf).await;
                    if n == 0 {
                        let head = "HTTP/1.1 200 OK\r\ncontent-length: 100000\r\netag: \"v1\"\r\nconnection: close\r\n\r\n";
                        sock.write_all(head.as_bytes()).await.unwrap();
                        sock.write_all(&[7u8; 40_000]).await.unwrap();
                        let _ = sock.shutdown().await;
                    } else {
                        // read the request, never answer
                        held.push(sock);
                    }
                }
            });
            let p = Profile { id: "t".into(), name: "t".into(), provider: "custom".into(), endpoint, region: "us-east-1".into(), access_key_id: "k".into(), path_style: true, ..Default::default() };
            let client = build_client(&p, "s");
            let dir = std::env::temp_dir().join(format!("kybl-stuck-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("file.bin");
            let cancel = Arc::new(AtomicBool::new(false));
            let flag = cancel.clone();
            tokio::spawn(async move {
                // after the 1 s resume wait, while the reconnect waits for its answer
                tokio::time::sleep(Duration::from_millis(2500)).await;
                flag.store(true, Ordering::Relaxed);
            });
            let started = Instant::now();
            let mut dl = Dl::default();
            let r = download_to(&client, "b", "file.bin", &dest, None, false, &cancel, &|_, _| {}, None, &mut dl).await;
            assert!(matches!(r, Ok(Outcome::Cancelled)), "{:?}", r.err());
            assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
            assert!(!dest::part_path(&dest).exists() && !dest.exists());
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /// The very first request of a download goes to a server that never answers (a pooled
    /// connection that died silently): Cancel still ends it at once.
    #[test]
    fn cancel_ends_a_download_whose_first_request_hangs() {
        use tokio::io::AsyncReadExt;
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move {
                let mut held = Vec::new();
                loop {
                    let (mut sock, _) = listener.accept().await.unwrap();
                    let mut buf = vec![0u8; 8192];
                    let _ = sock.read(&mut buf).await;
                    held.push(sock);
                }
            });
            let p = Profile { id: "t".into(), name: "t".into(), provider: "custom".into(), endpoint, region: "us-east-1".into(), access_key_id: "k".into(), path_style: true, ..Default::default() };
            let client = build_client(&p, "s");
            let dir = std::env::temp_dir().join(format!("kybl-hang-{}", uuid::Uuid::new_v4()));
            let dest = dir.join("file.bin");
            let cancel = Arc::new(AtomicBool::new(false));
            let flag = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                flag.store(true, Ordering::Relaxed);
            });
            let started = Instant::now();
            let mut dl = Dl::default();
            let r = download_to(&client, "b", "file.bin", &dest, None, false, &cancel, &|_, _| {}, None, &mut dl).await;
            assert!(matches!(r, Ok(Outcome::Cancelled)), "{:?}", r.err());
            assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
            assert!(!dest::part_path(&dest).exists() && !dest.exists());
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    fn a_wait_races_cancel_and_the_stall_limit() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            assert!(matches!(race(async { 5 }, &AtomicBool::new(false)).await, Raced::Got(5)));
            let started = Instant::now();
            assert!(matches!(race(std::future::pending::<()>(), &AtomicBool::new(true)).await, Raced::Stopped));
            assert!(started.elapsed() < Duration::from_secs(1));
        });
    }

    /// "Couldn't check the copy" keeps the finished file: Retry checks that same file again
    /// instead of downloading a second copy under "name (1)". A file changed since is left alone.
    #[test]
    fn retry_of_an_unchecked_download_checks_the_same_file() {
        let dir = std::env::temp_dir().join(format!("kybl-recheck-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wanted = dir.join("report.pdf");
        let chosen = dest::reserve(&wanted, false).unwrap();
        std::fs::write(&chosen, b"whole file").unwrap();
        dest::park(&chosen, "t1");
        let pending = |finished| PendingDownload {
            profile_id: "p".into(),
            bucket: "b".into(),
            key: "report.pdf".into(),
            requested: wanted.to_string_lossy().into_owned(),
            chosen: chosen.clone(),
            etag: Some("\"v1\"".into()),
            finished,
        };
        assert!(dest::resume(&chosen, "t1"));
        let plan = retry_kept(pending(stamp_of(&chosen)), &wanted, false);
        assert!(plan.recheck);
        assert_eq!(plan.chosen, chosen, "the same file, no \"report (1).pdf\"");
        assert!(plan.etag.is_none() && plan.kept.is_some_and(|k| k.finished.is_some()));
        assert_eq!(std::fs::read(&chosen).unwrap(), b"whole file");
        // the user changed the file meanwhile: it's theirs now, and the download goes elsewhere
        let before = stamp_of(&chosen);
        std::fs::write(&chosen, b"edited by the user").unwrap();
        let plan = retry_kept(pending(before), &wanted, false);
        assert!(!plan.recheck);
        assert_eq!(plan.chosen, dir.join("report (1).pdf"));
        assert_eq!(std::fs::read(&chosen).unwrap(), b"edited by the user");
        dest::release(&plan.chosen);
        let _ = std::fs::remove_dir_all(dir);
    }
}
