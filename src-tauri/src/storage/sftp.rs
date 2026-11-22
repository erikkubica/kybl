//! SFTP as a [`Storage`], with russh (ring crypto) and russh-sftp: the same code on every OS,
//! phones included (OpenDAL's SFTP spawns the system `ssh`, which phones and Windows lack).
//!
//! Sign-in by password (also answered to keyboard-interactive prompts, which many servers use for
//! passwords), a private key (OpenSSH, PEM or PuTTY, with its passphrase) or, on a computer, the
//! SSH agent. The server's key is trusted on first use: see [`hostkey`].
//!
//! One SSH connection per backend carries every request (SFTP runs many at once over it). It
//! sends keepalives, and a dropped connection is opened again on the next request.

pub mod hostkey;
pub mod replace;

use std::{
    collections::HashSet,
    io::SeekFrom,
    ops::Range,
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use bytes::BytesMut;
use futures_util::StreamExt;
use russh::{
    client::{self, AuthResult, KeyboardInteractiveAuthResponse},
    keys::{decode_secret_key, PrivateKeyWithHashAlg},
    MethodKind,
};
use russh_sftp::{
    client::{error::Error as SftpError, SftpSession},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::OnceCell,
};

use self::{
    hostkey::HostCheck,
    replace::{put_in_place, Renames},
};
use super::{net::*, *};
use crate::state::{NetAuth, NetConfig};

const REQUEST_TIMEOUT_SECS: u64 = 30;
/// Opening the SFTP session on a signed-in connection (channel, subsystem, first requests). A
/// server that stops answering here would otherwise hold the connection lock for good.
const SESSION_TIMEOUT: Duration = Duration::from_secs(30);
/// Files deleted at once inside a folder.
const DELETE_PARALLEL: usize = 16;

pub fn sftp_caps() -> Capabilities {
    Capabilities {
        roots: RootsMode::Single,
        folders: FolderMode::Real,
        rename: RenameMode::Native,
        server_copy: ServerCopy::None,
        streaming: StreamingMode::Proxy,
        range_read: true,
        conditional_write: CondWrite::Compare,
        thumbnails: ThumbMode::Local,
        ..Capabilities::default()
    }
}

pub(super) struct Conn {
    pub(super) handle: client::Handle<HostCheck>,
    sftp: SftpSession,
}

impl Conn {
    fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
}

pub struct SftpBackend {
    host: String,
    port: u16,
    user: String,
    auth: NetAuth,
    password: Option<String>,
    key: Option<SshKey>,
    /// the trusted server key fingerprint ("SHA256:...")
    host_key: Option<String>,
    base_cfg: String,
    base: OnceCell<String>,
    name: String,
    caps: Capabilities,
    pub(super) conn: tokio::sync::Mutex<Option<Arc<Conn>>>,
    /// [`SESSION_TIMEOUT`], shorter in tests
    session_timeout: Duration,
    pages: PageCache,
    known_dirs: Mutex<HashSet<String>>,
}

impl SftpBackend {
    pub fn new(cfg: &NetConfig, secrets: Secrets) -> SResult<Self> {
        let (host, port) = socket_addr(cfg, 22);
        if host.is_empty() {
            return Err(StorageError::other("Enter the server's address."));
        }
        if cfg.user.trim().is_empty() {
            return Err(StorageError::other("Enter the user name to sign in with."));
        }
        Ok(Self {
            name: root_name(&cfg.host, &cfg.base_path),
            host,
            port,
            user: cfg.user.trim().to_string(),
            auth: cfg.auth,
            password: secrets.password.filter(|p| !p.is_empty()),
            key: secrets.ssh,
            host_key: cfg.host_key.clone().filter(|k| !k.trim().is_empty()),
            base_cfg: cfg.base_path.trim().to_string(),
            base: OnceCell::new(),
            caps: sftp_caps(),
            conn: tokio::sync::Mutex::new(None),
            session_timeout: SESSION_TIMEOUT,
            pages: PageCache::default(),
            known_dirs: Mutex::default(),
        })
    }

    /// The TCP connection, the server's key checked and signed in.
    async fn sign_in_connection(&self) -> SResult<client::Handle<HostCheck>> {
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        });
        let (check, seen) = HostCheck::new(self.host_key.clone());
        let connecting = client::connect(config, (self.host.as_str(), self.port), check);
        let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
            Err(_) => return Err(timed_out(&self.host)),
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return Err(hostkey::refusal(&e, seen.lock().unwrap().clone(), self.host_key.as_deref()).unwrap_or_else(|| ssh_error(e, &self.host))),
        };
        with_timeout(&self.host, CONNECT_TIMEOUT, self.sign_in(&mut handle)).await?;
        Ok(handle)
    }

    /// The SFTP session on a signed-in connection, within `session_timeout` as a whole.
    async fn open_sftp(&self, handle: client::Handle<HostCheck>) -> SResult<Conn> {
        let opening = async {
            let channel = handle.channel_open_session().await.map_err(|e| ssh_error(e, &self.host))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| StorageError::new(ErrKind::Unsupported, "This server doesn't offer SFTP.").with_detail(e.to_string()))?;
            let cfg = russh_sftp::client::Config { request_timeout_secs: REQUEST_TIMEOUT_SECS, ..Default::default() };
            let sftp = with_timeout(&self.host, CONNECT_TIMEOUT, async {
                SftpSession::new_with_config(channel.into_stream(), cfg)
                    .await
                    .map_err(|e| StorageError::new(ErrKind::Unsupported, "This server doesn't offer SFTP.").with_detail(e.to_string()))
            })
            .await?;
            if !self.base.initialized() {
                let base = if self.base_cfg.starts_with('/') {
                    clean_base(&self.base_cfg)
                } else {
                    // relative to the user's home folder
                    let start = if self.base_cfg.is_empty() { ".".to_string() } else { self.base_cfg.clone() };
                    let abs = sftp.canonicalize(start).await.map_err(|e| {
                        StorageError::new(ErrKind::NotFound, format!("The folder {} isn't on the server.", self.base_cfg)).with_detail(e.to_string())
                    })?;
                    clean_base(&abs)
                };
                match sftp.metadata(base.clone()).await {
                    Ok(m) if m.is_dir() => {}
                    Ok(_) => return Err(StorageError::new(ErrKind::NotFound, format!("{base} is a file, not a folder."))),
                    Err(e) => return Err(StorageError::new(ErrKind::NotFound, format!("The folder {base} isn't on the server.")).with_detail(e.to_string())),
                }
                let _ = self.base.set(base);
            }
            Ok(sftp)
        };
        match tokio::time::timeout(self.session_timeout, opening).await {
            Ok(Ok(sftp)) => Ok(Conn { handle, sftp }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                // a half-open connection: let it go rather than keep waiting on it
                let _ = tokio::time::timeout(Duration::from_secs(1), handle.disconnect(russh::Disconnect::ByApplication, "", "")).await;
                Err(timed_out(&self.host))
            }
        }
    }

    async fn sign_in(&self, handle: &mut client::Handle<HostCheck>) -> SResult<()> {
        let user = self.user.clone();
        let err = |e: russh::Error| ssh_error(e, &self.host);
        let ok = match self.auth {
            NetAuth::Password => {
                let pw = self.password.clone().ok_or_else(|| StorageError::new(ErrKind::NeedsAuth, "Enter the password."))?;
                match handle.authenticate_password(&user, &pw).await.map_err(err)? {
                    AuthResult::Success => true,
                    AuthResult::Failure { remaining_methods, .. } if remaining_methods.contains(&MethodKind::KeyboardInteractive) => {
                        self.keyboard_interactive(handle, &pw).await?
                    }
                    AuthResult::Failure { remaining_methods, .. } if !remaining_methods.contains(&MethodKind::Password) => {
                        return Err(StorageError::new(ErrKind::NeedsAuth, "This server doesn't accept passwords. Sign in with a private key instead."));
                    }
                    AuthResult::Failure { .. } => false,
                }
            }
            NetAuth::Key => {
                let k = self.key.clone().ok_or_else(|| StorageError::new(ErrKind::NeedsAuth, "Add the private key to sign in with."))?;
                let key = decode_secret_key(&k.private_key, k.passphrase.as_deref()).map_err(key_error)?;
                let hash = if key.algorithm().is_rsa() { handle.best_supported_rsa_hash().await.map_err(err)?.flatten() } else { None };
                let r = handle.authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(err)?;
                if !r.success() {
                    return Err(StorageError::new(ErrKind::NeedsAuth, "The server didn't accept this private key for this user."));
                }
                true
            }
            NetAuth::Agent => self.agent(handle).await?,
        };
        if ok { Ok(()) } else { Err(wrong_login()) }
    }

    /// Answers every prompt with the password (that's what PAM asks for).
    async fn keyboard_interactive(&self, handle: &mut client::Handle<HostCheck>, pw: &str) -> SResult<bool> {
        let err = |e: russh::Error| ssh_error(e, &self.host);
        let mut r = handle.authenticate_keyboard_interactive_start(&self.user, None::<String>).await.map_err(err)?;
        for _ in 0..4 {
            match r {
                KeyboardInteractiveAuthResponse::Success => return Ok(true),
                KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let answers = prompts.iter().map(|_| pw.to_string()).collect();
                    r = handle.authenticate_keyboard_interactive_respond(answers).await.map_err(err)?;
                }
            }
        }
        Ok(false)
    }

    #[cfg(all(desktop, unix))]
    async fn agent(&self, handle: &mut client::Handle<HostCheck>) -> SResult<bool> {
        let agent = russh::keys::agent::client::AgentClient::connect_env().await.map_err(|e| no_agent(e.to_string()))?;
        self.agent_with(handle, agent).await
    }

    #[cfg(windows)]
    async fn agent(&self, handle: &mut client::Handle<HostCheck>) -> SResult<bool> {
        use russh::keys::agent::client::AgentClient;
        // Windows' own OpenSSH agent, then PuTTY's Pageant
        match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(a) => self.agent_with(handle, a).await,
            Err(_) => {
                let a = AgentClient::connect_pageant().await.map_err(|e| no_agent(e.to_string()))?;
                self.agent_with(handle, a).await
            }
        }
    }

    #[cfg(mobile)]
    async fn agent(&self, _handle: &mut client::Handle<HostCheck>) -> SResult<bool> {
        Err(StorageError::new(ErrKind::Unsupported, "There's no SSH agent on this device. Sign in with a password or a private key."))
    }

    #[cfg(any(windows, all(desktop, unix)))]
    async fn agent_with<S>(&self, handle: &mut client::Handle<HostCheck>, mut agent: russh::keys::agent::client::AgentClient<S>) -> SResult<bool>
    where
        S: russh::keys::agent::client::AgentStream + Unpin + Send + 'static,
    {
        use russh::keys::agent::AgentIdentity;
        let ids = agent.request_identities().await.map_err(|e| no_agent(e.to_string()))?;
        if ids.is_empty() {
            return Err(StorageError::new(ErrKind::NeedsAuth, "The SSH agent has no keys. Add one (ssh-add), or sign in with a password or a private key."));
        }
        for id in ids {
            let AgentIdentity::PublicKey { key, .. } = id else { continue };
            let hash = if key.algorithm().is_rsa() { handle.best_supported_rsa_hash().await.map_err(|e| ssh_error(e, &self.host))?.flatten() } else { None };
            if let Ok(AuthResult::Success) = handle.authenticate_publickey_with(&self.user, key, hash, &mut agent).await {
                return Ok(true);
            }
        }
        Err(StorageError::new(ErrKind::NeedsAuth, "The server didn't accept any key in the SSH agent for this user."))
    }

    /// The live connection, opened (again) when there is none or it dropped.
    /// Every step has a time limit, so the lock is never held for good; a connection that signed
    /// in but then stopped answering is dropped and opened once more.
    async fn conn(&self) -> SResult<Arc<Conn>> {
        let mut guard = self.conn.lock().await;
        if let Some(c) = guard.as_ref().filter(|c| !c.is_closed()) {
            return Ok(c.clone());
        }
        *guard = None;
        let mut attempt = 0;
        let c = loop {
            attempt += 1;
            let handle = self.sign_in_connection().await?;
            match self.open_sftp(handle).await {
                Ok(c) => break Arc::new(c),
                Err(e) if attempt == 1 && e.kind == ErrKind::Network => continue,
                Err(e) => return Err(e),
            }
        };
        *guard = Some(c.clone());
        Ok(c)
    }

    async fn reset(&self, broken: &Arc<Conn>) {
        let mut guard = self.conn.lock().await;
        if guard.as_ref().is_some_and(|c| Arc::ptr_eq(c, broken)) {
            *guard = None;
        }
    }

    /// Runs `f` on the connection; when the connection turns out to have dropped, opens a new
    /// one and runs `f` again (every caller is safe to repeat).
    async fn with<T, F>(&self, f: F) -> SResult<T>
    where
        F: Fn(Arc<Conn>) -> BoxFuture<'static, Result<T, SftpError>>,
    {
        for attempt in 0..2 {
            let c = self.conn().await?;
            match f(c.clone()).await {
                Ok(v) => return Ok(v),
                Err(e) if attempt == 0 && (c.is_closed() || is_connection_error(&e)) => self.reset(&c).await,
                Err(e) => {
                    if is_connection_error(&e) {
                        self.reset(&c).await;
                    }
                    return Err(sftp_error(e));
                }
            }
        }
        Err(dropped())
    }

    async fn base(&self) -> SResult<String> {
        if let Some(b) = self.base.get() {
            return Ok(b.clone());
        }
        self.conn().await?;
        Ok(self.base.get().cloned().unwrap_or_else(|| "/".into()))
    }

    async fn path(&self, key: &str) -> SResult<String> {
        join(&self.base().await?, key)
    }

    fn entry(key: String, m: &FileAttributes) -> Entry {
        let size = m.size.unwrap_or(0);
        let modified = m.mtime.map(|t| t as i64 * 1000);
        Entry { etag: Some(weak_etag(size, modified)), size: size as i64, modified, key, ..Default::default() }
    }

    /// The folder at `path`: (name, attributes), links resolved to what they point at.
    async fn read_dir(&self, path: String) -> SResult<Vec<(String, FileAttributes)>> {
        self.with(move |c| {
            let path = path.clone();
            Box::pin(async move {
                let mut out = Vec::new();
                for e in c.sftp.read_dir(path.clone()).await? {
                    let name = e.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let mut meta = e.metadata();
                    if meta.is_symlink() {
                        match c.sftp.metadata(format!("{}/{name}", path.trim_end_matches('/'))).await {
                            Ok(m) => meta = m,
                            // a broken link has nothing to show
                            Err(_) => continue,
                        }
                    }
                    out.push((name, meta));
                }
                Ok(out)
            })
        })
        .await
    }

    async fn metadata(&self, path: String) -> SResult<Option<FileAttributes>> {
        let r = self
            .with(move |c| {
                let p = path.clone();
                Box::pin(async move { c.sftp.metadata(p).await })
            })
            .await;
        match r {
            Ok(m) => Ok(Some(m)),
            Err(e) if e.kind == ErrKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn ensure_dir(&self, dir: &str) -> SResult<()> {
        let dir = dir_prefix(dir);
        if dir.is_empty() || self.known_dirs.lock().unwrap().contains(&dir) {
            return Ok(());
        }
        let base = self.base().await?;
        let mut key = String::new();
        for part in key_parts(&dir)? {
            key.push_str(part);
            key.push('/');
            if self.known_dirs.lock().unwrap().contains(&key) {
                continue;
            }
            let p = join(&base, &key)?;
            let made = self
                .with({
                    let p = p.clone();
                    move |c| {
                        let p = p.clone();
                        Box::pin(async move { c.sftp.create_dir(p).await })
                    }
                })
                .await;
            if let Err(e) = made {
                // fine if it was there already (servers report that as a plain "failure")
                if !self.metadata(p).await?.is_some_and(|m| m.is_dir()) {
                    return Err(e);
                }
            }
            self.known_dirs.lock().unwrap().insert(key.clone());
        }
        Ok(())
    }

    /// Renames `from` onto `to`. With `replace`, a file at `to` is replaced: by posix-rename
    /// (atomic) where the server has it, else by moving the old file aside first, so it is only
    /// deleted once the new one is in place. Without, a file at `to` makes it fail.
    async fn rename_over(&self, from: String, to: String, replace: bool) -> Result<(), replace::NotReplaced> {
        let not = |error| replace::NotReplaced { error, original_at: None };
        if replace {
            let (f, t) = (from.clone(), to.clone());
            let posix = self
                .with(move |c| {
                    let (f, t) = (f.clone(), t.clone());
                    Box::pin(async move { c.sftp.posix_rename(f, t).await })
                })
                .await;
            match posix {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                // the rename may have gone through before the connection dropped
                Err(e) if e.kind == ErrKind::NotFound && !self.file_exists(&from).await.map_err(not)? && self.file_exists(&to).await.map_err(not)? => {
                    return Ok(());
                }
                Err(e) => return Err(not(e)),
            }
            let backup = sibling_temp(&to);
            return put_in_place(self, &from, &to, &backup).await;
        }
        self.with(move |c| {
            let (f, t) = (from.clone(), to.clone());
            Box::pin(async move { c.sftp.rename(f, t).await })
        })
        .await
        .map_err(not)
    }

    /// Deletes a folder and everything in it, depth first.
    fn remove_tree<'a>(&'a self, path: String, cancel: &'a AtomicBool) -> BoxFuture<'a, SResult<()>> {
        Box::pin(async move {
            let entries = match self.read_dir(path.clone()).await {
                Ok(e) => e,
                Err(e) if e.kind == ErrKind::NotFound => return Ok(()),
                Err(e) => return Err(e),
            };
            let (dirs, files): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(_, m)| m.is_dir());
            for (name, _) in dirs {
                check_cancel(cancel)?;
                self.remove_tree(format!("{}/{name}", path.trim_end_matches('/')), cancel).await?;
            }
            check_cancel(cancel)?;
            let removals = futures_util::stream::iter(files.into_iter().map(|(name, _)| {
                let p = format!("{}/{name}", path.trim_end_matches('/'));
                async move {
                    self.with(move |c| {
                        let p = p.clone();
                        Box::pin(async move { c.sftp.remove_file(p).await })
                    })
                    .await
                }
            }))
            .buffer_unordered(DELETE_PARALLEL)
            .collect::<Vec<_>>()
            .await;
            for r in removals {
                match r {
                    Err(e) if e.kind != ErrKind::NotFound => return Err(e),
                    _ => {}
                }
            }
            check_cancel(cancel)?;
            self.with(move |c| {
                let p = path.clone();
                Box::pin(async move { c.sftp.remove_dir(p).await })
            })
            .await
        })
    }

    async fn remove_quietly(&self, path: String) {
        let _ = self
            .with(move |c| {
                let p = path.clone();
                Box::pin(async move { c.sftp.remove_file(p).await })
            })
            .await;
    }

    /// Writes the bytes to a new file at `path`. Ok(false) when cancelled.
    async fn upload(&self, path: &str, mut body: ByteStream, len: Option<u64>, modified: Option<i64>, progress: Progress<'_>, cancel: &AtomicBool) -> SResult<bool> {
        let c = self.conn().await?;
        let mut f = c
            .sftp
            .open_with_flags(path.to_string(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
            .await
            .map_err(sftp_error)?;
        let mut meter = Meter::new(len, progress, cancel);
        while let Some(chunk) = body.next().await {
            if meter.cancelled() {
                let _ = f.close().await;
                return Ok(false);
            }
            let chunk = chunk?;
            f.write_all(&chunk).await.map_err(|e| or_cancelled(write_error(e), cancel))?;
            meter.sent(chunk.len()).await;
        }
        f.flush().await.map_err(write_error)?;
        f.close().await.map_err(write_error)?;
        if let Some(ms) = modified {
            let t = (ms / 1000).clamp(0, u32::MAX as i64) as u32;
            let attrs = FileAttributes { atime: Some(t), mtime: Some(t), ..FileAttributes::empty() };
            let _ = c.sftp.set_metadata(path.to_string(), attrs).await;
        }
        meter.finish();
        Ok(true)
    }
}

/// A free name next to `path` (a full path) for a file moved aside while another takes its place.
fn sibling_temp(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => format!("{}{}", &path[..=i], temp_key(&path[i + 1..])),
        None => temp_key(path),
    }
}

/// On full paths, each step asked of the server on its own (never repeated as a whole).
#[async_trait]
impl Renames for SftpBackend {
    async fn rename_file(&self, from: &str, to: &str) -> SResult<()> {
        let (from, to) = (from.to_string(), to.to_string());
        self.with(move |c| {
            let (f, t) = (from.clone(), to.clone());
            Box::pin(async move { c.sftp.rename(f, t).await })
        })
        .await
    }

    async fn file_exists(&self, path: &str) -> SResult<bool> {
        Ok(self.metadata(path.to_string()).await?.is_some_and(|m| !m.is_dir()))
    }

    async fn remove_file(&self, path: &str) -> SResult<()> {
        let path = path.to_string();
        self.with(move |c| {
            let p = path.clone();
            Box::pin(async move { c.sftp.remove_file(p).await })
        })
        .await
    }
}

#[async_trait]
impl Storage for SftpBackend {
    fn kind(&self) -> ConnKind {
        ConnKind::Sftp
    }

    fn caps(&self) -> &Capabilities {
        &self.caps
    }

    /// Connects (and so checks the address, the server's key, the sign-in and the folder).
    async fn roots(&self) -> SResult<Vec<RootInfo>> {
        self.conn().await?;
        Ok(vec![root_info(self.name.clone())])
    }

    async fn list(&self, _root: &str, dir: &str, token: Option<String>) -> SResult<Page> {
        let prefix = dir_prefix(dir);
        let path = self.path(&prefix).await?;
        self.pages
            .page(&prefix, token, || async {
                let (mut folders, mut files) = (Vec::new(), Vec::new());
                for (name, meta) in self.read_dir(path).await? {
                    let key = format!("{prefix}{name}");
                    if meta.is_dir() {
                        folders.push(format!("{key}/"));
                    } else {
                        files.push(Self::entry(key, &meta));
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
        let Some(meta) = self.metadata(self.path(path).await?).await? else { return Ok(None) };
        let k = parts.join("/");
        Ok(match (meta.is_dir(), want_dir) {
            (true, true) => Some(Entry { key: if k.is_empty() { k } else { format!("{k}/") }, modified: meta.mtime.map(|t| t as i64 * 1000), ..Default::default() }),
            (false, false) => Some(Self::entry(k, &meta)),
            _ => None,
        })
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        if key_parts(path)?.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("This is a folder, not a file."));
        }
        let full = self.path(path).await?;
        let (c, mut f) = {
            let mut tries = 0;
            loop {
                let c = self.conn().await?;
                match c.sftp.open(full.clone()).await {
                    Ok(f) => break (c, f),
                    Err(e) if tries == 0 && (c.is_closed() || is_connection_error(&e)) => {
                        self.reset(&c).await;
                        tries += 1;
                    }
                    Err(e) => return Err(sftp_error(e)),
                }
            }
        };
        let meta = f.metadata().await.map_err(sftp_error)?;
        if meta.is_dir() {
            return Err(StorageError::other("This is a folder, not a file."));
        }
        let entry = Self::entry(path.to_string(), &meta);
        if if_match.is_some_and(|t| entry.etag.as_deref() != Some(t)) {
            let _ = root;
            return Err(StorageError::conflict());
        }
        let size = meta.size;
        let (start, end) = match (&range, size) {
            (Some(r), Some(s)) => (r.start.min(s), r.end.min(s).max(r.start.min(s))),
            (Some(r), None) => (r.start, r.end.max(r.start)),
            (None, s) => (0, s.unwrap_or(u64::MAX)),
        };
        if start > 0 {
            f.seek(SeekFrom::Start(start)).await.map_err(write_error)?;
        }
        let left = end - start;
        let body = futures_util::stream::unfold((f, left, c), |(mut f, left, c)| async move {
            if left == 0 {
                return None;
            }
            let mut buf = BytesMut::zeroed(CHUNK.min(left.min(usize::MAX as u64) as usize));
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    Some((Ok(buf.freeze()), (f, left - n as u64, c)))
                }
                Err(e) => Some((Err(e), (f, 0, c))),
            }
        });
        Ok(ReadStream {
            body: Box::pin(body),
            len: size.map(|_| left),
            total: size,
            range: range.map(|_| start..end),
            etag: entry.etag,
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
        let tmp = self.path(&temp_key(path)).await?;
        let (body, len) = source_stream(src).await?;
        match self.upload(&tmp, body, len, opts.modified, progress, cancel).await {
            Ok(true) => {}
            Ok(false) => {
                self.remove_quietly(tmp).await;
                return Ok(WriteOutcome::Cancelled);
            }
            Err(e) => {
                self.remove_quietly(tmp).await;
                return Err(e);
            }
        }
        // the temporary file is kept when it can't go in place: it may be all there is of the
        // new version, and the old one is never deleted before the new one is there
        if let Err(e) = self.rename_over(tmp.clone(), target, true).await {
            return Err(e.explain(Some(file_name(&tmp))));
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
                self.with(move |c| {
                    let p = p.clone();
                    Box::pin(async move { c.sftp.remove_file(p).await })
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
        // a file replaces what is there (like S3); a folder never replaces another
        self.rename_over(src, dst, !is_dir).await.map_err(|e| e.explain(None))?;
        let k = if is_dir { dir_prefix(&from.path) } else { from.path.clone() };
        self.pages.forget(&k);
        self.pages.forget(&to.path);
        self.known_dirs.lock().unwrap().retain(|d| !d.starts_with(&k));
        Ok(())
    }

    /// From statvfs, where the server has it (OpenSSH does); nothing otherwise.
    async fn quota(&self) -> SResult<Option<Quota>> {
        let base = self.base().await?;
        let Ok(st) = self
            .with(move |c| {
                let b = base.clone();
                Box::pin(async move { c.sftp.fs_info(b).await })
            })
            .await
        else {
            return Ok(None);
        };
        Ok(st.map(|s| {
            let unit = if s.fragment_size > 0 { s.fragment_size } else { s.block_size };
            Quota { used: s.blocks.saturating_sub(s.blocks_free) * unit, total: Some(s.blocks * unit) }
        }))
    }
}

fn is_connection_error(e: &SftpError) -> bool {
    matches!(e, SftpError::IO(_) | SftpError::Timeout | SftpError::UnexpectedPacket)
}

fn write_error(e: std::io::Error) -> StorageError {
    let low = e.to_string().to_lowercase();
    if low.contains("permission") {
        return StorageError::new(ErrKind::PermissionDenied, "The server didn't allow that. Check the account's permissions.").with_detail(e.to_string());
    }
    if low.contains("no space") || low.contains("quota") {
        return StorageError::other("The server is out of space, or the account is over its quota.").with_detail(e.to_string());
    }
    StorageError::from(e)
}

fn sftp_error(e: SftpError) -> StorageError {
    match &e {
        SftpError::Status(s) => {
            let (kind, say) = match s.status_code {
                StatusCode::NoSuchFile => (ErrKind::NotFound, "This file or folder isn't there any more. It may have been moved or deleted."),
                StatusCode::PermissionDenied => (ErrKind::PermissionDenied, "The server didn't allow that. Check the account's permissions."),
                StatusCode::OpUnsupported => (ErrKind::Unsupported, "This server doesn't support that."),
                StatusCode::Eof => (ErrKind::Other, "The file ended sooner than expected."),
                StatusCode::NoConnection | StatusCode::ConnectionLost => (ErrKind::Network, "The connection to the server dropped. Try again."),
                _ => {
                    let low = s.error_message.to_lowercase();
                    if low.contains("not empty") {
                        (ErrKind::Other, "The folder isn't empty.")
                    } else if low.contains("exist") {
                        (ErrKind::Exists, "Something with this name is already there.")
                    } else if low.contains("quota") || low.contains("space") {
                        (ErrKind::Other, "The server is out of space, or the account is over its quota.")
                    } else {
                        (ErrKind::Other, "The server couldn't do that.")
                    }
                }
            };
            StorageError::new(kind, say).with_detail(e.to_string())
        }
        SftpError::Timeout => StorageError::new(ErrKind::Network, "The server didn't answer in time. Try again.").with_detail(e.to_string()),
        SftpError::IO(_) | SftpError::UnexpectedPacket => dropped().with_detail(e.to_string()),
        SftpError::Limited(_) | SftpError::UnexpectedBehavior(_) => StorageError::other("The server couldn't do that.").with_detail(e.to_string()),
    }
}

fn ssh_error(e: russh::Error, host: &str) -> StorageError {
    use russh::Error as E;
    match e {
        E::IO(io) => connect_error(&io, host),
        E::ConnectionTimeout | E::KeepaliveTimeout | E::InactivityTimeout => timed_out(host),
        E::Disconnect | E::HUP | E::SendError => dropped(),
        E::NoCommonAlgo { .. } | E::UnknownAlgo | E::Version | E::Kex | E::KexInit => {
            StorageError::new(ErrKind::Unsupported, "Couldn't agree on encryption with this server. It may be too old for Kybl.").with_detail(e.to_string())
        }
        E::NoAuthMethod | E::UnsupportedAuthMethod => StorageError::new(ErrKind::NeedsAuth, "The server doesn't accept this way of signing in.").with_detail(e.to_string()),
        E::NotAuthenticated => wrong_login(),
        E::Keys(k) => key_error(k),
        e => StorageError::other(format!("Couldn't connect to {host}.")).with_detail(e.to_string()),
    }
}

fn key_error(e: russh::keys::Error) -> StorageError {
    use russh::keys::Error as K;
    let say = match &e {
        K::KeyIsEncrypted => "This private key is protected by a passphrase. Enter the passphrase.",
        K::UnsupportedKeyType { .. } => "Kybl can't use this type of private key. Use an Ed25519, ECDSA or RSA key.",
        _ if e.to_string().to_lowercase().contains("decrypt") || e.to_string().to_lowercase().contains("passphrase") => "The passphrase for the private key is wrong.",
        _ => "This private key couldn't be read. Paste the whole key, including its BEGIN and END lines.",
    };
    StorageError::new(ErrKind::NeedsAuth, say).with_detail(e.to_string())
}

#[cfg(any(windows, all(desktop, unix)))]
fn no_agent(detail: String) -> StorageError {
    StorageError::new(ErrKind::NeedsAuth, "Couldn't reach the SSH agent. Make sure it's running, or sign in with a password or a private key.").with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_a_host_and_a_user() {
        let cfg = NetConfig { host: "example.com".into(), user: "me".into(), ..Default::default() };
        let b = SftpBackend::new(&cfg, Secrets::default()).unwrap();
        assert_eq!(b.port, 22);
        assert_eq!(b.name, "example.com");
        assert!(SftpBackend::new(&NetConfig { user: "me".into(), ..Default::default() }, Secrets::default()).is_err());
        assert!(SftpBackend::new(&NetConfig { host: "h".into(), ..Default::default() }, Secrets::default()).is_err());
    }

    #[test]
    fn keys_read_or_say_why_not() {
        assert_eq!(key_error(russh::keys::Error::KeyIsEncrypted).kind, ErrKind::NeedsAuth);
        let e = decode_secret_key("not a key", None).map_err(key_error).err().unwrap();
        assert!(e.message.contains("couldn't be read"), "{}", e.message);
    }

    /// An SSH server that signs anyone in and then never answers the request for a session.
    struct Silent {
        held: Vec<russh::server::ChannelOpenHandle>,
    }

    impl russh::server::Handler for Silent {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.held.push(reply);
            Ok(())
        }
    }

    #[test]
    fn a_server_that_stops_answering_after_sign_in_doesnt_hold_the_connection() {
        use russh::keys::{ssh_key::private::Ed25519Keypair, HashAlg, PrivateKey};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let key = PrivateKey::from(Ed25519Keypair::from_seed(&[7; 32]));
            let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
            let config = Arc::new(russh::server::Config { keys: vec![key], auth_rejection_time: Duration::from_millis(10), ..Default::default() });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let accepted = Arc::new(AtomicUsize::new(0));
            let count = accepted.clone();
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    count.fetch_add(1, Ordering::SeqCst);
                    let config = config.clone();
                    tokio::spawn(async move {
                        if let Ok(s) = russh::server::run_stream(config, tcp, Silent { held: vec![] }).await {
                            let _ = s.await;
                        }
                    });
                }
            });
            let cfg = NetConfig { host: "127.0.0.1".into(), port, user: "me".into(), host_key: Some(fp), ..Default::default() };
            let mut b = SftpBackend::new(&cfg, Secrets { password: Some("pw".into()), ssh: None }).unwrap();
            b.session_timeout = Duration::from_millis(500);
            let e = tokio::time::timeout(Duration::from_secs(15), b.roots()).await.expect("waited on the server for good").unwrap_err();
            assert_eq!(e.kind, ErrKind::Network, "{e}");
            assert_eq!(accepted.load(Ordering::SeqCst), 2, "tried once more on a fresh connection");
            assert!(b.conn.lock().await.is_none(), "the stuck connection isn't kept");
            // and the lock is free for the next request
            assert!(tokio::time::timeout(Duration::from_secs(15), b.list("", "", None)).await.expect("the lock was still held").is_err());
        });
    }
}
