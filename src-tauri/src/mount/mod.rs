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
pub mod link;
pub mod os;
pub mod server;
pub mod webdav;
pub mod writeback;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
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
    /// drives that were mounted when the app began to quit (mounted again by `resume`)
    resume: Mutex<Vec<String>>,
    /// held while this run looks after the drives (see [`own_drives`])
    owner: Mutex<Option<std::fs::File>>,
    /// another running Kybl looks after the drives
    elsewhere: AtomicBool,
    /// one write of `mounts.json` at a time
    saving: Mutex<()>,
}

/// What a drive shows while another running Kybl looks after the drives.
const OTHER_COPY: &str = "Another copy of Kybl that is running looks after the drives. Quit that copy, then try again here.";

// ---------------------------------------------------------------- persistence

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(err)?.join("mounts.json"))
}

/// The saved drives, one by one: one this version can't read is left out here (and kept by the
/// next save), not the whole list (B5-4).
fn load_configs(app: &AppHandle) -> Vec<MountConfig> {
    let v = config_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok());
    crate::state::parse_list(v.as_ref())
}

pub(crate) fn write_configs(p: &std::path::Path, list: &[MountConfig]) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    // the file holds each drive's path token: `write_atomic` makes it this account's only (0600),
    // one an earlier build wrote readable by others included
    // drives this version can't read stay listed, so their pending saves keep their drive
    let old = crate::state::json_before_save(p)?;
    let mine = list.iter().map(serde_json::to_value).collect::<Result<Vec<_>, _>>().map_err(err)?;
    let all = crate::state::keep_unreadable::<MountConfig>(old.as_ref(), mine);
    crate::state::write_atomic(p, &serde_json::to_vec_pretty(&all).map_err(err)?).map_err(err)
}

/// Writes the drives as they are now. One write at a time, each of the list as it is then, so
/// an older list never lands after a newer one.
fn persist(app: &AppHandle) -> Result<(), String> {
    let mgr = app.state::<MountManager>();
    let _one = mgr.saving.lock().unwrap();
    let list = mgr.configs.lock().unwrap().clone();
    write_configs(&config_path(app)?, &list)
}

fn owner_lock_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(err)?.join("mounts.lock"))
}

/// Whether this run looks after the drives, taking them over when no other running Kybl does.
/// Drives (their mount points, pending saves and `mounts.json`) belong to this account, not to
/// one run, so only the run holding the lock mounts, unmounts or changes them: a second copy of
/// the app would otherwise unmount the first one's drives and upload its pending saves twice.
/// Taking them over later (the other copy quit) reads `mounts.json` again, as it left it.
fn own_drives(app: &AppHandle) -> bool {
    let mgr = app.state::<MountManager>();
    let mut owner = mgr.owner.lock().unwrap();
    if owner.is_some() {
        return true;
    }
    let Ok(path) = owner_lock_path(app) else { return true };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path) else { return true };
    match try_own(f) {
        Owner::Mine(f) => {
            *owner = Some(f);
            drop(owner);
            let was_other = mgr.elsewhere.swap(false, Ordering::SeqCst);
            let list = load_configs(app);
            let ids: Vec<String> = list.iter().map(|c| c.id.clone()).collect();
            *mgr.configs.lock().unwrap() = list;
            if was_other {
                for id in &ids {
                    emit(app, id);
                }
                take_over(app, ids);
            }
            true
        }
        Owner::Other => {
            mgr.elsewhere.store(true, Ordering::SeqCst);
            false
        }
        // a file system without locks: no other copy can be told apart, go on as before
        Owner::Unknown => true,
    }
}

/// The copy that looked after the drives quit: every drive is mounted here now, as a start does,
/// so their waiting saves upload too (not only the drive whose Retry noticed). Drives a mount was
/// already tried for in this run (the one being retried) are left to that.
fn take_over(app: &AppHandle, ids: Vec<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for id in ids {
            // after the mount under way (the Retry that took the drives over) is done
            drop(app.state::<MountManager>().busy.lock().await);
            let tried = app.state::<MountManager>().live.lock().unwrap().contains_key(&id);
            if !tried {
                mount_one(&app, &id).await;
            }
        }
    });
}

enum Owner {
    Mine(std::fs::File),
    Other,
    Unknown,
}

fn try_own(f: std::fs::File) -> Owner {
    match f.try_lock() {
        Ok(()) => Owner::Mine(f),
        Err(std::fs::TryLockError::WouldBlock) => Owner::Other,
        Err(std::fs::TryLockError::Error(_)) => Owner::Unknown,
    }
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
        if l.is_none() && os::unsupported_reason().is_none() && self.elsewhere.load(Ordering::SeqCst) {
            return MountInfo {
                id: c.id.clone(),
                profile_id: c.profile_id.clone(),
                bucket: c.bucket.clone(),
                prefix: c.prefix.clone(),
                name: c.name.clone(),
                read_only: c.read_only,
                state: "error",
                error: Some(OTHER_COPY.into()),
                mount_point: None,
                uploading: 0,
                upload_bytes: 0,
                upload_sent: 0,
                upload_error: None,
                notice: None,
                cache_bytes: 0,
            };
        }
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
    // quitting: `shutdown` has unmounted (or is unmounting) what was mounted; nothing new now
    if crate::quit::quitting() {
        return;
    }
    if os::unsupported_reason().is_none() && !own_drives(app) {
        emit(app, id);
        return;
    }
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
        // a fresh path token for every mount: the system's mount list shows the drive's address
        // to every app on this computer, so a token seen there stops working with the mount
        let stale = (!c.token.is_empty() && c.port != 0).then(|| format!("http://127.0.0.1:{}/{}/", c.port, c.token));
        if let Some(stale) = stale {
            // Linux: a mount of the previous token left by a crash is found by that address
            // only, so it goes before the token changes (B5-8). Other systems: nothing to do.
            let _ = tokio::task::spawn_blocking(move || os::forget_stale(&stale)).await;
        }
        c.token = server::random_token();
        match server::start(fs, c.port, c.token.clone(), read_only).await {
            Ok(s) => {
                if s.port != c.port {
                    c.port = s.port;
                }
                mgr.set(id, |l| l.server = Some(s));
                if let Some(x) = mgr.configs.lock().unwrap().iter_mut().find(|x| x.id == id) {
                    x.port = c.port;
                    x.token = c.token.clone();
                }
                let _ = persist(app);
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
/// With files open on the drive it stops with [`os::BUSY`] unless `force` (quitting only).
/// The caller holds `busy`.
async fn unmount_one(app: &AppHandle, id: &str, stop_uploads: bool, force: bool) -> Result<(), String> {
    let mgr = app.state::<MountManager>();
    let url = mgr.config(id).map(|c| format!("http://127.0.0.1:{}/{}/", c.port, c.token)).unwrap_or_default();
    let mounted = mgr.live.lock().unwrap().get(id).and_then(|l| l.mounted.clone());
    if let Some(m) = mounted {
        let url2 = url.clone();
        let r = tokio::time::timeout(Duration::from_secs(5), tokio::task::spawn_blocking(move || os::unmount(&m, &url2, force))).await;
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
    // only one running Kybl looks after the drives; the others list them with why they can't
    if os::unsupported_reason().is_none() {
        own_drives(app);
    }
    let configs = load_configs(app);
    *app.state::<MountManager>().configs.lock().unwrap() = configs.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for c in configs {
            mount_one(&app, &c.id).await;
        }
        // upload progress, once a second while something uploads
        let mut tick = 0u64;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            tick += 1;
            // another copy looks after the drives: take them over as soon as it quits
            if tick % 5 == 0 && !crate::quit::quitting() && app.state::<MountManager>().elsewhere.load(Ordering::SeqCst) {
                own_drives(&app);
            }
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
    // small saves still waiting get a moment to go up first
    let queues: Vec<_> = mgr.live.lock().unwrap().values().map(|l| l.fs.0.uploads.clone()).collect();
    let _ = futures_util::future::join_all(queues.iter().map(|q| q.drain(limit / 3))).await;
    // the drives to mount again if the quit is called off (see `resume`)
    *mgr.resume.lock().unwrap() = mgr.live.lock().unwrap().iter().filter(|(_, l)| l.mounted.is_some()).map(|(id, _)| id.clone()).collect();
    let all = async {
        let _one = mgr.busy.lock().await;
        // taken once a mount still under way (start-up) is done, so that drive goes too; any
        // mount after this one sees `quitting` and doesn't start
        let ids: Vec<String> = mgr.live.lock().unwrap().keys().cloned().collect();
        for id in &ids {
            let _ = unmount_one(app, id, true, true).await;
        }
    };
    if tokio::time::timeout(limit, all).await.is_err() {
        // whatever didn't unmount in time: its uploads stop all the same (they carry on next start)
        for q in &queues {
            q.stop();
        }
    }
}

/// The quit after [`shutdown`] was called off (an update's installer didn't start): the
/// uploads start again and the drives that were mounted are mounted again.
pub async fn resume(app: &AppHandle) {
    let Some(mgr) = app.try_state::<MountManager>() else { return };
    let ids: Vec<String> = std::mem::take(&mut *mgr.resume.lock().unwrap());
    {
        let live = mgr.live.lock().unwrap();
        for l in live.values() {
            if l.fs.0.uploads.is_stopped() {
                l.fs.0.uploads.rearm();
                l.fs.start_uploads();
            }
        }
    }
    for id in ids {
        mount_one(app, &id).await;
    }
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
    if !own_drives(&app) {
        return Err(OTHER_COPY.into());
    }
    let mgr = app.state::<MountManager>();
    let wanted = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| default_name(&app, &profile_id, &bucket, &prefix));
    let c = {
        let mut list = mgr.configs.lock().unwrap();
        if let Some(same) = list.iter().find(|c| c.profile_id == profile_id && c.bucket == bucket && c.prefix == prefix) {
            return Err(format!("This is already a drive: “{}”.", same.name));
        }
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
        c
    };
    if let Err(e) = persist(&app) {
        mgr.configs.lock().unwrap().retain(|x| x.id != c.id);
        return Err(e);
    }
    mount_one(&app, &c.id).await;
    Ok(mgr.info_of(&c))
}

#[tauri::command]
pub async fn mount_remove(app: AppHandle, id: String) -> Result<(), String> {
    remove_drive(&app, &id, false).await
}

/// Where the saves Kybl kept for a drive go when the drive goes: a folder the user can find,
/// `Documents/Kybl recovered/<drive> (<id>)`.
fn kept_folder(app: &AppHandle, c: &MountConfig) -> Result<PathBuf, String> {
    let base = app.path().document_dir().or_else(|_| app.path().home_dir()).map_err(err)?;
    let name: String = c.name.chars().map(|ch| if ch.is_control() || r#"/\:*?"<>|"#.contains(ch) { '_' } else { ch }).collect();
    let name = name.trim().trim_matches('.');
    let short: String = c.id.chars().take(8).collect();
    Ok(base.join("Kybl recovered").join(format!("{} ({short})", if name.is_empty() { "Drive" } else { name })))
}

/// Moves the saves Kybl kept aside for drive `c` (and, with `waiting`, those still waiting to
/// upload) out of its uploads folder before that folder is deleted, and shows where they went.
/// An error when they couldn't be moved: then nothing may be deleted.
async fn rescue_kept(app: &AppHandle, c: &MountConfig, waiting: bool) -> Result<(), String> {
    let Ok(dir) = uploads_dir(app, &c.id) else { return Ok(()) };
    if !waiting && !writeback::has_kept(&dir) {
        return Ok(());
    }
    let to = kept_folder(app, c)?;
    let to2 = to.clone();
    let moved = tokio::task::spawn_blocking(move || writeback::rescue(&dir, &to2)).await.map_err(err)?;
    match moved {
        Ok(0) => Ok(()),
        Ok(_) => {
            let _ = tauri_plugin_opener::reveal_item_in_dir(&to);
            Ok(())
        }
        Err(e) => Err(format!("Kybl couldn't move the saved files it kept for “{}” out of the way ({e}), so the drive stays.", c.name)),
    }
}

/// A connection was deleted: its drives go too (they could never be opened again, and would be
/// mounted again on every start). Saves still waiting to upload are moved out, not deleted.
pub async fn forget_profile(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    let ids: Vec<String> = app.state::<MountManager>().configs.lock().unwrap().iter().filter(|c| c.profile_id == profile_id).map(|c| c.id.clone()).collect();
    for id in ids {
        remove_drive(app, &id, true).await?;
    }
    Ok(())
}

/// Removes a drive and everything Kybl keeps for it. Saves still waiting to upload stop the
/// removal, unless `connection_gone` (its connection was deleted, so they never would): then
/// they are moved out with the rest of what Kybl kept, never deleted.
async fn remove_drive(app: &AppHandle, id: &str, connection_gone: bool) -> Result<(), String> {
    let id = id.to_string();
    let mgr = app.state::<MountManager>();
    let _one = mgr.busy.lock().await;
    // its pending saves and cache are the other copy's to look after while it runs
    if os::unsupported_reason().is_none() && !own_drives(app) {
        return Err(OTHER_COPY.into());
    }
    let c = mgr.config(&id).ok_or("This drive isn't there any more.")?;
    let waiting = || mgr.live.lock().unwrap().get(&id).map(|l| l.fs.0.uploads.stats().0).unwrap_or(0);
    let still_uploading = |n: usize| {
        format!(
            "{} from this drive {} still uploading. Remove the drive once {} done.",
            if n == 1 { "1 file".to_string() } else { format!("{n} files") },
            if n == 1 { "is" } else { "are" },
            if n == 1 { "it's" } else { "they're" },
        )
    };
    if !connection_gone && waiting() > 0 {
        return Err(still_uploading(waiting()));
    }
    // the files kept aside are promised never to be deleted: out of the folder first
    if !connection_gone {
        rescue_kept(app, &c, false).await?;
    }
    unmount_one(app, &id, connection_gone, false).await?;
    // a save that landed while the drive was unmounting is the user's only copy: keep the drive
    let n = waiting();
    if n > 0 && !connection_gone {
        drop(_one);
        emit(app, &id);
        return Err(still_uploading(n));
    }
    // nothing can be saved any more (unmounted, server stopped): stop the workers, then delete
    let l = mgr.live.lock().unwrap().remove(&id);
    if let Some(l) = l {
        l.fs.0.uploads.stop();
        if l.fs.0.uploads.stats().0 > 0 && !connection_gone {
            // committed in the last instant: put it back rather than delete it
            l.fs.0.uploads.rearm();
            l.fs.start_uploads();
            mgr.live.lock().unwrap().insert(id.clone(), l);
            drop(_one);
            emit(app, &id);
            return Err(still_uploading(1));
        }
        l.fs.0.blocks.clear();
    }
    if connection_gone {
        // the uploads are stopped: what waited goes out with what was kept, before any delete
        if let Err(e) = rescue_kept(app, &c, true).await {
            emit(app, &id);
            return Err(e);
        }
    }
    let _ = std::fs::remove_dir_all(cache_dir(app, &id)?);
    if let Ok(d) = uploads_dir(app, &id)
        && let Some(parent) = d.parent()
    {
        let _ = std::fs::remove_dir_all(parent);
    }
    mgr.configs.lock().unwrap().retain(|x| x.id != id);
    persist(app)?;
    let _ = app.emit(STATUS_EVENT, MountInfo { state: "removed", ..mgr.info_of(&c) });
    crate::tray::refresh_mounts(app);
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
    {
        let _one = mgr.busy.lock().await;
        unmount_one(&app, &id, false, false).await?;
    }
    emit(&app, &id);
    Ok(mgr.info_of(&c))
}

/// Clears the notice shown for a drive (the user read it).
#[tauri::command]
pub fn mount_dismiss(app: AppHandle, id: String) {
    app.state::<MountManager>().set(&id, |l| l.notice = None);
    emit(&app, &id);
}
