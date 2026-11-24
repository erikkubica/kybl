//! The HTTP side the cloud drives share: one reqwest client (rustls on ring), requests signed
//! with the connection's access token, one retry after a refresh when the server says 401, waits
//! on rate limits (`429` / `503` with `Retry-After`, Google's 403 `rateLimitExceeded`), and
//! errors in plain language.

use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};

use bytes::Bytes;
use reqwest::{Client, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::token::TokenSource;
use crate::storage::{extras, ConnKind, ErrKind, SResult, StorageError};

// ---------------------------------------------------------------- the client

/// rustls on ring, trusting the system's roots on a computer and Mozilla's on a phone (which keep
/// theirs where rustls can't read them; see `state::mobile_tls`).
fn tls_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        #[cfg(desktop)]
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        #[cfg(mobile)]
        for cert in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
            let _ = roots.add(cert.clone());
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(cfg)
    })
    .clone()
}

/// One client for every sign-in and cloud drive request: one connection pool, one TLS setup.
pub fn client() -> Client {
    static HTTP: OnceLock<Client> = OnceLock::new();
    HTTP.get_or_init(|| builder().build().expect("HTTP client")).clone()
}

/// The same, for the few requests whose redirect is the answer (OneDrive's copy monitor sends
/// "303: here's the new item" when done; following it unsigned would fail).
pub fn client_no_redirect() -> Client {
    static HTTP: OnceLock<Client> = OnceLock::new();
    HTTP.get_or_init(|| builder().redirect(reqwest::redirect::Policy::none()).build().expect("HTTP client")).clone()
}

/// How long a request may go without a byte moving before it counts as a dropped connection.
const STALL: Duration = Duration::from_secs(120);

fn builder() -> reqwest::ClientBuilder {
    // no whole-request timeout: big uploads and downloads take as long as they take
    bare_builder().read_timeout(STALL)
}

fn bare_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .tls_backend_preconfigured((*tls_config()).clone())
        .user_agent(concat!("Kybl/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(60))
        .tcp_keepalive(Duration::from_secs(30))
}

/// The client for upload pieces ([`Api::send_piece`]). reqwest's read timeout runs from the
/// moment a request goes out and is not reset while its body is still being sent, so on a slow
/// uplink (under about 70 KB/s for an 8 MiB piece) every piece would be cut off at 120 s and the
/// upload could never move on. Pieces watch for a stall instead: no byte of the body taken for
/// that long, or no answer that long after the last one.
fn piece_client() -> Client {
    static HTTP: OnceLock<Client> = OnceLock::new();
    HTTP.get_or_init(|| bare_builder().build().expect("HTTP client")).clone()
}

/// `piece` as a request body handed out in small slices, each one moving `mark` (the time the
/// last byte was taken) on.
fn marked_body(piece: Bytes, mark: Arc<AtomicI64>) -> reqwest::Body {
    const SLICE: usize = 64 * 1024;
    let n = piece.len();
    let slices = (0..n).step_by(SLICE).map(move |at| {
        mark.store(extras::now_ms(), Ordering::Relaxed);
        Ok::<Bytes, std::io::Error>(piece.slice(at..(at + SLICE).min(n)))
    });
    reqwest::Body::wrap_stream(futures_util::stream::iter(slices))
}

/// `fut`, unless `mark` stays put for `stall`: then a network error, which the upload loops
/// treat like a dropped connection (ask the server how far it got, carry on from there). The
/// cancel flag is looked at a few times a second, so Pause and Cancel don't wait for a piece
/// that is still on its way (a cancelled error).
async fn unless_stalled<T>(fut: impl Future<Output = SResult<T>>, mark: &AtomicI64, stall: Duration, cancel: &AtomicBool, kind: ConnKind) -> SResult<T> {
    let mut fut = std::pin::pin!(fut);
    let every = (stall / 4).min(Duration::from_millis(250)).max(Duration::from_millis(10));
    loop {
        tokio::select! {
            r = &mut fut => return r,
            _ = tokio::time::sleep(every) => {
                if cancel.load(Ordering::Relaxed) {
                    return Err(StorageError::cancelled());
                }
                if extras::now_ms() - mark.load(Ordering::Relaxed) > stall.as_millis() as i64 {
                    let say = format!("{} didn't answer in time. Check your internet connection.", kind.label());
                    return Err(StorageError::new(ErrKind::Network, say).with_detail("the upload stopped moving"));
                }
            }
        }
    }
}

/// The whole answer to a piece, read while the stall watch still runs (each chunk of the answer
/// moves `mark`), handed back as a response whose body is already here. A server that sends the
/// headers and then goes quiet would otherwise hold the caller's body read forever: the piece
/// client has no read timeout.
async fn buffered(mut res: Response, mark: &AtomicI64, kind: ConnKind) -> SResult<Response> {
    mark.store(extras::now_ms(), Ordering::Relaxed);
    let mut body = Vec::new();
    while let Some(c) = res.chunk().await.map_err(|e| net_error(kind, &e))? {
        mark.store(extras::now_ms(), Ordering::Relaxed);
        body.extend_from_slice(&c);
    }
    let (parts, _) = tauri::http::Response::<reqwest::Body>::from(res).into_parts();
    Ok(Response::from(tauri::http::Response::from_parts(parts, Bytes::from(body))))
}

// ---------------------------------------------------------------- signed requests

/// How often a request is tried when the service asks to slow down or is briefly unavailable.
const TRIES: u32 = 6;

/// Requests to one connection's API, signed with its access token.
#[derive(Clone)]
pub struct Api {
    pub http: Client,
    pub tokens: Arc<TokenSource>,
    pub kind: ConnKind,
    /// the longest single wait for a rate limit (shorter in tests)
    pub max_wait: Duration,
}

impl Api {
    pub fn new(kind: ConnKind, tokens: Arc<TokenSource>) -> Self {
        Self { http: client(), tokens, kind, max_wait: Duration::from_secs(60) }
    }

    /// Sends a request signed with the access token. `build` makes the request afresh for each
    /// try. A 401 refreshes the token and tries once more; rate limits and brief outages wait
    /// and try again. Any other answer comes back as it is (check the status).
    pub async fn send(&self, build: impl Fn(&Client) -> RequestBuilder + Sync) -> SResult<Response> {
        self.send_inner(&build, true, true).await
    }

    /// [`send`](Api::send) for a request that makes something new and is not safe to repeat
    /// (Drive's `files.create` and `files.copy`): a 502 or 504 can come back after the service
    /// did the work, so it is returned rather than sent again; the caller looks for what the
    /// request made before trying once more (see `gdrive::api::Drive::create_once`). A 503 and a
    /// 429 still wait and repeat: they mean the request was not taken.
    pub async fn send_create(&self, build: impl Fn(&Client) -> RequestBuilder + Sync) -> SResult<Response> {
        self.send_inner(&build, true, false).await
    }

    /// The same for addresses that carry their own authorization (OneDrive upload sessions,
    /// temporary download links), which must not get the token.
    pub async fn send_unsigned(&self, build: impl Fn(&Client) -> RequestBuilder + Sync) -> SResult<Response> {
        self.send_inner(&build, false, true).await
    }

    /// Sends one upload piece: `build` makes the request around the body it is given. Unlike
    /// [`send`](Api::send), a slow piece is never cut off while its bytes keep moving; only a
    /// stall ends it (see [`piece_client`]), while sending or while reading the answer, whose
    /// body is already read when this returns. `cancel` ends it at once with a cancelled error.
    /// `sign` is false for addresses that carry their own authorization.
    pub async fn send_piece(&self, sign: bool, piece: &Bytes, cancel: &AtomicBool, build: impl Fn(&Client, reqwest::Body) -> RequestBuilder + Sync) -> SResult<Response> {
        self.piece_inner(sign, true, piece, cancel, &build).await
    }

    /// [`send_piece`](Api::send_piece) for a request that makes something new (Drive's one-request
    /// upload): a 502 or 504 is returned, as with [`send_create`](Api::send_create).
    pub async fn send_piece_create(&self, piece: &Bytes, cancel: &AtomicBool, build: impl Fn(&Client, reqwest::Body) -> RequestBuilder + Sync) -> SResult<Response> {
        self.piece_inner(true, false, piece, cancel, &build).await
    }

    async fn piece_inner(&self, sign: bool, repeat_gateway: bool, piece: &Bytes, cancel: &AtomicBool, build: &(dyn Fn(&Client, reqwest::Body) -> RequestBuilder + Sync)) -> SResult<Response> {
        let mark = Arc::new(AtomicI64::new(extras::now_ms()));
        let api = Api { http: piece_client(), ..self.clone() };
        let make = |c: &Client| {
            mark.store(extras::now_ms(), Ordering::Relaxed);
            build(c, marked_body(piece.clone(), mark.clone()))
        };
        let whole = async {
            let res = api.send_inner(&make, sign, repeat_gateway).await?;
            buffered(res, &mark, self.kind).await
        };
        unless_stalled(whole, &mark, STALL, cancel, self.kind).await
    }

    async fn send_inner(&self, build: &(dyn Fn(&Client) -> RequestBuilder + Sync), sign: bool, repeat_gateway: bool) -> SResult<Response> {
        let mut refreshed = false;
        // sent again after a 502/503/504: the first try may have been carried out
        let mut repeated = false;
        let mut tries = 0u32;
        loop {
            tries += 1;
            let token = if sign { Some(self.tokens.access_token().await?) } else { None };
            let mut req = build(&self.http);
            if let Some(t) = &token {
                req = req.bearer_auth(t);
            }
            let res = match req.send().await {
                Ok(r) => r,
                Err(e) if tries < 3 && e.is_connect() => {
                    tokio::time::sleep(backoff(tries)).await;
                    continue;
                }
                Err(e) => return Err(net_error(self.kind, &e)),
            };
            let status = res.status().as_u16();
            if status == 401 && sign {
                if !refreshed {
                    refreshed = true;
                    self.tokens.force_refresh(token.as_deref().unwrap_or_default()).await?;
                    continue;
                }
                // a token fresh from the server and still refused: access was taken away
                let body = res.bytes().await.unwrap_or_default();
                return Err(self.tokens.lost(Some(error_detail(401, &body))).await);
            }
            let wait = match status {
                429 | 503 => Some(retry_after(&res).unwrap_or_else(|| backoff(tries))),
                502 | 504 if repeat_gateway => Some(retry_after(&res).unwrap_or_else(|| backoff(tries))),
                // Drive says "slow down" with a 403 and a reason in the body
                403 if self.kind == ConnKind::Gdrive => {
                    let body = res.bytes().await.unwrap_or_default();
                    if !is_google_rate_limit(&body) {
                        return Err(error_of(self.kind, 403, &body));
                    }
                    if tries >= TRIES {
                        return Err(rate_limited(self.kind));
                    }
                    tokio::time::sleep(backoff(tries).min(self.max_wait)).await;
                    continue;
                }
                _ => None,
            };
            match wait {
                Some(w) if tries < TRIES => {
                    // a 503 says the request was not taken, so its retry can't be the second
                    // copy of one that went through; a lost gateway answer (502, 504) can
                    repeated |= matches!(status, 502 | 504);
                    tokio::time::sleep(w.min(self.max_wait)).await
                }
                Some(_) if status == 429 => return Err(rate_limited(self.kind)),
                _ => {
                    let mut res = res;
                    if repeated {
                        res.extensions_mut().insert(Repeated);
                    }
                    return Ok(res);
                }
            }
        }
    }

    /// [`send`](Api::send), and an error unless the answer is a success.
    pub async fn ok(&self, build: impl Fn(&Client) -> RequestBuilder + Sync) -> SResult<Response> {
        check(self.kind, self.send(build).await?).await
    }

    /// [`send`](Api::send), reading a JSON answer.
    pub async fn json<T: DeserializeOwned>(&self, build: impl Fn(&Client) -> RequestBuilder + Sync) -> SResult<T> {
        let res = self.ok(build).await?;
        read_json(self.kind, res).await
    }
}

/// Marks an answer to a request that was sent again after a 502 or 504 (see
/// [`was_repeated`]).
#[derive(Clone, Copy)]
struct Repeated;

/// True when this answer is to a request sent again after a 502 or 504. The first try may
/// have been carried out with only its answer lost, so a "conflict" or "not found" here can mean
/// "already done": the upload paths look at the item before reporting it (B3-3, round 5).
pub fn was_repeated(res: &Response) -> bool {
    res.extensions().get::<Repeated>().is_some()
}

/// The response, or the error it reports.
pub async fn check(kind: ConnKind, res: Response) -> SResult<Response> {
    let status = res.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(res);
    }
    let body = res.bytes().await.unwrap_or_default();
    Err(error_of(kind, status, &body))
}

pub async fn read_json<T: DeserializeOwned>(kind: ConnKind, res: Response) -> SResult<T> {
    let body = res.bytes().await.map_err(|e| net_error(kind, &e))?;
    serde_json::from_slice(&body).map_err(|e| unexpected(kind, e))
}

pub fn unexpected(kind: ConnKind, e: impl std::fmt::Display) -> StorageError {
    StorageError::other(format!("{} sent an answer Kybl didn't expect.", kind.label())).with_detail(e.to_string())
}

/// 1, 2, 4, 8, 16 seconds (plus up to a quarter more, so clients don't retry in step).
pub fn backoff(try_no: u32) -> Duration {
    let base = 1000u64 << try_no.saturating_sub(1).min(5);
    let jitter = (extras::now_ms() as u64 % 250) * base / 1000;
    Duration::from_millis(base + jitter)
}

/// `Retry-After` in seconds or as a date.
pub fn retry_after(res: &Response) -> Option<Duration> {
    let v = res.headers().get("retry-after")?.to_str().ok()?;
    parse_retry_after(v, extras::now_ms())
}

pub fn parse_retry_after(v: &str, now_ms: i64) -> Option<Duration> {
    let v = v.trim();
    if let Ok(secs) = v.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = extras::parse_http_date(v)?;
    Some(Duration::from_millis((at - now_ms).max(0) as u64))
}

fn is_google_rate_limit(body: &[u8]) -> bool {
    let v: Value = serde_json::from_slice(body).unwrap_or_default();
    let reasons = v["error"]["errors"].as_array().cloned().unwrap_or_default();
    reasons.iter().any(|e| matches!(e["reason"].as_str(), Some("rateLimitExceeded" | "userRateLimitExceeded")))
}

// ---------------------------------------------------------------- errors

pub fn rate_limited(kind: ConnKind) -> StorageError {
    StorageError::new(ErrKind::RateLimited, format!("{} asked Kybl to slow down. Wait a minute and try again.", kind.label()))
}

pub fn net_error(kind: ConnKind, e: &reqwest::Error) -> StorageError {
    let say = if e.is_timeout() {
        format!("{} didn't answer in time. Check your internet connection.", kind.label())
    } else if e.is_connect() {
        format!("Can't reach {}. Check your internet connection.", kind.label())
    } else {
        format!("The connection to {} dropped. Try again.", kind.label())
    };
    StorageError::new(ErrKind::Network, say).with_detail(e.to_string())
}

/// "HTTP 403: storageQuotaExceeded: The user's Drive storage quota has been exceeded."
fn error_detail(status: u16, body: &[u8]) -> String {
    let (code, msg) = provider_error(body);
    match (code.is_empty(), msg.is_empty()) {
        (true, true) => format!("HTTP {status}: {}", String::from_utf8_lossy(&body[..body.len().min(300)])),
        (false, true) => format!("HTTP {status}: {code}"),
        (true, false) => format!("HTTP {status}: {msg}"),
        (false, false) => format!("HTTP {status}: {code}: {msg}"),
    }
}

/// The machine code and message out of the error bodies the three services send:
/// Google `{error: {message, errors: [{reason}]}}`, Graph `{error: {code, message}}`,
/// Dropbox `{error_summary}`, token endpoints `{error, error_description}`.
pub fn provider_error(body: &[u8]) -> (String, String) {
    let v: Value = serde_json::from_slice(body).unwrap_or_default();
    let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
    if let Some(summary) = v["error_summary"].as_str() {
        return (summary.to_string(), String::new());
    }
    match &v["error"] {
        Value::String(code) => (code.clone(), s(&v["error_description"])),
        e @ Value::Object(_) => {
            let code = e["errors"][0]["reason"].as_str().map(str::to_string).unwrap_or_else(|| s(&e["code"]));
            let code = if code.is_empty() { s(&e["status"]) } else { code };
            (code, s(&e["message"]))
        }
        _ => (String::new(), s(&v["message"])),
    }
}

/// An error answer as people read it, with the technical text kept as the detail.
pub fn error_of(kind: ConnKind, status: u16, body: &[u8]) -> StorageError {
    let label = kind.label();
    let (code, _) = provider_error(body);
    let has = |s: &str| code.contains(s);
    let (k, say): (ErrKind, String) = match status {
        _ if has("storageQuotaExceeded") || has("insufficient_space") || has("quotaLimitReached") || status == 507 => {
            (ErrKind::Other, format!("Your {label} is full. Free up space and try again."))
        }
        _ if has("too_many_write_operations") || has("too_many_requests") => (ErrKind::RateLimited, rate_limited(kind).message),
        _ if has("exportSizeLimitExceeded") => {
            (ErrKind::TooLarge, "This Google Docs file is too large to export. Open it in Google Drive and download it from there.".into())
        }
        _ if has("cannotDownloadAbusiveFile") => {
            (ErrKind::PermissionDenied, "Google Drive flagged this file as possibly harmful and won't hand it to apps.".into())
        }
        _ if has("disallowed_name") || has("malformed_path") || has("invalidName") => {
            (ErrKind::Other, format!("{label} doesn't allow this name. Try another one."))
        }
        401 => (ErrKind::NeedsAuth, format!("Kybl is no longer signed in to your {label}. Reconnect to keep using it.")),
        403 => (ErrKind::PermissionDenied, format!("Your {label} account isn't allowed to do that here.")),
        404 => (ErrKind::NotFound, StorageError::not_found().message),
        409 if kind == ConnKind::Dropbox && has("not_found") => (ErrKind::NotFound, StorageError::not_found().message),
        409 if has("conflict") || has("nameAlreadyExists") || has("already_exists") || kind != ConnKind::Dropbox => {
            (ErrKind::Exists, StorageError::exists().message)
        }
        412 => (ErrKind::Conflict, StorageError::conflict().message),
        413 => (ErrKind::TooLarge, format!("This file is too large for {label}.")),
        416 => (ErrKind::Other, "The file is shorter than expected. It may have changed. Try again.".into()),
        423 => (ErrKind::Conflict, "The file is locked. It may be open somewhere else. Try again later.".into()),
        429 => (ErrKind::RateLimited, rate_limited(kind).message),
        500..=599 => (ErrKind::Other, format!("{label} ran into a problem. Try again in a moment.")),
        _ => (ErrKind::Other, format!("{label} didn't accept the request.")),
    };
    StorageError::new(k, say).with_detail(error_detail(status, body))
}

/// A body for `application/x-www-form-urlencoded` requests.
pub fn form(pairs: &[(&str, &str)]) -> Bytes {
    Bytes::from(pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&"))
}

/// A query string value or path segment, percent-encoded.
pub fn enc(s: &str) -> String {
    const SET: &percent_encoding::AsciiSet =
        &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
    percent_encoding::utf8_percent_encode(s, SET).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B3-6 (round 4): a piece is ended by a stall, not by how long it takes. Bytes that keep
    /// moving keep it alive past the stall time; a piece that stops moving is a network error.
    #[tokio::test]
    async fn pieces_end_on_a_stall_not_on_a_clock() {
        let stall = Duration::from_millis(150);
        let mark = Arc::new(AtomicI64::new(extras::now_ms()));
        let m2 = mark.clone();
        let slow = async move {
            for _ in 0..12 {
                tokio::time::sleep(Duration::from_millis(40)).await;
                m2.store(extras::now_ms(), Ordering::Relaxed);
            }
            Ok::<_, StorageError>(7)
        };
        let no = AtomicBool::new(false);
        assert_eq!(unless_stalled(slow, &mark, stall, &no, ConnKind::Gdrive).await.unwrap(), 7, "480 ms, still moving");

        mark.store(extras::now_ms(), Ordering::Relaxed);
        let stuck = std::future::pending::<SResult<u32>>();
        let e = unless_stalled(stuck, &mark, stall, &no, ConnKind::Gdrive).await.unwrap_err();
        assert_eq!(e.kind, ErrKind::Network);

        // B3-2 (round 5): Cancel ends a piece that is still moving, without waiting for it
        let mark = Arc::new(AtomicI64::new(extras::now_ms()));
        let m2 = mark.clone();
        let busy = async move {
            for _ in 0..10_000 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                m2.store(extras::now_ms(), Ordering::Relaxed);
            }
            Ok(0)
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            c2.store(true, Ordering::Relaxed);
        });
        let started = std::time::Instant::now();
        let e = unless_stalled::<u32>(busy, &mark, Duration::from_secs(120), &cancel, ConnKind::Gdrive).await.unwrap_err();
        assert!(e.is_cancelled());
        assert!(started.elapsed() < Duration::from_secs(2));

        // the body moves the mark as it is taken, slice by slice
        let mark = Arc::new(AtomicI64::new(0));
        let body = marked_body(Bytes::from(vec![1u8; 200 * 1024]), mark.clone());
        let bytes = http_body_util::BodyExt::collect(body).await.unwrap().to_bytes();
        assert_eq!(bytes.len(), 200 * 1024);
        assert!(mark.load(Ordering::Relaxed) > 0);
    }

    /// B3-1 (round 5): an answer whose headers arrive and whose body then never comes ends as a
    /// stall, and a whole answer comes back readable after the guard.
    #[tokio::test]
    async fn a_silent_answer_body_is_a_stall() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for answer in ["HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok", "HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nok"] {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf).await;
                s.write_all(answer.as_bytes()).await.unwrap();
                // keep the connection open and quiet
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    drop(s);
                });
            }
        });
        let url = format!("http://{addr}/");
        let no = AtomicBool::new(false);
        let stall = Duration::from_millis(300);
        let get = |mark: Arc<AtomicI64>| {
            let url = url.clone();
            async move {
                let c = bare_builder().pool_max_idle_per_host(0).build().unwrap();
                let res = c.get(&url).send().await.map_err(|e| net_error(ConnKind::Gdrive, &e))?;
                buffered(res, &mark, ConnKind::Gdrive).await
            }
        };
        let mark = Arc::new(AtomicI64::new(extras::now_ms()));
        let res = unless_stalled(get(mark.clone()), &mark, stall, &no, ConnKind::Gdrive).await.unwrap();
        assert_eq!(res.status().as_u16(), 200);
        assert_eq!(&res.bytes().await.unwrap()[..], b"ok");

        let mark = Arc::new(AtomicI64::new(extras::now_ms()));
        let e = unless_stalled(get(mark.clone()), &mark, stall, &no, ConnKind::Gdrive).await.unwrap_err();
        assert_eq!(e.kind, ErrKind::Network);
    }

    #[test]
    fn retry_after_in_seconds_or_as_a_date() {
        assert_eq!(parse_retry_after("7", 0), Some(Duration::from_secs(7)));
        let at = extras::parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", at - 3000), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", at + 3000), Some(Duration::ZERO));
        assert_eq!(parse_retry_after("soon", 0), None);
    }

    #[test]
    fn provider_errors_read_plainly() {
        let g = br#"{"error":{"code":403,"message":"The user's Drive storage quota has been exceeded.","errors":[{"reason":"storageQuotaExceeded"}]}}"#;
        let e = error_of(ConnKind::Gdrive, 403, g);
        assert_eq!(e.message, "Your Google Drive is full. Free up space and try again.");
        assert!(e.detail.unwrap().contains("storageQuotaExceeded"));

        let m = br#"{"error":{"code":"nameAlreadyExists","message":"Name already exists"}}"#;
        assert_eq!(error_of(ConnKind::Onedrive, 409, m).kind, ErrKind::Exists);

        let d = br#"{"error_summary":"path/not_found/..","error":{".tag":"path"}}"#;
        assert_eq!(error_of(ConnKind::Dropbox, 409, d).kind, ErrKind::NotFound);
        let d = br#"{"error_summary":"path/conflict/file/.."}"#;
        assert_eq!(error_of(ConnKind::Dropbox, 409, d).kind, ErrKind::Exists);
        let d = br#"{"error_summary":"too_many_write_operations/.."}"#;
        assert_eq!(error_of(ConnKind::Dropbox, 409, d).kind, ErrKind::RateLimited);

        assert_eq!(error_of(ConnKind::Onedrive, 503, b"").message, "OneDrive ran into a problem. Try again in a moment.");
        assert_eq!(provider_error(br#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#).0, "invalid_grant");
        assert!(is_google_rate_limit(br#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#));
    }

    #[test]
    fn forms_and_segments_are_encoded() {
        assert_eq!(&form(&[("a b", "c&d"), ("x", "é")])[..], b"a%20b=c%26d&x=%C3%A9");
        assert_eq!(enc("My file #1.txt"), "My%20file%20%231.txt");
    }
}
