//! "Mount as drive" (phase 2, stage E4): a connection, root or folder shows up in Finder, the
//! Linux file manager or (experimentally) Explorer, and files download when they're opened.
//!
//! Each drive is a small WebDAV server inside Kybl ([`server`], over [`webdav::KyblFs`]) that the
//! system mounts ([`os`]). Reads are cached on disk ([`cache`]); saves upload in the background
//! ([`writeback`]); Finder's clutter stays local ([`junk`]).
//!
//! - Drives are kept in `app_config_dir/mounts.json` and mounted again when Kybl starts.
//! - Quitting unmounts them; uploads still waiting carry on next start (quit.rs asks first).
//! - Status reaches the page as `mount-status` events ([`MountInfo`]).
//!
//! See `NATIVE.md` for the native stages (Windows Cloud Files, macOS File Provider).

pub mod cache;
pub mod junk;
pub mod os;
pub mod server;
pub mod webdav;
pub mod writeback;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    state::{err, load_profiles, AppState},
    storage::registry,
};
use cache::BlockCache;
use webdav::{KyblFs, Opener, Spec};
use writeback::{Event, WriteBack};

pub const STATUS_EVENT: &str = "mount-status";

/// A saved drive.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MountConfig {
    pub id: String,
    pub profile_id: String,
    /// "" shows every root of the connection
    pub bucket: String,
    /// "" or a folder ending with `/`
    pub prefix: String,
    pub name: String,
    #[serde(default)]
    pub read_only: bool,
    /// the last port and path token, tried again so a still-mounted drive keeps working
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub cache_limit_mb: Option<u64>,
}

/// A drive as the page sees it (never the token).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
    pub id: String,
    pub profile_id: String,
    pub bucket: String,
    pub prefix: String,
    pub name: String,
    pub read_only: bool,
    /// "mounting" | "mounted" | "unmounted" | "error" | "unsupported" | "removed"
    pub state: &'static str,
    pub error: Option<String>,
    /// the folder (or drive letter) it is mounted at
    pub mount_point: Option<String>,
    /// saves waiting to upload or uploading
    pub uploading: usize,
    pub upload_bytes: u64,
    pub upload_sent: u64,
    /// why a waiting upload failed last (Kybl keeps trying)
    pub upload_error: Option<String>,
    /// something the user should know (a save kept as a conflict copy)
    pub notice: Option<String>,
    pub cache_bytes: u64,
}

struct Live {
    fs: KyblFs,
    server: Option<server::Server>,
    mounted: Option<os::Mounted>,
    state: &'static str,
    error: Option<String>,
    notice: Option<String>,
}

#[derive(Default)]
pub struct MountManager {
    configs: Mutex<Vec<MountConfig>>,
    live: Mutex<HashMap<String, Live>>,
    /// one mount or unmount at a time
    busy: tokio::sync::Mutex<()>,
}

// ---------------------------------------------------------------- persistence

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(err)?.join("mounts.json"))
}

fn load_configs(app: &AppHandle) -> Vec<MountConfig> {
    config_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
}

fn save_configs(app: &AppHandle, list: &[MountConfig]) -> Result<(), String> {
    let p = config_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(err)?).map_err(err)?;
    // the file holds each drive's path token: this account only
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(err)
}

fn cache_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(err)?.join("mount").join(id))
}

/// Pending saves are the user's only copy: app data, not the cache folder the system may empty.
fn uploads_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(err)?.join("mounts").join(id).join("uploads"))
}

fn mounts_base(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(err)?.join("Mounts"))
}

// ---------------------------------------------------------------- the manager

fn opener(app: &AppHandle, profile_id: &str) -> Opener {
    let (app, profile_id) = (app.clone(), profile_id.to_string());
    Arc::new(move || {
        let (app, profile_id) = (app.clone(), profile_id.clone());
        Box::pin(async move {
            let state = app.state::<AppState>();
            registry::open(&app, &state, &profile_id).await
        })
    })
}

impl MountManager {
    fn config(&self, id: &str) -> Option<MountConfig> {
        self.configs.lock().unwrap().iter().find(|c| c.id == id).cloned()
    }

    fn info_of(&self, c: &MountConfig) -> MountInfo {
        let live = self.live.lock().unwrap();
        let l = live.get(&c.id);
        let (uploading, upload_bytes, upload_sent) = l.map(|l| l.fs.0.uploads.stats()).unwrap_or_default();
        MountInfo {
            id: c.id.clone(),
            profile_id: c.profile_id.clone(),
            bucket: c.bucket.clone(),
            prefix: c.prefix.clone(),
            name: c.name.clone(),
            read_only: c.read_only,
            state: l.map(|l| l.state).unwrap_or(if os::unsupported_reason().is_some() { "unsupported" } else { "unmounted" }),
            error: l.and_then(|l| l.error.clone()).or_else(|| os::unsupported_reason().map(String::from)),
            mount_point: l.and_then(|l| l.mounted.as_ref().map(|m| m.point.clone())),
            uploading,
            upload_bytes,
            upload_sent,
            upload_error: l.and_then(|l| l.fs.0.uploads.last_error()),
            notice: l.and_then(|l| l.notice.clone()),
            cache_bytes: l.map(|l| l.fs.0.blocks.used()).unwrap_or(0),
        }
    }

    pub fn infos(&self) -> Vec<MountInfo> {
        let list = self.configs.lock().unwrap().clone();
        list.iter().map(|c| self.info_of(c)).collect()
    }

    /// Saves waiting to upload, over all drives (quit.rs asks before leaving them for later).
    pub fn pending_uploads(&self) -> usize {
        self.live.lock().unwrap().values().map(|l| l.fs.0.uploads.stats().0).sum()
    }

    fn set(&self, id: &str, f: impl FnOnce(&mut Live)) {
        if let Some(l) = self.live.lock().unwrap().get_mut(id) {
            f(l);
        }
    }
}

fn emit(app: &AppHandle, id: &str) {
    let mgr = app.state::<MountManager>();
    if let Some(c) = mgr.config(id) {
        let _ = app.emit(STATUS_EVENT, mgr.info_of(&c));
    }
    crate::tray::refresh_mounts(app);
}

/// Makes the drive's file system (and starts its uploads) if it isn't running yet.
fn ensure_live(app: &AppHandle, c: &MountConfig) -> Result<(), String> {
    let mgr = app.state::<MountManager>();
    if mgr.live.lock().unwrap().contains_key(&c.id) {
        return Ok(());
    }
    let limit = c.cache_limit_mb.map(|mb| mb * 1024 * 1024).unwrap_or(cache::DEFAULT_LIMIT);
    let blocks = Arc::new(BlockCache::open(cache_dir(app, &c.id)?, limit));
    let uploads = Arc::new(WriteBack::open(uploads_dir(app, &c.id)?));
    let spec = Spec { bucket: c.bucket.clone(), prefix: c.prefix.clone(), read_only: c.read_only };
    let fs = KyblFs::new(opener(app, &c.profile_id), spec, blocks, uploads);
    let (app2, id) = (app.clone(), c.id.clone());
    fs.set_listener(Arc::new(move |e: Event| {
        if let Event::Conflict { key, saved_as, .. } = &e {
            let name = |k: &str| k.rsplit('/').next().unwrap_or(k).to_string();
            let notice = format!("“{}” changed on the server while you edited it, so your version was saved as “{}”.", name(key), name(saved_as));
            app2.state::<MountManager>().set(&id, |l| l.notice = Some(notice));
        }
        emit(&app2, &id);
    }));
    fs.start_uploads();
    mgr.live.lock().unwrap().insert(c.id.clone(), Live { fs, server: None, mounted: None, state: "unmounted", error: None, notice: None });
    Ok(())
}

/// Is the drive's root read-only on the server (a bucket the keys can only read)?
async fn root_read_only(app: &AppHandle, c: &MountConfig) -> bool {
    if c.bucket.is_empty() {
        return false;
    }
    let state = app.state::<AppState>();
    match registry::open(app, &state, &c.profile_id).await {
        Ok(s) => s.roots().await.map(|r| r.iter().any(|x| x.id == c.bucket && x.read_only)).unwrap_or(false),
        Err(_) => false,
    }
}

/// Starts the drive's server and has the system mount it.
async fn mount_one(app: &AppHandle, id: &str) {
    let mgr = app.state::<MountManager>();
    let _one = mgr.busy.lock().await;
    let Some(mut c) = mgr.config(id) else { return };
    if let Some(why) = os::unsupported_reason() {
        let _ = ensure_live(app, &c);
        mgr.set(id, |l| {
            l.state = "unsupported";
            l.error = Some(why.into());
        });
        emit(app, id);
        return;
    }
    if let Err(e) = ensure_live(app, &c) {
        // nothing to show the status on without a live drive: say it on the event
        let _ = app.emit(STATUS_EVENT, MountInfo { state: "error", error: Some(e), ..mgr.info_of(&c) });
        return;
    }
    mgr.set(id, |l| {
        l.state = "mounting";
        l.error = None;
    });
    emit(app, id);

    let read_only = c.read_only || root_read_only(app, &c).await;
    let fs = mgr.live.lock().unwrap().get(id).map(|l| l.fs.clone());
    let Some(fs) = fs else { return };
    let need_server = mgr.live.lock().unwrap().get(id).is_some_and(|l| l.server.is_none());
    if need_server {
        if c.token.is_empty() {
            c.token = server::random_token();
        }
        match server::start(fs, c.port, c.token.clone(), read_only).await {
            Ok(s) => {
                if s.port != c.port {
                    c.port = s.port;
                }
                mgr.set(id, |l| l.server = Some(s));
                let list = {
                    let mut list = mgr.configs.lock().unwrap();
                    if let Some(x) = list.iter_mut().find(|x| x.id == id) {
                        x.port = c.port;
                        x.token = c.token.clone();
                    }
                    list.clone()
                };
                let _ = save_configs(app, &list);
            }
            Err(e) => {
                mgr.set(id, |l| {
                    l.state = "error";
                    l.error = Some(format!("Kybl couldn't start the drive.\n\n{e}"));
                });
                emit(app, id);
                return;
            }
        }
    }
    let Some(url) = mgr.live.lock().unwrap().get(id).and_then(|l| l.server.as_ref().map(|s| s.url())) else { return };
    let base = match mounts_base(app) {
        Ok(b) => b,
        Err(e) => {
            mgr.set(id, |l| {
                l.state = "error";
                l.error = Some(e);
            });
            emit(app, id);
            return;
        }
    };
    let name = c.name.clone();
    let result = tokio::task::spawn_blocking(move || os::mount(&url, &base, &name, read_only)).await.unwrap_or_else(|e| Err(e.to_string()));
    match result {
        Ok(m) => mgr.set(id, |l| {
            l.mounted = Some(m);
            l.state = "mounted";
            l.error = None;
        }),
        Err(e) => mgr.set(id, |l| {
            l.state = "error";
            l.error = Some(e);
        }),
    }
    emit(app, id);
}

/// Unmounts the drive and stops its server (its uploads keep going unless `stop_uploads`).
async fn unmount_one(app: &AppHandle, id: &str, stop_uploads: bool) -> Result<(), String> {
    let mgr = app.state::<MountManager>();
    let url = mgr.config(id).map(|c| format!("http://127.0.0.1:{}/{}/", c.port, c.token)).unwrap_or_default();
    let mounted = mgr.live.lock().unwrap().get(id).and_then(|l| l.mounted.clone());
    if let Some(m) = mounted {
        let url2 = url.clone();
        let r = tokio::time::timeout(Duration::from_secs(5), tokio::task::spawn_blocking(move || os::unmount(&m, &url2))).await;
        match r {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => return Err(e),
            _ => return Err("The drive didn't let go in time. Close the files open on it and try again.".into()),
        }
    }
    mgr.set(id, |l| {
        l.mounted = None;
        if let Some(s) = l.server.take() {
            s.stop();
        }
        if stop_uploads {
            l.fs.0.uploads.stop();
        }
        l.state = "unmounted";
    });
    Ok(())
}

// ---------------------------------------------------------------- start and quit

/// At start-up: mounts the saved drives again.
pub fn setup(app: &AppHandle) {
    app.manage(MountManager::default());
    let configs = load_configs(app);
    *app.state::<MountManager>().configs.lock().unwrap() = configs.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for c in configs {
            mount_one(&app, &c.id).await;
        }
        // upload progress, once a second while something uploads
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let busy: Vec<String> = {
                let mgr = app.state::<MountManager>();
                let live = mgr.live.lock().unwrap();
                live.iter().filter(|(_, l)| l.fs.0.uploads.stats().0 > 0).map(|(id, _)| id.clone()).collect()
            };
            for id in busy {
                emit(&app, &id);
            }
        }
    });
}

/// On the way out: unmounts every drive (within `limit`) and stops the uploads, which carry on
/// next start.
pub async fn shutdown(app: &AppHandle, limit: Duration) {
    let Some(mgr) = app.try_state::<MountManager>() else { return };
    let ids: Vec<String> = mgr.live.lock().unwrap().keys().cloned().collect();
    // small saves still waiting get a moment to go up first
    let queues: Vec<_> = mgr.live.lock().unwrap().values().map(|l| l.fs.0.uploads.clone()).collect();
    let _ = futures_util::future::join_all(queues.iter().map(|q| q.drain(limit / 3))).await;
    let all = async {
        for id in &ids {
            let _ = unmount_one(app, id, true).await;
        }
    };
    let _ = tokio::time::timeout(limit, all).await;
}

/// Saves still to upload (0 when the drives aren't set up, e.g. in tests).
pub fn pending_uploads(app: &AppHandle) -> usize {
    app.try_state::<MountManager>().map(|m| m.pending_uploads()).unwrap_or(0)
}

/// For the tray: (id, name, mounted) of each drive.
pub fn tray_items(app: &AppHandle) -> Vec<(String, String, bool)> {
    let Some(mgr) = app.try_state::<MountManager>() else { return vec![] };
    mgr.infos().into_iter().map(|i| (i.id, i.name, i.state == "mounted")).collect()
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn mount_list(mgr: State<'_, MountManager>) -> Vec<MountInfo> {
    mgr.infos()
}

/// The drive's name when none is given: the folder, else the root, else the connection.
fn default_name(app: &AppHandle, profile_id: &str, bucket: &str, prefix: &str) -> String {
    if let Some(last) = prefix.trim_end_matches('/').rsplit('/').next().filter(|s| !s.is_empty()) {
        return last.to_string();
    }
    if !bucket.is_empty() {
        // local roots are absolute paths: the last part reads better
        return bucket.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(bucket).to_string();
    }
    if profile_id == registry::LOCAL_ID {
        return "This device".into();
    }
    load_profiles(app).ok().and_then(|ps| ps.into_iter().find(|p| p.id == profile_id).map(|p| p.name)).unwrap_or_else(|| "Kybl".into())
}

/// `name`, or `name 2`, `name 3`… so two drives never share a folder.
fn unique_name(taken: &[String], name: &str) -> String {
    let base = os::safe_name(name);
    let mut n = 2;
    let mut out = base.clone();
    while taken.iter().any(|t| os::safe_name(t).eq_ignore_ascii_case(&out)) {
        out = format!("{base} {n}");
        n += 1;
    }
    out
}

/// Normalizes a folder: no leading slash, a trailing one ("" for the top).
fn norm_prefix(prefix: &str) -> String {
    let p = prefix.trim_matches('/');
    if p.is_empty() { String::new() } else { format!("{p}/") }
}

#[tauri::command]
pub async fn mount_add(app: AppHandle, profile_id: String, bucket: String, prefix: String, name: Option<String>) -> Result<MountInfo, String> {
    if let Some(why) = os::unsupported_reason() {
        return Err(why.into());
    }
    let prefix = norm_prefix(&prefix);
    {
        // the connection must open (a deleted or broken one fails here, not in Finder)
        let state = app.state::<AppState>();
        registry::open(&app, &state, &profile_id).await?;
    }
    let mgr = app.state::<MountManager>();
    if let Some(same) = mgr.configs.lock().unwrap().iter().find(|c| c.profile_id == profile_id && c.bucket == bucket && c.prefix == prefix) {
        return Err(format!("This is already a drive: “{}”.", same.name));
    }
    let wanted = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| default_name(&app, &profile_id, &bucket, &prefix));
    let c = {
        let mut list = mgr.configs.lock().unwrap();
        let taken: Vec<String> = list.iter().map(|c| c.name.clone()).collect();
        let c = MountConfig {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id,
            bucket,
            prefix,
            name: unique_name(&taken, &wanted),
            read_only: false,
            port: 0,
            token: server::random_token(),
            cache_limit_mb: None,
        };
        list.push(c.clone());
        save_configs(&app, &list)?;
        c
    };
    mount_one(&app, &c.id).await;
    Ok(mgr.info_of(&c))
}

#[tauri::command]
pub async fn mount_remove(app: AppHandle, id: String) -> Result<(), String> {
    let mgr = app.state::<MountManager>();
    let c = mgr.config(&id).ok_or("This drive isn't there any more.")?;
    let waiting = mgr.live.lock().unwrap().get(&id).map(|l| l.fs.0.uploads.stats().0).unwrap_or(0);
    if waiting > 0 {
        return Err(format!(
            "{} from this drive {} still uploading. Remove the drive once {} done.",
            if waiting == 1 { "1 file".to_string() } else { format!("{waiting} files") },
            if waiting == 1 { "is" } else { "are" },
            if waiting == 1 { "it's" } else { "they're" },
        ));
    }
    unmount_one(&app, &id, true).await?;
    if let Some(l) = mgr.live.lock().unwrap().remove(&id) {
        l.fs.0.blocks.clear();
    }
    let _ = std::fs::remove_dir_all(cache_dir(&app, &id)?);
    if let Ok(d) = uploads_dir(&app, &id) {
        if let Some(parent) = d.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
    let list = {
        let mut list = mgr.configs.lock().unwrap();
        list.retain(|x| x.id != id);
        list.clone()
    };
    save_configs(&app, &list)?;
    let _ = app.emit(STATUS_EVENT, MountInfo { state: "removed", ..mgr.info_of(&c) });
    crate::tray::refresh_mounts(&app);
    Ok(())
}

#[tauri::command]
pub async fn mount_reveal(app: AppHandle, id: String) -> Result<(), String> {
    let mgr = app.state::<MountManager>();
    let m = mgr.live.lock().unwrap().get(&id).and_then(|l| l.mounted.clone());
    let m = m.ok_or("This drive isn't mounted right now.")?;
    tokio::task::spawn_blocking(move || os::reveal(&m)).await.map_err(err)?
}

/// Mounts again a drive that failed or was unmounted.
#[tauri::command]
pub async fn mount_retry(app: AppHandle, id: String) -> Result<MountInfo, String> {
    let mgr = app.state::<MountManager>();
    let c = mgr.config(&id).ok_or("This drive isn't there any more.")?;
    let still = mgr.live.lock().unwrap().get(&id).and_then(|l| l.mounted.clone()).is_some_and(|m| os::is_mounted(&m));
    if !still {
        mgr.set(&id, |l| l.mounted = None);
        mount_one(&app, &id).await;
    }
    Ok(mgr.info_of(&c))
}

/// Unmounts a drive but keeps it in the list (mount_retry mounts it again).
#[tauri::command]
pub async fn mount_eject(app: AppHandle, id: String) -> Result<MountInfo, String> {
    let mgr = app.state::<MountManager>();
    let c = mgr.config(&id).ok_or("This drive isn't there any more.")?;
    unmount_one(&app, &id, false).await?;
    emit(&app, &id);
    Ok(mgr.info_of(&c))
}

/// Clears the notice shown for a drive (the user read it).
#[tauri::command]
pub fn mount_dismiss(app: AppHandle, id: String) {
    app.state::<MountManager>().set(&id, |l| l.notice = None);
    emit(&app, &id);
}
