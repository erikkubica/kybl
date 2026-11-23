//! This computer's (or phone's) own files as a [`Storage`], under the reserved connection id
//! [`super::registry::LOCAL_ID`]. Roots are the usual folders (Home, Desktop, Documents, Downloads) and
//! disks on a computer, the app's Documents folder on iOS (what Files shows as "On My iPhone ›
//! Kybl") and the download folder on Android. A root's id is its absolute path.
//!
//! Nothing outside a root can be reached: keys with `..`, absolute paths and symbolic links that
//! lead out of the root are refused. On a computer, deleting moves things to the Trash.

use std::{
    io::{self, SeekFrom},
    ops::Range,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::*;

mod fsops;
use fsops::{canon_lossy, check_not_into_itself, copy_tree, remove_copied, rename_noreplace, through_link, Copied};

const CHUNK: usize = 256 * 1024;
/// Clutter the system leaves in folders; never shown.
const HIDDEN: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

#[derive(Clone, Debug)]
struct LocalRoot {
    info: RootInfo,
    /// the root with every symbolic link resolved, to check paths against
    canon: PathBuf,
}

pub struct LocalBackend {
    fixed: Vec<LocalRoot>,
    /// disks and drive letters come and go, so they are looked up each time
    scan_volumes: bool,
    #[cfg_attr(mobile, allow(dead_code))]
    use_trash: bool,
    caps: Capabilities,
}

pub fn local_caps(trash: bool) -> Capabilities {
    Capabilities {
        roots: RootsMode::Drives,
        folders: FolderMode::Real,
        rename: RenameMode::Native,
        server_copy: ServerCopy::CrossRoot,
        streaming: StreamingMode::Proxy,
        range_read: true,
        conditional_write: CondWrite::Compare,
        thumbnails: ThumbMode::Local,
        trash,
        local_paths: true,
        ..Capabilities::default()
    }
}

fn outside() -> StorageError {
    StorageError::new(ErrKind::PermissionDenied, "That place is outside the folders Kybl can open here.")
}

fn millis_of(t: io::Result<SystemTime>) -> Option<i64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// A stand-in ETag: changes whenever the file's size or modification time does.
fn weak_etag(size: u64, modified: Option<i64>) -> String {
    format!("{:x}-{:x}", modified.unwrap_or(0), size)
}

fn file_entry(key: String, meta: &std::fs::Metadata) -> Entry {
    let modified = millis_of(meta.modified());
    Entry {
        etag: Some(weak_etag(meta.len(), modified)),
        size: meta.len() as i64,
        modified,
        key,
        ..Default::default()
    }
}

/// A link to a folder (or to something that isn't a file): listed so it can be seen, as a
/// file-like entry, never as a folder to go into.
fn link_entry(key: String, meta: &std::fs::Metadata) -> Entry {
    let modified = millis_of(meta.modified());
    Entry { etag: Some(weak_etag(0, modified)), size: 0, modified, key, mime: Some("inode/symlink".into()), ..Default::default() }
}

/// Windows answers `canonicalize` with `\\?\C:\…`, which nobody wants to see (or join with `/`).
fn plain(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => s.into_owned(),
    }
}

/// The parts of a key, refusing anything that could step outside the root.
fn parts(key: &str) -> SResult<Vec<&str>> {
    let key = key.strip_suffix('/').unwrap_or(key);
    if key.is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for part in key.split('/') {
        let bad = part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\0')
            || (cfg!(windows) && (part.contains('\\') || part.contains(':')));
        if bad {
            return Err(outside());
        }
        // a part that is itself a path ("C:" or "/x") would replace what it is joined to
        let mut comps = Path::new(part).components();
        if !matches!((comps.next(), comps.next()), (Some(Component::Normal(_)), None)) {
            return Err(outside());
        }
        out.push(part);
    }
    Ok(out)
}

/// Checks that `p` stays inside `root` once symbolic links are followed. With `follow_last`
/// false, `p` itself may be a link (it is what gets deleted or renamed, not where it points).
fn confine(root: &Path, p: &Path, follow_last: bool) -> SResult<()> {
    let mut probe = if follow_last { p.to_path_buf() } else { p.parent().map(Path::to_path_buf).unwrap_or_else(|| p.to_path_buf()) };
    loop {
        match std::fs::canonicalize(&probe) {
            Ok(real) => return if real.starts_with(root) { Ok(()) } else { Err(outside()) },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                // a link to nowhere: writing through it would create its target, wherever that is
                if std::fs::symlink_metadata(&probe).is_ok() {
                    return Err(outside());
                }
                if !probe.pop() {
                    return Err(outside());
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// A move to another disk: copy, then remove the originals of exactly what was copied. Never
/// the whole folder: something left out, or added meanwhile, would go with it.
fn move_across(src: &Path, dst: &Path) -> SResult<()> {
    let mut done = Copied::default();
    copy_tree(src, dst, false, &mut done)?;
    remove_copied(&done).map_err(|e| StorageError::from(e).with_detail("Copied, but removing the original failed."))?;
    left_behind(&done.skipped)
}

/// Special system files (pipes, sockets, devices) aren't copied; say which stayed behind.
fn left_behind(skipped: &[PathBuf]) -> SResult<()> {
    if skipped.is_empty() {
        return Ok(());
    }
    let n = skipped.len();
    let what = if n == 1 { "1 special system item (like a pipe or a device) was".to_string() } else { format!("{n} special system items (like pipes or devices) were") };
    Err(StorageError::new(ErrKind::Unsupported, format!("Everything else was done, but {what} left where it was."))
        .with_detail(skipped.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("\n")))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> SResult<T> + Send + 'static) -> SResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| StorageError::other(e.to_string()))?
}

impl LocalBackend {
    /// A backend over the given folders: (name, kind, path). Folders that don't exist are left out.
    pub fn with_roots(roots: Vec<(String, RootKind, PathBuf)>, use_trash: bool) -> Self {
        let mut fixed: Vec<LocalRoot> = Vec::new();
        for (name, kind, path) in roots {
            let Ok(canon) = std::fs::canonicalize(&path) else { continue };
            if !canon.is_dir() {
                continue;
            }
            let id = plain(&canon);
            if fixed.iter().any(|r| r.info.id == id) {
                continue;
            }
            fixed.push(LocalRoot { info: RootInfo { id, name, kind, created: None, read_only: false }, canon });
        }
        Self { fixed, scan_volumes: false, use_trash, caps: local_caps(use_trash) }
    }

    /// The folders of this device.
    pub async fn system<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        #[allow(unused_variables)]
        let paths = app.path();
        #[cfg(desktop)]
        {
            let mut roots = Vec::new();
            for (name, kind, dir) in [
                ("Home", RootKind::Home, paths.home_dir()),
                ("Desktop", RootKind::Desktop, paths.desktop_dir()),
                ("Documents", RootKind::Documents, paths.document_dir()),
                ("Downloads", RootKind::Downloads, paths.download_dir()),
            ] {
                if let Ok(d) = dir {
                    roots.push((name.to_string(), kind, d));
                }
            }
            let mut me = Self::with_roots(roots, true);
            me.scan_volumes = true;
            Ok(me)
        }
        #[cfg(target_os = "ios")]
        {
            let dir = paths.document_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            Ok(Self::with_roots(vec![("Kybl".to_string(), RootKind::Documents, dir)], false))
        }
        #[cfg(target_os = "android")]
        {
            let app = crate::platform::app().ok_or("Kybl isn't ready yet. Try again in a moment.")?;
            let dir = crate::platform::android::download_dir(app).await?;
            Ok(Self::with_roots(vec![("Downloads".to_string(), RootKind::Downloads, dir)], false))
        }
    }

    fn all_roots(&self) -> Vec<LocalRoot> {
        let mut all = self.fixed.clone();
        if self.scan_volumes {
            for (name, path) in volumes() {
                let Ok(canon) = std::fs::canonicalize(&path) else { continue };
                let id = plain(&canon);
                if all.iter().any(|r| r.info.id == id) {
                    continue;
                }
                all.push(LocalRoot { info: RootInfo { id, name, kind: RootKind::Volume, created: None, read_only: false }, canon });
            }
        }
        all
    }

    fn root(&self, id: &str) -> SResult<LocalRoot> {
        if let Some(r) = self.fixed.iter().find(|r| r.info.id == id) {
            return Ok(r.clone());
        }
        self.all_roots()
            .into_iter()
            .find(|r| r.info.id == id)
            .ok_or_else(|| StorageError::new(ErrKind::NotFound, "This folder or disk isn't available any more."))
    }

    /// The real path of `key` in `root` (no checks against links yet; see [`confine`]).
    fn join(&self, root: &str, key: &str) -> SResult<(PathBuf, PathBuf)> {
        let r = self.root(root)?;
        let mut p = r.canon.clone();
        for part in parts(key)? {
            p.push(part);
        }
        Ok((r.canon, p))
    }

    /// `key`'s own path (a link itself, not where it points) for deleting or moving it: inside
    /// the root, and not reached through a linked folder, which would act on whatever that
    /// folder really is instead of on what was picked.
    async fn resolve_own(&self, root: &str, key: &str) -> SResult<PathBuf> {
        let (canon, p) = self.join(root, key)?;
        let q = p.clone();
        blocking(move || {
            confine(&canon, &q, false)?;
            if through_link(&canon, &q) {
                return Err(StorageError::new(
                    ErrKind::PermissionDenied,
                    "This is inside a linked folder, so Kybl won't change it from here. Open the folder the link points to instead.",
                ));
            }
            Ok(())
        })
        .await?;
        Ok(p)
    }

    /// `key`'s path, checked to stay inside the root.
    async fn resolve(&self, root: &str, key: &str, follow_last: bool) -> SResult<PathBuf> {
        let (canon, p) = self.join(root, key)?;
        let q = p.clone();
        blocking(move || confine(&canon, &q, follow_last)).await?;
        Ok(p)
    }

    async fn stat_path(&self, key: &str, p: PathBuf) -> SResult<Option<Entry>> {
        let key = key.strip_suffix('/').unwrap_or(key).to_string();
        blocking(move || match std::fs::symlink_metadata(&p) {
            // a link to a folder is a file-like entry here too (see `list`)
            Ok(l) if l.file_type().is_symlink() => match std::fs::metadata(&p) {
                Ok(m) if m.is_file() => {
                    let mut e = file_entry(key, &m);
                    e.mime = Some(mime_guess::from_path(&p).first_or_octet_stream().to_string());
                    Ok(Some(e))
                }
                Ok(_) => Ok(Some(link_entry(key, &l))),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
            Ok(m) if m.is_dir() => Ok(Some(Entry { key: if key.is_empty() { key } else { format!("{key}/") }, modified: millis_of(m.modified()), ..Default::default() })),
            Ok(m) => {
                let mut e = file_entry(key, &m);
                e.mime = Some(mime_guess::from_path(&p).first_or_octet_stream().to_string());
                Ok(Some(e))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        })
        .await
    }

    async fn precondition_fails(&self, root: &str, path: &str, pre: &Precondition) -> SResult<Option<WriteOutcome>> {
        if *pre == Precondition::None {
            return Ok(None);
        }
        let now = self.stat(root, path).await?;
        let holds = match (pre, &now) {
            (Precondition::IfNoneMatch, cur) => cur.is_none(),
            (Precondition::IfMatch(tag), Some(cur)) => cur.etag.as_deref() == Some(tag.as_str()),
            (Precondition::IfUnchanged { etag: Some(tag), .. }, Some(cur)) => cur.etag.as_deref() == Some(tag.as_str()),
            (Precondition::IfUnchanged { etag: None, size, modified }, Some(cur)) => cur.size == *size && cur.modified == *modified,
            _ => false,
        };
        Ok(if holds { None } else { Some(WriteOutcome::Conflict(now)) })
    }

    async fn remove(&self, p: PathBuf, is_dir: bool) -> SResult<()> {
        #[cfg(desktop)]
        if self.use_trash {
            return blocking(move || match std::fs::symlink_metadata(&p) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                _ => trash::delete(&p).map_err(|e| StorageError::other("Couldn't move this to the Trash.").with_detail(e.to_string())),
            })
            .await;
        }
        let r = if is_dir && !std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            tokio::fs::remove_dir_all(&p).await
        } else {
            tokio::fs::remove_file(&p).await
        };
        match r {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

/// Disks other than the system one, and the system disk itself.
#[cfg(desktop)]
fn volumes() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let mut system = "Macintosh HD".to_string();
        if let Ok(rd) = std::fs::read_dir("/Volumes") {
            for e in rd.flatten() {
                let path = e.path();
                let name = e.file_name().to_string_lossy().into_owned();
                // the system disk appears here as a link to "/"
                if std::fs::read_link(&path).is_ok_and(|t| t == Path::new("/")) {
                    system = name;
                } else if path.is_dir() && !name.starts_with('.') {
                    out.push((name, path));
                }
            }
        }
        out.insert(0, (system, PathBuf::from("/")));
    }
    #[cfg(target_os = "windows")]
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).is_dir() {
            out.push((format!("{}:", letter as char), PathBuf::from(root)));
        }
    }
    #[cfg(target_os = "linux")]
    {
        out.push(("File system".to_string(), PathBuf::from("/")));
        let user = std::env::var("USER").unwrap_or_default();
        for base in [format!("/media/{user}"), format!("/run/media/{user}"), "/mnt".to_string()] {
            if let Ok(rd) = std::fs::read_dir(&base) {
                for e in rd.flatten() {
                    if e.path().is_dir() {
                        out.push((e.file_name().to_string_lossy().into_owned(), e.path()));
                    }
                }
            }
        }
    }
    out
}

#[cfg(mobile)]
fn volumes() -> Vec<(String, PathBuf)> {
    Vec::new()
}

#[async_trait]
impl Storage for LocalBackend {
    fn kind(&self) -> ConnKind {
        ConnKind::Local
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        Ok(self.all_roots().into_iter().map(|r| r.info).collect())
    }

    /// Folders first, then files, each in name order; 1,000 a page. Each page is read afresh and
    /// starts after the last name the previous one sent (see [`net::page_after`]), so files
    /// coming and going meanwhile can't make a walk skip others. Links show as files (a link to a
    /// file with that file's size and time) and are never descended into: a walk or a move of a
    /// folder stays inside it.
    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let p = self.resolve(root, dir, true).await?;
        let prefix = match dir.strip_suffix('/').unwrap_or(dir) {
            "" => String::new(),
            d => format!("{d}/"),
        };
        blocking(move || {
            let mut folders = Vec::new();
            let mut files = Vec::new();
            for e in std::fs::read_dir(&p)? {
                let e = e?;
                // a name that isn't valid UTF-8 couldn't be asked for again
                let Ok(name) = e.file_name().into_string() else { continue };
                if HIDDEN.contains(&name.as_str()) {
                    continue;
                }
                // gone since the folder was read: skip it; any other error fails the listing, so
                // a sync never takes a file it couldn't look at for a deleted one
                let meta = match std::fs::symlink_metadata(e.path()) {
                    Ok(m) => m,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                let key = format!("{prefix}{name}");
                if meta.file_type().is_symlink() {
                    match std::fs::metadata(e.path()) {
                        Ok(target) if target.is_file() => files.push(file_entry(key, &target)),
                        Ok(_) => files.push(link_entry(key, &meta)),
                        // a broken link has nothing to show
                        Err(_) => {}
                    }
                } else if meta.is_dir() {
                    folders.push(format!("{key}/"));
                } else {
                    files.push(file_entry(key, &meta));
                }
            }
            net::sort_listing(&mut folders, &mut files);
            Ok(net::page_after(&folders, &files, token.as_deref()))
        })
        .await
    }

    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        let p = self.resolve(root, path, true).await?;
        self.stat_path(path, p).await
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        let p = self.resolve(root, path, true).await?;
        // a pipe or device would block opening (or never end): only plain files and folders
        let q = p.clone();
        let kind = blocking(move || Ok(std::fs::metadata(&q)?.file_type())).await?;
        if !kind.is_file() && !kind.is_dir() {
            return Err(StorageError::new(ErrKind::Unsupported, "This is a special system file (like a pipe or a device), not a file Kybl can read."));
        }
        let mut file = tokio::fs::File::open(&p).await?;
        let meta = file.metadata().await?;
        if meta.is_dir() {
            return Err(StorageError::new(ErrKind::Other, "This is a folder, not a file."));
        }
        let size = meta.len();
        let etag = weak_etag(size, millis_of(meta.modified()));
        if if_match.is_some_and(|t| t != etag) {
            return Err(StorageError::conflict());
        }
        let (start, end) = match &range {
            Some(r) => (r.start.min(size), r.end.min(size).max(r.start.min(size))),
            None => (0, size),
        };
        if start > 0 {
            file.seek(SeekFrom::Start(start)).await?;
        }
        let left = end - start;
        let body = futures_util::stream::unfold((file, left), |(mut f, left)| async move {
            if left == 0 {
                return None;
            }
            let mut buf = BytesMut::zeroed(CHUNK.min(left as usize));
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    Some((Ok(buf.freeze()), (f, left - n as u64)))
                }
                Err(e) => Some((Err(e), (f, 0))),
            }
        });
        Ok(ReadStream {
            body: Box::pin(body),
            len: Some(left),
            total: Some(size),
            range: range.map(|_| start..end),
            etag: Some(etag),
            content_type: Some(mime_guess::from_path(&p).first_or_octet_stream().to_string()),
        })
    }

    /// Written next to the target under a temporary name and renamed over it once whole, so a
    /// half-written file never takes the real name.
    async fn write(
        &self,
        root: &str,
        path: &str,
        src: WriteSource,
        opts: WriteOpts<'_>,
        progress: Progress<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> SResult<WriteOutcome> {
        if path.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("A file needs a name."));
        }
        let target = self.resolve(root, path, true).await?;
        if let Some(conflict) = self.precondition_fails(root, path, &opts.precondition).await? {
            return Ok(conflict);
        }
        let parent = target.parent().ok_or_else(outside)?.to_path_buf();
        tokio::fs::create_dir_all(&parent).await?;
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = parent.join(format!(".{name}.kybl-{}", uuid::Uuid::new_v4()));

        let result: SResult<bool> = async {
            let mut out = tokio::fs::File::create(&tmp).await?;
            let (mut body, total): (ByteStream, Option<u64>) = match src {
                WriteSource::Path(p) => {
                    let f = tokio::fs::File::open(&p).await?;
                    let len = f.metadata().await?.len();
                    let s = futures_util::stream::unfold(f, |mut f| async move {
                        let mut buf = BytesMut::zeroed(CHUNK);
                        match f.read(&mut buf).await {
                            Ok(0) => None,
                            Ok(n) => {
                                buf.truncate(n);
                                Some((Ok(buf.freeze()), f))
                            }
                            Err(e) => Some((Err(e), f)),
                        }
                    });
                    (Box::pin(s), Some(len))
                }
                WriteSource::Bytes(b) => {
                    let n = b.len() as u64;
                    (Box::pin(futures_util::stream::iter([Ok::<Bytes, io::Error>(b)])), Some(n))
                }
                WriteSource::Stream { len, body, .. } => (body, len),
            };
            let mut done = 0u64;
            let mut last = Instant::now();
            progress(0, total.unwrap_or(0));
            while let Some(chunk) = body.next().await {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(false);
                }
                let chunk = chunk?;
                out.write_all(&chunk).await?;
                done += chunk.len() as u64;
                if last.elapsed() > Duration::from_millis(150) {
                    progress(done, total.unwrap_or(done));
                    last = Instant::now();
                }
            }
            out.flush().await?;
            let out = out.into_std().await;
            let when = opts.modified.map(|ms| UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64));
            blocking(move || {
                if let Some(t) = when {
                    let _ = out.set_modified(t);
                }
                out.sync_all()?;
                Ok(())
            })
            .await?;
            progress(done, total.unwrap_or(done));
            Ok(true)
        }
        .await;
        match result {
            Ok(true) => {
                // "only if nothing is there" must still hold at the very end: a file that
                // appeared while this one was being written is never replaced
                let exclusive = opts.precondition == Precondition::IfNoneMatch;
                let (t, d) = (tmp.clone(), target.clone());
                let placed = blocking(move || Ok(if exclusive { rename_noreplace(&t, &d) } else { std::fs::rename(&t, &d) })).await?;
                if let Err(e) = placed {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    if e.kind() == io::ErrorKind::AlreadyExists {
                        return Ok(WriteOutcome::Conflict(self.stat(root, path).await?));
                    }
                    return Err(e.into());
                }
                let entry = self.stat_path(path, target).await?.unwrap_or_default();
                Ok(WriteOutcome::Done(entry))
            }
            Ok(false) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Ok(WriteOutcome::Cancelled)
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()> {
        let p = self.resolve(root, dir, true).await?;
        tokio::fs::create_dir_all(&p).await?;
        Ok(())
    }

    async fn delete(
        &self,
        root: &str,
        files: &[String],
        dirs: &[String],
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> SResult<(u64, u64)> {
        let total = (files.len() + dirs.len()) as u64;
        let mut done = 0u64;
        on_progress(0, total);
        let items = files.iter().map(|f| (f, false)).chain(dirs.iter().map(|d| (d, true)));
        for (key, is_dir) in items {
            if cancel.load(Ordering::Relaxed) {
                return Err(StorageError::cancelled());
            }
            if parts(key)?.is_empty() {
                return Err(StorageError::other("The top of a folder list can't be deleted."));
            }
            let p = self.resolve_own(root, key).await?;
            self.remove(p, is_dir).await?;
            done += 1;
            on_progress(done, total);
        }
        Ok((done, total))
    }

    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        let src = self.resolve(&from.root, &from.path, true).await?;
        let dst = self.resolve(&to.root, &to.path, true).await?;
        if src == dst {
            return Err(StorageError::other("Source and destination are the same"));
        }
        blocking(move || {
            if is_dir && check_not_into_itself(&src, &dst)? {
                return Err(StorageError::other("Cannot copy a folder into itself"));
            }
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut done = Copied::default();
            copy_tree(&src, &dst, true, &mut done)?;
            left_behind(&done.skipped)
        })
        .await
    }

    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        if parts(&from.path)?.is_empty() {
            return Err(StorageError::other("The top of a folder list can't be moved."));
        }
        let src = self.resolve_own(&from.root, &from.path).await?;
        let dst = self.resolve(&to.root, &to.path, false).await?;
        if src == dst {
            return Err(StorageError::other("Source and destination are the same"));
        }
        let (s, d) = (src.clone(), dst.clone());
        // (the same folder under another spelling is a case-only rename on a case-blind disk, not a move into itself)
        if is_dir && blocking(move || Ok(check_not_into_itself(&s, &d)? && std::fs::canonicalize(&s).ok() != Some(canon_lossy(&d)))).await? {
            return Err(StorageError::other("Cannot move a folder into itself"));
        }
        if let Some(parent) = dst.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        match tokio::fs::rename(&src, &dst).await {
            Ok(()) => Ok(()),
            // another disk: copy, then remove the original once the copy is whole
            // another disk
            Err(e) if e.kind() == io::ErrorKind::CrossesDevices => blocking(move || move_across(&src, &dst)).await,
            Err(e) => Err(e.into()),
        }
    }

    fn local_path(&self, root: &str, path: &str) -> Option<PathBuf> {
        let (canon, p) = self.join(root, path).ok()?;
        confine(&canon, &p, true).ok()?;
        Some(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn setup() -> (Tmp, LocalBackend, String) {
        let base = std::env::temp_dir().join(format!("kybl-local-{}", uuid::Uuid::new_v4()));
        let root = base.join("root");
        std::fs::create_dir_all(root.join("docs/deep")).unwrap();
        std::fs::write(root.join("a.txt"), b"hello world").unwrap();
        std::fs::write(root.join("docs/b.md"), b"# b").unwrap();
        std::fs::write(root.join("docs/deep/c.bin"), vec![7u8; 3000]).unwrap();
        std::fs::write(root.join(".DS_Store"), b"x").unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        std::fs::write(base.join("outside/secret.txt"), b"secret").unwrap();
        let b = LocalBackend::with_roots(vec![("Test".into(), RootKind::Folder, root)], false);
        let id = b.fixed[0].info.id.clone();
        (Tmp(base), b, id)
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    fn no_progress(_: u64, _: u64) {}

    #[test]
    fn lists_folders_then_files_and_hides_clutter() {
        let (_t, b, root) = setup();
        rt().block_on(async {
            let roots = b.roots().await.unwrap();
            assert_eq!(roots.len(), 1);
            assert_eq!(roots[0].name, "Test");
            let page = b.list(&root, "", None).await.unwrap();
            assert_eq!(page.folders, vec!["docs/"]);
            assert_eq!(page.objects.iter().map(|o| o.key.as_str()).collect::<Vec<_>>(), vec!["a.txt"]);
            assert_eq!(page.objects[0].size, 11);
            assert!(page.objects[0].etag.is_some());
            let page = b.list(&root, "docs/", None).await.unwrap();
            assert_eq!(page.folders, vec!["docs/deep/"]);
            assert_eq!(page.objects[0].key, "docs/b.md");
            assert!(b.list("/somewhere/else", "", None).await.is_err(), "only known roots");
        });
    }

    #[test]
    fn walks_everything_below() {
        let (_t, b, root) = setup();
        rt().block_on(async {
            let mut keys = Vec::new();
            let mut w = b.walk(&root, "docs/");
            while let Some(batch) = w.next().await {
                keys.extend(batch.unwrap().into_iter().map(|e| e.key));
            }
            keys.sort();
            assert_eq!(keys, vec!["docs/b.md", "docs/deep/", "docs/deep/c.bin"]);
        });
    }

    #[test]
    fn pages_big_folders() {
        let (t, b, root) = setup();
        let big = t.0.join("root/big");
        std::fs::create_dir_all(big.join("sub")).unwrap();
        for i in 0..1500 {
            std::fs::write(big.join(format!("f{i:04}")), b"").unwrap();
        }
        rt().block_on(async {
            let p1 = b.list(&root, "big/", None).await.unwrap();
            assert_eq!(p1.folders, vec!["big/sub/"]);
            assert_eq!(p1.objects.len(), 999);
            let p2 = b.list(&root, "big/", p1.next_token.clone()).await.unwrap();
            assert!(p2.folders.is_empty());
            assert_eq!(p2.objects.len(), 501);
            assert!(p2.next_token.is_none());
            assert_eq!(p2.objects.last().unwrap().key, "big/f1499");
        });
    }

    #[test]
    fn reads_whole_and_ranges() {
        let (_t, b, root) = setup();
        rt().block_on(async {
            let r = b.read(&root, "a.txt", None, None).await.unwrap();
            assert_eq!(r.total, Some(11));
            assert_eq!(r.collect(100).await.unwrap(), b"hello world");
            let r = b.read(&root, "a.txt", Some(6..100), None).await.unwrap();
            assert_eq!(r.range, Some(6..11));
            assert_eq!(r.collect(100).await.unwrap(), b"world");
            assert!(b.read(&root, "a.txt", None, Some("nope")).await.is_err_and(|e| e.kind == ErrKind::Conflict));
            assert!(b.read(&root, "docs/deep/c.bin", None, None).await.unwrap().collect(100).await.is_err_and(|e| e.kind == ErrKind::TooLarge));
            assert!(b.read(&root, "missing", None, None).await.is_err_and(|e| e.kind == ErrKind::NotFound));
        });
    }

    #[test]
    fn writes_and_checks_preconditions() {
        let (t, b, root) = setup();
        let cancel = Arc::new(AtomicBool::new(false));
        rt().block_on(async {
            let out = b.write(&root, "new/n.txt", WriteSource::Bytes(Bytes::from_static(b"abc")), WriteOpts::default(), &no_progress, &cancel).await.unwrap();
            let WriteOutcome::Done(e) = out else { panic!("written") };
            assert_eq!((e.key.as_str(), e.size), ("new/n.txt", 3));
            assert_eq!(std::fs::read(t.0.join("root/new/n.txt")).unwrap(), b"abc");

            let pre = WriteOpts { precondition: Precondition::IfNoneMatch, ..Default::default() };
            let out = b.write(&root, "new/n.txt", WriteSource::Bytes(Bytes::from_static(b"x")), pre, &no_progress, &cancel).await.unwrap();
            assert!(matches!(out, WriteOutcome::Conflict(Some(_))), "already there");
            let pre = WriteOpts { precondition: Precondition::IfMatch(e.etag.clone().unwrap()), modified: Some(1_000_000), ..Default::default() };
            let out = b.write(&root, "new/n.txt", WriteSource::Bytes(Bytes::from_static(b"abcd")), pre, &no_progress, &cancel).await.unwrap();
            let WriteOutcome::Done(e2) = out else { panic!("unchanged, so written") };
            assert_eq!(e2.modified, Some(1_000_000));

            // from a file and from a stream
            let src = t.0.join("outside/secret.txt");
            b.write(&root, "copy.txt", WriteSource::Path(src), WriteOpts::default(), &no_progress, &cancel).await.unwrap();
            assert_eq!(std::fs::read(t.0.join("root/copy.txt")).unwrap(), b"secret");
            let body: ByteStream = Box::pin(futures_util::stream::iter([Ok(Bytes::from_static(b"st")), Ok(Bytes::from_static(b"ream"))]));
            b.write(&root, "s.txt", WriteSource::Stream { len: None, body, reopen: None }, WriteOpts::default(), &no_progress, &cancel).await.unwrap();
            assert_eq!(std::fs::read(t.0.join("root/s.txt")).unwrap(), b"stream");

            // cancelled: nothing left behind
            let stop = Arc::new(AtomicBool::new(true));
            let out = b.write(&root, "c.txt", WriteSource::Bytes(Bytes::from_static(b"x")), WriteOpts::default(), &no_progress, &stop).await.unwrap();
            assert!(matches!(out, WriteOutcome::Cancelled));
            assert!(!t.0.join("root/c.txt").exists());
            let left: Vec<_> = std::fs::read_dir(t.0.join("root")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".kybl-")).collect();
            assert!(left.is_empty(), "{left:?}");
        });
    }

    #[test]
    fn makes_renames_copies_and_deletes() {
        let (t, b, root) = setup();
        let never = AtomicBool::new(false);
        rt().block_on(async {
            b.mkdir(&root, "x/y/").await.unwrap();
            assert!(t.0.join("root/x/y").is_dir());
            b.rename(&Loc::new(&root, "a.txt"), &Loc::new(&root, "x/a2.txt"), false).await.unwrap();
            assert!(!t.0.join("root/a.txt").exists() && t.0.join("root/x/a2.txt").exists());
            b.rename(&Loc::new(&root, "docs/"), &Loc::new(&root, "x/docs/"), true).await.unwrap();
            assert!(t.0.join("root/x/docs/deep/c.bin").exists());
            assert!(b.rename(&Loc::new(&root, "x/"), &Loc::new(&root, "x/inner/"), true).await.is_err(), "not into itself");
            // a case-only rename (on a case-blind disk the new spelling is the folder itself)
            b.mkdir(&root, "photos/").await.unwrap();
            b.rename(&Loc::new(&root, "photos/"), &Loc::new(&root, "Photos/"), true).await.unwrap();
            let names: Vec<_> = std::fs::read_dir(t.0.join("root")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            assert!(names.contains(&"Photos".to_string()) && !names.contains(&"photos".to_string()), "{names:?}");
            std::fs::write(t.0.join("root/notes.txt"), b"n").unwrap();
            b.rename(&Loc::new(&root, "notes.txt"), &Loc::new(&root, "Notes.txt"), false).await.unwrap();
            assert_eq!(std::fs::read(t.0.join("root/Notes.txt")).unwrap(), b"n");
            b.copy(&Loc::new(&root, "x/docs/"), &Loc::new(&root, "docs2/"), true).await.unwrap();
            assert_eq!(std::fs::read(t.0.join("root/docs2/b.md")).unwrap(), b"# b");
            assert!(b.stat(&root, "x/docs/").await.unwrap().is_some_and(|e| e.is_dir()));
            assert!(b.stat(&root, "x/docs").await.unwrap().is_some_and(|e| e.is_dir()), "a file name that is a folder is still taken");
            assert!(b.stat(&root, "nope.txt").await.unwrap().is_none());

            let (done, total) = b.delete(&root, &["x/a2.txt".into(), "gone.txt".into()], &["docs2/".into()], &never, &no_progress).await.unwrap();
            assert_eq!((done, total), (3, 3));
            assert!(!t.0.join("root/x/a2.txt").exists() && !t.0.join("root/docs2").exists());
            assert!(b.delete(&root, &[], &["".into()], &never, &no_progress).await.is_err(), "never the root itself");
            let stop = AtomicBool::new(true);
            assert!(b.delete(&root, &["x/docs/b.md".into()], &[], &stop, &no_progress).await.is_err_and(|e| e.is_cancelled()));
            assert!(t.0.join("root/x/docs/b.md").exists());
        });
    }

    #[test]
    fn nothing_outside_the_root() {
        let (_t, b, root) = setup();
        let cancel = Arc::new(AtomicBool::new(false));
        let never = AtomicBool::new(false);
        rt().block_on(async {
            for key in ["../outside/secret.txt", "docs/../../outside/secret.txt", "/etc/passwd", "a//b", "./a.txt"] {
                assert!(b.read(&root, key, None, None).await.is_err_and(|e| e.kind == ErrKind::PermissionDenied), "{key}");
                assert!(b.write(&root, key, WriteSource::Bytes(Bytes::from_static(b"x")), WriteOpts::default(), &no_progress, &cancel).await.is_err(), "{key}");
                assert!(b.delete(&root, &[key.to_string()], &[], &never, &no_progress).await.is_err(), "{key}");
                assert!(b.local_path(&root, key).is_none(), "{key}");
            }
            assert!(b.list(&root, "../", None).await.is_err());
            assert!(b.rename(&Loc::new(&root, "a.txt"), &Loc::new(&root, "../stolen.txt"), false).await.is_err());
        });
    }

    #[cfg(unix)]
    #[test]
    fn links_out_of_the_root_are_refused() {
        let (t, b, root) = setup();
        let cancel = Arc::new(AtomicBool::new(false));
        let r = t.0.join("root");
        std::os::unix::fs::symlink(t.0.join("outside"), r.join("escape")).unwrap();
        std::os::unix::fs::symlink(t.0.join("outside/secret.txt"), r.join("secret-link")).unwrap();
        std::os::unix::fs::symlink(t.0.join("outside/not-yet.txt"), r.join("dangling")).unwrap();
        std::os::unix::fs::symlink(r.join("docs"), r.join("docs-link")).unwrap();
        rt().block_on(async {
            assert!(b.list(&root, "escape/", None).await.is_err());
            assert!(b.read(&root, "escape/secret.txt", None, None).await.is_err());
            assert!(b.read(&root, "secret-link", None, None).await.is_err());
            assert!(b.local_path(&root, "secret-link").is_none());
            let w = b.write(&root, "escape/planted.txt", WriteSource::Bytes(Bytes::from_static(b"x")), WriteOpts::default(), &no_progress, &cancel).await;
            assert!(w.is_err());
            assert!(!t.0.join("outside/planted.txt").exists());
            let w = b.write(&root, "dangling", WriteSource::Bytes(Bytes::from_static(b"x")), WriteOpts::default(), &no_progress, &cancel).await;
            assert!(w.is_err());
            assert!(!t.0.join("outside/not-yet.txt").exists());
            assert!(b.mkdir(&root, "escape/newdir/").await.is_err());
            assert!(!t.0.join("outside/newdir").exists());
            // a link that stays inside is fine
            assert_eq!(b.read(&root, "docs-link/b.md", None, None).await.unwrap().collect(10).await.unwrap(), b"# b");
            // deleting a link removes the link, never what it points to
            let never = AtomicBool::new(false);
            b.delete(&root, &["secret-link".into()], &["escape/".into()], &never, &no_progress).await.unwrap();
            assert!(t.0.join("outside/secret.txt").exists());
            assert!(!r.join("secret-link").exists() && !r.join("escape").exists());
        });
    }

    #[test]
    fn pages_carry_on_after_the_last_name() {
        let (t, b, root) = setup();
        let big = t.0.join("root/big");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..1500 {
            std::fs::write(big.join(format!("f{i:04}")), b"").unwrap();
        }
        rt().block_on(async {
            let p1 = b.list(&root, "big/", None).await.unwrap();
            assert_eq!(p1.objects.last().unwrap().key, "big/f0999");
            // files already listed go away before the next page is asked for
            for i in 0..300 {
                std::fs::remove_file(big.join(format!("f{i:04}"))).unwrap();
            }
            let p2 = b.list(&root, "big/", p1.next_token.clone()).await.unwrap();
            assert_eq!(p2.objects.first().unwrap().key, "big/f1000", "nothing skipped");
            assert_eq!(p2.objects.len(), 500);
            assert!(p2.next_token.is_none());
        });
    }

    #[cfg(unix)]
    #[test]
    fn links_inside_a_folder_are_never_gone_into() {
        let (t, b, root) = setup();
        let never = AtomicBool::new(false);
        let r = t.0.join("root");
        std::fs::create_dir_all(r.join("sel")).unwrap();
        std::fs::create_dir_all(r.join("other")).unwrap();
        std::fs::write(r.join("other/keep.txt"), b"keep").unwrap();
        std::fs::write(r.join("sel/own.txt"), b"own").unwrap();
        std::os::unix::fs::symlink(r.join("other"), r.join("sel/link")).unwrap();
        std::os::unix::fs::symlink(r.join("other/keep.txt"), r.join("sel/file-link")).unwrap();
        std::os::unix::fs::symlink(r.join("sel"), r.join("sel/loop")).unwrap();
        rt().block_on(async {
            let page = b.list(&root, "sel/", None).await.unwrap();
            assert!(page.folders.is_empty(), "{:?}", page.folders);
            let keys: Vec<_> = page.objects.iter().map(|o| o.key.as_str()).collect();
            assert_eq!(keys, vec!["sel/file-link", "sel/link", "sel/loop", "sel/own.txt"]);
            assert_eq!(page.objects[0].size, 4, "a link to a file shows that file");
            assert!(b.stat(&root, "sel/link").await.unwrap().is_some_and(|e| !e.is_dir()));

            let mut keys = Vec::new();
            let mut w = b.walk(&root, "sel/");
            while let Some(batch) = w.next().await {
                keys.extend(batch.unwrap().into_iter().map(|e| e.key));
            }
            assert!(keys.iter().all(|k| !k.contains("keep.txt") && !k.starts_with("sel/loop/")), "{keys:?}");

            // a move's clean-up can't reach through the link to what it points to
            assert!(b.delete(&root, &["sel/link/keep.txt".into()], &[], &never, &no_progress).await.is_err());
            assert!(b.rename(&Loc::new(&root, "sel/link/keep.txt"), &Loc::new(&root, "x.txt"), false).await.is_err());
            assert!(r.join("other/keep.txt").exists());
            // deleting the links themselves leaves their targets
            b.delete(&root, &["sel/link".into(), "sel/file-link".into()], &["sel/loop/".into()], &never, &no_progress).await.unwrap();
            assert_eq!(std::fs::read(r.join("other/keep.txt")).unwrap(), b"keep");
            assert!(r.join("sel/own.txt").exists());
        });
    }

    #[test]
    fn only_if_absent_holds_to_the_end() {
        let (t, b, root) = setup();
        let cancel = Arc::new(AtomicBool::new(false));
        let target = t.0.join("root/race.txt");
        rt().block_on(async {
            // someone else creates the file while this write is under way
            let racer = target.clone();
            let body: ByteStream = Box::pin(futures_util::stream::once(async move {
                std::fs::write(&racer, b"theirs").unwrap();
                Ok(Bytes::from_static(b"mine"))
            }));
            let pre = WriteOpts { precondition: Precondition::IfNoneMatch, ..Default::default() };
            let out = b.write(&root, "race.txt", WriteSource::Stream { len: Some(4), body, reopen: None }, pre, &no_progress, &cancel).await.unwrap();
            assert!(matches!(out, WriteOutcome::Conflict(Some(_))), "refused, not replaced");
            assert_eq!(std::fs::read(&target).unwrap(), b"theirs");
            let left: Vec<_> = std::fs::read_dir(t.0.join("root")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".kybl-")).collect();
            assert!(left.is_empty());
        });
    }

    /// Runs `f` on a thread, failing instead of hanging the suite when it blocks.
    #[cfg(unix)]
    fn within<T: Send + 'static>(secs: u64, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(secs)).expect("blocked (a pipe was opened?)")
    }

    #[cfg(unix)]
    fn mkfifo(p: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
    }

    #[cfg(unix)]
    #[test]
    fn moves_across_disks_keep_what_they_could_not_copy() {
        let base = std::env::temp_dir().join(format!("kybl-across-{}", uuid::Uuid::new_v4()));
        let _t = Tmp(base.clone());
        let src = base.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        std::fs::write(base.join("elsewhere/precious.txt"), b"p").unwrap();
        std::fs::write(src.join("a.txt"), b"a").unwrap();
        std::fs::write(src.join("sub/b.txt"), b"b").unwrap();
        mkfifo(&src.join("sub/pipe"));
        std::os::unix::fs::symlink(base.join("elsewhere"), src.join("out")).unwrap();
        let (s, d) = (src.clone(), base.join("dst"));
        let r = within(10, move || move_across(&s, &d));
        let e = r.unwrap_err();
        assert_eq!(e.kind, ErrKind::Unsupported, "{e}");
        let dst = base.join("dst");
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"a");
        assert_eq!(std::fs::read(dst.join("sub/b.txt")).unwrap(), b"b");
        assert!(std::fs::symlink_metadata(dst.join("out")).unwrap().file_type().is_symlink(), "a link comes along as a link");
        // the copied originals are gone; the pipe and its folder stay
        assert!(!src.join("a.txt").exists() && !src.join("sub/b.txt").exists() && std::fs::symlink_metadata(src.join("out")).is_err());
        assert!(std::fs::symlink_metadata(src.join("sub/pipe")).is_ok());
        assert_eq!(std::fs::read(base.join("elsewhere/precious.txt")).unwrap(), b"p", "never followed out");

        // reading a pipe is refused instead of waiting forever
        let (_t2, b, root) = setup();
        let r = b.fixed[0].canon.clone();
        mkfifo(&r.join("pipe"));
        let res = within(10, move || rt().block_on(async move { b.read(&root, "pipe", None, None).await.map(|_| ()) }));
        assert!(res.is_err_and(|e| e.kind == ErrKind::Unsupported));
    }
}
