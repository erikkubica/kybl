//! A disk cache of recently fetched file bytes, shared by the document viewers (`doc_open`),
//! downloads and "Open" in another app (a download to the temporary folder). Opening a document,
//! then downloading it, then opening it in its app fetches it once instead of three times.
//!
//! An entry names one exact version of one file: connection, root, key and the file's ETag (or,
//! for stores without ETags, its size and modification time). A file without either is never
//! cached, because there is no way to tell later whether it changed. Readers look up the current
//! ETag first (HEAD / stat, or the listing for downloads), so a changed file is simply a miss.
//!
//! Layout: `<app cache>/files/<connection>/<file>/<version>`, each part a hash, so no names or
//! paths of the files show on disk. Keeping one folder per file makes "is anything cached for
//! this file?" a folder check, so a file that was never cached costs no extra HEAD, and storing a
//! new version drops the old ones. Writes go to `tmp/` first and are renamed into place, so a
//! half-written file is never served; sizes are checked again on every hit.
//!
//! Files can be private: the folders are 0700 and the files 0600 on unix, the cache of a
//! connection goes when the connection is deleted or edited, Settings can clear it, and this
//! computer's own files (connections with `localPaths`) are never copied into it.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, atomic::Ordering, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use tauri::{AppHandle, Manager, Runtime};

use crate::storage::Conn;
use crate::transfers::{Outcome, Progress};

/// The cache is trimmed back to `KEEP_TOTAL` (least recently used first) once it passes
/// `MAX_TOTAL`. Phones get less: their disks are smaller and the system may clear it anyway.
#[cfg(not(mobile))]
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
#[cfg(mobile)]
const MAX_TOTAL: u64 = 300 * 1024 * 1024;
const KEEP_TOTAL: u64 = MAX_TOTAL / 10 * 8;
/// Bigger files are not cached: one of them would push out everything else.
const MAX_FILE: u64 = 200 * 1024 * 1024;
const TMP: &str = "tmp";

/// Which version of a file the bytes are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ident {
    /// without quotes or `W/`
    pub etag: Option<String>,
    pub size: u64,
    /// milliseconds since the epoch
    pub modified: Option<i64>,
}

impl Ident {
    pub fn new(etag: Option<&str>, size: u64, modified: Option<i64>) -> Self {
        let etag = etag.map(|e| e.trim().trim_start_matches("W/").trim_matches('"').to_string()).filter(|e| !e.is_empty());
        Ident { etag, size, modified }
    }

    /// The version part of the entry's name; None when nothing tells versions apart. The size is
    /// part of it even with an ETag, as a cheap second check.
    fn tag(&self) -> Option<String> {
        match (&self.etag, self.modified) {
            (Some(e), _) => Some(format!("e\0{e}\0{}", self.size)),
            (None, Some(m)) => Some(format!("m\0{}\0{m}", self.size)),
            (None, None) => None,
        }
    }
}

fn hash(s: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, s.as_bytes());
    d.as_ref()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

pub struct FileCache {
    dir: PathBuf,
    max_total: u64,
    keep_total: u64,
    max_file: u64,
    /// bytes in the cache, counted on first use and kept up to date after; also serializes
    /// stores, evictions and clears
    total: Mutex<Option<u64>>,
}

static CACHE: OnceLock<Option<FileCache>> = OnceLock::new();

/// The app's file cache; None when the cache folder can't be made (then nothing is cached).
pub fn get<R: Runtime>(app: &AppHandle<R>) -> Option<&'static FileCache> {
    CACHE
        .get_or_init(|| {
            let dir = app.path().app_cache_dir().ok()?.join("files");
            FileCache::open(dir, MAX_TOTAL, KEEP_TOTAL, MAX_FILE).ok()
        })
        .as_ref()
}

/// Whether files of this connection may be cached: not this computer's own files.
pub fn cacheable(conn: &Conn) -> bool {
    match conn {
        Conn::S3(_) => true,
        Conn::Other(s) => !s.caps().local_paths,
    }
}

#[cfg(unix)]
fn private_dir(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(p)?;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn private_dir(p: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(p)
}

/// A new file only its owner can read.
fn private_file(p: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(p)
}

impl FileCache {
    pub fn open(dir: PathBuf, max_total: u64, keep_total: u64, max_file: u64) -> std::io::Result<Self> {
        private_dir(&dir)?;
        private_dir(&dir.join(TMP))?;
        Ok(FileCache { dir, max_total, keep_total, max_file, total: Mutex::new(None) })
    }

    fn profile_dir(&self, profile: &str) -> PathBuf {
        self.dir.join(hash(&format!("p\0{profile}")))
    }

    fn file_dir(&self, profile: &str, root: &str, key: &str) -> PathBuf {
        // the root's length goes first, so no root/key split can collide with another
        self.profile_dir(profile).join(hash(&format!("f\0{}\0{root}\0{key}", root.len())))
    }

    fn entry(&self, profile: &str, root: &str, key: &str, id: &Ident) -> Option<PathBuf> {
        Some(self.file_dir(profile, root, key).join(hash(&id.tag()?)))
    }

    /// Whether any version of this file is cached. Cheap (no network), so callers ask this before
    /// spending a HEAD on the current ETag.
    pub fn has_any(&self, profile: &str, root: &str, key: &str) -> bool {
        std::fs::read_dir(self.file_dir(profile, root, key)).is_ok_and(|mut d| d.next().is_some())
    }

    /// The cached bytes of exactly this version, if they are here and whole. A hit counts as a
    /// use for the eviction order.
    pub fn lookup(&self, profile: &str, root: &str, key: &str, id: &Ident) -> Option<PathBuf> {
        let path = self.entry(profile, root, key, id)?;
        let len = std::fs::metadata(&path).ok()?.len();
        if len != id.size {
            // can't be the right bytes; never serve it
            self.remove_file(&path, len);
            return None;
        }
        let _ = filetime::set_file_mtime(&path, filetime::FileTime::now());
        Some(path)
    }

    /// The bytes of this version, read whole (for the viewers).
    pub fn read(&self, profile: &str, root: &str, key: &str, id: &Ident) -> Option<Vec<u8>> {
        let path = self.lookup(profile, root, key, id)?;
        let bytes = std::fs::read(path).ok()?;
        (bytes.len() as u64 == id.size).then_some(bytes)
    }

    /// Stores `bytes` as this version of the file, replacing any other version. A file that
    /// can't be cached (too big, or no way to tell versions apart) only drops the old versions.
    pub fn store_bytes(&self, profile: &str, root: &str, key: &str, id: &Ident, bytes: &[u8]) -> bool {
        if bytes.len() as u64 != id.size {
            self.forget(profile, root, key);
            return false;
        }
        self.store_with(profile, root, key, id, |tmp| {
            let mut f = private_file(tmp)?;
            f.write_all(bytes)?;
            f.sync_all()
        })
    }

    /// Stores a copy of the local file `src` (a finished download) as this version.
    pub fn store_file(&self, profile: &str, root: &str, key: &str, id: &Ident, src: &Path) -> bool {
        if std::fs::metadata(src).map(|m| m.len()).ok() != Some(id.size) {
            self.forget(profile, root, key);
            return false;
        }
        self.store_with(profile, root, key, id, |tmp| {
            let mut from = std::fs::File::open(src)?;
            let mut f = private_file(tmp)?;
            std::io::copy(&mut from, &mut f)?;
            f.sync_all()
        })
    }

    fn store_with(&self, profile: &str, root: &str, key: &str, id: &Ident, write: impl FnOnce(&Path) -> std::io::Result<()>) -> bool {
        let Some(path) = self.entry(profile, root, key, id).filter(|_| id.size <= self.max_file) else {
            self.forget(profile, root, key);
            return false;
        };
        let tmp = self.dir.join(TMP).join(uuid::Uuid::new_v4().to_string());
        // written outside the lock: only the rename has to be in step with evictions
        if write(&tmp).is_err() || std::fs::metadata(&tmp).map(|m| m.len()).ok() != Some(id.size) {
            let _ = std::fs::remove_file(&tmp);
            return false;
        }
        let mut total = self.total.lock().unwrap();
        let mut sum = total.unwrap_or_else(|| self.scan_total());
        let dir = path.parent().expect("an entry sits in its file's folder").to_path_buf();
        // other versions of the same file are stale now
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.path() != path {
                    let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                    if std::fs::remove_file(e.path()).is_ok() {
                        sum = sum.saturating_sub(len);
                    }
                }
            }
        }
        let old = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let placed = private_dir(&dir).and_then(|_| std::fs::rename(&tmp, &path)).is_ok();
        if placed {
            sum = sum.saturating_sub(old) + id.size;
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
        if sum > self.max_total {
            sum = self.evict_to(self.keep_total);
        }
        *total = Some(sum);
        placed
    }

    /// Drops every cached version of one file.
    pub fn forget(&self, profile: &str, root: &str, key: &str) {
        let mut total = self.total.lock().unwrap();
        let freed = remove_tree(&self.file_dir(profile, root, key));
        if let Some(t) = total.as_mut() {
            *t = t.saturating_sub(freed);
        }
    }

    /// Drops everything cached for a connection.
    pub fn forget_profile(&self, profile: &str) {
        let mut total = self.total.lock().unwrap();
        let freed = remove_tree(&self.profile_dir(profile));
        if let Some(t) = total.as_mut() {
            *t = t.saturating_sub(freed);
        }
    }

    /// Empties the cache; answers the bytes freed.
    pub fn clear(&self) -> u64 {
        let mut total = self.total.lock().unwrap();
        let mut freed = 0;
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                if e.file_name() != TMP {
                    freed += remove_tree(&e.path());
                }
            }
        }
        *total = Some(0);
        freed
    }

    /// Bytes in the cache.
    pub fn usage(&self) -> u64 {
        let mut total = self.total.lock().unwrap();
        *total.get_or_insert_with(|| self.scan_total())
    }

    /// At start-up: removes writes a crash or quit left in `tmp/` and trims the cache.
    pub fn prune(&self) {
        if let Ok(rd) = std::fs::read_dir(self.dir.join(TMP)) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
        let mut total = self.total.lock().unwrap();
        let sum = self.scan_total();
        *total = Some(if sum > self.max_total { self.evict_to(self.keep_total) } else { sum });
    }

    fn remove_file(&self, path: &Path, len: u64) {
        let mut total = self.total.lock().unwrap();
        if std::fs::remove_file(path).is_ok()
            && let Some(t) = total.as_mut()
        {
            *t = t.saturating_sub(len);
        }
    }

    /// Every entry: (last used, size, path).
    fn entries(&self) -> Vec<(SystemTime, u64, PathBuf)> {
        let mut out = Vec::new();
        let Ok(profiles) = std::fs::read_dir(&self.dir) else { return out };
        for p in profiles.flatten().filter(|p| p.file_name() != TMP) {
            let Ok(files) = std::fs::read_dir(p.path()) else { continue };
            for f in files.flatten() {
                let Ok(versions) = std::fs::read_dir(f.path()) else { continue };
                for v in versions.flatten() {
                    if let Ok(m) = v.metadata()
                        && m.is_file()
                    {
                        out.push((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), v.path()));
                    }
                }
            }
        }
        out
    }

    fn scan_total(&self) -> u64 {
        self.entries().iter().map(|e| e.1).sum()
    }

    /// Removes the least recently used entries until at most `keep` bytes are left; answers what
    /// is left. Callers hold the `total` lock.
    fn evict_to(&self, keep: u64) -> u64 {
        let mut all = self.entries();
        let mut sum: u64 = all.iter().map(|e| e.1).sum();
        all.sort_by_key(|e| e.0);
        for (_, len, path) in all {
            if sum <= keep {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                sum = sum.saturating_sub(len);
                // the file's folder goes with its last version, so `has_any` stays honest
                if let Some(dir) = path.parent() {
                    let _ = std::fs::remove_dir(dir);
                }
            }
        }
        sum
    }
}

/// Removes a folder and everything in it; answers the bytes freed.
fn remove_tree(p: &Path) -> u64 {
    let freed = walkdir::WalkDir::new(p)
        .into_iter()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum();
    let _ = std::fs::remove_dir_all(p);
    freed
}

// ---------------------------------------------------------------- the current version

/// HEAD of an S3 object as an `Ident`; None when that fails (the caller just fetches).
pub async fn s3_ident(client: &aws_sdk_s3::Client, bucket: &str, key: &str) -> Option<Ident> {
    let h = client.head_object().bucket(bucket).key(key).send().await.ok()?;
    let modified = h.last_modified().map(|d| d.secs() * 1000 + (d.subsec_nanos() / 1_000_000) as i64);
    Some(Ident::new(h.e_tag(), h.content_length().unwrap_or(0).max(0) as u64, modified))
}

/// The current version of a file on any connection.
async fn current(conn: &Conn, root: &str, key: &str) -> Option<Ident> {
    match conn {
        Conn::S3(client) => s3_ident(client, root, key).await,
        Conn::Other(s) => {
            let e = s.stat(root, key).await.ok()??;
            Some(Ident::new(e.etag.as_deref(), e.size.max(0) as u64, e.modified))
        }
    }
}

// ---------------------------------------------------------------- previews

/// The current version's bytes when the cache holds them (one HEAD / stat, and only for a file
/// cached before); None means "fetch it".
pub async fn read_current<R: Runtime>(app: &AppHandle<R>, conn: &Conn, profile: &str, root: &str, key: &str, max_bytes: u64) -> Option<Vec<u8>> {
    let cache = get(app)?;
    if !cacheable(conn) || !cache.has_any(profile, root, key) {
        return None;
    }
    let id = current(conn, root, key).await.filter(|id| id.size <= max_bytes)?;
    let (p, r, k) = (profile.to_string(), root.to_string(), key.to_string());
    tokio::task::spawn_blocking(move || cache.read(&p, &r, &k, &id)).await.ok()?
}

/// Keeps bytes just fetched whole (a preview) for the next open, in the background. Needs the
/// ETag or the modification time the fetch saw; without either nothing is kept.
#[allow(clippy::too_many_arguments)]
pub fn remember_bytes<R: Runtime>(app: &AppHandle<R>, conn: &Conn, profile: &str, root: &str, key: &str, etag: Option<&str>, modified: Option<i64>, bytes: &[u8]) {
    let Some(cache) = get(app) else { return };
    if !cacheable(conn) || bytes.len() as u64 > cache.max_file {
        return;
    }
    let id = Ident::new(etag, bytes.len() as u64, modified);
    let (p, r, k, bytes) = (profile.to_string(), root.to_string(), key.to_string(), bytes.to_vec());
    tokio::task::spawn_blocking(move || cache.store_bytes(&p, &r, &k, &id, &bytes));
}

// ---------------------------------------------------------------- downloads

/// Serves a download from the cache when it holds the file's current version: the cached bytes
/// are copied to `dest` (through its partial file, so the destination appears only once whole),
/// with progress and cancel as a network download has. `listed` is the version the listing
/// showed: when the cache has that one, no HEAD is needed. None means "not served": the caller
/// downloads as usual (also after any error here, so the cache can never fail a download).
#[allow(clippy::too_many_arguments)]
pub async fn serve_download<R: Runtime>(
    app: &AppHandle<R>,
    conn: &Conn,
    profile: &str,
    root: &str,
    key: &str,
    listed: Option<&Ident>,
    dest: &Path,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Option<Result<Outcome, String>> {
    let cache = get(app)?;
    if !cacheable(conn) || !cache.has_any(profile, root, key) {
        return None;
    }
    let (id, src) = match listed.and_then(|l| Some((l.clone(), cache.lookup(profile, root, key, l)?))) {
        Some(hit) => hit,
        None => {
            let id = current(conn, root, key).await?;
            let src = cache.lookup(profile, root, key, &id)?;
            (id, src)
        }
    };
    let part = crate::dest::part_path(dest);
    let copied = {
        let (dest, part) = (dest.to_path_buf(), part.clone());
        // the copy runs on a blocking thread; progress and cancel go through these
        let done = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let (done2, stop2) = (done.clone(), stop.clone());
        let task = tokio::task::spawn_blocking(move || copy_file(&src, &dest, &part, &done2, &stop2));
        tokio::pin!(task);
        progress(0, id.size);
        loop {
            tokio::select! {
                r = &mut task => break r.unwrap_or_else(|e| Err(std::io::Error::other(e.to_string()))),
                _ = tokio::time::sleep(Duration::from_millis(150)) => {
                    if cancel.load(Ordering::Relaxed) {
                        stop.store(true, Ordering::Relaxed);
                    }
                    progress(done.load(Ordering::Relaxed), id.size);
                }
            }
        }
    };
    match copied {
        Ok(true) if std::fs::metadata(&part).map(|m| m.len()).ok() == Some(id.size) => {
            if tokio::fs::rename(&part, dest).await.is_err() {
                let _ = tokio::fs::remove_file(&part).await;
                return None;
            }
            crate::leftovers::partial_ended(&part);
            progress(id.size, id.size);
            Some(Ok(Outcome::Done))
        }
        Ok(false) => {
            let _ = tokio::fs::remove_file(&part).await;
            crate::leftovers::partial_ended(&part);
            Some(Ok(Outcome::Cancelled))
        }
        // a short copy or a disk error: drop it and fetch from the server instead
        _ => {
            let _ = tokio::fs::remove_file(&part).await;
            crate::leftovers::partial_ended(&part);
            None
        }
    }
}

/// Copies `src` into `part` (a new file with the usual permissions, not the cache's 0600), in
/// chunks so progress shows and a cancel stops it. Ok(false) when cancelled.
fn copy_file(src: &Path, dest: &Path, part: &Path, done: &std::sync::atomic::AtomicU64, stop: &AtomicBool) -> std::io::Result<bool> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut from = std::fs::File::open(src)?;
    let mut to = std::fs::File::create(part)?;
    crate::leftovers::partial_started(part);
    let mut buf = vec![0u8; 1 << 20];
    let mut got = 0u64;
    let mut last = Instant::now();
    loop {
        if stop.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n])?;
        got += n as u64;
        if last.elapsed() > Duration::from_millis(50) {
            done.store(got, Ordering::Relaxed);
            last = Instant::now();
        }
    }
    done.store(got, Ordering::Relaxed);
    to.sync_all()?;
    Ok(true)
}

/// After a download from the server: keeps a copy of the file for the next open. `etag` is the
/// one the download saw; without it the file's version comes from a stat, and is only trusted
/// when its size matches what arrived. Runs in the background and never fails the download.
pub fn remember_download<R: Runtime>(app: &AppHandle<R>, conn: Conn, profile: String, root: String, key: String, etag: Option<String>, path: PathBuf) {
    let Some(cache) = get(app) else { return };
    if !cacheable(&conn) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(len) = tokio::fs::metadata(&path).await.map(|m| m.len()) else { return };
        if len > cache.max_file {
            // too big to keep, but an older version may still be here
            let _ = tokio::task::spawn_blocking(move || cache.forget(&profile, &root, &key)).await;
            return;
        }
        let id = match etag.as_deref() {
            Some(e) => Ident::new(Some(e), len, None),
            None => match current(&conn, &root, &key).await {
                Some(id) if id.size == len => id,
                _ => return,
            },
        };
        let _ = tokio::task::spawn_blocking(move || cache.store_file(&profile, &root, &key, &id, &path)).await;
    });
}

// ---------------------------------------------------------------- commands

/// Bytes held by the caches Settings can clear.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    thumbnails: u64,
    files: u64,
}

#[tauri::command]
pub async fn cache_usage(app: AppHandle) -> Result<CacheUsage, String> {
    let thumbnails = crate::thumbs::usage(&app).await;
    let files = match get(&app) {
        Some(c) => tokio::task::spawn_blocking(|| c.usage()).await.unwrap_or(0),
        None => 0,
    };
    Ok(CacheUsage { thumbnails, files })
}

/// Clears the thumbnail cache and the file cache; answers the bytes freed.
#[tauri::command]
pub async fn clear_caches(app: AppHandle) -> Result<u64, String> {
    let thumbs = crate::thumbs::clear(&app).await?;
    let files = match get(&app) {
        Some(c) => tokio::task::spawn_blocking(|| c.clear()).await.unwrap_or(0),
        None => 0,
    };
    Ok(thumbs + files)
}

/// Drops a connection's cached files (it was deleted, or its settings changed).
pub async fn forget_profile<R: Runtime>(app: &AppHandle<R>, profile: &str) {
    if let Some(c) = get(app) {
        let profile = profile.to_string();
        let _ = tokio::task::spawn_blocking(move || c.forget_profile(&profile)).await;
    }
}

/// Start-up housekeeping.
pub async fn prune<R: Runtime>(app: AppHandle<R>) {
    if let Some(c) = get(&app) {
        let _ = tokio::task::spawn_blocking(|| c.prune()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(max_total: u64, keep: u64, max_file: u64) -> (FileCache, PathBuf) {
        let dir = std::env::temp_dir().join(format!("kybl-filecache-{}", uuid::Uuid::new_v4()));
        (FileCache::open(dir.clone(), max_total, keep, max_file).unwrap(), dir)
    }

    fn id(etag: &str, size: u64) -> Ident {
        Ident::new(Some(etag), size, None)
    }

    #[test]
    fn idents_need_an_etag_or_a_modification_time() {
        assert_eq!(Ident::new(Some("W/\"abc\""), 3, None).etag.as_deref(), Some("abc"));
        assert_eq!(Ident::new(Some("\"\""), 3, None).etag, None);
        assert!(Ident::new(Some("abc"), 3, None).tag().is_some());
        assert!(Ident::new(None, 3, Some(5)).tag().is_some());
        assert_eq!(Ident::new(None, 3, None).tag(), None, "nothing tells versions apart");
        // quoted and unquoted ETags name the same entry
        assert_eq!(Ident::new(Some("\"abc\""), 3, None).tag(), Ident::new(Some("abc"), 3, None).tag());
    }

    #[test]
    fn keys_keep_connections_roots_files_and_versions_apart() {
        let (c, dir) = cache(1 << 20, 1 << 19, 1 << 20);
        let a = c.entry("p", "b", "k", &id("e", 1)).unwrap();
        for other in [
            c.entry("q", "b", "k", &id("e", 1)),
            c.entry("p", "c", "k", &id("e", 1)),
            c.entry("p", "b", "k2", &id("e", 1)),
            c.entry("p", "b", "k", &id("f", 1)),
            c.entry("p", "b", "k", &id("e", 2)),
            c.entry("p", "b", "k", &Ident::new(None, 1, Some(7))),
        ] {
            assert_ne!(other.unwrap(), a);
        }
        // a separator inside a name can't make two files collide
        assert_ne!(c.file_dir("p", "a\0b", "c"), c.file_dir("p", "a", "b\0c"));
        // nothing of the names shows on disk
        let below = a.strip_prefix(&dir).unwrap().to_string_lossy().into_owned();
        assert!(below.split('/').all(|part| part.len() == 32 && part.bytes().all(|b| b.is_ascii_hexdigit())), "{below}");
        assert_eq!(c.entry("p", "b", "k", &Ident::new(None, 1, None)), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_changed_etag_is_a_miss_and_storing_it_drops_the_old_version() {
        let (c, dir) = cache(1 << 20, 1 << 19, 1 << 20);
        assert!(!c.has_any("p", "b", "doc.md"));
        assert!(c.store_bytes("p", "b", "doc.md", &id("v1", 5), b"hello"));
        assert!(c.has_any("p", "b", "doc.md"));
        assert_eq!(c.read("p", "b", "doc.md", &id("v1", 5)).as_deref(), Some(&b"hello"[..]));
        // the file changed on the server: another ETag, nothing to serve
        assert_eq!(c.read("p", "b", "doc.md", &id("v2", 5)), None);
        assert_eq!(c.lookup("p", "b", "doc.md", &id("v2", 5)), None);
        // the same ETag with another size can't be the same bytes either
        assert_eq!(c.lookup("p", "b", "doc.md", &id("v1", 6)), None);

        assert!(c.store_bytes("p", "b", "doc.md", &id("v2", 6), b"hello!"));
        assert_eq!(c.read("p", "b", "doc.md", &id("v1", 5)), None, "the old version went");
        assert_eq!(c.read("p", "b", "doc.md", &id("v2", 6)).as_deref(), Some(&b"hello!"[..]));
        assert_eq!(c.usage(), 6);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stores_are_atomic_and_refuse_what_cant_be_right() {
        let (c, dir) = cache(1 << 20, 1 << 19, 10);
        // bytes that don't match the size the server reported are never kept
        assert!(!c.store_bytes("p", "b", "k", &id("e", 4), b"abc"));
        // too big for one entry: not kept, and an older version goes
        assert!(c.store_bytes("p", "b", "k", &id("e", 3), b"abc"));
        assert!(!c.store_bytes("p", "b", "k", &id("f", 11), &[0u8; 11]));
        assert!(!c.has_any("p", "b", "k"));
        // no ETag and no time: not kept
        assert!(!c.store_bytes("p", "b", "k", &Ident::new(None, 3, None), b"abc"));
        // nothing is left half-written in tmp/
        assert_eq!(std::fs::read_dir(dir.join(TMP)).unwrap().count(), 0);

        // a file copy (a finished download)
        let src = dir.join("download.bin");
        std::fs::write(&src, b"0123456789").unwrap();
        assert!(c.store_file("p", "b", "dl", &id("x", 10), &src));
        assert!(!c.store_file("p", "b", "dl2", &id("x", 9), &src), "size mismatch");
        assert_eq!(c.read("p", "b", "dl", &id("x", 10)).as_deref(), Some(&b"0123456789"[..]));

        // a write that dies midway leaves nothing behind and nothing to serve
        assert!(!c.store_with("p", "b", "k2", &id("e", 3), |tmp| {
            let mut f = private_file(tmp)?;
            f.write_all(b"a")?;
            Err(std::io::Error::other("disk full"))
        }));
        assert!(!c.has_any("p", "b", "k2"));
        assert_eq!(std::fs::read_dir(dir.join(TMP)).unwrap().count(), 0);

        // a truncated entry (say, a crash before the data reached the disk) is never served
        let e = c.entry("p", "b", "dl", &id("x", 10)).unwrap();
        std::fs::write(&e, b"01234").unwrap();
        assert_eq!(c.read("p", "b", "dl", &id("x", 10)), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn only_the_owner_can_read_the_cache() {
        use std::os::unix::fs::PermissionsExt;
        let (c, dir) = cache(1 << 20, 1 << 19, 1 << 20);
        c.store_bytes("p", "b", "secret.txt", &id("e", 3), b"abc");
        let e = c.entry("p", "b", "secret.txt", &id("e", 3)).unwrap();
        assert_eq!(std::fs::metadata(&e).unwrap().permissions().mode() & 0o777, 0o600);
        for d in [dir.clone(), e.parent().unwrap().to_path_buf(), e.parent().unwrap().parent().unwrap().to_path_buf()] {
            assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700, "{d:?}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_least_recently_used_go_first() {
        let (c, dir) = cache(30, 20, 30);
        let past = |k: &str, secs: i64| {
            let e = c.entry("p", "b", k, &id("e", 10)).unwrap();
            filetime::set_file_mtime(e, filetime::FileTime::from_unix_time(1_700_000_000 + secs, 0)).unwrap();
        };
        c.store_bytes("p", "b", "a", &id("e", 10), &[1; 10]);
        past("a", 0);
        c.store_bytes("p", "b", "b", &id("e", 10), &[2; 10]);
        past("b", 10);
        c.store_bytes("p", "b", "c", &id("e", 10), &[3; 10]);
        past("c", 20);
        // reading "a" makes it the most recently used
        assert!(c.lookup("p", "b", "a", &id("e", 10)).is_some());
        assert_eq!(c.usage(), 30);
        // past the cap: trimmed back to 20, oldest first ("b", then "c")
        c.store_bytes("p", "b", "d", &id("e", 10), &[4; 10]);
        assert_eq!(c.usage(), 20);
        assert!(c.has_any("p", "b", "a"));
        assert!(!c.has_any("p", "b", "b"), "its folder goes with its last version");
        assert!(!c.has_any("p", "b", "c"));
        assert!(c.has_any("p", "b", "d"));
        // the count kept in memory agrees with the disk
        assert_eq!(c.scan_total(), 20);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn connections_and_everything_can_be_dropped() {
        let (c, dir) = cache(1 << 20, 1 << 19, 1 << 20);
        c.store_bytes("p", "b", "k", &id("e", 3), b"abc");
        c.store_bytes("q", "b", "k", &id("e", 4), b"abcd");
        c.forget_profile("p");
        assert!(!c.has_any("p", "b", "k"));
        assert!(c.has_any("q", "b", "k"));
        assert_eq!(c.usage(), 4);
        // leftovers of a crash in tmp/ go at start-up
        std::fs::write(dir.join(TMP).join("half"), b"x").unwrap();
        c.prune();
        assert_eq!(std::fs::read_dir(dir.join(TMP)).unwrap().count(), 0);
        assert_eq!(c.clear(), 4);
        assert_eq!(c.usage(), 0);
        assert!(!c.has_any("q", "b", "k"));
        // still usable after a clear
        assert!(c.store_bytes("q", "b", "k", &id("e", 3), b"abc"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_download_is_served_from_the_cache_by_copy() {
        let (c, dir) = cache(1 << 20, 1 << 19, 1 << 20);
        c.store_bytes("p", "b", "k", &id("e", 5), b"hello");
        let src = c.lookup("p", "b", "k", &id("e", 5)).unwrap();
        let dest = dir.join("out/hello.txt");
        let part = crate::dest::part_path(&dest);
        let done = std::sync::atomic::AtomicU64::new(0);
        assert!(copy_file(&src, &dest, &part, &done, &AtomicBool::new(false)).unwrap());
        assert_eq!(std::fs::read(&part).unwrap(), b"hello");
        assert_eq!(done.load(Ordering::Relaxed), 5);
        // a cancel stops it
        assert!(!copy_file(&src, &dest, &part, &done, &AtomicBool::new(true)).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }
}
