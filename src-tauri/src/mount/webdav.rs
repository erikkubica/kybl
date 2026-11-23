//! The WebDAV file system of a mounted drive: `dav-server`'s [`DavFileSystem`] over any
//! connection behind [`Storage`].
//!
//! - **Paths**: a drive shows one place of a connection: a folder in a root (bucket, drive) or,
//!   with no root given, every root as a top-level folder (a connection with one root shows
//!   that root's contents). Keys inside are `prefix + path`.
//! - **Listings** are cached for [`TTL`] (Finder asks for the same folder many times a second),
//!   and dropped as soon as Kybl itself changes something in that folder. A lookup of one file
//!   lists its folder once instead of asking the server about each name. Past [`TTL`] (up to
//!   [`STALE`]) the cached listing is still answered at once and a fresh one is fetched behind
//!   it: macOS's WebDAV client gives up on slow answers (Finder then freezes or shows an empty
//!   folder), and a big folder is several pages from the server. Asks for the same folder at the
//!   same time share one listing. The list of roots and the quota work the same way.
//! - **Reads** go through the block cache ([`super::cache`]): ranged reads, kept on disk. Blocks
//!   are fetched ahead only while a file is read front to back; a lone read (Finder peeking at a
//!   video's start or end to draw its icon) fetches just the block it needs.
//! - **Writes** go to a local file and are uploaded in the background ([`super::writeback`]).
//!   Until then the drive shows the local copy.
//! - **Clutter** (`._*`, `.DS_Store`, Spotlight and Trash folders) never reaches the server
//!   ([`super::junk`]).
//! - **Web-only files** (Google Docs and the like) show as `Name.gdoc.html` shortcuts that open
//!   the document in the browser ([`super::link`]). Renaming, moving or deleting one does that
//!   to the document; writing to one is refused.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt,
    future::Future,
    hash::Hash,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
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
    link,
    writeback::{BaseState, Event, Listener, WriteBack},
};
use crate::storage::{BoxFuture, Entry, ErrKind, Loc, ServerCopy, Storage, StorageError};

/// How long a folder listing is trusted.
pub const TTL: Duration = Duration::from_secs(10);
/// How long an older listing is still answered at once while a fresh one is fetched; past it the
/// ask waits for the fresh one (a folder last seen long ago may have changed a lot).
pub const STALE: Duration = Duration::from_secs(5 * 60);
/// How long the list of roots is trusted (an older one is answered while it is refreshed).
const ROOTS_TTL: Duration = Duration::from_secs(60);
/// How long the storage quota is trusted.
const QUOTA_TTL: Duration = Duration::from_secs(60);
/// How long the first ask for the quota waits for it. Finder asks for it with the drive's top
/// folder; a store that is slow to count (or can't) must not hold the listing up.
const QUOTA_WAIT: Duration = Duration::from_millis(500);
/// The most blocks fetched ahead of a file read front to back.
const READ_AHEAD: u64 = 8;

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
    /// A web-only file's shortcut: the size of the page the drive makes (so a client reads all
    /// of it), and no etag of the store's: the page changes with its name and link, not with
    /// the document.
    fn link(e: &Entry, fallback: SystemTime) -> Self {
        Self { len: link_page(e).len() as u64, modified: ms_to_time(e.modified, fallback), dir: false, etag: None }
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

// ---------------------------------------------------------------- one request for many

/// The result of a backend call, shared by everyone who asked while it was under way.
type Flight<T> = Arc<tokio::sync::OnceCell<FsResult<T>>>;

/// Backend calls under way by key: a second ask for the same thing joins the first instead of
/// making its own (Finder sends several PROPFINDs of the same folder at once).
struct Flights<K, T> {
    map: Mutex<HashMap<K, (u64, Flight<T>)>>,
}

impl<K, T> Default for Flights<K, T> {
    fn default() -> Self {
        Self { map: Mutex::default() }
    }
}

impl<K: Hash + Eq + Clone, T: Clone> Flights<K, T> {
    /// Runs `f`, or joins the call for `k` under way. `epoch` is the cache epoch the caller saw:
    /// a call started before something changed (another epoch) is never joined, since its answer
    /// may not show that change.
    async fn run<F: Future<Output = FsResult<T>>>(&self, k: K, epoch: u64, f: impl FnOnce() -> F) -> FsResult<T> {
        let cell = {
            let mut map = self.map.lock().unwrap();
            match map.get(&k) {
                Some((e, c)) if *e == epoch => c.clone(),
                _ => {
                    let c = Flight::default();
                    map.insert(k.clone(), (epoch, c.clone()));
                    c
                }
            }
        };
        let r = cell.get_or_init(f).await.clone();
        // the first one out clears it, so a failure is tried again next time
        let mut map = self.map.lock().unwrap();
        if map.get(&k).is_some_and(|(_, c)| Arc::ptr_eq(c, &cell)) {
            map.remove(&k);
        }
        r
    }
}

// ---------------------------------------------------------------- the file system

/// One folder's children, as listed.
struct Listing {
    at: Instant,
    dirs: BTreeSet<String>,
    files: BTreeMap<String, Entry>,
    /// web-only files by their shortcut's name (`Plan.gdoc.html`); the entry keeps the real key
    links: BTreeMap<String, Entry>,
}

/// The page a web-only file's shortcut holds, titled with the file's own name.
fn link_page(e: &Entry) -> Vec<u8> {
    let (_, title) = split_key(e.key.trim_end_matches('/'));
    link::page(title, link::web_url(e).unwrap_or_default())
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
    /// a web-only file's shortcut; the entry's key is the real file's
    Link(Entry),
    Dir,
}

/// A drive with every root: (folder name, root id, read-only).
type Roots = Arc<Vec<(String, String, bool)>>;
/// (bytes used, bytes in all)
type QuotaPair = (u64, Option<u64>);

pub struct Inner {
    /// this drive itself, for work that goes on after a request is answered
    me: Weak<Inner>,
    open: Opener,
    spec: Spec,
    started: SystemTime,
    listings: Mutex<HashMap<(String, String), Arc<Listing>>>,
    listing_calls: Flights<(String, String), Arc<Listing>>,
    /// goes up whenever Kybl drops listings because it changed something: a listing fetched
    /// from before isn't cached or shared
    epoch: AtomicU64,
    roots: Mutex<Option<(Instant, Roots)>>,
    roots_calls: Flights<(), Roots>,
    quota: Mutex<Option<(Instant, Option<QuotaPair>)>>,
    quota_calls: Flights<(), Option<QuotaPair>>,
    /// per file version read lately: (last block asked for, blocks asked for in a row)
    reads: Mutex<HashMap<String, (u64, u32)>>,
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
        let inner = Arc::new_cyclic(|me| Inner {
            me: me.clone(),
            open,
            spec,
            started: SystemTime::now(),
            listings: Mutex::default(),
            listing_calls: Flights::default(),
            epoch: AtomicU64::new(0),
            roots: Mutex::default(),
            roots_calls: Flights::default(),
            quota: Mutex::default(),
            quota_calls: Flights::default(),
            reads: Mutex::default(),
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

    /// Runs `f` in the background, on its own task, so it finishes even when the request that
    /// started it is answered (or dropped) first.
    fn background<F>(&self, f: impl FnOnce(Arc<Inner>) -> F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        if let Some(me) = self.me.upgrade() {
            tokio::spawn(f(me));
        }
    }

    /// The roots of a drive that shows all of them, as folder names. An older list is answered
    /// at once and refreshed behind it: roots rarely change, and every path of the drive needs it.
    async fn roots(&self) -> FsResult<Roots> {
        let cached = self.roots.lock().unwrap().clone();
        if let Some((at, r)) = cached {
            if at.elapsed() >= ROOTS_TTL {
                self.background(|me| async move {
                    let _ = me.fetch_roots().await;
                });
            }
            return Ok(r);
        }
        self.fetch_roots().await
    }

    async fn fetch_roots(&self) -> FsResult<Roots> {
        self.roots_calls.run((), 0, || self.list_roots()).await
    }

    async fn list_roots(&self) -> FsResult<Roots> {
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
        let roots = self.roots().await?;
        // one root (SFTP, FTP, WebDAV, Dropbox): its contents are the drive's top
        if roots.len() == 1 {
            return Ok(Node::In { root: roots[0].1.clone(), key: rel.to_string() });
        }
        if rel.is_empty() {
            return Ok(Node::Top);
        }
        let (first, rest) = rel.split_once('/').unwrap_or((rel, ""));
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

    /// The folder `dir` ("" or ending with `/`), from the cache while it is fresh; while it is
    /// merely stale, from the cache too, with a fresh listing fetched behind it.
    async fn listing(&self, root: &str, dir: &str) -> FsResult<Arc<Listing>> {
        let k = (root.to_string(), dir.to_string());
        let cached = self.listings.lock().unwrap().get(&k).cloned();
        if let Some(l) = cached {
            let age = l.at.elapsed();
            if age < TTL {
                return Ok(l);
            }
            if age < STALE {
                let (root, dir) = k;
                self.background(|me| async move {
                    let _ = me.fetch_listing(&root, &dir).await;
                });
                return Ok(l);
            }
        }
        self.fetch_listing(root, dir).await
    }

    /// A fresh listing of `dir`, shared with anyone asking for it at the same time.
    async fn fetch_listing(&self, root: &str, dir: &str) -> FsResult<Arc<Listing>> {
        let epoch = self.epoch.load(Ordering::SeqCst);
        self.listing_calls.run((root.to_string(), dir.to_string()), epoch, || self.list_now(root, dir, epoch)).await
    }

    async fn list_now(&self, root: &str, dir: &str, epoch: u64) -> FsResult<Arc<Listing>> {
        let started = Instant::now();
        let s = self.storage().await?;
        let mut l = Listing { at: Instant::now(), dirs: BTreeSet::new(), files: BTreeMap::new(), links: BTreeMap::new() };
        let mut web_only = Vec::new();
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
                if link::web_url(&o).is_some() {
                    web_only.push((name, o));
                    continue;
                }
                l.files.insert(name, o);
            }
            match page.next_token {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        // named once everything else is known, so a shortcut never hides a real file: a taken
        // name gets a number ("Plan (2).gdoc.html"), in a stable order
        web_only.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.key.cmp(&b.1.key)));
        for (name, o) in web_only {
            let tag = link::tag(&o);
            let mut n = 1;
            let mut link_name = link::name(&name, tag, n);
            while l.dirs.contains(&link_name) || l.files.contains_key(&link_name) || l.links.contains_key(&link_name) {
                n += 1;
                link_name = link::name(&name, tag, n);
            }
            l.links.insert(link_name, o);
        }
        super::server::timing(|| format!("list {dir:?}: {} items in {} ms", l.dirs.len() + l.files.len(), started.elapsed().as_millis()));
        let l = Arc::new(l);
        let mut cache = self.listings.lock().unwrap();
        // something changed while this was listed: answer with it, but don't keep it
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Ok(l);
        }
        if cache.len() > 2000 {
            cache.retain(|_, v| v.at.elapsed() < STALE);
        }
        cache.insert((root.to_string(), dir.to_string()), l.clone());
        Ok(l)
    }

    /// Kybl changed something in the folder holding `key`.
    fn forget_parent(&self, root: &str, key: &str) {
        let (parent, _) = split_key(key.trim_end_matches('/'));
        let mut cache = self.listings.lock().unwrap();
        self.epoch.fetch_add(1, Ordering::SeqCst);
        cache.remove(&(root.to_string(), parent));
    }

    /// A folder and everything below it changed.
    fn forget_tree(&self, root: &str, dir: &str) {
        let mut cache = self.listings.lock().unwrap();
        self.epoch.fetch_add(1, Ordering::SeqCst);
        cache.retain(|(r, d), _| !(r == root && d.starts_with(dir)));
    }

    /// How many blocks to fetch ahead of block `idx` of `v`: none for a lone read, more and more
    /// while the file is read front to back. Kept per file version, not per open file: macOS's
    /// client reads a file as many ranged GETs, each a new open.
    fn read_ahead(&self, v: &FileVersion, idx: u64) -> u64 {
        let k = format!("{}\n{}\n{}", v.root, v.key, v.version);
        let mut reads = self.reads.lock().unwrap();
        if reads.len() > 512 {
            reads.clear();
        }
        let (last, run) = reads.get(&k).copied().unwrap_or((u64::MAX, 0));
        let run = if last != u64::MAX && idx == last + 1 {
            run + 1
        } else if idx == last {
            run
        } else {
            0
        };
        reads.insert(k, (idx, run));
        if run == 0 { 0 } else { (1u64 << run.min(3)).min(READ_AHEAD) }
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
            } else if let Some(e) = l.files.get(n) {
                Some(Found::File(e.clone()))
            } else {
                l.links.get(n).map(|e| Found::Link(e.clone()))
            }
        };
        if let Some(f) = hit(name) {
            return Ok(Some((key.to_string(), f)));
        }
        let want = nfc(name);
        let other = l.dirs.iter().chain(l.files.keys()).chain(l.links.keys()).find(|n| nfc(n) == want).cloned();
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
            Found::Link(e) => Meta::link(e, self.started),
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
                for (name, e) in &l.links {
                    out.insert(name.clone(), Meta::link(e, self.started));
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
                Some((_, Found::Link(e))) => Ok(Box::new(MemFile { data: Bytes::from(link_page(&e)), pos: 0, meta: Some(Meta::link(&e, self.started)) })),
                _ => Err(FsError::NotFound),
            };
        }
        // the shortcut is made here, from the document's link: there is nothing to save it to
        if matches!(found, Some((_, Found::Link(_)))) {
            return Err(FsError::Forbidden);
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
            // deleting the shortcut deletes the document, as with Drive for desktop's own
            // shortcuts (Drive keeps it in its trash)
            Some((real, Found::Link(e))) => {
                let s = self.storage().await?;
                s.delete(&root, std::slice::from_ref(&e.key), &[], &AtomicBool::new(false), &|_, _| {}).await.map_err(fs_err)?;
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
        let pending = self.uploads.get(&root, &key);
        let remote = self.remote(&root, &key).await?;
        if let (Some((_, Found::Link(e))), None) = (&remote, &pending) {
            return self.rename_link(&root, &key, e, &root2, &key2).await;
        }
        if root != root2 {
            // the client copies and deletes instead
            return Err(FsError::IsRemote);
        }
        if self.read_only(&root).await {
            return Err(FsError::Forbidden);
        }
        let (parent2, name2) = split_key(&key2);
        let key2 = format!("{parent2}{}", nfc(name2));
        let s = self.storage().await?;
        match (&remote, &pending) {
            (Some((real, Found::Dir)), _) => {
                // what the server had under each waiting save before the move: the files move
                // with the folder, and each save then builds on its file at the new name
                let inside: Vec<_> = self.uploads.pending().into_iter().filter(|p| p.root == root && p.key.starts_with(&dirkey(&key))).collect();
                let mut before = Vec::with_capacity(inside.len());
                for p in &inside {
                    let old = format!("{}{}", dirkey(real), &p.key[dirkey(&key).len()..]);
                    before.push(s.stat(&root, &old).await.ok().flatten());
                }
                s.rename(&Loc::new(&root, dirkey(real)), &Loc::new(&root, dirkey(&key2)), true).await.map_err(fs_err)?;
                for (p, pre) in inside.iter().zip(before) {
                    let moved = format!("{}{}", dirkey(&key2), &p.key[dirkey(&key).len()..]);
                    let post = s.stat(&root, &moved).await.ok().flatten();
                    self.uploads.rename(&root, &p.key, &moved, super::writeback::rebase(p.base.as_ref(), pre.as_ref(), post.as_ref()));
                }
                self.forget_tree(&root, &dirkey(real));
                self.forget_tree(&root, &dirkey(&key2));
            }
            (Some((real, Found::File(e))), _) => {
                s.rename(&Loc::new(&root, real.clone()), &Loc::new(&root, key2.clone()), false).await.map_err(fs_err)?;
                if let Some(p) = &pending {
                    // the moved file can carry a new ETag or time: the save builds on it as it
                    // is now at the new name, not on the old name's
                    let post = s.stat(&root, &key2).await.ok().flatten();
                    self.uploads.rename(&root, &key, &key2, super::writeback::rebase(p.base.as_ref(), Some(e), post.as_ref()));
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

    /// Renames or moves the document behind a shortcut: the shortcut's ending comes off the new
    /// name ("Plan.gdoc.html" to "Q3.gdoc.html" renames the document "Q3"). Refused across roots,
    /// where a client would copy the shortcut's page and delete the document.
    async fn rename_link(&self, root: &str, key: &str, e: &Entry, root2: &str, key2: &str) -> FsResult<()> {
        if root != root2 || self.read_only(root).await {
            return Err(FsError::Forbidden);
        }
        let (parent2, name2) = split_key(key2);
        let target = link::target_name(name2, link::tag(e)).ok_or(FsError::Forbidden)?;
        let to = format!("{parent2}{}", nfc(target));
        // the store would replace what is there; the client only checked the shortcut's name
        match self.lookup(root, &to).await? {
            None => {}
            Some(_) if to == e.key => {}
            Some(_) => return Err(FsError::Exists),
        }
        if to != e.key {
            let s = self.storage().await?;
            s.rename(&Loc::new(root, e.key.clone()), &Loc::new(root, to.clone()), false).await.map_err(fs_err)?;
        }
        self.forget_parent(root, key);
        self.forget_parent(root, &to);
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
        let dest = self.remote(&root2, &key2).await?;
        if matches!(dest, Some((_, Found::Link(_)))) {
            return Err(FsError::Forbidden);
        }
        let seen = match &dest {
            Some((_, Found::File(e))) => Some(BaseState::of(e)),
            _ => None,
        };
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
                Some((_, Found::Link(e))) => {
                    // a copy of the document where the store can copy it, which keeps it live
                    // (Finder's Duplicate); else a copy of the shortcut's page, which still works
                    let s = self.storage().await?;
                    let server_copy = match s.caps().server_copy {
                        ServerCopy::CrossRoot => true,
                        ServerCopy::SameRoot => root == root2,
                        ServerCopy::None => false,
                    };
                    let tag = link::tag(&e);
                    let target = name2.strip_suffix(&format!(".{tag}.html")).filter(|t| !t.is_empty());
                    if let Some(target) = target.filter(|_| server_copy) {
                        let to = format!("{parent2}{}", nfc(target));
                        if self.lookup(&root2, &to).await?.is_some() {
                            return Err(FsError::Exists);
                        }
                        s.copy(&Loc::new(&root, e.key.clone()), &Loc::new(&root2, to.clone()), false).await.map_err(fs_err)?;
                        self.forget_parent(&root2, &to);
                        return Ok(false);
                    }
                    std::fs::write(&temp, link_page(&e)).map_err(io_err)?;
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

    /// The quota, never slow: the last one known (refreshed behind it when old), else whatever
    /// arrives within [`QUOTA_WAIT`]; past that "unknown" (Finder shows no free space) until the
    /// call, which goes on in the background, has an answer.
    async fn quota(&self) -> FsResult<(u64, Option<u64>)> {
        let cached = *self.quota.lock().unwrap();
        if let Some((at, q)) = cached {
            if at.elapsed() >= QUOTA_TTL {
                self.background(|me| async move {
                    let _ = me.fetch_quota().await;
                });
            }
            return q.ok_or(FsError::NotImplemented);
        }
        let Some(me) = self.me.upgrade() else { return Err(FsError::NotImplemented) };
        let call = tokio::spawn(async move { me.fetch_quota().await });
        match tokio::time::timeout(QUOTA_WAIT, call).await {
            Ok(Ok(Ok(q))) => q.ok_or(FsError::NotImplemented),
            _ => {
                // "unknown" for now, already old: later asks answer at once (and join or start
                // a refresh) instead of each waiting again
                let mut q = self.quota.lock().unwrap();
                if q.is_none() {
                    let old = Instant::now().checked_sub(QUOTA_TTL).unwrap_or_else(Instant::now);
                    *q = Some((old, None));
                }
                Err(FsError::NotImplemented)
            }
        }
    }

    /// What Kybl does after it changed something in `dir` (and below).
    #[cfg(test)]
    pub fn forget_folder(&self, root: &str, dir: &str) {
        self.forget_tree(root, dir);
    }

    /// Makes every cached listing, the roots and the quota look `by` older (tests of what
    /// happens past the TTLs, without waiting for them).
    #[cfg(test)]
    pub fn age_caches(&self, by: Duration) {
        let older = |at: Instant| at.checked_sub(by).unwrap_or(at);
        for l in self.listings.lock().unwrap().values_mut() {
            *l = Arc::new(Listing { at: older(l.at), dirs: l.dirs.clone(), files: l.files.clone(), links: l.links.clone() });
        }
        if let Some((at, _)) = &mut *self.roots.lock().unwrap() {
            *at = older(*at);
        }
        if let Some((at, _)) = &mut *self.quota.lock().unwrap() {
            *at = older(*at);
        }
    }

    async fn fetch_quota(&self) -> FsResult<Option<QuotaPair>> {
        self.quota_calls
            .run((), 0, || async {
                let s = self.storage().await?;
                let q = s.quota().await.ok().flatten().map(|q| (q.used, q.total));
                *self.quota.lock().unwrap() = Some((Instant::now(), q));
                Ok(q)
            })
            .await
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
        let ahead = self.fs.read_ahead(&self.ver, idx);
        let b = self.fs.blocks.block(&*self.storage, &self.ver, idx).await.map_err(fs_err)?;
        self.cur = Some((idx, b.clone()));
        // read front to back: fetch the next blocks while this one is used (a lone read, like
        // Finder peeking at the end of a video for its icon, fetches nothing extra)
        for next in idx + 1..=idx + ahead {
            if !self.fs.blocks.prefetch(self.storage.clone(), &self.ver, next) {
                break;
            }
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
    /// what the file says of itself, when it isn't just "this many bytes, now"
    meta: Option<Meta>,
}

impl MemFile {
    fn new(data: Bytes) -> Self {
        Self { data, pos: 0, meta: None }
    }
}

impl DavFile for MemFile {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = self.meta.clone().unwrap_or_else(|| Meta { len: self.data.len() as u64, modified: SystemTime::now(), dir: false, etag: None });
        let m: Box<dyn DavMetaData> = Box::new(meta);
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
