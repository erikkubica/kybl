//! FTP and FTPS as a [`Storage`], with suppaftp (rustls on ring).
//!
//! Encryption follows `NetConfig::tls`: `none` (plain FTP: the password and files cross the
//! network readable by anyone on the way; the UI warns), `explicit` (AUTH TLS on port 21) or
//! `implicit` (TLS from the first byte, port 990). A server's own certificate is trusted once the
//! user has checked it (`NetConfig::cert_fingerprint`, see [`super::certtrust`]). Passive mode,
//! with the usual fix for servers behind NAT that announce a private address. Names are UTF-8. Listings use MLSD where the server
//! has it, else LIST.
//!
//! An FTP connection does one thing at a time, so a few are kept open and lent out: a read holds
//! its connection until the body is finished. Uploads go to a temporary name next to the target
//! and are renamed over it once whole; a server that won't rename over a file gets the old one
//! moved aside first (see [`super::sftp::replace`]), so it is never deleted before the new one is
//! in place.

use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    sync::{
        atomic::AtomicBool,
        Arc, Mutex,
    },
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
    certtrust::{self, Seen},
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
/// Starts the version tags `read` makes from SIZE and MDTM (listings make their own).
const MDTM_TAG: &str = "mdtm:";

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
        // SITE CHMOD: most Unix servers take it; one that doesn't says so when asked
        permissions: true,
        ..Capabilities::default()
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Feats {
    mlsd: bool,
    /// MFMT: a file's modification time can be set
    mfmt: bool,
}

struct Pool {
    idle: Mutex<Vec<(Ftp, Instant)>>,
    slots: Arc<Semaphore>,
    /// streaming reads: one fewer than `slots`
    readers: Arc<Semaphore>,
}

/// A lent connection; it goes back to the pool when dropped, unless something went wrong on it.
struct Lease {
    conn: Option<Ftp>,
    pool: Arc<Pool>,
    healthy: bool,
    _permit: OwnedSemaphorePermit,
    /// held by a streaming read until its body is done
    _reader: Option<OwnedSemaphorePermit>,
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
    /// the server's own certificate, trusted by the user
    cert_pin: Option<String>,
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

/// Answers to AUTH TLS that mean "not offered here" (anything else, a 4xx above all, is a
/// passing failure and never a reason to go on unencrypted).
const NOT_OFFERED: [u32; 4] = [500, 502, 504, 534];

const TLS_STOPPED: &str = "This server encrypted the connection before (or says it can), but now refuses to. Kybl didn't fall back to plain FTP, so nothing was sent unencrypted. Something on this network may be in the way: try another network. If the server really stopped offering encryption, turn encryption off in this connection's settings.";

const PLAIN_ASK: &str = "This server didn't offer encryption, so Kybl hasn't sent your password. If you know this server only speaks plain FTP, you can connect without encryption: your password and files then cross the network unencrypted. On a public or unknown network, someone may be blocking encryption on purpose.";

/// The first line of a [`PLAIN_ASK`] error's detail, for the UI to offer "Connect without
/// encryption" (which calls [`ftp_allow_plain`]).
pub const PLAIN_MARK: &str = "ftp-plain-unconfirmed";

/// The per-run tag that starts every trust error's detail (see [`super::trust_tag`]), for the UI
/// to tell Kybl's own trust questions from text a server sent.
#[tauri::command]
pub fn trust_tag() -> String {
    super::trust_tag().to_string()
}

/// "Connect without encryption": the user agrees that the "encrypt if available" FTP server of
/// `net` may be used over plain FTP when it offers no encryption. A server that encrypted a
/// connection before (or says it can) is still never used unencrypted.
#[tauri::command]
pub fn ftp_allow_plain(net: NetConfig) -> Result<(), String> {
    let b = FtpBackend::new(&net, None)?;
    tls_memory::allow_plain(&b.tls_key());
    Ok(())
}

/// Which of the folders MLSD listed (`dirs`) LIST shows as links (`listed`: name, is a link).
/// Err(name) for a folder LIST doesn't show at all: it can't be told apart from a link.
fn link_dirs<'a>(dirs: impl IntoIterator<Item = &'a str>, listed: impl IntoIterator<Item = (&'a str, bool)>) -> Result<HashSet<String>, String> {
    let listed: HashMap<&str, bool> = listed.into_iter().collect();
    let mut links = HashSet::new();
    for d in dirs {
        match listed.get(d) {
            Some(true) => {
                links.insert(d.to_string());
            }
            Some(false) => {}
            None => return Err(d.to_string()),
        }
    }
    Ok(links)
}

/// Whether a FEAT answer lists AUTH TLS (or SSL).
fn offers_tls<'a>(feats: impl IntoIterator<Item = (&'a str, Option<&'a str>)>) -> bool {
    feats.into_iter().any(|(k, v)| {
        let line = format!("{k} {}", v.unwrap_or("")).to_ascii_uppercase();
        line.starts_with("AUTH") && (line.contains("TLS") || line.contains("SSL"))
    })
}

/// The servers ("user@host:port") an "encrypt if available" connection once reached with TLS,
/// kept in the app's data folder: such a server refusing later is not taken as "it only speaks
/// plain FTP" (that refusal is what someone on the network would forge to read the password).
///
/// The list only ever grows. Every write re-reads the file under a lock and merges (another
/// running Kybl may have added servers since), and goes through a flushed temporary file. A file
/// that can't be read is never taken for "nothing seen": what can still be read from it is kept,
/// the damaged copy is set aside, and the list is in doubt: a server not in it may have been seen,
/// so an "encrypt if available" connection refused encryption asks the user before going plain,
/// and only consent given in that run counts (a file that couldn't be opened is read again on
/// the next question, and once it reads whole the doubt is over).
///
/// The user's consent to plain FTP is kept in the same list as `<key>#plain`. Server keys end in
/// the port's digits, so no key (whatever its user name) is ever read as a consent entry. Older
/// `plain:<key>` entries are ignored (they could be a server key): the user is asked once more.
pub mod tls_memory {
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        sync::{Mutex, OnceLock},
    };

    static PATH: OnceLock<PathBuf> = OnceLock::new();
    static MEMORY: Mutex<Option<Memory>> = Mutex::new(None);

    /// Why the list may lack entries.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Doubt {
        /// the file couldn't be opened (locked, a passing error): read again on the next question
        Unreadable,
        /// the file was damaged: what was lost stays lost for this run
        Damaged,
    }

    /// What the list says of a server.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Known {
        /// reached with TLS before
        Seen,
        /// not in a list read whole
        NotSeen,
        /// not in the list, but the list may lack entries
        Unsure,
    }

    #[derive(Default, Debug)]
    pub(super) struct Memory {
        /// servers seen with TLS (`user@host:port`) and consent entries ([`consent_entry`])
        seen: HashSet<String>,
        /// the file couldn't be read whole: entries may be missing
        doubt: Option<Doubt>,
        /// servers the user agreed to use over plain FTP during this run: they count even while
        /// the list is in doubt (the consent was given knowing what the server is like now)
        agreed_now: HashSet<String>,
    }

    impl Memory {
        /// An entry read from the list (or added since).
        pub(super) fn seen(&self, key: &str) -> bool {
            self.seen.contains(key)
        }

        pub(super) fn known(&self, key: &str) -> Known {
            match (self.seen(key), self.doubt) {
                (true, _) => Known::Seen,
                (false, None) => Known::NotSeen,
                (false, Some(_)) => Known::Unsure,
            }
        }

        /// The user's consent for plain FTP: in doubt, only consent given in this run counts (a
        /// lost "seen with TLS" entry must not let an old consent through).
        pub(super) fn plain_allowed(&self, key: &str) -> bool {
            self.agreed_now.contains(key) || (self.doubt.is_none() && self.seen.contains(&consent_entry(key)))
        }
    }

    /// The consent entry of a server, kept in the same list. Server keys always end in the port's
    /// digits, so no server key (whatever its user name) can be written like one.
    pub(super) fn consent_entry(key: &str) -> String {
        format!("{key}#plain")
    }

    /// Where the list is kept (set once at start-up; without it, it lasts until the app quits).
    pub fn init(path: PathBuf) {
        let _ = PATH.set(path);
    }

    /// The quoted names still readable in a damaged file (a list cut short, stray bytes).
    fn salvage(raw: &[u8]) -> HashSet<String> {
        let text = String::from_utf8_lossy(raw);
        let mut out = HashSet::new();
        let mut rest = text.as_ref();
        while let Some(start) = rest.find('"') {
            let after = &rest[start + 1..];
            let mut end = None;
            let mut escaped = false;
            for (i, c) in after.char_indices() {
                match c {
                    '\\' if !escaped => escaped = true,
                    '"' if !escaped => {
                        end = Some(i);
                        break;
                    }
                    _ => escaped = false,
                }
            }
            let Some(end) = end else { break };
            if let Ok(s) = serde_json::from_str::<String>(&format!("\"{}", &after[..=end]))
                && !s.is_empty()
            {
                out.insert(s);
            }
            rest = &after[end + 1..];
        }
        out
    }

    /// Merges what the file holds into `m`. A damaged file: what can be read is kept, the file is
    /// set aside and rewritten from that, and `m` stays in doubt. A file that exists but can't be
    /// opened: in doubt too, and left alone (false: the file must not be written over).
    pub(super) fn merge_from_disk(path: &Path, m: &mut Memory) -> bool {
        // a file that couldn't be opened before and reads whole now: nothing is missing any more
        let clear = |m: &mut Memory| {
            if m.doubt == Some(Doubt::Unreadable) {
                m.doubt = None;
            }
        };
        let raw = match std::fs::read(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => {
                m.doubt = m.doubt.or(Some(Doubt::Unreadable));
                return false;
            }
        };
        match serde_json::from_slice::<Vec<String>>(&raw) {
            Ok(list) => {
                m.seen.extend(list);
                clear(m);
            }
            Err(_) => {
                m.doubt = Some(Doubt::Damaged);
                m.seen.extend(salvage(&raw));
                // the rewritten list reads whole on the next run, when its consent entries count
                // again: one whose server isn't listed may have lost its "seen with TLS" entry
                // here, so it is dropped (the user is asked once more). Consent of this run stays.
                let keep: HashSet<String> = m
                    .seen
                    .iter()
                    .filter_map(|e| e.strip_suffix("#plain"))
                    .filter(|k| m.agreed_now.contains(*k) || m.seen.contains(*k))
                    .map(consent_entry)
                    .collect();
                m.seen.retain(|e| !e.ends_with("#plain") || keep.contains(e));
                let aside = path.with_extension(format!("damaged-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)));
                if std::fs::rename(path, &aside).is_err() {
                    return false;
                }
                let _ = write(path, m);
            }
        }
        true
    }

    fn write(path: &Path, m: &Memory) -> std::io::Result<()> {
        let mut list: Vec<&String> = m.seen.iter().collect();
        list.sort();
        crate::state::write_atomic(path, &serde_json::to_vec(&list).map_err(std::io::Error::other)?)
    }

    /// Adds `key` and writes the list: the file read again and merged first, under a lock that
    /// other running copies of Kybl take too, so no copy's entries are ever dropped.
    pub(super) fn add_and_save(path: &Path, m: &mut Memory, key: &str) {
        m.seen.insert(key.to_string());
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path.with_extension("lock"));
        let _held = lock.as_ref().ok().filter(|f| f.lock().is_ok());
        // a file that couldn't be read is never written over (it may hold entries this run lacks)
        if merge_from_disk(path, m) {
            let _ = write(path, m);
        }
    }

    fn with<T>(f: impl FnOnce(&mut Memory, Option<&Path>) -> T) -> T {
        let mut g = MEMORY.lock().unwrap();
        let path = PATH.get().map(PathBuf::as_path);
        let m = g.get_or_insert_with(|| {
            let mut m = Memory::default();
            if let Some(p) = path {
                merge_from_disk(p, &mut m);
            }
            m
        });
        f(m, path)
    }

    pub fn seen(key: &str) -> Known {
        with(|m, path| {
            // another running Kybl may have reached this server with TLS since the list was read
            // (and a file that couldn't be opened is tried again)
            if !m.seen(key)
                && let Some(p) = path
            {
                merge_from_disk(p, m);
            }
            m.known(key)
        })
    }

    pub fn remember(key: &str) {
        add(key.to_string());
    }

    /// The user agreed that this server, which offers no encryption, may be used over plain FTP.
    /// Asked before the first unencrypted sign-in; a lost list only means being asked again.
    pub fn allow_plain(key: &str) {
        with(|m, _| m.agreed_now.insert(key.to_string()));
        add(consent_entry(key));
    }

    pub fn plain_allowed(key: &str) -> bool {
        with(|m, path| {
            // another running Kybl may have been given the OK since the list was read
            if !m.plain_allowed(key)
                && let Some(p) = path
            {
                merge_from_disk(p, m);
            }
            m.plain_allowed(key)
        })
    }

    fn add(entry: String) {
        with(|m, path| match path {
            Some(p) if !m.seen.contains(&entry) => add_and_save(p, m, &entry),
            _ => {
                m.seen.insert(entry);
            }
        })
    }
}

impl FtpBackend {
    /// This server and account, for [`tls_memory`].
    fn tls_key(&self) -> String {
        format!("{}@{}:{}", self.user, self.host.to_ascii_lowercase(), self.port)
    }

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
            cert_pin: cfg.cert_fingerprint.clone().filter(|f| !f.trim().is_empty()),
            base_cfg: cfg.base_path.trim().to_string(),
            base: OnceCell::new(),
            feats: OnceCell::new(),
            caps: ftp_caps(),
            pool: Arc::new(Pool { idle: Mutex::default(), slots: Arc::new(Semaphore::new(MAX_CONNS)), readers: Arc::new(Semaphore::new(MAX_CONNS - 1)) }),
            pages: PageCache::default(),
            known_dirs: Mutex::default(),
        })
    }

    async fn connect(&self) -> SResult<Ftp> {
        with_timeout(&self.host, CONNECT_TIMEOUT, async {
            let addr = addr_string(&self.host, self.port);
            // a fresh TLS setup per connection, so a refused certificate is this connection's
            let (tls_cfg, seen) = certtrust::client_config(self.cert_pin.as_deref());
            let tls = || AsyncRustlsConnector::from(suppaftp::tokio_rustls::TlsConnector::from(tls_cfg.clone()));
            let err = |e: FtpError| cert_refused(&e, &seen).unwrap_or_else(|| ftp_error(e, &self.host));
            let mut ftp = match self.tls {
                TlsMode::None => Ftp::connect(&addr).await.map_err(err)?,
                TlsMode::Explicit => Ftp::connect(&addr).await.map_err(err)?.into_secure(tls(), &self.host).await.map_err(|e| match e {
                    FtpError::UnexpectedResponse(_) => StorageError::new(ErrKind::Network, "This server doesn't offer encryption on this port. Try implicit encryption (port 990), or allow the fallback to plain FTP if the server only speaks that.")
                        .with_detail(one_line(&e.to_string())),
                    e => err(e),
                })?,
                // asked on every connection: one refusal (which anyone on the network can forge)
                // never decides for the next
                TlsMode::Auto => match Ftp::connect(&addr).await.map_err(err)?.into_secure(tls(), &self.host).await {
                    Ok(ftp) => {
                        tls_memory::remember(&self.tls_key());
                        ftp
                    }
                    // AUTH TLS refused as not offered: the server may only speak plain FTP. A
                    // failed handshake is not a refusal and stays an error.
                    Err(FtpError::UnexpectedResponse(r)) if NOT_OFFERED.contains(&r.status.code()) => {
                        // reached with TLS before: never plain. A list that may lack entries
                        // (it couldn't be read whole) goes on to the user's consent below, where
                        // only consent given in this run counts.
                        if tls_memory::seen(&self.tls_key()) == tls_memory::Known::Seen {
                            return Err(StorageError::new(ErrKind::Network, TLS_STOPPED).with_detail(one_line(&r.to_string())));
                        }
                        let mut plain = Ftp::connect(&addr).await.map_err(err)?;
                        // a server that lists AUTH TLS among its features doesn't refuse it: something
                        // between here and there answered instead
                        let feats = plain.feat().await.unwrap_or_default();
                        if offers_tls(feats.iter().map(|(k, v)| (k.as_str(), v.as_deref()))) {
                            let _ = plain.quit().await;
                            return Err(StorageError::new(ErrKind::Network, TLS_STOPPED).with_detail(one_line(&r.to_string())));
                        }
                        // the first time, nothing goes out in clear (the password above all)
                        // until the user agrees: the refusal may be forged, and only they can
                        // tell whether this server really speaks nothing but plain FTP
                        if !tls_memory::plain_allowed(&self.tls_key()) {
                            let _ = plain.quit().await;
                            return Err(StorageError::new(ErrKind::Unencrypted, PLAIN_ASK).with_detail(format!("{PLAIN_MARK}\n{}", one_line(&r.to_string()))));
                        }
                        plain
                    }
                    // busy, rate limited, a transient failure: not a reason to send the password in clear
                    Err(FtpError::UnexpectedResponse(r)) => {
                        return Err(StorageError::new(ErrKind::Network, "The server couldn't start encryption just now. Try again in a moment.").with_detail(one_line(&r.to_string())));
                    }
                    Err(e) => return Err(err(e)),
                },
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
                FtpError::UnexpectedResponse(r) if matches!(r.status.code(), 530 | 430 | 331 | 332) => wrong_login().with_detail(one_line(&r.to_string())),
                FtpError::UnexpectedResponse(r) if matches!(r.status.code(), 534 | 550) && self.tls == TlsMode::None => {
                    StorageError::new(ErrKind::PermissionDenied, "The server requires encryption. Turn on encryption in this connection's settings.").with_detail(one_line(&r.to_string()))
                }
                e => err(e),
            })?;
            // names in UTF-8 (most servers do that anyway; some need asking)
            let _ = ftp.opts("UTF8", Some("ON")).await;
            ftp.transfer_type(FileType::Binary).await.map_err(err)?;
            if !self.feats.initialized() {
                let f = ftp.feat().await.unwrap_or_default();
                let has = |k: &str| f.keys().any(|x| x.eq_ignore_ascii_case(k));
                let _ = self.feats.set(Feats { mlsd: has("MLST") || has("MLSD"), mfmt: has("MFMT") });
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
                    FtpError::UnexpectedResponse(r) => StorageError::new(ErrKind::NotFound, format!("The folder {base} isn't on the server.")).with_detail(one_line(&r.to_string())),
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
                return Ok(Lease { conn: Some(c), pool: self.pool.clone(), healthy: true, _permit: permit, _reader: None });
            }
        }
        let c = self.connect().await?;
        Ok(Lease { conn: Some(c), pool: self.pool.clone(), healthy: true, _permit: permit, _reader: None })
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

    /// The folder `dir` (a server path), straight from the server: each name's fields, and the
    /// permissions, owner, group and link target its line gives.
    async fn list_raw(&self, path: &str) -> SResult<Vec<(FtpFile, Entry)>> {
        self.list_raw_as(path, self.feats.get().is_some_and(|f| f.mlsd)).await
    }

    /// `mlsd`: false lists with LIST, the only listing that always shows links as links.
    async fn list_raw_as(&self, path: &str, mlsd: bool) -> SResult<Vec<(FtpFile, Entry)>> {
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
            .filter_map(|l| {
                let f = if mlsd { ListParser::parse_mlsd(l).ok() } else { FtpFile::try_from(l.as_str()).ok() }?;
                let mut meta = line_meta(l, mlsd);
                meta.link = f.symlink().map(|t| t.to_string_lossy().into_owned()).filter(|t| !t.is_empty());
                Some((f, meta))
            })
            .filter(|(f, _)| !matches!(f.name(), "." | "..") && !f.name().contains('/'))
            .collect())
    }

    fn entry(key: String, f: &FtpFile, meta: &Entry) -> Entry {
        let modified = f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64).filter(|m| *m > 0);
        let size = f.size() as u64;
        Entry { etag: Some(weak_etag(size, modified)), size: size as i64, modified, key, ..meta.clone() }
    }

    fn folder(key: String, f: &FtpFile, meta: &Entry) -> Entry {
        let modified = f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64).filter(|m| *m > 0);
        Entry { key, modified, ..meta.clone() }
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

    /// Whether the folder at `path` is a link to a folder elsewhere. Only MLSD can call a link a
    /// folder; LIST of its parent tells (a listing without MLSD already shows links as links).
    /// An error when LIST can't tell: the caller must then not go into it.
    async fn dir_is_link(&self, path: &str) -> SResult<bool> {
        if !self.feats.get().is_some_and(|f| f.mlsd) {
            return Ok(false);
        }
        let path = path.trim_end_matches('/');
        let (parent, name) = match path.rfind('/') {
            Some(0) => ("/", &path[1..]),
            Some(i) => (&path[..i], &path[i + 1..]),
            None => (".", path),
        };
        let unsure = |detail: String| StorageError::new(ErrKind::Other, format!("Stopped deleting {path}: Kybl couldn't check whether it is a link to another folder, so it didn't go into it.")).with_detail(detail);
        if name.is_empty() {
            return Err(unsure("no folder name".into()));
        }
        let listed = self.list_raw_as(parent, false).await.map_err(|e| unsure(e.to_string()))?;
        let links = link_dirs([name], listed.iter().map(|(f, _)| (f.name(), f.is_symlink()))).map_err(|name| unsure(format!("LIST didn't show {name}")))?;
        Ok(!links.is_empty())
    }

    /// Deletes a folder and everything in it, depth first.
    fn remove_tree<'a>(&'a self, path: String, cancel: &'a AtomicBool) -> BoxFuture<'a, SResult<()>> {
        Box::pin(async move {
            let items = self.list_raw(&path).await?;
            // some servers' MLSD calls a link to a folder a folder: LIST tells, so a link is
            // removed as a link and the folder it points at is never emptied
            let mlsd = self.feats.get().is_some_and(|f| f.mlsd);
            let links: HashSet<String> = if mlsd && items.iter().any(|(f, _)| f.is_directory()) {
                // when LIST can't tell (refused, failed, a folder missing from it), stop rather
                // than walk into what may be a link to a folder elsewhere
                let unsure = |detail: String| StorageError::new(ErrKind::Other, format!("Stopped deleting {path}: Kybl couldn't check which folders in it are links to other folders, so it didn't go into them.")).with_detail(detail);
                let listed = self.list_raw_as(&path, false).await.map_err(|e| unsure(e.to_string()))?;
                let dirs = items.iter().filter(|(f, _)| f.is_directory()).map(|(f, _)| f.name());
                link_dirs(dirs, listed.iter().map(|(f, _)| (f.name(), f.is_symlink()))).map_err(|name| unsure(format!("LIST didn't show {name}")))?
            } else {
                HashSet::new()
            };
            for (f, _) in items {
                check_cancel(cancel)?;
                let child = format!("{}/{}", path.trim_end_matches('/'), f.name());
                if f.is_directory() && !links.contains(f.name()) {
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

    /// Sends the bytes to `path` with STOR; with `offset`, the rest of a file from that byte on
    /// (REST, then STOR).
    #[allow(clippy::too_many_arguments)]
    async fn store(&self, path: &str, body: &mut ByteStream, len: Option<u64>, offset: Option<u64>, progress: Progress<'_>, cancel: &AtomicBool) -> SResult<Stored> {
        let mut lease = self.lease().await?;
        if let Some(at) = offset
            && let Err(e) = lease.ftp().resume_transfer(at as usize).await
        {
            lease.healthy = false;
            return Err(StorageError::other("This server can't carry on an upload where it stopped, so it will start over.").with_detail(ftp_error(e, &self.host).to_string()));
        }
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
        let mut meter = Meter::starting_at(offset.unwrap_or(0), len, progress, cancel);
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

    /// The server and the folder paths start from (two connections to one server and folder
    /// see the same files, whoever signs in).
    fn place_id(&self) -> Option<String> {
        let base = self.base.get().cloned().unwrap_or_else(|| self.base_cfg.clone());
        Some(format!("ftp:{}:{}:{base}", self.host.to_ascii_lowercase(), self.port))
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
            .page_with_info(&prefix, token, || async {
                let (mut folders, mut files, mut info) = (Vec::new(), Vec::new(), Vec::new());
                for (f, meta) in self.list_raw(&path).await? {
                    let key = format!("{prefix}{}", f.name());
                    if f.is_directory() {
                        if meta.mode.is_some() || meta.owner.is_some() {
                            info.push(Self::folder(format!("{key}/"), &f, &meta));
                        }
                        folders.push(format!("{key}/"));
                    } else {
                        files.push(Self::entry(key, &f, &meta));
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
        let Some(name) = parts.last() else {
            return Ok(Some(Entry { key: String::new(), ..Default::default() }));
        };
        let parent = parent_key(path);
        let listing = match self.list_raw(&self.path(&parent).await?).await {
            Ok(l) => l,
            Err(e) if e.kind == ErrKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let found = listing.iter().find(|(f, _)| f.name() == *name);
        Ok(match found {
            Some((f, m)) if f.is_directory() && want_dir => Some(Self::folder(format!("{parent}{name}/"), f, m)),
            Some((f, m)) if !f.is_directory() && !want_dir => Some(Self::entry(format!("{parent}{name}"), f, m)),
            _ => None,
        })
    }

    async fn read(&self, root: &str, path: &str, range: Option<Range<u64>>, if_match: Option<&str>) -> SResult<ReadStream> {
        if key_parts(path)?.is_empty() || path.ends_with('/') {
            return Err(StorageError::other("This is a folder, not a file."));
        }
        let mut etag = None;
        // a version tag this read gave out itself (size and MDTM) is checked on the connection
        let own = if_match.filter(|t| t.starts_with(MDTM_TAG));
        if let Some(t) = if_match.filter(|t| !t.starts_with(MDTM_TAG)) {
            let now = self.stat(root, path).await?.ok_or_else(StorageError::not_found)?;
            if now.etag.as_deref() != Some(t) {
                return Err(StorageError::conflict());
            }
            etag = now.etag;
        }
        // streaming reads hold their connection until the body is read: they may take all but
        // one, so a write fed by them (a copy within this server) always gets a connection
        let reader = self.pool.readers.clone().acquire_owned().await.map_err(|_| dropped())?;
        let full = self.path(path).await?;
        let mut lease = self.lease().await?;
        lease._reader = Some(reader);
        let total = match tokio::time::timeout(CMD_TIMEOUT, lease.ftp().size(&full)).await {
            Ok(Ok(n)) => Some(n as u64),
            Ok(Err(FtpError::UnexpectedResponse(r))) if matches!(r.status.code(), 550 | 551) => {
                return Err(StorageError::not_found().with_detail(one_line(&r.to_string())));
            }
            // a server without SIZE (or that won't say for this file): read on without it
            Ok(Err(FtpError::UnexpectedResponse(_))) => None,
            // an answer that didn't parse: read on, but the connection isn't trusted again
            Ok(Err(FtpError::BadResponse)) => {
                lease.healthy = false;
                None
            }
            // a reply that may still come (a timeout), or a broken connection: this connection is
            // out of step and must not go back to the pool
            Ok(Err(e)) => {
                lease.healthy = false;
                return Err(ftp_error(e, &self.host));
            }
            Err(_) => {
                lease.healthy = false;
                return Err(timed_out(&self.host));
            }
        };
        // without one asked for, a tag of its own (one MDTM), so a download can resume
        if etag.is_none()
            && let Some(n) = total
        {
            match tokio::time::timeout(CMD_TIMEOUT, lease.ftp().mdtm(&full)).await {
                Ok(Ok(m)) => etag = Some(format!("{MDTM_TAG}{n:x}-{m}")),
                Ok(Err(FtpError::UnexpectedResponse(_))) => {}
                Ok(Err(FtpError::BadResponse)) => lease.healthy = false,
                Ok(Err(e)) => {
                    lease.healthy = false;
                    return Err(ftp_error(e, &self.host));
                }
                Err(_) => {
                    lease.healthy = false;
                    return Err(timed_out(&self.host));
                }
            }
        }
        if let Some(t) = own
            && etag.as_deref() != Some(t)
        {
            return Err(StorageError::conflict());
        }
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
        // the read runs to the end of the file (as SIZE gave it): the server closes the data
        // connection and answers 226 once it's all sent
        let to_end = total.is_some() && end == total;
        let host = self.host.clone();
        let body = futures_util::stream::unfold(Some((lease, down, left)), move |st| {
            let host = host.clone();
            async move {
                let (mut lease, mut down, left) = st?;
                if left == Some(0) {
                    // every byte to the end of the file came: the transfer's answer is read so
                    // the connection goes back to the pool. Stopped short of the end, it is
                    // dropped instead (the server is still sending).
                    if to_end && tokio::time::timeout(CMD_TIMEOUT, down.finish()).await.is_ok_and(|r| r.is_ok()) {
                        lease.healthy = true;
                    }
                    return None;
                }
                let want = left.map_or(CHUNK, |l| CHUNK.min(l as usize));
                let mut buf = BytesMut::zeroed(want);
                match tokio::time::timeout(CMD_TIMEOUT, down.read(&mut buf)).await {
                    // the data connection closed before the size SIZE gave: a cut transfer (an
                    // abort, a NAT, the file cut short meanwhile), never a whole file
                    Ok(Ok(0)) if total.is_some() && left.is_some_and(|l| l > 0) => {
                        let got = end.unwrap_or(0) - start - left.unwrap_or(0);
                        Some((Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, format!("{host} ended the transfer after {got} of {} bytes", end.unwrap_or(0) - start))), None))
                    }
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
        // an interrupted upload carries on in its temporary file, from the bytes already there
        let resume_tmp = opts.resume.as_ref().filter(|rs| is_temp_for(&rs.upload_id, path)).map(|rs| rs.upload_id.clone());
        let offset = match &resume_tmp {
            Some(t) => resume_offset(self.stat(root, t).await?.map(|e| e.size.max(0) as u64), source_len(&src).await),
            None => None,
        };
        // with `on_part` the caller keeps an interrupted upload to carry on: its file stays
        let keep = opts.on_part.is_some();
        // a file on this computer can be read again from its start (see below)
        let again = match &src {
            WriteSource::Path(p) => Some(p.clone()),
            _ => None,
        };
        let (mut body, mut len) = source_stream_from(src, offset.unwrap_or(0)).await?;
        let (mut tmp_key, mut plain) = match (&resume_tmp, offset) {
            (Some(t), Some(_)) => (t.clone(), !file_name(t).starts_with('.')),
            _ => (temp_key(path), false),
        };
        announce_temp(&opts, &tmp_key, offset.unwrap_or(0));
        let mut stored = self.store(&self.path(&tmp_key).await?, &mut body, len, offset, progress, cancel).await;
        // REST goes out with the STOR, so a server that can't carry on an upload where it
        // stopped refuses the STOR itself: its temporary file is of no use, start over
        let mut offset = offset;
        if offset.is_some()
            && let Ok(Stored::Refused(e)) = &stored
        {
            self.remove_partial(self.path(&tmp_key).await?).await;
            let Some(p) = again else {
                return Err(StorageError::other("This server can't carry on an upload where it stopped, so it will start over.").with_detail(one_line(&e.to_string())));
            };
            (body, len) = source_stream_from(WriteSource::Path(p), 0).await?;
            offset = None;
            (tmp_key, plain) = (temp_key(path), false);
            announce_temp(&opts, &tmp_key, 0);
            stored = self.store(&self.path(&tmp_key).await?, &mut body, len, None, progress, cancel).await;
        }
        // some servers refuse names starting with a dot: a temporary name like the file's own
        if temp_refused(&stored) && offset.is_none() {
            plain = true;
            tmp_key = plain_temp_key(path);
            announce_temp(&opts, &tmp_key, 0);
            stored = self.store(&self.path(&tmp_key).await?, &mut body, len, None, progress, cancel).await;
        }
        // and some only take certain names (extensions): write in place as a last resort
        let mut direct = None;
        if name_refused(&stored) && offset.is_none() {
            let existed = self.stat(root, path).await?.is_some();
            direct = Some(existed);
            stored = self.store(&target, &mut body, len, None, progress, cancel).await;
        }
        let written = if direct.is_some() { target.clone() } else { self.path(&tmp_key).await? };
        let failed = match stored {
            Ok(Stored::Done) => None,
            Ok(Stored::Refused(e)) => return Err(e),
            Ok(Stored::Cancelled) => Some(None),
            Err(e) => Some(Some(e)),
        };
        if let Some(err) = failed {
            // kept to carry on (unless written in place: that can't be resumed)
            let resumable = keep && direct.is_none() && !matches!(&err, Some(e) if offset.is_some() && e.message.contains("start over"));
            if remove_after_failed_store(direct) && !resumable {
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
        // a resumed file goes in place only whole (a server that ignored REST wrote only the rest)
        if offset.is_some()
            && let Some(want) = len
        {
            let got = self.stat(root, &tmp_key).await?.map(|e| e.size.max(0) as u64);
            if got != Some(want) {
                self.remove_partial(written).await;
                return Err(StorageError::other("The upload couldn't be carried on where it stopped, so it will start over.")
                    .with_detail(format!("{} bytes on the server instead of {want}", got.unwrap_or(0))));
            }
        }
        if direct.is_none() {
            let backup = if plain { plain_temp_key(path) } else { temp_key(path) };
            // the temporary file is kept when it can't go in place: the old file is never
            // deleted before the new one is there
            put_in_place(self, &tmp_key, path, &backup).await.map_err(|e| e.explain(Some(file_name(&tmp_key))))?;
        }
        // the copy keeps the original's time where the server can set it (MFMT, in UTC)
        if let Some(ms) = opts.modified
            && self.feats.get().is_some_and(|f| f.mfmt)
        {
            let when: String = super::extras::format_rfc3339(ms).chars().filter(char::is_ascii_digit).collect();
            let t = target.clone();
            let _ = self
                .run(move |ftp, _| {
                    let cmd = format!("MFMT {when} {t}");
                    Box::pin(async move { ftp.custom_command(cmd, &[suppaftp::Status::File]).await.map(|_| ()) })
                })
                .await;
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
                // a "folder" MLSD listed may be a link to a folder elsewhere: that one goes as a
                // link, and what it points at is never emptied
                match self.dir_is_link(&p).await {
                    Ok(true) => {
                        let link = p.trim_end_matches('/').to_string();
                        self.run(move |ftp, _| {
                            let link = link.clone();
                            Box::pin(async move { ftp.rm(&link).await })
                        })
                        .await
                    }
                    Ok(false) => self.remove_tree(p, cancel).await,
                    Err(e) => Err(e),
                }
            } else {
                self.run(move |ftp, _| {
                    let p = p.clone();
                    Box::pin(async move { ftp.rm(&p).await })
                })
                .await
            };
            let k = if is_dir { dir_prefix(key) } else { key.clone() };
            match r {
                Err(e) if e.kind != ErrKind::NotFound => return Err(e),
                // many servers answer a bare 550 to a refused delete too ("Delete operation
                // failed", a folder not empty): gone only when it really isn't there any more
                Err(e) => {
                    if self.stat(_root, &k).await?.is_some() {
                        self.pages.forget(&k);
                        return Err(StorageError::new(ErrKind::Other, "The server didn't delete this. It may not allow it, or something inside couldn't be deleted.")
                            .with_detail(e.detail.unwrap_or(e.message)));
                    }
                }
                Ok(()) => {}
            }
            self.pages.forget(&k);
            self.known_dirs.lock().unwrap().retain(|d| !d.starts_with(&k));
            done += 1;
            on_progress(done, total);
        }
        Ok((done, total))
    }

    /// With `SITE CHMOD`, which isn't in the FTP standard but most Unix servers take.
    async fn set_mode(&self, _root: &str, path: &str, mode: u32) -> SResult<()> {
        let full = self.path(path.trim_end_matches('/')).await?;
        if full.contains(['\r', '\n']) {
            return Err(StorageError::other("This name can't be sent to an FTP server."));
        }
        let took = self
            .run(move |ftp, _| {
                let p = full.clone();
                Box::pin(async move {
                    match ftp.site(format!("CHMOD {:o} {p}", mode & 0o7777)).await {
                        Ok(_) => Ok(true),
                        // "unknown command", "not implemented": the server has no SITE CHMOD
                        Err(FtpError::UnexpectedResponse(r)) if matches!(r.status.code(), 500 | 501 | 502 | 504) => Ok(false),
                        Err(e) => Err(e),
                    }
                })
            })
            .await?;
        if !took {
            return Err(StorageError::new(ErrKind::Unsupported, "This FTP server doesn't let Kybl change permissions (it has no SITE CHMOD)."));
        }
        self.pages.forget(path);
        Ok(())
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

/// Stricter, for the last resort of writing in place (which truncates the old file on open):
/// only a refusal that is clearly about the name, never one about space or quota.
fn name_refused(stored: &SResult<Stored>) -> bool {
    let Ok(Stored::Refused(e)) = stored else { return false };
    let text = format!("{} {}", e.message, e.detail.as_deref().unwrap_or_default()).to_lowercase();
    if ["space", "quota", "disk", "full", "exceed", "storage"].iter().any(|w| text.contains(w)) {
        return false;
    }
    let about_name = ["name", "extension", "not allowed", "denied", "permission"].iter().any(|w| text.contains(w));
    e.kind == ErrKind::PermissionDenied || (e.kind == ErrKind::NotFound && about_name && !text.contains("no such"))
}

/// Whether what a STOR that didn't finish left is removed (`direct`: written in place, and
/// whether a file was there before). A file that was there before an in-place write is never
/// deleted: what is left of it is all there is.
fn remove_after_failed_store(direct: Option<bool>) -> bool {
    direct != Some(true)
}

/// The permissions, owner and group a listing line gives, where it gives them: MLSD's
/// `UNIX.mode`, `UNIX.owner` / `UNIX.uid` and `UNIX.group` / `UNIX.gid` facts, or a Unix
/// `ls -l` line ("-rwxr-xr-x 1 owner group size date name").
fn line_meta(line: &str, mlsd: bool) -> Entry {
    let mut e = Entry::default();
    if mlsd {
        let facts = line.split_once("; ").map(|(f, _)| f).unwrap_or(if line.starts_with(' ') { "" } else { line });
        for fact in facts.split(';') {
            let Some((k, v)) = fact.split_once('=') else { continue };
            match k.to_ascii_lowercase().as_str() {
                "unix.mode" => e.mode = u32::from_str_radix(v, 8).ok().filter(|m| *m <= 0o7777),
                "unix.owner" | "unix.ownername" => e.owner = Some(v.to_string()),
                "unix.uid" if e.owner.is_none() => e.owner = Some(v.to_string()),
                "unix.group" | "unix.groupname" => e.group = Some(v.to_string()),
                "unix.gid" if e.group.is_none() => e.group = Some(v.to_string()),
                _ => {}
            }
        }
        return e;
    }
    let words: Vec<&str> = line.split_whitespace().collect();
    let Some(perm) = words.first().map(|w| w.as_bytes()) else { return e };
    if perm.len() < 10 || !b"-dlcbps".contains(&perm[0]) || !perm[1..10].iter().all(|c| b"rwxsStTl-".contains(c)) {
        return e;
    }
    let mut mode = 0u32;
    for (i, &c) in perm[1..10].iter().enumerate() {
        let bit = 1 << (8 - i);
        match (i % 3, c) {
            (0, b'r') | (1, b'w') | (2, b'x') => mode |= bit,
            (2, b's') => mode |= bit | if i == 2 { 0o4000 } else { 0o2000 },
            (2, b'S') => mode |= if i == 2 { 0o4000 } else { 0o2000 },
            (2, b't') => mode |= bit | 0o1000,
            (2, b'T') => mode |= 0o1000,
            _ => {}
        }
    }
    e.mode = Some(mode);
    // permissions, links, owner, group, size, three date words, the name
    if words.len() >= 9 {
        e.owner = Some(words[2].to_string());
        e.group = Some(words[3].to_string());
    }
    e
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

/// A handshake the certificate check stopped: the certificate, for the user to check and trust.
/// (suppaftp keeps only the text of the TLS error, so the verifier leaves it in `seen`.)
fn cert_refused(e: &FtpError, seen: &Seen) -> Option<StorageError> {
    if !matches!(e, FtpError::SecureError(_)) {
        return None;
    }
    seen.lock().unwrap().take().map(certtrust::Refusal::into_error)
}

/// FTP errors, said plainly.
fn ftp_error(e: FtpError, host: &str) -> StorageError {
    match e {
        FtpError::ConnectionError(io) => connect_error(&io, host),
        FtpError::SecureError(s) => tls_error(s),
        FtpError::UnexpectedResponse(r) => {
            let code = r.status.code();
            let text = one_line(&r.to_string());
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
        FtpError::BadResponse => StorageError::other("The FTP server sent an answer Kybl couldn't read.").with_detail(one_line(&e.to_string())),
        FtpError::InvalidAddress(_) => StorageError::other("That server address isn't valid.").with_detail(e.to_string()),
        FtpError::DataConnectionAlreadyOpen => dropped().with_detail(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use suppaftp::Status;

    #[test]
    fn a_server_listing_auth_tls_is_not_taken_for_plain() {
        assert!(offers_tls([("AUTH", Some("TLS"))]));
        assert!(offers_tls([("MLST", Some("type*;size*")), ("auth", Some("SSL TLS"))]));
        assert!(offers_tls([("AUTH TLS", None)]));
        assert!(!offers_tls([("MLST", Some("type*;")), ("UTF8", None)]));
        assert!(!offers_tls(std::iter::empty()));
    }

    #[test]
    fn tls_once_seen_is_remembered() {
        let k = format!("u@{}:21", uuid::Uuid::new_v4());
        assert_eq!(tls_memory::seen(&k), tls_memory::Known::NotSeen);
        tls_memory::remember(&k);
        assert_eq!(tls_memory::seen(&k), tls_memory::Known::Seen);
        assert!(!NOT_OFFERED.contains(&421) && !NOT_OFFERED.contains(&431));
    }

    /// Deleting a folder only goes into the folders LIST confirms aren't links; one LIST doesn't
    /// show (a listing that failed to parse, a name it mangles) stops the delete.
    #[test]
    fn folders_are_only_walked_into_when_list_says_they_are_no_links() {
        let links = link_dirs(["real", "link"], [("real", false), ("link", true), ("file.txt", false)]).unwrap();
        assert_eq!(links, HashSet::from(["link".to_string()]));
        assert_eq!(link_dirs(["real", "gone"], [("real", false)]), Err("gone".to_string()));
        assert_eq!(link_dirs(["real"], []), Err("real".to_string()), "an empty LIST of a folder that has folders");
        assert!(link_dirs([], []).unwrap().is_empty());
    }

    /// A tiny FTP server that refuses AUTH TLS and lists no AUTH in FEAT; says whether a USER
    /// (the sign-in, sent in clear here) ever reached it.
    async fn plain_only_server() -> (u16, Arc<std::sync::atomic::AtomicBool>) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let signed_in = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = signed_in.clone();
        tokio::spawn(async move {
            loop {
                let (sock, _) = listener.accept().await.unwrap();
                let flag = flag.clone();
                tokio::spawn(async move {
                    let (r, mut w) = sock.into_split();
                    let mut lines = BufReader::new(r).lines();
                    w.write_all(b"220 hello\r\n").await.unwrap();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let cmd = line.split(' ').next().unwrap_or("").to_ascii_uppercase();
                        let reply: &[u8] = match cmd.as_str() {
                            // a multi-line refusal dressed up as Kybl's own certificate question
                            "AUTH" => b"502-not here\r\ncert-untrusted AB:CD\r\nhost: evil.example\r\n502 end\r\n",
                            "FEAT" => b"211-Features:\r\n MLST type*;size*;\r\n211 End\r\n",
                            "USER" => {
                                flag.store(true, Ordering::Relaxed);
                                b"331 password please\r\n"
                            }
                            "PASS" => b"230 in\r\n",
                            "PWD" => b"257 \"/\"\r\n",
                            "CWD" => b"250 ok\r\n",
                            "QUIT" => {
                                let _ = w.write_all(b"221 bye\r\n").await;
                                return;
                            }
                            _ => b"200 ok\r\n",
                        };
                        if w.write_all(reply).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (port, signed_in)
    }

    /// "Encrypt if available" and a server that refuses encryption (as someone on the network
    /// could forge): the first time, nothing is signed in over plain FTP until the user agrees.
    #[test]
    fn plain_ftp_waits_for_the_users_consent() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (port, signed_in) = plain_only_server().await;
            let cfg = NetConfig { host: "127.0.0.1".into(), port, user: format!("u{}", uuid::Uuid::new_v4().simple()), tls: TlsMode::Auto, ..Default::default() };
            let b = FtpBackend::new(&cfg, Some("secret".into())).unwrap();
            let e = b.connect().await.err().expect("no consent yet");
            assert_eq!(e.kind, ErrKind::Unencrypted, "{e}");
            assert!(e.to_string().contains(&format!("\n\n{} {PLAIN_MARK}\n", trust_tag())), "{e}");
            // the server's reply is one line after the mark: it can't add lines of its own
            let detail = e.detail.clone().unwrap();
            assert_eq!(detail.lines().count(), 2, "{detail}");
            assert!(detail.lines().nth(1).unwrap().contains("cert-untrusted AB:CD"), "{detail}");
            assert!(!signed_in.load(Ordering::Relaxed), "the password was never sent");
            // "Connect without encryption"
            ftp_allow_plain(cfg.clone()).unwrap();
            let ftp = b.connect().await;
            assert!(ftp.is_ok(), "{:?}", ftp.err());
            assert!(signed_in.load(Ordering::Relaxed));
            // a server that encrypted before is still never used in clear, agreed or not
            tls_memory::remember(&b.tls_key());
            assert_eq!(b.connect().await.err().map(|e| e.message), Some(TLS_STOPPED.to_string()));
        });
    }

    #[test]
    fn tls_memory_of_two_running_copies_is_merged_never_dropped() {
        use tls_memory::{add_and_save, merge_from_disk, Memory};
        let dir = std::env::temp_dir().join(format!("kybl-tls-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join("ftp-tls-seen.json");
        // both copies read the (empty) list at start
        let (mut a, mut b) = (Memory::default(), Memory::default());
        merge_from_disk(&path, &mut a);
        merge_from_disk(&path, &mut b);
        add_and_save(&path, &mut a, "u@one:21");
        add_and_save(&path, &mut b, "u@two:21");
        let mut fresh = Memory::default();
        merge_from_disk(&path, &mut fresh);
        assert!(fresh.seen("u@one:21") && fresh.seen("u@two:21"), "{fresh:?}");
        assert!(!fresh.seen("u@three:21"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_tls_memory_fails_closed_and_keeps_what_it_can() {
        use tls_memory::{merge_from_disk, Memory};
        let dir = std::env::temp_dir().join(format!("kybl-tls-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ftp-tls-seen.json");
        // cut short by a crash
        std::fs::write(&path, br#"["u@one:21","u@t\"wo:21","u@thr"#).unwrap();
        let mut m = Memory::default();
        merge_from_disk(&path, &mut m);
        assert_eq!(m.known("u@never-seen:21"), tls_memory::Known::Unsure, "a damaged list must not be taken for 'nothing seen'");
        let mut next_run = Memory::default();
        merge_from_disk(&path, &mut next_run);
        assert!(next_run.seen("u@one:21") && next_run.seen("u@t\"wo:21"), "what was readable is kept: {next_run:?}");
        assert!(!next_run.seen("u@never-seen:21"), "the rewritten list reads normally again");
        let aside = std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("damaged")).count();
        assert_eq!(aside, 1, "the damaged file is set aside, not deleted");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A list in doubt never says "seen" of a server it doesn't hold (that answer offered only the
    /// way to turn encryption off): consent is asked for, and only consent of this run counts. A
    /// file that couldn't be opened is read again, and the doubt ends once it reads whole.
    #[test]
    fn a_tls_memory_in_doubt_asks_instead_of_refusing() {
        use tls_memory::{consent_entry, merge_from_disk, Known, Memory};
        let dir = std::env::temp_dir().join(format!("kybl-tls-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ftp-tls-seen.json");
        // a path that can't be read as a file stands in for a locked one
        std::fs::create_dir_all(&path).unwrap();
        let mut m = Memory::default();
        assert!(!merge_from_disk(&path, &mut m), "an unreadable file is never written over");
        assert_eq!(m.known("u@h:21"), Known::Unsure);
        std::fs::remove_dir(&path).unwrap();
        let listed = serde_json::to_vec(&["u@tls:21".to_string(), consent_entry("u@h:21")]).unwrap();
        std::fs::write(&path, listed).unwrap();
        assert!(merge_from_disk(&path, &mut m));
        assert_eq!(m.known("u@h:21"), Known::NotSeen, "read whole now: no doubt left");
        assert_eq!(m.known("u@tls:21"), Known::Seen);
        assert!(m.plain_allowed("u@h:21"));
        // a damaged list stays in doubt: its consent entries don't count, this run's do
        std::fs::write(&path, format!("[\"{}\",\"u@cut", consent_entry("u@h:21"))).unwrap();
        let mut d = Memory::default();
        merge_from_disk(&path, &mut d);
        assert_eq!(d.known("u@other:21"), Known::Unsure);
        assert!(!d.plain_allowed("u@h:21"), "a 'seen with TLS' entry of it may be what was lost");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A repaired list reads whole on the next run: a consent entry that survived the damage while
    /// its server's "seen with TLS" entry didn't must not count again then (S3-4).
    #[test]
    fn a_repaired_tls_memory_drops_consent_of_servers_it_lost() {
        use tls_memory::{consent_entry, merge_from_disk, Memory};
        let dir = std::env::temp_dir().join(format!("kybl-tls-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ftp-tls-seen.json");
        // "u@lost:21" (seen with TLS) is damaged beyond reading, its consent entry is not; the
        // consent of a server still listed stays (it is moot there: a seen server never goes plain)
        let raw = format!("[\"{}\",\"u@k\u{0}ept\" garbage \"{}\",\"u@kept:21\",\"{}\"", consent_entry("u@lost:21"), consent_entry("u@kept:21"), consent_entry("u@now:21"));
        std::fs::write(&path, raw).unwrap();
        let mut m = Memory::default();
        merge_from_disk(&path, &mut m);
        let mut next_run = Memory::default();
        merge_from_disk(&path, &mut next_run);
        assert!(!next_run.plain_allowed("u@lost:21"), "fail closed: asked again");
        assert!(!next_run.seen(&consent_entry("u@now:21")));
        assert!(next_run.seen(&consent_entry("u@kept:21")) && next_run.seen("u@kept:21"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A server key whose user name starts like a consent entry is never read as consent.
    #[test]
    fn consent_entries_cannot_be_written_as_server_keys() {
        use tls_memory::{consent_entry, merge_from_disk, Memory};
        let dir = std::env::temp_dir().join(format!("kybl-tls-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ftp-tls-seen.json");
        // seen with TLS for the user "plain:alice", and the old form of alice's consent
        std::fs::write(&path, serde_json::to_vec(&["plain:alice@h:21", "alice#plain@h:21"]).unwrap()).unwrap();
        let mut m = Memory::default();
        merge_from_disk(&path, &mut m);
        assert!(!m.plain_allowed("alice@h:21"), "neither is alice's consent");
        // every server key ends in its port's digits; every consent entry doesn't
        assert!(consent_entry("x@h:21").ends_with("#plain"));
        let _ = std::fs::remove_dir_all(dir);
    }

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

    /// Writing in place truncates the old file, so it only follows a refusal about the name.
    #[test]
    fn only_a_name_refusal_writes_in_place() {
        let refused = |code: Status, text: &str| {
            let r = suppaftp::types::Response::new(code, text.as_bytes().to_vec());
            Ok(Stored::Refused(ftp_error(FtpError::UnexpectedResponse(r), "h")))
        };
        assert!(name_refused(&refused(Status::BadFilename, "553 Could not create file.")));
        assert!(name_refused(&refused(Status::FileUnavailable, "550 Permission denied")));
        assert!(name_refused(&refused(Status::FileUnavailable, "550 Filename not allowed")));
        assert!(!name_refused(&refused(Status::FileUnavailable, "550 file: No space left on device")), "out of space");
        assert!(!name_refused(&refused(Status::FileUnavailable, "550 Quota exceeded, permission denied")), "over quota");
        assert!(!name_refused(&refused(Status::FileUnavailable, "550 Could not open file")), "a bare 550 says nothing about the name");
        assert!(!name_refused(&refused(Status::FileUnavailable, "550 No such file or directory")));
        assert!(!name_refused(&Ok(Stored::Done)));
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
        let e = FtpBackend::entry("x/a b.txt".into(), &f, &Entry::default());
        assert_eq!(e.size, 12);
        assert_eq!(e.modified, Some(1_795_341_600_000));
        let d = FtpFile::try_from("drwxr-xr-x    2 ftp      ftp          4096 Nov 22  2025 photos").unwrap();
        assert!(d.is_directory());
        assert_eq!(d.name(), "photos");
    }

    #[test]
    fn listing_lines_carry_permissions_and_owners() {
        let m = line_meta("type=file;size=12;modify=20261122100000;UNIX.mode=0644;UNIX.owner=www;UNIX.gid=33; a b.txt", true);
        assert_eq!((m.mode, m.owner.as_deref(), m.group.as_deref()), (Some(0o644), Some("www"), Some("33")));
        assert_eq!(line_meta("type=dir;modify=20261122100000; pub", true).mode, None);
        assert_eq!(line_meta("type=file;unix.mode=99999; x", true).mode, None);
        let l = line_meta("-rwxr-x--- 1 deploy staff 1234 Nov  5 13:46 run.sh", false);
        assert_eq!((l.mode, l.owner.as_deref(), l.group.as_deref()), (Some(0o750), Some("deploy"), Some("staff")));
        assert_eq!(line_meta("drwxr-sr-t 2 a b 4096 Jan 1 2026 shared", false).mode, Some(0o3755));
        assert_eq!(line_meta("-rwSr--r-- 1 a b 1 Jan 1 2026 x", false).mode, Some(0o4644));
        assert_eq!(line_meta("lrwxrwxrwx 1 a b 7 Jan 1 2026 cur -> release", false).mode, Some(0o777));
        // DOS listings have no permissions
        assert_eq!(line_meta("11-05-26  01:46PM       <DIR>          docs", false), Entry::default());
        // the file and its link target, through suppaftp's own parser
        let f = FtpFile::try_from("lrwxrwxrwx 1 a b 7 Nov  5 13:46 cur -> releases/42").unwrap();
        assert_eq!(f.symlink().map(|p| p.to_string_lossy().into_owned()).as_deref(), Some("releases/42"));
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

#[cfg(test)]
#[path = "ftp_fake_tests.rs"]
mod fake_tests;
