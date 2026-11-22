use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};

use aws_sdk_s3::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::dest;
use crate::multipart;
use crate::state::{client_for, err, sdk_err, AppState};
use crate::transfer_notice::{self as notice, Dir};
use crate::tuning::LIMITER;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferEvent {
    id: String,
    /// queued | running | done | error | cancelled
    state: &'static str,
    bytes: u64,
    total: u64,
    error: Option<String>,
}

fn emit(app: &AppHandle, id: &str, state: &'static str, bytes: u64, total: u64, error: Option<String>) {
    let _ = app.emit(
        "transfer",
        TransferEvent { id: id.to_string(), state, bytes, total, error },
    );
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
}

/// Every transfer that has not ended. The page only learns of transfers it started; on Android
/// the process (and its transfers) can outlive the page, and a page opened again asks for these.
static ACTIVE: LazyLock<Mutex<HashMap<String, ActiveTransfer>>> = LazyLock::new(Default::default);

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

/// The wait before resume attempt `n` (1-based).
fn resume_delay(n: u32) -> Duration {
    Duration::from_secs((1u64 << (n - 1).min(5)).min(30))
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
    let mut etag = None;
    download_to(client, bucket, key, Path::new(dest), None, false, cancel, progress, None, &mut etag).await
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
    let have = tokio::fs::metadata(part).await.ok()?.len();
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
    let file = tokio::fs::OpenOptions::new().append(true).open(part).await.ok()?;
    Some((file, have, out))
}

/// The download itself, into `<dest>.s3part` and renamed onto `dest` once whole. With
/// `resume_etag`, a partial file from an earlier attempt is continued. With `keep_partial`, a
/// failed download leaves its partial file for a later retry (a cancelled one never does).
/// `etag_out` receives the object's ETag, which a retry needs to resume.
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
    etag_out: &mut Option<String>,
) -> Result<Outcome, String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(err)?;
    }
    let part_path = dest::part_path(dest);
    let resumed = match resume_etag {
        Some(tag) => resume_from(client, bucket, key, &part_path, tag).await,
        None => None,
    };
    let (mut file, mut got, mut out, total, etag) = match resumed {
        Some((file, have, out)) => {
            let total = have + out.content_length().unwrap_or(0).max(0) as u64;
            (file, have, out, total, resume_etag.map(str::to_string))
        }
        None => {
            let out = client.get_object().bucket(bucket).key(key).send().await.map_err(sdk_err)?;
            let total = out.content_length().unwrap_or(0).max(0) as u64;
            // A resumed request asks for the same version of the object, so a file changed
            // meanwhile fails cleanly instead of being stitched together from two versions.
            let etag = out.e_tag().map(str::to_string);
            let file = tokio::fs::File::create(&part_path).await.map_err(err)?;
            crate::leftovers::partial_started(&part_path);
            (file, 0, out, total, etag)
        }
    };
    etag_out.clone_from(&etag);
    progress(got, total);

    let mut last_emit = Instant::now();
    let mut checked_at = got;
    let result: Result<bool, String> = async {
        let mut failures = 0u32;
        loop {
            match out.body.try_next().await {
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
                    LIMITER.throttle(chunk.len()).await;
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
                            match req.send().await {
                                Ok(rest) if rest.content_range().is_some() => out = rest,
                                Ok(_) => return Err("The server can't carry on this download where it paused. Try again.".into()),
                                Err(e) => return Err(sdk_err(e)),
                            }
                            progress(got, total);
                        }
                    }
                }
                Ok(None) => break,
                // The connection dropped mid-file: the phone went to the background, the network
                // changed, the server hung up. Ask for the rest of the file and carry on.
                Err(e) => loop {
                    failures += 1;
                    if failures > RESUME_ATTEMPTS || (total > 0 && got >= total) {
                        return Err(err(e));
                    }
                    tokio::time::sleep(resume_delay(failures)).await;
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(false);
                    }
                    let mut req = client.get_object().bucket(bucket).key(key).range(format!("bytes={got}-"));
                    if let Some(tag) = &etag {
                        req = req.if_match(tag);
                    }
                    match req.send().await {
                        Ok(rest) if rest.content_range().is_some() || got == 0 => {
                            out = rest;
                            break;
                        }
                        // the server ignored the range and sent the whole file again: can't resume
                        Ok(_) => return Err(err(e)),
                        Err(again) if failures >= RESUME_ATTEMPTS => return Err(sdk_err(again)),
                        Err(_) => continue,
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
    drop(file);
    match result {
        Ok(true) => {
            tokio::fs::rename(&part_path, dest).await.map_err(err)?;
            // (a partial file removed anywhere is dropped from the list when it is next saved)
            crate::leftovers::partial_ended(&part_path);
            Ok(Outcome::Done)
        }
        Ok(false) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            Ok(Outcome::Cancelled)
        }
        Err(e) => {
            if !keep_partial {
                let _ = tokio::fs::remove_file(&part_path).await;
            }
            Err(e)
        }
    }
}

/// A download that failed, kept so Retry (the same transfer id) continues its partial file under
/// the name it was given.
struct PendingDownload {
    profile_id: String,
    bucket: String,
    key: String,
    /// the path the page asked for
    requested: String,
    /// the path actually written (a free name unless overwriting)
    chosen: PathBuf,
    etag: Option<String>,
}

static PENDING_DOWNLOADS: LazyLock<Mutex<HashMap<String, PendingDownload>>> = LazyLock::new(Default::default);

/// Forgets the failed download `id` and removes its partial file, unless that file isn't its own
/// any more (a download that replaces the file can take a name a failed download left behind).
fn forget_download(id: &str, p: PendingDownload) {
    if dest::unpark(&p.chosen, id) {
        let _ = std::fs::remove_file(dest::part_path(&p.chosen));
    }
}

/// Where an upload reads from.
enum Source {
    Path(String),
    /// A file picked on Android (`content://…`): only readable through the system, so it is
    /// opened right away, while the app is on screen. Android's file and path APIs go through
    /// the app's screen, which may be gone (swiped away) by the time the upload's turn comes.
    Picked { file: std::fs::File, cache: std::path::PathBuf },
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
    let cache = app.path().app_cache_dir().map_err(err)?.join("uploads");
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut opts = OpenOptions::new();
        opts.read(true);
        let file = app.fs().open(fp, opts).map_err(|e| format!("Could not read the picked file: {e}"))?;
        Ok(Source::Picked { file, cache })
    })
    .await
    .map_err(err)?
}

/// The path to upload from. A picked file is copied into the cache under the object's own name
/// (so its content type still reads right); the second value is the copy to remove afterwards.
async fn local_source(source: Source, key: &str) -> Result<(String, Option<std::path::PathBuf>), String> {
    let (mut src, cache) = match source {
        Source::Path(p) => return Ok((p, None)),
        Source::Picked { file, cache } => (file, cache),
    };
    let name = key.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("upload");
    let dir = cache.join(uuid::Uuid::new_v4().to_string());
    let dest = dir.join(name);
    let dest2 = dest.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(err)?;
        let mut out = std::fs::File::create(&dest2).map_err(err)?;
        std::io::copy(&mut src, &mut out).map_err(err)?;
        Ok(())
    })
    .await
    .map_err(err)??;
    Ok((dest.to_string_lossy().into_owned(), Some(dest)))
}

#[derive(Clone, Copy)]
enum Kind {
    Upload,
    /// `resume`: continue the partial file of an earlier attempt
    Download { resume: bool },
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
    resume_etag: Option<String>,
) -> Result<(), String> {
    let client = client_for(&app, state, &profile_id).await?;
    let source = match kind {
        Kind::Upload => Some(open_source(&app, &local).await?),
        Kind::Download { .. } => None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(id.clone(), cancel.clone());
    let slots = state.transfer_slots(&profile_id).await;
    emit(&app, &id, "queued", 0, 0, None);
    let dir = match kind {
        Kind::Upload => Dir::Upload,
        Kind::Download { .. } => Dir::Download,
    };
    let name = key.rsplit('/').find(|n| !n.is_empty()).unwrap_or(&key).to_string();
    notice::queued(&app, &id, dir, &name);
    ACTIVE.lock().unwrap().insert(
        id.clone(),
        ActiveTransfer {
            id: id.clone(),
            kind: match kind {
                Kind::Upload => "upload",
                Kind::Download { .. } => "download",
            },
            name: name.clone(),
            state: "queued",
            bytes: 0,
            total: 0,
            profile_id: profile_id.clone(),
            bucket: bucket.clone(),
            key: key.clone(),
            local: local.clone(),
        },
    );

    tauri::async_runtime::spawn(async move {
        // a transfer cancelled while it waits for its turn ends right away, not when its turn comes
        let permit = tokio::select! {
            p = slots.acquire() => Some(p),
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
        let mut done_bytes = 0u64;
        let mut etag = None;
        let result = if permit.is_none() || cancel.load(Ordering::Relaxed) {
            Ok(Outcome::Cancelled)
        } else {
            let report = |done: u64, total: u64| {
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
                Kind::Upload => match local_source(source.expect("an upload has a source"), &key).await {
                    Ok((path, temp)) => {
                        let r = multipart::upload_resumable(&client, &id, &profile_id, &bucket, &key, &path, &cancel, &report, Some(&paused)).await;
                        if let Ok(Outcome::Done) = r {
                            done_bytes = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
                        }
                        if let Some(t) = temp.as_ref().and_then(|t| t.parent()) {
                            let _ = tokio::fs::remove_dir_all(t).await;
                        }
                        r
                    }
                    Err(e) => Err(e),
                },
                Kind::Download { resume } => {
                    let chosen = PathBuf::from(&local);
                    let tag = if resume { resume_etag.as_deref() } else { None };
                    let r = download_to(&client, &bucket, &key, &chosen, tag, true, &cancel, &report, Some(&paused), &mut etag).await;
                    if let Ok(Outcome::Done) = r {
                        done_bytes = tokio::fs::metadata(&chosen).await.map(|m| m.len()).unwrap_or(0);
                    }
                    r
                }
            }
        };
        drop(permit);
        match (kind, &result) {
            (Kind::Download { .. }, r) => {
                let chosen = PathBuf::from(&local);
                // a failed download keeps its name (and partial file) for Retry; otherwise the
                // name is free for others again
                match r {
                    Err(_) => dest::park(&chosen, &id),
                    Ok(_) => dest::release(&chosen),
                }
                match r {
                    Err(_) => {
                        let kept = PendingDownload { profile_id: profile_id.clone(), bucket: bucket.clone(), key: key.clone(), requested, chosen, etag };
                        PENDING_DOWNLOADS.lock().unwrap().insert(id.clone(), kept);
                    }
                    // stopped before its turn came: a partial file from an earlier attempt goes too
                    Ok(Outcome::Cancelled) => {
                        let _ = tokio::fs::remove_file(dest::part_path(&chosen)).await;
                    }
                    Ok(Outcome::Done) => {}
                }
            }
            // stopped before its turn came: what an earlier attempt left on the server goes too
            (Kind::Upload, Ok(Outcome::Cancelled)) => {
                multipart::forget(&id);
            }
            _ => {}
        }
        ACTIVE.lock().unwrap().remove(&id);
        notice::finished(
            &app,
            &id,
            match result {
                Ok(Outcome::Done) => Some(true),
                Ok(Outcome::Cancelled) => None,
                Err(_) => Some(false),
            },
        );
        match result {
            Ok(Outcome::Done) => emit(&app, &id, "done", done_bytes, done_bytes, None),
            Ok(Outcome::Cancelled) => emit(&app, &id, "cancelled", 0, 0, None),
            Err(e) => emit(&app, &id, "error", 0, 0, Some(e)),
        }
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
    let requested = local_path.clone();
    spawn_transfer(app, &state, Kind::Upload, id, profile_id, bucket, key, local_path, requested, None).await
}

/// Starts a download and answers with the local path it writes to: `dest_path` itself when
/// `overwrite`, else the first free name ("photo (1).jpg") if a file is already there. Starting
/// the same id again after it failed continues its partial file under the same name.
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
) -> Result<String, String> {
    let wanted = dest::validate(&dest_path)?;
    if state.cancels.lock().await.contains_key(&id) {
        return Err("This download is already running.".into());
    }
    let overwrite = overwrite.unwrap_or(false);
    let kept = PENDING_DOWNLOADS.lock().unwrap().remove(&id);
    let (chosen, resume_etag) = match kept {
        // the same download again: same name, carrying on from its partial file (unless another
        // download took the name meanwhile, or a file turned up there)
        Some(p) if p.profile_id == profile_id && p.bucket == bucket && p.key == key && p.requested == dest_path && dest::resume(&p.chosen, &id) => {
            let (chosen, partial) = dest::recheck_retry(p.chosen, &wanted, overwrite);
            (chosen, if partial { p.etag } else { None })
        }
        other => {
            if let Some(p) = other {
                forget_download(&id, p);
            }
            (dest::reserve(&wanted, overwrite)?, None)
        }
    };
    let local = chosen.to_string_lossy().into_owned();
    let kind = Kind::Download { resume: resume_etag.is_some() };
    if let Err(e) = spawn_transfer(app, &state, kind, id, profile_id, bucket, key, local.clone(), dest_path, resume_etag).await {
        dest::release(&chosen);
        let _ = std::fs::remove_file(dest::part_path(&chosen));
        return Err(e);
    }
    Ok(local)
}

/// Stops a transfer. For one that already failed (and was kept for Retry) it drops what was
/// kept: the partial download file, or the multipart upload on the server.
#[tauri::command]
pub async fn cancel_transfer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().await.get(&id) {
        flag.store(true, Ordering::Relaxed);
        return Ok(());
    }
    if let Some(p) = PENDING_DOWNLOADS.lock().unwrap().remove(&id) {
        forget_download(&id, p);
    }
    multipart::forget(&id);
    Ok(())
}

/// On quit: stops every transfer and bucket operation, aborts open multipart uploads (waiting at
/// most `limit`) and removes partial download files, so nothing is left behind.
#[cfg_attr(mobile, allow(dead_code))]
pub async fn shutdown(state: &AppState, limit: Duration) {
    for flag in state.cancels.lock().await.values() {
        flag.store(true, Ordering::Relaxed);
    }
    let parts: Vec<PathBuf> = ACTIVE
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.kind == "download")
        .map(|t| dest::part_path(Path::new(&t.local)))
        .chain(PENDING_DOWNLOADS.lock().unwrap().drain().map(|(_, p)| dest::part_path(&p.chosen)))
        .collect();
    multipart::abort_all(limit).await;
    for p in parts {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};
    use std::sync::Mutex;

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
            };
            let client = build_client(&p, "s");
            let dir = std::env::temp_dir().join(format!("kybl-retry-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("file.bin");
            // what the failed first attempt left behind
            std::fs::write(dest::part_path(&dest), &data[..70_000]).unwrap();
            let mut etag = None;
            let r = download_to(&client, "b", "file.bin", &dest, Some("\"v1\""), true, &AtomicBool::new(false), &|_, _| {}, None, &mut etag).await;
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
}
