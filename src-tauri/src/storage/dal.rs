//! Path-based stores served by OpenDAL, behind [`Storage`]: Azure Blob Storage and Google Cloud
//! Storage today (the sign-in providers can build on the same adapter: hand [`DalBackend::new`]
//! an `Operator`).
//!
//! Every operator gets the app's one HTTP client (rustls on ring, see `net::http`), not OpenDAL's
//! default. Azure and GCS are prefix stores like S3: folders are key prefixes (an empty one is a
//! marker object), a rename copies and deletes, and copies stay on the server.

use std::{
    ops::Range,
    sync::{atomic::AtomicBool, Arc},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use futures_util::{StreamExt, TryStreamExt};
use opendal::{
    options::{DeleteOptions, ListOptions, ReaderOptions, WriteOptions},
    EntryMode, ErrorKind as DalKind, HttpTransporter, Metadata, OperationContext, Operator,
};
use opendal_http_transport_reqwest::ReqwestTransport;

use super::{net::*, *};
use crate::state::BlobConfig;

/// Upload part size: big enough for few requests, small enough for phones' memory.
const PART: usize = 8 * 1024 * 1024;

pub struct DalBackend {
    op: Operator,
    kind: ConnKind,
    caps: Capabilities,
    name: String,
    pages: PageCache,
}

/// A store's operator with the app's HTTP client in place of OpenDAL's default.
pub fn with_app_http(op: Operator) -> Operator {
    let ctx = OperationContext::new().with_http_transport(HttpTransporter::new(ReqwestTransport::new(http())));
    op.with_context(ctx)
}

fn prefix_caps(cond: CondWrite) -> Capabilities {
    Capabilities {
        roots: RootsMode::Single,
        folders: FolderMode::Prefix,
        rename: RenameMode::CopyDelete,
        server_copy: ServerCopy::SameRoot,
        streaming: StreamingMode::Proxy,
        range_read: true,
        conditional_write: cond,
        hashes: vec![HashKind::Md5],
        thumbnails: ThumbMode::Local,
        ..Capabilities::default()
    }
}

/// Azure Blob Storage: one container. The secret is the account key, or a SAS token (starting
/// with `?` or containing `sig=`).
pub fn azblob(blob: &BlobConfig, secret: Option<String>) -> SResult<DalBackend> {
    let account = blob.account.trim();
    let container = blob.container.as_deref().map(str::trim).filter(|c| !c.is_empty()).ok_or_else(|| StorageError::other("Enter the container to open."))?;
    if account.is_empty() && blob.endpoint.trim().is_empty() {
        return Err(StorageError::other("Enter the storage account name."));
    }
    let endpoint = match blob.endpoint.trim() {
        "" => format!("https://{account}.blob.core.windows.net"),
        e => e.trim_end_matches('/').to_string(),
    };
    let mut b = opendal::services::Azblob::default().container(container).endpoint(&endpoint);
    if !account.is_empty() {
        b = b.account_name(account);
    }
    match secret.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.starts_with('?') || s.contains("sig=") => b = b.sas_token(s.trim_start_matches('?')),
        Some(s) => b = b.account_key(s),
        None => return Err(StorageError::new(ErrKind::NeedsAuth, "Enter the account key or a SAS token.")),
    }
    let op = Operator::new(b).map_err(|e| dal_error(e, "connect"))?;
    Ok(DalBackend::new(with_app_http(op), ConnKind::Azblob, prefix_caps(CondWrite::IfMatch), container.to_string()))
}

/// Google Cloud Storage: one bucket. The secret is the service account's JSON key.
pub fn gcs(blob: &BlobConfig, secret: Option<String>) -> SResult<DalBackend> {
    use base64::Engine;
    let bucket = blob.container.as_deref().map(str::trim).filter(|c| !c.is_empty()).ok_or_else(|| StorageError::other("Enter the bucket to open."))?;
    let key = secret.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| StorageError::new(ErrKind::NeedsAuth, "Add the service account key (JSON)."))?;
    if serde_json::from_str::<serde_json::Value>(key).is_err() {
        return Err(StorageError::new(ErrKind::NeedsAuth, "The service account key should be the JSON file Google Cloud gave you."));
    }
    let mut b = opendal::services::Gcs::default()
        .bucket(bucket)
        .credential(&base64::engine::general_purpose::STANDARD.encode(key))
        // never look for credentials on this machine or a cloud VM: only the key given
        .disable_config_load()
        .disable_vm_metadata();
    if !blob.endpoint.trim().is_empty() {
        b = b.endpoint(blob.endpoint.trim());
    }
    let op = Operator::new(b).map_err(|e| dal_error(e, "connect"))?;
    Ok(DalBackend::new(with_app_http(op), ConnKind::Gcs, prefix_caps(CondWrite::Compare), bucket.to_string()))
}

fn millis(m: &Metadata) -> Option<i64> {
    m.last_modified().and_then(|t| SystemTime::from(t).duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
}

/// OpenDAL's root is "/"; ours is "".
fn dal_path(key: &str) -> String {
    if key.trim_matches('/').is_empty() { "/".to_string() } else { key.trim_start_matches('/').to_string() }
}

impl DalBackend {
    pub fn new(op: Operator, kind: ConnKind, caps: Capabilities, name: String) -> Self {
        Self { op, kind, caps, name, pages: PageCache::default() }
    }

    fn entry(key: String, m: &Metadata) -> Entry {
        let md5 = m.content_md5().map(str::to_string);
        Entry {
            key,
            size: m.content_length() as i64,
            modified: millis(m),
            etag: m.etag().map(str::to_string),
            mime: m.content_type().map(str::to_string),
            hashes: Hashes { md5, ..Default::default() },
            ..Default::default()
        }
    }

    async fn stat_meta(&self, path: &str) -> SResult<Option<Metadata>> {
        match self.op.stat(&dal_path(path)).await {
            Ok(m) => Ok(Some(m)),
            Err(e) if e.kind() == DalKind::NotFound => Ok(None),
            Err(e) => Err(dal_error(e, "look up")),
        }
    }

    /// Every file below `dir` (recursive listing).
    async fn files_below(&self, dir: &str) -> SResult<Vec<String>> {
        let opts = ListOptions { recursive: true, ..Default::default() };
        let mut l = self.op.lister_options(&dal_path(dir), opts).await.map_err(|e| dal_error(e, "list"))?;
        let mut out = Vec::new();
        while let Some(e) = l.try_next().await.map_err(|e| dal_error(e, "list"))? {
            if e.metadata().mode() == EntryMode::FILE {
                out.push(e.path().to_string());
            }
        }
        Ok(out)
    }

    async fn copy_any(&self, from: &str, to: &str, is_dir: bool) -> SResult<()> {
        if !is_dir {
            self.op.copy(&dal_path(from), &dal_path(to)).await.map_err(|e| dal_error(e, "copy"))?;
            return Ok(());
        }
        let (src, dst) = (dir_prefix(from), dir_prefix(to));
        if dst.starts_with(&src) {
            return Err(StorageError::other("Cannot copy a folder into itself"));
        }
        let files = self.files_below(&src).await?;
        let copies = futures_util::stream::iter(files.into_iter().map(|f| {
            let target = format!("{dst}{}", &f[src.len().min(f.len())..]);
            async move { self.op.copy(&f, &target).await.map_err(|e| dal_error(e, "copy")) }
        }))
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
        copies.into_iter().collect::<SResult<Vec<_>>>()?;
        Ok(())
    }
}

#[async_trait]
impl Storage for DalBackend {
    fn kind(&self) -> ConnKind {
        self.kind
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    /// Lists the top (and so checks the account and the key).
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        self.op.check().await.map_err(|e| dal_error(e, "open"))?;
        Ok(vec![root_info(self.name.clone())])
    }

    async fn list(&self, _root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let prefix = dir_prefix(dir);
        self.pages
            .page(&prefix, token, || async {
                let mut l = self.op.lister(&dal_path(&prefix)).await.map_err(|e| dal_error(e, "list"))?;
                let (mut folders, mut files) = (Vec::new(), Vec::new());
                while let Some(e) = l.try_next().await.map_err(|e| dal_error(e, "list"))? {
                    let key = e.path().trim_start_matches('/').to_string();
                    if key == prefix || key.is_empty() {
                        continue;
                    }
                    if e.metadata().mode() == EntryMode::DIR {
                        folders.push(key);
                    } else {
                        files.push(Self::entry(key, e.metadata()));
                    }
                }
                Ok((folders, files))
            })
            .await
    }

    async fn stat(&self, _root: &str, path: &str) -> SResult<Option<Entry>> {
        key_parts(path)?;
        if path.trim_matches('/').is_empty() {
            return Ok(Some(Entry::default()));
        }
        Ok(self.stat_meta(path).await?.and_then(|m| {
            let dir = m.mode() == EntryMode::DIR;
            (dir == path.ends_with('/')).then(|| if dir { Entry { key: dir_prefix(path), ..Default::default() } } else { Self::entry(path.to_string(), &m) })
        }))
    }

    async fn read(&self, _root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        if key_parts(path)?.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("This is a folder, not a file."));
        }
        let meta = self.stat_meta(path).await?.ok_or_else(StorageError::not_found)?;
        let total = meta.content_length();
        if if_match.is_some_and(|t| meta.etag() != Some(t)) {
            return Err(StorageError::conflict());
        }
        let (start, end) = match &range {
            Some(r) => (r.start.min(total), r.end.min(total).max(r.start.min(total))),
            None => (0, total),
        };
        let opts = ReaderOptions { if_match: if_match.map(str::to_string), content_length_hint: Some(total), ..Default::default() };
        let reader = self.op.reader_options(&dal_path(path), opts).await.map_err(|e| dal_error(e, "download"))?;
        let body: ByteStream = if end > start {
            let s = reader.into_bytes_stream(start..end).await.map_err(|e| dal_error(e, "download"))?;
            Box::pin(s.map(|c| c.map_err(std::io::Error::other)))
        } else {
            Box::pin(futures_util::stream::empty())
        };
        Ok(ReadStream {
            body,
            len: Some(end - start),
            total: Some(total),
            range: range.map(|_| start..end),
            etag: meta.etag().map(str::to_string),
            content_type: meta.content_type().map(str::to_string).or_else(|| Some(mime_of(path))),
        })
    }

    async fn write(
        &self,
        root: &str,
        path: &str,
        src: WriteSource,
        opts: WriteOpts<'_>,
        progress: Progress<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> SResult<WriteOutcome> {
        if key_parts(path)?.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("A file needs a name."));
        }
        if opts.precondition != Precondition::None {
            let now = self.stat(root, path).await?;
            if !precondition_holds(&opts.precondition, now.as_ref()) {
                return Ok(WriteOutcome::Conflict(now));
            }
        }
        let cap = self.op.info().capability();
        let mut wo = WriteOptions {
            content_type: Some(opts.content_type.clone().unwrap_or_else(|| mime_of(path))),
            chunk: Some(PART),
            concurrent: 4,
            ..Default::default()
        };
        match &opts.precondition {
            Precondition::IfMatch(t) | Precondition::IfUnchanged { etag: Some(t), .. } if cap.write_with_if_match => wo.if_match = Some(t.clone()),
            Precondition::IfNoneMatch if cap.write_with_if_not_exists => wo.if_not_exists = true,
            _ => {}
        }
        let (mut body, len) = source_stream(src).await?;
        let mut w = self.op.writer_options(&dal_path(path), wo).await.map_err(|e| dal_error(e, "upload"))?;
        let mut meter = Meter::new(len, progress, cancel);
        let sent: SResult<bool> = async {
            while let Some(chunk) = body.next().await {
                if meter.cancelled() {
                    return Ok(false);
                }
                let chunk = chunk?;
                let n = chunk.len();
                w.write(chunk).await.map_err(|e| dal_error(e, "upload"))?;
                meter.sent(n).await;
            }
            Ok(true)
        }
        .await;
        match sent {
            Ok(true) => {}
            Ok(false) => {
                let _ = w.abort().await;
                return Ok(WriteOutcome::Cancelled);
            }
            Err(e) => {
                let _ = w.abort().await;
                return Err(or_cancelled(e, cancel));
            }
        }
        match w.close().await {
            Ok(_) => {}
            Err(e) if e.kind() == DalKind::ConditionNotMatch || e.kind() == DalKind::AlreadyExists => {
                return Ok(WriteOutcome::Conflict(self.stat(root, path).await?));
            }
            Err(e) => return Err(dal_error(e, "upload")),
        }
        meter.finish();
        self.pages.forget(path);
        let entry = self.stat(root, path).await?.unwrap_or_else(|| Entry { key: path.to_string(), size: len.unwrap_or(0) as i64, ..Default::default() });
        Ok(WriteOutcome::Done(entry))
    }

    async fn mkdir(&self, _root: &str, dir: &str) -> SResult<()> {
        let d = dir_prefix(dir);
        if key_parts(&d)?.is_empty() {
            return Ok(());
        }
        self.pages.forget(&d);
        self.op.create_dir(&d).await.map_err(|e| dal_error(e, "make the folder"))
    }

    async fn delete(
        &self,
        _root: &str,
        files: &[String],
        dirs: &[String],
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> SResult<(u64, u64)> {
        let total = (files.len() + dirs.len()) as u64;
        let mut done = 0u64;
        on_progress(0, total);
        for (key, is_dir) in delete_items(files, dirs) {
            check_cancel(cancel)?;
            if key_parts(key)?.is_empty() {
                return Err(top_refused());
            }
            let r = if is_dir {
                self.op.delete_options(&dir_prefix(key), DeleteOptions { recursive: true, ..Default::default() }).await
            } else {
                self.op.delete(key).await
            };
            match r {
                Err(e) if e.kind() != DalKind::NotFound => return Err(dal_error(e, "delete")),
                _ => {}
            }
            self.pages.forget(&if is_dir { dir_prefix(key) } else { key.clone() });
            done += 1;
            on_progress(done, total);
        }
        Ok((done, total))
    }

    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.copy_any(&from.path, &to.path, is_dir).await?;
        self.pages.forget(&to.path);
        Ok(())
    }

    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        if key_parts(&from.path)?.is_empty() {
            return Err(top_refused());
        }
        self.copy_any(&from.path, &to.path, is_dir).await?;
        let r = if is_dir {
            self.op.delete_options(&dir_prefix(&from.path), DeleteOptions { recursive: true, ..Default::default() }).await
        } else {
            self.op.delete(&from.path).await
        };
        r.map_err(|e| dal_error(e, "delete").with_detail("Copied, but removing the original failed."))?;
        self.pages.forget(&from.path);
        self.pages.forget(&to.path);
        Ok(())
    }
}

/// OpenDAL errors, said plainly.
pub fn dal_error(e: opendal::Error, what: &str) -> StorageError {
    let detail = e.to_string();
    let low = detail.to_lowercase();
    let (kind, say) = match e.kind() {
        DalKind::NotFound => (ErrKind::NotFound, "This file or folder isn't there any more. It may have been moved or deleted.".to_string()),
        DalKind::PermissionDenied if low.contains("401") || low.contains("authenticat") || low.contains("signature") || low.contains("invalid_grant") => {
            (ErrKind::NeedsAuth, "The key was refused. Check the account and the key.".to_string())
        }
        DalKind::PermissionDenied => (ErrKind::PermissionDenied, format!("The key isn't allowed to {what} this.")),
        DalKind::AlreadyExists => (ErrKind::Exists, "Something with this name is already there.".to_string()),
        DalKind::ConditionNotMatch => (ErrKind::Conflict, "This file changed since it was opened.".to_string()),
        DalKind::RateLimited => (ErrKind::RateLimited, "The service is busy. Try again in a moment.".to_string()),
        DalKind::Unsupported => (ErrKind::Unsupported, "This connection doesn't support that.".to_string()),
        DalKind::ConfigInvalid => (ErrKind::Other, "The connection settings aren't valid.".to_string()),
        _ if low.contains("dns") || low.contains("connect") || low.contains("timed out") || low.contains("tls") => {
            (ErrKind::Network, "Couldn't reach the service. Check your internet connection.".to_string())
        }
        _ => (ErrKind::Other, format!("Couldn't {what} this.")),
    };
    StorageError::new(kind, say).with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_checked() {
        let blob = BlobConfig { account: "acct".into(), container: Some("box".into()), ..Default::default() };
        assert!(azblob(&blob, None).is_err());
        let b = azblob(&blob, Some("a2V5".into())).unwrap();
        assert_eq!(b.kind(), ConnKind::Azblob);
        assert_eq!(b.name, "box");
        assert_eq!(b.caps().folders, FolderMode::Prefix);
        assert!(azblob(&BlobConfig { account: "acct".into(), ..Default::default() }, Some("k".into())).is_err());
        assert!(azblob(&blob, Some("?sv=2024&sig=x".into())).is_ok());
        let g = BlobConfig { container: Some("bkt".into()), ..Default::default() };
        assert!(gcs(&g, Some("not json".into())).is_err());
        assert!(gcs(&g, None).is_err());
        assert_eq!(dal_path(""), "/");
        assert_eq!(dal_path("a/b/"), "a/b/");
    }
}
