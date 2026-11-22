//! The read cache of a mounted drive: files are fetched in blocks of [`BLOCK`] bytes with ranged
//! reads and kept on disk in `cache_dir/mount/<id>/`, up to a size limit, least recently used
//! first out.
//!
//! A block is named after the file *version* (connection, root, key and the etag, or size and
//! time when there is no etag), so a file that changes on the server is fetched again and the
//! old blocks simply age out. Two readers asking for the same block share one download.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;

use crate::storage::{SResult, Storage, StorageError};

/// Bytes per block: big enough that streaming a video is a handful of requests per second,
/// small enough that a peek at a file's header (Quick Look, thumbnails) stays cheap.
pub const BLOCK: u64 = 4 * 1024 * 1024;

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
        let d = ring::digest::digest(
            &ring::digest::SHA256,
            format!("{}\n{}\n{}\n{}", self.root, self.key, self.size, self.version).as_bytes(),
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
}

impl BlockCache {
    /// Opens (and indexes) the cache in `dir`, oldest files first in line to go.
    pub fn open(dir: PathBuf, limit: u64) -> Self {
        let _ = std::fs::create_dir_all(&dir);
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
        let c = Self { dir, limit, index: Mutex::new(index), inflight: Mutex::default() };
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

    /// The cached block, if there is one (and marks it as just used).
    fn cached(&self, name: &str) -> Option<Bytes> {
        let mut ix = self.index.lock().unwrap();
        if !ix.entries.contains_key(name) {
            return None;
        }
        match std::fs::read(self.dir.join(name)) {
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

    /// Writes a block aside and swaps it in, then makes room.
    fn store(&self, name: &str, bytes: &[u8]) {
        let path = self.dir.join(name);
        let tmp = self.dir.join(format!("{name}.tmp"));
        if std::fs::write(&tmp, bytes).is_err() || std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        {
            let mut ix = self.index.lock().unwrap();
            ix.tick += 1;
            let t = ix.tick;
            if let Some((old, _)) = ix.entries.insert(name.to_string(), (bytes.len() as u64, t)) {
                ix.used -= old;
            }
            ix.used += bytes.len() as u64;
        }
        self.evict(Some(name));
    }

    /// Drops least recently used blocks until the cache fits its limit (never `keep`).
    fn evict(&self, keep: Option<&str>) {
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
            let _ = std::fs::remove_file(self.dir.join(&victim));
        }
    }

    /// Block `idx` of `v`: from the cache, or fetched with a ranged read and cached.
    pub async fn block(&self, s: &dyn Storage, v: &FileVersion, idx: u64) -> SResult<Bytes> {
        if idx >= v.blocks() {
            return Ok(Bytes::new());
        }
        let name = Self::name(v, idx);
        if let Some(b) = self.cached(&name) {
            return Ok(b);
        }
        let lock = self.inflight.lock().unwrap().entry(name.clone()).or_default().clone();
        let result = {
            let _held = lock.lock().await;
            match self.cached(&name) {
                Some(b) => Ok(b),
                None => self.fetch(s, v, idx).await,
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
            self.store(&Self::name(v, idx), &bytes);
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
                    self.store(&Self::name(v, at), &b);
                    if at == idx {
                        ours = Some(b);
                    }
                    at += 1;
                }
            }
        }
        if !buf.is_empty() {
            let b = buf.freeze();
            self.store(&Self::name(v, at), &b);
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
