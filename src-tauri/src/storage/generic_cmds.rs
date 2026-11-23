//! The bodies of the browse commands for connections that aren't S3, written once against
//! [`Storage`]. Each answers with the same type, and reports the same events (`search-progress`,
//! `size-progress`, `move-progress`), as its S3 twin in `commands.rs`, so the page can't tell
//! them apart. Also the new commands every kind answers: `list_roots`,
//! `connection_capabilities` and `local_path`.

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::AsyncWriteExt;

use super::*;
use crate::{
    commands::{
        BucketInfo, ChildSize, FolderSize, Job, ListResult, MoveItem, MoveProgress, ObjectDetails, OpResult, RemoteFile, SearchProgress,
        SearchResult, SizeProgress, TextPreview, MAX_CHILDREN,
    },
    dest,
    objects::Existing,
    transfers::Outcome,
    tuning::DOWN,
};

// ---------------------------------------------------------------- new commands

/// Where browsing starts in a connection: buckets, drives, or this computer's folders.
#[tauri::command]
pub async fn list_roots(app: AppHandle, state: State<'_, AppState>, profile_id: String) -> Result<Vec<RootInfo>, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    Ok(s.roots().await?)
}

/// What a connection can do, so the page can hide what it can't.
#[tauri::command]
pub async fn connection_capabilities(app: AppHandle, state: State<'_, AppState>, profile_id: String) -> Result<Capabilities, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    Ok(s.caps().clone())
}

/// The real file or folder behind a key, for connections that are this device's own disk
/// (`capabilities.localPaths`); None elsewhere, or when the key leads outside its root.
#[tauri::command]
pub async fn local_path(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<Option<String>, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    Ok(s.local_path(&bucket, &key).map(|p| p.to_string_lossy().into_owned()))
}

// ---------------------------------------------------------------- browsing

pub async fn list_buckets(s: &dyn Storage) -> Result<Vec<BucketInfo>, String> {
    Ok(s.roots().await?.into_iter().map(|r| BucketInfo { name: r.id, created: r.created }).collect())
}

pub async fn create_bucket(s: &dyn Storage, bucket: &str) -> Result<(), String> {
    Ok(s.create_root(bucket).await?)
}

pub async fn list_objects(s: &dyn Storage, bucket: &str, prefix: &str, token: Option<String>) -> Result<ListResult, String> {
    let page = s.list(bucket, prefix, token).await?;
    Ok(ListResult { folders: page.folders, objects: page.objects, next_token: page.next_token, folder_info: page.folder_info })
}

/// Same limits as the S3 search: 300,000 entries looked at, 500 matches.
#[allow(clippy::too_many_arguments)]
pub async fn search_objects<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    s: &dyn Storage,
    bucket: &str,
    prefix: &str,
    query: &str,
    op_id: Option<String>,
) -> Result<SearchResult, String> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(id) = &op_id {
        state.cancels.lock().await.insert(id.clone(), flag.clone());
    }
    let r = search_scan(s, bucket, prefix, query, 300_000, 500, &flag, |scanned, found| {
        if let Some(id) = &op_id {
            let _ = app.emit("search-progress", SearchProgress { op_id: id.clone(), scanned, found: found.to_vec() });
        }
    })
    .await;
    if let Some(id) = &op_id {
        state.cancels.lock().await.remove(id);
    }
    r
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_scan(
    s: &dyn Storage,
    bucket: &str,
    prefix: &str,
    query: &str,
    max_scan: u64,
    max_results: usize,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, &[Entry]),
) -> Result<SearchResult, String> {
    let needle = query.to_lowercase();
    let mut found: Vec<Entry> = Vec::new();
    let (mut scanned, mut truncated) = (0u64, false);
    let mut walk = s.walk(bucket, prefix);
    'batches: while let Some(batch) = walk.next().await {
        if cancel.load(Ordering::Relaxed) {
            truncated = true;
            break;
        }
        let before = found.len();
        for e in batch? {
            scanned += 1;
            if e.is_dir() {
                continue;
            }
            let rest = e.key.get(prefix.len()..).unwrap_or(&e.key);
            if rest.to_lowercase().contains(&needle) {
                found.push(e);
                if found.len() >= max_results {
                    progress(scanned, &found[before..]);
                    truncated = true;
                    break 'batches;
                }
            }
        }
        progress(scanned, &found[before..]);
        if scanned >= max_scan {
            truncated = true;
            break;
        }
    }
    Ok(SearchResult { objects: found, scanned, truncated })
}

pub async fn head_object(s: &dyn Storage, bucket: &str, key: &str) -> Result<ObjectDetails, String> {
    let e = s.stat(bucket, key).await?.ok_or_else(StorageError::not_found)?;
    Ok(ObjectDetails {
        content_type: e.mime.clone().or_else(|| (!e.is_dir()).then(|| mime_guess::from_path(key).first_or_octet_stream().to_string())),
        key: key.to_string(),
        size: e.size,
        modified: e.modified,
        etag: e.etag,
        storage_class: e.storage_class,
        metadata: HashMap::new(),
        cache_control: None,
        content_disposition: None,
        content_encoding: None,
    })
}

pub async fn get_text_preview(s: &dyn Storage, bucket: &str, key: &str, max_bytes: usize) -> Result<TextPreview, String> {
    let range = s.caps().range_read.then_some(0..max_bytes as u64);
    let mut r = s.read(bucket, key, range, None).await?;
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = r.body.next().await {
        buf.extend_from_slice(&chunk.map_err(StorageError::from)?);
        if buf.len() >= max_bytes {
            truncated = buf.len() > max_bytes || r.total.is_none_or(|t| t > max_bytes as u64);
            buf.truncate(max_bytes);
            break;
        }
    }
    Ok(TextPreview { text: String::from_utf8_lossy(&buf).into_owned(), truncated })
}

pub async fn get_object_bytes(s: &dyn Storage, bucket: &str, key: &str, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    let r = s.read(bucket, key, None, None).await?;
    let buf = r.collect(max_bytes).await?;
    Ok(tauri::ipc::Response::new(buf))
}

pub async fn presign_get(s: &dyn Storage, bucket: &str, key: &str, expires_secs: u64) -> Result<String, String> {
    Ok(s.share_link(&Loc::new(bucket, key), Some(Duration::from_secs(expires_secs))).await?)
}

/// Adds up everything below `prefix` (and each direct subfolder), as `commands::folder_size`.
pub async fn folder_size<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    s: &dyn Storage,
    bucket: &str,
    prefix: &str,
    op_id: String,
) -> Result<FolderSize, String> {
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    let mut last = Instant::now() - Duration::from_secs(1);
    let r = size_scan(s, bucket, prefix, &flag, |bytes, objects| {
        if last.elapsed() >= Duration::from_millis(200) {
            last = Instant::now();
            let _ = app.emit("size-progress", SizeProgress { op_id: op_id.clone(), bytes, objects });
        }
    })
    .await;
    if let Ok(f) = &r {
        let _ = app.emit("size-progress", SizeProgress { op_id: op_id.clone(), bytes: f.bytes, objects: f.objects });
    }
    state.cancels.lock().await.remove(&op_id);
    r
}

pub(crate) async fn size_scan(
    s: &dyn Storage,
    bucket: &str,
    prefix: &str,
    cancel: &AtomicBool,
    mut on_batch: impl FnMut(u64, u64),
) -> Result<FolderSize, String> {
    let (mut bytes, mut objects) = (0u64, 0u64);
    let mut kids: HashMap<String, (u64, u64)> = HashMap::new();
    let mut walk = s.walk(bucket, prefix);
    while let Some(batch) = walk.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        for e in batch? {
            if e.is_dir() {
                continue;
            }
            let size = e.size.max(0) as u64;
            bytes += size;
            objects += 1;
            if let Some(rest) = e.key.strip_prefix(prefix)
                && let Some(slash) = rest.find('/')
            {
                let k = kids.entry(format!("{prefix}{}", &rest[..=slash])).or_default();
                k.0 += size;
                k.1 += 1;
            }
        }
        on_batch(bytes, objects);
    }
    let mut children: Vec<ChildSize> = kids.into_iter().map(|(prefix, (bytes, objects))| ChildSize { prefix, bytes, objects }).collect();
    children.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.prefix.cmp(&b.prefix)));
    children.truncate(MAX_CHILDREN);
    Ok(FolderSize { bytes, objects, children })
}

// ---------------------------------------------------------------- mutations

pub async fn create_folder(s: &dyn Storage, bucket: &str, prefix: &str) -> Result<(), String> {
    let dir = if prefix.ends_with('/') { prefix.to_string() } else { format!("{prefix}/") };
    Ok(s.mkdir(bucket, &dir).await?)
}

fn emit_move<R: Runtime>(app: &AppHandle<R>, op_id: Option<&str>, phase: &'static str, done: u64, total: u64) {
    if let Some(id) = op_id {
        let _ = app.emit("move-progress", MoveProgress { op_id: id.to_string(), phase, done, total, bytes: 0, total_bytes: 0 });
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn delete_objects<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    s: &dyn Storage,
    bucket: &str,
    keys: Vec<String>,
    prefixes: Vec<String>,
    op_id: Option<String>,
) -> Result<OpResult, String> {
    let op = op_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op.clone(), flag.clone());
    let _job = Job::start();
    let r = delete_with(app, s, bucket, &keys, &prefixes, Some(&op), &flag).await;
    state.cancels.lock().await.remove(&op);
    Ok(r)
}

pub(crate) async fn delete_with<R: Runtime>(
    app: &AppHandle<R>,
    s: &dyn Storage,
    bucket: &str,
    keys: &[String],
    prefixes: &[String],
    op: Option<&str>,
    flag: &AtomicBool,
) -> OpResult {
    let (done, total) = (AtomicU64::new(0), AtomicU64::new((keys.len() + prefixes.len()) as u64));
    let r = s
        .delete(bucket, keys, prefixes, flag, &|d, t| {
            done.store(d, Ordering::Relaxed);
            total.store(t, Ordering::Relaxed);
            emit_move(app, op, "deleting", d, t);
        })
        .await;
    let (done, total) = (done.load(Ordering::Relaxed), total.load(Ordering::Relaxed));
    match r {
        Ok((d, t)) => OpResult { done: d, total: t, error: None },
        Err(e) => OpResult { done, total, error: Some(e.into()) },
    }
}

/// Copies or moves items within the connection (into `dest_bucket` when given). Each item is
/// one step: a native rename or server-side copy where the store has one, else the bytes are
/// read and written back, file by file. A move only removes what was copied.
#[allow(clippy::too_many_arguments)]
pub async fn move_many<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    s: &dyn Storage,
    bucket: &str,
    items: Vec<MoveItem>,
    delete_source: bool,
    op_id: String,
    dest_bucket: Option<String>,
) -> Result<OpResult, String> {
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    let _job = Job::start();
    let r = move_with(app, s, bucket, dest_bucket.as_deref(), &items, delete_source, Some(&op_id), &flag).await;
    state.cancels.lock().await.remove(&op_id);
    r
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn move_with<R: Runtime>(
    app: &AppHandle<R>,
    s: &dyn Storage,
    bucket: &str,
    dest_bucket: Option<&str>,
    items: &[MoveItem],
    delete_source: bool,
    op_id: Option<&str>,
    cancel: &Arc<AtomicBool>,
) -> Result<OpResult, String> {
    let to_bucket = dest_bucket.filter(|b| !b.is_empty()).unwrap_or(bucket);
    let same_root = to_bucket == bucket;
    for it in items {
        if same_root && it.from == it.to {
            return Err("Source and destination are the same".into());
        }
        if it.is_prefix && same_root && it.to.starts_with(&it.from) {
            return Err("Cannot copy a folder into itself".into());
        }
    }
    let total = items.len() as u64;
    let mut done = 0u64;
    emit_move(app, op_id, "copying", 0, total);
    let server_copy = match s.caps().server_copy {
        ServerCopy::CrossRoot => true,
        ServerCopy::SameRoot => same_root,
        ServerCopy::None => false,
    };
    for it in items {
        if cancel.load(Ordering::Relaxed) {
            return Ok(OpResult { done, total, error: Some(CANCELLED.into()) });
        }
        let (from, to) = (Loc::new(bucket, &it.from), Loc::new(to_bucket, &it.to));
        let r = if delete_source {
            s.rename(&from, &to, it.is_prefix).await
        } else if server_copy {
            s.copy(&from, &to, it.is_prefix).await
        } else {
            copy_through(s, &from, &to, it.is_prefix, cancel).await
        };
        if let Err(e) = r {
            let error = if e.is_cancelled() { e.into() } else { format!("{}: {e}", it.from) };
            return Ok(OpResult { done, total, error: Some(error) });
        }
        done += 1;
        emit_move(app, op_id, "copying", done, total);
    }
    Ok(OpResult { done, total, error: None })
}

/// Copies by reading and writing the bytes (stores without a server-side copy).
pub(crate) async fn copy_through(s: &dyn Storage, from: &Loc, to: &Loc, is_dir: bool, cancel: &Arc<AtomicBool>) -> SResult<()> {
    let write_file = |r: ReadStream, dst: String| async move {
        let src = WriteSource::Stream { len: r.len, body: r.body, reopen: None };
        match s.write(&to.root, &dst, src, WriteOpts::default(), &|_, _| {}, cancel).await? {
            WriteOutcome::Done(_) => Ok(()),
            WriteOutcome::Cancelled => Err(StorageError::cancelled()),
            WriteOutcome::Conflict(_) => Err(StorageError::conflict()),
        }
    };
    let copy_file = |src: String, dst: String| async move { write_file(s.read(&from.root, &src, None, None).await?, dst).await };
    if !is_dir {
        return copy_file(from.path.clone(), to.path.clone()).await;
    }
    s.mkdir(&to.root, &to.path).await?;
    let mut walk = s.walk(&from.root, &from.path);
    // links this connection can't make (FTP): never left out without a word
    let mut skipped = Vec::new();
    while let Some(batch) = walk.next().await {
        for e in batch? {
            if cancel.load(Ordering::Relaxed) {
                return Err(StorageError::cancelled());
            }
            let dst = format!("{}{}", to.path, &e.key[from.path.len()..]);
            if let Some(target) = &e.link {
                // a link to a folder stays a link (the walk doesn't go into it)
                if s.caps().links {
                    s.make_link(&to.root, &dst, target).await?;
                } else if !e.is_dir() {
                    // a link to a file: what it points at is copied, as a download would get it.
                    // FTP's LIST shows every link as a file, links to folders too: one that can't
                    // be read as a file is left out (and said), unless the connection itself failed
                    match s.read(&from.root, &e.key, None, None).await {
                        Ok(r) => write_file(r, dst).await?,
                        Err(err) if link_read_is_fatal(&err) => return Err(err),
                        Err(_) => skipped.push(e.key),
                    }
                } else {
                    skipped.push(e.key);
                }
            } else if e.is_dir() {
                s.mkdir(&to.root, &dst).await?;
            } else {
                copy_file(e.key, dst).await?;
            }
        }
    }
    if !skipped.is_empty() {
        return Err(StorageError::other(format!("Copied, except {} link(s) to folders (or to something no longer there), which this connection can't copy.", skipped.len())).with_detail(skipped.join("\n")));
    }
    Ok(())
}

/// A link that couldn't be read as a file during a copy stops the copy only when the connection
/// itself is in trouble; otherwise it is taken for a link to a folder (or to nothing) and left out.
fn link_read_is_fatal(e: &StorageError) -> bool {
    matches!(e.kind, ErrKind::Network | ErrKind::Cancelled | ErrKind::NeedsAuth | ErrKind::RateLimited | ErrKind::UntrustedCert | ErrKind::CertChanged | ErrKind::Unencrypted)
}

#[allow(clippy::too_many_arguments)]
pub async fn copy_or_move<R: Runtime>(
    app: &AppHandle<R>,
    s: &dyn Storage,
    bucket: &str,
    from: String,
    to: String,
    is_prefix: bool,
    delete_source: bool,
) -> Result<u64, String> {
    let never = Arc::new(AtomicBool::new(false));
    let r = move_with(app, s, bucket, None, &[MoveItem { from, to, is_prefix }], delete_source, None, &never).await?;
    match r.error {
        Some(e) => Err(e),
        None => Ok(r.done),
    }
}

/// Which keys (and folders) are already there, in the order asked.
pub async fn existing_keys(s: &dyn Storage, bucket: &str, keys: Vec<String>, prefixes: Vec<String>) -> Result<Existing, String> {
    let check = |k: String, dir: bool| async move {
        let probe = if dir && !k.ends_with('/') { format!("{k}/") } else { k.clone() };
        s.stat(bucket, &probe).await.map(|e| e.is_some().then_some(k))
    };
    let keys: Vec<_> = futures_util::stream::iter(keys.into_iter().map(|k| check(k, false))).buffered(16).collect().await;
    let prefixes: Vec<_> = futures_util::stream::iter(prefixes.into_iter().map(|k| check(k, true))).buffered(16).collect().await;
    let flat = |v: Vec<SResult<Option<String>>>| v.into_iter().filter_map(Result::transpose).collect::<SResult<Vec<String>>>();
    Ok(Existing { keys: flat(keys)?, prefixes: flat(prefixes)? })
}

pub async fn list_all_under(s: &dyn Storage, bucket: &str, prefix: &str) -> Result<Vec<RemoteFile>, String> {
    let mut out = Vec::new();
    let mut walk = s.walk(bucket, prefix);
    while let Some(batch) = walk.next().await {
        out.extend(batch?.into_iter().filter(|e| !e.is_dir()).map(|e| RemoteFile { key: e.key, size: e.size }));
    }
    Ok(out)
}

// ---------------------------------------------------------------- transfers

/// Uploads a local file through the backend (`transfers::spawn_transfer` for non-S3 targets).
pub(crate) async fn upload(s: &dyn Storage, bucket: &str, key: &str, path: &str, cancel: &Arc<AtomicBool>, progress: Progress<'_>) -> Result<Outcome, String> {
    upload_with(s, bucket, key, path, WriteOpts::default(), cancel, progress).await
}

/// [`upload`] with options: `resume` and `on_part` make it resumable where the backend allows (a
/// cloud drive's upload session, an SFTP / FTP server's temporary file). With `on_part` set, a
/// cancelled or failed upload is left for the caller to carry on or clean up.
pub(crate) async fn upload_with(
    s: &dyn Storage,
    bucket: &str,
    key: &str,
    path: &str,
    opts: WriteOpts<'_>,
    cancel: &Arc<AtomicBool>,
    progress: Progress<'_>,
) -> Result<Outcome, String> {
    let src = WriteSource::Path(path.into());
    match s.write(bucket, key, src, opts, progress, cancel).await? {
        WriteOutcome::Done(_) => Ok(Outcome::Done),
        WriteOutcome::Cancelled => Ok(Outcome::Cancelled),
        WriteOutcome::Conflict(_) => Err(StorageError::conflict().into()),
    }
}

/// Downloads through the backend into `<dest>.s3part`, renamed onto `dest` once whole. The
/// bandwidth cap applies unless the source is this device's own disk.
/// With `hold`, "Wi-Fi only" pauses it on mobile data (see `transfers::Hold`).
pub(crate) async fn download(
    s: &dyn Storage,
    bucket: &str,
    key: &str,
    dest: &Path,
    cancel: &AtomicBool,
    progress: Progress<'_>,
    hold: crate::transfers::Hold<'_>,
) -> Result<Outcome, String> {
    let mut dl = Dl::default();
    download_resumable(s, bucket, key, dest, None, false, cancel, progress, hold, &mut dl).await
}

/// How many times in a row a download picks up again after the connection drops.
const RESUME_ATTEMPTS: u32 = 6;

/// Where a download of `total` bytes carries on from a partial file of `have` bytes: None to
/// start over (nothing there, as big as the file or bigger, or no version to ask for).
pub(crate) fn continue_at(have: u64, total: Option<u64>, version: Option<&str>, ranged: bool) -> Option<u64> {
    match (version, total) {
        (Some(_), Some(t)) if ranged && have > 0 && have < t => Some(have),
        _ => None,
    }
}

/// [`download`] that can carry on: with `resume` (the version an earlier attempt fetched), a
/// partial file it left is continued with a ranged read of the same version, where the backend
/// reads ranges. A dropped connection mid-file is picked up again the same way. With
/// `keep_partial`, a failed download keeps its partial file for a later retry; with `dl.pause`
/// set when it is cancelled, it keeps it too and answers [`crate::multipart::PAUSED`].
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_resumable(
    s: &dyn Storage,
    bucket: &str,
    key: &str,
    dest: &Path,
    resume: Option<&str>,
    keep_partial: bool,
    cancel: &AtomicBool,
    progress: Progress<'_>,
    hold: crate::transfers::Hold<'_>,
    dl: &mut Dl<'_>,
) -> Result<Outcome, String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let part = dest::part_path(dest);
    let mut lane = (!s.caps().local_paths).then(|| DOWN.lane());
    let ranged = s.caps().range_read;
    // a partial file of an earlier attempt: the rest of the same version, if the server can
    let mut resumed = None;
    if let Some(version) = resume
        && let Some((f, have)) = dest::open_part(&part).await
        && let Ok(Some(now)) = s.stat(bucket, key).await
        && let Some(at) = continue_at(have, Some(now.size.max(0) as u64), Some(version), ranged)
        && let Ok(r) = s.read(bucket, key, Some(at..now.size as u64), Some(version)).await
        && r.range.as_ref().map(|g| g.start) == Some(at)
    {
        resumed = Some((r, at, f, now.size as u64));
    }
    let (mut r, mut got, mut file, total, etag) = match resumed {
        Some((r, at, f, total)) => (r, at, f, total, resume.map(str::to_string)),
        None => {
            let r = s.read(bucket, key, None, None).await?;
            let total = r.total.or(r.len).unwrap_or(0);
            let etag = r.etag.clone();
            let f = dest::create_part(&part).await.map_err(|e| e.to_string())?;
            crate::leftovers::partial_started(&part);
            (r, 0, f, total, etag)
        }
    };
    dl.etag.clone_from(&etag);
    dl.from = got;
    if let Some(seen) = dl.seen {
        seen(etag.as_deref());
    }
    // only a version that can be asked for again can be carried on
    let can_resume = ranged && etag.is_some() && total > 0;
    let result: SResult<bool> = async {
        let (mut last, mut checked_at, mut failures) = (Instant::now(), got, 0u32);
        progress(got, total);
        loop {
            let chunk = match r.body.next().await {
                None => break,
                Some(Ok(c)) => c,
                // the connection dropped mid-file: ask for the rest of the same version
                Some(Err(e)) => {
                    if !can_resume || got >= total {
                        return Err(e.into());
                    }
                    loop {
                        failures += 1;
                        if failures > RESUME_ATTEMPTS {
                            return Err(StorageError::from(e));
                        }
                        tokio::time::sleep(Duration::from_secs((1u64 << (failures - 1).min(4)).min(15))).await;
                        if cancel.load(Ordering::Relaxed) {
                            return Ok(false);
                        }
                        match s.read(bucket, key, Some(got..total), etag.as_deref()).await {
                            Ok(rest) if rest.range.as_ref().map(|g| g.start) == Some(got) => {
                                r = rest;
                                break;
                            }
                            // the file changed, or the server sent something else: can't go on
                            Ok(_) => return Err(StorageError::from(e)),
                            Err(again) if again.kind == ErrKind::Conflict => return Err(again),
                            Err(_) => continue,
                        }
                    }
                    continue;
                }
            };
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            file.write_all(&chunk).await?;
            got += chunk.len() as u64;
            failures = 0;
            if last.elapsed() > Duration::from_millis(150) {
                progress(got, total.max(got));
                last = Instant::now();
            }
            if let Some(l) = lane.as_mut() {
                l.throttle(chunk.len()).await;
            }
            // "Wi-Fi only" and the phone moved to mobile data: let go of the connection, keep
            // what arrived, and ask for the rest (of the same version) once back on Wi-Fi
            if let Some(paused) = hold
                && got - checked_at >= crate::tuning::WIFI_CHECK_BYTES
                && got < total
                && crate::tuning::hold_for_wifi()
            {
                checked_at = got;
                r.body = Box::pin(futures_util::stream::empty());
                file.flush().await?;
                paused(got, total);
                if !crate::tuning::wait_for_wifi(cancel).await {
                    return Ok(false);
                }
                r = s.read(bucket, key, Some(got..total), etag.as_deref()).await?;
                if r.range.as_ref().map(|g| g.start) != Some(got) {
                    return Err(StorageError::other("The server can't carry on this download where it paused. Try again."));
                }
                progress(got, total);
            } else if got - checked_at >= crate::tuning::WIFI_CHECK_BYTES {
                checked_at = got;
            }
        }
        file.flush().await?;
        file.sync_all().await?;
        progress(got, total.max(got));
        Ok(true)
    }
    .await;
    let _ = file.flush().await;
    drop(file);
    let paused = dl.pause.is_some_and(|p| p.load(Ordering::Relaxed));
    match result {
        Ok(true) => {
            tokio::fs::rename(&part, dest).await.map_err(|e| e.to_string())?;
            crate::leftovers::partial_ended(&part);
            Ok(Outcome::Done)
        }
        // paused: what arrived stays, to carry on from
        Ok(false) if paused && can_resume => Err(crate::multipart::PAUSED.into()),
        Ok(false) => {
            let _ = tokio::fs::remove_file(&part).await;
            Ok(Outcome::Cancelled)
        }
        Err(e) => {
            if !(keep_partial && can_resume) {
                let _ = tokio::fs::remove_file(&part).await;
            }
            Err(e.into())
        }
    }
}

/// Told the version a download fetches.
pub(crate) type Seen<'a> = dyn Fn(Option<&str>) + Send + Sync + 'a;

/// What a download is told and tells back besides its bytes.
#[derive(Default)]
pub(crate) struct Dl<'a> {
    /// set together with the cancel flag: stop, but keep the partial file to carry on later
    pub pause: Option<&'a AtomicBool>,
    /// told the version (ETag) being fetched as soon as it is known
    pub seen: Option<&'a Seen<'a>>,
    /// the version fetched
    pub etag: Option<String>,
    /// the byte it started from (above 0: it carried on a partial file)
    pub from: u64,
}

#[cfg(test)]
mod tests {
    //! The generic commands against the local disk.
    use super::*;
    use crate::storage::local::LocalBackend;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tauri::{test::{mock_builder, mock_context, noop_assets}, Listener};

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn setup() -> (Tmp, LocalBackend, String) {
        let base = std::env::temp_dir().join(format!("kybl-generic-{}", uuid::Uuid::new_v4()));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("photos/2026")).unwrap();
        std::fs::write(root.join("readme.md"), b"# Read me\nhello").unwrap();
        std::fs::write(root.join("photos/Report.pdf"), vec![1u8; 100]).unwrap();
        std::fs::write(root.join("photos/2026/report-2.pdf"), vec![2u8; 250]).unwrap();
        std::fs::write(root.join("photos/2026/cat.jpg"), vec![3u8; 1000]).unwrap();
        let b = LocalBackend::with_roots(vec![("Test".into(), RootKind::Folder, root)], false);
        let id = futures_executor_block(b.roots()).unwrap()[0].id.clone();
        (Tmp(base), b, id)
    }

    fn futures_executor_block<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Runtime::new().unwrap().block_on(f)
    }

    #[test]
    fn browse_commands_answer_like_s3() {
        let (_t, b, root) = setup();
        futures_executor_block(async {
            let l = list_objects(&b, &root, "", None).await.unwrap();
            assert_eq!(l.folders, vec!["photos/"]);
            assert_eq!(l.objects[0].key, "readme.md");
            let v = serde_json::to_value(&l).unwrap();
            assert!(v.get("nextToken").is_some() && v["objects"][0].get("storageClass").is_some(), "{v}");

            let buckets = list_buckets(&b).await.unwrap();
            assert_eq!(buckets[0].name, root);

            let d = head_object(&b, &root, "readme.md").await.unwrap();
            assert_eq!((d.size, d.content_type.as_deref()), (15, Some("text/markdown")));
            assert!(head_object(&b, &root, "nope").await.is_err());

            let t = get_text_preview(&b, &root, "readme.md", 9).await.unwrap();
            assert_eq!((t.text.as_str(), t.truncated), ("# Read me", true));
            let t = get_text_preview(&b, &root, "readme.md", 1000).await.unwrap();
            assert!(!t.truncated);
            assert!(get_object_bytes(&b, &root, "photos/2026/cat.jpg", 10).await.err().is_some_and(|e| e.contains("too large")));
            assert!(get_object_bytes(&b, &root, "photos/2026/cat.jpg", 1000).await.is_ok());
            assert!(presign_get(&b, &root, "readme.md", 60).await.is_err(), "no links for local files");

            let never = AtomicBool::new(false);
            let r = search_scan(&b, &root, "", "REPORT", 1000, 100, &never, |_, _| {}).await.unwrap();
            let mut keys: Vec<_> = r.objects.iter().map(|o| o.key.as_str()).collect();
            keys.sort();
            assert_eq!(keys, vec!["photos/2026/report-2.pdf", "photos/Report.pdf"]);
            assert!(!r.truncated);
            let stop = AtomicBool::new(true);
            assert!(search_scan(&b, &root, "", "report", 1000, 100, &stop, |_, _| {}).await.unwrap().truncated);

            let f = size_scan(&b, &root, "photos/", &never, |_, _| {}).await.unwrap();
            assert_eq!((f.bytes, f.objects), (1350, 3));
            assert_eq!(f.children, vec![ChildSize { prefix: "photos/2026/".into(), bytes: 1250, objects: 2 }]);
            assert_eq!(size_scan(&b, &root, "photos/", &stop, |_, _| {}).await.err().as_deref(), Some(CANCELLED));

            let mut all: Vec<_> = list_all_under(&b, &root, "photos/").await.unwrap().into_iter().map(|f| f.key).collect();
            all.sort();
            assert_eq!(all, vec!["photos/2026/cat.jpg", "photos/2026/report-2.pdf", "photos/Report.pdf"]);

            let ex = existing_keys(&b, &root, vec!["nope.txt".into(), "readme.md".into()], vec!["photos/".into(), "empty/".into(), "photos/2026".into()]).await.unwrap();
            assert_eq!(ex, Existing { keys: vec!["readme.md".into()], prefixes: vec!["photos/".into(), "photos/2026".into()] });
        });
    }

    #[test]
    fn mutations_report_progress_like_s3() {
        let (t, b, root) = setup();
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let ev = events.clone();
        app.listen_any("move-progress", move |e| ev.lock().unwrap().push(e.payload().to_string()));
        let h = app.handle().clone();
        futures_executor_block(async {
            create_folder(&b, &root, "new").await.unwrap();
            assert!(t.0.join("root/new").is_dir());

            let flag = Arc::new(AtomicBool::new(false));
            let items = [MoveItem { from: "photos/".into(), to: "new/photos/".into(), is_prefix: true }];
            let r = move_with(&h, &b, &root, None, &items, false, Some("op1"), &flag).await.unwrap();
            assert_eq!((r.done, r.total, r.error), (1, 1, None));
            assert!(t.0.join("root/new/photos/2026/cat.jpg").exists() && t.0.join("root/photos/2026/cat.jpg").exists());

            let items = [MoveItem { from: "readme.md".into(), to: "new/readme.md".into(), is_prefix: false }];
            let r = move_with(&h, &b, &root, None, &items, true, Some("op2"), &flag).await.unwrap();
            assert!(r.error.is_none());
            assert!(!t.0.join("root/readme.md").exists() && t.0.join("root/new/readme.md").exists());

            let bad = [MoveItem { from: "new/".into(), to: "new/inner/".into(), is_prefix: true }];
            assert!(move_with(&h, &b, &root, None, &bad, true, None, &flag).await.is_err());
            let stop = Arc::new(AtomicBool::new(true));
            let r = move_with(&h, &b, &root, None, &items, true, None, &stop).await.unwrap();
            assert_eq!(r.error.as_deref(), Some(CANCELLED));

            assert_eq!(copy_or_move(&h, &b, &root, "new/readme.md".into(), "readme2.md".into(), false, false).await.unwrap(), 1);

            // the byte-by-byte copy, for stores without a server-side one
            let never = Arc::new(AtomicBool::new(false));
            copy_through(&b, &Loc::new(&root, "new/photos/"), &Loc::new(&root, "through/"), true, &never).await.unwrap();
            assert_eq!(std::fs::read(t.0.join("root/through/2026/cat.jpg")).unwrap(), vec![3u8; 1000]);

            let r = delete_with(&h, &b, &root, &["readme2.md".into()], &["new/".into(), "through/".into()], Some("op3"), &AtomicBool::new(false)).await;
            assert_eq!((r.done, r.total, r.error), (3, 3, None));
            assert!(!t.0.join("root/new").exists());
        });
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|e| e.contains(r#""phase":"copying""#) && e.contains(r#""opId":"op1""#)), "{ev:?}");
        assert!(ev.iter().any(|e| e.contains(r#""phase":"deleting""#) && e.contains(r#""done":3"#)), "{ev:?}");
    }

    #[test]
    fn transfers_go_through_the_backend() {
        let (t, b, root) = setup();
        futures_executor_block(async {
            let seen = Mutex::new((0u64, 0u64));
            let report = |d: u64, total: u64| *seen.lock().unwrap() = (d, total);
            let dest = t.0.join("down/cat.jpg");
            let never = Arc::new(AtomicBool::new(false));
            assert!(matches!(download(&b, &root, "photos/2026/cat.jpg", &dest, &never, &report, None).await.unwrap(), Outcome::Done));
            assert_eq!(std::fs::read(&dest).unwrap().len(), 1000);
            assert_eq!(*seen.lock().unwrap(), (1000, 1000));
            assert!(!dest::part_path(&dest).exists());

            let stop = AtomicBool::new(true);
            let dest2 = t.0.join("down/stopped.jpg");
            assert!(matches!(download(&b, &root, "photos/2026/cat.jpg", &dest2, &stop, &report, None).await.unwrap(), Outcome::Cancelled));
            assert!(!dest2.exists() && !dest::part_path(&dest2).exists());

            assert!(matches!(upload(&b, &root, "up/again.jpg", dest.to_str().unwrap(), &never, &report).await.unwrap(), Outcome::Done));
            assert_eq!(std::fs::read(t.0.join("root/up/again.jpg")).unwrap().len(), 1000);
        });
    }

    #[test]
    fn a_download_carries_on_only_with_a_version_and_a_partial_file_smaller_than_the_whole() {
        assert_eq!(continue_at(100, Some(1000), Some("v1"), true), Some(100));
        assert_eq!(continue_at(0, Some(1000), Some("v1"), true), None, "nothing there yet");
        assert_eq!(continue_at(1000, Some(1000), Some("v1"), true), None, "as big as the file");
        assert_eq!(continue_at(2000, Some(1000), Some("v1"), true), None, "bigger: the file changed");
        assert_eq!(continue_at(100, Some(1000), None, true), None, "no version to ask for");
        assert_eq!(continue_at(100, None, Some("v1"), true), None, "size unknown");
        assert_eq!(continue_at(100, Some(1000), Some("v1"), false), None, "no ranged reads");
    }

    #[test]
    fn downloads_carry_on_from_a_partial_file_and_keep_it_when_paused() {
        let (t, b, root) = setup();
        let content: Vec<u8> = (0..2_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(t.0.join("root/big.bin"), &content).unwrap();
        futures_executor_block(async {
            let etag = b.stat(&root, "big.bin").await.unwrap().unwrap().etag.expect("the local disk tags versions");
            let never = AtomicBool::new(false);
            let first = Mutex::new(None::<u64>);
            let report = |d: u64, _| {
                first.lock().unwrap().get_or_insert(d);
            };

            // an earlier attempt left the first 700,000 bytes
            let dest = t.0.join("down/big.bin");
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::write(dest::part_path(&dest), &content[..700_000]).unwrap();
            let mut dl = Dl::default();
            let r = download_resumable(&b, &root, "big.bin", &dest, Some(&etag), true, &never, &report, None, &mut dl).await.unwrap();
            assert!(matches!(r, Outcome::Done));
            assert_eq!(dl.from, 700_000);
            assert_eq!(*first.lock().unwrap(), Some(700_000), "progress starts where it carried on");
            assert!(std::fs::read(&dest).unwrap() == content, "the whole file, in order");
            assert!(!dest::part_path(&dest).exists());

            // a stale version starts over instead of mixing two files
            let dest2 = t.0.join("down/stale.bin");
            std::fs::write(dest::part_path(&dest2), vec![9u8; 500]).unwrap();
            let mut dl = Dl::default();
            let r = download_resumable(&b, &root, "big.bin", &dest2, Some("not-this-one"), true, &never, &|_, _| {}, None, &mut dl).await.unwrap();
            assert!(matches!(r, Outcome::Done));
            assert_eq!(dl.from, 0);
            assert!(std::fs::read(&dest2).unwrap() == content);

            // paused: the partial file stays, and it says so
            let dest3 = t.0.join("down/paused.bin");
            let (stop, pause) = (AtomicBool::new(true), AtomicBool::new(true));
            let mut dl = Dl { pause: Some(&pause), ..Default::default() };
            let r = download_resumable(&b, &root, "big.bin", &dest3, None, true, &stop, &|_, _| {}, None, &mut dl).await;
            assert_eq!(r.err().as_deref(), Some(crate::multipart::PAUSED));
            assert!(dest::part_path(&dest3).exists() && !dest3.exists());
            assert_eq!(dl.etag.as_deref(), Some(etag.as_str()));
        });
    }
}
