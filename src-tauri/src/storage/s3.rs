//! S3 as a [`Storage`]: a thin adapter over the existing S3 code in `commands`, `multipart` and
//! `objects`. The S3 commands themselves don't go through it (they keep their own bodies); the
//! engines that work across providers (copying between connections, dual pane, the editor) do.

use std::{
    io,
    ops::Range,
    sync::{atomic::AtomicBool, atomic::Ordering, Arc},
    time::Duration,
};

use async_trait::async_trait;
use aws_sdk_s3::{
    error::SdkError,
    operation::head_object::HeadObjectOutput,
    presigning::PresigningConfig,
    primitives::ByteStream as S3Body,
    types::StorageClass,
    Client,
};
use bytes::Bytes;
use futures_util::StreamExt;

use super::*;
use crate::{
    commands::{copy_object, delete_keys, list_all, list_page, millis, obj_info, Headers},
    multipart::{self, SINGLE_PUT_LIMIT},
    state::{sdk_err, Profile},
    transfers::Outcome,
};

/// How a provider's S3 differs from AWS, by `profile.provider`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quirks {
    /// If-Match / If-None-Match on PUT are honoured (Hetzner and many others ignore or break them)
    pub conditional_put: bool,
    /// a simple upload's ETag is the MD5 of the content (not with server-side SSE-C, as on Kybl)
    pub etag_is_md5: bool,
    /// DeleteObjects works (the delete code falls back to one by one when it doesn't)
    pub bulk_delete: bool,
}

impl Quirks {
    pub fn for_provider(provider: &str) -> Self {
        match provider {
            "aws" | "r2" | "minio" => Self { conditional_put: true, etag_is_md5: true, bulk_delete: true },
            "kybl" => Self { conditional_put: false, etag_is_md5: false, bulk_delete: true },
            // hetzner, custom and anything unknown: assume the least
            _ => Self { conditional_put: false, etag_is_md5: true, bulk_delete: true },
        }
    }
}

pub fn s3_caps(provider: &str, q: Quirks) -> Capabilities {
    Capabilities {
        roots: RootsMode::Buckets,
        // only Kybl Storage's account owns its buckets (no region or location to pick)
        create_root: provider == "kybl",
        folders: FolderMode::Prefix,
        rename: RenameMode::CopyDelete,
        server_copy: ServerCopy::CrossRoot,
        share: ShareMode::Presign,
        share_expiry: true,
        streaming: StreamingMode::Presign,
        range_read: true,
        conditional_write: if q.conditional_put { CondWrite::IfMatch } else { CondWrite::Compare },
        hashes: if q.etag_is_md5 { vec![HashKind::Md5] } else { vec![] },
        thumbnails: ThumbMode::Local,
        metadata: MetaMode::S3,
        tags: true,
        storage_class: true,
        trash: false,
        versions: false,
        search: SearchMode::Scan,
        changes: false,
        multipart: true,
        max_object_size: Some(5 * 1024 * 1024 * 1024 * 1024),
        background_upload: true,
        local_paths: false,
    }
}

pub struct S3Backend {
    client: Client,
    /// the connection's id, to write down multipart uploads in case the app ends mid-way (leftovers.rs)
    profile_id: String,
    preset_bucket: Option<String>,
    quirks: Quirks,
    caps: Capabilities,
}

impl S3Backend {
    pub fn new(client: Client, profile: &Profile) -> Self {
        let quirks = Quirks::for_provider(&profile.provider);
        Self {
            client,
            profile_id: profile.id.clone(),
            preset_bucket: profile.bucket.clone().filter(|b| !b.trim().is_empty()),
            quirks,
            caps: s3_caps(&profile.provider, quirks),
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn quirks(&self) -> Quirks {
        self.quirks
    }

    fn bucket_root(name: String, created: Option<i64>) -> RootInfo {
        RootInfo { id: name.clone(), name, kind: RootKind::Bucket, created, read_only: false }
    }

    /// Puts small content in one request, honouring the precondition on the server when the
    /// provider can (else it was checked by reading first).
    async fn put_bytes(&self, root: &str, path: &str, body: Bytes, opts: &WriteOpts<'_>) -> SResult<Option<WriteOutcome>> {
        let mut req = self.client.put_object().bucket(root).key(path);
        if opts.preserve_meta {
            match self.client.head_object().bucket(root).key(path).send().await {
                Ok(h) => {
                    let k = Headers::of(&h);
                    req = req
                        .set_content_type(k.content_type)
                        .set_cache_control(k.cache_control)
                        .set_content_disposition(k.content_disposition)
                        .set_content_encoding(k.content_encoding)
                        .set_content_language(k.content_language)
                        .set_metadata(Some(k.metadata))
                        .set_storage_class(k.storage_class.as_deref().map(StorageClass::from));
                }
                Err(e) if is_404(&e) => {}
                Err(e) => return Err(sdk_err(e).into()),
            }
        }
        if let Some(ct) = &opts.content_type {
            req = req.content_type(ct);
        } else if !opts.preserve_meta {
            req = req.content_type(mime_guess::from_path(path).first_or_octet_stream().to_string());
        }
        if self.quirks.conditional_put {
            match &opts.precondition {
                Precondition::IfMatch(tag) => req = req.if_match(tag),
                Precondition::IfNoneMatch => req = req.if_none_match("*"),
                Precondition::IfUnchanged { etag: Some(tag), .. } => req = req.if_match(tag),
                _ => {}
            }
        }
        match req.body(S3Body::from(body)).send().await {
            Ok(_) => Ok(None),
            Err(e) if e.raw_response().is_some_and(|r| matches!(r.status().as_u16(), 409 | 412)) => {
                Ok(Some(WriteOutcome::Conflict(self.stat(root, path).await.ok().flatten())))
            }
            Err(e) => Err(sdk_err(e).into()),
        }
    }

    /// Checks a precondition by reading what is there. Some(conflict) when it fails.
    async fn compare(&self, root: &str, path: &str, pre: &Precondition) -> SResult<Option<WriteOutcome>> {
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
}

fn is_404<E>(e: &SdkError<E, aws_sdk_s3::config::http::HttpResponse>) -> bool {
    e.raw_response().is_some_and(|r| r.status().as_u16() == 404)
}

fn head_entry(key: &str, h: &HeadObjectOutput) -> Entry {
    Entry {
        key: key.to_string(),
        size: h.content_length().unwrap_or(0),
        modified: millis(h.last_modified()),
        etag: h.e_tag().map(|e| e.trim_matches('"').to_string()),
        storage_class: h.storage_class().map(|s| s.as_str().to_string()),
        mime: h.content_type().map(str::to_string),
        ..Default::default()
    }
}

/// "bytes 0-99/1234" -> (0..100, Some(1234))
fn content_range(v: &str) -> Option<(Range<u64>, Option<u64>)> {
    let rest = v.strip_prefix("bytes ")?;
    let (span, total) = rest.split_once('/')?;
    let (a, b) = span.split_once('-')?;
    let (a, b): (u64, u64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    Some((a..b + 1, total.trim().parse().ok()))
}

fn body_stream(body: S3Body) -> ByteStream {
    Box::pin(futures_util::stream::unfold(Some(body), |b| async move {
        let mut b = b?;
        match b.try_next().await {
            Ok(Some(chunk)) => Some((Ok(chunk), Some(b))),
            Ok(None) => None,
            // one error ends the stream
            Err(e) => Some((Err(io::Error::other(e)), None)),
        }
    }))
}

#[async_trait]
impl Storage for S3Backend {
    fn kind(&self) -> ConnKind {
        ConnKind::S3
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    /// The buckets, with the connection's own bucket first; just that bucket when the key may
    /// not list them (keys scoped to one bucket).
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        match self.client.list_buckets().send().await {
            Ok(out) => {
                let mut roots: Vec<RootInfo> = out
                    .buckets()
                    .iter()
                    .map(|b| Self::bucket_root(b.name().unwrap_or_default().to_string(), millis(b.creation_date())))
                    .collect();
                if let Some(b) = &self.preset_bucket
                    && !roots.iter().any(|r| r.id == *b)
                {
                    roots.insert(0, Self::bucket_root(b.clone(), None));
                }
                Ok(roots)
            }
            Err(e) => match &self.preset_bucket {
                Some(b) => Ok(vec![Self::bucket_root(b.clone(), None)]),
                None => Err(sdk_err(e).into()),
            },
        }
    }

    async fn create_root(&self, name: &str) -> SResult<()> {
        if !self.caps.create_root {
            return unsupported();
        }
        self.client.create_bucket().bucket(name).send().await.map_err(sdk_err)?;
        Ok(())
    }

    async fn list(&self, root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let out = self
            .client
            .list_objects_v2()
            .bucket(root)
            .prefix(dir)
            .delimiter("/")
            .max_keys(1000)
            .set_continuation_token(token)
            .send()
            .await
            .map_err(sdk_err)?;
        Ok(Page {
            folders: out.common_prefixes().iter().filter_map(|p| p.prefix().map(str::to_string)).collect(),
            objects: out.contents().iter().filter(|o| o.key() != Some(dir)).map(obj_info).collect(),
            next_token: if out.is_truncated().unwrap_or(false) { out.next_continuation_token().map(str::to_string) } else { None },
        })
    }

    /// The flat listing, 1,000 keys a page (S3 has no folders to walk).
    fn walk<'a>(&'a self, root: &'a str, dir: &'a str) -> BoxStream<'a, SResult<Vec<Entry>>> {
        Box::pin(futures_util::stream::unfold(Some(None::<String>), move |token| async move {
            let token = token?;
            match list_page(&self.client, root, dir, token.as_deref(), None).await {
                Ok(out) => {
                    let batch: Vec<Entry> = out.contents().iter().map(obj_info).collect();
                    let next = if out.is_truncated().unwrap_or(false) { out.next_continuation_token().map(|t| Some(t.to_string())) } else { None };
                    Some((Ok(batch), next))
                }
                Err(e) => Some((Err(e.into()), None)),
            }
        }))
    }

    async fn stat(&self, root: &str, path: &str) -> SResult<Option<Entry>> {
        if path.is_empty() || path.ends_with('/') {
            let out = self.client.list_objects_v2().bucket(root).prefix(path).max_keys(1).send().await.map_err(sdk_err)?;
            let any = !out.contents().is_empty() || out.key_count().unwrap_or(0) > 0;
            return Ok(any.then(|| Entry { key: path.to_string(), ..Default::default() }));
        }
        match self.client.head_object().bucket(root).key(path).send().await {
            Ok(h) => Ok(Some(head_entry(path, &h))),
            Err(e) if is_404(&e) => Ok(None),
            Err(e) => Err(sdk_err(e).into()),
        }
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        let mut req = self.client.get_object().bucket(root).key(path);
        if let Some(r) = &range {
            if r.end <= r.start {
                return Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total: None, range: Some(r.clone()), etag: None, content_type: None });
            }
            req = req.range(format!("bytes={}-{}", r.start, r.end - 1));
        }
        if let Some(tag) = if_match {
            req = req.if_match(tag);
        }
        let out = match req.send().await {
            Ok(out) => out,
            Err(e) if e.raw_response().is_some_and(|r| r.status().as_u16() == 412) => return Err(StorageError::conflict()),
            Err(e) if is_404(&e) => return Err(StorageError::not_found()),
            // asked past the end of the file: nothing to send
            Err(e) if e.raw_response().is_some_and(|r| r.status().as_u16() == 416) => {
                return Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total: None, range, etag: None, content_type: None });
            }
            Err(e) => return Err(sdk_err(e).into()),
        };
        let len = out.content_length().map(|l| l.max(0) as u64);
        let (sent, total) = match out.content_range().and_then(content_range) {
            Some((r, t)) => (Some(r), t),
            None => (None, len),
        };
        Ok(ReadStream {
            len,
            total,
            range: sent,
            etag: out.e_tag().map(|e| e.trim_matches('"').to_string()),
            content_type: out.content_type().map(str::to_string),
            body: body_stream(out.body),
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
        // the server checks Bytes writes itself where it can; everything else is compared first
        let server_checks = self.quirks.conditional_put && matches!(src, WriteSource::Bytes(_));
        if !server_checks && let Some(conflict) = self.compare(root, path, &opts.precondition).await? {
            return Ok(conflict);
        }
        match src {
            WriteSource::Path(p) => {
                let p = p.to_str().ok_or_else(|| StorageError::other("This file's name can't be read."))?.to_string();
                match multipart::upload_file(&self.client, &self.profile_id, root, path, &p, cancel, progress).await? {
                    Outcome::Done => {}
                    Outcome::Cancelled => return Ok(WriteOutcome::Cancelled),
                }
            }
            WriteSource::Bytes(b) => {
                let n = b.len() as u64;
                if let Some(conflict) = self.put_bytes(root, path, b, &opts).await? {
                    return Ok(conflict);
                }
                progress(n, n);
            }
            WriteSource::Stream { len: Some(n), mut body, .. } if n <= SINGLE_PUT_LIMIT => {
                let mut buf = Vec::with_capacity(n as usize);
                while let Some(chunk) = body.next().await {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(WriteOutcome::Cancelled);
                    }
                    buf.extend_from_slice(&chunk?);
                    progress(buf.len() as u64, n);
                }
                if let Some(conflict) = self.put_bytes(root, path, Bytes::from(buf), &opts).await? {
                    return Ok(conflict);
                }
            }
            WriteSource::Stream { len, body, reopen } => {
                return super::s3_stream::upload_stream(self, root, path, len, body, reopen, opts, progress, cancel).await;
            }
        }
        let entry = self.stat(root, path).await?.unwrap_or_else(|| Entry { key: path.to_string(), ..Default::default() });
        Ok(WriteOutcome::Done(entry))
    }

    async fn mkdir(&self, root: &str, dir: &str) -> SResult<()> {
        let key = if dir.ends_with('/') { dir.to_string() } else { format!("{dir}/") };
        self.client.put_object().bucket(root).key(key).send().await.map_err(sdk_err)?;
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
        let mut all: Vec<String> = files.to_vec();
        for d in dirs {
            all.extend(list_all(&self.client, root, d).await?.into_iter().map(|o| o.key));
        }
        all.sort();
        all.dedup();
        let total = all.len() as u64;
        let mut done = 0u64;
        on_progress(0, total);
        for chunk in all.chunks(1000) {
            if cancel.load(Ordering::Relaxed) {
                return Err(StorageError::cancelled());
            }
            delete_keys(&self.client, root, chunk).await?;
            done += chunk.len() as u64;
            on_progress(done, total);
        }
        Ok((done, total))
    }

    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        if from == to {
            return Err(StorageError::other("Source and destination are the same"));
        }
        if !is_dir {
            let h = self.client.head_object().bucket(&from.root).key(&from.path).send().await.map_err(sdk_err)?;
            return Ok(copy_object(&self.client, &from.root, &from.path, &to.root, &to.path, h.content_length().unwrap_or(0), None).await?);
        }
        if from.root == to.root && to.path.starts_with(&from.path) {
            return Err(StorageError::other("Cannot copy a folder into itself"));
        }
        for o in list_all(&self.client, &from.root, &from.path).await? {
            let dst = format!("{}{}", to.path, &o.key[from.path.len()..]);
            copy_object(&self.client, &from.root, &o.key, &to.root, &dst, o.size, None).await?;
        }
        Ok(())
    }

    /// S3 has no rename: copy, then delete the originals once every copy made it.
    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.copy(from, to, is_dir).await?;
        let never = AtomicBool::new(false);
        let (files, dirs) = if is_dir { (vec![], vec![from.path.clone()]) } else { (vec![from.path.clone()], vec![]) };
        self.delete(&from.root, &files, &dirs, &never, &|_, _| {}).await?;
        Ok(())
    }

    async fn share_link(&self, loc: &Loc, ttl: Option<Duration>) -> SResult<String> {
        let ttl = ttl.unwrap_or(Duration::from_secs(7 * 24 * 3600)).clamp(Duration::from_secs(60), Duration::from_secs(7 * 24 * 3600));
        let cfg = PresigningConfig::expires_in(ttl).map_err(|e| StorageError::other(e.to_string()))?;
        let req = self.client.get_object().bucket(&loc.root).key(&loc.path).presigned(cfg).await.map_err(sdk_err)?;
        Ok(req.uri().to_string())
    }

    fn as_s3(&self) -> Option<&S3Backend> {
        Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_reads() {
        assert_eq!(content_range("bytes 0-99/1234"), Some((0..100, Some(1234))));
        assert_eq!(content_range("bytes 5-5/*"), Some((5..6, None)));
        assert_eq!(content_range("nonsense"), None);
    }

    #[test]
    fn providers_get_their_quirks() {
        assert!(Quirks::for_provider("aws").conditional_put);
        assert!(!Quirks::for_provider("hetzner").conditional_put);
        assert!(!Quirks::for_provider("kybl").etag_is_md5);
        let caps = s3_caps("kybl", Quirks::for_provider("kybl"));
        assert!(caps.create_root);
        assert_eq!(caps.conditional_write, CondWrite::Compare);
        assert!(!s3_caps("aws", Quirks::for_provider("aws")).create_root);
    }
}
