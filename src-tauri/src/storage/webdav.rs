//! WebDAV (Nextcloud, ownCloud, Synology, Apache, nginx, rclone...) as a [`Storage`], on the
//! shared HTTP client.
//!
//! Hand-written rather than OpenDAL's: its writer keeps a whole file in memory before sending it,
//! and it can't send `If-Match` on writes. Here uploads stream from disk, big uploads to Nextcloud
//! and ownCloud go up in chunks they can retry, and a connection given only a server's address
//! finds Nextcloud's WebDAV folder by itself.
//!
//! One root (`id = ""`). Keys map to URLs under the base URL, each part percent-encoded.

use std::{
    collections::HashSet,
    ops::Range,
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{header, Method, RequestBuilder, Response, StatusCode, Url};
use tokio::sync::OnceCell;

use super::{net::*, *};
use crate::state::{NetConfig, TlsMode};

/// Characters left as they are in a URL path part; everything else is percent-encoded.
const PART: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');
/// Nextcloud and ownCloud take bigger uploads in chunks; smaller ones go in one PUT.
const CHUNKED_ABOVE: u64 = 64 * 1024 * 1024;
const CHUNK_SIZE: usize = 16 * 1024 * 1024;
/// How long a MOVE or COPY may stay silent while the server works (a big copy, chunk assembly).
const PATIENT: Duration = Duration::from_secs(30 * 60);

const PROPS: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>"#;
const QUOTA_PROPS: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>"#;

pub fn webdav_caps() -> Capabilities {
    Capabilities {
        roots: RootsMode::Single,
        folders: FolderMode::Real,
        rename: RenameMode::Native,
        server_copy: ServerCopy::SameRoot,
        streaming: StreamingMode::Proxy,
        range_read: true,
        // sent as If-Match, and checked by reading first for servers that ignore it
        conditional_write: CondWrite::IfMatch,
        thumbnails: ThumbMode::Local,
        ..Capabilities::default()
    }
}

pub struct WebdavBackend {
    client: reqwest::Client,
    /// for MOVE and COPY, which the server may answer only once it has done the work
    patient: reqwest::Client,
    /// addresses to try, best first, until one answers as a WebDAV folder
    candidates: Vec<Url>,
    /// the one that did, ending with `/`
    base: OnceCell<Url>,
    user: String,
    password: Option<String>,
    name: String,
    caps: Capabilities,
    pages: PageCache,
    /// folders known to be there, so uploads into them don't make them again
    known_dirs: Mutex<HashSet<String>>,
}

/// One `<d:response>` of a PROPFIND.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DavItem {
    href: String,
    is_dir: bool,
    size: Option<u64>,
    modified: Option<i64>,
    etag: Option<String>,
    content_type: Option<String>,
    quota_available: Option<i64>,
    quota_used: Option<i64>,
}

impl WebdavBackend {
    pub fn new(cfg: &NetConfig, password: Option<String>) -> SResult<Self> {
        let candidates = candidate_urls(cfg)?;
        let name = match cfg.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            Some(u) => {
                let url = Url::parse(u).ok();
                let host = url.as_ref().and_then(|u| u.host_str()).unwrap_or(u).to_string();
                root_name(&host, &cfg.base_path)
            }
            None => root_name(&cfg.host, &cfg.base_path),
        };
        // its own client: it may trust the server's own certificate (see `certtrust`)
        let pin = cfg.cert_fingerprint.as_deref().filter(|f| !f.trim().is_empty());
        let tls = certtrust::client_config(pin).0;
        Ok(Self {
            client: http_with(&tls),
            patient: http_waiting(&tls, PATIENT),
            candidates,
            base: OnceCell::new(),
            user: cfg.user.trim().to_string(),
            password,
            name,
            caps: webdav_caps(),
            pages: PageCache::default(),
            known_dirs: Mutex::default(),
        })
    }

    fn req(&self, method: Method, url: Url) -> RequestBuilder {
        self.req_on(&self.client, method, url)
    }

    /// A MOVE or COPY: waits as long as the server takes to move or put a big file together.
    fn moving(&self, method: &[u8], url: Url) -> RequestBuilder {
        self.req_on(&self.patient, Method::from_bytes(method).expect("method"), url)
    }

    fn req_on(&self, client: &reqwest::Client, method: Method, url: Url) -> RequestBuilder {
        let r = client.request(method, url);
        if self.user.is_empty() { r } else { r.basic_auth(&self.user, self.password.as_deref()) }
    }

    /// The base URL, found on first use.
    async fn base(&self) -> SResult<&Url> {
        self.base
            .get_or_try_init(|| async {
                let mut last = None;
                for url in &self.candidates {
                    match self.probe(url).await {
                        Ok(true) => return Ok(url.clone()),
                        Ok(false) => {}
                        // a wrong password, an unreachable server or its certificate won't get better at another path
                        Err(e) if matches!(e.kind, ErrKind::NeedsAuth | ErrKind::Network | ErrKind::UntrustedCert | ErrKind::CertChanged) => return Err(e),
                        Err(e) => last = Some(e),
                    }
                }
                Err(StorageError::new(ErrKind::NotFound, "Couldn't find a WebDAV folder at this address. Check the address and the folder.")
                    .with_detail(last.map(|e| e.to_string()).unwrap_or_default()))
            })
            .await
    }

    /// Whether `url` answers as a WebDAV folder.
    async fn probe(&self, url: &Url) -> SResult<bool> {
        let resp = self.propfind(url.clone(), "0", PROPS).await?;
        match resp.status() {
            StatusCode::MULTI_STATUS => {
                let items = parse_multistatus(&resp.text().await.map_err(http_error)?)?;
                Ok(items.first().is_some_and(|i| i.is_dir))
            }
            StatusCode::UNAUTHORIZED => Err(wrong_login()),
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED | StatusCode::FORBIDDEN | StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND => Ok(false),
            _ => Err(status_error(resp, "list").await),
        }
    }

    async fn propfind(&self, url: Url, depth: &str, body: &'static str) -> SResult<Response> {
        self.req(Method::from_bytes(b"PROPFIND").expect("method"), url)
            .header("Depth", depth)
            .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
            .body(body)
            .send()
            .await
            .map_err(http_error)
    }

    /// The URL of a key (folders, ending with `/`, get a trailing slash).
    async fn url(&self, key: &str) -> SResult<Url> {
        let base = self.base().await?;
        url_of(base, key)
    }

    /// The key of an href in a PROPFIND answer; None when it's outside the base.
    async fn key_of(&self, href: &str, is_dir: bool) -> SResult<Option<String>> {
        let base = self.base().await?;
        Ok(key_of(base, href, is_dir))
    }

    fn entry(key: String, i: &DavItem) -> Entry {
        Entry {
            size: i.size.unwrap_or(0) as i64,
            modified: i.modified,
            etag: i.etag.clone(),
            mime: if i.is_dir { None } else { i.content_type.clone() },
            key,
            ..Default::default()
        }
    }

    async fn stat_url(&self, key: &str) -> SResult<Option<Entry>> {
        let url = self.url(key).await?;
        let resp = self.propfind(url, "0", PROPS).await?;
        match resp.status() {
            StatusCode::MULTI_STATUS => {}
            StatusCode::NOT_FOUND => return Ok(None),
            _ => return Err(status_error(resp, "look up").await),
        }
        let items = parse_multistatus(&resp.text().await.map_err(http_error)?)?;
        let Some(i) = items.into_iter().next() else { return Ok(None) };
        let k = key.trim_end_matches('/');
        Ok(Some(if i.is_dir {
            Self::entry(if k.is_empty() { String::new() } else { format!("{k}/") }, &i)
        } else {
            Self::entry(k.to_string(), &i)
        }))
    }

    /// A file never replaces a folder: with `Overwrite: T` the server would delete the whole
    /// collection (RFC 4918 9.9.3) to make room for it.
    async fn refuse_folder_at(&self, key: &str) -> SResult<()> {
        match self.stat_url(key.trim_end_matches('/')).await? {
            Some(e) if e.is_dir() => Err(StorageError::new(ErrKind::Exists, "A folder with this name is already there.")),
            _ => Ok(()),
        }
    }

    fn remember_dir(&self, key: &str) {
        self.known_dirs.lock().unwrap().insert(dir_prefix(key));
    }

    /// Makes the folder `dir` (key ending with `/`) and any missing parents.
    async fn ensure_dir(&self, dir: &str) -> SResult<()> {
        let dir = dir_prefix(dir);
        if dir.is_empty() || self.known_dirs.lock().unwrap().contains(&dir) {
            return Ok(());
        }
        // the nearest one first: usually only the last part is missing
        let mut missing = vec![dir.clone()];
        while let Some(d) = missing.last().cloned() {
            let resp = self.req(Method::from_bytes(b"MKCOL").expect("method"), self.url(&d).await?).send().await.map_err(http_error)?;
            match resp.status() {
                // made it, or it was there already
                s if s.is_success() || s == StatusCode::METHOD_NOT_ALLOWED => {
                    self.remember_dir(&d);
                    missing.pop();
                }
                // a parent is missing
                StatusCode::CONFLICT | StatusCode::NOT_FOUND if !parent_key(&d).is_empty() => {
                    let parent = parent_key(&d);
                    if missing.len() > 64 || missing.contains(&parent) {
                        return Err(status_error(resp, "make the folder").await);
                    }
                    missing.push(parent);
                }
                _ => return Err(status_error(resp, "make the folder").await),
            }
        }
        Ok(())
    }

    /// The Nextcloud/ownCloud user folder this connection points into, for chunked uploads:
    /// (the uploads collection URL, the user) when the base URL is `.../remote.php/dav/files/{user}/`.
    fn chunk_home(base: &Url) -> Option<Url> {
        let path = base.path();
        let at = path.find("/remote.php/dav/files/")?;
        let rest = &path[at + "/remote.php/dav/files/".len()..];
        let user = rest.split('/').next().filter(|u| !u.is_empty())?;
        let mut u = base.clone();
        u.set_path(&format!("{}/remote.php/dav/uploads/{user}/", &path[..at]));
        Some(u)
    }

    async fn put_once(
        &self,
        url: Url,
        body: ByteStream,
        len: Option<u64>,
        headers: header::HeaderMap,
        progress: Progress<'_>,
        cancel: &AtomicBool,
    ) -> SResult<Response> {
        let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
        let rx = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|c| (c, rx)) });
        let mut req = self.req(Method::PUT, url).headers(headers).body(reqwest::Body::wrap_stream(rx));
        if let Some(n) = len {
            // nginx and some others refuse chunked uploads; say the length up front
            req = req.header(header::CONTENT_LENGTH, n);
        }
        let send = async { req.send().await.map_err(http_error) };
        let pump = async {
            let mut body = body;
            let mut meter = Meter::new(len, progress, cancel);
            while let Some(chunk) = body.next().await {
                if meter.cancelled() {
                    let _ = tx.send(Err(std::io::Error::other(CANCELLED))).await;
                    return;
                }
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                };
                let n = chunk.len();
                if tx.send(Ok(chunk)).await.is_err() {
                    return;
                }
                meter.sent(n).await;
            }
            meter.finish();
            drop(tx);
        };
        let (resp, ()) = tokio::join!(send, pump);
        resp.map_err(|e| or_cancelled(e, cancel))
    }

    /// Nextcloud's chunked upload (v2): the chunks go into an upload folder, each retried on its
    /// own if the network hiccups, then the server puts them together at the destination.
    #[allow(clippy::too_many_arguments)]
    async fn put_chunked(
        &self,
        uploads: Url,
        dest: Url,
        mut body: ByteStream,
        total: u64,
        mut headers: header::HeaderMap,
        progress: Progress<'_>,
        cancel: &AtomicBool,
    ) -> SResult<Response> {
        let dir = uploads.join(&format!("kybl-{}/", uuid::Uuid::new_v4().simple())).map_err(|e| StorageError::other(e.to_string()))?;
        let dest_s = dest.to_string();
        // the final MOVE timed out: the server may still be putting the file together
        let mut assembling = false;
        let resp = self
            .req(Method::from_bytes(b"MKCOL").expect("method"), dir.clone())
            .header("Destination", &dest_s)
            .send()
            .await
            .map_err(http_error)?;
        if !resp.status().is_success() {
            return Err(status_error(resp, "start the upload").await);
        }
        let result: SResult<Response> = async {
            let mut meter = Meter::new(Some(total), progress, cancel);
            let mut buf = BytesMut::new();
            let mut n = 0u32;
            let mut ended = false;
            loop {
                // fill one chunk
                while !ended && buf.len() < CHUNK_SIZE {
                    match body.next().await {
                        Some(c) => buf.extend_from_slice(&c?),
                        None => ended = true,
                    }
                }
                if buf.is_empty() {
                    break;
                }
                let take = buf.len().min(CHUNK_SIZE);
                let part = buf.split_to(take).freeze();
                n += 1;
                let url = dir.join(&format!("{n:05}")).map_err(|e| StorageError::other(e.to_string()))?;
                let mut tries = 0u32;
                loop {
                    check_cancel(cancel)?;
                    let r = self
                        .req(Method::PUT, url.clone())
                        .header("Destination", &dest_s)
                        .header("OC-Total-Length", total)
                        .header(header::CONTENT_LENGTH, part.len())
                        .body(part.clone())
                        .send()
                        .await
                        .map_err(http_error);
                    match r {
                        Ok(resp) if resp.status().is_success() => break,
                        Ok(resp) if !resp.status().is_server_error() || tries >= 3 => return Err(status_error(resp, "upload").await),
                        Err(e) if e.kind != ErrKind::Network || tries >= 3 => return Err(e),
                        _ => {
                            tries += 1;
                            tokio::time::sleep(Duration::from_secs(1u64 << tries)).await;
                        }
                    }
                }
                meter.sent(part.len()).await;
            }
            check_cancel(cancel)?;
            meter.finish();
            headers.insert("OC-Total-Length", total.into());
            let file = dir.join(".file").map_err(|e| StorageError::other(e.to_string()))?;
            self.moving(b"MOVE", file)
                .headers(headers)
                .header("Destination", &dest_s)
                .header("Overwrite", "T")
                .send()
                .await
                .map_err(|e| {
                    assembling = e.is_timeout();
                    http_error(e)
                })
        }
        .await;
        let ok = matches!(&result, Ok(r) if r.status().is_success());
        // (left to the server then: deleting the parts could break the file it is making)
        if !ok && !assembling {
            let _ = self.req(Method::DELETE, dir).send().await;
        }
        result.map_err(|e| or_cancelled(e, cancel))
    }

    async fn move_or_copy(&self, method: &'static [u8], from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        let (src, dst) = if is_dir { (dir_prefix(&from.path), dir_prefix(&to.path)) } else { (from.path.clone(), to.path.clone()) };
        if key_parts(&src)?.is_empty() {
            return Err(top_refused());
        }
        if src == dst {
            return Err(StorageError::other("Source and destination are the same"));
        }
        if is_dir && dst.starts_with(&src) {
            return Err(StorageError::other("Cannot copy a folder into itself"));
        }
        self.ensure_dir(&parent_key(&dst)).await?;
        if !is_dir {
            self.refuse_folder_at(&dst).await?;
        }
        let mut req = self
            .moving(method, self.url(&src).await?)
            .header("Destination", self.url(&dst).await?.to_string())
            // a file replaces what is there (like S3); a folder never silently replaces another
            .header("Overwrite", if is_dir { "F" } else { "T" });
        if method == b"COPY" {
            req = req.header("Depth", "infinity");
        }
        let resp = req.send().await.map_err(http_error)?;
        self.pages.forget(&src);
        self.pages.forget(&dst);
        if method == b"MOVE" {
            self.known_dirs.lock().unwrap().retain(|d| !d.starts_with(&src));
        }
        match resp.status() {
            s if s.is_success() => whole_success(resp, if method == b"MOVE" { "move" } else { "copy" }).await,
            StatusCode::PRECONDITION_FAILED => Err(StorageError::exists()),
            _ => Err(status_error(resp, if method == b"MOVE" { "move" } else { "copy" }).await),
        }
    }
}

#[async_trait]
impl Storage for WebdavBackend {
    fn kind(&self) -> ConnKind {
        ConnKind::Webdav
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    /// The folder address paths start from.
    fn place_id(&self) -> Option<String> {
        let base = self.base.get().or(self.candidates.first())?;
        Some(format!("webdav:{}", base.as_str().trim_end_matches('/').to_ascii_lowercase()))
    }

    /// Finds the WebDAV folder (and so checks the address and the sign-in).
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        self.base().await?;
        Ok(vec![root_info(self.name.clone())])
    }

    async fn list(&self, _root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let prefix = dir_prefix(dir);
        self.pages
            .page(&prefix, token, || async {
                let resp = self.propfind(self.url(&prefix).await?, "1", PROPS).await?;
                if resp.status() != StatusCode::MULTI_STATUS {
                    return Err(status_error(resp, "list").await);
                }
                let items = parse_multistatus(&resp.text().await.map_err(http_error)?)?;
                let (mut folders, mut files) = (Vec::new(), Vec::new());
                for i in &items {
                    let Some(key) = self.key_of(&i.href, i.is_dir).await? else { continue };
                    // the folder itself, or something that isn't directly inside it
                    if key == prefix || !key.starts_with(&prefix) || key[prefix.len()..].trim_end_matches('/').contains('/') {
                        continue;
                    }
                    if i.is_dir {
                        self.remember_dir(&key);
                        folders.push(key);
                    } else {
                        files.push(Self::entry(key, i));
                    }
                }
                self.remember_dir(&prefix);
                Ok((folders, files))
            })
            .await
    }

    async fn stat(&self, _root: &str, path: &str) -> SResult<Option<Entry>> {
        if key_parts(path)?.is_empty() {
            return Ok(self.stat_url("").await?.map(|_| Entry::default()));
        }
        let found = self.stat_url(path).await?;
        // asked for a folder, found a file (or the other way round)
        Ok(found.filter(|e| e.is_dir() == (path.ends_with('/') || path.trim_matches('/').is_empty())))
    }

    async fn read(&self, _root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        if key_parts(path)?.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("This is a folder, not a file."));
        }
        let mut req = self.req(Method::GET, self.url(path).await?);
        if let Some(r) = &range {
            if r.end <= r.start {
                return Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total: None, range: Some(r.clone()), etag: None, content_type: None });
            }
            req = req.header(header::RANGE, format!("bytes={}-{}", r.start, r.end - 1));
        }
        if let Some(t) = if_match {
            req = req.header(header::IF_MATCH, t);
        }
        let resp = req.send().await.map_err(http_error)?;
        let status = resp.status();
        let h = resp.headers();
        let etag = h.get(header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
        let content_type = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
        let content_len = resp.content_length();
        match status {
            StatusCode::PARTIAL_CONTENT => {
                // report the bytes the server says it sent (callers check them against what they
                // asked for); a part that doesn't say where it belongs can't be used at all
                let cr = h.get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(extras::parse_content_range);
                let Some((sent, total)) = cr else {
                    return Err(StorageError::other("The server sent part of the file without saying which part."));
                };
                if content_len.is_some_and(|l| l != sent.end - sent.start) {
                    return Err(StorageError::other("The server sent a different amount of the file than it said."));
                }
                let body = resp.bytes_stream().map(|c| c.map_err(std::io::Error::other));
                Ok(ReadStream { body: Box::pin(body), len: content_len, total, range: Some(sent), etag, content_type })
            }
            StatusCode::OK => {
                let total = content_len;
                let body: ByteStream = Box::pin(resp.bytes_stream().map(|c| c.map_err(std::io::Error::other)));
                match range {
                    // the server sent it all: skip to the part asked for
                    Some(r) => {
                        let end = total.map_or(r.end, |t| r.end.min(t));
                        let start = r.start.min(end);
                        Ok(ReadStream { body: slice_stream(body, start, Some(end)), len: Some(end - start), total, range: Some(start..end), etag, content_type })
                    }
                    None => Ok(ReadStream { body, len: total, total, range: None, etag, content_type }),
                }
            }
            StatusCode::RANGE_NOT_SATISFIABLE => {
                let total = h.get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit('/').next()).and_then(|t| t.parse().ok());
                let r = range.unwrap_or(0..0);
                Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total, range: Some(r.start..r.start), etag, content_type })
            }
            StatusCode::PRECONDITION_FAILED => Err(StorageError::conflict()),
            _ => Err(status_error(resp, "download").await),
        }
    }

    async fn write(
        &self,
        _root: &str,
        path: &str,
        src: WriteSource,
        opts: WriteOpts<'_>,
        progress: Progress<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> SResult<WriteOutcome> {
        if key_parts(path)?.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("A file needs a name."));
        }
        // read first too: not every server honours If-Match on a PUT
        if opts.precondition != Precondition::None {
            let now = self.stat(_root, path).await?;
            if !precondition_holds(&opts.precondition, now.as_ref()) {
                return Ok(WriteOutcome::Conflict(now));
            }
        }
        self.ensure_dir(&parent_key(path)).await?;
        let mut headers = header::HeaderMap::new();
        match &opts.precondition {
            Precondition::IfMatch(t) | Precondition::IfUnchanged { etag: Some(t), .. } => {
                if let Ok(v) = header::HeaderValue::from_str(t) {
                    headers.insert(header::IF_MATCH, v);
                }
            }
            Precondition::IfNoneMatch => {
                headers.insert(header::IF_NONE_MATCH, header::HeaderValue::from_static("*"));
            }
            _ => {}
        }
        let ctype = opts.content_type.clone().unwrap_or_else(|| mime_of(path));
        if let Ok(v) = header::HeaderValue::from_str(&ctype) {
            headers.insert(header::CONTENT_TYPE, v);
        }
        // Nextcloud and ownCloud keep the file's own modification time when told it
        if let Some(ms) = opts.modified {
            headers.insert("X-OC-Mtime", (ms / 1000).into());
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(WriteOutcome::Cancelled);
        }
        self.refuse_folder_at(path).await?;
        let (body, len) = source_stream(src).await?;
        let url = self.url(path).await?;
        let base = self.base().await?.clone();
        let chunked = Self::chunk_home(&base).filter(|_| len.is_some_and(|n| n > CHUNKED_ABOVE));
        // Plain uploads go to a temporary name and are moved over the target once whole, so a
        // cancelled or broken upload never leaves half a file (many servers write a PUT in
        // place). A conditional write (an editor save) goes straight to the target, where the
        // server can check If-Match; Nextcloud's chunked uploads come together at the end anyway.
        let via_temp = chunked.is_none() && opts.precondition == Precondition::None;
        let tmp = via_temp.then(|| temp_key(path));
        let resp = match (chunked, &tmp) {
            (Some(uploads), _) => self.put_chunked(uploads, url.clone(), body, len.unwrap_or(0), headers, progress, cancel).await,
            (None, Some(t)) => self.put_once(self.url(t).await?, body, len, headers, progress, cancel).await,
            (None, None) => self.put_once(url.clone(), body, len, headers, progress, cancel).await,
        };
        let drop_tmp = || async {
            if let Some(t) = &tmp
                && let Ok(u) = self.url(t).await
            {
                let _ = self.req(Method::DELETE, u).send().await;
            }
        };
        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                drop_tmp().await;
                return if e.is_cancelled() { Ok(WriteOutcome::Cancelled) } else { Err(e) };
            }
        };
        self.pages.forget(path);
        match resp.status() {
            s if s.is_success() => {
                if let Some(t) = &tmp {
                    let moved = self
                        .moving(b"MOVE", self.url(t).await?)
                        .header("Destination", url.to_string())
                        .header("Overwrite", "T")
                        .send()
                        .await
                        .map_err(http_error)?;
                    if !moved.status().is_success() {
                        drop_tmp().await;
                        return Err(status_error(moved, "upload").await);
                    }
                }
                let entry = self.stat_url(path).await?.unwrap_or_else(|| Entry { key: path.to_string(), size: len.unwrap_or(0) as i64, ..Default::default() });
                Ok(WriteOutcome::Done(entry))
            }
            StatusCode::PRECONDITION_FAILED => Ok(WriteOutcome::Conflict(self.stat_url(path).await?)),
            _ => {
                drop_tmp().await;
                Err(status_error(resp, "upload").await)
            }
        }
    }

    async fn mkdir(&self, _root: &str, dir: &str) -> SResult<()> {
        key_parts(dir)?;
        self.pages.forget(&dir_prefix(dir));
        self.ensure_dir(dir).await
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
            let k = if is_dir { dir_prefix(key) } else { key.trim_end_matches('/').to_string() };
            // a folder goes in one request, everything inside it included
            let resp = self.req(Method::DELETE, self.url(&k).await?).send().await.map_err(http_error)?;
            if !resp.status().is_success() && resp.status() != StatusCode::NOT_FOUND {
                return Err(status_error(resp, "delete").await);
            }
            let partly = whole_success(resp, "delete").await;
            self.pages.forget(&k);
            partly?;
            if is_dir {
                self.known_dirs.lock().unwrap().retain(|d| !d.starts_with(&k));
            }
            done += 1;
            on_progress(done, total);
        }
        Ok((done, total))
    }

    async fn copy(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.move_or_copy(b"COPY", from, to, is_dir).await
    }

    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        self.move_or_copy(b"MOVE", from, to, is_dir).await
    }

    async fn quota(&self) -> SResult<Option<Quota>> {
        let resp = self.propfind(self.base().await?.clone(), "0", QUOTA_PROPS).await?;
        if resp.status() != StatusCode::MULTI_STATUS {
            return Ok(None);
        }
        let items = parse_multistatus(&resp.text().await.map_err(http_error)?)?;
        let Some(i) = items.first() else { return Ok(None) };
        // negative numbers mean "unknown" or "unlimited" (Nextcloud)
        Ok(match (i.quota_used, i.quota_available) {
            (Some(u), Some(a)) if u >= 0 && a >= 0 => Some(Quota { used: u as u64, total: Some((u + a) as u64) }),
            (Some(u), _) if u >= 0 => Some(Quota { used: u as u64, total: None }),
            _ => None,
        })
    }
}

// ---------------------------------------------------------------- addresses

/// The addresses to try, best first: what was typed (with the folder), then, when that is just
/// a server, Nextcloud's and ownCloud's WebDAV folders for the user.
fn candidate_urls(cfg: &NetConfig) -> SResult<Vec<Url>> {
    let typed = match cfg.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) if u.contains("://") => u.to_string(),
        Some(u) => format!("https://{u}"),
        None => {
            let (host, port) = socket_addr(cfg, 0);
            let scheme = if cfg.tls == TlsMode::None { "http" } else { "https" };
            let explicit = cfg.port != 0 || port_in_host(&cfg.host).is_some();
            let hostpart = if explicit {
                addr_string(&host, port)
            } else if host.contains(':') {
                format!("[{host}]")
            } else {
                host
            };
            format!("{scheme}://{hostpart}/")
        }
    };
    let mut url = Url::parse(&typed).map_err(|e| StorageError::other("That server address isn't valid.").with_detail(e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        // "webdav://" / "davs://" as some apps write them
        let secure = matches!(url.scheme(), "davs" | "webdavs");
        let rest = typed.split_once("://").map(|(_, r)| r).unwrap_or_default();
        url = Url::parse(&format!("{}://{rest}", if secure { "https" } else { "http" })).map_err(|e| StorageError::other("That server address isn't valid.").with_detail(e.to_string()))?;
    }
    // the user's folder goes after whatever path the address already has
    let server_only = url.path().trim_matches('/').is_empty();
    let mut base = url.clone();
    let mut path = url.path().trim_end_matches('/').to_string();
    for p in cfg.base_path.split('/').filter(|p| !p.is_empty()) {
        path.push('/');
        path.push_str(&utf8_percent_encode(p, PART).to_string());
    }
    path.push('/');
    base.set_path(&path);
    base.set_query(None);
    base.set_fragment(None);
    let mut out = vec![base];
    let user = cfg.user.trim();
    if server_only && !user.is_empty() {
        for prefix in ["remote.php/dav/files/", "nextcloud/remote.php/dav/files/"] {
            let mut u = url.clone();
            let mut p = format!("/{prefix}{}/", utf8_percent_encode(user, PART));
            for part in cfg.base_path.split('/').filter(|p| !p.is_empty()) {
                p.push_str(&utf8_percent_encode(part, PART).to_string());
                p.push('/');
            }
            u.set_path(&p);
            out.push(u);
        }
    }
    Ok(out)
}

fn url_of(base: &Url, key: &str) -> SResult<Url> {
    let parts = key_parts(key)?;
    let mut path = base.path().trim_end_matches('/').to_string();
    for p in &parts {
        path.push('/');
        path.push_str(&utf8_percent_encode(p, PART).to_string());
    }
    if parts.is_empty() || key.ends_with('/') {
        path.push('/');
    }
    let mut u = base.clone();
    u.set_path(&path);
    Ok(u)
}

/// The key of an href (absolute URL or path, percent-encoded any which way), relative to `base`.
fn key_of(base: &Url, href: &str, is_dir: bool) -> Option<String> {
    let path = if href.contains("://") { Url::parse(href).ok()?.path().to_string() } else { href.split(['?', '#']).next()?.to_string() };
    let decoded = percent_decode_str(&path).decode_utf8_lossy().into_owned();
    let base_path = percent_decode_str(base.path()).decode_utf8_lossy().into_owned();
    let rest = decoded.strip_prefix(base_path.trim_end_matches('/'))?;
    if !rest.is_empty() && !rest.starts_with('/') {
        return None;
    }
    let rest = rest.trim_matches('/');
    Some(match (rest.is_empty(), is_dir) {
        (true, _) => String::new(),
        (false, true) => format!("{rest}/"),
        (false, false) => rest.to_string(),
    })
}

// ---------------------------------------------------------------- PROPFIND answers

/// The `<d:response>`s of a 207 Multi-Status answer. Only properties under a 200 `propstat`
/// count (the others are the server saying it doesn't have them).
fn parse_multistatus(xml: &str) -> SResult<Vec<DavItem>> {
    use quick_xml::{events::Event, name::ResolveResult, NsReader};
    let mut r = NsReader::from_str(xml);
    let mut out = Vec::new();
    let mut item: Option<DavItem> = None;
    let mut stat = DavItem::default();
    let mut stat_ok = true;
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    loop {
        let (ns, ev) = r.read_resolved_event().map_err(|e| StorageError::other("The server's answer couldn't be read.").with_detail(e.to_string()))?;
        let dav = matches!(ns, ResolveResult::Bound(n) if n.as_ref() == "DAV:");
        match ev {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_string();
                let name = if dav { name } else { format!("x:{name}") };
                match name.as_str() {
                    "response" => item = Some(DavItem::default()),
                    "propstat" => {
                        stat = DavItem::default();
                        stat_ok = true;
                    }
                    "collection" if path.last().is_some_and(|p| p == "resourcetype") => stat.is_dir = true,
                    _ => {}
                }
                path.push(name);
                text.clear();
            }
            Event::Empty(e) => {
                let name = e.local_name().as_ref().to_string();
                if dav && name == "collection" && path.last().is_some_and(|p| p == "resourcetype") {
                    stat.is_dir = true;
                }
            }
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::CData(c) => text.push_str(&c.into_inner()),
            Event::GeneralRef(g) => {
                let s = format!("&{};", &*g);
                text.push_str(&quick_xml::escape::unescape(&s).map(|c| c.into_owned()).unwrap_or(s));
            }
            Event::End(_) => {
                let name = path.pop().unwrap_or_default();
                let t = text.trim();
                let parent = path.last().map(String::as_str);
                match (name.as_str(), parent) {
                    ("href", Some("response")) => {
                        if let Some(i) = item.as_mut() {
                            i.href = t.to_string();
                        }
                    }
                    ("status", Some("propstat")) => stat_ok = t.split_whitespace().nth(1).is_some_and(|c| c.starts_with('2')),
                    ("getcontentlength", _) => stat.size = t.parse().ok(),
                    ("getlastmodified", _) => stat.modified = parse_http_date(t),
                    ("getetag", _) if !t.is_empty() => stat.etag = Some(t.to_string()),
                    ("getcontenttype", _) if !t.is_empty() => stat.content_type = Some(t.to_string()),
                    ("quota-available-bytes", _) => stat.quota_available = t.parse().ok(),
                    ("quota-used-bytes", _) => stat.quota_used = t.parse().ok(),
                    ("propstat", _) if stat_ok => {
                        if let Some(i) = item.as_mut() {
                            let s = std::mem::take(&mut stat);
                            i.is_dir |= s.is_dir;
                            i.size = s.size.or(i.size);
                            i.modified = s.modified.or(i.modified);
                            i.etag = s.etag.or(i.etag.take());
                            i.content_type = s.content_type.or(i.content_type.take());
                            i.quota_available = s.quota_available.or(i.quota_available);
                            i.quota_used = s.quota_used.or(i.quota_used);
                        }
                    }
                    ("response", _) => {
                        if let Some(i) = item.take().filter(|i| !i.href.is_empty()) {
                            out.push(i);
                        }
                    }
                    _ => {}
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}

/// "Sat, 22 Nov 2026 10:00:00 GMT" (RFC 1123, what WebDAV sends) to milliseconds.
pub(crate) fn parse_http_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let s = s.split_once(',').map_or(s, |(_, r)| r).trim();
    let mut it = s.split_whitespace();
    let day: i64 = it.next()?.parse().ok()?;
    let mon = it.next()?;
    let year: i64 = it.next()?.parse().ok()?;
    let mut hms = it.next()?.split(':').map(|p| p.parse::<i64>());
    let (h, m, sec) = (hms.next()?.ok()?, hms.next()?.ok()?, hms.next()?.ok()?);
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let month = MONTHS.iter().position(|x| mon.to_ascii_lowercase().starts_with(x))? as i64 + 1;
    Some(days_from_civil(year, month, day)? * 86_400_000 + (h * 3600 + m * 60 + sec) * 1000)
}

/// Days since 1970-01-01 of a calendar date (Howard Hinnant's algorithm).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

// ---------------------------------------------------------------- errors

pub(crate) fn http_error(e: reqwest::Error) -> StorageError {
    use std::error::Error as _;
    // a certificate the user can check and trust
    if let Some(r) = certtrust::refusal_in(&e) {
        return r.into_error();
    }
    let mut src: Option<&dyn std::error::Error> = e.source();
    let mut io: Option<&std::io::Error> = None;
    let mut chain = e.to_string();
    while let Some(s) = src {
        chain.push_str(": ");
        chain.push_str(&s.to_string());
        if io.is_none() {
            io = s.downcast_ref::<std::io::Error>();
        }
        src = s.source();
    }
    let host = e.url().and_then(|u| u.host_str()).unwrap_or("The server").to_string();
    let low = chain.to_lowercase();
    if e.is_timeout() {
        return timed_out(&host).with_detail(chain);
    }
    if low.contains("certificate") || low.contains("tls") || low.contains("handshake") {
        return tls_error(chain);
    }
    if e.is_connect() {
        return match io {
            Some(io) => connect_error(io, &host).with_detail(chain),
            None if low.contains("dns") || low.contains("lookup") => StorageError::new(ErrKind::Network, format!("Couldn't find {host}. Check the address.")).with_detail(chain),
            None => StorageError::new(ErrKind::Network, format!("Couldn't reach {host}. Check the address and your internet connection.")).with_detail(chain),
        };
    }
    if low.contains(CANCELLED) {
        return StorageError::cancelled();
    }
    dropped().with_detail(chain)
}

/// A refused request, said plainly; `what` is the action ("upload", "delete").
/// A 207 answer to DELETE, MOVE or COPY lists what failed inside the folder (a locked or
/// read-only member): the first `<status>` that isn't 2xx, with its href. Ok(None) when all
/// went; Err when the answer can't be read whole (cut off, not XML, empty): nothing then says
/// that everything went.
fn multistatus_failure(xml: &str) -> Result<Option<String>, String> {
    use quick_xml::{events::Event, Reader};
    let mut r = Reader::from_str(xml);
    let (mut href, mut text) = (String::new(), String::new());
    let mut whole = false;
    loop {
        match r.read_event().map_err(|e| e.to_string())? {
            Event::Start(_) => text.clear(),
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::End(e) => {
                match e.local_name().as_ref() {
                    "href" => href = text.trim().to_string(),
                    "status" => {
                        // "HTTP/1.1 423 Locked"
                        let code = text.split_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok());
                        if code.is_some_and(|c| !(200..300).contains(&c)) {
                            return Ok(Some(format!("{href}: {}", text.trim())));
                        }
                    }
                    "multistatus" => whole = true,
                    _ => {}
                }
                text.clear();
            }
            Event::Eof if whole => return Ok(None),
            Event::Eof => return Err("the answer ended before </multistatus>".into()),
            _ => {}
        }
    }
}

/// Success, or for a 207 the members that failed said as an error. A 207 whose list can't be
/// read is no proof that everything went, so it fails too.
async fn whole_success(resp: Response, what: &str) -> SResult<()> {
    if resp.status() != StatusCode::MULTI_STATUS {
        return Ok(());
    }
    let unsure = |detail: String| {
        StorageError::other(format!("The server's answer was cut off, so Kybl can't tell whether it could {what} everything inside. Look at the folder, then try again.")).with_detail(detail)
    };
    let body = resp.text().await.map_err(|e| unsure(e.to_string()))?;
    match multistatus_failure(&body) {
        Ok(None) => Ok(()),
        Ok(Some(first)) => Err(StorageError::other(format!("The server couldn't {what} everything inside: something there is locked or read-only.")).with_detail(first)),
        Err(e) => Err(unsure(format!("HTTP 207: {e}"))),
    }
}

async fn status_error(resp: Response, what: &str) -> StorageError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = format!("HTTP {status}{}{}", if body.is_empty() { "" } else { ": " }, body.chars().take(400).collect::<String>());
    let (kind, say): (ErrKind, String) = match status {
        StatusCode::UNAUTHORIZED => (ErrKind::NeedsAuth, "Wrong user name or password.".into()),
        StatusCode::FORBIDDEN => (ErrKind::PermissionDenied, format!("The server didn't allow Kybl to {what} this.")),
        StatusCode::NOT_FOUND => (ErrKind::NotFound, "This file or folder isn't there any more. It may have been moved or deleted.".into()),
        StatusCode::METHOD_NOT_ALLOWED => (ErrKind::Unsupported, format!("The server doesn't let Kybl {what} this.")),
        StatusCode::CONFLICT => (ErrKind::NotFound, "The folder it goes in isn't there.".into()),
        StatusCode::PRECONDITION_FAILED => (ErrKind::Conflict, "This file changed since it was opened.".into()),
        StatusCode::PAYLOAD_TOO_LARGE => (ErrKind::TooLarge, "The server refused a file this large.".into()),
        StatusCode::LOCKED => (ErrKind::Conflict, "This file is locked on the server. It may be open somewhere else.".into()),
        StatusCode::INSUFFICIENT_STORAGE => (ErrKind::Other, "The server is out of space.".into()),
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => (ErrKind::RateLimited, "The server is busy. Try again in a moment.".into()),
        s if s.is_server_error() => (ErrKind::Other, format!("The server had a problem ({}). Try again.", s.as_u16())),
        s => (ErrKind::Other, format!("The server refused to {what} this ({}).", s.as_u16())),
    };
    StorageError::new(kind, say).with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(url: Option<&str>, host: &str, user: &str, base: &str) -> NetConfig {
        NetConfig { url: url.map(str::to_string), host: host.into(), user: user.into(), base_path: base.into(), tls: TlsMode::Implicit, ..Default::default() }
    }

    #[test]
    fn addresses_to_try() {
        let c = candidate_urls(&cfg(Some("https://cloud.example.com"), "", "al ice", "")).unwrap();
        let c: Vec<String> = c.iter().map(Url::to_string).collect();
        assert_eq!(c[0], "https://cloud.example.com/");
        assert_eq!(c[1], "https://cloud.example.com/remote.php/dav/files/al%20ice/");
        let c = candidate_urls(&cfg(Some("https://nas:5006/dav"), "", "me", "Photos/2026")).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].as_str(), "https://nas:5006/dav/Photos/2026/");
        let c = candidate_urls(&cfg(None, "nas.local:8080", "", "")).unwrap();
        assert_eq!(c[0].as_str(), "https://nas.local:8080/");
        let mut plain = cfg(None, "nas.local", "", "x");
        plain.tls = TlsMode::None;
        assert_eq!(candidate_urls(&plain).unwrap()[0].as_str(), "http://nas.local/x/");
        assert_eq!(candidate_urls(&cfg(Some("davs://h/x"), "", "", "")).unwrap()[0].as_str(), "https://h/x/");
    }

    #[test]
    fn keys_and_urls() {
        let base = Url::parse("https://h/remote.php/dav/files/me/").unwrap();
        assert_eq!(url_of(&base, "a b/c#1.txt").unwrap().as_str(), "https://h/remote.php/dav/files/me/a%20b/c%231.txt");
        assert_eq!(url_of(&base, "a/").unwrap().as_str(), "https://h/remote.php/dav/files/me/a/");
        assert_eq!(url_of(&base, "").unwrap().as_str(), "https://h/remote.php/dav/files/me/");
        assert!(url_of(&base, "../x").is_err());
        assert_eq!(key_of(&base, "/remote.php/dav/files/me/a%20b/", true).as_deref(), Some("a b/"));
        assert_eq!(key_of(&base, "https://h/remote.php/dav/files/me/a%20b/c%231.txt", false).as_deref(), Some("a b/c#1.txt"));
        assert_eq!(key_of(&base, "/remote.php/dav/files/me/", true).as_deref(), Some(""));
        assert_eq!(key_of(&base, "/remote.php/dav/files/meow/x", false), None);
        assert_eq!(WebdavBackend::chunk_home(&base).unwrap().as_str(), "https://h/remote.php/dav/uploads/me/");
        assert!(WebdavBackend::chunk_home(&Url::parse("https://nas/dav/").unwrap()).is_none());
    }

    #[test]
    fn reads_multistatus_answers() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
 <d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Sat, 22 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
   <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
 <D:response xmlns:D="DAV:"><D:href>/dav/Tom%20%26%20Jerry.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>12</D:getcontentlength><D:getetag>"abc"</D:getetag><D:getcontenttype>text/plain</D:getcontenttype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
 <response xmlns="DAV:"><href>/dav/a&amp;b/</href><propstat><prop><resourcetype><collection/></resourcetype><quota-used-bytes>5</quota-used-bytes><quota-available-bytes>-3</quota-available-bytes></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</d:multistatus>"#;
        let items = parse_multistatus(xml).unwrap();
        assert_eq!(items.len(), 3);
        assert!(items[0].is_dir);
        assert_eq!(items[0].size, None);
        assert_eq!(items[0].modified, Some(1_795_341_600_000));
        assert_eq!(items[1].href, "/dav/Tom%20%26%20Jerry.txt");
        assert!(!items[1].is_dir);
        assert_eq!(items[1].size, Some(12));
        assert_eq!(items[1].etag.as_deref(), Some("\"abc\""));
        assert_eq!(items[1].content_type.as_deref(), Some("text/plain"));
        assert_eq!(items[2].href, "/dav/a&b/");
        assert!(items[2].is_dir);
        assert_eq!(items[2].quota_used, Some(5));
        assert_eq!(items[2].quota_available, Some(-3));
    }

    /// A 207 to DELETE/MOVE/COPY that lists a failed member is a failure, not a success.
    #[test]
    fn partial_multistatus_is_a_failure() {
        let failed = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/f/locked.txt</d:href><d:status>HTTP/1.1 423 Locked</d:status></d:response></d:multistatus>"#;
        assert_eq!(multistatus_failure(failed).unwrap().as_deref(), Some("/dav/f/locked.txt: HTTP/1.1 423 Locked"));
        let fine = r#"<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/dav/f/</href><status>HTTP/1.1 204 No Content</status></response></multistatus>"#;
        assert_eq!(multistatus_failure(fine), Ok(None));
        // an answer that can't be read whole is no proof that everything went
        assert!(multistatus_failure("").is_err(), "empty");
        assert!(multistatus_failure(&fine[..fine.len() - 30]).is_err(), "cut off");
        assert!(multistatus_failure("<html><body>Bad gateway</body></html>").is_err(), "not a multistatus");
        assert!(multistatus_failure("<multistatus><response></multistatus>").is_err(), "not XML");
    }

    #[test]
    fn http_dates_and_ranges() {
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:01 GMT"), Some(1000));
        assert_eq!(parse_http_date("Sat, 22 Nov 2026 10:00:00 GMT"), Some(1_795_341_600_000));
        assert_eq!(parse_http_date("garbage"), None);
    }

    /// Reads report the bytes the server sent: a 206 for other bytes than asked says so, a 206
    /// that doesn't say which bytes it holds is refused, a 200 is cut to the range asked for.
    #[tokio::test]
    async fn ranged_reads_report_what_came() {
        use crate::oauth::mock::{Mock, Resp};
        let data: Vec<u8> = (0..100u8).collect();
        let listing = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
        let mock = Mock::start(move |req| match (req.method.as_str(), req.path.as_str()) {
            ("PROPFIND", "/") => Resp::bytes(207, listing).header("content-type", "application/xml"),
            ("GET", "/exact.bin") => Resp::bytes(206, data[10..20].to_vec()).header("content-range", "bytes 10-19/100"),
            ("GET", "/other.bin") => Resp::bytes(206, data[0..10].to_vec()).header("content-range", "bytes 0-9/100"),
            ("GET", "/unsaid.bin") => Resp::bytes(206, data[10..20].to_vec()),
            ("GET", "/whole.bin") => Resp::bytes(200, data.clone()),
            _ => Resp::status(404),
        })
        .await;
        let w = WebdavBackend::new(&cfg(Some(&format!("{}/", mock.base)), "", "", ""), None).unwrap();

        let r = w.read("", "exact.bin", Some(10..20), None).await.unwrap();
        assert_eq!((r.range.clone(), r.total), (Some(10..20), Some(100)));
        assert_eq!(r.collect(1000).await.unwrap(), (10..20u8).collect::<Vec<_>>());

        let r = w.read("", "other.bin", Some(10..20), None).await.unwrap();
        assert_eq!(r.range, Some(0..10), "the bytes sent, not the ones asked for");

        assert!(w.read("", "unsaid.bin", Some(10..20), None).await.is_err(), "no Content-Range: unusable");

        let r = w.read("", "whole.bin", Some(10..20), None).await.unwrap();
        assert_eq!(r.range, Some(10..20));
        assert_eq!(r.collect(1000).await.unwrap(), (10..20u8).collect::<Vec<_>>(), "the whole file, cut to the range");
    }
}
