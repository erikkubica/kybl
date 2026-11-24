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
    build_client, err, get_secret, load_profiles, lock_profiles, save_profiles, sdk_err, set_secret,
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
    clear_secret: Option<bool>,
) -> Result<Profile, String> {
    let was_new = profile.id.is_empty();
    if was_new {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    profile.group = profile.group.as_deref().and_then(crate::state::normalize_group);
    // SSH tunnels: only over SFTP, each checked
    if let Some(net) = profile.net.as_mut() {
        if profile.kind == ConnKind::Sftp {
            crate::tunnels::tidy(&mut net.tunnels)?;
        } else {
            net.tunnels.clear();
        }
    }
    // reserved for this device's own folders, which are never a saved connection
    if profile.id == registry::LOCAL_ID {
        return Err("This connection can't be changed.".into());
    }
    // held for the whole save: what the vault held before, the change, the list save and an undo
    // all belong to this save, never to another one of the same connection (S3-4)
    let held = lock_profiles().await;
    let mut profiles = load_profiles(&app)?;
    let saved = profiles.iter().find(|p| p.id == profile.id).cloned();
    // SFTP key sign-in: a passphrase alone goes with the key already saved (an imported key file
    // that has one), under the name the key is read from
    let mut secret = secret;
    let mut secret_name = profile.id.clone();
    let key_auth = profile.kind == ConnKind::Sftp && profile.net.as_ref().is_some_and(|n| n.auth == crate::state::NetAuth::Key);
    if let Some(pass) = secret.as_deref().filter(|_| key_auth).and_then(storage::net::SshKey::passphrase_only) {
        let ssh = crate::state::secret_key(&profile.id, "ssh");
        let (name, stored) = match get_secret(&state, &ssh).await? {
            Some(s) => (ssh, Some(s)),
            None => (profile.id.clone(), get_secret(&state, &profile.id).await?),
        };
        let merged = stored
            .as_deref()
            .and_then(|s| storage::net::SshKey::with_passphrase(s, &pass))
            .ok_or_else(|| "There is no saved key to add the passphrase to. Choose the key file again.".to_string())?;
        secret = Some(merged);
        secret_name = name;
    } else if key_auth && secret.as_deref().is_some_and(|s| !s.is_empty()) {
        // a whole new key goes where the key is read from: a connection saved by an older build
        // keeps its key under `#ssh`, which is read before the bare id, so writing to the id
        // would leave the old key in use
        let ssh = crate::state::secret_key(&profile.id, "ssh");
        if get_secret(&state, &ssh).await?.is_some() {
            secret_name = ssh;
        }
    }
    // what the vault held before this save changed it, and what it left there, to put back if
    // the list can't be saved (an unreadable "before", a refused keychain prompt: nothing is)
    let mut undo: Option<(Option<String>, Option<String>)> = None;
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        let before = get_secret(&state, &secret_name).await.ok();
        set_secret(&state, &secret_name, &s).await?;
        undo = before.map(|b| (b, Some(s)));
    } else if clear_secret.unwrap_or(false) && matches!(profile.kind, ConnKind::Ftp | ConnKind::Webdav) {
        // "Remove saved password": the server takes an anonymous / password-less sign-in now
        let before = get_secret(&state, &profile.id).await.ok();
        crate::state::remove_main_secret(&state, &profile.id).await?;
        undo = before.map(|b| (b, None));
    } else if profile.kind == ConnKind::S3 && get_secret(&state, &profile.id).await?.is_none() {
        return Err("A secret key is required for a new connection".into());
    } else if password_moved(&state, saved.as_ref(), &profile).await? {
        return Err(PASSWORD_AGAIN.into());
    }
    match profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile.clone(),
        None => profiles.push(profile.clone()),
    }
    if let Err(e) = save_profiles(&app, &profiles, &held) {
        // a new connection's secrets all go; an edited one gets its old secret back
        let e = if was_new {
            forget_unsaved(&state, &profile.id, true, e).await
        } else {
            if let Some((before, wrote)) = undo {
                crate::state::undo_secret(&state, &secret_name, wrote.as_deref(), before).await;
            }
            e
        };
        return Err(e);
    }
    drop(held);
    state.clients.lock().await.remove(&profile.id);
    registry::forget(&profile.id);
    #[cfg(desktop)]
    crate::tunnels::run::connection_changed(&app, &profile.id, Some(&profile));
    // the connection may point somewhere else now (another endpoint or account)
    crate::filecache::forget_profile(&app, &profile.id).await;
    Ok(profile)
}

/// A saved password is never sent to another server or user (S3-3).
const PASSWORD_AGAIN: &str = "Enter the password again. A saved password isn't sent to a new server or user name.";

/// Where a connection's saved secret is sent: the server it connects to, the way it connects
/// (TLS or plain) and, for passwords, the user name. Built from the same functions the connection
/// itself uses, so a port typed into the host field, a `dav://` address (plain http) or a switch
/// from TLS to plain count as a new place (S-4, B3-6). `None`: no secret that could be sent
/// anywhere new (SFTP with a key or the agent, which only sign, and the other kinds, whose
/// secrets only sign). An Azure SAS token or a Google service account key is the credential
/// itself and goes to the endpoint, so those kinds follow the same rule (S-3).
pub(crate) fn password_target(p: &Profile) -> Option<String> {
    use crate::storage::net::socket_addr;
    if matches!(p.kind, ConnKind::Azblob | ConnKind::Gcs) {
        let b = p.blob.as_ref()?;
        let place = blob_origin(p.kind, b);
        return Some(if p.kind == ConnKind::Azblob { format!("{place}|{}", b.account.trim().to_lowercase()) } else { place });
    }
    let n = p.net.as_ref()?;
    let place = match p.kind {
        ConnKind::Ftp => {
            let (host, port) = socket_addr(n, if n.tls == crate::state::TlsMode::Implicit { 990 } else { 21 });
            // "Auto" falls back to plain FTP, so it is no better than plain for a password
            let secure = matches!(n.tls, crate::state::TlsMode::Explicit | crate::state::TlsMode::Implicit);
            format!("{}:{}:{port}", if secure { "tls" } else { "plain" }, host.to_lowercase())
        }
        ConnKind::Sftp if n.auth == crate::state::NetAuth::Password => {
            let (host, port) = socket_addr(n, 22);
            format!("{}:{port}", host.to_lowercase())
        }
        ConnKind::Webdav => dav_origin(n),
        _ => return None,
    };
    Some(format!("{place}|{}", n.user.trim()))
}

/// `scheme://host:port` of a URL, the default port spelled out; `None` when it isn't a URL.
fn url_origin(raw: &str) -> Option<String> {
    let u = reqwest::Url::parse(raw.trim()).ok()?;
    Some(format!("{}://{}:{}", u.scheme(), u.host_str()?.to_lowercase(), u.port_or_known_default()?))
}

/// The server an Azure or Google Cloud Storage connection talks to (its endpoint, or the
/// service's own address when none is set).
fn blob_origin(kind: ConnKind, b: &crate::state::BlobConfig) -> String {
    let ep = b.endpoint.trim();
    let default = if kind == ConnKind::Azblob { format!("https://{}.blob.core.windows.net", b.account.trim()) } else { "https://storage.googleapis.com".to_string() };
    let ep = if ep.is_empty() { default.as_str() } else { ep };
    url_origin(ep).unwrap_or_else(|| ep.trim_end_matches('/').to_lowercase())
}

/// A WebDAV connection's server as the connection reaches it: scheme, host and port of the first
/// address it tries (`dav://` and `webdav://` are plain http there, `davs://` is https).
fn dav_origin(n: &crate::state::NetConfig) -> String {
    if let Some(u) = crate::storage::webdav::candidate_urls(n).ok().and_then(|c| c.into_iter().next()) {
        if let Some(o) = url_origin(u.as_str()) {
            return o;
        }
    }
    n.url.as_deref().unwrap_or(&n.host).trim().to_lowercase()
}

/// Whether `now`, an edit of the saved connection `saved`, would send its saved password to
/// another server or user name (a new connection has none to send).
async fn password_moved(state: &AppState, saved: Option<&Profile>, now: &Profile) -> Result<bool, String> {
    let Some(target) = password_target(now) else { return Ok(false) };
    let Some(saved) = saved else { return Ok(false) };
    if password_target(saved).as_deref() == Some(target.as_str()) {
        return Ok(false);
    }
    Ok(get_secret(state, &now.id).await?.is_some_and(|s| !s.is_empty()))
}

/// Whether a saved connection has a password (main secret) in the vault, so its form can say
/// "Unchanged" only when there is one.
#[tauri::command]
pub async fn profile_has_secret(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    if get_secret(&state, &id).await?.is_some_and(|s| !s.is_empty()) {
        return Ok(true);
    }
    // an SFTP key saved by older versions
    Ok(get_secret(&state, &crate::state::secret_key(&id, "ssh")).await?.is_some_and(|s| !s.is_empty()))
}

/// Files connections under sidebar groups (`None` or "": the top level), by id. Only the group
/// changes: unlike `save_profile`, the connections keep their open clients and cached files.
#[tauri::command]
pub async fn set_profile_groups(app: AppHandle, groups: std::collections::HashMap<String, Option<String>>) -> Result<Vec<Profile>, String> {
    let held = lock_profiles().await;
    let mut profiles = load_profiles(&app)?;
    apply_groups(&mut profiles, &groups);
    save_profiles(&app, &profiles, &held)?;
    Ok(profiles)
}

fn apply_groups(profiles: &mut [Profile], groups: &std::collections::HashMap<String, Option<String>>) {
    for p in profiles.iter_mut() {
        if let Some(g) = groups.get(&p.id) {
            p.group = g.as_deref().and_then(crate::state::normalize_group);
        }
    }
}

/// Deletes a connection. Once it is out of the saved list everything else of it goes, whatever
/// fails: an error from then on would leave a connection that can't be deleted again with its
/// tunnels, open client and cached files still there (B3-1). Its id is noted for secret removal
/// before the list loses it, so a crash in between still removes its secrets at the next start
/// (S3-1). Secrets that can't be removed now: the answer is a note saying so (`None`: all gone).
#[tauri::command]
pub async fn delete_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    // its drives first: one with saves that couldn't be moved out keeps the connection too
    #[cfg(desktop)]
    crate::mount::forget_profile(&app, &id).await?;
    let held = lock_profiles().await;
    let mut profiles = load_profiles(&app)?;
    let kind = profiles.iter().find(|p| p.id == id).map(|p| p.kind);
    let queued = crate::state::remember_left_secrets(&state, &id);
    if let Err(e) = &queued {
        eprintln!("kybl: couldn't note a connection's secrets for removal: {e}");
    }
    profiles.retain(|p| p.id != id);
    if let Err(e) = save_profiles(&app, &profiles, &held) {
        // still saved: its secrets stay
        if queued.is_ok() {
            crate::state::unremember_left_secrets(&state, &id);
        }
        return Err(e);
    }
    drop(held);
    state.clients.lock().await.remove(&id);
    registry::forget(&id);
    #[cfg(desktop)]
    crate::tunnels::run::connection_changed(&app, &id, None);
    // files of a deleted connection don't stay on this computer, thumbnails included
    crate::filecache::forget_profile(&app, &id).await;
    crate::thumbs::forget_profile(&app, &id, kind).await;
    crate::placeholders::forget_profile(&id);
    Ok(crate::state::finish_forgetting(&state, &id, queued.is_ok()).await.err().map(left_secrets_note))
}

/// What the page says when a deleted connection's secrets are still stored.
fn left_secrets_note(left: crate::state::LeftSecrets) -> String {
    let then = if left.queued {
        "Kybl removes it the next time it starts."
    } else {
        "Kybl couldn't note it for later either, so it stays in Kybl's encrypted secret store."
    };
    format!("The connection was deleted, but its saved password or sign-in couldn't be removed yet. {then}\n\n{}", left.error)
}

/// A new connection whose save failed after its secret was stored: the secret goes too (now, or
/// at the next start), so nothing of it is left in the vault. Answers the save's error `e`, with
/// a word added when the secret stays for good.
pub(crate) async fn forget_unsaved(state: &AppState, id: &str, was_new: bool, e: String) -> String {
    if !was_new {
        return e;
    }
    match crate::state::forget_secrets_of_gone(state, id).await {
        Err(left) if !left.queued => {
            let (say, details) = e.split_once("\n\n").unwrap_or((e.as_str(), ""));
            let more = if details.is_empty() { left.error } else { format!("{details}\n{}", left.error) };
            format!("{say} The password or sign-in stored for it couldn't be removed either.\n\n{more}")
        }
        _ => e,
    }
}

/// Tries the connection with the given (possibly unsaved) settings. `clear_secret` (FTP and
/// WebDAV, "Remove saved password"): sign in without the saved password, as Save will leave it.
#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: Profile,
    secret: Option<String>,
    clear_secret: Option<bool>,
) -> Result<String, String> {
    if profile.kind != ConnKind::S3 {
        let no_password = clear_secret.unwrap_or(false) && matches!(profile.kind, ConnKind::Ftp | ConnKind::Webdav);
        let typed = secret.as_deref().is_some_and(|s| !s.is_empty());
        let s = if no_password && !typed {
            registry::build_without_password(&profile)?
        } else {
            // the saved password only for the server and user it was saved for (S3-3)
            if !typed && !profile.id.is_empty() {
                let saved = load_profiles(&app)?.into_iter().find(|p| p.id == profile.id);
                if password_moved(&state, saved.as_ref(), &profile).await? {
                    return Err(PASSWORD_AGAIN.into());
                }
            }
            registry::build(&app, &state, &profile, secret).await?
        };
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
    /// what the store says about some of `folders` (permissions, link targets); servers only
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) folder_info: Vec<ObjInfo>,
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
        folder_info: vec![],
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
            let listed = list_all(client, bucket, &it.from).await?;
            // onto a folder it is inside (`a/b/b/` to `a/b/`) is fine until a copy would land on
            // one of the folder's own files (`a/b/b/b/x` to `a/b/b/x`): it would be overwritten
            // before it is read, and a move would then delete it
            if same_bucket && it.from.starts_with(&it.to) {
                let sources: std::collections::HashSet<&str> = listed.iter().map(|o| o.key.as_str()).collect();
                if listed.iter().any(|o| sources.contains(format!("{}{}", it.to, &o.key[it.from.len()..]).as_str())) {
                    return Err("Can't copy a folder over a folder it is inside".into());
                }
            }
            for o in listed {
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

/// Expands dropped/picked paths: files stay as they are, folders are walked recursively. Off the
/// thread the command arrives on (the window's, for a command that isn't async): a big folder
/// or a slow volume takes long to walk.
#[tauri::command]
pub async fn expand_paths(paths: Vec<String>) -> Result<Vec<LocalFile>, String> {
    tokio::task::spawn_blocking(move || expand(paths)).await.map_err(err)?
}

fn expand(paths: Vec<String>) -> Result<Vec<LocalFile>, String> {
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
    include_links: Option<bool>,
) -> Result<Vec<RemoteFile>, String> {
    let client = match storage::connect(&app, &state, &profile_id).await? {
        Conn::S3(c) => c,
        Conn::Other(s) if include_links == Some(true) => return generic::list_all_under_with_links(&*s, &bucket, &prefix).await,
        Conn::Other(s) => return generic::list_all_under(&*s, &bucket, &prefix).await,
    };
    Ok(list_all(&client, &bucket, &prefix)
        .await?
        .into_iter()
        .filter(|o| !o.key.ends_with('/'))
        .map(|o| RemoteFile { key: o.key, size: o.size })
        .collect())
}

/// [`list_all_under`] as the files are found: each batch goes to `on_batch` while the walk goes
/// on, so a folder download starts with the first files instead of after the whole tree was
/// listed (thousands of folders on an FTP server take minutes). `op_id` stops it
/// (`cancel_transfer`); answers the number of files sent.
#[tauri::command]
pub async fn stream_files_under(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    bucket: String,
    prefix: String,
    op_id: String,
    on_batch: tauri::ipc::Channel<Vec<RemoteFile>>,
) -> Result<u64, String> {
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(op_id.clone(), flag.clone());
    let r = stream_files(&app, &state, &profile_id, &bucket, &prefix, &flag, &|batch| on_batch.send(batch).map_err(|e| e.to_string())).await;
    state.cancels.lock().await.remove(&op_id);
    r
}

async fn stream_files(
    app: &AppHandle,
    state: &AppState,
    profile_id: &str,
    bucket: &str,
    prefix: &str,
    cancel: &AtomicBool,
    send: &(dyn Fn(Vec<RemoteFile>) -> Result<(), String> + Send + Sync),
) -> Result<u64, String> {
    let stopped = || cancel.load(Ordering::Relaxed);
    let mut sent = 0u64;
    match storage::connect(app, state, profile_id).await? {
        Conn::S3(client) => {
            let mut token: Option<String> = None;
            loop {
                if stopped() {
                    return Err(storage::StorageError::cancelled().into());
                }
                let out = client.list_objects_v2().bucket(bucket).prefix(prefix).set_continuation_token(token.take()).send().await.map_err(sdk_err)?;
                let batch: Vec<RemoteFile> = out.contents().iter().map(obj_info).filter(|o| !o.key.ends_with('/')).map(|o| RemoteFile { key: o.key, size: o.size }).collect();
                sent += batch.len() as u64;
                if !batch.is_empty() {
                    send(batch)?;
                }
                token = out.next_continuation_token().map(str::to_string).filter(|_| out.is_truncated().unwrap_or(false));
                if token.is_none() {
                    break;
                }
            }
        }
        Conn::Other(s) => {
            use futures_util::StreamExt;
            let mut walk = s.walk(bucket, prefix);
            while let Some(batch) = walk.next().await {
                if stopped() {
                    return Err(storage::StorageError::cancelled().into());
                }
                let files: Vec<RemoteFile> =
                    batch?.into_iter().filter(|e| !e.is_dir() && !crate::local_links::skip_listed_link(s.caps(), e)).map(|e| RemoteFile { key: e.key, size: e.size }).collect();
                sent += files.len() as u64;
                if !files.is_empty() {
                    send(files)?;
                }
            }
        }
    }
    Ok(sent)
}

/// Runs against a throwaway S3 server; see the sync tests for how to start one.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A saved password belongs to a server and user name: another one needs it typed again,
    /// while a name, folder or other change keeps it. Keys only sign, so they follow (S3-3).
    #[test]
    fn a_saved_password_belongs_to_its_server_and_user() {
        use crate::state::{NetAuth, NetConfig, TlsMode};
        let p = |kind: ConnKind, net: NetConfig| Profile { kind, net: Some(net), ..Default::default() };
        let ftp = NetConfig { host: "Files.Example.com".into(), user: "alice".into(), tls: TlsMode::Explicit, ..Default::default() };
        let t = |kind, net| password_target(&p(kind, net));
        assert_eq!(t(ConnKind::Ftp, ftp.clone()), t(ConnKind::Ftp, NetConfig { host: " files.example.com".into(), port: 21, base_path: "/x".into(), ..ftp.clone() }));
        assert_ne!(t(ConnKind::Ftp, ftp.clone()), t(ConnKind::Ftp, NetConfig { host: "other.example.com".into(), ..ftp.clone() }));
        assert_ne!(t(ConnKind::Ftp, ftp.clone()), t(ConnKind::Ftp, NetConfig { user: "bob".into(), ..ftp.clone() }));
        assert_ne!(t(ConnKind::Ftp, ftp.clone()), t(ConnKind::Ftp, NetConfig { port: 2121, ..ftp.clone() }));
        let sftp = NetConfig { host: "h".into(), user: "u".into(), auth: NetAuth::Password, ..Default::default() };
        assert!(t(ConnKind::Sftp, sftp.clone()).is_some());
        assert_eq!(t(ConnKind::Sftp, NetConfig { auth: NetAuth::Key, ..sftp.clone() }), None, "a key only signs");
        let dav = |u: &str| t(ConnKind::Webdav, NetConfig { url: Some(u.into()), user: "u".into(), ..Default::default() });
        assert_eq!(dav("https://Cloud.example.com/remote.php/dav/"), dav("davs://cloud.example.com:443/other/"));
        assert_ne!(dav("https://cloud.example.com/"), dav("https://evil.example.net/"));
        assert_ne!(dav("https://cloud.example.com/"), dav("https://cloud.example.com:8443/"));
        // a profile saved with host and port instead of an address
        let old = t(ConnKind::Webdav, NetConfig { host: "cloud.example.com".into(), tls: TlsMode::Implicit, user: "u".into(), ..Default::default() });
        assert_eq!(old, dav("https://cloud.example.com/"));
        // the transport counts: https to http (or dav://, which is plain http) is a new place (B3-6, S-4)
        assert_ne!(dav("https://cloud.example.com/"), dav("http://cloud.example.com/"));
        assert_ne!(dav("https://cloud.example.com/"), dav("dav://cloud.example.com/"));
        assert_ne!(dav("https://cloud.example.com/"), dav("ftp://cloud.example.com/"));
        let tls = |tls| t(ConnKind::Ftp, NetConfig { tls, ..ftp.clone() });
        assert_ne!(tls(TlsMode::Explicit), tls(TlsMode::None));
        assert_ne!(tls(TlsMode::Explicit), tls(TlsMode::Auto));
        // a port typed in the host field is the port connected to
        assert_ne!(t(ConnKind::Ftp, ftp.clone()), t(ConnKind::Ftp, NetConfig { host: "files.example.com:2121".into(), ..ftp.clone() }));
        assert_eq!(t(ConnKind::Ftp, NetConfig { host: "files.example.com:2121".into(), ..ftp.clone() }), t(ConnKind::Ftp, NetConfig { port: 2121, ..ftp.clone() }));
    }

    /// An Azure SAS token or a Google service account key is the credential itself: it must not
    /// follow a new endpoint or account (S-3).
    #[test]
    fn a_saved_blob_secret_belongs_to_its_endpoint() {
        use crate::state::BlobConfig;
        let p = |kind: ConnKind, account: &str, endpoint: &str, container: &str| Profile {
            kind,
            blob: Some(BlobConfig { account: account.into(), endpoint: endpoint.into(), container: Some(container.into()) }),
            ..Default::default()
        };
        let t = |q: Profile| password_target(&q);
        let az = t(p(ConnKind::Azblob, "acct", "", "photos"));
        assert!(az.is_some());
        assert_eq!(az, t(p(ConnKind::Azblob, " Acct", "https://acct.blob.core.windows.net/", "other")), "the container may change");
        assert_ne!(az, t(p(ConnKind::Azblob, "acct", "https://attacker.example", "photos")));
        assert_ne!(az, t(p(ConnKind::Azblob, "acct", "http://acct.blob.core.windows.net", "photos")), "https to http");
        assert_ne!(az, t(p(ConnKind::Azblob, "other", "", "photos")));
        let g = t(p(ConnKind::Gcs, "", "", "bucket"));
        assert!(g.is_some());
        assert_eq!(g, t(p(ConnKind::Gcs, "", "https://storage.googleapis.com/", "other")));
        assert_ne!(g, t(p(ConnKind::Gcs, "", "https://attacker.example", "bucket")));
    }

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
