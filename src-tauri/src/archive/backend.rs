//! An open archive as a read-only [`Storage`]: a pane lists it like any folder, Quick Look and
//! the viewers read files out of it, and copying out (to another pane, a job, a download) reads
//! through the same trait as any connection. Its one root is the archive's file name.

use std::{
    io,
    ops::Range,
    sync::{atomic::AtomicBool, Arc},
};

use async_trait::async_trait;
use bytes::Bytes;

use super::index::{Index, Item};
use crate::storage::{
    Capabilities, ConnKind, Entry, ErrKind, FolderMode, Loc, Page, Progress, ReadStream, RenameMode, RootInfo, RootKind, RootsMode, SResult, Storage,
    StorageError, StreamingMode, ThumbMode, WriteOpts, WriteOutcome, WriteSource,
};

pub struct ArchiveBackend {
    pub root: String,
    pub index: Arc<Index>,
    caps: Capabilities,
}

pub fn read_only() -> StorageError {
    StorageError::new(ErrKind::PermissionDenied, "Archives open read-only. Extract the files to change them.")
}

impl ArchiveBackend {
    pub fn new(root: String, index: Arc<Index>) -> Self {
        let caps = Capabilities {
            roots: RootsMode::Single,
            folders: FolderMode::Real,
            rename: RenameMode::Native,
            streaming: StreamingMode::Proxy,
            range_read: true,
            thumbnails: ThumbMode::Local,
            ..Capabilities::default()
        };
        Self { root, index, caps }
    }

    fn entry(it: &Item) -> Entry {
        Entry {
            key: it.key.clone(),
            size: it.size as i64,
            modified: it.modified,
            // the CRC where the archive keeps one (zip), else size and time: changes with the content
            etag: Some(match it.crc {
                Some(c) => format!("{c:08x}"),
                None => format!("{:x}-{:x}", it.modified.unwrap_or(0), it.size),
            }),
            ..Default::default()
        }
    }

    fn check_root(&self, root: &str) -> SResult<()> {
        if root == self.root || root.is_empty() {
            Ok(())
        } else {
            Err(StorageError::not_found())
        }
    }
}

/// Streams a file out of the archive: unpacking runs on a blocking thread, chunks come through a
/// small channel (so a slow reader holds back the unpacking, and dropping the stream stops it).
pub fn stream_item(index: Arc<Index>, item: Item, range: Option<Range<u64>>) -> crate::storage::ByteStream {
    let (tx, rx) = tokio::sync::mpsc::channel::<io::Result<Bytes>>(4);
    tokio::task::spawn_blocking(move || {
        let res = index.read(&item, range, &mut |chunk| tx.blocking_send(Ok(Bytes::copy_from_slice(chunk))).is_ok());
        if let Err(e) = res {
            let _ = tx.blocking_send(Err(e));
        }
    });
    Box::pin(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|v| (v, rx)) }))
}

#[async_trait]
impl Storage for ArchiveBackend {
    fn kind(&self) -> ConnKind {
        ConnKind::Unknown
    }
    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        Ok(vec![RootInfo { id: self.root.clone(), name: self.root.clone(), kind: RootKind::Folder, created: None, read_only: true }])
    }

    async fn list(&self, root: &str, dir: &str, _token: Option<String>) -> SResult<Page> {
        self.check_root(root)?;
        if !self.index.has_dir(dir) {
            return Err(StorageError::not_found());
        }
        let (folders, files) = self.index.list(dir);
        Ok(Page { folders, objects: files.into_iter().map(Self::entry).collect(), next_token: None })
    }

    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        self.check_root(root)?;
        if path.is_empty() || path.ends_with('/') {
            return Ok(self.index.has_dir(path).then(|| Entry { key: path.to_string(), ..Default::default() }));
        }
        Ok(self.index.item(path).map(Self::entry))
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, _if_match: Option<&str>) -> SResult<ReadStream> {
        self.check_root(root)?;
        let item = self.index.item(path).ok_or_else(StorageError::not_found)?.clone();
        let total = item.size;
        let range = range.map(|r| r.start.min(total)..r.end.min(total));
        let len = range.as_ref().map(|r| r.end - r.start).unwrap_or(total);
        let etag = Self::entry(&item).etag;
        let content_type = mime_guess::from_path(&item.key).first().map(|m| m.essence_str().to_string());
        Ok(ReadStream { body: stream_item(self.index.clone(), item, range.clone()), len: Some(len), total: Some(total), range, etag, content_type })
    }

    async fn write(&self, _: &str, _: &str, _: WriteSource, _: WriteOpts<'_>, _: Progress<'_>, _: &Arc<AtomicBool>) -> SResult<WriteOutcome> {
        Err(read_only())
    }
    async fn mkdir(&self, _: &str, _: &str) -> SResult<()> {
        Err(read_only())
    }
    async fn delete(&self, _: &str, _: &[String], _: &[String], _: &AtomicBool, _: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<(u64, u64)> {
        Err(read_only())
    }
    async fn rename(&self, _: &Loc, _: &Loc, _: bool) -> SResult<()> {
        Err(read_only())
    }
}
