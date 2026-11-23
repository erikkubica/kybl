use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use aws_sdk_s3::{
    presigning::PresigningConfig,
    primitives::DateTime,
    operation::head_object::HeadObjectOutput,
    types::{CompletedMultipartUpload, CompletedPart, Delete, MetadataDirective, ObjectIdentifier, StorageClass},
    Client,
};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

use crate::state::{
    build_client, delete_secret, err, get_secret, load_profiles, save_profiles, sdk_err, set_secret,
    AppState,
    Profile,
};
use crate::storage::{self, generic_cmds as generic, registry, ConnKind, Conn};

const COPY_SOURCE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// Objects above this size are copied with multipart copy (CopyObject tops out at 5 GiB).
const MULTIPART_COPY_THRESHOLD: i64 = 4 * 1024 * 1024 * 1024;
const COPY_PART_SIZE: i64 = 512 * 1024 * 1024;

pub(crate) fn millis(d: Option<&DateTime>) -> Option<i64> {
    d.map(|d| d.secs() * 1000 + (d.subsec_nanos() / 1_000_000) as i64)
}

// ---------------------------------------------------------------- profiles

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> Result<Vec<Profile>, String> {
    load_profiles(&app)
}

#[tauri::command]
pub async fn save_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    mut profile: Profile,
    secret: Option<String>,
) -> Result<Profile, String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    profile.group = profile.group.as_deref().and_then(crate::state::normalize_group);
    // reserved for this device's own folders, which are never a saved connection
    if profile.id == registry::LOCAL_ID {
        return Err("This connection can't be changed.".into());
    }
    if let Some(s) = secret.as_deref().filter(|s| !s.is_empty()) {
        set_secret(&state, &profile.id, s).await?;
    } else if profile.kind == ConnKind::S3 && get_secret(&state, &profile.id).await?.is_none() {
        return Err("A secret key is required for a new connection".into());
    }
    let mut profiles = load_profiles(&app)?;
    match profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile.clone(),
        None => profiles.push(profile.clone()),
    }
    save_profiles(&app, &profiles)?;
    state.clients.lock().await.remove(&profile.id);
    registry::forget(&profile.id);
    // the connection may point somewhere else now (another endpoint or account)
    crate::filecache::forget_profile(&app, &profile.id).await;
    Ok(profile)
}

/// Files connections under sidebar groups (`None` or "": the top level), by id. Only the group
/// changes: unlike `save_profile`, the connections keep their open clients and cached files.
#[tauri::command]
pub fn set_profile_groups(app: AppHandle, groups: std::collections::HashMap<String, Option<String>>) -> Result<Vec<Profile>, String> {
    let mut profiles = load_profiles(&app)?;
    apply_groups(&mut profiles, &groups);
    save_profiles(&app, &profiles)?;
    Ok(profiles)
}

fn apply_groups(profiles: &mut [Profile], groups: &std::collections::HashMap<String, Option<String>>) {
    for p in profiles.iter_mut() {
        if let Some(g) = groups.get(&p.id) {
            p.group = g.as_deref().and_then(crate::state::normalize_group);
        }
    }
}

#[tauri::command]
pub async fn delete_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut profiles = load_profiles(&app)?;
    profiles.retain(|p| p.id != id);
    save_profiles(&app, &profiles)?;
    delete_secret(&state, &id).await?;
    state.clients.lock().await.remove(&id);
    registry::forget(&id);
    // files of a deleted connection don't stay on this computer
    crate::filecache::forget_profile(&app, &id).await;
    crate::placeholders::forget_profile(&id);
    Ok(())
}

/// Tries the connection with the given (possibly unsaved) settings.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: Profile,
    secret: Option<String>,
) -> Result<String, String> {
    if profile.kind != ConnKind::S3 {
        let s = registry::build(&app, &state, &profile, secret).await?;
        s.roots().await?;
        return Ok("Connected.".into());
    }
    let secret = match secret.filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => get_secret(&state, &profile.id)
            .await?
            .ok_or_else(|| "Enter the secret key to test".to_string())?,
    };
    let client = build_client(&profile, &secret);
    let bucket = profile.bucket.clone().filter(|b| !b.is_empty());
    match client.list_buckets().send().await {
        Ok(out) => Ok(format!("Connected. {} bucket(s) visible.", out.buckets().len())),
        Err(list_err) => {
            // Many providers scope keys to one bucket and refuse ListBuckets.
            if let Some(b) = bucket {
                client
                    .list_objects_v2()
                    .bucket(&b)
                    .max_keys(1)
                    .send()
                    .await
                    .map_err(sdk_err)?;
                Ok(format!("Connected. Bucket \"{b}\" is reachable (this key cannot list all buckets)."))
            } else {
                let e = sdk_err(list_err);
                let (say, details) = e.split_once("\n\n").unwrap_or((e.as_str(), ""));
                let details = if details.is_empty() { String::new() } else { format!("\n\n{details}") };
                Err(format!(
                    "{say} If this key is limited to one bucket, enter the bucket name and test again.{details}"
                ))
            }
        }
    }
}

// ---------------------------------------------------------------- browsing

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketInfo {
    pub(crate) name: String,
    pub(crate) created: Option<i64>,
}

#[tauri::command]
pub async fn list_buckets(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<BucketInfo>, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::list_buckets(&*s).await,
    };
    let out = client.list_buckets().send().await.map_err(sdk_err)?;
    Ok(out
        .buckets()
        .iter()
        .map(|b| BucketInfo {
            name: b.name().unwrap_or_default().to_string(),
            created: millis(b.creation_date()),
        })
        .collect())
}

/// Creates a bucket. Only offered for Kybl Storage, whose account owns its buckets (so no
/// region/location constraint to pick).
#[tauri::command]
pub async fn create_bucket(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
) -> Result<(), String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::create_bucket(&*s, &bucket).await,
    };
    client.create_bucket().bucket(bucket).send().await.map_err(sdk_err)?;
    Ok(())
}

/// A listed object: the storage core's [`storage::Entry`], which serializes the same way.
pub(crate) use crate::storage::Entry as ObjInfo;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub(crate) folders: Vec<String>,
    pub(crate) objects: Vec<ObjInfo>,
    pub(crate) next_token: Option<String>,
}

pub(crate) fn obj_info(o: &aws_sdk_s3::types::Object) -> ObjInfo {
    ObjInfo {
        key: o.key().unwrap_or_default().to_string(),
        size: o.size().unwrap_or(0),
        modified: millis(o.last_modified()),
        etag: o.e_tag().map(|e| e.trim_matches('"').to_string()),
        storage_class: o.storage_class().map(|s| s.as_str().to_string()),
        ..Default::default()
    }
}

#[tauri::command]
pub async fn list_objects(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
    token: Option<String>,
) -> Result<ListResult, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::list_objects(&*s, &bucket, &prefix, token).await,
    };
    let out = client
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(&prefix)
        .delimiter("/")
        .max_keys(1000)
        .set_continuation_token(token)
        .send()
        .await
        .map_err(sdk_err)?;
    let folders = out
        .common_prefixes()
        .iter()
        .filter_map(|p| p.prefix().map(|s| s.to_string()))
        .collect();
    let objects = out
        .contents()
        .iter()
        .filter(|o| o.key() != Some(prefix.as_str()))
        .map(obj_info)
        .collect();
    Ok(ListResult {
        folders,
        objects,
        next_token: if out.is_truncated().unwrap_or(false) {
            out.next_continuation_token().map(|s| s.to_string())
        } else {
            None
        },
    })
}

pub(crate) async fn list_all(
    client: &Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<ObjInfo>, String> {
    let mut all = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let out = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(token.take())
            .send()
            .await
            .map_err(sdk_err)?;
        all.extend(out.contents().iter().map(obj_info));
        if out.is_truncated().unwrap_or(false) {
            token = out.next_continuation_token().map(|s| s.to_string());
            if token.is_none() {
                break;
            }
        } else {
            break;
        }
    }
    Ok(all)
}

/// Most direct subfolders reported back for one folder (the biggest ones win).
pub(crate) const MAX_CHILDREN: usize = 5000;

/// Size of one direct subfolder, including everything nested below it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChildSize {
    pub(crate) prefix: String,
    pub(crate) bytes: u64,
    pub(crate) objects: u64,
}

/// Runs `fut` unless `cancel` is set first (checked every 100 ms): a slow listing request on a
/// big scan shouldn't hold up Stop. None when cancelled.
async fn unless_cancelled<T>(fut: impl std::future::Future<Output = T>, cancel: Option<&AtomicBool>) -> Option<T> {
    let Some(flag) = cancel else { return Some(fut.await) };
    tokio::pin!(fut);
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            out = &mut fut => return Some(out),
            _ = tick.tick() => if flag.load(Ordering::Relaxed) { return None },
        }
    }
}

/// Tries a listing page that failed once or twice more before giving up: a scan of a few million
/// keys takes thousands of requests, and one dropped connection shouldn't throw all of it away.
/// Listing the same page again (same continuation token) is safe.
const PAGE_TRIES: u32 = 3;

pub(crate) async fn list_page(
    client: &Client,
    bucket: &str,
    prefix: &str,
    token: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> Result<aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output, String> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let req = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(token.map(str::to_string))
            .send();
        match unless_cancelled(req, cancel).await {
            None => return Err(CANCELLED.into()),
            Some(Ok(out)) => return Ok(out),
            Some(Err(e)) if attempt >= PAGE_TRIES => return Err(sdk_err(e)),
            Some(Err(_)) => {
                if unless_cancelled(tokio::time::sleep(Duration::from_secs(attempt as u64)), cancel).await.is_none() {
                    return Err(CANCELLED.into());
                }
            }
        }
    }
}

/// Total size of everything under `prefix`, however deep. S3 stores no folder sizes, so this reads
/// the whole flat listing (1,000 keys per request) and adds it up. The same pass also totals each
/// direct subfolder, so one run answers for the folder and for every folder directly inside it.
/// `on_page` gets the running (bytes, objects).
pub(crate) async fn prefix_size(
    client: &Client,
    bucket: &str,
    prefix: &str,
    cancel: Option<&AtomicBool>,
    mut on_page: impl FnMut(u64, u64),
) -> Result<(u64, u64, Vec<ChildSize>), String> {
    let (mut bytes, mut objects) = (0u64, 0u64);
    let mut kids: HashMap<String, (u64, u64)> = HashMap::new();
    let mut token: Option<String> = None;
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(CANCELLED.into());
        }
        let out = list_page(client, bucket, prefix, token.as_deref(), cancel).await?;
        for o in out.contents() {
            // folder markers ("name/" with no content) are not files
            if o.key().is_some_and(|k| k.ends_with('/')) && o.size().unwrap_or(0) == 0 {
                continue;
            }
            let size = o.size().unwrap_or(0).max(0) as u64;
            bytes += size;
            objects += 1;
            // "a/b/c.txt" under "a/" belongs to the direct subfolder "a/b/"
            if let Some(rest) = o.key().and_then(|k| k.strip_prefix(prefix)) {
                if let Some(slash) = rest.find('/') {
                    let e = kids.entry(format!("{prefix}{}", &rest[..=slash])).or_default();
                    e.0 += size;
                    e.1 += 1;
                }
            }
        }
        on_page(bytes, objects);
        token = out.next_continuation_token().map(|t| t.to_string());
        if !out.is_truncated().unwrap_or(false) || token.is_none() {
            let mut children: Vec<ChildSize> = kids.into_iter().map(|(prefix, (bytes, objects))| ChildSize { prefix, bytes, objects }).collect();
            children.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.prefix.cmp(&b.prefix)));
            children.truncate(MAX_CHILDREN);
            return Ok((bytes, objects, children));
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSize {
    pub(crate) bytes: u64,
    pub(crate) objects: u64,
    pub(crate) children: Vec<ChildSize>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SizeProgress {
    pub(crate) op_id: String,
    pub(crate) bytes: u64,
    pub(crate) objects: u64,
}

/// Adds up a folder's size in the background; progress arrives as `size-progress` events and the
/// run can be stopped with `cancel_transfer(op_id)`.
#[tauri::command]
pub async fn folder_size(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
    op_id: String,
) -> Result<FolderSize, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::folder_size(&app, &state, &*s, &bucket, &prefix, op_id).await,
    };
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    // a few events a second is plenty, even when a fast server lists many pages a second
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    let result = prefix_size(&client, &bucket, &prefix, Some(&flag), |bytes, objects| {
        if last.elapsed() >= Duration::from_millis(200) {
            last = std::time::Instant::now();
            let _ = app.emit("size-progress", SizeProgress { op_id: op_id.clone(), bytes, objects });
        }
    })
    .await;
    if let Ok((bytes, objects, _)) = &result {
        let _ = app.emit("size-progress", SizeProgress { op_id: op_id.clone(), bytes: *bytes, objects: *objects });
    }
    state.cancels.lock().await.remove(&op_id);
    result.map(|(bytes, objects, children)| FolderSize { bytes, objects, children })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub(crate) objects: Vec<ObjInfo>,
    pub(crate) scanned: u64,
    /// true when the scan stopped early (a limit reached, or stopped by the user), so results
    /// may be incomplete
    pub(crate) truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchProgress {
    pub(crate) op_id: String,
    pub(crate) scanned: u64,
    /// matches from this page only; the UI appends them
    pub(crate) found: Vec<ObjInfo>,
}

/// Recursive, case-insensitive "contains" search over the keys below `prefix`.
/// With an `op_id`, each page reports a `search-progress` event (keys checked so far and the new
/// matches), and `cancel_transfer(op_id)` stops the scan.
#[tauri::command]
pub async fn search_objects(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
    query: String,
    op_id: Option<String>,
) -> Result<SearchResult, String> {
    const MAX_SCAN: u64 = 300_000;
    const MAX_RESULTS: usize = 500;
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::search_objects(&app, &state, &*s, &bucket, &prefix, &query, op_id).await,
    };
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(id) = &op_id {
        state.cancels.lock().await.insert(id.clone(), flag.clone());
    }
    let result = search_scan(&client, &bucket, &prefix, &query, MAX_SCAN, MAX_RESULTS, &flag, |scanned, found| {
        if let Some(id) = &op_id {
            let _ = app.emit("search-progress", SearchProgress { op_id: id.clone(), scanned, found: found.to_vec() });
        }
    })
    .await;
    if let Some(id) = &op_id {
        state.cancels.lock().await.remove(id);
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn search_scan(
    client: &Client,
    bucket: &str,
    prefix: &str,
    query: &str,
    max_scan: u64,
    max_results: usize,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, &[ObjInfo]),
) -> Result<SearchResult, String> {
    let (bucket, prefix) = (bucket.to_string(), prefix.to_string());
    let needle = query.to_lowercase();
    let mut found: Vec<ObjInfo> = Vec::new();
    let mut scanned = 0u64;
    let mut token: Option<String> = None;
    let mut truncated = false;
    'pages: loop {
        let out = match list_page(client, &bucket, &prefix, token.as_deref(), Some(cancel)).await {
            Ok(out) => out,
            // stopped: what was found so far is the answer, marked as incomplete
            Err(e) if e == CANCELLED => {
                truncated = true;
                break;
            }
            Err(e) => return Err(e),
        };
        let before = found.len();
        let mut full = false;
        for o in out.contents() {
            scanned += 1;
            let key = o.key().unwrap_or_default();
            if key.ends_with('/') {
                continue;
            }
            if key[prefix.len().min(key.len())..].to_lowercase().contains(&needle) {
                found.push(obj_info(o));
                if found.len() >= max_results {
                    full = true;
                    break;
                }
            }
        }
        progress(scanned, &found[before..]);
        if full {
            truncated = true;
            break 'pages;
        }
        if cancel.load(Ordering::Relaxed) {
            truncated = true;
            break;
        }
        if scanned >= max_scan {
            truncated = true;
            break;
        }
        if out.is_truncated().unwrap_or(false) {
            token = out.next_continuation_token().map(|s| s.to_string());
            if token.is_none() {
                break;
            }
        } else {
            break;
        }
    }
    Ok(SearchResult { objects: found, scanned, truncated })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetails {
    pub(crate) key: String,
    pub(crate) size: i64,
    pub(crate) content_type: Option<String>,
    pub(crate) modified: Option<i64>,
    pub(crate) etag: Option<String>,
    pub(crate) storage_class: Option<String>,
    pub(crate) metadata: HashMap<String, String>,
    pub(crate) cache_control: Option<String>,
    pub(crate) content_disposition: Option<String>,
    pub(crate) content_encoding: Option<String>,
}

pub(crate) fn details(key: String, h: &HeadObjectOutput) -> ObjectDetails {
    ObjectDetails {
        key,
        size: h.content_length().unwrap_or(0),
        content_type: h.content_type().map(|s| s.to_string()),
        modified: millis(h.last_modified()),
        etag: h.e_tag().map(|e| e.trim_matches('"').to_string()),
        storage_class: h.storage_class().map(|s| s.as_str().to_string()),
        metadata: h.metadata().cloned().unwrap_or_default(),
        cache_control: h.cache_control().map(str::to_string),
        content_disposition: h.content_disposition().map(str::to_string),
        content_encoding: h.content_encoding().map(str::to_string),
    }
}

#[tauri::command]
pub async fn head_object(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<ObjectDetails, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::head_object(&*s, &bucket, &key).await,
    };
    let h = client
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(sdk_err)?;
    Ok(details(key, &h))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub(crate) text: String,
    pub(crate) truncated: bool,
}

#[tauri::command]
pub async fn get_text_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
    max_bytes: usize,
) -> Result<TextPreview, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::get_text_preview(&*s, &bucket, &key, max_bytes).await,
    };
    let mut out = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .range(format!("bytes=0-{}", max_bytes.saturating_sub(1)))
        .send()
        .await
        .map_err(sdk_err)?;
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = out.body.try_next().await.map_err(err)? {
        buf.extend_from_slice(&chunk);
        if buf.len() >= max_bytes {
            buf.truncate(max_bytes);
            truncated = true;
            break;
        }
    }
    Ok(TextPreview {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    })
}

/// The whole object as raw bytes (no JSON), for previews that render the file in the app
/// itself, like PDFs. Refuses anything over `max_bytes` instead of loading it. With `cache`
/// (the PDF viewer), the bytes come from and go to the file cache, as `doc_open`'s do; image
/// thumbnails leave it off, so photos don't push documents out of it. `etag` and `size` (the
/// listing's) let a cached copy of that version answer without asking the server.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn get_object_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
    max_bytes: u64,
    cache: Option<bool>,
    etag: Option<String>,
    size: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let conn = storage::connect(&app, &state, &profile_id).await?;
    let cache = cache.unwrap_or(false);
    // the version the listing showed: a cached copy of it needs no HEAD
    if cache
        && let (Some(e), Some(n)) = (etag.as_deref(), size)
        && let Some(bytes) = crate::filecache::read_listed(&app, &conn, &profile_id, &bucket, &key, crate::filecache::Ident::new(Some(e), n, None), max_bytes).await
    {
        return Ok(tauri::ipc::Response::new(bytes));
    }
    if cache && let Some(bytes) = crate::filecache::read_current(&app, &conn, &profile_id, &bucket, &key, max_bytes).await {
        return Ok(tauri::ipc::Response::new(bytes));
    }
    let client = match &conn {
        Conn::S3(c) => c.clone(),
        Conn::Other(s) if cache => {
            let r = s.read(&bucket, &key, None, None).await?;
            let etag = r.etag.clone();
            let buf = r.collect(max_bytes).await?;
            crate::filecache::remember_bytes(&app, &conn, &profile_id, &bucket, &key, etag.as_deref(), None, &buf);
            return Ok(tauri::ipc::Response::new(buf));
        }
        Conn::Other(s) => return generic::get_object_bytes(&**s, &bucket, &key, max_bytes).await,
    };
    let mut out = client.get_object().bucket(&bucket).key(&key).send().await.map_err(sdk_err)?;
    let len = out.content_length().unwrap_or(0).max(0) as u64;
    if len > max_bytes {
        return Err("This file is too large to preview.".into());
    }
    let etag = out.e_tag().map(str::to_string);
    let modified = out.last_modified().map(|d| d.secs() * 1000 + (d.subsec_nanos() / 1_000_000) as i64);
    // sized up front: growing by doubling would briefly need up to twice the file
    let mut buf: Vec<u8> = Vec::with_capacity(len as usize);
    while let Some(chunk) = out.body.try_next().await.map_err(err)? {
        buf.extend_from_slice(&chunk);
        if buf.len() as u64 > max_bytes {
            return Err("This file is too large to preview.".into());
        }
    }
    if cache {
        crate::filecache::remember_bytes(&app, &conn, &profile_id, &bucket, &key, etag.as_deref(), modified, &buf);
    }
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
pub async fn presign_get(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
    expires_secs: u64,
) -> Result<String, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::presign_get(&*s, &bucket, &key, expires_secs).await,
    };
    let cfg = PresigningConfig::expires_in(Duration::from_secs(expires_secs.clamp(60, 7 * 24 * 3600)))
        .map_err(err)?;
    let req = client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .presigned(cfg)
        .await
        .map_err(sdk_err)?;
    Ok(req.uri().to_string())
}

// ---------------------------------------------------------------- mutations

#[tauri::command]
pub async fn create_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
) -> Result<(), String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::create_folder(&*s, &bucket, &prefix).await,
    };
    let key = if prefix.ends_with('/') { prefix } else { format!("{prefix}/") };
    client
        .put_object()
        .bucket(&bucket)
        .key(key)
        .send()
        .await
        .map_err(sdk_err)?;
    Ok(())
}

pub(crate) async fn delete_keys(client: &Client, bucket: &str, keys: &[String]) -> Result<(), String> {
    for chunk in keys.chunks(1000) {
        let ids: Result<Vec<ObjectIdentifier>, _> = chunk
            .iter()
            .map(|k| ObjectIdentifier::builder().key(k).build())
            .collect();
        let ids = ids.map_err(err)?;
        let delete = Delete::builder().set_objects(Some(ids)).quiet(true).build().map_err(err)?;
        let batch = client.delete_objects().bucket(bucket).delete(delete).send().await;
        let batch_failed = match &batch {
            Ok(out) => !out.errors().is_empty(),
            Err(_) => true,
        };
        if batch_failed {
            // Some S3-compatible services do not implement bulk delete: go one by one.
            for k in chunk {
                client
                    .delete_object()
                    .bucket(bucket)
                    .key(k)
                    .send()
                    .await
                    .map_err(sdk_err)?;
            }
        }
    }
    Ok(())
}

/// Deletes the given object keys and everything below the given prefixes, 1000 per request,
/// reporting `move-progress` events (phase "deleting") tagged with `op_id`. Can be cancelled
/// between batches with `cancel_transfer(op_id)`.
#[tauri::command]
pub async fn delete_objects(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    keys: Vec<String>,
    prefixes: Vec<String>,
    op_id: Option<String>,
) -> Result<OpResult, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::delete_objects(&app, &state, &*s, &bucket, keys, prefixes, op_id).await,
    };
    let op = op_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op.clone(), flag.clone());
    let _job = Job::start();
    let emit = |phase: &'static str, done: u64, total: u64| {
        let _ = app.emit("move-progress", MoveProgress { op_id: op.clone(), phase, done, total, bytes: 0, total_bytes: 0 });
    };
    let result = async {
        let mut all: Vec<String> = keys;
        for p in &prefixes {
            all.extend(list_all(&client, &bucket, p).await?.into_iter().map(|o| o.key));
            emit("listing", 0, all.len() as u64);
        }
        all.sort();
        all.dedup();
        let total = all.len() as u64;
        let mut done = 0u64;
        emit("deleting", 0, total);
        for chunk in all.chunks(DELETE_BATCH) {
            if flag.load(Ordering::Relaxed) {
                return Ok(OpResult { done, total, error: Some(CANCELLED.into()) });
            }
            if let Err(e) = delete_keys(&client, &bucket, chunk).await {
                return Ok(OpResult { done, total, error: Some(e) });
            }
            done += chunk.len() as u64;
            emit("deleting", done, total);
        }
        Ok::<_, String>(OpResult { done, total, error: None })
    }
    .await;
    state.cancels.lock().await.remove(&op);
    result
}

/// The headers an object carries that a copy has to set again when it can't just copy them
/// (multipart copy, and editing them in place).
#[derive(Clone, Default, Debug, PartialEq)]
pub(crate) struct Headers {
    pub(crate) content_type: Option<String>,
    pub(crate) cache_control: Option<String>,
    pub(crate) content_disposition: Option<String>,
    pub(crate) content_encoding: Option<String>,
    pub(crate) content_language: Option<String>,
    pub(crate) metadata: HashMap<String, String>,
    pub(crate) storage_class: Option<String>,
}

impl Headers {
    pub(crate) fn of(h: &HeadObjectOutput) -> Self {
        Self {
            content_type: h.content_type().map(str::to_string),
            cache_control: h.cache_control().map(str::to_string),
            content_disposition: h.content_disposition().map(str::to_string),
            content_encoding: h.content_encoding().map(str::to_string),
            content_language: h.content_language().map(str::to_string),
            metadata: h.metadata().cloned().unwrap_or_default(),
            // STANDARD is what an object gets without asking; sending it is only needed to leave
            // another class, and some providers refuse the header altogether
            storage_class: h.storage_class().map(|c| c.as_str().to_string()).filter(|c| c != "STANDARD"),
        }
    }
}

/// Copies `src` (in `src_bucket`) to `dst` (in `dst_bucket`, same connection), server-side.
/// Under the single-copy limit, CopyObject copies the headers itself; with `replace` it sets
/// those instead. Bigger objects go part by part, and a multipart upload starts with no headers
/// at all, so they are read from the source first (or taken from `replace`) and set on it.
pub(crate) async fn copy_object(
    client: &Client,
    src_bucket: &str,
    src: &str,
    dst_bucket: &str,
    dst: &str,
    size: i64,
    replace: Option<&Headers>,
) -> Result<(), String> {
    copy_object_from(client, src_bucket, src, dst_bucket, dst, size, replace, MULTIPART_COPY_THRESHOLD).await
}

/// [`copy_object`] with the size from which it copies part by part (tests use a small one).
#[allow(clippy::too_many_arguments)]
async fn copy_object_from(
    client: &Client,
    src_bucket: &str,
    src: &str,
    dst_bucket: &str,
    dst: &str,
    size: i64,
    replace: Option<&Headers>,
    multipart_from: i64,
) -> Result<(), String> {
    let source = utf8_percent_encode(&format!("{src_bucket}/{src}"), COPY_SOURCE_SET).to_string();
    if size < multipart_from {
        let mut req = client.copy_object().bucket(dst_bucket).key(dst).copy_source(source);
        if let Some(h) = replace {
            req = req
                .metadata_directive(MetadataDirective::Replace)
                .set_content_type(h.content_type.clone())
                .set_cache_control(h.cache_control.clone())
                .set_content_disposition(h.content_disposition.clone())
                .set_content_encoding(h.content_encoding.clone())
                .set_content_language(h.content_language.clone())
                .set_metadata(Some(h.metadata.clone()))
                .set_storage_class(h.storage_class.as_deref().map(StorageClass::from));
        }
        req.send().await.map_err(sdk_err)?;
        return Ok(());
    }
    let headers = match replace {
        Some(h) => h.clone(),
        None => Headers::of(&client.head_object().bucket(src_bucket).key(src).send().await.map_err(sdk_err)?),
    };
    let upload = client
        .create_multipart_upload()
        .bucket(dst_bucket)
        .key(dst)
        .set_content_type(headers.content_type)
        .set_cache_control(headers.cache_control)
        .set_content_disposition(headers.content_disposition)
        .set_content_encoding(headers.content_encoding)
        .set_content_language(headers.content_language)
        .set_metadata(Some(headers.metadata))
        .set_storage_class(headers.storage_class.as_deref().map(StorageClass::from))
        // CopyObject keeps the tags, a multipart upload starts without: set them again
        .set_tagging(crate::objects::tagging_header(client, src_bucket, src).await)
        .send()
        .await
        .map_err(sdk_err)?;
    let upload_id = upload.upload_id().unwrap_or_default().to_string();
    // aborted if the app quits meanwhile
    let _open = crate::multipart::OpenGuard::new(client, dst_bucket, dst, &upload_id);
    let result: Result<Vec<CompletedPart>, String> = async {
        let mut parts = Vec::new();
        let mut start = 0i64;
        let mut n = 1i32;
        while start < size {
            let end = (start + COPY_PART_SIZE).min(size) - 1;
            let r = client
                .upload_part_copy()
                .bucket(dst_bucket)
                .key(dst)
                .upload_id(&upload_id)
                .part_number(n)
                .copy_source(&source)
                .copy_source_range(format!("bytes={start}-{end}"))
                .send()
                .await
                .map_err(sdk_err)?;
            let etag = r
                .copy_part_result()
                .and_then(|c| c.e_tag())
                .map(|s| s.to_string());
            parts.push(CompletedPart::builder().set_e_tag(etag).part_number(n).build());
            start = end + 1;
            n += 1;
        }
        Ok(parts)
    }
    .await;
    match result {
        Ok(parts) => {
            client
                .complete_multipart_upload()
                .bucket(dst_bucket)
                .key(dst)
                .upload_id(&upload_id)
                .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
                .send()
                .await
                .map_err(sdk_err)?;
            Ok(())
        }
        Err(e) => {
            let _ = client
                .abort_multipart_upload()
                .bucket(dst_bucket)
                .key(dst)
                .upload_id(&upload_id)
                .send()
                .await;
            Err(e)
        }
    }
}

/// Copies or moves one object, or a whole prefix ("folder"), inside a bucket.
/// For a move the sources are only deleted after every copy succeeded.
/// Error text of an operation the user stopped; the UI shows it as "Cancelled", not as a failure.
pub(crate) const CANCELLED: &str = storage::CANCELLED;

/// How many objects are copied at once. Kept modest so busy buckets aren't throttled.
const COPY_CONCURRENCY: usize = 8;
/// Originals are deleted in batches as their copies complete (one DeleteObjects call each).
const DELETE_BATCH: usize = 1000;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoveItem {
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) is_prefix: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveProgress {
    pub(crate) op_id: String,
    /// listing | copying | deleting
    pub(crate) phase: &'static str,
    pub(crate) done: u64,
    pub(crate) total: u64,
    pub(crate) bytes: u64,
    pub(crate) total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    /// objects copied (and, for a move, removed from the old place)
    pub(crate) done: u64,
    pub(crate) total: u64,
    /// set when it stopped early; everything not counted in `done` is untouched
    pub(crate) error: Option<String>,
}

/// Copies (and optionally deletes the originals of) objects and whole folders, within `bucket`
/// or into `dest_bucket` on the same connection.
/// S3 has no rename, so a move is a server-side copy of every object followed by a delete.
/// Originals are only ever deleted after their own copy succeeded.
#[allow(clippy::too_many_arguments)]
async fn copy_many<R: tauri::Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    bucket: &str,
    dest_bucket: Option<&str>,
    items: &[MoveItem],
    delete_source: bool,
    op_id: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> Result<OpResult, String> {
    let cancelled = || cancel.is_some_and(|c| c.load(Ordering::Relaxed));
    let emit = |phase: &'static str, done: u64, total: u64, bytes: u64, total_bytes: u64| {
        if let Some(id) = op_id {
            let _ = app.emit("move-progress", MoveProgress { op_id: id.to_string(), phase, done, total, bytes, total_bytes });
        }
    };

    let to_bucket = dest_bucket.filter(|b| !b.is_empty()).unwrap_or(bucket);
    let same_bucket = to_bucket == bucket;

    // 1. everything to copy
    let mut jobs: Vec<(String, String, i64)> = Vec::new();
    for it in items {
        if same_bucket && it.from == it.to {
            return Err("Source and destination are the same".into());
        }
        if it.is_prefix {
            if same_bucket && it.to.starts_with(&it.from) {
                return Err("Cannot copy a folder into itself".into());
            }
            for o in list_all(client, bucket, &it.from).await? {
                let rest = o.key[it.from.len()..].to_string();
                jobs.push((o.key.clone(), format!("{}{rest}", it.to), o.size));
            }
        } else {
            let h = client.head_object().bucket(bucket).key(&it.from).send().await.map_err(sdk_err)?;
            jobs.push((it.from.clone(), it.to.clone(), h.content_length().unwrap_or(0)));
        }
        emit("listing", 0, jobs.len() as u64, 0, 0);
    }
    let total = jobs.len() as u64;
    let total_bytes: u64 = jobs.iter().map(|j| j.2.max(0) as u64).sum();
    emit("copying", 0, total, 0, total_bytes);

    // 2. copy with limited parallelism, deleting originals batch by batch
    let mut set = tokio::task::JoinSet::new();
    let mut queue = jobs.into_iter();
    let mut pending_delete: Vec<String> = Vec::new();
    let (mut done, mut bytes) = (0u64, 0u64);
    let mut error: Option<String> = None;
    let mut last_emit = std::time::Instant::now();
    loop {
        if error.is_none() && cancelled() {
            error = Some(CANCELLED.into());
        }
        while error.is_none() && set.len() < COPY_CONCURRENCY {
            let Some((src, dst, size)) = queue.next() else { break };
            let (client, bucket, to_bucket) = (client.clone(), bucket.to_string(), to_bucket.to_string());
            set.spawn(async move {
                let r = copy_object(&client, &bucket, &src, &to_bucket, &dst, size, None).await;
                (src, size, r)
            });
        }
        let Some(joined) = set.join_next().await else { break };
        match joined {
            Ok((src, size, Ok(()))) => {
                done += 1;
                bytes += size.max(0) as u64;
                if delete_source {
                    pending_delete.push(src);
                }
            }
            Ok((src, _, Err(e))) => {
                error.get_or_insert(format!("{src}: {e}"));
            }
            Err(e) => {
                error.get_or_insert(e.to_string());
            }
        }
        if pending_delete.len() >= DELETE_BATCH {
            if let Err(e) = delete_keys(client, bucket, &pending_delete).await {
                error.get_or_insert(format!("Copied, but removing the originals failed: {e}"));
            }
            pending_delete.clear();
        }
        if last_emit.elapsed() > Duration::from_millis(200) {
            emit("copying", done, total, bytes, total_bytes);
            last_emit = std::time::Instant::now();
        }
    }
    if !pending_delete.is_empty() {
        if let Err(e) = delete_keys(client, bucket, &pending_delete).await {
            error.get_or_insert(format!("Copied, but removing the originals failed: {e}"));
        }
    }
    emit("copying", done, total, bytes, total_bytes);
    Ok(OpResult { done, total, error })
}

/// Single item copy/move (rename). Kept for simple callers; fails if anything failed.
#[tauri::command]
pub async fn copy_or_move(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    from: String,
    to: String,
    is_prefix: bool,
    delete_source: bool,
) -> Result<u64, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::copy_or_move(&app, &*s, &bucket, from, to, is_prefix, delete_source).await,
    };
    let r = copy_many(&app, &client, &bucket, None, &[MoveItem { from, to, is_prefix }], delete_source, None, None).await?;
    match r.error {
        Some(e) if r.done > 0 => Err(format!("{e} ({} of {} objects were done before it stopped)", r.done, r.total)),
        Some(e) => Err(e),
        None => Ok(r.done),
    }
}

/// Moves or copies several items in one go, reporting `move-progress` events tagged with `op_id`.
/// With `dest_bucket` the copies land in that bucket (same connection, still server-side).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn move_many(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    items: Vec<MoveItem>,
    delete_source: bool,
    op_id: String,
    dest_bucket: Option<String>,
) -> Result<OpResult, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::move_many(&app, &state, &*s, &bucket, items, delete_source, op_id, dest_bucket).await,
    };
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    let _job = Job::start();
    let r = copy_many(&app, &client, &bucket, dest_bucket.as_deref(), &items, delete_source, Some(&op_id), Some(&flag)).await;
    state.cancels.lock().await.remove(&op_id);
    r
}

/// Bucket operations (move, copy, delete) running right now, for the quit prompt.
static JOBS: AtomicUsize = AtomicUsize::new(0);

#[cfg_attr(mobile, allow(dead_code))]
pub fn running_jobs() -> usize {
    JOBS.load(Ordering::Relaxed)
}

/// Counts one bucket operation while it lives.
pub(crate) struct Job;

impl Job {
    pub(crate) fn start() -> Self {
        JOBS.fetch_add(1, Ordering::Relaxed);
        Job
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        JOBS.fetch_sub(1, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- helpers for transfers

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    path: String,
    /// path relative to what the user picked/dropped, using '/' separators
    rel: String,
    size: u64,
}

/// Expands dropped/picked paths: files stay as they are, folders are walked recursively.
#[tauri::command]
pub fn expand_paths(paths: Vec<String>) -> Result<Vec<LocalFile>, String> {
    let mut out = Vec::new();
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        let meta = std::fs::metadata(&path).map_err(|e| format!("{p}: {e}"))?;
        if meta.is_file() {
            out.push(LocalFile {
                path: p.clone(),
                rel: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                size: meta.len(),
            });
        } else if meta.is_dir() {
            let base = path.parent().map(|b| b.to_path_buf()).unwrap_or_default();
            for entry in WalkDir::new(&path).follow_links(false).into_iter().filter_map(|e| e.ok()) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy();
                if name == ".DS_Store" {
                    continue;
                }
                let rel = entry
                    .path()
                    .strip_prefix(&base)
                    .map(|r| r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
                    .unwrap_or_else(|_| name.to_string());
                out.push(LocalFile {
                    path: entry.path().to_string_lossy().into_owned(),
                    rel,
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub(crate) key: String,
    pub(crate) size: i64,
}

#[tauri::command]
pub async fn list_all_under(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
) -> Result<Vec<RemoteFile>, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) => return generic::list_all_under(&*s, &bucket, &prefix).await,
    };
    Ok(list_all(&client, &bucket, &prefix)
        .await?
        .into_iter()
        .filter(|o| !o.key.ends_with('/'))
        .map(|o| RemoteFile { key: o.key, size: o.size })
        .collect())
}

/// Runs against a throwaway S3 server; see the sync tests for how to start one.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn groups_change_only_the_named_connections() {
        let p = |id: &str, g: Option<&str>| Profile { id: id.into(), name: id.into(), group: g.map(Into::into), ..Default::default() };
        let mut list = vec![p("a", None), p("b", Some("Old")), p("c", Some("Keep"))];
        let groups = std::collections::HashMap::from([("a".to_string(), Some(" Clients / Acme ".to_string())), ("b".to_string(), None), ("gone".to_string(), Some("X".to_string()))]);
        apply_groups(&mut list, &groups);
        let got: Vec<Option<&str>> = list.iter().map(|p| p.group.as_deref()).collect();
        assert_eq!(got, [Some("Clients/Acme"), None, Some("Keep")]);
        // "" is the top level too
        apply_groups(&mut list, &std::collections::HashMap::from([("a".to_string(), Some(" / ".to_string()))]));
        assert_eq!(list[0].group, None);
    }
    use tauri::{test::{mock_builder, mock_context, noop_assets}, Listener};

    #[test]
    fn search_streams_matches_and_stops_when_asked() {
        let Ok(endpoint) = std::env::var("KYBL_TEST_ENDPOINT") else { return };
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&p, "testsecret");
        tauri::async_runtime::block_on(async move {
            let base = format!("se-{}/", uuid::Uuid::new_v4());
            for k in ["Report.pdf", "sub/report-2.pdf", "photo.jpg"] {
                client
                    .put_object()
                    .bucket("testbucket")
                    .key(format!("{base}{k}"))
                    .body(aws_sdk_s3::primitives::ByteStream::from_static(b"x"))
                    .send()
                    .await
                    .unwrap();
            }
            let streamed = Mutex::new(Vec::<String>::new());
            let go = AtomicBool::new(false);
            let r = search_scan(&client, "testbucket", &base, "REPORT", 1000, 100, &go, |_, found| {
                streamed.lock().unwrap().extend(found.iter().map(|o| o.key.clone()));
            })
            .await
            .unwrap();
            assert_eq!(r.objects.len(), 2, "case-insensitive, in subfolders too");
            assert!(!r.truncated);
            assert_eq!(streamed.into_inner().unwrap().len(), 2, "every match also arrives as progress");
            let stop = AtomicBool::new(true);
            let r = search_scan(&client, "testbucket", &base, "report", 1000, 100, &stop, |_, _| {}).await.unwrap();
            assert!(r.truncated, "a stopped search says its results may be incomplete");
        });
    }

    #[test]
    fn folder_size_adds_up_everything_below() {
        let Ok(endpoint) = std::env::var("KYBL_TEST_ENDPOINT") else { return };
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&p, "testsecret");
        tauri::async_runtime::block_on(async move {
            let base = format!("sz-{}/", uuid::Uuid::new_v4());
            for (k, n) in [("a.txt", 100usize), ("sub/b.txt", 250), ("sub/deep/c.txt", 1000)] {
                client
                    .put_object()
                    .bucket("testbucket")
                    .key(format!("{base}{k}"))
                    .body(aws_sdk_s3::primitives::ByteStream::from(vec![b'x'; n]))
                    .send()
                    .await
                    .unwrap();
            }
            let mut pages = 0;
            // nested folders count: "sub/deep/c.txt" is inside "sub/", which is inside the base
            let (bytes, objects, kids) = prefix_size(&client, "testbucket", &base, None, |_, _| pages += 1).await.unwrap();
            assert_eq!((bytes, objects), (1350, 3));
            assert!(pages >= 1);
            // one direct subfolder, totalled over every depth below it
            assert_eq!(kids, vec![ChildSize { prefix: format!("{base}sub/"), bytes: 1250, objects: 2 }]);
            let (bytes, objects, kids) = prefix_size(&client, "testbucket", &format!("{base}sub/"), None, |_, _| {}).await.unwrap();
            assert_eq!((bytes, objects), (1250, 2));
            assert_eq!(kids, vec![ChildSize { prefix: format!("{base}sub/deep/"), bytes: 1000, objects: 1 }]);
            let none = prefix_size(&client, "testbucket", &format!("{base}nothing/"), None, |_, _| {}).await.unwrap();
            assert_eq!((none.0, none.1, none.2.len()), (0, 0, 0));
            let stop = AtomicBool::new(true);
            let err = prefix_size(&client, "testbucket", &base, Some(&stop), |_, _| {}).await.unwrap_err();
            assert_eq!(err, CANCELLED);
        });
    }

    /// Needs a multipart-capable server (`KYBL_TEST_MULTIPART_ENDPOINT`, e.g. adobe/s3mock):
    /// the part-by-part copy keeps the source's headers and metadata, across buckets too, and
    /// rewriting headers in place works on both paths.
    #[test]
    fn copies_keep_headers_and_props_can_be_replaced() {
        let Ok(endpoint) = std::env::var("KYBL_TEST_MULTIPART_ENDPOINT") else {
            return eprintln!("skipped: KYBL_TEST_MULTIPART_ENDPOINT not set");
        };
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&p, "testsecret");
        tauri::async_runtime::block_on(async move {
            let other = format!("other-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            client.create_bucket().bucket(&other).send().await.unwrap();
            let base = format!("cp-{}/", uuid::Uuid::new_v4());
            let src = format!("{base}photo.jpg");
            client
                .put_object()
                .bucket("testbucket")
                .key(&src)
                .content_type("image/jpeg")
                .cache_control("max-age=300")
                .content_disposition("inline")
                .metadata("owner", "me")
                .body(aws_sdk_s3::primitives::ByteStream::from(vec![7u8; 1000]))
                .send()
                .await
                .unwrap();
            let copies = [
                ("testbucket", format!("{base}big-copy.jpg"), 0),
                (other.as_str(), src.clone(), 0),
                ("testbucket", format!("{base}small-copy.jpg"), i64::MAX),
            ];
            for (bucket, dst, from) in copies {
                copy_object_from(&client, "testbucket", &src, bucket, &dst, 1000, None, from).await.unwrap();
                let h = client.head_object().bucket(bucket).key(&dst).send().await.unwrap();
                assert_eq!(h.content_type(), Some("image/jpeg"), "{bucket}/{dst}");
                assert_eq!(h.cache_control(), Some("max-age=300"), "{bucket}/{dst}");
                assert_eq!(h.content_disposition(), Some("inline"), "{bucket}/{dst}");
                assert_eq!(h.metadata().and_then(|m| m.get("owner")).map(String::as_str), Some("me"), "{bucket}/{dst}");
                assert_eq!(h.content_length(), Some(1000));
            }
            // replacing headers in place, both ways
            for from in [i64::MAX, 0] {
                let head = client.head_object().bucket("testbucket").key(&src).send().await.unwrap();
                let mut next = Headers::of(&head);
                next.content_type = Some(format!("text/plain-{from}"));
                next.cache_control = None;
                next.metadata = HashMap::from([("team".to_string(), "ops".to_string())]);
                copy_object_from(&client, "testbucket", &src, "testbucket", &src, 1000, Some(&next), from).await.unwrap();
                let h = client.head_object().bucket("testbucket").key(&src).send().await.unwrap();
                // s3mock keeps the old Content-Type on CopyObject even with REPLACE (real S3,
                // MinIO and Ceph set it), so only the part-by-part path is checked for it here
                if from == 0 {
                    assert_eq!(h.content_type(), Some(format!("text/plain-{from}").as_str()));
                }
                assert_eq!(h.cache_control(), None, "{from}");
                assert_eq!(h.metadata().cloned().unwrap_or_default(), HashMap::from([("team".to_string(), "ops".to_string())]));
                assert_eq!(h.content_length(), Some(1000), "the content is untouched");
            }
        });
    }

    #[test]
    fn move_folder_in_parallel_with_progress() {
        let Ok(endpoint) = std::env::var("KYBL_TEST_ENDPOINT") else { return };
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&p, "testsecret");
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let ev = events.clone();
        app.listen_any("move-progress", move |e| ev.lock().unwrap().push(e.payload().to_string()));
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let base = format!("mv-{}/", uuid::Uuid::new_v4());
            for i in 0..40 {
                client
                    .put_object()
                    .bucket("testbucket")
                    .key(format!("{base}src/f{i:02}.txt"))
                    .body(aws_sdk_s3::primitives::ByteStream::from(vec![b'x'; 1000 + i]))
                    .send()
                    .await
                    .unwrap();
            }
            let items = [MoveItem { from: format!("{base}src/"), to: format!("{base}dst/src/"), is_prefix: true }];
            let r = copy_many(&h, &client, "testbucket", None, &items, true, Some("op1"), None).await.unwrap();
            assert!(r.error.is_none(), "{:?}", r.error);
            assert_eq!((r.done, r.total), (40, 40));
            let left = list_all(&client, "testbucket", &format!("{base}src/")).await.unwrap();
            assert!(left.is_empty(), "originals should be gone");
            let moved = list_all(&client, "testbucket", &format!("{base}dst/src/")).await.unwrap();
            assert_eq!(moved.len(), 40);
            assert!(moved.iter().any(|o| o.key.ends_with("f39.txt") && o.size == 1039));

            // into itself is refused before anything happens
            let bad = [MoveItem { from: format!("{base}dst/"), to: format!("{base}dst/inner/"), is_prefix: true }];
            assert!(copy_many(&h, &client, "testbucket", None, &bad, true, None, None).await.is_err());

            // a cancelled move stops before copying anything and leaves the originals alone
            let stop = AtomicBool::new(true);
            let back = [MoveItem { from: format!("{base}dst/src/"), to: format!("{base}back/"), is_prefix: true }];
            let r = copy_many(&h, &client, "testbucket", None, &back, true, None, Some(&stop)).await.unwrap();
            assert_eq!(r.error.as_deref(), Some(CANCELLED));
            assert_eq!(r.done, 0);
            assert_eq!(list_all(&client, "testbucket", &format!("{base}dst/src/")).await.unwrap().len(), 40);
        });
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|e| e.contains(r#""phase":"copying""#) && e.contains(r#""done":40"#)), "{ev:?}");
    }
}
