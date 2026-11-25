//! The read cache of a mounted drive: files are fetched in blocks of [`BLOCK`] bytes with ranged
//! reads and kept on disk in `cache_dir/mount/<id>/`, up to a size limit, least recently used
//! first out.
//!
//! A block is named after the file *version* (connection, root, key and the etag, or size and
//! time when there is no etag), so a file that changes on the server is fetched again and the
//! old blocks simply age out. Two readers asking for the same block share one download.
//!
//! Downloads are bounded: at most [`FETCHES`] block downloads at once, of which at most
//! [`PREFETCHES`] are read-ahead, so a burst of preview reads (Finder draws an icon for every
//! video in view by reading its start and end) can't hog the connection, and a file being read
//! front to back always has room. Folder listings don't go through here and never wait on it.
//! Disk reads and writes of blocks run off the async threads.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;

use crate::storage::{SResult, Storage, StorageError};

/// Bytes per block: small, because most reads on a drive are peeks (Finder reads the start
/// and the end of every video and photo in view to draw its icon), and each peek costs a whole
/// block. Files read front to back fetch several blocks ahead instead (`webdav::RemoteRead`),
/// so streaming still moves in big steps. Was 4 MiB: 8 MiB per icon with the old read-ahead.
pub const BLOCK: u64 = 1024 * 1024;

/// Block downloads at once, over everything this drive reads.
pub const FETCHES: usize = 6;
/// Of those, read-ahead downloads at once; past it read-ahead is skipped, never queued.
pub const PREFETCHES: usize = 3;

/// The cache's default size per drive.
pub const DEFAULT_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

/// Which file version a block belongs to.
#[derive(Clone, Debug)]
pub struct FileVersion {
    pub root: String,
    pub key: String,
    pub size: u64,
    /// the etag, or "size-modified" for stores without one
    pub version: String,
}

impl FileVersion {
    /// The stem of this version's block files: a hash, so keys of any length and character fit.
    fn stem(&self) -> String {
        // the block size is part of the name: blocks cached with another size are never read
        // as this one's (they just age out)
        let d = ring::digest::digest(
            &ring::digest::SHA256,
            format!("{}\n{}\n{}\n{}\n{BLOCK}", self.root, self.key, self.size, self.version).as_bytes(),
        );
        d.as_ref()[..16].iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn blocks(&self) -> u64 {
        self.size.div_ceil(BLOCK)
    }
}

#[derive(Default)]
struct Index {
    /// block file name → (bytes, last use)
    entries: HashMap<String, (u64, u64)>,
    used: u64,
    tick: u64,
}

pub struct BlockCache {
    dir: PathBuf,
    limit: u64,
    index: Mutex<Index>,
    /// one lock per block being fetched, so the same block isn't downloaded twice at once
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// room for block downloads ([`FETCHES`])
    fetches: tokio::sync::Semaphore,
    /// room for read-ahead ([`PREFETCHES`])
    prefetches: Arc<tokio::sync::Semaphore>,
}

impl BlockCache {
    /// Opens (and indexes) the cache in `dir`, oldest files first in line to go.
    pub fn open(dir: PathBuf, limit: u64) -> Self {
        // blocks of remote files: this account only
        let _ = crate::files::filecache::private_dir(&dir);
        let mut found: Vec<(String, u64, std::time::SystemTime)> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                if name.ends_with(".tmp") {
                    let _ = std::fs::remove_file(e.path());
                    return None;
                }
                let m = e.metadata().ok()?;
                Some((name, m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)))
            })
            .collect();
        found.sort_by_key(|f| f.2);
        let mut index = Index::default();
        for (name, len, _) in found {
            index.tick += 1;
            index.used += len;
            index.entries.insert(name, (len, index.tick));
        }
        let c = Self {
            dir,
            limit,
            index: Mutex::new(index),
            inflight: Mutex::default(),
            fetches: tokio::sync::Semaphore::new(FETCHES),
            prefetches: Arc::new(tokio::sync::Semaphore::new(PREFETCHES)),
        };
        c.evict(None);
        c
    }

    pub fn used(&self) -> u64 {
        self.index.lock().unwrap().used
    }

    /// Empties the cache (the drive was removed, or the user cleared it).
    pub fn clear(&self) {
        let mut ix = self.index.lock().unwrap();
        for name in ix.entries.keys() {
            let _ = std::fs::remove_file(self.dir.join(name));
        }
        ix.entries.clear();
        ix.used = 0;
    }

    fn name(v: &FileVersion, idx: u64) -> String {
        format!("{}-{idx}", v.stem())
    }

    fn range_of(v: &FileVersion, idx: u64) -> std::ops::Range<u64> {
        let start = idx * BLOCK;
        start..(start + BLOCK).min(v.size)
    }

    /// The cached block, if there is one (and marks it as just used). The file is read off the
    /// async threads and outside the index lock, so other readers don't queue behind the disk.
    async fn cached(&self, name: &str) -> Option<Bytes> {
        if !self.index.lock().unwrap().entries.contains_key(name) {
            return None;
        }
        let path = self.dir.join(name);
        let read = tokio::task::spawn_blocking(move || std::fs::read(path)).await.unwrap_or_else(|e| Err(std::io::Error::other(e)));
        let mut ix = self.index.lock().unwrap();
        match read {
            Ok(b) => {
                ix.tick += 1;
                let t = ix.tick;
                if let Some(e) = ix.entries.get_mut(name) {
                    e.1 = t;
                }
                Some(Bytes::from(b))
            }
            Err(_) => {
                // deleted behind our back: forget it
                if let Some((len, _)) = ix.entries.remove(name) {
                    ix.used -= len;
                }
                None
            }
        }
    }

    pub fn has(&self, v: &FileVersion, idx: u64) -> bool {
        self.index.lock().unwrap().entries.contains_key(&Self::name(v, idx))
    }

    /// Whether the block is being downloaded right now.
    pub fn fetching(&self, v: &FileVersion, idx: u64) -> bool {
        self.inflight.lock().unwrap().contains_key(&Self::name(v, idx))
    }

    /// Fetches block `idx` in the background when read-ahead has room; false when it hadn't
    /// (read-ahead is a bonus: it never waits, so it never delays a read someone asked for).
    pub fn prefetch(self: &Arc<Self>, s: Arc<dyn Storage>, v: &FileVersion, idx: u64) -> bool {
        if idx >= v.blocks() || self.has(v, idx) || self.fetching(v, idx) {
            return true;
        }
        let Ok(permit) = self.prefetches.clone().try_acquire_owned() else { return false };
        let (me, v) = (self.clone(), v.clone());
        tokio::spawn(async move {
            let _ = me.block(&*s, &v, idx).await;
            drop(permit);
        });
        true
    }

    /// Writes a block aside and swaps it in (off the async threads), then makes room.
    async fn store(&self, name: &str, bytes: Bytes) {
        let path = self.dir.join(name);
        // a temporary name of its own (private to this account), renamed into place
        let tmp = self.dir.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
        let len = bytes.len() as u64;
        let wrote = tokio::task::spawn_blocking(move || {
            if crate::files::filecache::write_private(&tmp, &bytes).is_err() || std::fs::rename(&tmp, &path).is_err() {
                let _ = std::fs::remove_file(&tmp);
                return false;
            }
            true
        })
        .await
        .unwrap_or(false);
        if !wrote {
            return;
        }
        {
            let mut ix = self.index.lock().unwrap();
            ix.tick += 1;
            let t = ix.tick;
            if let Some((old, _)) = ix.entries.insert(name.to_string(), (len, t)) {
                ix.used -= old;
            }
            ix.used += len;
        }
        self.evict(Some(name));
    }

    /// Drops least recently used blocks until the cache fits its limit (never `keep`).
    fn evict(&self, keep: Option<&str>) {
        let mut gone = Vec::new();
        let mut ix = self.index.lock().unwrap();
        while ix.used > self.limit {
            let Some(victim) = ix
                .entries
                .iter()
                .filter(|(n, _)| Some(n.as_str()) != keep)
                .min_by_key(|(_, (_, t))| *t)
                .map(|(n, _)| n.clone())
            else {
                break;
            };
            if let Some((len, _)) = ix.entries.remove(&victim) {
                ix.used -= len;
            }
            gone.push(victim);
        }
        // deleted outside the lock: readers of other blocks don't wait on the disk
        drop(ix);
        for name in gone {
            let _ = std::fs::remove_file(self.dir.join(name));
        }
    }

    /// Block `idx` of `v`: from the cache, or fetched with a ranged read and cached.
    pub async fn block(&self, s: &dyn Storage, v: &FileVersion, idx: u64) -> SResult<Bytes> {
        if idx >= v.blocks() {
            return Ok(Bytes::new());
        }
        let name = Self::name(v, idx);
        if let Some(b) = self.cached(&name).await {
            return Ok(b);
        }
        let lock = self.inflight.lock().unwrap().entry(name.clone()).or_default().clone();
        let result = {
            let _held = lock.lock().await;
            match self.cached(&name).await {
                Some(b) => Ok(b),
                None => {
                    let _slot = self.fetches.acquire().await.expect("never closed");
                    self.fetch(s, v, idx).await
                }
            }
        };
        // the last one out removes the lock
        {
            let mut inflight = self.inflight.lock().unwrap();
            if Arc::strong_count(&lock) <= 2 {
                inflight.remove(&name);
            }
        }
        result
    }

    async fn fetch(&self, s: &dyn Storage, v: &FileVersion, idx: u64) -> SResult<Bytes> {
        let want = Self::range_of(v, idx);
        let r = s.read(&v.root, &v.key, Some(want.clone()), None).await?;
        if r.range.is_some() {
            let bytes = collect(r.body, want.end - want.start).await?;
            // a short answer (a dropped connection, a file that shrank) is passed on but never
            // kept: cached, it would be served as the whole block until the file changes
            if bytes.len() as u64 == want.end - want.start {
                self.store(&Self::name(v, idx), bytes.clone()).await;
            }
            return Ok(bytes);
        }
        // the store sent the whole file: keep every block on the way, answer with ours
        let mut body = r.body;
        let mut buf = BytesMut::with_capacity(BLOCK as usize);
        let mut at = 0u64;
        let mut ours = None;
        while let Some(chunk) = body.next().await {
            let mut chunk = chunk.map_err(StorageError::from)?;
            while !chunk.is_empty() {
                let room = (BLOCK - buf.len() as u64) as usize;
                let piece = chunk.split_to(room.min(chunk.len()));
                buf.extend_from_slice(&piece);
                if buf.len() as u64 == BLOCK {
                    let b = std::mem::replace(&mut buf, BytesMut::with_capacity(BLOCK as usize)).freeze();
                    self.store(&Self::name(v, at), b.clone()).await;
                    if at == idx {
                        ours = Some(b);
                    }
                    at += 1;
                }
            }
        }
        if !buf.is_empty() {
            let b = buf.freeze();
            // the last block only when the file really ended there
            if at * BLOCK + b.len() as u64 == v.size {
                self.store(&Self::name(v, at), b.clone()).await;
            }
            if at == idx {
                ours = Some(b);
            }
        }
        Ok(ours.unwrap_or_default())
    }
}

async fn collect(mut body: crate::storage::ByteStream, max: u64) -> SResult<Bytes> {
    let mut buf = BytesMut::with_capacity(max as usize);
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(StorageError::from)?;
        let room = (max - buf.len() as u64) as usize;
        buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if buf.len() as u64 >= max {
            break;
        }
    }
    Ok(buf.freeze())
}
