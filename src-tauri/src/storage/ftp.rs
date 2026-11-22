//! FTP and FTPS as a [`Storage`], with suppaftp (rustls on ring).
//!
//! Encryption follows `NetConfig::tls`: `none` (plain FTP: the password and files cross the
//! network readable by anyone on the way; the UI warns), `explicit` (AUTH TLS on port 21) or
//! `implicit` (TLS from the first byte, port 990). Passive mode, with the usual fix for servers
//! behind NAT that announce a private address. Names are UTF-8. Listings use MLSD where the server
//! has it, else LIST.
//!
//! An FTP connection does one thing at a time, so a few are kept open and lent out: a read holds
//! its connection until the body is finished. Uploads go to a temporary name next to the target
//! and are renamed over it once whole; a server that won't rename over a file gets the old one
//! moved aside first (see [`super::sftp::replace`]), so it is never deleted before the new one is
//! in place.

use std::{
    collections::HashSet,
    ops::Range,
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

use async_trait::async_trait;
use bytes::BytesMut;
use futures_util::StreamExt;
use suppaftp::{
    list::{File as FtpFile, ListParser},
    tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream as Ftp, TransferStream},
    types::FileType,
    FtpError, Mode,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{OnceCell, OwnedSemaphorePermit, Semaphore},
};

use super::{
    net::*,
    sftp::replace::{put_in_place, Renames},
    *,
};
use crate::state::{NetConfig, TlsMode};

type Xfer = TransferStream<suppaftp::tokio::AsyncRustlsStream>;

/// Connections open at once; servers often allow only a few per address.
const MAX_CONNS: usize = 4;
/// An idle connection older than this is checked with NOOP before it is lent again.
const IDLE_CHECK: Duration = Duration::from_secs(30);
const CMD_TIMEOUT: Duration = Duration::from_secs(60);

pub fn ftp_caps() -> Capabilities {
    Capabilities {
        roots: RootsMode::Single,
        folders: FolderMode::Real,
        rename: RenameMode::Native,
        server_copy: ServerCopy::None,
        streaming: StreamingMode::Proxy,
        // REST before RETR
        range_read: true,
        conditional_write: CondWrite::Compare,
        thumbnails: ThumbMode::Local,
        ..Capabilities::default()
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Feats {
    mlsd: bool,
}

struct Pool {
    idle: Mutex<Vec<(Ftp, Instant)>>,
    slots: Arc<Semaphore>,
}

/// A lent connection; it goes back to the pool when dropped, unless something went wrong on it.
struct Lease {
    conn: Option<Ftp>,
    pool: Arc<Pool>,
    healthy: bool,
    _permit: OwnedSemaphorePermit,
}

impl Lease {
    fn ftp(&mut self) -> &mut Ftp {
        self.conn.as_mut().expect("connection until dropped")
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take()
            && self.healthy
        {
            self.pool.idle.lock().unwrap().push((c, Instant::now()));
        }
    }
}

pub struct FtpBackend {
    host: String,
    port: u16,
    tls: TlsMode,
    user: String,
    password: String,
    base_cfg: String,
    /// the absolute folder keys are under, found at the first sign-in
    base: OnceCell<String>,
    feats: OnceCell<Feats>,
    name: String,
    caps: Capabilities,
    pool: Arc<Pool>,
    pages: PageCache,
    known_dirs: Mutex<HashSet<String>>,
}

impl FtpBackend {
    pub fn new(cfg: &NetConfig, password: Option<String>) -> SResult<Self> {
        let default_port = if cfg.tls == TlsMode::Implicit { 990 } else { 21 };
        let (host, port) = socket_addr(cfg, default_port);
        if host.is_empty() {
            return Err(StorageError::other("Enter the server's address."));
        }
        Ok(Self {
            name: root_name(&cfg.host, &cfg.base_path),
            host,
            port,
            tls: cfg.tls,
            user: cfg.user.trim().to_string(),
            password: password.unwrap_or_default(),
            base_cfg: cfg.base_path.trim().to_string(),
            base: OnceCell::new(),
            feats: OnceCell::new(),
            caps: ftp_caps(),
            pool: Arc::new(Pool { idle: Mutex::default(), slots: Arc::new(Semaphore::new(MAX_CONNS)) }),
            pages: PageCache::default(),
            known_dirs: Mutex::default(),
        })
    }

    async fn connect(&self) -> SResult<Ftp> {
        with_timeout(&self.host, CONNECT_TIMEOUT, async {
            let addr = addr_string(&self.host, self.port);
            let tls = || AsyncRustlsConnector::from(suppaftp::tokio_rustls::TlsConnector::from(tls_config()));
            let err = |e: FtpError| ftp_error(e, &self.host);
            let mut ftp = match self.tls {
                TlsMode::None => Ftp::connect(&addr).await.map_err(err)?,
                TlsMode::Explicit => Ftp::connect(&addr).await.map_err(err)?.into_secure(tls(), &self.host).await.map_err(|e| match e {
                    FtpError::UnexpectedResponse(_) => StorageError::new(ErrKind::Network, "This server doesn't offer encryption on this port. Try implicit encryption (port 990), or turn encryption off if the server only speaks plain FTP.")
                        .with_detail(e.to_string()),
                    e => err(e),
                })?,
                #[allow(deprecated)]
                TlsMode::Implicit => Ftp::connect_secure_implicit(&addr, tls(), &self.host).await.map_err(err)?,
            };
            // servers behind NAT often announce a private address for passive mode
            ftp.set_passive_nat_workaround(true);
            if self.host.contains(':') {
                ftp.set_mode(Mode::ExtendedPassive);
            }
            let user = if self.user.is_empty() { "anonymous" } else { self.user.as_str() };
            ftp.login(user, self.password.as_str()).await.map_err(|e| match e {
                FtpError::UnexpectedResponse(r) if matches!(r.status.code(), 530 | 430 | 331 | 332) => wrong_login().with_detail(r.to_string()),
                FtpError::UnexpectedResponse(r) if matches!(r.status.code(), 534 | 550) && self.tls == TlsMode::None => {
                    StorageError::new(ErrKind::PermissionDenied, "The server requires encryption. Turn on encryption in this connection's settings.").with_detail(r.to_string())
                }
                e => err(e),
            })?;
            // names in UTF-8 (most servers do that anyway; some need asking)
            let _ = ftp.opts("UTF8", Some("ON")).await;
            ftp.transfer_type(FileType::Binary).await.map_err(err)?;
            if !self.feats.initialized() {
                let f = ftp.feat().await.unwrap_or_default();
                let has = |k: &str| f.keys().any(|x| x.eq_ignore_ascii_case(k));
                let _ = self.feats.set(Feats { mlsd: has("MLST") || has("MLSD") });
            }
            if !self.base.initialized() {
                let base = if self.base_cfg.starts_with('/') {
                    clean_base(&self.base_cfg)
                } else {
                    let home = ftp.pwd().await.map_err(err)?;
                    clean_base(&format!("{home}/{}", self.base_cfg))
                };
                // the starting folder must be there: a typo shouldn't look like an empty server
                ftp.cwd(&base).await.map_err(|e| match e {
                    FtpError::UnexpectedResponse(r) => StorageError::new(ErrKind::NotFound, format!("The folder {base} isn't on the server.")).with_detail(r.to_string()),
                    e => err(e),
                })?;
                let _ = self.base.set(base);
            }
            Ok(ftp)
        })
        .await
    }

    /// A connection: an idle one if it still answers, else a new one.
    async fn lease(&self) -> SResult<Lease> {
        let permit = self.pool.slots.clone().acquire_owned().await.map_err(|_| dropped())?;
        loop {
            let idle = self.pool.idle.lock().unwrap().pop();
            let Some((mut c, at)) = idle else { break };
            if at.elapsed() < IDLE_CHECK || tokio::time::timeout(Duration::from_secs(10), c.noop()).await.is_ok_and(|r| r.is_ok()) {
                return Ok(Lease { conn: Some(c), pool: self.pool.clone(), healthy: true, _permit: permit });
            }
        }
        let c = self.connect().await?;
        Ok(Lease { conn: Some(c), pool: self.pool.clone(), healthy: true, _permit: permit })
    }

    /// Runs `f` on a connection, with a time limit; a connection that failed isn't reused, and an
    /// operation that failed because an idle connection had dropped is tried once more.
    async fn run<T, F>(&self, f: F) -> SResult<T>
    where
        F: for<'c> Fn(&'c mut Ftp, &'c str) -> BoxFuture<'c, Result<T, FtpError>>,
    {
        for attempt in 0..2 {
            let mut lease = self.lease().await?;
            let base = self.base.get().cloned().unwrap_or_else(|| "/".into());
            match tokio::time::timeout(CMD_TIMEOUT, f(lease.ftp(), &base)).await {
                Ok(Ok(v)) => return Ok(v),
                Ok(Err(FtpError::ConnectionError(_))) if attempt == 0 => lease.healthy = false,
                Ok(Err(e)) => {
                    lease.healthy = !matches!(e, FtpError::ConnectionError(_) | FtpError::SecureError(_) | FtpError::BadResponse | FtpError::DataConnectionAlreadyOpen);
                    return Err(ftp_error(e, &self.host));
                }
                Err(_) => {
                    lease.healthy = false;
                    return Err(timed_out(&self.host));
                }
            }
        }
        Err(dropped())
    }

    async fn base(&self) -> SResult<String> {
        if let Some(b) = self.base.get() {
            return Ok(b.clone());
        }
        drop(self.lease().await?);
        Ok(self.base.get().cloned().unwrap_or_else(|| "/".into()))
    }

    async fn path(&self, key: &str) -> SResult<String> {
        join(&self.base().await?, key)
    }

    /// The folder `dir` (a server path), straight from the server: (name, entry fields).
    async fn list_raw(&self, path: &str) -> SResult<Vec<FtpFile>> {
        let mlsd = self.feats.get().is_some_and(|f| f.mlsd);
        let path = path.to_string();
        let lines = self
            .run(move |ftp, _| {
                let path = path.clone();
                Box::pin(async move {
                    if mlsd {
                        match ftp.mlsd(Some(&path)).await {
                            Ok(l) => return Ok((true, l)),
                            Err(FtpError::UnexpectedResponse(r)) if r.status.code() >= 500 && r.status.code() != 550 => {}
                            Err(e) => return Err(e),
                        }
                    }
                    // LIST takes its argument as `ls` options on some servers: list from inside
                    ftp.cwd(&path).await?;
                    ftp.list(None).await.map(|l| (false, l))
                })
            })
            .await?;
        let (mlsd, lines) = lines;
        Ok(lines
            .iter()
            .filter_map(|l| if mlsd { ListParser::parse_mlsd(l).ok() } else { FtpFile::try_from(l.as_str()).ok() })
            .filter(|f| !matches!(f.name(), "." | "..") && !f.name().contains('/'))
            .collect())
    }

    fn entry(key: String, f: &FtpFile) -> Entry {
        let modified = f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64).filter(|m| *m > 0);
        let size = f.size() as u64;
        Entry { etag: Some(weak_etag(size, modified)), size: size as i64, modified, key, ..Default::default() }
    }

    async fn ensure_dir(&self, dir: &str) -> SResult<()> {
        let dir = dir_prefix(dir);
        if dir.is_empty() || self.known_dirs.lock().unwrap().contains(&dir) {
            return Ok(());
        }
        let base = self.base().await?;
        let parts: Vec<String> = key_parts(&dir)?.into_iter().map(str::to_string).collect();
        self.run(move |ftp, _| {
            let (base, parts) = (base.clone(), parts.clone());
            Box::pin(async move {
                let mut p = base.trim_end_matches('/').to_string();
                for part in &parts {
                    p = format!("{p}/{part}");
                    if let Err(e) = ftp.mkdir(&p).await {
                        // already there (servers say so in different ways): fine if we can go in
                        if ftp.cwd(&p).await.is_err() {
                            return Err(e);
                        }
                    }
                }
                Ok(())
            })
        })
        .await?;
        let mut known = self.known_dirs.lock().unwrap();
        let mut k = String::new();
        for part in key_parts(&dir)? {
            k.push_str(part);
            k.push('/');
            known.insert(k.clone());
        }
        Ok(())
    }

    /// Deletes a folder and everything in it, depth first.
    fn remove_tree<'a>(&'a self, path: String, cancel: &'a AtomicBool) -> BoxFuture<'a, SResult<()>> {
        Box::pin(async move {
            for f in self.list_raw(&path).await? {
                check_cancel(cancel)?;
                let child = format!("{}/{}", path.trim_end_matches('/'), f.name());
                if f.is_directory() {
                    self.remove_tree(child, cancel).await?;
                } else {
                    self.run(move |ftp, _| {
                        let child = child.clone();
                        Box::pin(async move { ftp.rm(&child).await })
                    })
                    .await?;
                }
            }
            self.run(move |ftp, _| {
                let path = path.clone();
                Box::pin(async move { ftp.rmdir(&path).await })
            })
            .await
        })
    }

    /// Sends the bytes to `path` with STOR.
    async fn store(&self, path: &str, body: &mut ByteStream, len: Option<u64>, progress: Progress<'_>, cancel: &AtomicBool) -> SResult<Stored> {
        let mut lease = self.lease().await?;
        let mut up: Xfer = match lease.ftp().put_with_stream(path).await {
            Ok(x) => x,
            // refused before any byte went: the caller may try another name
            Err(FtpError::UnexpectedResponse(r)) => return Ok(Stored::Refused(ftp_error(FtpError::UnexpectedResponse(r), &self.host))),
            Err(e) => {
                lease.healthy = false;
                return Err(ftp_error(e, &self.host));
            }
        };
        // nothing else may run on this connection until the transfer is finished
        lease.healthy = false;
        let mut meter = Meter::new(len, progress, cancel);
        while let Some(chunk) = body.next().await {
            if meter.cancelled() {
                return Ok(Stored::Cancelled);
            }
            let chunk = chunk?;
            match tokio::time::timeout(CMD_TIMEOUT, up.write_all(&chunk)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => return Err(or_cancelled(StorageError::from(e), cancel)),
                Err(_) => return Err(timed_out(&self.host)),
            }
            meter.sent(chunk.len()).await;
        }
        match tokio::time::timeout(CMD_TIMEOUT, up.finish()).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(ftp_error(e, &self.host)),
            Err(_) => return Err(timed_out(&self.host)),
        }
        lease.healthy = true;
        meter.finish();
        Ok(Stored::Done)
    }

    /// Removes what an interrupted STOR left. The server may still be closing that upload (the
    /// data connection was just dropped) and create the file after a first delete, so delete,
    /// wait a moment and delete again.
    async fn remove_partial(&self, path: String) {
        self.remove_quietly(path.clone()).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        self.remove_quietly(path).await;
    }

    async fn remove_quietly(&self, path: String) {
        let _ = self
            .run(move |ftp, _| {
                let p = path.clone();
                Box::pin(async move { ftp.rm(&p).await })
            })
            .await;
    }
}

#[async_trait]
impl Storage for FtpBackend {
    fn kind(&self) -> ConnKind {
        ConnKind::Ftp
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    /// Signs in (and so checks the address, the password and the starting folder).
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        drop(self.lease().await?);
        Ok(vec![root_info(self.name.clone())])
    }

    async fn list(&self, _root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let prefix = dir_prefix(dir);
        let path = self.path(&prefix).await?;
        self.pages
            .page(&prefix, token, || async {
                let (mut folders, mut files) = (Vec::new(), Vec::new());
                for f in self.list_raw(&path).await? {
                    let key = format!("{prefix}{}", f.name());
                    if f.is_directory() {
                        folders.push(format!("{key}/"));
                    } else {
                        files.push(Self::entry(key, &f));
                    }
                }
                self.known_dirs.lock().unwrap().insert(prefix.clone());
                Ok((folders, files))
            })
            .await
    }

    async fn stat(&self, _root: &str, path: &str) -> SResult<Option<Entry>> {
        let parts = key_parts(path)?;
        let want_dir = path.ends_with('/') || parts.is_empty();
        let Some(name) = parts.last() else {
            return Ok(Some(Entry { key: String::new(), ..Default::default() }));
        };
        let parent = parent_key(path);
        let listing = match self.list_raw(&self.path(&parent).await?).await {
            Ok(l) => l,
            Err(e) if e.kind == ErrKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let found = listing.iter().find(|f| f.name() == *name);
        Ok(match found {
            Some(f) if f.is_directory() && want_dir => Some(Entry { key: format!("{parent}{name}/"), ..Default::default() }),
            Some(f) if !f.is_directory() && !want_dir => Some(Self::entry(format!("{parent}{name}"), f)),
            _ => None,
        })
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        if key_parts(path)?.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("This is a folder, not a file."));
        }
        let mut etag = None;
        if let Some(t) = if_match {
            let now = self.stat(root, path).await?.ok_or_else(StorageError::not_found)?;
            if now.etag.as_deref() != Some(t) {
                return Err(StorageError::conflict());
            }
            etag = now.etag;
        }
        let full = self.path(path).await?;
        let mut lease = self.lease().await?;
        let total = match tokio::time::timeout(CMD_TIMEOUT, lease.ftp().size(&full)).await {
            Ok(Ok(n)) => Some(n as u64),
            Ok(Err(FtpError::UnexpectedResponse(r))) if matches!(r.status.code(), 550 | 551) => {
                return Err(StorageError::not_found().with_detail(r.to_string()));
            }
            _ => None,
        };
        let (start, end) = match &range {
            Some(r) => {
                let end = total.map_or(r.end, |t| r.end.min(t));
                (r.start.min(end), Some(end))
            }
            None => (0, total),
        };
        if end.is_some_and(|e| e <= start) && range.is_some() {
            return Ok(ReadStream { body: Box::pin(futures_util::stream::empty()), len: Some(0), total, range: Some(start..start), etag, content_type: Some(mime_of(path)) });
        }
        if start > 0 {
            lease.ftp().resume_transfer(start as usize).await.map_err(|e| ftp_error(e, &self.host))?;
        }
        let down: Xfer = match lease.ftp().retr_as_stream(&full).await {
            Ok(x) => x,
            Err(e) => {
                lease.healthy = matches!(e, FtpError::UnexpectedResponse(_));
                return Err(ftp_error(e, &self.host));
            }
        };
        // reused only once the transfer finished cleanly
        lease.healthy = false;
        let left = end.map(|e| e - start);
        let host = self.host.clone();
        let body = futures_util::stream::unfold(Some((lease, down, left)), move |st| {
            let host = host.clone();
            async move {
                let (mut lease, mut down, left) = st?;
                if left == Some(0) {
                    // stopped short of the end: this connection is dropped, not reused
                    return None;
                }
                let want = left.map_or(CHUNK, |l| CHUNK.min(l as usize));
                let mut buf = BytesMut::zeroed(want);
                match tokio::time::timeout(CMD_TIMEOUT, down.read(&mut buf)).await {
                    Ok(Ok(0)) => {
                        if tokio::time::timeout(CMD_TIMEOUT, down.finish()).await.is_ok_and(|r| r.is_ok()) {
                            lease.healthy = true;
                        }
                        None
                    }
                    Ok(Ok(n)) => {
                        buf.truncate(n);
                        Some((Ok(buf.freeze()), Some((lease, down, left.map(|l| l - n as u64)))))
                    }
                    Ok(Err(e)) => Some((Err(e), None)),
                    Err(_) => Some((Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("{host} stopped sending"))), None)),
                }
            }
        });
        Ok(ReadStream {
            body: Box::pin(body),
            len: end.map(|e| e - start),
            total,
            range: range.map(|_| start..end.unwrap_or(start)),
            etag,
            content_type: Some(mime_of(path)),
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
        self.ensure_dir(&parent_key(path)).await?;
        let target = self.path(path).await?;
        let (mut body, len) = source_stream(src).await?;
        let mut tmp_key = temp_key(path);
        let mut stored = self.store(&self.path(&tmp_key).await?, &mut body, len, progress, cancel).await;
        let mut plain = false;
        // some servers refuse names starting with a dot: a temporary name like the file's own
        if temp_refused(&stored) {
            plain = true;
            tmp_key = plain_temp_key(path);
            stored = self.store(&self.path(&tmp_key).await?, &mut body, len, progress, cancel).await;
        }
        // and some only take certain names (extensions): write in place as a last resort
        let mut direct = None;
        if temp_refused(&stored) {
            let existed = self.stat(root, path).await?.is_some();
            direct = Some(existed);
            stored = self.store(&target, &mut body, len, progress, cancel).await;
        }
        let written = if direct.is_some() { target.clone() } else { self.path(&tmp_key).await? };
        let failed = match stored {
            Ok(Stored::Done) => None,
            Ok(Stored::Refused(e)) => return Err(e),
            Ok(Stored::Cancelled) => Some(None),
            Err(e) => Some(Some(e)),
        };
        if let Some(err) = failed {
            if remove_after_failed_store(direct) {
                self.remove_partial(written).await;
            }
            return match err {
                None => Ok(WriteOutcome::Cancelled),
                Some(mut e) => {
                    if direct == Some(true) {
                        e.message = format!("{} This server doesn't allow temporary names, so the file was being replaced in place and may be incomplete now.", e.message);
                    }
                    Err(e)
                }
            };
        }
        if direct.is_none() {
            let backup = if plain { plain_temp_key(path) } else { temp_key(path) };
            // the temporary file is kept when it can't go in place: the old file is never
            // deleted before the new one is there
            put_in_place(self, &tmp_key, path, &backup).await.map_err(|e| e.explain(Some(file_name(&tmp_key))))?;
        }
        self.pages.forget(path);
        let entry = self.stat(root, path).await?.unwrap_or_else(|| Entry { key: path.to_string(), size: len.unwrap_or(0) as i64, ..Default::default() });
        Ok(WriteOutcome::Done(entry))
    }

    async fn mkdir(&self, _root: &str, dir: &str) -> SResult<()> {
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
            let p = self.path(key).await?;
            let r = if is_dir {
                self.remove_tree(p, cancel).await
            } else {
                self.run(move |ftp, _| {
                    let p = p.clone();
                    Box::pin(async move { ftp.rm(&p).await })
                })
                .await
            };
            match r {
                Err(e) if e.kind != ErrKind::NotFound => return Err(e),
                _ => {}
            }
            let k = if is_dir { dir_prefix(key) } else { key.clone() };
            self.pages.forget(&k);
            self.known_dirs.lock().unwrap().retain(|d| !d.starts_with(&k));
            done += 1;
            on_progress(done, total);
        }
        Ok((done, total))
    }

    async fn rename(&self, from: &Loc, to: &Loc, is_dir: bool) -> SResult<()> {
        if key_parts(&from.path)?.is_empty() {
            return Err(top_refused());
        }
        let (src, dst) = (self.path(&from.path).await?, self.path(&to.path).await?);
        if src == dst {
            return Err(StorageError::other("Source and destination are the same"));
        }
        if is_dir && dst.starts_with(&format!("{src}/")) {
            return Err(StorageError::other("Cannot move a folder into itself"));
        }
        self.ensure_dir(&parent_key(&to.path)).await?;
        if is_dir {
            // a folder never replaces another
            self.run(move |ftp, _| {
                let (s, d) = (src.clone(), dst.clone());
                Box::pin(async move { ftp.rename(&s, &d).await })
            })
            .await?;
        } else {
            // a file replaces what is there (like S3), which is only deleted once this one is in its place
            put_in_place(self, &from.path, &to.path, &temp_key(&to.path)).await.map_err(|e| e.explain(None))?;
        }
        let k = if is_dir { dir_prefix(&from.path) } else { from.path.clone() };
        self.pages.forget(&k);
        self.pages.forget(&to.path);
        self.known_dirs.lock().unwrap().retain(|d| !d.starts_with(&k));
        Ok(())
    }
}

/// Each step asked of the server on its own (never repeated as a whole), on keys.
#[async_trait]
impl Renames for FtpBackend {
    async fn rename_file(&self, from: &str, to: &str) -> SResult<()> {
        let (f, t) = (self.path(from).await?, self.path(to).await?);
        self.run(move |ftp, _| {
            let (f, t) = (f.clone(), t.clone());
            Box::pin(async move { ftp.rename(&f, &t).await })
        })
        .await
    }

    async fn file_exists(&self, key: &str) -> SResult<bool> {
        Ok(self.stat("", key).await?.is_some())
    }

    async fn remove_file(&self, key: &str) -> SResult<()> {
        let p = self.path(key).await?;
        self.run(move |ftp, _| {
            let p = p.clone();
            Box::pin(async move { ftp.rm(&p).await })
        })
        .await
    }
}

enum Stored {
    Done,
    Cancelled,
    Refused(StorageError),
}

/// The server refused the name before any byte went (553 "name not allowed", 550 "denied" or
/// "no such file" for a hidden name): another name may work, and the body is still unread.
fn temp_refused(stored: &SResult<Stored>) -> bool {
    matches!(stored, Ok(Stored::Refused(e)) if matches!(e.kind, ErrKind::PermissionDenied | ErrKind::NotFound))
}

/// Whether what a STOR that didn't finish left is removed (`direct`: written in place, and
/// whether a file was there before). A file that was there before an in-place write is never
/// deleted: what is left of it is all there is.
fn remove_after_failed_store(direct: Option<bool>) -> bool {
    direct != Some(true)
}

/// A temporary name for servers that refuse names starting with a dot: "dir/name.kybl-…ext",
/// keeping the extension for servers that only take certain kinds of files.
fn plain_temp_key(key: &str) -> String {
    let (dir, name) = (parent_key(key), file_name(key));
    let id = &uuid::Uuid::new_v4().simple().to_string()[..12];
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{dir}{}.kybl-{id}{}", &name[..i], &name[i..]),
        _ if name.starts_with('.') => format!("{dir}kybl-{id}{name}"),
        _ => format!("{dir}{name}.kybl-{id}"),
    }
}

/// FTP errors, said plainly.
fn ftp_error(e: FtpError, host: &str) -> StorageError {
    match e {
        FtpError::ConnectionError(io) => connect_error(&io, host),
        FtpError::SecureError(s) => tls_error(s),
        FtpError::UnexpectedResponse(r) => {
            let code = r.status.code();
            let text = r.to_string();
            let low = text.to_lowercase();
            let (kind, say) = match code {
                530 | 430 => (ErrKind::NeedsAuth, "Wrong user name or password."),
                421 => (ErrKind::RateLimited, "The server closed the connection. It may allow only a few connections at a time; try again in a moment."),
                425 | 426 => (ErrKind::Network, "Couldn't open a data connection to the server. A firewall may be blocking passive mode."),
                450 | 550 | 551 if low.contains("permission") || low.contains("denied") || low.contains("not allowed") => {
                    (ErrKind::PermissionDenied, "The server didn't allow that. Check the account's permissions.")
                }
                450 | 550 | 551 if low.contains("exist") && !low.contains("not exist") && !low.contains("no such") => (ErrKind::Exists, "Something with this name is already there."),
                450 | 550 | 551 => (ErrKind::NotFound, "This file or folder isn't there any more. It may have been moved or deleted."),
                452 | 552 => (ErrKind::Other, "The server is out of space, or the account is over its quota."),
                553 => (ErrKind::PermissionDenied, "The server doesn't allow this file name."),
                522 | 534 => (ErrKind::PermissionDenied, "The server requires encryption. Turn on encryption in this connection's settings."),
                _ => (ErrKind::Other, "The FTP server refused that."),
            };
            StorageError::new(kind, say).with_detail(text)
        }
        FtpError::BadResponse => StorageError::other("The FTP server sent an answer Kybl couldn't read.").with_detail(e.to_string()),
        FtpError::InvalidAddress(_) => StorageError::other("That server address isn't valid.").with_detail(e.to_string()),
        FtpError::DataConnectionAlreadyOpen => dropped().with_detail(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use suppaftp::Status;

    #[test]
    fn temporary_names_without_a_leading_dot() {
        let k = plain_temp_key("d/photo.jpg");
        assert!(k.starts_with("d/photo.kybl-") && k.ends_with(".jpg"), "{k}");
        let k = plain_temp_key(".env");
        assert!(k.starts_with("kybl-") && k.ends_with(".env"), "{k}");
        let k = plain_temp_key("d/README");
        assert!(k.starts_with("d/README.kybl-"), "{k}");
        assert_ne!(plain_temp_key("a.txt"), plain_temp_key("a.txt"));
    }

    #[test]
    fn only_a_refused_name_tries_another() {
        let refused = |kind| Ok(Stored::Refused(StorageError::new(kind, "x")));
        assert!(temp_refused(&refused(ErrKind::PermissionDenied)));
        assert!(temp_refused(&refused(ErrKind::NotFound)));
        assert!(!temp_refused(&refused(ErrKind::Other)), "out of space isn't about the name");
        assert!(!temp_refused(&Err(StorageError::new(ErrKind::PermissionDenied, "x"))), "refused mid-way: the body is spent");
        assert!(!temp_refused(&Ok(Stored::Done)));
    }

    #[test]
    fn an_unfinished_in_place_write_never_deletes_the_file_that_was_there() {
        assert!(remove_after_failed_store(None), "a temporary file goes");
        assert!(remove_after_failed_store(Some(false)), "a new file nobody had goes");
        assert!(!remove_after_failed_store(Some(true)), "what is left of the old file stays");
    }

    #[test]
    fn defaults_and_names() {
        let cfg = NetConfig { host: "ftp.example.com".into(), tls: TlsMode::Implicit, base_path: "/pub".into(), ..Default::default() };
        let b = FtpBackend::new(&cfg, None).unwrap();
        assert_eq!(b.port, 990);
        assert_eq!(b.name, "ftp.example.com/pub");
        let cfg = NetConfig { host: "ftp.example.com:2121".into(), ..Default::default() };
        assert_eq!(FtpBackend::new(&cfg, None).unwrap().port, 2121);
        assert!(FtpBackend::new(&NetConfig::default(), None).is_err());
    }

    #[test]
    fn listings_parse_both_ways() {
        let f = ListParser::parse_mlsd("type=file;size=12;modify=20261122100000; a b.txt").unwrap();
        assert_eq!(f.name(), "a b.txt");
        let e = FtpBackend::entry("x/a b.txt".into(), &f);
        assert_eq!(e.size, 12);
        assert_eq!(e.modified, Some(1_795_341_600_000));
        let d = FtpFile::try_from("drwxr-xr-x    2 ftp      ftp          4096 Nov 22  2025 photos").unwrap();
        assert!(d.is_directory());
        assert_eq!(d.name(), "photos");
    }

    #[test]
    fn refusals_read_plainly() {
        let r = suppaftp::types::Response::new(Status::NotLoggedIn, b"530 Login incorrect.".to_vec());
        assert_eq!(ftp_error(FtpError::UnexpectedResponse(r), "h").kind, ErrKind::NeedsAuth);
        let r = suppaftp::types::Response::new(Status::FileUnavailable, b"550 No such file or directory".to_vec());
        assert_eq!(ftp_error(FtpError::UnexpectedResponse(r), "h").kind, ErrKind::NotFound);
        let r = suppaftp::types::Response::new(Status::FileUnavailable, b"550 Permission denied".to_vec());
        assert_eq!(ftp_error(FtpError::UnexpectedResponse(r), "h").kind, ErrKind::PermissionDenied);
    }
}
