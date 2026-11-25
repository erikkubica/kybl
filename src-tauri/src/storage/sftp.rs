//! SFTP as a [`Storage`], with russh (ring crypto) and russh-sftp: the same code on every OS,
//! phones included (OpenDAL's SFTP spawns the system `ssh`, which phones and Windows lack).
//!
//! Sign-in by password (also answered to keyboard-interactive prompts, which many servers use for
//! passwords), a private key (OpenSSH, PEM or PuTTY, with its passphrase) or, on a computer, the
//! SSH agent. The server's key is trusted on first use: see [`hostkey`].
//!
//! One SSH connection per backend carries every request (SFTP runs many at once over it). It
//! sends keepalives, and a dropped connection is opened again on the next request.

pub mod command;
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
        permissions: true,
        links: true,
        ..Capabilities::default()
    }
}

/// One name in a folder: its attributes (a link's are what it points at) and, for a symbolic
/// link, its target as stored.
struct Listed {
    name: String,
    meta: FileAttributes,
    link: Option<String>,
}

/// The permissions, owner and group a server reports (SFTP v3 gives numbers for the owner).
fn unix_meta(m: &FileAttributes) -> Entry {
    Entry {
        mode: m.permissions.map(|p| p & 0o7777),
        owner: m.user.clone().or_else(|| m.uid.map(|u| u.to_string())),
        group: m.group.clone().or_else(|| m.gid.map(|g| g.to_string())),
        ..Default::default()
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

    /// The TCP connection, the server's key checked and signed in (also what an SSH tunnel runs
    /// over, see `tunnels::run`).
    pub(crate) async fn sign_in_connection(&self) -> SResult<client::Handle<HostCheck>> {
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            preferred: russh::Preferred { kex: std::borrow::Cow::Borrowed(KEX_ORDER), ..Default::default() },
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

    /// An interactive shell for a terminal pane (src/terminal): a connection of its own, signed in
    /// like this one, with a pseudo-terminal of `cols` × `rows` and the user's login shell on it.
    #[cfg_attr(mobile, allow(dead_code))]
    pub(crate) async fn open_shell(&self, cols: u32, rows: u32, lang: Option<&str>) -> SResult<(client::Handle<HostCheck>, russh::Channel<client::Msg>)> {
        let handle = self.sign_in_connection().await?;
        let err = |e: russh::Error| ssh_error(e, &self.host);
        let opening = async {
            let ch = handle.channel_open_session().await.map_err(err)?;
            ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await.map_err(err)?;
            // servers pass LANG on only when they accept it (AcceptEnv); a refusal changes nothing
            if let Some(l) = lang {
                let _ = ch.set_env(false, "LANG", l).await;
            }
            ch.request_shell(false).await.map_err(err)?;
            Ok(ch)
        };
        let ch = with_timeout(&self.host, self.session_timeout, opening).await?;
        Ok((handle, ch))
    }

    /// Where folder `key` of this connection is on the server, for a shell: an absolute path, or
    /// one below the user's home folder ("~", "~/www/site") when the connection's folder is given
    /// relative to it.
    #[cfg_attr(mobile, allow(dead_code))]
    pub(crate) fn shell_dir(&self, key: &str) -> SResult<String> {
        let parts = key_parts(key)?;
        if self.base_cfg.starts_with('/') {
            return join(&clean_base(&self.base_cfg), key);
        }
        let rel: Vec<&str> = self.base_cfg.split('/').filter(|p| !p.is_empty() && *p != ".").chain(parts).collect();
        Ok(if rel.is_empty() { "~".into() } else { format!("~/{}", rel.join("/")) })
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
        Entry { etag: Some(weak_etag(size, modified)), size: size as i64, modified, key, ..unix_meta(m) }
    }

    fn folder(key: String, m: &FileAttributes) -> Entry {
        Entry { key, modified: m.mtime.map(|t| t as i64 * 1000), ..unix_meta(m) }
    }

    /// The folder at `path`, links resolved to what they point at (a broken link lists as an
    /// empty file, so it can still be seen and deleted).
    async fn read_dir(&self, path: String) -> SResult<Vec<Listed>> {
        self.with(move |c| {
            let path = path.clone();
            Box::pin(async move {
                let mut out = Vec::new();
                for e in c.sftp.read_dir(path.clone()).await? {
                    let name = e.file_name().to_string();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let mut meta = e.metadata();
                    let mut link = None;
                    if meta.is_symlink() {
                        let full = format!("{}/{name}", path.trim_end_matches('/'));
                        link = Some(c.sftp.read_link(full.clone()).await.map(|t| t.to_string()).unwrap_or_default());
                        match c.sftp.metadata(full).await {
                            Ok(m) => meta = m,
                            Err(_) => {
                                meta.set_regular(true);
                                meta.size = Some(0);
                            }
                        }
                    }
                    out.push(Listed { name, meta, link });
                }
                Ok(out)
            })
        })
        .await
    }

    /// What a write to `path` replaces, as `cp` treats it: a link (to a file inside this
    /// connection's folder) is followed, so the file it points at is updated and the link stays a
    /// link; and the replaced file's permission bits, so a 0600 secret or a 0755 script keeps them.
    async fn replacing(&self, root: &str, path: &str) -> SResult<(String, Option<u32>)> {
        let bits = |m: FileAttributes| m.permissions.map(|p| p & 0o7777);
        // (one LSTAT for the usual cases: nothing there, or a plain file)
        let Some(own) = self.link_metadata(self.path(path).await?).await? else { return Ok((path.to_string(), None)) };
        if !own.is_symlink() {
            return Ok((path.to_string(), if own.is_dir() { None } else { bits(own) }));
        }
        let mut key = path.to_string();
        if let Ok(e) = self.resolve_link(root, path).await
            && !e.is_dir()
            && !e.key.is_empty()
        {
            key = e.key;
        }
        let mode = self.metadata(self.path(&key).await?).await?.filter(|m| !m.is_dir()).and_then(bits);
        Ok((key, mode))
    }

    /// The attributes of `path` itself, not of what a link there points at.
    async fn link_metadata(&self, path: String) -> SResult<Option<FileAttributes>> {
        let r = self
            .with(move |c| {
                let p = path.clone();
                Box::pin(async move { c.sftp.symlink_metadata(p).await })
            })
            .await;
        match r {
            Ok(m) => Ok(Some(m)),
            Err(e) if e.kind == ErrKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
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

    /// Deletes a folder and everything in it, depth first; `tally` counts what is in it (the folder
    /// itself is the caller's to count).
    fn remove_tree<'a>(&'a self, path: String, cancel: &'a AtomicBool, tally: &'a Tally<'a>) -> BoxFuture<'a, SResult<()>> {
        Box::pin(async move {
            let entries = match self.read_dir(path.clone()).await {
                Ok(e) => e,
                Err(e) if e.kind == ErrKind::NotFound => return Ok(()),
                Err(e) => return Err(e),
            };
            tally.found(entries.len() as u64);
            // a link (to a folder too) goes by itself: what it points at is never touched
            let (dirs, files): (Vec<_>, Vec<_>) = entries.into_iter().partition(|e| e.meta.is_dir() && e.link.is_none());
            for Listed { name, .. } in dirs {
                check_cancel(cancel)?;
                self.remove_tree(format!("{}/{name}", path.trim_end_matches('/')), cancel, tally).await?;
                tally.removed(1);
            }
            check_cancel(cancel)?;
            let removals = futures_util::stream::iter(files.into_iter().map(|Listed { name, .. }| {
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
            for r in &removals {
                match r {
                    Err(e) if e.kind != ErrKind::NotFound => return Err(e.clone()),
                    _ => {}
                }
            }
            tally.removed(removals.len() as u64);
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
    /// Writes `body` to `path`: a new file, or with `offset` the rest of one from that byte on.
    #[allow(clippy::too_many_arguments)]
    async fn upload(&self, path: &str, mut body: ByteStream, len: Option<u64>, offset: Option<u64>, modified: Option<i64>, progress: Progress<'_>, cancel: &AtomicBool) -> SResult<bool> {
        let c = self.conn().await?;
        let flags = match offset {
            Some(_) => OpenFlags::CREATE | OpenFlags::WRITE,
            None => OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        };
        let mut f = c.sftp.open_with_flags(path.to_string(), flags).await.map_err(sftp_error)?;
        if let Some(at) = offset {
            f.seek(SeekFrom::Start(at)).await.map_err(write_error)?;
        }
        let mut meter = Meter::starting_at(offset.unwrap_or(0), len, progress, cancel);
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

    fn as_sftp(&self) -> Option<&SftpBackend> {
        Some(self)
    }

    /// The server and the folder paths start from (two connections to one server and folder
    /// see the same files, whoever signs in).
    fn place_id(&self) -> Option<String> {
        let base = self.base.get().cloned().unwrap_or_else(|| self.base_cfg.clone());
        Some(format!("sftp:{}:{}:{base}", self.host.to_ascii_lowercase(), self.port))
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
            .page_with_info(&prefix, token, || async {
                let (mut folders, mut files, mut info) = (Vec::new(), Vec::new(), Vec::new());
                for Listed { name, meta, link } in self.read_dir(path).await? {
                    let key = format!("{prefix}{name}");
                    if meta.is_dir() {
                        folders.push(format!("{key}/"));
                        info.push(Entry { link, ..Self::folder(format!("{key}/"), &meta) });
                    } else {
                        files.push(Entry { link, ..Self::entry(key, &meta) });
                    }
                }
                self.known_dirs.lock().unwrap().insert(prefix.clone());
                Ok((folders, files, info))
            })
            .await
    }

    async fn stat(&self, _root: &str, path: &str) -> SResult<Option<Entry>> {
        let parts = key_parts(path)?;
        let want_dir = path.ends_with('/') || parts.is_empty();
        let Some(meta) = self.metadata(self.path(path).await?).await? else { return Ok(None) };
        let k = parts.join("/");
        Ok(match (meta.is_dir(), want_dir) {
            (true, true) => Some(Self::folder(if k.is_empty() { k } else { format!("{k}/") }, &meta)),
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
        // the size the server gave: an end of file before it is a cut read, never a whole file
        let known = size.is_some();
        let body = futures_util::stream::unfold((f, left, c), move |(mut f, left, c)| async move {
            if left == 0 {
                return None;
            }
            let mut buf = BytesMut::zeroed(CHUNK.min(left.min(usize::MAX as u64) as usize));
            match f.read(&mut buf).await {
                Ok(0) if known => Some((Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, format!("The file ended {left} bytes short of its size."))), (f, 0, c))),
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
        let asked = path;
        let (resolved, old_mode) = self.replacing(root, path).await?;
        let path = resolved.as_str();
        self.ensure_dir(&parent_key(path)).await?;
        let target = self.path(path).await?;
        // an interrupted upload carries on in its temporary file, from the bytes already there
        let len_now = source_len(&src).await;
        let (tmp_key, offset) = match opts.resume.as_ref().filter(|rs| is_temp_for(&rs.upload_id, path)) {
            Some(rs) => {
                let have = self.metadata(self.path(&rs.upload_id).await?).await?.filter(|m| !m.is_dir()).and_then(|m| m.size);
                match resume_offset(have, len_now) {
                    Some(at) => (rs.upload_id.clone(), Some(at)),
                    None => (temp_key(path), None),
                }
            }
            None => (temp_key(path), None),
        };
        let tmp = self.path(&tmp_key).await?;
        // with `on_part` the caller keeps an interrupted upload to carry on: its file stays
        let keep = opts.on_part.is_some();
        announce_temp(&opts, &tmp_key, offset.unwrap_or(0));
        let (body, len) = source_stream_from(src, offset.unwrap_or(0)).await?;
        match self.upload(&tmp, body, len, offset, opts.modified, progress, cancel).await {
            Ok(true) => {}
            Ok(false) => {
                if !keep {
                    self.remove_quietly(tmp).await;
                }
                return Ok(WriteOutcome::Cancelled);
            }
            Err(e) => {
                if !keep {
                    self.remove_quietly(tmp).await;
                }
                if e.kind == ErrKind::NotFound {
                    forget_dir_chain(&self.known_dirs, &parent_key(path));
                }
                return Err(e);
            }
        }
        // a resumed file goes in place only whole
        if offset.is_some()
            && let Some(want) = len
        {
            let got = self.metadata(tmp.clone()).await?.and_then(|m| m.size);
            if got != Some(want) {
                self.remove_quietly(tmp).await;
                return Err(StorageError::other("The upload couldn't be carried on where it stopped, so it will start over.")
                    .with_detail(format!("{} bytes on the server instead of {want}", got.unwrap_or(0))));
            }
        }
        // the new file takes the permissions of the one it replaces
        if let Some(mode) = old_mode {
            let t = tmp.clone();
            let _ = self
                .with(move |c| {
                    let p = t.clone();
                    Box::pin(async move { c.sftp.set_metadata(p, FileAttributes { permissions: Some(mode), ..FileAttributes::empty() }).await })
                })
                .await;
        }
        // "only if nothing is there" holds to the end: a plain rename refuses a file that turned
        // up during the upload
        if opts.precondition == Precondition::IfNoneMatch {
            if let Err(e) = self.rename_over(tmp.clone(), target, false).await {
                self.remove_quietly(tmp).await;
                return match self.stat(root, path).await? {
                    Some(now) => Ok(WriteOutcome::Conflict(Some(now))),
                    None => Err(e.error),
                };
            }
            self.pages.forget(path);
            self.pages.forget(asked);
            let entry = self.stat(root, asked).await?.unwrap_or_else(|| Entry { key: asked.to_string(), size: len.unwrap_or(0) as i64, ..Default::default() });
            return Ok(WriteOutcome::Done(entry));
        }
        // the temporary file is kept when it can't go in place: it may be all there is of the
        // new version, and the old one is never deleted before the new one is there
        if let Err(e) = self.rename_over(tmp.clone(), target, true).await {
            return Err(e.explain(Some(file_name(&tmp))));
        }
        self.pages.forget(path);
        self.pages.forget(asked);
        let entry = self.stat(root, asked).await?.unwrap_or_else(|| Entry { key: asked.to_string(), size: len.unwrap_or(0) as i64, ..Default::default() });
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
        let tally = Tally::new((files.len() + dirs.len()) as u64, on_progress);
        for (key, is_dir) in delete_items(files, dirs) {
            check_cancel(cancel)?;
            if key_parts(key)?.is_empty() {
                return Err(top_refused());
            }
            let p = self.path(key).await?;
            // a folder that is a link: only the link goes, never what is in the folder it points at
            let is_tree = is_dir && !self.link_metadata(p.clone()).await?.is_some_and(|m| m.is_symlink());
            let r = if is_tree {
                self.remove_tree(p, cancel, &tally).await
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
            tally.removed(1);
        }
        Ok(tally.get())
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

    async fn remote_hash(&self, _root: &str, path: &str, size: u64) -> SResult<Option<(HashKind, String)>> {
        self.hash_on_server(path, size).await
    }

    async fn set_mode(&self, _root: &str, path: &str, mode: u32) -> SResult<()> {
        let full = self.path(path).await?;
        self.with(move |c| {
            let p = full.clone();
            Box::pin(async move { c.sftp.set_metadata(p, FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::empty() }).await })
        })
        .await?;
        self.pages.forget(path);
        Ok(())
    }

    async fn make_link(&self, _root: &str, path: &str, target: &str) -> SResult<()> {
        if key_parts(path)?.is_empty() || target.trim().is_empty() {
            return Err(StorageError::other("A link needs a name and something to point at."));
        }
        let full = self.path(path.trim_end_matches('/')).await?;
        if self.link_metadata(full.clone()).await?.is_some() {
            return Err(StorageError::exists());
        }
        let target = target.to_string();
        self.with(move |c| {
            let (link, target) = (full.clone(), target.clone());
            // OpenSSH (and servers built like it) read SSH_FXP_SYMLINK's two paths the other way
            // round from the draft: the target first, then the link
            Box::pin(async move { c.sftp.symlink(target, link).await })
        })
        .await?;
        self.pages.forget(path);
        Ok(())
    }

    async fn resolve_link(&self, _root: &str, path: &str) -> SResult<Entry> {
        let full = self.path(path.trim_end_matches('/')).await?;
        let base = self.base().await?;
        let (real, real_base) = self
            .with(move |c| {
                let (p, b) = (full.clone(), base.clone());
                Box::pin(async move { Ok((c.sftp.canonicalize(p).await?.to_string(), c.sftp.canonicalize(b).await?.to_string())) })
            })
            .await?;
        let Some(meta) = self.metadata(real.clone()).await? else {
            return Err(StorageError::new(ErrKind::NotFound, "The original isn't there any more: the link is broken.").with_detail(real));
        };
        let Some(rel) = key_under(&real_base, &real) else {
            return Err(StorageError::other(format!("The original is outside this connection's folder: {real}")));
        };
        Ok(if meta.is_dir() { Self::folder(if rel.is_empty() { rel } else { format!("{rel}/") }, &meta) } else { Self::entry(rel, &meta) })
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

/// `path` (a full server path) as a key below `base`: "" for the base itself, None outside it.
fn key_under(base: &str, path: &str) -> Option<String> {
    let base = base.trim_end_matches('/');
    if path.trim_end_matches('/') == base {
        return Some(String::new());
    }
    path.strip_prefix(base).and_then(|r| r.strip_prefix('/')).map(|r| r.trim_end_matches('/').to_string())
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

/// Key exchanges, best first: russh's own list, with the fixed Diffie-Hellman groups and NIST
/// ECDH ahead of group exchange. ProFTPD's mod_sftp (Hetzner Storage Boxes, many shared hosts)
/// offers no curve25519, and its group exchange fails with russh ("Key exchange init failed"),
/// while group 16/18/14 work. Every one of these is still a strong choice.
const KEX_ORDER: &[russh::kex::Name] = &[
    russh::kex::MLKEM768X25519_SHA256,
    russh::kex::CURVE25519,
    russh::kex::CURVE25519_PRE_RFC_8731,
    russh::kex::DH_G16_SHA512,
    russh::kex::DH_G18_SHA512,
    russh::kex::DH_G14_SHA256,
    russh::kex::ECDH_SHA2_NISTP256,
    russh::kex::ECDH_SHA2_NISTP384,
    russh::kex::ECDH_SHA2_NISTP521,
    russh::kex::DH_GEX_SHA256,
    russh::kex::DH_G17_SHA512,
    russh::kex::DH_G15_SHA512,
    russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
    russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
];

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
    /// Against a real server (env KYBL_SSH_HELLO="host port"): only the handshake, no sign-in. A
    /// server whose key isn't saved yet ends in the "unknown host key" question, which means the
    /// key exchange itself went through. Ignored by default.
    #[test]
    #[ignore]
    fn real_server_handshake() {
        let hp = std::env::var("KYBL_SSH_HELLO").unwrap();
        let (host, port) = hp.split_once(' ').unwrap();
        let cfg = NetConfig { host: host.into(), port: port.parse().unwrap(), user: "kybl-handshake-only".into(), ..Default::default() };
        let b = SftpBackend::new(&cfg, Secrets { password: Some("-".into()), ssh: None }).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let r = rt.block_on(b.sign_in_connection()).map(|_| ());
        let e = r.unwrap_err();
        eprintln!("HANDSHAKE -> {} | {}", e.message, e.detail.as_deref().unwrap_or(""));
        assert!(!e.message.contains("agree on encryption"), "key exchange failed");
    }

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
    fn a_shell_goes_to_the_folder_absolute_or_below_home() {
        let at = |base: &str, key: &str| {
            let cfg = NetConfig { host: "h".into(), user: "me".into(), base_path: base.into(), ..Default::default() };
            SftpBackend::new(&cfg, Secrets::default()).unwrap().shell_dir(key).unwrap()
        };
        assert_eq!(at("/var/www/", "site/img/"), "/var/www/site/img");
        assert_eq!(at("/", ""), "/");
        assert_eq!(at("", ""), "~");
        assert_eq!(at("", "docs/"), "~/docs");
        assert_eq!(at("./www", "a b/"), "~/www/a b");
        let cfg = NetConfig { host: "h".into(), user: "me".into(), ..Default::default() };
        assert!(SftpBackend::new(&cfg, Secrets::default()).unwrap().shell_dir("../etc").is_err());
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
