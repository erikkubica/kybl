use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use aws_sdk_s3::{
    presigning::PresigningConfig,
    primitives::DateTime,
    types::{CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier},
    Client,
};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

use crate::state::{
    build_client, client_for, delete_secret, err, get_secret, load_profiles, save_profiles, sdk_err, set_secret,
    AppState,
    Profile,
};

const COPY_SOURCE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// Objects above this size are copied with multipart copy (CopyObject tops out at 5 GiB).
const MULTIPART_COPY_THRESHOLD: i64 = 4 * 1024 * 1024 * 1024;
const COPY_PART_SIZE: i64 = 512 * 1024 * 1024;

fn millis(d: Option<&DateTime>) -> Option<i64> {
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
    if let Some(s) = secret.as_deref().filter(|s| !s.is_empty()) {
        set_secret(&state, &profile.id, s).await?;
    } else if get_secret(&state, &profile.id).await?.is_none() {
        return Err("A secret key is required for a new connection".into());
    }
    let mut profiles = load_profiles(&app)?;
    match profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile.clone(),
        None => profiles.push(profile.clone()),
    }
    save_profiles(&app, &profiles)?;
    state.clients.lock().await.remove(&profile.id);
    Ok(profile)
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
    Ok(())
}

/// Tries the connection with the given (possibly unsaved) settings.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    profile: Profile,
    secret: Option<String>,
) -> Result<String, String> {
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
    name: String,
    created: Option<i64>,
}

#[tauri::command]
pub async fn list_buckets(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<BucketInfo>, String> {
    let client = client_for(&app, &state, &profile_id).await?;
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObjInfo {
    pub(crate) key: String,
    pub(crate) size: i64,
    pub(crate) modified: Option<i64>,
    pub(crate) etag: Option<String>,
    storage_class: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    folders: Vec<String>,
    objects: Vec<ObjInfo>,
    next_token: Option<String>,
}

fn obj_info(o: &aws_sdk_s3::types::Object) -> ObjInfo {
    ObjInfo {
        key: o.key().unwrap_or_default().to_string(),
        size: o.size().unwrap_or(0),
        modified: millis(o.last_modified()),
        etag: o.e_tag().map(|e| e.trim_matches('"').to_string()),
        storage_class: o.storage_class().map(|s| s.as_str().to_string()),
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
    let client = client_for(&app, &state, &profile_id).await?;
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
const MAX_CHILDREN: usize = 5000;

/// Size of one direct subfolder, including everything nested below it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChildSize {
    prefix: String,
    bytes: u64,
    objects: u64,
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
        let out = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(token.take())
            .send()
            .await
            .map_err(sdk_err)?;
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
    bytes: u64,
    objects: u64,
    children: Vec<ChildSize>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SizeProgress {
    op_id: String,
    bytes: u64,
    objects: u64,
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
    let client = client_for(&app, &state, &profile_id).await?;
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    let result = prefix_size(&client, &bucket, &prefix, Some(&flag), |bytes, objects| {
        let _ = app.emit("size-progress", SizeProgress { op_id: op_id.clone(), bytes, objects });
    })
    .await;
    state.cancels.lock().await.remove(&op_id);
    result.map(|(bytes, objects, children)| FolderSize { bytes, objects, children })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    objects: Vec<ObjInfo>,
    scanned: u64,
    /// true when the scan stopped early (limit reached) so results may be incomplete
    truncated: bool,
}

/// Recursive, case-insensitive "contains" search over the keys below `prefix`.
#[tauri::command]
pub async fn search_objects(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
    query: String,
) -> Result<SearchResult, String> {
    const MAX_SCAN: u64 = 300_000;
    const MAX_RESULTS: usize = 500;
    let client = client_for(&app, &state, &profile_id).await?;
    let needle = query.to_lowercase();
    let mut found: Vec<ObjInfo> = Vec::new();
    let mut scanned = 0u64;
    let mut token: Option<String> = None;
    let mut truncated = false;
    'pages: loop {
        let out = client
            .list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .set_continuation_token(token.take())
            .send()
            .await
            .map_err(sdk_err)?;
        for o in out.contents() {
            scanned += 1;
            let key = o.key().unwrap_or_default();
            if key.ends_with('/') {
                continue;
            }
            if key[prefix.len().min(key.len())..].to_lowercase().contains(&needle) {
                found.push(obj_info(o));
                if found.len() >= MAX_RESULTS {
                    truncated = true;
                    break 'pages;
                }
            }
        }
        if scanned >= MAX_SCAN {
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
    key: String,
    size: i64,
    content_type: Option<String>,
    modified: Option<i64>,
    etag: Option<String>,
    storage_class: Option<String>,
    metadata: HashMap<String, String>,
}

#[tauri::command]
pub async fn head_object(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
) -> Result<ObjectDetails, String> {
    let client = client_for(&app, &state, &profile_id).await?;
    let h = client
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(sdk_err)?;
    Ok(ObjectDetails {
        key,
        size: h.content_length().unwrap_or(0),
        content_type: h.content_type().map(|s| s.to_string()),
        modified: millis(h.last_modified()),
        etag: h.e_tag().map(|e| e.trim_matches('"').to_string()),
        storage_class: h.storage_class().map(|s| s.as_str().to_string()),
        metadata: h.metadata().cloned().unwrap_or_default(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    text: String,
    truncated: bool,
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
    let client = client_for(&app, &state, &profile_id).await?;
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
/// itself, like PDFs. Refuses anything over `max_bytes` instead of loading it.
#[tauri::command]
pub async fn get_object_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    key: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let client = client_for(&app, &state, &profile_id).await?;
    let mut out = client.get_object().bucket(&bucket).key(&key).send().await.map_err(sdk_err)?;
    let len = out.content_length().unwrap_or(0).max(0) as u64;
    if len > max_bytes {
        return Err("This file is too large to preview.".into());
    }
    // sized up front: growing by doubling would briefly need up to twice the file
    let mut buf: Vec<u8> = Vec::with_capacity(len as usize);
    while let Some(chunk) = out.body.try_next().await.map_err(err)? {
        buf.extend_from_slice(&chunk);
        if buf.len() as u64 > max_bytes {
            return Err("This file is too large to preview.".into());
        }
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
    let client = client_for(&app, &state, &profile_id).await?;
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
    let client = client_for(&app, &state, &profile_id).await?;
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

async fn delete_keys(client: &Client, bucket: &str, keys: &[String]) -> Result<(), String> {
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
    let client = client_for(&app, &state, &profile_id).await?;
    let op = op_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op.clone(), flag.clone());
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

async fn copy_one(
    client: &Client,
    bucket: &str,
    src: &str,
    dst: &str,
    size: i64,
) -> Result<(), String> {
    let source = utf8_percent_encode(&format!("{bucket}/{src}"), COPY_SOURCE_SET).to_string();
    if size < MULTIPART_COPY_THRESHOLD {
        client
            .copy_object()
            .bucket(bucket)
            .key(dst)
            .copy_source(source)
            .send()
            .await
            .map_err(sdk_err)?;
        return Ok(());
    }
    let upload = client
        .create_multipart_upload()
        .bucket(bucket)
        .key(dst)
        .send()
        .await
        .map_err(sdk_err)?;
    let upload_id = upload.upload_id().unwrap_or_default().to_string();
    let result: Result<Vec<CompletedPart>, String> = async {
        let mut parts = Vec::new();
        let mut start = 0i64;
        let mut n = 1i32;
        while start < size {
            let end = (start + COPY_PART_SIZE).min(size) - 1;
            let r = client
                .upload_part_copy()
                .bucket(bucket)
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
                .bucket(bucket)
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
                .bucket(bucket)
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
const CANCELLED: &str = "Cancelled";

/// How many objects are copied at once. Kept modest so busy buckets aren't throttled.
const COPY_CONCURRENCY: usize = 8;
/// Originals are deleted in batches as their copies complete (one DeleteObjects call each).
const DELETE_BATCH: usize = 1000;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoveItem {
    from: String,
    to: String,
    is_prefix: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MoveProgress {
    op_id: String,
    /// listing | copying | deleting
    phase: &'static str,
    done: u64,
    total: u64,
    bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    /// objects copied (and, for a move, removed from the old place)
    done: u64,
    total: u64,
    /// set when it stopped early; everything not counted in `done` is untouched
    error: Option<String>,
}

/// Copies (and optionally deletes the originals of) objects and whole folders within a bucket.
/// S3 has no rename, so a move is a server-side copy of every object followed by a delete.
/// Originals are only ever deleted after their own copy succeeded.
async fn copy_many<R: tauri::Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    bucket: &str,
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

    // 1. everything to copy
    let mut jobs: Vec<(String, String, i64)> = Vec::new();
    for it in items {
        if it.from == it.to {
            return Err("Source and destination are the same".into());
        }
        if it.is_prefix {
            if it.to.starts_with(&it.from) {
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
            let (client, bucket) = (client.clone(), bucket.to_string());
            set.spawn(async move {
                let r = copy_one(&client, &bucket, &src, &dst, size).await;
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
    let client = client_for(&app, &state, &profile_id).await?;
    let r = copy_many(&app, &client, &bucket, &[MoveItem { from, to, is_prefix }], delete_source, None, None).await?;
    match r.error {
        Some(e) if r.done > 0 => Err(format!("{e} ({} of {} objects were done before it stopped)", r.done, r.total)),
        Some(e) => Err(e),
        None => Ok(r.done),
    }
}

/// Moves or copies several items in one go, reporting `move-progress` events tagged with `op_id`.
#[tauri::command]
pub async fn move_many(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    items: Vec<MoveItem>,
    delete_source: bool,
    op_id: String,
) -> Result<OpResult, String> {
    let client = client_for(&app, &state, &profile_id).await?;
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    let r = copy_many(&app, &client, &bucket, &items, delete_source, Some(&op_id), Some(&flag)).await;
    state.cancels.lock().await.remove(&op_id);
    r
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
    key: String,
    size: i64,
}

#[tauri::command]
pub async fn list_all_under(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
) -> Result<Vec<RemoteFile>, String> {
    let client = client_for(&app, &state, &profile_id).await?;
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
    use tauri::{test::{mock_builder, mock_context, noop_assets}, Listener};

    #[test]
    fn folder_size_adds_up_everything_below() {
        let Ok(endpoint) = std::env::var("S3B_TEST_ENDPOINT") else { return };
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
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

    #[test]
    fn move_folder_in_parallel_with_progress() {
        let Ok(endpoint) = std::env::var("S3B_TEST_ENDPOINT") else { return };
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
            let r = copy_many(&h, &client, "testbucket", &items, true, Some("op1"), None).await.unwrap();
            assert!(r.error.is_none(), "{:?}", r.error);
            assert_eq!((r.done, r.total), (40, 40));
            let left = list_all(&client, "testbucket", &format!("{base}src/")).await.unwrap();
            assert!(left.is_empty(), "originals should be gone");
            let moved = list_all(&client, "testbucket", &format!("{base}dst/src/")).await.unwrap();
            assert_eq!(moved.len(), 40);
            assert!(moved.iter().any(|o| o.key.ends_with("f39.txt") && o.size == 1039));

            // into itself is refused before anything happens
            let bad = [MoveItem { from: format!("{base}dst/"), to: format!("{base}dst/inner/"), is_prefix: true }];
            assert!(copy_many(&h, &client, "testbucket", &bad, true, None, None).await.is_err());

            // a cancelled move stops before copying anything and leaves the originals alone
            let stop = AtomicBool::new(true);
            let back = [MoveItem { from: format!("{base}dst/src/"), to: format!("{base}back/"), is_prefix: true }];
            let r = copy_many(&h, &client, "testbucket", &back, true, None, Some(&stop)).await.unwrap();
            assert_eq!(r.error.as_deref(), Some(CANCELLED));
            assert_eq!(r.done, 0);
            assert_eq!(list_all(&client, "testbucket", &format!("{base}dst/src/")).await.unwrap().len(), 40);
        });
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|e| e.contains(r#""phase":"copying""#) && e.contains(r#""done":40"#)), "{ev:?}");
    }
}
