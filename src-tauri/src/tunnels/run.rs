//! Running tunnels. Each listens on 127.0.0.1 only and carries every connection it accepts over a
//! `direct-tcpip` channel of an SSH connection of its own (signed in like the connection's file
//! browsing, with its saved credentials), counting connections and bytes.
//!
//! When the SSH connection drops, the tunnel keeps its port and signs in again with a growing
//! pause (1 s up to 30 s); apps that connect meanwhile wait for it a while. Stopping one closes
//! its port, its connections and its SSH connection; quitting stops them all. The page hears of
//! every change through [`STATUS_EVENT`] (the whole list) and reads byte counts with `tunnel_list`.

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    pin::Pin,
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    task::{Context, Poll},
    time::Duration,
};

use russh::client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinSet,
    time::Instant,
};

use super::{host_port, TunnelDef};
use crate::state::{load_profiles, AppState, ConnKind, Profile};
use crate::storage::{
    registry,
    sftp::{hostkey::HostCheck, SftpBackend},
};

/// Sent with every tunnel's state ([`TunnelInfo`] list) when one starts, stops, drops, comes back
/// or gains or loses a connection.
pub const STATUS_EVENT: &str = "tunnel-status";
/// How long a connection made while the tunnel signs in again waits for it.
const WAIT_FOR_SERVER: Duration = Duration::from_secs(20);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

type Handle = Arc<client::Handle<HostCheck>>;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// listening, signed in to the server
    Up,
    /// listening, the SSH connection dropped: signing in again
    Retrying,
}

#[derive(Default)]
struct Counters {
    active: AtomicU32,
    total: AtomicU64,
    /// from apps on this computer to the far side
    sent: AtomicU64,
    received: AtomicU64,
}

struct Shared {
    counters: Counters,
    /// the phase, and what went wrong last (a refused forward, why signing in again failed)
    phase: Mutex<(Phase, Option<String>)>,
    notify: Box<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn set(&self, phase: Phase, error: Option<String>) {
        let changed = {
            let mut p = self.phase.lock().unwrap();
            let changed = *p != (phase, error.clone());
            *p = (phase, error);
            changed
        };
        if changed {
            (self.notify)();
        }
    }
    fn phase(&self) -> Phase {
        self.phase.lock().unwrap().0
    }
}

/// A started tunnel.
pub struct Running {
    profile_id: String,
    def: TunnelDef,
    /// the server and sign-in it was started with (None: not known, as in tests)
    server: Option<Server>,
    /// unix milliseconds
    started: u64,
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

/// Where and as whom a tunnel's SSH connection signs in. Another one after the connection was
/// edited means the running tunnel goes to the wrong place: it is started again.
#[derive(Clone, Debug, PartialEq)]
struct Server {
    host: String,
    port: u16,
    user: String,
    auth: crate::state::NetAuth,
}

impl Server {
    fn of(profile: &Profile) -> Option<Server> {
        let n = profile.net.as_ref()?;
        Some(Server { host: n.host.clone(), port: n.port, user: n.user.clone(), auth: n.auth })
    }
}

/// Builds the connection's backend afresh, from its saved settings and secrets, each time the
/// tunnel signs in again (a password changed since it started is the one used).
pub type Rebuild = Arc<dyn Fn() -> crate::storage::BoxFuture<'static, Result<SftpBackend, String>> + Send + Sync>;

/// A running tunnel, for the page.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub profile_id: String,
    pub tunnel_id: String,
    /// the name, or where it goes
    pub name: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub phase: Phase,
    pub error: Option<String>,
    /// connections open now, and since it started
    pub active: u32,
    pub total: u64,
    pub sent: u64,
    pub received: u64,
    pub started: u64,
}

impl Running {
    fn info(&self) -> TunnelInfo {
        let c = &self.shared.counters;
        let (phase, error) = self.shared.phase.lock().unwrap().clone();
        TunnelInfo {
            profile_id: self.profile_id.clone(),
            tunnel_id: self.def.id.clone(),
            name: self.def.label(),
            local_port: self.def.local_port,
            remote_host: self.def.remote_host.clone(),
            remote_port: self.def.remote_port,
            phase,
            error,
            active: c.active.load(Ordering::Relaxed),
            total: c.total.load(Ordering::Relaxed),
            sent: c.sent.load(Ordering::Relaxed),
            received: c.received.load(Ordering::Relaxed),
            started: self.started,
        }
    }

    /// Stops it and waits (briefly) until its port is closed.
    async fn stop(self) {
        let _ = self.stop.send(true);
        let abort = self.task.abort_handle();
        if tokio::time::timeout(Duration::from_secs(3), self.task).await.is_err() {
            abort.abort();
        }
    }
}

fn key(profile_id: &str, tunnel_id: &str) -> String {
    format!("{profile_id}\u{0}{tunnel_id}")
}

static RUNNING: LazyLock<Mutex<HashMap<String, Running>>> = LazyLock::new(Default::default);
/// Being started (signing in): a second Start waits for nothing and is refused.
static STARTING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// Started on their own in this run ("Start when the connection opens"): once only, so a tunnel
/// the user stopped stays stopped.
static AUTOSTARTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Every running tunnel, by connection then port.
pub fn list() -> Vec<TunnelInfo> {
    let mut out: Vec<TunnelInfo> = RUNNING.lock().unwrap().values().map(Running::info).collect();
    out.sort_by(|a, b| (&a.profile_id, a.local_port).cmp(&(&b.profile_id, b.local_port)));
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Why `port` on 127.0.0.1 can't be a tunnel's now, if it can't. `own` is the tunnel asking (its
/// own running listener doesn't count).
pub async fn port_problem(port: u16, own: Option<(&str, &str)>) -> Option<String> {
    if port == 0 {
        return Some("Ports are numbers from 1 to 65535.".into());
    }
    let other = RUNNING
        .lock()
        .unwrap()
        .values()
        .find(|r| r.def.local_port == port)
        .filter(|r| own.is_none_or(|(p, t)| r.profile_id != p || r.def.id != t))
        .map(|r| r.def.label());
    if let Some(name) = other {
        return Some(format!("Port {port} is in use by the tunnel “{name}”."));
    }
    if own.is_some_and(|(p, t)| RUNNING.lock().unwrap().contains_key(&key(p, t))) {
        return None;
    }
    // something answering there (another app, perhaps on all addresses) would be shadowed
    if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(("127.0.0.1", port))).await {
        return Some(format!("Something on this computer already uses port {port}."));
    }
    match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(_) => None,
        Err(e) => Some(port_error(port, &e)),
    }
}

fn port_error(port: u16, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::AddrInUse => format!("Something on this computer already uses port {port}."),
        std::io::ErrorKind::PermissionDenied => format!("This computer doesn't let apps use port {port}. Pick one above 1024."),
        _ => format!("Couldn't use port {port}: {e}"),
    }
}

/// Starts a tunnel over `backend`'s server: binds its port, signs in (an error from either is
/// returned and nothing is left open), then runs until stopped. `notify` hears of every change.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn launch(profile_id: &str, def: TunnelDef, backend: SftpBackend, notify: Box<dyn Fn() + Send + Sync>) -> Result<Running, String> {
    launch_with(profile_id, def, backend, None, notify).await
}

/// [`launch`], with `rebuild` giving the backend to sign in with again after a drop.
pub async fn launch_with(profile_id: &str, def: TunnelDef, backend: SftpBackend, rebuild: Option<Rebuild>, notify: Box<dyn Fn() + Send + Sync>) -> Result<Running, String> {
    if let Some(p) = port_problem(def.local_port, None).await {
        return Err(p);
    }
    let listener = TcpListener::bind(("127.0.0.1", def.local_port)).await.map_err(|e| port_error(def.local_port, &e))?;
    let handle = backend.sign_in_connection().await.map_err(String::from)?;
    let shared = Arc::new(Shared { counters: Counters::default(), phase: Mutex::new((Phase::Up, None)), notify });
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(supervise(listener, backend, rebuild, Arc::new(handle), def.clone(), shared.clone(), stopped));
    Ok(Running { profile_id: profile_id.to_string(), def, server: None, started: now_ms(), shared, stop, task })
}

/// Accepts connections and keeps the SSH connection up until told to stop; then closes it all.
async fn supervise(listener: TcpListener, mut backend: SftpBackend, rebuild: Option<Rebuild>, first: Handle, def: TunnelDef, shared: Arc<Shared>, mut stop: watch::Receiver<bool>) {
    let slot = Arc::new(watch::Sender::new(Some(first)));
    let mut conns = JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut backoff = Duration::from_secs(1);
    let mut next_try = Instant::now();
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            r = listener.accept() => match r {
                Ok((tcp, peer)) => {
                    let _ = tcp.set_nodelay(true);
                    conns.spawn(forward(slot.subscribe(), tcp, peer, def.remote_host.clone(), def.remote_port, shared.clone()));
                }
                // out of file handles, say: the next accept may work
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
            _ = tick.tick() => {
                let down = slot.borrow().as_ref().is_none_or(|h| h.is_closed());
                if !down {
                    continue;
                }
                if shared.phase() == Phase::Up {
                    slot.send_replace(None);
                    shared.set(Phase::Retrying, Some("The connection to the server dropped. Reconnecting…".into()));
                    backoff = Duration::from_secs(1);
                    next_try = Instant::now();
                }
                if Instant::now() < next_try {
                    continue;
                }
                // the connection's current settings and secrets (edited since it started, say)
                if let Some(rebuild) = &rebuild {
                    tokio::select! {
                        r = rebuild() => if let Ok(b) = r { backend = b },
                        _ = stop.changed() => break,
                    }
                }
                let attempt = tokio::select! {
                    r = backend.sign_in_connection() => r,
                    _ = stop.changed() => break,
                };
                match attempt {
                    Ok(h) => {
                        slot.send_replace(Some(Arc::new(h)));
                        backoff = Duration::from_secs(1);
                        shared.set(Phase::Up, None);
                    }
                    Err(e) => {
                        next_try = Instant::now() + backoff;
                        shared.set(Phase::Retrying, Some(format!("{} Trying again in {} s.", e.message, backoff.as_secs())));
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                    }
                }
            }
        }
    }
    drop(listener);
    conns.abort_all();
    while conns.join_next().await.is_some() {}
    shared.counters.active.store(0, Ordering::Relaxed);
    if let Some(h) = slot.send_replace(None) {
        let _ = tokio::time::timeout(Duration::from_secs(1), h.disconnect(russh::Disconnect::ByApplication, "", "")).await;
    }
}

/// One accepted connection, carried over a `direct-tcpip` channel to `host:port`.
async fn forward(mut slot: watch::Receiver<Option<Handle>>, tcp: TcpStream, peer: SocketAddr, host: String, port: u16, shared: Arc<Shared>) {
    let handle = match tokio::time::timeout(WAIT_FOR_SERVER, slot.wait_for(|h| h.as_ref().is_some_and(|h| !h.is_closed()))).await {
        Ok(Ok(h)) => h.clone(),
        _ => None,
    };
    let Some(handle) = handle else { return };
    let ch = match handle.channel_open_direct_tcpip(host.clone(), port as u32, peer.ip().to_string(), peer.port() as u32).await {
        Ok(ch) => ch,
        Err(e) => {
            let why = match e {
                russh::Error::ChannelOpenFailure(r) => format!("{r:?}"),
                e => e.to_string(),
            };
            let phase = shared.phase();
            shared.set(phase, Some(format!("The server couldn't connect to {} ({why}).", host_port(&host, port))));
            return;
        }
    };
    let c = &shared.counters;
    c.active.fetch_add(1, Ordering::Relaxed);
    c.total.fetch_add(1, Ordering::Relaxed);
    // a forward that works again clears an earlier refusal
    if shared.phase() == Phase::Up {
        shared.set(Phase::Up, None);
    }
    (shared.notify)();
    let mut local = Counted { inner: tcp, sent: &c.sent, received: &c.received };
    let mut remote = ch.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
    c.active.fetch_sub(1, Ordering::Relaxed);
    (shared.notify)();
}

/// A local connection that counts the bytes read from it (sent through the tunnel) and written
/// to it (received).
struct Counted<'a> {
    inner: TcpStream,
    sent: &'a AtomicU64,
    received: &'a AtomicU64,
}

impl AsyncRead for Counted<'_> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let me = self.get_mut();
        let before = buf.filled().len();
        let r = Pin::new(&mut me.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = r {
            me.sent.fetch_add((buf.filled().len() - before) as u64, Ordering::Relaxed);
        }
        r
    }
}

impl AsyncWrite for Counted<'_> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        let me = self.get_mut();
        let r = Pin::new(&mut me.inner).poll_write(cx, data);
        if let Poll::Ready(Ok(n)) = r {
            me.received.fetch_add(n as u64, Ordering::Relaxed);
        }
        r
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

// ---------------------------------------------------------------- the app's side

fn emit_all<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(STATUS_EVENT, list());
}

fn find_def(profile: &Profile, tunnel_id: &str) -> Result<TunnelDef, String> {
    if profile.kind != ConnKind::Sftp {
        return Err("Tunnels run over SFTP (SSH) connections.".into());
    }
    profile
        .net
        .as_ref()
        .and_then(|n| n.tunnels.iter().find(|t| t.id == tunnel_id))
        .cloned()
        .ok_or_else(|| "This tunnel isn't in the connection any more.".into())
}

/// Starts tunnel `tunnel_id` of connection `profile_id` (already running: as it is).
pub async fn start<R: Runtime>(app: &AppHandle<R>, state: &AppState, profile_id: &str, tunnel_id: &str) -> Result<TunnelInfo, String> {
    let k = key(profile_id, tunnel_id);
    if let Some(r) = RUNNING.lock().unwrap().get(&k) {
        return Ok(r.info());
    }
    if !STARTING.lock().unwrap().insert(k.clone()) {
        return Err("This tunnel is starting.".into());
    }
    let result = async {
        let profile = load_profiles(app)?.into_iter().find(|p| p.id == profile_id).ok_or("Connection not found")?;
        let def = find_def(&profile, tunnel_id)?;
        super::check(&def)?;
        let backend = registry::sftp_for(app, state, profile_id).await?;
        let notify_app = app.clone();
        let (a, pid) = (app.clone(), profile_id.to_string());
        let rebuild: Rebuild = Arc::new(move || {
            let (a, pid) = (a.clone(), pid.clone());
            Box::pin(async move { registry::sftp_for(&a, &a.state::<AppState>(), &pid).await })
        });
        let mut running = launch_with(profile_id, def, backend, Some(rebuild), Box::new(move || emit_all(&notify_app))).await?;
        running.server = Server::of(&profile);
        Ok::<_, String>(running)
    }
    .await;
    STARTING.lock().unwrap().remove(&k);
    let running = result?;
    let info = running.info();
    RUNNING.lock().unwrap().insert(k, running);
    emit_all(app);
    Ok(info)
}

/// Stops a tunnel; false when it wasn't running.
pub async fn stop<R: Runtime>(app: &AppHandle<R>, profile_id: &str, tunnel_id: &str) -> bool {
    let r = RUNNING.lock().unwrap().remove(&key(profile_id, tunnel_id));
    let Some(r) = r else { return false };
    r.stop().await;
    emit_all(app);
    true
}

/// Quitting: every tunnel stops, its port closed.
pub async fn shutdown() {
    let all: Vec<Running> = RUNNING.lock().unwrap().drain().map(|(_, r)| r).collect();
    futures_util::future::join_all(all.into_iter().map(Running::stop)).await;
}

/// What a running tunnel does after its connection was saved.
#[derive(Debug, PartialEq)]
enum AfterSave {
    /// carries on (a new name is taken over)
    Keep,
    /// its definition is gone or goes elsewhere now
    Stop,
    /// the connection now signs in elsewhere (another host, port, user or way of signing in):
    /// it starts again over the new one
    Restart,
}

fn after_save(r: &Running, defs: Option<&[TunnelDef]>, server: Option<&Server>) -> AfterSave {
    match defs.and_then(|d| d.iter().find(|d| d.id == r.def.id)) {
        Some(d) if d.same_route(&r.def) => {
            if r.server.is_some() && r.server.as_ref() != server {
                AfterSave::Restart
            } else {
                AfterSave::Keep
            }
        }
        _ => AfterSave::Stop,
    }
}

/// A connection was saved (`Some`) or deleted (`None`): running tunnels that are gone or now go
/// elsewhere stop, ones whose connection now signs in elsewhere start again over it, renamed ones
/// carry on under the new name.
pub fn connection_changed<R: Runtime>(app: &AppHandle<R>, profile_id: &str, profile: Option<&Profile>) {
    let defs = profile.map(|p| p.net.as_ref().map(|n| n.tunnels.as_slice()).unwrap_or_default());
    let server = profile.and_then(Server::of);
    let (mut gone, mut again) = (vec![], vec![]);
    {
        let mut all = RUNNING.lock().unwrap();
        for r in all.values_mut().filter(|r| r.profile_id == profile_id) {
            match after_save(r, defs, server.as_ref()) {
                AfterSave::Keep => {
                    if let Some(d) = defs.and_then(|d| d.iter().find(|d| d.id == r.def.id)) {
                        r.def = d.clone();
                    }
                }
                AfterSave::Stop => gone.push(key(profile_id, &r.def.id)),
                AfterSave::Restart => {
                    gone.push(key(profile_id, &r.def.id));
                    again.push((r.def.id.clone(), r.def.label()));
                }
            }
        }
        let stopping: Vec<Running> = gone.iter().filter_map(|k| all.remove(k)).collect();
        if !stopping.is_empty() {
            let app = app.clone();
            let pid = profile_id.to_string();
            tauri::async_runtime::spawn(async move {
                futures_util::future::join_all(stopping.into_iter().map(Running::stop)).await;
                emit_all(&app);
                for (tid, name) in again {
                    let state = app.state::<AppState>();
                    if let Err(e) = start(&app, &state, &pid, &tid).await {
                        let _ = app.emit("tunnel-error", TunnelError { profile_id: pid.clone(), tunnel_id: tid, name, error: e });
                    }
                }
            });
        }
    }
    if defs.is_none() {
        AUTOSTARTED.lock().unwrap().retain(|k| !k.starts_with(&format!("{profile_id}\u{0}")));
    }
    emit_all(app);
}

/// The connection was opened (its backend built): its "Start when the connection opens" tunnels
/// start, each once per run. Failures are reported through [`STATUS_EVENT`]'s companion
/// `tunnel-error` event, as nobody waits on them.
pub fn autostart<R: Runtime>(app: &AppHandle<R>, profile: &Profile) {
    if profile.kind != ConnKind::Sftp {
        return;
    }
    let Some(net) = &profile.net else { return };
    for d in net.tunnels.iter().filter(|d| d.auto_start) {
        if !AUTOSTARTED.lock().unwrap().insert(key(&profile.id, &d.id)) {
            continue;
        }
        let (app, pid, tid, name) = (app.clone(), profile.id.clone(), d.id.clone(), d.label());
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if let Err(e) = start(&app, &state, &pid, &tid).await {
                let _ = app.emit("tunnel-error", TunnelError { profile_id: pid, tunnel_id: tid, name, error: e });
            }
        });
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TunnelError {
    profile_id: String,
    tunnel_id: String,
    name: String,
    error: String,
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn tunnel_list() -> Vec<TunnelInfo> {
    list()
}

#[tauri::command]
pub async fn tunnel_start<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, profile_id: String, tunnel_id: String) -> Result<TunnelInfo, String> {
    start(&app, &state, &profile_id, &tunnel_id).await
}

#[tauri::command]
pub async fn tunnel_stop<R: Runtime>(app: AppHandle<R>, profile_id: String, tunnel_id: String) -> Result<bool, String> {
    Ok(stop(&app, &profile_id, &tunnel_id).await)
}

/// The connection form's check of a local port: why it can't be used, or None.
#[tauri::command]
pub async fn tunnel_port_check(port: u16, profile_id: Option<String>, tunnel_id: Option<String>) -> Option<String> {
    let own = profile_id.as_deref().zip(tunnel_id.as_deref());
    port_problem(port, own).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::NetConfig;
    use crate::storage::net::Secrets;
    use russh::keys::{ssh_key::private::Ed25519Keypair, HashAlg, PrivateKey};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// An SSH server that forwards `direct-tcpip` channels to the address asked for (only
    /// 127.0.0.1 here), like sshd with AllowTcpForwarding, and refuses everything else.
    struct Forwarder;

    impl russh::server::Handler for Forwarder {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, password: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if password == "pw" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            host: &str,
            port: u32,
            _from: &str,
            _from_port: u32,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            let target = if host == "127.0.0.1" { TcpStream::connect((host, port as u16)).await.ok() } else { None };
            let Some(mut tcp) = target else {
                // dropping the reply refuses the channel
                return Ok(());
            };
            reply.accept().await;
            tokio::spawn(async move {
                let mut s = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut s, &mut tcp).await;
            });
            Ok(())
        }
    }

    /// The server on a free port, and its key's fingerprint. Dropping the returned sender stops
    /// it accepting (the sessions it has keep going until `kill` is set).
    async fn ssh_server() -> (u16, String, Arc<std::sync::atomic::AtomicBool>, tokio::task::JoinHandle<()>) {
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[7; 32]));
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(russh::server::Config { keys: vec![key], auth_rejection_time: Duration::from_millis(10), ..Default::default() });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let kill = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let k = kill.clone();
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                // while "down", new sign-ins are refused too: otherwise a reconnect could land
                // between two checks and the test would never see the tunnel retrying
                if k.load(Ordering::SeqCst) {
                    drop(tcp);
                    continue;
                }
                let (config, k) = (config.clone(), k.clone());
                tokio::spawn(async move {
                    let Ok(session) = russh::server::run_stream(config, tcp, Forwarder).await else { return };
                    let handle = session.handle();
                    let mut session = std::pin::pin!(session);
                    loop {
                        tokio::select! {
                            _ = &mut session => break,
                            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                                if k.load(Ordering::SeqCst) {
                                    let _ = handle.disconnect(russh::Disconnect::ByApplication, "bye".into(), "".into()).await;
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        (port, fp, kill, task)
    }

    /// A TCP server that sends back what it gets.
    async fn echo_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        port
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn backend(port: u16, fp: &str, pw: &str) -> SftpBackend {
        let cfg = NetConfig { host: "127.0.0.1".into(), port, user: "me".into(), host_key: Some(fp.into()), ..Default::default() };
        SftpBackend::new(&cfg, Secrets { password: Some(pw.into()), ssh: None }).unwrap()
    }

    async fn round_trip(port: u16, msg: &[u8]) -> Vec<u8> {
        let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        c.write_all(msg).await.unwrap();
        let mut got = vec![0; msg.len()];
        tokio::time::timeout(Duration::from_secs(10), c.read_exact(&mut got)).await.expect("no echo").unwrap();
        got
    }

    async fn until(what: &str, f: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(15);
        while !f() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[test]
    fn bytes_round_trip_through_the_tunnel_and_it_comes_back_after_a_drop() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (ssh_port, fp, kill, _srv) = ssh_server().await;
            let echo = echo_server().await;
            let local = free_port();
            let def = TunnelDef { id: "t".into(), local_port: local, remote_host: "127.0.0.1".into(), remote_port: echo, ..Default::default() };
            let notes = Arc::new(AtomicU32::new(0));
            let n = notes.clone();
            let r = launch("p", def.clone(), backend(ssh_port, &fp, "pw"), Box::new(move || {
                n.fetch_add(1, Ordering::Relaxed);
            }))
            .await
            .unwrap();

            // bytes go there and back, counted
            let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
            assert_eq!(round_trip(local, b"hello tunnel").await, b"hello tunnel");
            assert_eq!(round_trip(local, &big).await, big);
            until("the connections to close", || r.info().active == 0).await;
            let i = r.info();
            assert_eq!((i.total, i.phase), (2, Phase::Up));
            assert_eq!(i.sent, 12 + 200_000);
            assert_eq!(i.received, 12 + 200_000);
            assert!(notes.load(Ordering::Relaxed) >= 4, "opened and closed twice");

            // the port is taken now, for another tunnel and for the form's check
            assert!(port_problem(local, None).await.unwrap().contains(&local.to_string()));
            assert!(launch("p", TunnelDef { id: "u".into(), ..def.clone() }, backend(ssh_port, &fp, "pw"), Box::new(|| {})).await.is_err());

            // the server drops every session: the tunnel notices and signs in again
            kill.store(true, Ordering::SeqCst);
            until("the drop to be noticed", || r.info().phase == Phase::Retrying).await;
            kill.store(false, Ordering::SeqCst);
            until("the tunnel to come back", || r.info().phase == Phase::Up).await;
            assert_eq!(round_trip(local, b"again").await, b"again");

            // a target the server can't reach: the app's connection closes, the tunnel says why
            let r2 = launch(
                "p",
                TunnelDef { id: "x".into(), local_port: free_port(), remote_host: "db.internal".into(), remote_port: 5432, ..Default::default() },
                backend(ssh_port, &fp, "pw"),
                Box::new(|| {}),
            )
            .await
            .unwrap();
            let mut c = TcpStream::connect(("127.0.0.1", r2.def.local_port)).await.unwrap();
            let mut buf = [0u8; 1];
            assert_eq!(tokio::time::timeout(Duration::from_secs(10), c.read(&mut buf)).await.unwrap().unwrap_or(0), 0);
            until("the refusal to show", || r2.info().error.is_some()).await;
            assert!(r2.info().error.unwrap().contains("db.internal:5432"));
            r2.stop().await;

            // stopping frees the port at once
            r.stop().await;
            assert!(TcpStream::connect(("127.0.0.1", local)).await.is_err());
            assert_eq!(port_problem(local, None).await, None);
        });
    }

    #[test]
    fn a_wrong_password_or_a_taken_port_leaves_nothing_open() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (ssh_port, fp, _kill, _srv) = ssh_server().await;
            let local = free_port();
            let def = TunnelDef { id: "t".into(), local_port: local, remote_host: "127.0.0.1".into(), remote_port: 1, ..Default::default() };
            assert!(launch("p", def.clone(), backend(ssh_port, &fp, "wrong"), Box::new(|| {})).await.is_err());
            assert_eq!(port_problem(local, None).await, None, "the port was let go");

            let held = TcpListener::bind(("127.0.0.1", local)).await.unwrap();
            let e = launch("p", def, backend(ssh_port, &fp, "pw"), Box::new(|| {})).await.err().unwrap();
            assert!(e.contains("already uses port"), "{e}");
            drop(held);
        });
    }

    /// After a drop the tunnel signs in with the connection as it is saved now (the server
    /// moved, the password changed), not with the backend it started with.
    #[test]
    fn signing_in_again_uses_the_connection_as_saved_now() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (old_port, fp, old_kill, _old) = ssh_server().await;
            let (new_port, fp2, _new_kill, _new) = ssh_server().await;
            let echo = echo_server().await;
            let local = free_port();
            let def = TunnelDef { id: "t".into(), local_port: local, remote_host: "127.0.0.1".into(), remote_port: echo, ..Default::default() };
            let rebuilds = Arc::new(AtomicU32::new(0));
            let n = rebuilds.clone();
            let rebuild: Rebuild = Arc::new(move || {
                n.fetch_add(1, Ordering::Relaxed);
                let b = backend(new_port, &fp2, "pw");
                Box::pin(async move { Ok(b) })
            });
            let r = launch_with("p", def, backend(old_port, &fp, "pw"), Some(rebuild), Box::new(|| {})).await.unwrap();
            assert_eq!(round_trip(local, b"one").await, b"one");
            // the old server goes away for good
            old_kill.store(true, Ordering::SeqCst);
            until("the drop to be noticed", || r.info().phase == Phase::Retrying || rebuilds.load(Ordering::Relaxed) > 0).await;
            until("the tunnel to come back over the new server", || r.info().phase == Phase::Up && rebuilds.load(Ordering::Relaxed) > 0).await;
            assert_eq!(round_trip(local, b"two").await, b"two");
            r.stop().await;
        });
    }

    #[test]
    fn a_saved_connection_keeps_stops_or_restarts_its_tunnels() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let server = Server { host: "a.example".into(), port: 22, user: "me".into(), auth: crate::state::NetAuth::Password };
            let def = TunnelDef { id: "t".into(), local_port: 5433, remote_host: "db".into(), remote_port: 5432, ..Default::default() };
            let (stop, _) = watch::channel(false);
            let shared = Arc::new(Shared { counters: Counters::default(), phase: Mutex::new((Phase::Up, None)), notify: Box::new(|| {}) });
            let r = Running { profile_id: "p".into(), def: def.clone(), server: Some(server.clone()), started: 0, shared, stop, task: tokio::spawn(async {}) };
            let renamed = [TunnelDef { name: "db".into(), ..def.clone() }];
            assert_eq!(after_save(&r, Some(&renamed), Some(&server)), AfterSave::Keep);
            let moved = [TunnelDef { remote_port: 6543, ..def.clone() }];
            assert_eq!(after_save(&r, Some(&moved), Some(&server)), AfterSave::Stop);
            assert_eq!(after_save(&r, Some(&[]), Some(&server)), AfterSave::Stop);
            assert_eq!(after_save(&r, None, None), AfterSave::Stop);
            for other in [
                Server { host: "b.example".into(), ..server.clone() },
                Server { port: 2222, ..server.clone() },
                Server { user: "deploy".into(), ..server.clone() },
                Server { auth: crate::state::NetAuth::Key, ..server.clone() },
            ] {
                assert_eq!(after_save(&r, Some(&renamed), Some(&other)), AfterSave::Restart, "{other:?}");
            }
        });
    }
}
