//! Archives (.zip, .tar, .tar.gz): browsing one like a folder, extracting, compressing.
//!
//! - **Browse**: `archive_open` reads the archive's table of contents (a remote archive is fetched
//!   first, the page usually hands over the copy it already downloaded with progress) and keeps
//!   it as a read-only connection under an id that names its source (`archive:` + base64 of
//!   connection, root and key). Every browse command, Quick Look, the viewers, copies to other
//!   panes and jobs then read it through `storage::registry` like any connection; after a restart
//!   the registry opens it again from that id (see [`reopen`]).
//! - **Extract** / **Compress** run as one row of the transfers panel (the page starts them with
//!   its own transfer id; they send the same `transfer` events and stop on `cancel_transfer`).
//!   SFTP unpacks and zips on the server when it can (remote.rs).
//!
//! Safety: names that would land outside the destination, links, absurd sizes and decompression
//! bombs are left out or refused when the index is read (index.rs), so everything downstream only
//! ever sees safe keys.

pub mod backend;
pub mod index;
pub mod ops;
pub mod remote;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use self::{
    backend::ArchiveBackend,
    index::{parent_of, Format, Index, Skipped},
};
use crate::state::AppState;
use crate::storage::{registry, BoxFuture, SResult, Storage, StorageError, WriteOpts, WriteOutcome, WriteSource};

/// Connection ids of open archives start with this.
pub const PREFIX: &str = "archive:";

/// The connection id of the archive at `key` of `root` on connection `profile`.
pub fn encode_id(profile: &str, root: &str, key: &str) -> String {
    format!("{PREFIX}{}", B64.encode(format!("{profile}\n{root}\n{key}")))
}

/// (connection, root, key) of an archive id.
pub fn decode_id(id: &str) -> Option<(String, String, String)> {
    let raw = String::from_utf8(B64.decode(id.strip_prefix(PREFIX)?).ok()?).ok()?;
    let mut it = raw.splitn(3, '\n');
    Some((it.next()?.to_string(), it.next()?.to_string(), it.next()?.to_string()))
}

fn base_name(key: &str) -> &str {
    key.trim_end_matches('/').rsplit('/').next().unwrap_or(key)
}

/// An archive open this session.
struct Opened {
    backend: Arc<ArchiveBackend>,
    /// size and modification time of the file it was read from, when it was read
    stamp: Option<Stamp>,
}

type Stamp = (u64, Option<std::time::SystemTime>);

fn stamp_of(path: &Path) -> Option<Stamp> {
    std::fs::metadata(path).ok().map(|m| (m.len(), m.modified().ok()))
}

/// The archives open this session, by id.
static OPENED: LazyLock<Mutex<HashMap<String, Opened>>> = LazyLock::new(Default::default);
/// One open (download, unpack, index) per archive at a time: a second one waits and reuses it.
static OPENING: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

/// Downloaded archives and unpacked .tar files beyond this are removed (oldest first), except the
/// ones open archives read from.
const CACHE_BUDGET: u64 = 2 << 30;

fn work_base<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, StorageError> {
    Ok(app.path().app_cache_dir().map_err(|e| StorageError::other(e.to_string()))?.join("archives"))
}

/// `<app cache>/archives/<this run>/`: emptied when Kybl quits, and what an ended run left is
/// removed by the next start (see `instance_dir`).
fn work_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, StorageError> {
    crate::instance_dir::claim(&work_base(app)?).map_err(StorageError::from)
}

/// Start-up: claims this run's work folder, removing what earlier runs left there.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let _ = work_dir(app);
}

/// Quitting: the downloads and unpacked copies go.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(base) = work_base(app) {
        crate::instance_dir::clear(&base);
    }
}

/// Keeps the work folder under `budget`: whole files, oldest first, never one in `keep` (open
/// archives read from them) nor an unfinished one (`.part`, a zip being made).
pub(crate) fn prune(dir: &Path, keep: &[PathBuf], budget: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let m = e.metadata().ok().filter(|m| m.is_file())?;
            (!name.ends_with(".part") && !name.starts_with("pack-")).then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort();
    for (_, len, path) in files {
        if total <= budget {
            break;
        }
        if keep.contains(&path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// A file of this computer holding the archive: `local` (a copy the page already made), the
/// archive itself when its connection is this computer, else a fresh download into the cache.
async fn local_file<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: &str,
    (profile, root, key): (&str, &str, &str),
    local: Option<&str>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
    cancel: &AtomicBool,
) -> SResult<PathBuf> {
    if let Some(l) = local.map(PathBuf::from).filter(|p| p.is_file()) {
        return Ok(l);
    }
    let src = registry::open(app, state, profile).await.map_err(StorageError::from)?;
    if let Some(p) = src.local_path(root, key).filter(|p| p.is_file()) {
        return Ok(p);
    }
    let e = src.stat(root, key).await?.ok_or_else(StorageError::not_found)?;
    let ext = if Format::of(key) == Some(Format::TarGz) { "tgz" } else { key.rsplit('.').next().unwrap_or("bin") };
    let to = work_dir(app)?.join(format!("{:016x}.{ext}", index::fnv(&format!("{id}|{}|{}", e.size, e.etag.unwrap_or_default()))));
    if std::fs::metadata(&to).is_ok_and(|m| m.len() == e.size.max(0) as u64) {
        return Ok(to);
    }
    ops::fetch(&*src, root, key, &to, progress, cancel).await
}

/// The open archive `id` when it can be reused: opened from `local` (if given), and that file is
/// still the size and age it was when it was read.
fn reusable(id: &str, local: Option<&str>) -> Option<Arc<ArchiveBackend>> {
    let all = OPENED.lock().unwrap();
    let o = all.get(id)?;
    let src = &o.backend.index.source;
    (local.is_none_or(|l| src == Path::new(l)) && stamp_of(src) == o.stamp).then(|| o.backend.clone())
}

/// The open archive `id`, opened (fetched and indexed) when it isn't yet, when `local` is
/// another copy than the one it was opened from, or when that file changed since (a rebuilt
/// archive, a newer download to the same place).
async fn ensure<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: &str,
    local: Option<&str>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
    cancel: &Arc<AtomicBool>,
) -> SResult<Arc<ArchiveBackend>> {
    if let Some(b) = reusable(id, local) {
        return Ok(b);
    }
    let gate = OPENING.lock().unwrap().entry(id.to_string()).or_default().clone();
    let res = {
        let _one = gate.lock().await;
        match reusable(id, local) {
            // opened by the open this one waited for
            Some(b) => Ok(b),
            None => open_now(app, state, id, local, progress, cancel).await,
        }
    };
    {
        let mut opening = OPENING.lock().unwrap();
        if Arc::strong_count(&gate) <= 2 {
            opening.remove(id);
        }
    }
    res
}

async fn open_now<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: &str,
    local: Option<&str>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
    cancel: &Arc<AtomicBool>,
) -> SResult<Arc<ArchiveBackend>> {
    let (profile, root, key) = decode_id(id).ok_or_else(|| StorageError::other("This archive link is damaged."))?;
    let format = Format::of(&key).ok_or_else(|| StorageError::other("Kybl opens .zip, .tar and .tar.gz archives."))?;
    let path = local_file(app, state, id, (&profile, &root, &key), local, progress, cancel).await?;
    let work = work_dir(app)?;
    // taken before reading: a change while it is read makes the next open read it again
    let stamp = stamp_of(&path);
    let c = cancel.clone();
    let w = work.clone();
    let index = tokio::task::spawn_blocking(move || Index::open(&path, format, &w, &c))
        .await
        .map_err(|e| StorageError::other(e.to_string()))?
        .map_err(|e| if cancel.load(Ordering::Relaxed) { StorageError::cancelled() } else { StorageError::other(e.to_string()) })?;
    let b = Arc::new(ArchiveBackend::new(base_name(&key).to_string(), Arc::new(index)));
    let keep: Vec<PathBuf> = {
        let mut all = OPENED.lock().unwrap();
        all.insert(id.to_string(), Opened { backend: b.clone(), stamp });
        all.values().flat_map(|o| [o.backend.index.source.clone(), o.backend.index.data.clone()]).collect()
    };
    registry::insert(id, b.clone());
    let _ = tokio::task::spawn_blocking(move || prune(&work, &keep, CACHE_BUDGET)).await;
    Ok(b)
}

/// For `storage::registry::open`: an archive id not open this session (after a restart, a job
/// resuming), opened again from its source.
pub fn reopen<'a, R: Runtime>(app: &'a AppHandle<R>, state: &'a AppState, id: &'a str) -> BoxFuture<'a, Result<Arc<dyn Storage>, String>> {
    Box::pin(async move {
        let b = ensure(app, state, id, None, &|_, _| {}, &Arc::new(AtomicBool::new(false))).await?;
        Ok(b as Arc<dyn Storage>)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    /// the connection id to list it with
    pub id: String,
    /// its one root (the archive's file name)
    pub root: String,
    pub format: Format,
    pub files: usize,
    pub folders: usize,
    pub bytes: u64,
    pub skipped: Skipped,
}

/// Opens the archive at `key` (`local`: a copy on this computer the page already has) for
/// browsing, and says how to list it.
#[tauri::command]
pub async fn archive_open(app: AppHandle, state: State<'_, AppState>, profile_id: String, root: String, key: String, local: Option<String>) -> Result<ArchiveInfo, String> {
    let id = encode_id(&profile_id, &root, &key);
    let b = ensure(&app, &state, &id, local.as_deref(), &|_, _| {}, &Arc::new(AtomicBool::new(false))).await?;
    let ix = &b.index;
    Ok(ArchiveInfo { id, root: b.root.clone(), format: ix.format, files: ix.items.len(), folders: ix.dirs.len(), bytes: ix.total, skipped: ix.skipped })
}

// ---------------------------------------------------------------- transfers-panel tasks

#[derive(Serialize, Clone)]
struct TransferEvent<'a> {
    id: &'a str,
    state: &'static str,
    bytes: u64,
    total: u64,
    error: Option<String>,
}

struct Task<R: Runtime> {
    app: AppHandle<R>,
    id: String,
    cancel: Arc<AtomicBool>,
    last: Mutex<Instant>,
}

impl<R: Runtime> Task<R> {
    fn emit(&self, state: &'static str, bytes: u64, total: u64, error: Option<String>) {
        let _ = self.app.emit("transfer", TransferEvent { id: &self.id, state, bytes, total, error });
    }
    /// Progress, at most ~8 a second.
    fn tick(&self, bytes: u64, total: u64) {
        let mut last = self.last.lock().unwrap();
        if last.elapsed() >= Duration::from_millis(120) {
            *last = Instant::now();
            drop(last);
            self.emit("running", bytes, total, None);
        }
    }
}

/// Runs `work` as transfer `id`: running/done/error/cancelled events, Cancel through
/// `cancel_transfer`. Returns once it started.
async fn spawn_task<R, F, Fut>(app: AppHandle<R>, state: &AppState, id: String, work: F) -> Result<(), String>
where
    R: Runtime,
    F: FnOnce(Arc<Task<R>>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = SResult<u64>> + Send + 'static,
{
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut c = state.cancels.lock().await;
        if c.contains_key(&id) {
            return Err("This is already running.".into());
        }
        c.insert(id.clone(), cancel.clone());
    }
    let task = Arc::new(Task { app: app.clone(), id: id.clone(), cancel, last: Mutex::new(Instant::now() - Duration::from_secs(1)) });
    task.emit("running", 0, 0, None);
    tauri::async_runtime::spawn(async move {
        let res = work(task.clone()).await;
        match res {
            Ok(total) => task.emit("done", total, total, None),
            Err(e) if e.is_cancelled() || task.cancel.load(Ordering::Relaxed) => task.emit("cancelled", 0, 0, None),
            Err(e) => task.emit("error", 0, 0, Some(e.to_string())),
        }
        task.app.state::<AppState>().cancels.lock().await.remove(&task.id);
    });
    Ok(())
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtractJob {
    /// the connection the archive file is on, or an open archive's id (then `src_key` is unused
    /// and `paths` pick entries inside it)
    pub src_profile_id: String,
    pub src_root: String,
    #[serde(default)]
    pub src_key: String,
    /// entries to extract (files, folders ending with `/`); empty: everything
    #[serde(default)]
    pub paths: Vec<String>,
    /// the archive folder `paths` are relative to
    #[serde(default)]
    pub base: String,
    /// picked entries that get another name at the destination (a clash the page resolved with
    /// "Keep both")
    #[serde(default)]
    pub renames: HashMap<String, String>,
    pub dest_profile_id: String,
    pub dest_root: String,
    /// "" or ending with `/`
    pub dest_dir: String,
    /// a folder in `dest_dir` to unpack into (made if missing)
    pub folder: Option<String>,
    /// replace files of the same names (the page asked); else they are kept
    #[serde(default)]
    pub overwrite: bool,
    /// a copy of the archive on this computer the page already has
    pub local: Option<String>,
}

/// Extracts an archive (or entries of an open one) into a folder of any connection, as transfer `id`.
#[tauri::command]
pub async fn archive_extract(app: AppHandle, state: State<'_, AppState>, id: String, job: ExtractJob) -> Result<(), String> {
    let a = app.clone();
    if job.folder.as_deref().is_some_and(|f| !remote::plain_folder_name(f)) {
        return Err("That folder name can't be used to unpack into.".into());
    }
    spawn_task(app, &state, id, move |task| async move {
        let state = a.state::<AppState>();
        let inside = job.src_profile_id.starts_with(PREFIX);
        let archive_id = if inside { job.src_profile_id.clone() } else { encode_id(&job.src_profile_id, &job.src_root, &job.src_key) };
        let dst = registry::open(&a, &state, &job.dest_profile_id).await.map_err(StorageError::from)?;

        // SFTP: the server unpacks an archive of its own in place
        if let (false, true, Some(folder), Some(sftp), Some(format)) =
            (inside, job.paths.is_empty(), job.folder.as_deref(), dst.as_sftp(), Format::of(&job.src_key))
        {
            if job.src_profile_id == job.dest_profile_id && job.src_root == job.dest_root && remote::extract(sftp, &job.src_key, format, &job.dest_dir, folder, &task.cancel).await? {
                return Ok(0);
            }
        }

        let t = task.clone();
        let b = ensure(&a, &state, &archive_id, job.local.as_deref(), &move |n, total| t.tick(n, total), &task.cancel).await?;
        let plan = ops::plan_extract(&b.index, &job.paths, &job.base, &job.dest_dir, job.folder.as_deref(), &job.renames);
        let total = plan.bytes;
        let t = task.clone();
        ops::extract(b.index.clone(), dst, &job.dest_root, &plan, job.overwrite, &move |n| t.tick(n, total), &task.cancel).await?;
        Ok(total)
    })
    .await
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompressJob {
    pub profile_id: String,
    pub root: String,
    /// keys of the files and folders (ending with `/`), all in one folder
    pub items: Vec<String>,
    /// the zip's key, in that folder (a free name: the page checked)
    pub dest_key: String,
}

/// Zips files and folders of any connection into `dest_key` next to them, as transfer `id`.
#[tauri::command]
pub async fn archive_compress(app: AppHandle, state: State<'_, AppState>, id: String, job: CompressJob) -> Result<(), String> {
    if job.items.is_empty() || Format::of(&job.dest_key) != Some(Format::Zip) {
        return Err("Nothing to compress.".into());
    }
    let a = app.clone();
    let tid = id.clone();
    spawn_task(app, &state, id, move |task| async move {
        let state = a.state::<AppState>();
        let src = registry::open(&a, &state, &job.profile_id).await.map_err(StorageError::from)?;
        let dir = parent_of(&job.dest_key).to_string();

        // SFTP: zip on the server
        if let Some(sftp) = src.as_sftp() {
            if job.items.iter().all(|k| parent_of(k) == dir) {
                let names: Vec<String> = job.items.iter().map(|k| base_name(k).to_string()).collect();
                if remote::compress(sftp, &dir, &names, base_name(&job.dest_key), &task.cancel).await? {
                    return Ok(0);
                }
            }
        }

        let plan = ops::plan_pack(&*src, &job.root, &job.items).await?;
        let total: u64 = plan.iter().map(|i| i.size).sum();
        let t = task.clone();
        let tick = move |n: u64| t.tick(n, total);
        // on this computer: written next to the result and renamed in; elsewhere: zipped in the
        // cache, then uploaded
        if let Some(final_path) = src.local_path(&job.root, &job.dest_key) {
            let tmp = final_path.with_file_name(format!(".{}.kybl-{tid}.part", base_name(&job.dest_key)));
            ops::pack_to_file(src.clone(), &job.root, &plan, &tmp, &tick, &task.cancel).await?;
            if final_path.exists() {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(StorageError::exists());
            }
            tokio::fs::rename(&tmp, &final_path).await?;
            return Ok(total);
        }
        let work = work_dir(&a)?;
        tokio::fs::create_dir_all(&work).await?;
        let tmp = work.join(format!("pack-{tid}.zip"));
        let res = async {
            ops::pack_to_file(src.clone(), &job.root, &plan, &tmp, &tick, &task.cancel).await?;
            let size = tokio::fs::metadata(&tmp).await?.len();
            let t = task.clone();
            let up = move |n: u64, _: u64| t.tick(n, size);
            let opts = WriteOpts { content_type: Some("application/zip".into()), parts_in_flight: 4, ..Default::default() };
            match src.write(&job.root, &job.dest_key, WriteSource::Path(tmp.clone()), opts, &up, &task.cancel).await? {
                WriteOutcome::Done(_) => Ok(size),
                WriteOutcome::Cancelled => Err(StorageError::cancelled()),
                WriteOutcome::Conflict(_) => Err(StorageError::exists()),
            }
        }
        .await;
        let _ = tokio::fs::remove_file(&tmp).await;
        res
    })
    .await
}
