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

/// A Content-MD5 as Azure and Google Cloud send it (base64 of the 16 bytes) as lowercase hex, the
/// form every hash in Kybl takes. Hex is passed through; anything else is no hash at all (a wrong
/// one would fail every verified copy, or worse, pass a bad one).
pub fn md5_hex(v: &str) -> Option<String> {
    use base64::Engine;
    let v = v.trim();
    if v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(v.to_ascii_lowercase());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(v).ok()?;
    (bytes.len() == 16).then(|| bytes.iter().map(|b| format!("{b:02x}")).collect())
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
        let md5 = m.content_md5().and_then(md5_hex);
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

    async fn copy_any(&self, from: &str, to: &str, is_dir: bool) -> SResult<()> {
        if !is_dir {
            return self.copy_key(&dal_path(from), &dal_path(to)).await;
        }
        copy_folder(self, from, to).await.map(|_| ())
    }
}

/// What folder copies and moves need of a prefix store, so their rules can be tested without one.
#[async_trait]
trait Keys: Sync {
    /// Every key below the prefix `dir`: (key, is a folder marker).
    async fn keys_below(&self, dir: &str) -> SResult<Vec<(String, bool)>>;
    async fn copy_key(&self, from: &str, to: &str) -> SResult<()>;
    async fn make_marker(&self, dir: &str) -> SResult<()>;
    /// Deletes one key; one that is already gone is fine.
    async fn delete_key(&self, key: &str) -> SResult<()>;
}

#[async_trait]
impl Keys for DalBackend {
    async fn keys_below(&self, dir: &str) -> SResult<Vec<(String, bool)>> {
        let opts = ListOptions { recursive: true, ..Default::default() };
        let mut l = self.op.lister_options(&dal_path(dir), opts).await.map_err(|e| dal_error(e, "list"))?;
        let mut out = Vec::new();
        while let Some(e) = l.try_next().await.map_err(|e| dal_error(e, "list"))? {
            let key = e.path().trim_start_matches('/').to_string();
            match e.metadata().mode() {
                EntryMode::FILE => out.push((key, false)),
                EntryMode::DIR if !key.is_empty() => out.push((key, true)),
                _ => {}
            }
        }
        Ok(out)
    }

    async fn copy_key(&self, from: &str, to: &str) -> SResult<()> {
        self.op.copy(from, to).await.map(|_| ()).map_err(|e| dal_error(e, "copy"))
    }

    async fn make_marker(&self, dir: &str) -> SResult<()> {
        self.op.create_dir(dir).await.map_err(|e| dal_error(e, "make the folder"))
    }

    async fn delete_key(&self, key: &str) -> SResult<()> {
        match self.op.delete(key).await {
            Err(e) if e.kind() != DalKind::NotFound => Err(dal_error(e, "delete")),
            _ => Ok(()),
        }
    }
}

/// Copies everything below the folder `from` to `to` on the server. Answers the source keys that
/// were copied (files, then folder markers) — only once every one of them made it.
async fn copy_folder(k: &(impl Keys + ?Sized), from: &str, to: &str) -> SResult<Vec<String>> {
    let (src, dst) = (dir_prefix(from), dir_prefix(to));
    if dst.starts_with(&src) {
        return Err(StorageError::other("Cannot copy a folder into itself"));
    }
    let listed = k.keys_below(&src).await?;
    let target = |key: &str| format!("{dst}{}", &key[src.len().min(key.len())..]);
    let (markers, files): (Vec<_>, Vec<_>) = listed.into_iter().filter(|(key, _)| key.starts_with(&src)).partition(|(_, m)| *m);
    let copies = futures_util::stream::iter(files.into_iter().map(|(f, _)| async move {
        let r = k.copy_key(&f, &target(&f)).await;
        (f, r)
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;
    let mut done = Vec::with_capacity(copies.len() + markers.len());
    let mut failed: Option<StorageError> = None;
    for (f, r) in copies {
        match r {
            Ok(()) => done.push(f),
            Err(e) => failed = failed.or(Some(e)),
        }
    }
    if let Some(e) = failed {
        return Err(e);
    }
    // empty folders come along too
    for (m, _) in markers {
        k.make_marker(&target(&m)).await?;
        done.push(m);
    }
    Ok(done)
}

/// Moves the folder `from` to `to`: copies, then deletes exactly the keys it copied — never a file
/// it didn't copy (one added since the listing, or one whose copy failed: then nothing is deleted).
async fn move_folder(k: &(impl Keys + ?Sized), from: &str, to: &str) -> SResult<()> {
    let copied = copy_folder(k, from, to).await?;
    // files first, then the markers deepest first, so a failure never leaves files in a folder
    // whose marker is gone
    let (mut markers, files): (Vec<_>, Vec<_>) = copied.into_iter().partition(|key| key.ends_with('/'));
    markers.sort_by_key(|m| std::cmp::Reverse(m.len()));
    let removals = futures_util::stream::iter(files.into_iter().map(|f| async move { k.delete_key(&f).await })).buffer_unordered(8).collect::<Vec<_>>().await;
    removals.into_iter().collect::<SResult<Vec<_>>>().map_err(|e| e.with_detail("Copied, but removing the original failed."))?;
    // the folder's own marker last (a listing may or may not include it)
    markers.push(dir_prefix(from));
    for m in &markers {
        k.delete_key(m).await.map_err(|e| e.with_detail("Copied, but removing the original failed."))?;
    }
    Ok(())
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
        if is_dir {
            move_folder(self, &from.path, &to.path).await?;
        } else {
            self.copy_any(&from.path, &to.path, false).await?;
            self.delete_key(&dal_path(&from.path)).await.map_err(|e| e.with_detail("Copied, but removing the original failed."))?;
        }
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

    #[test]
    fn content_md5s_become_hex() {
        // MD5("hello"), as Azure's Content-MD5 header and GCS's md5Hash send it
        assert_eq!(md5_hex("XUFAKrxLKna5cZ2REBfFkg==").as_deref(), Some("5d41402abc4b2a76b9719d911017c592"));
        assert_eq!(md5_hex("5D41402ABC4B2A76B9719D911017C592").as_deref(), Some("5d41402abc4b2a76b9719d911017c592"));
        assert_eq!(md5_hex("not a hash"), None);
        assert_eq!(md5_hex("aGVsbG8="), None, "base64, but not 16 bytes");
        let mut b = opendal::MetadataBuilder::file(5);
        b.content_md5("XUFAKrxLKna5cZ2REBfFkg==");
        let m = b.build();
        let e = DalBackend::entry("hello.txt".into(), &m);
        assert_eq!(e.hashes.md5.as_deref(), Some("5d41402abc4b2a76b9719d911017c592"), "the MD5 of the bytes, as copies compare it");
    }

    /// A prefix store in memory: copies of keys in `fail` fail, and `late` is added right after
    /// the first listing (someone uploading while the folder moves).
    #[derive(Default)]
    struct Fake {
        keys: std::sync::Mutex<std::collections::BTreeSet<String>>,
        fail: Vec<String>,
        late: Option<String>,
    }

    #[async_trait]
    impl Keys for Fake {
        async fn keys_below(&self, dir: &str) -> SResult<Vec<(String, bool)>> {
            let mut keys = self.keys.lock().unwrap();
            let out = keys.iter().filter(|k| k.starts_with(dir)).map(|k| (k.clone(), k.ends_with('/'))).collect();
            if let Some(l) = &self.late {
                keys.insert(l.clone());
            }
            Ok(out)
        }
        async fn copy_key(&self, from: &str, to: &str) -> SResult<()> {
            if self.fail.iter().any(|f| f == from) {
                return Err(StorageError::other("copy failed"));
            }
            let mut keys = self.keys.lock().unwrap();
            if !keys.contains(from) {
                return Err(StorageError::not_found());
            }
            keys.insert(to.to_string());
            Ok(())
        }
        async fn make_marker(&self, dir: &str) -> SResult<()> {
            self.keys.lock().unwrap().insert(dir.to_string());
            Ok(())
        }
        async fn delete_key(&self, key: &str) -> SResult<()> {
            self.keys.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn fake(keys: &[&str], fail: &[&str], late: Option<&str>) -> Fake {
        Fake {
            keys: std::sync::Mutex::new(keys.iter().map(|k| k.to_string()).collect()),
            fail: fail.iter().map(|k| k.to_string()).collect(),
            late: late.map(str::to_string),
        }
    }

    fn keys(f: &Fake) -> Vec<String> {
        f.keys.lock().unwrap().iter().cloned().collect()
    }

    #[tokio::test]
    async fn folder_moves_delete_only_what_they_copied() {
        // everything copies: the originals go, empty folders come along
        let f = fake(&["a/", "a/1.txt", "a/empty/", "a/sub/2.txt", "ab.txt"], &[], None);
        move_folder(&f, "a/", "b/").await.unwrap();
        assert_eq!(keys(&f), vec!["ab.txt", "b/", "b/1.txt", "b/empty/", "b/sub/2.txt"]);

        // a file uploaded into the folder after it was listed was never copied: it stays
        let f = fake(&["a/1.txt"], &[], Some("a/new.txt"));
        move_folder(&f, "a/", "b/").await.unwrap();
        assert_eq!(keys(&f), vec!["a/new.txt", "b/1.txt"]);

        // one copy fails: nothing is deleted, and the move says so
        let f = fake(&["a/1.txt", "a/2.txt"], &["a/2.txt"], None);
        assert!(move_folder(&f, "a/", "b/").await.is_err());
        let left = keys(&f);
        assert!(left.contains(&"a/1.txt".to_string()) && left.contains(&"a/2.txt".to_string()), "{left:?}");
        assert!(!left.contains(&"b/2.txt".to_string()));

        assert!(copy_folder(&f, "a/", "a/inner/").await.is_err(), "not into itself");
    }
}
