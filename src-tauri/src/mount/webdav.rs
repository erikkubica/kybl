//! The WebDAV file system of a mounted drive: `dav-server`'s [`DavFileSystem`] over any
//! connection behind [`Storage`].
//!
//! - **Paths**: a drive shows one place of a connection: a folder in a root (bucket, drive) or,
//!   with no root given, every root as a top-level folder. Keys inside are `prefix + path`.
//! - **Listings** are cached for [`TTL`] (Finder asks for the same folder many times a second),
//!   and dropped as soon as Kybl itself changes something in that folder. A lookup of one file
//!   lists its folder once instead of asking the server about each name.
//! - **Reads** go through the block cache ([`super::cache`]): ranged reads, kept on disk, with
//!   the next block fetched ahead while a file is read front to back.
//! - **Writes** go to a local file and are uploaded in the background ([`super::writeback`]).
//!   Until then the drive shows the local copy.
//! - **Clutter** (`._*`, `.DS_Store`, Spotlight and Trash folders) never reaches the server
//!   ([`super::junk`]).

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::{Buf, Bytes};
use dav_server::{
    davpath::DavPath,
    fs::{DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream, OpenOptions, ReadDirMeta},
};
use futures_util::{FutureExt, StreamExt};
use unicode_normalization::UnicodeNormalization;

use super::{
    cache::{BlockCache, FileVersion, BLOCK},
    junk::{is_junk_dir, is_junk_path, JunkStore},
    writeback::{BaseState, Event, Listener, WriteBack},
};
use crate::storage::{BoxFuture, Entry, ErrKind, Loc, ServerCopy, Storage, StorageError};

/// How long a folder listing is trusted.
pub const TTL: Duration = Duration::from_secs(10);
/// How long the storage quota is trusted.
const QUOTA_TTL: Duration = Duration::from_secs(60);

/// Hands out the drive's connection (the registry in the app, a fixed store in tests).
pub type Opener = Arc<dyn Fn() -> BoxFuture<'static, Result<Arc<dyn Storage>, String>> + Send + Sync>;

/// What a drive shows.
#[derive(Clone, Debug)]
pub struct Spec {
    /// "" shows every root as a top-level folder
    pub bucket: String,
    /// "" or a folder key ending with `/`
    pub prefix: String,
    pub read_only: bool,
}

fn fs_err(e: StorageError) -> FsError {
    match e.kind {
        ErrKind::NotFound => FsError::NotFound,
        ErrKind::Exists => FsError::Exists,
        ErrKind::PermissionDenied | ErrKind::NeedsAuth => FsError::Forbidden,
        ErrKind::TooLarge => FsError::TooLarge,
        ErrKind::Unsupported => FsError::NotImplemented,
        _ => FsError::GeneralFailure,
    }
}

fn io_err(_: std::io::Error) -> FsError {
    FsError::GeneralFailure
}

fn ms_to_time(ms: Option<i64>, fallback: SystemTime) -> SystemTime {
    match ms {
        Some(ms) if ms >= 0 => UNIX_EPOCH + Duration::from_millis(ms as u64),
        _ => fallback,
    }
}

fn dirkey(key: &str) -> String {
    if key.is_empty() { String::new() } else { format!("{key}/") }
}

/// (parent folder key, name) of a key without a trailing slash.
fn split_key(key: &str) -> (String, &str) {
    match key.rfind('/') {
        Some(i) => (key[..=i].to_string(), &key[i + 1..]),
        None => (String::new(), key),
    }
}

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

// ---------------------------------------------------------------- metadata

#[derive(Debug, Clone)]
struct Meta {
    len: u64,
    modified: SystemTime,
    dir: bool,
    etag: Option<String>,
}

impl Meta {
    fn dir(at: SystemTime) -> Self {
        Self { len: 0, modified: at, dir: true, etag: None }
    }
    fn file(e: &Entry, fallback: SystemTime) -> Self {
        Self { len: e.size.max(0) as u64, modified: ms_to_time(e.modified, fallback), dir: false, etag: e.etag.clone() }
    }
}

impl DavMetaData for Meta {
    fn len(&self) -> u64 {
        self.len
    }
    fn modified(&self) -> FsResult<SystemTime> {
        Ok(self.modified)
    }
    fn is_dir(&self) -> bool {
        self.dir
    }
    fn is_symlink(&self) -> bool {
        false
    }
    /// The store's own etag when it has one (so a client's cache follows real changes), else
    /// size and time like dav-server does.
    fn etag(&self) -> Option<String> {
        if let Some(t) = &self.etag {
            let t: String = t.trim_start_matches("W/").chars().filter(|c| *c != '"' && !c.is_control()).collect();
            if !t.is_empty() {
                return Some(t);
            }
        }
        let t = self.modified.duration_since(UNIX_EPOCH).ok()?;
        let t = t.as_secs() * 1_000_000 + u64::from(t.subsec_micros());
        Some(if self.dir { format!("{t:x}") } else { format!("{:x}-{t:x}", self.len) })
    }
}

struct DirEntry {
    name: String,
    meta: Meta,
}

impl DavDirEntry for DirEntry {
    fn name(&self) -> Vec<u8> {
        self.name.as_bytes().to_vec()
    }
    fn metadata(&self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = Box::new(self.meta.clone());
        Box::pin(async move { Ok(m) })
    }
}

// ---------------------------------------------------------------- the file system

/// One folder's children, as listed.
struct Listing {
    at: Instant,
    dirs: BTreeSet<String>,
    files: BTreeMap<String, Entry>,
}

/// Where a path of the drive points.
enum Node {
    /// the top of a drive that shows every root
    Top,
    /// `key` inside `root` ("" is the root's top), without a trailing slash
    In { root: String, key: String },
}

/// What is at a key: our pending save, a file on the server, or a folder.
enum Found {
    Pending(super::writeback::Pending),
    File(Entry),
    Dir,
}

/// A drive with every root: (folder name, root id, read-only).
type Roots = Arc<Vec<(String, String, bool)>>;
/// (bytes used, bytes in all)
type QuotaPair = (u64, Option<u64>);

pub struct Inner {
    open: Opener,
    spec: Spec,
    started: SystemTime,
    listings: Mutex<HashMap<(String, String), Arc<Listing>>>,
    roots: Mutex<Option<(Instant, Roots)>>,
    quota: Mutex<Option<(Instant, Option<QuotaPair>)>>,
    pub blocks: Arc<BlockCache>,
    pub uploads: Arc<WriteBack>,
    junk: JunkStore,
    /// told about uploads and conflicts (the drive's status line)
    listener: Mutex<Option<Listener>>,
}

#[derive(Clone)]
pub struct KyblFs(pub Arc<Inner>);

impl KyblFs {
    pub fn new(open: Opener, spec: Spec, blocks: Arc<BlockCache>, uploads: Arc<WriteBack>) -> Self {
        let inner = Arc::new(Inner {
            open,
            spec,
            started: SystemTime::now(),
            listings: Mutex::default(),
            roots: Mutex::default(),
            quota: Mutex::default(),
            blocks,
            uploads: uploads.clone(),
            junk: JunkStore::default(),
            listener: Mutex::default(),
        });
        // a finished upload changes its folder: list it again next time
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        uploads.set_listener(Arc::new(move |e: Event| {
            let Some(me) = weak.upgrade() else { return };
            if let Event::Uploaded { root, key } = &e {
                me.forget_parent(root, key);
            }
            let l = me.listener.lock().unwrap().clone();
            if let Some(l) = l {
                l(e);
            }
        }));
        Self(inner)
    }

    pub fn set_listener(&self, l: Listener) {
        *self.0.listener.lock().unwrap() = Some(l);
    }

    /// Starts the upload workers; they run until `uploads.stop()`.
    pub fn start_uploads(&self) {
        for _ in 0..super::writeback::WORKERS {
            let open = self.0.open.clone();
            tokio::spawn(self.0.uploads.clone().run(move || open()));
        }
    }
}

impl Inner {
    async fn storage(&self) -> FsResult<Arc<dyn Storage>> {
        (self.open)().await.map_err(|_| FsError::GeneralFailure)
    }

    fn rel(path: &DavPath) -> String {
        String::from_utf8_lossy(path.as_bytes()).trim_matches('/').to_string()
    }

    /// The roots of a drive that shows all of them, as folder names.
    async fn roots(&self) -> FsResult<Roots> {
        if let Some((at, r)) = &*self.roots.lock().unwrap()
            && at.elapsed() < Duration::from_secs(60)
        {
            return Ok(r.clone());
        }
        let s = self.storage().await?;
        let mut out: Vec<(String, String, bool)> = Vec::new();
        for r in s.roots().await.map_err(fs_err)? {
            let base = r.name.replace('/', "-");
            let mut name = base.clone();
            let mut n = 2;
            while out.iter().any(|(x, _, _)| *x == name) {
                name = format!("{base} ({n})");
                n += 1;
            }
            out.push((name, r.id, r.read_only));
        }
        let out = Arc::new(out);
        *self.roots.lock().unwrap() = Some((Instant::now(), out.clone()));
        Ok(out)
    }

    async fn node(&self, rel: &str) -> FsResult<Node> {
        if !self.spec.bucket.is_empty() {
            let key = format!("{}{rel}", self.spec.prefix);
            return Ok(Node::In { root: self.spec.bucket.clone(), key: key.trim_end_matches('/').to_string() });
        }
        if rel.is_empty() {
            return Ok(Node::Top);
        }
        let (first, rest) = rel.split_once('/').unwrap_or((rel, ""));
        let roots = self.roots().await?;
        let first_nfc = nfc(first);
        let id = roots
            .iter()
            .find(|(n, _, _)| n == first)
            .or_else(|| roots.iter().find(|(n, _, _)| nfc(n) == first_nfc))
            .map(|(_, id, _)| id.clone())
            .ok_or(FsError::NotFound)?;
        Ok(Node::In { root: id, key: rest.to_string() })
    }

    async fn read_only(&self, root: &str) -> bool {
        if self.spec.read_only {
            return true;
        }
        if self.spec.bucket.is_empty() {
            return self.roots().await.map(|r| r.iter().any(|(_, id, ro)| id == root && *ro)).unwrap_or(true);
        }
        false
    }

    /// The folder `dir` ("" or ending with `/`), from the cache while it is fresh.
    async fn listing(&self, root: &str, dir: &str) -> FsResult<Arc<Listing>> {
        let k = (root.to_string(), dir.to_string());
        if let Some(l) = self.listings.lock().unwrap().get(&k)
            && l.at.elapsed() < TTL
        {
            return Ok(l.clone());
        }
        let s = self.storage().await?;
        let mut l = Listing { at: Instant::now(), dirs: BTreeSet::new(), files: BTreeMap::new() };
        let mut token = None;
        loop {
            let page = match s.list(root, dir, token).await {
                Ok(p) => p,
                // a folder that isn't there has nothing in it
                Err(e) if e.kind == ErrKind::NotFound => break,
                Err(e) => return Err(fs_err(e)),
            };
            for f in page.folders {
                let name = f.strip_prefix(dir).unwrap_or(&f).trim_end_matches('/');
                if !name.is_empty() && !name.contains('/') && !is_junk_dir(name) {
                    l.dirs.insert(name.to_string());
                }
            }
            for o in page.objects {
                let name = o.key.strip_prefix(dir).unwrap_or(&o.key).to_string();
                // the folder's own marker object, and clutter someone else uploaded
                if name.is_empty() || name.ends_with('/') || name.contains('/') || is_junk_path(&name) {
                    continue;
                }
                l.files.insert(name, o);
            }
            match page.next_token {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        let l = Arc::new(l);
        let mut cache = self.listings.lock().unwrap();
        if cache.len() > 2000 {
            cache.retain(|_, v| v.at.elapsed() < TTL);
        }
        cache.insert(k, l.clone());
        Ok(l)
    }

    /// Kybl changed something in the folder holding `key`.
    fn forget_parent(&self, root: &str, key: &str) {
        let (parent, _) = split_key(key.trim_end_matches('/'));
        self.listings.lock().unwrap().remove(&(root.to_string(), parent));
    }

    /// A folder and everything below it changed.
    fn forget_tree(&self, root: &str, dir: &str) {
        self.listings.lock().unwrap().retain(|(r, d), _| !(r == root && d.starts_with(dir)));
    }

    /// What the server has at `key` (not counting pending saves). Matches names that differ
    /// only in Unicode composition, answering with the server's own key.
    async fn remote(&self, root: &str, key: &str) -> FsResult<Option<(String, Found)>> {
        if key.is_empty() {
            return Ok(Some((String::new(), Found::Dir)));
        }
        let (parent, name) = split_key(key);
        let l = self.listing(root, &parent).await?;
        let hit = |n: &str| -> Option<Found> {
            if l.dirs.contains(n) {
                Some(Found::Dir)
            } else {
                l.files.get(n).map(|e| Found::File(e.clone()))
            }
        };
        if let Some(f) = hit(name) {
            return Ok(Some((key.to_string(), f)));
        }
        let want = nfc(name);
        let other = l.dirs.iter().chain(l.files.keys()).find(|n| nfc(n) == want).cloned();
        Ok(other.and_then(|n| hit(&n).map(|f| (format!("{parent}{n}"), f))))
    }

    /// What is at `key`, pending saves first; with the key it is really stored under.
    async fn lookup(&self, root: &str, key: &str) -> FsResult<Option<(String, Found)>> {
        if let Some(p) = self.uploads.get(root, key) {
            return Ok(Some((key.to_string(), Found::Pending(p))));
        }
        let r = self.remote(root, key).await?;
        // a new folder holding only pending saves (prefix stores show it after the upload)
        if r.is_none() && self.uploads.any_under(root, &dirkey(key)) {
            return Ok(Some((key.to_string(), Found::Dir)));
        }
        if let Some((real, Found::File(e))) = &r
            && real != key
        {
            if let Some(p) = self.uploads.get(root, real) {
                return Ok(Some((real.clone(), Found::Pending(p))));
            }
            return Ok(Some((real.clone(), Found::File(e.clone()))));
        }
        Ok(r)
    }

    fn pending_meta(&self, p: &super::writeback::Pending) -> Meta {
        Meta { len: p.size, modified: ms_to_time(Some(p.modified), self.started), dir: false, etag: Some(format!("kybl-{}-{}", p.seq, p.size)) }
    }

    fn found_meta(&self, f: &Found) -> Meta {
        match f {
            Found::Dir => Meta::dir(self.started),
            Found::File(e) => Meta::file(e, self.started),
            Found::Pending(p) => self.pending_meta(p),
        }
    }

    async fn metadata(&self, path: &DavPath) -> FsResult<Meta> {
        let rel = Self::rel(path);
        if rel.is_empty() {
            return Ok(Meta::dir(self.started));
        }
        if is_junk_path(&rel) {
            return self.junk.get(&rel).map(|(len, at)| Meta { len, modified: at, dir: false, etag: None }).ok_or(FsError::NotFound);
        }
        match self.node(&rel).await? {
            Node::Top => Ok(Meta::dir(self.started)),
            Node::In { root, key } => match self.lookup(&root, &key).await? {
                Some((_, f)) => Ok(self.found_meta(&f)),
                None => Err(FsError::NotFound),
            },
        }
    }

    async fn read_dir(&self, path: &DavPath) -> FsResult<Vec<DirEntry>> {
        let rel = Self::rel(path);
        if is_junk_path(&rel) {
            return Err(FsError::NotFound);
        }
        let mut out: BTreeMap<String, Meta> = BTreeMap::new();
        match self.node(&rel).await? {
            Node::Top => {
                for (name, _, _) in self.roots().await?.iter() {
                    out.insert(name.clone(), Meta::dir(self.started));
                }
            }
            Node::In { root, key } => {
                let dir = dirkey(&key);
                let l = self.listing(&root, &dir).await?;
                for d in &l.dirs {
                    out.insert(d.clone(), Meta::dir(self.started));
                }
                for (name, e) in &l.files {
                    out.insert(name.clone(), Meta::file(e, self.started));
                }
                for p in self.uploads.in_dir(&root, &dir) {
                    let name = p.key[dir.len()..].to_string();
                    out.insert(name, self.pending_meta(&p));
                }
            }
        }
        for (name, len, at) in self.junk.in_dir(&rel) {
            out.insert(name, Meta { len, modified: at, dir: false, etag: None });
        }
        Ok(out.into_iter().map(|(name, meta)| DirEntry { name, meta }).collect())
    }

    /// The node of a path that must be inside a root and not the drive's own top.
    async fn file_node(&self, rel: &str) -> FsResult<(String, String)> {
        match self.node(rel).await? {
            Node::In { root, key } if !key.is_empty() => Ok((root, key)),
            _ => Err(FsError::Forbidden),
        }
    }

    async fn open(self: Arc<Self>, path: &DavPath, o: OpenOptions) -> FsResult<Box<dyn DavFile>> {
        let rel = Self::rel(path);
        let writing = o.write || o.append || o.truncate || o.create || o.create_new;
        if is_junk_path(&rel) {
            if rel.split('/').any(is_junk_dir) {
                return Err(if writing { FsError::Forbidden } else { FsError::NotFound });
            }
            let existing = self.junk.read(&rel);
            if !writing {
                return existing.map(|d| Box::new(MemFile::new(Bytes::from(d))) as Box<dyn DavFile>).ok_or(FsError::NotFound);
            }
            if o.create_new && existing.is_some() {
                return Err(FsError::Exists);
            }
            if !o.create && existing.is_none() {
                return Err(FsError::NotFound);
            }
            let data = if o.truncate { Vec::new() } else { existing.unwrap_or_default() };
            let pos = if o.append { data.len() as u64 } else { 0 };
            self.junk.put(&rel, data.clone());
            return Ok(Box::new(JunkWriter { fs: self.clone(), rel, data, pos }));
        }
        let (root, key) = self.file_node(&rel).await?;
        let found = self.lookup(&root, &key).await?;
        if matches!(found, Some((_, Found::Dir))) {
            return Err(FsError::Forbidden);
        }
        if !writing {
            return match found {
                Some((_, Found::Pending(p))) => {
                    let f = std::fs::File::open(self.uploads.path_of(&p)).map_err(io_err)?;
                    Ok(Box::new(LocalRead { file: f, meta: self.pending_meta(&p) }))
                }
                Some((real, Found::File(e))) => {
                    let storage = self.storage().await?;
                    let version = e.etag.clone().unwrap_or_else(|| format!("{}-{}", e.size, e.modified.unwrap_or(0)));
                    let ver = FileVersion { root: root.clone(), key: real, size: e.size.max(0) as u64, version };
                    Ok(Box::new(RemoteRead { fs: self.clone(), storage, ver, meta: Meta::file(&e, self.started), pos: 0, cur: None }))
                }
                _ => Err(FsError::NotFound),
            };
        }
        if self.read_only(&root).await {
            return Err(FsError::Forbidden);
        }
        if o.create_new && found.is_some() {
            return Err(FsError::Exists);
        }
        if !o.create && found.is_none() {
            return Err(FsError::NotFound);
        }
        // new files get composed (NFC) names, like everything else Kybl writes
        let (key, seen) = match &found {
            Some((real, Found::File(e))) => (real.clone(), Some(BaseState::of(e))),
            Some((real, _)) => (real.clone(), None),
            None => {
                let (parent, name) = split_key(&key);
                (format!("{parent}{}", nfc(name)), None)
            }
        };
        let base = self.uploads.base_for(&root, &key, seen);
        let temp = self.uploads.new_temp().map_err(io_err)?;
        if !o.truncate
            && let Err(e) = self.fill(&temp, &root, &found).await
        {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        let file = std::fs::OpenOptions::new().read(true).write(true).open(&temp).map_err(io_err)?;
        let len = file.metadata().map_err(io_err)?.len();
        let created = found.is_none();
        // emptying an existing file is a change even when nothing is written after
        let mut w = WriteFile { fs: self.clone(), root, key, temp, file: Some(file), pos: if o.append { len } else { 0 }, dirty: o.truncate && !created, base };
        // a new file exists from now on (a LOCK makes an empty one; a PUT fills it at once)
        if created {
            w.commit_copy().map_err(io_err)?;
        }
        Ok(Box::new(w))
    }

    /// Copies what is at a file now into `temp` (an edit that doesn't start from empty).
    async fn fill(&self, temp: &PathBuf, root: &str, found: &Option<(String, Found)>) -> FsResult<()> {
        match found {
            Some((_, Found::Pending(p))) => {
                std::fs::copy(self.uploads.path_of(p), temp).map_err(io_err)?;
            }
            Some((real, Found::File(_))) => self.download(root, real, temp).await?,
            _ => {}
        }
        Ok(())
    }

    async fn download(&self, root: &str, key: &str, to: &PathBuf) -> FsResult<()> {
        let s = self.storage().await?;
        let r = s.read(root, key, None, None).await.map_err(fs_err)?;
        let mut out = std::fs::File::create(to).map_err(io_err)?;
        let mut body = r.body;
        while let Some(chunk) = body.next().await {
            out.write_all(&chunk.map_err(io_err)?).map_err(io_err)?;
        }
        Ok(())
    }

    async fn create_dir(&self, path: &DavPath) -> FsResult<()> {
        let rel = Self::rel(path);
        if is_junk_path(&rel) {
            return Err(FsError::Forbidden);
        }
        let (root, key) = match self.node(&rel).await? {
            Node::In { root, key } if !key.is_empty() => (root, key),
            _ => return Err(FsError::Exists),
        };
        if self.read_only(&root).await {
            return Err(FsError::Forbidden);
        }
        if self.lookup(&root, &key).await?.is_some() {
            return Err(FsError::Exists);
        }
        let (parent, name) = split_key(&key);
        let key = format!("{parent}{}", nfc(name));
        let s = self.storage().await?;
        s.mkdir(&root, &dirkey(&key)).await.map_err(fs_err)?;
        self.forget_parent(&root, &key);
        Ok(())
    }

    async fn remove_file(&self, path: &DavPath) -> FsResult<()> {
        let rel = Self::rel(path);
        if is_junk_path(&rel) {
            return if self.junk.remove(&rel) { Ok(()) } else { Err(FsError::NotFound) };
        }
        let (root, key) = self.file_node(&rel).await?;
        if self.read_only(&root).await {
            return Err(FsError::Forbidden);
        }
        let had_pending = self.uploads.remove(&root, &key);
        match self.remote(&root, &key).await? {
            Some((real, Found::File(_))) => {
                let s = self.storage().await?;
                s.delete(&root, std::slice::from_ref(&real), &[], &AtomicBool::new(false), &|_, _| {}).await.map_err(fs_err)?;
                self.forget_parent(&root, &real);
                Ok(())
            }
            Some(_) => Err(FsError::Forbidden),
            None if had_pending => Ok(()),
            None => Err(FsError::NotFound),
        }
    }

    async fn remove_dir(&self, path: &DavPath) -> FsResult<()> {
        let rel = Self::rel(path);
        if is_junk_path(&rel) {
            return Err(FsError::NotFound);
        }
        let (root, key) = self.file_node(&rel).await?;
        if self.read_only(&root).await {
            return Err(FsError::Forbidden);
        }
        let dir = dirkey(&key);
        self.uploads.remove_under(&root, &dir);
        self.junk.remove_under(&rel);
        if let Some((real, Found::Dir)) = self.remote(&root, &key).await? {
            let s = self.storage().await?;
            s.delete(&root, &[], &[dirkey(&real)], &AtomicBool::new(false), &|_, _| {}).await.map_err(fs_err)?;
        }
        self.forget_parent(&root, &key);
        self.forget_tree(&root, &dir);
        Ok(())
    }

    async fn rename(&self, from: &DavPath, to: &DavPath) -> FsResult<()> {
        let (rf, rt) = (Self::rel(from), Self::rel(to));
        match (is_junk_path(&rf), is_junk_path(&rt)) {
            (true, true) => return if self.junk.rename(&rf, &rt) { Ok(()) } else { Err(FsError::NotFound) },
            (false, true) => return Err(FsError::Forbidden),
            (true, false) => {
                // a clutter-named temp file saved under a real name: it becomes a real save
                let data = self.junk.read(&rf).ok_or(FsError::NotFound)?;
                let (root, key) = self.file_node(&rt).await?;
                if self.read_only(&root).await {
                    return Err(FsError::Forbidden);
                }
                let seen = self.remote_base(&root, &key).await?;
                let temp = self.uploads.new_temp().map_err(io_err)?;
                std::fs::write(&temp, data).map_err(io_err)?;
                let base = self.uploads.base_for(&root, &key, seen);
                self.uploads.commit(&root, &key, &temp, base).map_err(io_err)?;
                self.junk.remove(&rf);
                return Ok(());
            }
            (false, false) => {}
        }
        let (root, key) = self.file_node(&rf).await?;
        let (root2, key2) = self.file_node(&rt).await?;
        if root != root2 {
            // the client copies and deletes instead
            return Err(FsError::IsRemote);
        }
        if self.read_only(&root).await {
            return Err(FsError::Forbidden);
        }
        let (parent2, name2) = split_key(&key2);
        let key2 = format!("{parent2}{}", nfc(name2));
        let pending = self.uploads.get(&root, &key);
        let remote = self.remote(&root, &key).await?;
        let s = self.storage().await?;
        match (&remote, &pending) {
            (Some((real, Found::Dir)), _) => {
                s.rename(&Loc::new(&root, dirkey(real)), &Loc::new(&root, dirkey(&key2)), true).await.map_err(fs_err)?;
                for p in self.uploads.pending().into_iter().filter(|p| p.root == root && p.key.starts_with(&dirkey(&key))) {
                    let moved = format!("{}{}", dirkey(&key2), &p.key[dirkey(&key).len()..]);
                    self.uploads.rename(&root, &p.key, &moved, None);
                }
                self.forget_tree(&root, &dirkey(real));
                self.forget_tree(&root, &dirkey(&key2));
            }
            (Some((real, Found::File(e))), _) => {
                s.rename(&Loc::new(&root, real.clone()), &Loc::new(&root, key2.clone()), false).await.map_err(fs_err)?;
                if pending.is_some() {
                    self.uploads.rename(&root, &key, &key2, Some(BaseState::of(e)));
                }
            }
            (None, Some(_)) => {
                let seen = self.remote_base(&root, &key2).await?;
                self.uploads.rename(&root, &key, &key2, seen);
            }
            _ => return Err(FsError::NotFound),
        }
        self.forget_parent(&root, &key);
        self.forget_parent(&root, &key2);
        Ok(())
    }

    /// What the server has at `key`, as an edit's base.
    async fn remote_base(&self, root: &str, key: &str) -> FsResult<Option<BaseState>> {
        Ok(match self.remote(root, key).await? {
            Some((_, Found::File(e))) => Some(BaseState::of(&e)),
            _ => None,
        })
    }

    async fn copy(&self, from: &DavPath, to: &DavPath) -> FsResult<()> {
        let (rf, rt) = (Self::rel(from), Self::rel(to));
        if is_junk_path(&rt) {
            if let Some(d) = self.junk.read(&rf) {
                self.junk.put(&rt, d);
            }
            return Ok(());
        }
        let (root2, key2) = self.file_node(&rt).await?;
        if self.read_only(&root2).await {
            return Err(FsError::Forbidden);
        }
        let (parent2, name2) = split_key(&key2);
        let key2 = format!("{parent2}{}", nfc(name2));
        let seen = self.remote_base(&root2, &key2).await?;
        let temp = self.uploads.new_temp().map_err(io_err)?;
        // true: `temp` holds the copy, to upload; false: copied on the server already
        let result: FsResult<bool> = async {
            if is_junk_path(&rf) {
                std::fs::write(&temp, self.junk.read(&rf).ok_or(FsError::NotFound)?).map_err(io_err)?;
                return Ok(true);
            }
            let (root, key) = self.file_node(&rf).await?;
            match self.lookup(&root, &key).await? {
                Some((_, Found::Pending(p))) => {
                    std::fs::copy(self.uploads.path_of(&p), &temp).map_err(io_err)?;
                }
                Some((real, Found::File(_))) => {
                    let s = self.storage().await?;
                    let server_copy = match s.caps().server_copy {
                        ServerCopy::CrossRoot => true,
                        ServerCopy::SameRoot => root == root2,
                        ServerCopy::None => false,
                    };
                    if server_copy && self.uploads.get(&root2, &key2).is_none() {
                        s.copy(&Loc::new(&root, real), &Loc::new(&root2, key2.clone()), false).await.map_err(fs_err)?;
                        self.forget_parent(&root2, &key2);
                        return Ok(false);
                    }
                    self.download(&root, &real, &temp).await?;
                }
                _ => return Err(FsError::NotFound),
            }
            Ok(true)
        }
        .await;
        match result {
            Ok(true) => {
                let base = self.uploads.base_for(&root2, &key2, seen);
                self.uploads.commit(&root2, &key2, &temp, base).map_err(io_err)?;
                Ok(())
            }
            other => {
                let _ = std::fs::remove_file(&temp);
                other.map(|_| ())
            }
        }
    }

    async fn quota(&self) -> FsResult<(u64, Option<u64>)> {
        if let Some((at, q)) = &*self.quota.lock().unwrap()
            && at.elapsed() < QUOTA_TTL
        {
            return q.ok_or(FsError::NotImplemented);
        }
        let s = self.storage().await?;
        let q = s.quota().await.ok().flatten().map(|q| (q.used, q.total));
        *self.quota.lock().unwrap() = Some((Instant::now(), q));
        q.ok_or(FsError::NotImplemented)
    }
}

impl DavFileSystem for KyblFs {
    fn open<'a>(&'a self, path: &'a DavPath, options: OpenOptions) -> FsFuture<'a, Box<dyn DavFile>> {
        self.0.clone().open(path, options).boxed()
    }

    fn read_dir<'a>(&'a self, path: &'a DavPath, _meta: ReadDirMeta) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        async move {
            let entries = self.0.read_dir(path).await?;
            let s: FsStream<Box<dyn DavDirEntry>> =
                Box::pin(futures_util::stream::iter(entries.into_iter().map(|e| Ok(Box::new(e) as Box<dyn DavDirEntry>))));
            Ok(s)
        }
        .boxed()
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        async move { Ok(Box::new(self.0.metadata(path).await?) as Box<dyn DavMetaData>) }.boxed()
    }

    fn symlink_metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        self.metadata(path)
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        self.0.create_dir(path).boxed()
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        self.0.remove_dir(path).boxed()
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        self.0.remove_file(path).boxed()
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        self.0.rename(from, to).boxed()
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        self.0.copy(from, to).boxed()
    }

    /// Accepted (so `X-OC-MTime` PUTs succeed); the upload carries the save's own time.
    fn set_modified<'a>(&'a self, _path: &'a DavPath, _tm: SystemTime) -> FsFuture<'a, ()> {
        async { Ok(()) }.boxed()
    }

    fn get_quota(&self) -> FsFuture<'_, (u64, Option<u64>)> {
        self.0.quota().boxed()
    }
}

// ---------------------------------------------------------------- open files

/// A file on the server, read through the block cache.
struct RemoteRead {
    fs: Arc<Inner>,
    storage: Arc<dyn Storage>,
    ver: FileVersion,
    meta: Meta,
    pos: u64,
    /// the block read last: most reads are small pieces of the same block
    cur: Option<(u64, Bytes)>,
}

impl fmt::Debug for RemoteRead {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteRead").field("key", &self.ver.key).field("pos", &self.pos).finish()
    }
}

impl RemoteRead {
    async fn block(&mut self, idx: u64) -> FsResult<Bytes> {
        if let Some((i, b)) = &self.cur
            && *i == idx
        {
            return Ok(b.clone());
        }
        let fetched = !self.fs.blocks.has(&self.ver, idx);
        let b = self.fs.blocks.block(&*self.storage, &self.ver, idx).await.map_err(fs_err)?;
        self.cur = Some((idx, b.clone()));
        // read front to back: fetch the next block while this one is used
        let next = idx + 1;
        if fetched && next < self.ver.blocks() && !self.fs.blocks.has(&self.ver, next) {
            let (blocks, storage, ver) = (self.fs.blocks.clone(), self.storage.clone(), self.ver.clone());
            tokio::spawn(async move {
                let _ = blocks.block(&*storage, &ver, next).await;
            });
        }
        Ok(b)
    }
}

impl DavFile for RemoteRead {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = Box::new(self.meta.clone());
        async move { Ok(m) }.boxed()
    }
    fn write_buf(&mut self, _buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }
    fn write_bytes(&mut self, _buf: Bytes) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }
    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        async move {
            if self.pos >= self.ver.size || count == 0 {
                return Ok(Bytes::new());
            }
            let idx = self.pos / BLOCK;
            let b = self.block(idx).await?;
            let off = (self.pos - idx * BLOCK) as usize;
            if off >= b.len() {
                // shorter than listed: the file changed on the server
                return Ok(Bytes::new());
            }
            let n = count.min(b.len() - off);
            self.pos += n as u64;
            Ok(b.slice(off..off + n))
        }
        .boxed()
    }
    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        let r = seek_to(self.pos, self.ver.size, pos).inspect(|&p| {
            self.pos = p;
        });
        async move { r }.boxed()
    }
    fn flush(&mut self) -> FsFuture<'_, ()> {
        async { Ok(()) }.boxed()
    }
}

fn seek_to(cur: u64, len: u64, pos: SeekFrom) -> FsResult<u64> {
    let p = match pos {
        SeekFrom::Start(p) => p as i128,
        SeekFrom::Current(d) => cur as i128 + d as i128,
        SeekFrom::End(d) => len as i128 + d as i128,
    };
    if p < 0 { Err(FsError::GeneralFailure) } else { Ok(p as u64) }
}

/// A pending save, read from its local file.
#[derive(Debug)]
struct LocalRead {
    file: std::fs::File,
    meta: Meta,
}

impl DavFile for LocalRead {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = Box::new(self.meta.clone());
        async move { Ok(m) }.boxed()
    }
    fn write_buf(&mut self, _buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }
    fn write_bytes(&mut self, _buf: Bytes) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }
    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        let r = read_some(&mut self.file, count);
        async move { r }.boxed()
    }
    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        let r = self.file.seek(pos).map_err(io_err);
        async move { r }.boxed()
    }
    fn flush(&mut self) -> FsFuture<'_, ()> {
        async { Ok(()) }.boxed()
    }
}

fn read_some(f: &mut std::fs::File, count: usize) -> FsResult<Bytes> {
    let mut buf = vec![0u8; count.min(BLOCK as usize)];
    let n = f.read(&mut buf).map_err(io_err)?;
    buf.truncate(n);
    Ok(Bytes::from(buf))
}

/// A save under way: written to a local file, which becomes a pending upload on flush.
struct WriteFile {
    fs: Arc<Inner>,
    root: String,
    key: String,
    temp: PathBuf,
    /// None after a flush handed the file over (a later write starts from a copy)
    file: Option<std::fs::File>,
    pos: u64,
    dirty: bool,
    base: Option<BaseState>,
}

impl fmt::Debug for WriteFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WriteFile").field("key", &self.key).field("pos", &self.pos).finish()
    }
}

impl WriteFile {
    /// The open file, reopened from the pending copy after a flush.
    fn file(&mut self) -> std::io::Result<&mut std::fs::File> {
        if self.file.is_none() {
            let temp = self.fs.uploads.new_temp()?;
            if let Some(p) = self.fs.uploads.get(&self.root, &self.key) {
                std::fs::copy(self.fs.uploads.path_of(&p), &temp)?;
            }
            self.file = Some(std::fs::OpenOptions::new().read(true).write(true).open(&temp)?);
            self.temp = temp;
        }
        Ok(self.file.as_mut().expect("just opened"))
    }

    /// Makes a copy of what is written so far the pending upload (the file stays open).
    fn commit_copy(&mut self) -> std::io::Result<()> {
        let copy = self.fs.uploads.new_temp()?;
        std::fs::copy(&self.temp, &copy)?;
        self.fs.uploads.commit(&self.root, &self.key, &copy, self.base.clone())?;
        Ok(())
    }

    fn len(&mut self) -> u64 {
        match &self.file {
            Some(f) => f.metadata().map(|m| m.len()).unwrap_or(0),
            None => self.fs.uploads.get(&self.root, &self.key).map(|p| p.size).unwrap_or(0),
        }
    }

    fn write_all(&mut self, data: &[u8]) -> FsResult<()> {
        let pos = self.pos;
        let f = self.file().map_err(io_err)?;
        f.seek(SeekFrom::Start(pos)).map_err(io_err)?;
        f.write_all(data).map_err(|e| if e.kind() == std::io::ErrorKind::StorageFull { FsError::InsufficientStorage } else { FsError::GeneralFailure })?;
        self.pos += data.len() as u64;
        self.dirty = true;
        Ok(())
    }
}

impl Drop for WriteFile {
    fn drop(&mut self) {
        // a save that never flushed (the client gave up): nothing to upload
        if self.file.take().is_some() {
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

impl DavFile for WriteFile {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = Box::new(Meta { len: self.len(), modified: SystemTime::now(), dir: false, etag: None });
        async move { Ok(m) }.boxed()
    }
    fn write_buf(&mut self, mut buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        let data = buf.copy_to_bytes(buf.remaining());
        let r = self.write_all(&data);
        async move { r }.boxed()
    }
    fn write_bytes(&mut self, buf: Bytes) -> FsFuture<'_, ()> {
        let r = self.write_all(&buf);
        async move { r }.boxed()
    }
    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        let pos = self.pos;
        let r = self.file().map_err(io_err).and_then(|f| {
            f.seek(SeekFrom::Start(pos)).map_err(io_err)?;
            read_some(f, count)
        });
        if let Ok(b) = &r {
            self.pos += b.len() as u64;
        }
        async move { r }.boxed()
    }
    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        let len = self.len();
        let r = seek_to(self.pos, len, pos).inspect(|&p| {
            self.pos = p;
        });
        async move { r }.boxed()
    }
    fn flush(&mut self) -> FsFuture<'_, ()> {
        let r = (|| -> FsResult<()> {
            if !self.dirty {
                return Ok(());
            }
            let Some(f) = self.file.take() else { return Ok(()) };
            f.sync_data().map_err(io_err)?;
            drop(f);
            self.fs.uploads.commit(&self.root, &self.key, &self.temp, self.base.clone()).map_err(io_err)?;
            self.dirty = false;
            Ok(())
        })();
        async move { r }.boxed()
    }
}

/// A clutter file read from memory.
#[derive(Debug)]
struct MemFile {
    data: Bytes,
    pos: usize,
}

impl MemFile {
    fn new(data: Bytes) -> Self {
        Self { data, pos: 0 }
    }
}

impl DavFile for MemFile {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = Box::new(Meta { len: self.data.len() as u64, modified: SystemTime::now(), dir: false, etag: None });
        async move { Ok(m) }.boxed()
    }
    fn write_buf(&mut self, _buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }
    fn write_bytes(&mut self, _buf: Bytes) -> FsFuture<'_, ()> {
        async { Err(FsError::Forbidden) }.boxed()
    }
    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        let start = self.pos.min(self.data.len());
        let end = (start + count).min(self.data.len());
        self.pos = end;
        let b = self.data.slice(start..end);
        async move { Ok(b) }.boxed()
    }
    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        let r = seek_to(self.pos as u64, self.data.len() as u64, pos).inspect(|&p| {
            self.pos = p as usize;
        });
        async move { r }.boxed()
    }
    fn flush(&mut self) -> FsFuture<'_, ()> {
        async { Ok(()) }.boxed()
    }
}

/// A clutter file being written: kept in memory for this session, never uploaded.
struct JunkWriter {
    fs: Arc<Inner>,
    rel: String,
    data: Vec<u8>,
    pos: u64,
}

impl fmt::Debug for JunkWriter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JunkWriter").field("rel", &self.rel).finish()
    }
}

impl JunkWriter {
    fn put(&mut self, b: &[u8]) {
        let pos = self.pos as usize;
        if self.data.len() < pos + b.len() {
            self.data.resize(pos + b.len(), 0);
        }
        self.data[pos..pos + b.len()].copy_from_slice(b);
        self.pos += b.len() as u64;
    }
}

impl DavFile for JunkWriter {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let m: Box<dyn DavMetaData> = Box::new(Meta { len: self.data.len() as u64, modified: SystemTime::now(), dir: false, etag: None });
        async move { Ok(m) }.boxed()
    }
    fn write_buf(&mut self, mut buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        let b = buf.copy_to_bytes(buf.remaining());
        self.put(&b);
        async { Ok(()) }.boxed()
    }
    fn write_bytes(&mut self, buf: Bytes) -> FsFuture<'_, ()> {
        self.put(&buf);
        async { Ok(()) }.boxed()
    }
    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        let start = (self.pos as usize).min(self.data.len());
        let end = (start + count).min(self.data.len());
        self.pos = end as u64;
        let b = Bytes::copy_from_slice(&self.data[start..end]);
        async move { Ok(b) }.boxed()
    }
    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        let r = seek_to(self.pos, self.data.len() as u64, pos).inspect(|&p| {
            self.pos = p;
        });
        async move { r }.boxed()
    }
    fn flush(&mut self) -> FsFuture<'_, ()> {
        self.fs.junk.put(&self.rel, self.data.clone());
        async { Ok(()) }.boxed()
    }
}
