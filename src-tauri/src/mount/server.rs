//! The loopback WebDAV server of one drive, the same shape as the media server
//! (`storage/media.rs`): `127.0.0.1` only, a random path token, and a Host check.
//!
//! - **Token**: every request must start with `/<token>/`; the drive is mounted at
//!   `http://127.0.0.1:<port>/<token>/`. macOS's `mount_webdav` can't take a user name and
//!   password without a dialog or a keychain item (a URL with `user:pass@` is refused), so the
//!   secret lives in the path instead. It is 128 random bits, new for every mount; note that the
//!   mount table (`mount`) shows the URL to other accounts on the same computer while the drive
//!   is mounted (see NATIVE.md).
//! - **Host**: only `127.0.0.1:<port>` / `localhost:<port>`, so a web page can't reach the
//!   server through a DNS name that points at this computer.
//! - **Port**: the drive's previous port is tried first. A mount left behind by a crash has the
//!   old token, so it is replaced by a fresh mount (`os::mount`).
//! - **Timing**: with `KYBL_DRIVE_TIMING=1` in the environment, every request (method, path,
//!   status, time to the answer's headers) and every folder listing fetched from the server is
//!   printed to stderr, to see where a slow Finder window waits.

use std::{
    convert::Infallible,
    net::Ipv4Addr,
    sync::{Arc, OnceLock},
    time::Instant,
};

use bytes::Bytes;
use dav_server::{memls::MemLs, DavHandler};
use http_body_util::{BodyExt, Full};
use hyper::{body::Incoming, server::conn::http1, service::service_fn, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

use super::webdav::KyblFs;

/// A running server; dropping it (or [`stop`](Server::stop)) stops accepting connections.
pub struct Server {
    pub port: u16,
    token: String,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    /// `http://127.0.0.1:<port>/<token>/`
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{}/", self.port, self.token)
    }

    pub fn stop(&self) {
        self.task.abort();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Prints `what()` to stderr when `KYBL_DRIVE_TIMING=1` (built only then).
pub fn timing(what: impl FnOnce() -> String) {
    static ON: OnceLock<bool> = OnceLock::new();
    if *ON.get_or_init(|| std::env::var("KYBL_DRIVE_TIMING").as_deref() == Ok("1")) {
        eprintln!("[drive] {}", what());
    }
}

pub fn random_token() -> String {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut b).expect("system randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

type Body = http_body_util::combinators::UnsyncBoxBody<Bytes, std::io::Error>;

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from_static(text.as_bytes())).map_err(|e: Infallible| match e {}).boxed_unsync());
    *r.status_mut() = status;
    r
}

/// Starts serving `fs` on `127.0.0.1`, on `port` when it is free (0: any). `read_only` refuses
/// every method that changes something.
pub async fn start(fs: KyblFs, port: u16, token: String, read_only: bool) -> std::io::Result<Server> {
    let listener = match tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
        Ok(l) => l,
        Err(_) if port != 0 => tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?,
        Err(e) => return Err(e),
    };
    let port = listener.local_addr()?.port();
    let prefix = format!("/{token}");
    let mut cfg = DavHandler::builder()
        .filesystem(Box::new(fs))
        // real locks in memory: Finder only mounts writable when LOCK works
        .locksystem(MemLs::new())
        .strip_prefix(prefix.clone())
        .hide_symlinks(true)
        .autoindex(false);
    if read_only {
        cfg = cfg.methods(dav_server::DavMethodSet::WEBDAV_RO);
    }
    let dav = Arc::new(cfg.build_handler());
    let hosts: Arc<[String]> = vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")].into();
    let prefix: Arc<str> = prefix.into();
    let task = tokio::spawn(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((s, _)) => s,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    continue;
                }
            };
            let (dav, hosts, prefix) = (dav.clone(), hosts.clone(), prefix.clone());
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let (dav, hosts, prefix) = (dav.clone(), hosts.clone(), prefix.clone());
                    async move { Ok::<_, Infallible>(serve(&dav, &hosts, &prefix, req).await) }
                });
                let _ = http1::Builder::new().keep_alive(true).serve_connection(TokioIo::new(stream), svc).await;
            });
        }
    });
    Ok(Server { port, token, task })
}

async fn serve(dav: &DavHandler, hosts: &[String], prefix: &str, req: Request<Incoming>) -> Response<Body> {
    let host = req.headers().get(hyper::header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
        return plain(StatusCode::FORBIDDEN, "Not here.");
    }
    let path = req.uri().path();
    let under = path == prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'));
    if !under {
        return plain(StatusCode::NOT_FOUND, "Not here.");
    }
    let started = Instant::now();
    let (method, rel) = (req.method().clone(), path[prefix.len()..].to_string());
    let depth = req.headers().get("depth").and_then(|d| d.to_str().ok()).map(str::to_string);
    let res = dav.handle(req).await.map(|b| b.boxed_unsync());
    timing(|| format!("{method} {rel} depth={} -> {} in {} ms", depth.as_deref().unwrap_or("-"), res.status().as_u16(), started.elapsed().as_millis()));
    res
}
