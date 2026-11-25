//! Video and audio for connections that can't hand out a presigned URL (this device's disk, and
//! the network and cloud providers): the web view plays them from the app itself.
//!
//! A media URL names one file version, packed like `thumb://`: the percent-encoded
//! `profileId \n root \n size \n etag \n path`. Media elements ask for it piece by piece with
//! `Range` headers; every answer is at most [`MAX_CHUNK`] bytes (a `206` with `Content-Range`,
//! even for `bytes=0-`), because a custom-scheme response is one buffer, not a stream. Players
//! take the shorter piece and ask for the next one.
//!
//! Two ways in, picked by [`media_base`] (the frontend's `playableUrl` asks it once):
//!
//! - **`media://`** (the default): a Tauri URI scheme. WebKit on macOS and iOS (`WKURLSchemeHandler`),
//!   WebView2 on Windows and the Android WebView (`shouldInterceptRequest`) all pass `Range` through
//!   and play 206 answers: Tauri's own `asset:` protocol plays video the same way, with 1 MB
//!   pieces. On Android this needs wry 0.57.1 or later, which works around a Chromium bug that
//!   skipped the start of every intercepted 206 body a second time (wry#1864).
//! - **a loopback HTTP server** on `127.0.0.1`, a random port and a random path token. The default
//!   on Linux, where WebKitGTK plays media through GStreamer, which never asks the app's URI scheme
//!   handlers (tauri#3725), and the fallback anywhere else: set `KYBL_MEDIA=http` (or
//!   `KYBL_MEDIA=scheme` to force the scheme). It is not the default on phones: Android's release
//!   build forbids cleartext HTTP (`usesCleartextTraffic=false`) and iOS may close the listening
//!   socket of a suspended app.
//!
//! The scheme can't notice that the web view gave up on a request (wry just drops the task), so
//! the 4 MiB cap is also what bounds wasted reads. Through the loopback server a dropped
//! connection drops the read with it.

use std::{
    convert::Infallible,
    net::Ipv4Addr,
    sync::{Arc, OnceLock},
};

use bytes::Bytes;
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{
    http::{header, HeaderValue, Method, Request, Response, StatusCode},
    AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};

use super::{registry, BoxFuture, ErrKind, Storage, StorageError};
use crate::state::AppState;

/// The most one reply carries.
pub const MAX_CHUNK: u64 = 4 * 1024 * 1024;

// ---------------------------------------------------------------- the URL

/// What a media URL names (see the module docs for the packing).
#[derive(Debug, PartialEq, Eq)]
pub struct MediaId<'a> {
    pub profile_id: &'a str,
    pub root: &'a str,
    /// None when the URL didn't say: looked up before answering
    pub size: Option<u64>,
    pub etag: &'a str,
    pub path: &'a str,
}

/// `profileId \n root \n size \n etag \n path`; the path goes last so it may contain anything.
pub fn parse_id(id: &str) -> Option<MediaId<'_>> {
    let mut parts = id.splitn(5, '\n');
    let (profile_id, root, size, etag, path) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if profile_id.is_empty() || path.is_empty() || path.ends_with('/') {
        return None;
    }
    Some(MediaId { profile_id, root, size: size.parse().ok(), etag, path })
}

/// The decoded id from a URL path (`/<pct id>`).
fn id_from_path(path: &str) -> String {
    percent_decode_str(path.trim_start_matches('/')).decode_utf8_lossy().into_owned()
}

// ---------------------------------------------------------------- ranges

/// The first range of a `Range: bytes=…` header as (first, last) byte, both inclusive, clamped
/// to the file. Err when it is malformed or starts past the end (answered with 416). Only the
/// first of several ranges is served: media elements never ask for more than one.
pub fn parse_range(h: &str, size: u64) -> Result<(u64, u64), ()> {
    let h = h.trim();
    let spec = match h.get(..6) {
        Some(unit) if unit.eq_ignore_ascii_case("bytes=") => &h[6..],
        _ => return Err(()),
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = first.split_once('-').ok_or(())?;
    let (a, b) = (a.trim(), b.trim());
    let num = |s: &str| -> Result<u64, ()> {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            return Err(());
        }
        s.parse().map_err(|_| ())
    };
    if a.is_empty() {
        // the last n bytes
        let n = num(b)?;
        if n == 0 || size == 0 {
            return Err(());
        }
        return Ok((size.saturating_sub(n), size - 1));
    }
    let start = num(a)?;
    if start >= size {
        return Err(());
    }
    let end = if b.is_empty() {
        size - 1
    } else {
        let e = num(b)?;
        if e < start {
            return Err(());
        }
        e.min(size - 1)
    };
    Ok((start, end))
}

// ---------------------------------------------------------------- answering

fn status_of(e: &StorageError) -> StatusCode {
    match e.kind {
        ErrKind::NotFound => StatusCode::NOT_FOUND,
        ErrKind::PermissionDenied => StatusCode::FORBIDDEN,
        ErrKind::NeedsAuth => StatusCode::UNAUTHORIZED,
        ErrKind::RateLimited => StatusCode::TOO_MANY_REQUESTS,
        ErrKind::Unsupported => StatusCode::NOT_IMPLEMENTED,
        ErrKind::Conflict => StatusCode::PRECONDITION_FAILED,
        ErrKind::Network => StatusCode::BAD_GATEWAY,
        ErrKind::Cancelled => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// A short plain-text error (the sentence people would read, no details).
fn error_reply(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .expect("valid response")
}

fn unsatisfiable(total: u64) -> Response<Vec<u8>> {
    let mut r = error_reply(StatusCode::RANGE_NOT_SATISFIABLE, "That part of the file isn't there.");
    r.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{total}")).expect("ascii"));
    r.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    r
}

/// The type players go by: the store's own answer unless it is the "no idea" one, else from the
/// file name.
fn content_type(path: &str, from_store: Option<&str>) -> String {
    match from_store {
        Some(t) if !t.is_empty() && t != "application/octet-stream" => t.to_string(),
        _ => mime_guess::from_path(path).first_or_octet_stream().to_string(),
    }
}

/// Answers one request for `id` from `s`: `method` GET or HEAD, `range` the `Range` header.
pub async fn answer(s: &dyn Storage, id: &MediaId<'_>, method: &Method, range: Option<&str>) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return error_reply(StatusCode::METHOD_NOT_ALLOWED, "Only GET and HEAD.");
    }
    match answer_inner(s, id, method, range).await {
        Ok(r) => r,
        Err(e) => error_reply(status_of(&e), &e.message),
    }
}

async fn answer_inner(s: &dyn Storage, id: &MediaId<'_>, method: &Method, range: Option<&str>) -> Result<Response<Vec<u8>>, StorageError> {
    let size = match id.size {
        Some(n) => n,
        None => match s.stat(id.root, id.path).await? {
            Some(e) if !e.is_dir() => e.size.max(0) as u64,
            _ => return Err(StorageError::not_found()),
        },
    };
    // what to send: [start, end) and whether it is a part
    let (start, end, partial) = match range {
        Some(h) => match parse_range(h, size) {
            Ok((a, b)) => (a, (b + 1).min(a + MAX_CHUNK), true),
            Err(()) => return Ok(unsatisfiable(size)),
        },
        None if size <= MAX_CHUNK => (0, size, false),
        None => (0, MAX_CHUNK, true),
    };

    let mut store_type: Option<String> = None;
    let mut total = size;
    let body: Vec<u8> = if method == Method::HEAD {
        Vec::new()
    } else {
        let want = end - start;
        let r = s.read(id.root, id.path, partial.then_some(start..end), None).await?;
        store_type = r.content_type.clone();
        // stores that can't read a range send the whole file: skip to the start here
        let whole = r.range.is_none();
        total = r.total.or(if whole { r.len } else { None }).unwrap_or(size);
        let mut skip = if whole { start } else { 0 };
        let mut buf = Vec::with_capacity(want.min(MAX_CHUNK) as usize);
        let mut stream = r.body;
        while (buf.len() as u64) < want {
            let Some(chunk) = stream.next().await else { break };
            let chunk = chunk?;
            let mut piece = &chunk[..];
            if skip > 0 {
                let n = skip.min(piece.len() as u64) as usize;
                piece = &piece[n..];
                skip -= n as u64;
            }
            let room = (want - buf.len() as u64) as usize;
            buf.extend_from_slice(&piece[..piece.len().min(room)]);
        }
        // the rest of the read is dropped here, which stops it
        drop(stream);
        buf
    };

    // the file changed since it was listed: answer for what is there now
    let sent_end = if method == Method::HEAD { end.min(total) } else { start + body.len() as u64 };
    if partial && (start >= total || sent_end <= start) && end > start {
        return Ok(unsatisfiable(total));
    }
    let partial = partial || sent_end - start < total;

    let mut b = Response::builder()
        .header(header::CONTENT_TYPE, content_type(id.path, store_type.as_deref()))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, (sent_end - start).to_string())
        // the URL names one version (etag + size); without an etag it could be anything next time
        .header(header::CACHE_CONTROL, if id.etag.is_empty() { "no-store" } else { "private, max-age=86400" })
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges");
    if partial {
        b = b
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{}/{total}", sent_end.max(start + 1) - 1));
    } else {
        b = b.status(StatusCode::OK);
    }
    Ok(b.body(body).expect("valid response"))
}

/// A request as both front doors see it: the decoded id, the method and the Range header.
async fn answer_request<R: Runtime>(app: &AppHandle<R>, id: &str, method: &Method, range: Option<&str>) -> Response<Vec<u8>> {
    let Some(id) = parse_id(id) else {
        return error_reply(StatusCode::BAD_REQUEST, "This isn't a media address Kybl knows.");
    };
    let state = app.state::<AppState>();
    match registry::open(app, &state, id.profile_id).await {
        Ok(s) => answer(&*s, &id, method, range).await,
        Err(e) => error_reply(StatusCode::NOT_FOUND, e.split("\n\n").next().unwrap_or("Connection not found")),
    }
}

fn range_of<B>(req: &Request<B>) -> Option<String> {
    req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string)
}

// ---------------------------------------------------------------- media:// (the URI scheme)

/// Serves `media://localhost/<id>` (`http://media.localhost/<id>` on Windows and Android). The
/// work runs on the async runtime; the web view's thread only hands the request over.
pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let id = id_from_path(request.uri().path());
    let range = range_of(&request);
    let method = request.method().clone();
    tauri::async_runtime::spawn(async move {
        responder.respond(answer_request(&app, &id, &method, range.as_deref()).await);
    });
}

// ---------------------------------------------------------------- the loopback server

/// Opens a connection's backend by profile id (the registry in the app, a fixed store in tests).
pub type Opener = Arc<dyn Fn(String) -> BoxFuture<'static, Result<Arc<dyn Storage>, String>> + Send + Sync>;

/// The running server: URLs are `base` + the percent-encoded id.
pub struct Loopback {
    pub base: String,
}

fn random_token() -> String {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut b).expect("system randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One request to the loopback server. Only `127.0.0.1:<port>` as the host (no page on another
/// name can reach it through DNS tricks) and only paths under the secret token.
async fn serve_http<B>(req: Request<B>, prefix: &str, host: &str, open: &Opener) -> Response<Vec<u8>> {
    if req.headers().get(header::HOST).and_then(|h| h.to_str().ok()) != Some(host) {
        return error_reply(StatusCode::FORBIDDEN, "Not here.");
    }
    let Some(rest) = req.uri().path().strip_prefix(prefix) else {
        return error_reply(StatusCode::NOT_FOUND, "Not here.");
    };
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return error_reply(StatusCode::METHOD_NOT_ALLOWED, "Only GET and HEAD.");
    }
    let id = id_from_path(rest);
    let Some(mid) = parse_id(&id) else {
        return error_reply(StatusCode::BAD_REQUEST, "This isn't a media address Kybl knows.");
    };
    match open(mid.profile_id.to_string()).await {
        Ok(s) => answer(&*s, &mid, req.method(), range_of(&req).as_deref()).await,
        Err(e) => error_reply(StatusCode::NOT_FOUND, e.split("\n\n").next().unwrap_or("Connection not found")),
    }
}

/// Starts the loopback server on `127.0.0.1` and a free port. It runs until the app quits.
pub async fn start_loopback(open: Opener) -> std::io::Result<Loopback> {
    use hyper::{server::conn::http1, service::service_fn};
    use hyper_util::rt::TokioIo;

    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let host: Arc<str> = format!("127.0.0.1:{port}").into();
    let prefix: Arc<str> = format!("/{token}/").into();
    let base = format!("http://{host}{prefix}");
    tokio::spawn(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((s, _)) => s,
                // out of file handles and the like: wait a moment instead of spinning
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    continue;
                }
            };
            let (open, host, prefix) = (open.clone(), host.clone(), prefix.clone());
            tokio::spawn(async move {
                let svc = service_fn(move |req| {
                    let (open, host, prefix) = (open.clone(), host.clone(), prefix.clone());
                    async move {
                        let r = serve_http(req, &prefix, &host, &open).await;
                        Ok::<_, Infallible>(r.map(|b| http_body_util::Full::new(Bytes::from(b))))
                    }
                });
                // a player that seeks or closes drops its connection: the read in flight goes with it
                let _ = http1::Builder::new().keep_alive(true).serve_connection(TokioIo::new(stream), svc).await;
            });
        }
    });
    Ok(Loopback { base })
}

fn app_opener<R: Runtime>(app: AppHandle<R>) -> Opener {
    Arc::new(move |profile_id: String| {
        let app = app.clone();
        Box::pin(async move {
            let state = app.state::<AppState>();
            registry::open(&app, &state, &profile_id).await
        })
    })
}

// ---------------------------------------------------------------- which one

/// How the web view should reach media: `scheme` "media" (use `convertFileSrc(id, "media")`;
/// `base` is empty) or "http" (`base` + the percent-encoded id).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaBase {
    pub scheme: &'static str,
    pub base: String,
}

/// Linux plays media through GStreamer, which can't use the app's URI schemes (see module docs).
fn loopback_wanted() -> bool {
    match std::env::var("KYBL_MEDIA").as_deref() {
        Ok("http") => true,
        Ok("scheme") => false,
        _ => cfg!(target_os = "linux"),
    }
}

#[tauri::command]
pub async fn media_base(app: AppHandle) -> Result<MediaBase, String> {
    static LOOPBACK: OnceLock<tokio::sync::OnceCell<Option<String>>> = OnceLock::new();
    let scheme = MediaBase { scheme: "media", base: String::new() };
    if !loopback_wanted() {
        return Ok(scheme);
    }
    let cell = LOOPBACK.get_or_init(Default::default);
    let base = cell.get_or_init(|| async { start_loopback(app_opener(app.clone())).await.ok().map(|l| l.base) }).await;
    // no server (no free port, sandbox): the scheme still works for most media
    Ok(match base {
        Some(b) => MediaBase { scheme: "http", base: b.clone() },
        None => scheme,
    })
}

// ---------------------------------------------------------------- tests

/// A store in memory, for tests here and in files/thumbs.rs: it can pretend it can't read ranges and
/// can hand out a remote thumbnail, and it records the ranges it was asked for.
#[cfg(test)]
pub(crate) mod test_store {
    use std::{
        collections::HashMap,
        ops::Range,
        sync::{atomic::AtomicBool, Arc, Mutex},
    };

    use bytes::Bytes;

    use crate::storage::*;

    pub struct MemStore {
        pub files: HashMap<String, Vec<u8>>,
        pub caps: Capabilities,
        pub remote_thumb: Option<Vec<u8>>,
        pub reads: Mutex<Vec<Option<Range<u64>>>>,
    }

    impl MemStore {
        pub fn new(range_read: bool) -> Self {
            Self { files: HashMap::new(), caps: Capabilities { range_read, ..Default::default() }, remote_thumb: None, reads: Mutex::new(vec![]) }
        }
        pub fn with(mut self, path: &str, bytes: Vec<u8>) -> Self {
            self.files.insert(path.to_string(), bytes);
            self
        }
    }

    #[async_trait::async_trait]
    impl Storage for MemStore {
        fn kind(&self) -> ConnKind {
            ConnKind::Webdav
        }
        fn caps(&self) -> &Capabilities {
            &self.caps
        }
        async fn roots(&self) -> SResult<Vec<RootInfo>> {
            Ok(vec![])
        }
        async fn list(&self, _: &str, _: &str, _: Option<String>) -> SResult<Page> {
            unsupported()
        }
        async fn stat(&self, _: &str, path: &str) -> SResult<Option<Entry>> {
            Ok(self.files.get(path).map(|b| Entry { key: path.into(), size: b.len() as i64, ..Default::default() }))
        }
        async fn read(&self, _: &str, path: &str, range: Option<Range<u64>>, _: Option<&str>) -> SResult<ReadStream> {
            self.reads.lock().unwrap().push(range.clone());
            let all = self.files.get(path).ok_or_else(StorageError::not_found)?.clone();
            let total = all.len() as u64;
            let (bytes, sent) = match range.filter(|_| self.caps.range_read) {
                Some(r) => {
                    let (a, b) = (r.start.min(total), r.end.min(total));
                    (all[a as usize..b as usize].to_vec(), Some(a..b))
                }
                None => (all, None),
            };
            let len = bytes.len() as u64;
            // in small pieces, like a network read
            let chunks: Vec<std::io::Result<Bytes>> = bytes.chunks(1000).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
            Ok(ReadStream { body: Box::pin(futures_util::stream::iter(chunks)), len: Some(len), total: Some(total), range: sent, etag: None, content_type: None })
        }
        async fn write(&self, _: &str, _: &str, _: WriteSource, _: WriteOpts<'_>, _: Progress<'_>, _: &Arc<AtomicBool>) -> SResult<WriteOutcome> {
            unsupported()
        }
        async fn mkdir(&self, _: &str, _: &str) -> SResult<()> {
            unsupported()
        }
        async fn delete(&self, _: &str, _: &[String], _: &[String], _: &AtomicBool, _: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<(u64, u64)> {
            unsupported()
        }
        async fn rename(&self, _: &Loc, _: &Loc, _: bool) -> SResult<()> {
            unsupported()
        }
        async fn thumbnail(&self, _: &Loc, _: &Entry) -> SResult<Option<Bytes>> {
            Ok(self.remote_thumb.clone().map(Bytes::from))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::test_store::MemStore;
    use super::*;
    use crate::storage::{local::LocalBackend, RootKind};

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const BIG: usize = 9 * 1024 * 1024 + 123;

    fn pattern(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    /// A local root with a small mp4, a 9 MiB mp4 and an empty file.
    async fn local() -> (Tmp, Arc<dyn Storage>, String) {
        let dir = std::env::temp_dir().join(format!("kybl-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("clips")).unwrap();
        std::fs::write(dir.join("clips/small.mp4"), pattern(1000)).unwrap();
        std::fs::write(dir.join("clips/big video.mp4"), pattern(BIG)).unwrap();
        std::fs::write(dir.join("empty.mp3"), b"").unwrap();
        let b = LocalBackend::with_roots(vec![("T".into(), RootKind::Folder, dir.clone())], false);
        let root = b.roots().await.unwrap()[0].id.clone();
        (Tmp(dir), Arc::new(b), root)
    }

    fn id_str(root: &str, size: &str, path: &str) -> String {
        format!("local\n{root}\n{size}\ne1\n{path}")
    }

    async fn get(s: &dyn Storage, root: &str, path: &str, size: u64, range: Option<&str>) -> Response<Vec<u8>> {
        let id = id_str(root, &size.to_string(), path);
        answer(s, &parse_id(&id).unwrap(), &Method::GET, range).await
    }

    fn h<'a>(r: &'a Response<Vec<u8>>, name: header::HeaderName) -> &'a str {
        r.headers().get(name).map(|v| v.to_str().unwrap()).unwrap_or("")
    }

    #[test]
    fn ids_and_ranges_parse() {
        assert_eq!(
            parse_id("p\nr\n42\ne\na/b\nc.mp4"),
            Some(MediaId { profile_id: "p", root: "r", size: Some(42), etag: "e", path: "a/b\nc.mp4" })
        );
        assert_eq!(parse_id("p\nr\n\n\nx.mp4").unwrap().size, None);
        assert_eq!(parse_id("p\nr\n42\ne"), None);
        assert_eq!(parse_id("p\nr\n42\ne\nfolder/"), None);

        assert_eq!(parse_range("bytes=0-1", 100), Ok((0, 1)));
        assert_eq!(parse_range("bytes=10-", 100), Ok((10, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Ok((90, 99)));
        assert_eq!(parse_range("bytes=-500", 100), Ok((0, 99)));
        assert_eq!(parse_range("bytes=50-5000", 100), Ok((50, 99)));
        assert_eq!(parse_range("Bytes=0-0, 5-6", 100), Ok((0, 0)));
        assert_eq!(parse_range("bytes=100-", 100), Err(()));
        assert_eq!(parse_range("bytes=5-4", 100), Err(()));
        assert_eq!(parse_range("bytes=-0", 100), Err(()));
        assert_eq!(parse_range("bytes=0-", 0), Err(()));
        assert_eq!(parse_range("items=0-1", 100), Err(()));
        assert_eq!(parse_range("bytes=+1-2", 100), Err(()));
        assert_eq!(parse_range("bytes=a-b", 100), Err(()));
    }

    #[test]
    fn local_files_answer_every_kind_of_range() {
        tauri::async_runtime::block_on(async {
            let (_t, s, root) = local().await;
            let big = pattern(BIG);
            let s = &*s;

            // small file, no Range: the whole thing
            let r = get(s, &root, "clips/small.mp4", 1000, None).await;
            assert_eq!(r.status(), StatusCode::OK);
            assert_eq!(r.body().len(), 1000);
            assert_eq!(h(&r, header::CONTENT_LENGTH), "1000");
            assert_eq!(h(&r, header::CONTENT_TYPE), "video/mp4");
            assert_eq!(h(&r, header::ACCEPT_RANGES), "bytes");
            assert_eq!(h(&r, header::CONTENT_RANGE), "");

            // WebKit's first probe
            let r = get(s, &root, "clips/big video.mp4", BIG as u64, Some("bytes=0-1")).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(r.body(), &big[0..2]);
            assert_eq!(h(&r, header::CONTENT_RANGE), format!("bytes 0-1/{BIG}"));
            assert_eq!(h(&r, header::CONTENT_LENGTH), "2");

            // open-ended: capped at 4 MiB
            let r = get(s, &root, "clips/big video.mp4", BIG as u64, Some("bytes=0-")).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(r.body().len() as u64, MAX_CHUNK);
            assert_eq!(r.body()[..], big[..MAX_CHUNK as usize]);
            assert_eq!(h(&r, header::CONTENT_RANGE), format!("bytes 0-{}/{BIG}", MAX_CHUNK - 1));

            // a seek into the middle, capped
            let r = get(s, &root, "clips/big video.mp4", BIG as u64, Some("bytes=5000000-")).await;
            assert_eq!(r.body()[..], big[5_000_000..5_000_000 + MAX_CHUNK as usize]);
            assert_eq!(h(&r, header::CONTENT_RANGE), format!("bytes 5000000-{}/{BIG}", 5_000_000 + MAX_CHUNK - 1));

            // the end of the file (where mp4 players look for the index)
            let r = get(s, &root, "clips/big video.mp4", BIG as u64, Some("bytes=-100")).await;
            assert_eq!(r.body()[..], big[BIG - 100..]);
            assert_eq!(h(&r, header::CONTENT_RANGE), format!("bytes {}-{}/{BIG}", BIG - 100, BIG - 1));

            // a closed range inside the cap, and one running past the end
            let r = get(s, &root, "clips/big video.mp4", BIG as u64, Some("bytes=100-199")).await;
            assert_eq!(r.body()[..], big[100..200]);
            let r = get(s, &root, "clips/small.mp4", 1000, Some("bytes=900-5000")).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 900-999/1000");

            // a Range covering the whole small file is still a 206
            let r = get(s, &root, "clips/small.mp4", 1000, Some("bytes=0-")).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(r.body().len(), 1000);

            // no Range on a big file: the first piece, as a 206
            let r = get(s, &root, "clips/big video.mp4", BIG as u64, None).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(r.body().len() as u64, MAX_CHUNK);

            // past the end, malformed, empty file
            let r = get(s, &root, "clips/small.mp4", 1000, Some("bytes=1000-")).await;
            assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(h(&r, header::CONTENT_RANGE), "bytes */1000");
            let r = get(s, &root, "clips/small.mp4", 1000, Some("lines=1-2")).await;
            assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            let r = get(s, &root, "empty.mp3", 0, None).await;
            assert_eq!(r.status(), StatusCode::OK);
            assert!(r.body().is_empty());
            assert_eq!(h(&r, header::CONTENT_TYPE), "audio/mpeg");
            let r = get(s, &root, "empty.mp3", 0, Some("bytes=0-")).await;
            assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);

            // HEAD: the headers, no body, no read
            let id = id_str(&root, &BIG.to_string(), "clips/big video.mp4");
            let r = answer(s, &parse_id(&id).unwrap(), &Method::HEAD, Some("bytes=0-")).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert!(r.body().is_empty());
            assert_eq!(h(&r, header::CONTENT_LENGTH), MAX_CHUNK.to_string());
            let r = answer(s, &parse_id(&id).unwrap(), &Method::POST, None).await;
            assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED);

            // size missing from the URL: looked up
            let id = id_str(&root, "", "clips/small.mp4");
            let r = answer(s, &parse_id(&id).unwrap(), &Method::GET, Some("bytes=-10")).await;
            assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 990-999/1000");

            // errors: gone, outside the root, a stale size (the file shrank)
            let r = get(s, &root, "clips/nope.mp4", 10, Some("bytes=0-")).await;
            assert_eq!(r.status(), StatusCode::NOT_FOUND);
            assert!(!r.body().is_empty());
            let r = get(s, &root, "../outside.mp4", 10, None).await;
            assert_eq!(r.status(), StatusCode::FORBIDDEN);
            let r = get(s, &root, "clips/small.mp4", 5000, Some("bytes=2000-")).await;
            assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(h(&r, header::CONTENT_RANGE), "bytes */1000");
            let r = get(s, &root, "clips/small.mp4", 5000, Some("bytes=500-")).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 500-999/1000");
        });
    }

    #[test]
    fn stores_without_ranges_are_skipped_to_the_start() {
        tauri::async_runtime::block_on(async {
            let data = pattern(12_345);
            let s = MemStore::new(false).with("v.webm", data.clone());
            let id = "p\nr\n12345\n\nv.webm";
            let r = answer(&s, &parse_id(id).unwrap(), &Method::GET, Some("bytes=5000-5999")).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(r.body()[..], data[5000..6000]);
            assert_eq!(h(&r, header::CONTENT_RANGE), "bytes 5000-5999/12345");
            assert_eq!(h(&r, header::CONTENT_TYPE), "video/webm");
            // no etag in the URL: nothing may be cached
            assert_eq!(h(&r, header::CACHE_CONTROL), "no-store");

            let s = MemStore::new(true).with("v.webm", data.clone());
            let r = answer(&s, &parse_id(id).unwrap(), &Method::GET, Some("bytes=5000-5999")).await;
            assert_eq!(r.body()[..], data[5000..6000]);
            assert_eq!(s.reads.lock().unwrap().as_slice(), &[Some(5000..6000)]);
        });
    }

    async fn raw_http(base: &str, path: &str, host: Option<&str>, extra: &str) -> (String, Vec<u8>) {
        let addr = base.trim_start_matches("http://").split('/').next().unwrap().to_string();
        let mut c = tokio::net::TcpStream::connect(&addr).await.unwrap();
        let host = host.unwrap_or(&addr);
        let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n{extra}\r\n");
        c.write_all(req.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        c.read_to_end(&mut out).await.unwrap();
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&out[..split]).into_owned(), out[split + 4..].to_vec())
    }

    #[test]
    fn the_loopback_server_answers_ranges_and_refuses_strangers() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_t, s, root) = local().await;
            let open: Opener = Arc::new(move |id: String| {
                let s = s.clone();
                Box::pin(async move { if id == "local" { Ok(s) } else { Err("Connection not found".to_string()) } })
            });
            let lb = start_loopback(open).await.unwrap();
            assert!(lb.base.starts_with("http://127.0.0.1:"));
            let path_of = |id: &str| {
                let base_path = format!("/{}", lb.base.splitn(4, '/').nth(3).unwrap());
                format!("{base_path}{}", percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC))
            };
            let big = pattern(BIG);
            let p = path_of(&id_str(&root, &BIG.to_string(), "clips/big video.mp4"));

            let (head, body) = raw_http(&lb.base, &p, None, "Range: bytes=1000-1999\r\n").await;
            assert!(head.starts_with("HTTP/1.1 206"), "{head}");
            assert!(head.to_lowercase().contains(&format!("content-range: bytes 1000-1999/{BIG}")), "{head}");
            assert_eq!(body, &big[1000..2000]);

            let (head, body) = raw_http(&lb.base, &p, None, "Range: bytes=0-\r\n").await;
            assert!(head.starts_with("HTTP/1.1 206"));
            assert_eq!(body.len() as u64, MAX_CHUNK);

            // wrong token, wrong host, unknown connection
            let (head, _) = raw_http(&lb.base, &format!("/nottoken/{}", &p[34..]), None, "").await;
            assert!(head.starts_with("HTTP/1.1 404"), "{head}");
            let (head, _) = raw_http(&lb.base, &p, Some("evil.example:80"), "").await;
            assert!(head.starts_with("HTTP/1.1 403"), "{head}");
            let (head, _) = raw_http(&lb.base, &path_of("other\nr\n1\ne\nx.mp4"), None, "").await;
            assert!(head.starts_with("HTTP/1.1 404"), "{head}");

            // a player that hangs up mid-answer doesn't take the server down
            let addr = lb.base.trim_start_matches("http://").split('/').next().unwrap().to_string();
            let mut c = tokio::net::TcpStream::connect(&addr).await.unwrap();
            c.write_all(format!("GET {p} HTTP/1.1\r\nHost: {addr}\r\nRange: bytes=0-\r\n\r\n").as_bytes()).await.unwrap();
            let mut first = [0u8; 64];
            let _ = c.read(&mut first).await.unwrap();
            drop(c);
            let (head, body) = raw_http(&lb.base, &p, None, "Range: bytes=-10\r\n").await;
            assert!(head.starts_with("HTTP/1.1 206"));
            assert_eq!(body, &big[BIG - 10..]);
        });
    }
}
