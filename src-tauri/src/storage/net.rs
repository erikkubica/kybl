//! What the server backends (WebDAV, FTP, SFTP, and the OpenDAL ones) share: the TLS setup and
//! HTTP client, paths under a base folder, listings served a page at a time, writes that report
//! progress and keep to the bandwidth cap, and errors in plain language.

use std::{
    collections::HashMap,
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use tokio::io::AsyncReadExt;

use super::*;
use crate::{state::NetConfig, tuning::LIMITER};

/// Files listed per page.
pub const PAGE: usize = 1000;
/// Read and write chunk size.
pub const CHUNK: usize = 256 * 1024;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------- TLS and HTTP

/// rustls on ring, trusting the system's roots on a computer and Mozilla's on a phone (which keep
/// theirs where rustls can't read them; see `state::mobile_tls`).
pub fn tls_config() -> Arc<rustls::ClientConfig> {
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

/// One HTTP client for WebDAV and the OpenDAL backends: one connection pool, one TLS setup.
pub fn http() -> reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .tls_backend_preconfigured((*tls_config()).clone())
            .user_agent(concat!("Kybl/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            // no whole-request timeout: uploads of big files take as long as they take
            .read_timeout(Duration::from_secs(120))
            // some servers drop idle connections without a word; don't reuse stale ones
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .expect("HTTP client")
    })
    .clone()
}

// ---------------------------------------------------------------- settings and secrets

/// The network settings of a connection, with a message when they're missing.
pub fn net_config(cfg: Option<&NetConfig>) -> SResult<NetConfig> {
    let c = cfg.cloned().unwrap_or_default();
    if c.host.trim().is_empty() && c.url.as_deref().is_none_or(|u| u.trim().is_empty()) {
        return Err(StorageError::other("Enter the server's address."));
    }
    Ok(c)
}

/// "files.example.com" from what people type: "ftp://files.example.com:2121/x" included.
pub fn bare_host(host: &str) -> String {
    let h = host.trim();
    let h = h.split_once("://").map_or(h, |(_, rest)| rest);
    let h = h.split('/').next().unwrap_or(h);
    // user@host
    let h = h.rsplit_once('@').map_or(h, |(_, rest)| rest);
    // host:port, but not a bare IPv6 address
    let h = if h.starts_with('[') {
        h.split_once(']').map_or(h, |(a, _)| a.trim_start_matches('['))
    } else if h.matches(':').count() == 1 {
        h.split(':').next().unwrap_or(h)
    } else {
        h
    };
    h.to_string()
}

/// A port typed into the host field ("example.com:2222"), if any.
pub fn port_in_host(host: &str) -> Option<u16> {
    let h = host.trim();
    let h = h.split_once("://").map_or(h, |(_, rest)| rest);
    let h = h.split('/').next().unwrap_or(h);
    let tail = if h.starts_with('[') { h.split_once("]:")?.1 } else if h.matches(':').count() == 1 { h.split(':').nth(1)? } else { return None };
    tail.parse().ok()
}

/// "host:port" to connect to, with brackets around IPv6 addresses.
pub fn socket_addr(cfg: &NetConfig, default_port: u16) -> (String, u16) {
    let host = bare_host(&cfg.host);
    let port = if cfg.port != 0 { cfg.port } else { port_in_host(&cfg.host).unwrap_or(default_port) };
    (host, port)
}

pub fn addr_string(host: &str, port: u16) -> String {
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// An SSH private key as kept in the vault (`{id}#ssh`): JSON `{"privateKey", "passphrase"}`, or
/// just the key text.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SshKey {
    pub private_key: String,
    pub passphrase: Option<String>,
}

impl SshKey {
    pub fn parse(s: &str) -> Option<Self> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        if t.starts_with('{') {
            let v: serde_json::Value = serde_json::from_str(t).ok()?;
            let key = v.get("privateKey").or_else(|| v.get("key")).and_then(|k| k.as_str())?.to_string();
            let pass = v.get("passphrase").and_then(|p| p.as_str()).filter(|p| !p.is_empty()).map(str::to_string);
            return Some(Self { private_key: key, passphrase: pass });
        }
        Some(Self { private_key: t.to_string(), passphrase: None })
    }
}

impl std::fmt::Debug for SshKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SshKey(..)")
    }
}

/// What a server connection signs in with.
#[derive(Clone, Default)]
pub struct Secrets {
    pub password: Option<String>,
    pub ssh: Option<SshKey>,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secrets(..)")
    }
}

// ---------------------------------------------------------------- paths

/// The folder a connection starts in, as an absolute server path: "/" or "/a/b" (no trailing
/// slash).
pub fn clean_base(base: &str) -> String {
    let parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.is_empty() { "/".to_string() } else { format!("/{}", parts.join("/")) }
}

/// The parts of a key, refusing anything that would climb out of the base folder.
pub fn key_parts(key: &str) -> SResult<Vec<&str>> {
    let mut out = Vec::new();
    for p in key.split('/') {
        match p {
            "" | "." => {}
            ".." => return Err(StorageError::new(ErrKind::PermissionDenied, "That place is outside this connection's folder.")),
            p => out.push(p),
        }
    }
    Ok(out)
}

/// The server path of a key under `base` (no trailing slash, "/" for the top).
pub fn join(base: &str, key: &str) -> SResult<String> {
    let parts = key_parts(key)?;
    let base = base.trim_end_matches('/');
    Ok(match (base.is_empty(), parts.is_empty()) {
        (true, true) => "/".to_string(),
        (_, true) => base.to_string(),
        _ => format!("{base}/{}", parts.join("/")),
    })
}

/// "a/b/" for "a/b/c.txt" and "a/b/c/"; "" at the top.
pub fn parent_key(key: &str) -> String {
    let k = key.trim_end_matches('/');
    match k.rfind('/') {
        Some(i) => k[..=i].to_string(),
        None => String::new(),
    }
}

/// The last part of a key.
pub fn file_name(key: &str) -> &str {
    let k = key.trim_end_matches('/');
    k.rsplit('/').next().unwrap_or(k)
}

/// The folder key of a listing ("" or ending with `/`).
pub fn dir_prefix(dir: &str) -> String {
    match dir.trim_matches('/') {
        "" => String::new(),
        d => format!("{d}/"),
    }
}

/// A sibling name to write to before renaming over the target, so a half-written file never
/// takes the real name.
pub fn temp_key(key: &str) -> String {
    format!("{}.{}.kybl-{}", parent_key(key), file_name(key), &uuid::Uuid::new_v4().simple().to_string()[..12])
}

pub fn root_info(name: String) -> RootInfo {
    RootInfo { id: String::new(), name, kind: RootKind::Folder, created: None, read_only: false }
}

/// What a single-root server connection is called: the host, plus the base folder if any.
pub fn root_name(host: &str, base: &str) -> String {
    let host = bare_host(host);
    match base.trim_matches('/') {
        "" => host,
        b => format!("{host}/{b}"),
    }
}

/// A stand-in ETag for stores without one: changes whenever size or modification time does.
pub fn weak_etag(size: u64, modified: Option<i64>) -> String {
    format!("{:x}-{:x}", modified.unwrap_or(0), size)
}

pub fn mime_of(key: &str) -> String {
    mime_guess::from_path(key).first_or_octet_stream().to_string()
}

// ---------------------------------------------------------------- listing pages

/// Servers list a whole folder in one go. The listing is kept for a minute so the next pages
/// come from it instead of listing again; a fresh first page always asks the server.
#[derive(Default)]
pub struct PageCache {
    inner: Mutex<HashMap<String, (Instant, Arc<Listing>)>>,
}

/// A whole folder: subfolder keys and files, sorted.
type Listing = (Vec<String>, Vec<Entry>);

impl PageCache {
    const KEEP: Duration = Duration::from_secs(60);

    /// One page of `dir`, listing it with `fetch` (folders and files, in any order) on the first
    /// page or when the kept listing is gone.
    pub async fn page<F, Fut>(&self, dir: &str, token: Option<String>, fetch: F) -> SResult<Page>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = SResult<(Vec<String>, Vec<Entry>)>>,
    {
        let start: usize = token.as_deref().and_then(|t| t.parse().ok()).unwrap_or(0);
        let kept = if start > 0 {
            let mut m = self.inner.lock().unwrap();
            m.retain(|_, (at, _)| at.elapsed() < Self::KEEP);
            m.get(dir).map(|(_, l)| l.clone())
        } else {
            None
        };
        let listing = match kept {
            Some(l) => l,
            None => {
                let (mut folders, mut files) = fetch().await?;
                folders.sort_by_key(|f| f.to_lowercase());
                files.sort_by_key(|f| f.key.to_lowercase());
                let l = Arc::new((folders, files));
                if folders_and_files(&l) > PAGE {
                    self.inner.lock().unwrap().insert(dir.to_string(), (Instant::now(), l.clone()));
                }
                l
            }
        };
        let (folders, files) = &*listing;
        let total = folders.len() + files.len();
        let start = start.min(total);
        let end = (start + PAGE).min(total);
        let nf = folders.len();
        let page_folders = if start < nf { folders[start..end.min(nf)].to_vec() } else { vec![] };
        let page_files = files[start.max(nf) - nf..end.max(nf) - nf].to_vec();
        Ok(Page { folders: page_folders, objects: page_files, next_token: (end < total).then(|| end.to_string()) })
    }

    /// Something changed below `dir` (or anywhere, for ""): forget kept listings there.
    pub fn forget(&self, key: &str) {
        let parent = parent_key(key);
        self.inner.lock().unwrap().retain(|d, _| *d != parent && !d.starts_with(key));
    }
}

fn folders_and_files(l: &Listing) -> usize {
    l.0.len() + l.1.len()
}

// ---------------------------------------------------------------- writes

/// The bytes of a write and how many there are, when known.
pub async fn source_stream(src: WriteSource) -> SResult<(ByteStream, Option<u64>)> {
    Ok(match src {
        WriteSource::Path(p) => {
            let f = tokio::fs::File::open(&p).await?;
            let len = f.metadata().await?.len();
            let s = futures_util::stream::unfold(f, |mut f| async move {
                let mut buf = BytesMut::zeroed(CHUNK);
                match f.read(&mut buf).await {
                    Ok(0) => None,
                    Ok(n) => {
                        buf.truncate(n);
                        Some((Ok(buf.freeze()), f))
                    }
                    Err(e) => Some((Err(e), f)),
                }
            });
            (Box::pin(s), Some(len))
        }
        WriteSource::Bytes(b) => {
            let n = b.len() as u64;
            (Box::pin(futures_util::stream::iter([Ok::<Bytes, io::Error>(b)])), Some(n))
        }
        WriteSource::Stream { len, body, .. } => (body, len),
    })
}

/// Counts what goes out: reports progress every 150 ms, keeps to the shared bandwidth cap and
/// notices a cancel. Each backend's write loop calls [`Meter::sent`] per chunk.
pub struct Meter<'a> {
    pub done: u64,
    total: Option<u64>,
    last: Instant,
    progress: Progress<'a>,
    cancel: &'a AtomicBool,
}

impl<'a> Meter<'a> {
    pub fn new(total: Option<u64>, progress: Progress<'a>, cancel: &'a AtomicBool) -> Self {
        progress(0, total.unwrap_or(0));
        Self { done: 0, total, last: Instant::now(), progress, cancel }
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// After `n` more bytes went out: progress, then wait as long as the cap asks.
    pub async fn sent(&mut self, n: usize) {
        self.done += n as u64;
        if self.last.elapsed() > Duration::from_millis(150) {
            (self.progress)(self.done, self.total.unwrap_or(self.done).max(self.done));
            self.last = Instant::now();
        }
        LIMITER.throttle(n).await;
    }

    pub fn finish(&self) {
        (self.progress)(self.done, self.total.unwrap_or(self.done).max(self.done));
    }
}

/// Whether a write may go ahead, for stores that check by reading first (`CondWrite::Compare`).
pub fn precondition_holds(pre: &Precondition, now: Option<&Entry>) -> bool {
    match (pre, now) {
        (Precondition::None, _) => true,
        (Precondition::IfNoneMatch, cur) => cur.is_none(),
        (Precondition::IfMatch(tag), Some(cur)) => cur.etag.as_deref() == Some(tag.as_str()),
        (Precondition::IfUnchanged { etag: Some(tag), .. }, Some(cur)) => cur.etag.as_deref() == Some(tag.as_str()),
        (Precondition::IfUnchanged { etag: None, size, modified }, Some(cur)) => cur.size == *size && cur.modified == *modified,
        _ => false,
    }
}

/// Reads a range of a stream that came whole (a server that ignored the range): skips to
/// `start`, stops at `end`.
pub fn slice_stream(body: ByteStream, start: u64, end: Option<u64>) -> ByteStream {
    Box::pin(
        futures_util::stream::unfold((body, 0u64), move |(mut body, mut pos)| async move {
            loop {
                if end.is_some_and(|e| pos >= e) {
                    return None;
                }
                let chunk = match body.next().await? {
                    Ok(c) => c,
                    Err(e) => return Some((Err(e), (body, u64::MAX))),
                };
                let (from, to) = (pos, pos + chunk.len() as u64);
                pos = to;
                if to <= start {
                    continue;
                }
                let lo = start.saturating_sub(from) as usize;
                let hi = end.map_or(chunk.len(), |e| (e.min(to) - from) as usize);
                return Some((Ok(chunk.slice(lo..hi)), (body, pos)));
            }
        })
        .fuse(),
    )
}

// ---------------------------------------------------------------- errors

/// Errors connecting to a server, said plainly.
pub fn connect_error(e: &io::Error, host: &str) -> StorageError {
    use io::ErrorKind as K;
    let say = match e.kind() {
        K::TimedOut => format!("{host} didn't answer in time. Check the address and your internet connection."),
        K::ConnectionRefused => format!("{host} refused the connection. Check the port, and that the server is running."),
        K::NotFound => format!("Couldn't find {host}. Check the address."),
        _ if is_dns_error(e) => format!("Couldn't find {host}. Check the address."),
        _ => format!("Couldn't reach {host}. Check the address and your internet connection."),
    };
    StorageError::new(ErrKind::Network, say).with_detail(e.to_string())
}

fn is_dns_error(e: &io::Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("failed to lookup") || s.contains("nodename nor servname") || s.contains("name or service not known") || s.contains("no such host")
}

pub fn wrong_login() -> StorageError {
    StorageError::new(ErrKind::NeedsAuth, "Wrong user name or password.")
}

pub fn timed_out(host: &str) -> StorageError {
    StorageError::new(ErrKind::Network, format!("{host} didn't answer in time. Check the address and your internet connection."))
}

pub fn dropped() -> StorageError {
    StorageError::new(ErrKind::Network, "The connection to the server dropped. Try again.")
}

/// An error out of a write loop: a cancel shows as Cancelled, not as the broken pipe it caused.
pub fn or_cancelled(e: StorageError, cancel: &AtomicBool) -> StorageError {
    if cancel.load(Ordering::Relaxed) { StorageError::cancelled() } else { e }
}

/// TLS failures, said plainly.
pub fn tls_error(detail: impl Into<String>) -> StorageError {
    let d = detail.into();
    let low = d.to_lowercase();
    let say = if low.contains("certificate") || low.contains("unknownissuer") || low.contains("unknown issuer") {
        "The server's security certificate isn't trusted. If the server uses its own certificate, Kybl can't connect to it securely."
    } else if low.contains("handshake") || low.contains("protocol") || low.contains("corrupt message") {
        "Couldn't start a secure connection. The server may not support encryption on this port: check the encryption setting."
    } else {
        "Couldn't start a secure connection with the server."
    };
    StorageError::new(ErrKind::Network, say).with_detail(d)
}

pub async fn with_timeout<T>(host: &str, d: Duration, f: impl Future<Output = SResult<T>>) -> SResult<T> {
    match tokio::time::timeout(d, f).await {
        Ok(r) => r,
        Err(_) => Err(timed_out(host)),
    }
}

/// Runs `cancel`-aware deletes of top-level items, reporting (done, total) as each finishes.
pub fn delete_items<'a>(files: &'a [String], dirs: &'a [String]) -> impl Iterator<Item = (&'a String, bool)> {
    files.iter().map(|f| (f, false)).chain(dirs.iter().map(|d| (d, true)))
}

pub fn check_cancel(cancel: &AtomicBool) -> SResult<()> {
    if cancel.load(Ordering::Relaxed) { Err(StorageError::cancelled()) } else { Ok(()) }
}

pub fn top_refused() -> StorageError {
    StorageError::other("The top of this connection can't be deleted or moved.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_ports_from_what_people_type() {
        assert_eq!(bare_host("ftp://files.example.com:2121/x"), "files.example.com");
        assert_eq!(bare_host(" example.com "), "example.com");
        assert_eq!(bare_host("me@example.com:22"), "example.com");
        assert_eq!(bare_host("[::1]:22"), "::1");
        assert_eq!(bare_host("::1"), "::1");
        assert_eq!(port_in_host("example.com:2222"), Some(2222));
        assert_eq!(port_in_host("[::1]:2222"), Some(2222));
        assert_eq!(port_in_host("::1"), None);
        assert_eq!(port_in_host("example.com"), None);
        let cfg = NetConfig { host: "example.com:2222".into(), ..Default::default() };
        assert_eq!(socket_addr(&cfg, 22), ("example.com".into(), 2222));
        let cfg = NetConfig { host: "example.com:2222".into(), port: 23, ..Default::default() };
        assert_eq!(socket_addr(&cfg, 22).1, 23);
        assert_eq!(addr_string("::1", 22), "[::1]:22");
    }

    #[test]
    fn paths_stay_under_the_base() {
        assert_eq!(clean_base(""), "/");
        assert_eq!(clean_base("srv//www/"), "/srv/www");
        assert_eq!(join("/srv", "a/b.txt").unwrap(), "/srv/a/b.txt");
        assert_eq!(join("/srv", "a/").unwrap(), "/srv/a");
        assert_eq!(join("/srv", "").unwrap(), "/srv");
        assert_eq!(join("/", "a").unwrap(), "/a");
        assert_eq!(join("/", "").unwrap(), "/");
        assert!(join("/srv", "a/../../etc").is_err());
        assert_eq!(parent_key("a/b/c.txt"), "a/b/");
        assert_eq!(parent_key("a/b/"), "a/");
        assert_eq!(parent_key("a"), "");
        assert_eq!(file_name("a/b/"), "b");
        assert_eq!(dir_prefix("/a/b"), "a/b/");
        assert_eq!(dir_prefix(""), "");
        assert!(temp_key("a/b.txt").starts_with("a/.b.txt.kybl-"));
        assert_eq!(root_name("sftp://example.com:22", "/home/me/"), "example.com/home/me");
    }

    #[test]
    fn ssh_keys_read_as_json_or_text() {
        let k = SshKey::parse(r#"{"privateKey":"-----BEGIN","passphrase":"pw"}"#).unwrap();
        assert_eq!(k.private_key, "-----BEGIN");
        assert_eq!(k.passphrase.as_deref(), Some("pw"));
        let k = SshKey::parse("-----BEGIN OPENSSH PRIVATE KEY-----\n...").unwrap();
        assert!(k.passphrase.is_none());
        assert!(SshKey::parse("  ").is_none());
        assert_eq!(format!("{k:?}"), "SshKey(..)");
    }

    #[test]
    fn whole_streams_slice_to_a_range() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let chunks: Vec<io::Result<Bytes>> = vec![Ok(Bytes::from_static(b"0123")), Ok(Bytes::from_static(b"4567")), Ok(Bytes::from_static(b"89"))];
        let s = slice_stream(Box::pin(futures_util::stream::iter(chunks)), 3, Some(9));
        let got: Vec<u8> = rt.block_on(s.map(|c| c.unwrap().to_vec()).concat());
        assert_eq!(got, b"345678");
    }

    #[test]
    fn pages_come_from_one_listing() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let cache = PageCache::default();
        let files: Vec<Entry> = (0..1500).map(|i| Entry { key: format!("f{i:04}"), ..Default::default() }).collect();
        let p1 = rt.block_on(cache.page("", None, || async { Ok((vec!["d/".to_string()], files.clone())) })).unwrap();
        assert_eq!(p1.folders, vec!["d/"]);
        assert_eq!(p1.objects.len(), PAGE - 1);
        let p2 = rt.block_on(cache.page("", p1.next_token.clone(), || async { panic!("listed again") })).unwrap();
        assert_eq!(p2.objects.len(), 501);
        assert!(p2.next_token.is_none());
    }

    #[test]
    fn preconditions_compare() {
        let e = Entry { key: "a".into(), size: 3, modified: Some(5), etag: Some("t".into()), ..Default::default() };
        assert!(precondition_holds(&Precondition::None, None));
        assert!(precondition_holds(&Precondition::IfNoneMatch, None));
        assert!(!precondition_holds(&Precondition::IfNoneMatch, Some(&e)));
        assert!(precondition_holds(&Precondition::IfMatch("t".into()), Some(&e)));
        assert!(!precondition_holds(&Precondition::IfMatch("t".into()), None));
        assert!(precondition_holds(&Precondition::IfUnchanged { etag: None, size: 3, modified: Some(5) }, Some(&e)));
        assert!(!precondition_holds(&Precondition::IfUnchanged { etag: None, size: 4, modified: Some(5) }, Some(&e)));
    }
}

#[cfg(test)]
#[path = "net_it.rs"]
mod it;
