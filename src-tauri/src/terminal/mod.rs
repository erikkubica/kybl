//! Terminal panes: a shell on this computer (a pseudo-terminal running the user's login shell in
//! the pane's folder) or on an SFTP connection's server (an SSH session channel with a
//! pseudo-terminal, signed in with the connection's credentials, `cd`-ing into the folder).
//!
//! The page opens one with `terminal_open`, handing over a Channel: output comes back on it in
//! batches as raw bytes ([`batch`]), and a last JSON message `{"exit": code}` when the shell ends.
//! Input, size changes and acknowledgements of drawn output are commands. Closing the pane, a
//! reload of the page or its window going away ends the shell and frees everything.
//!
//! Nothing a terminal shows or is sent is ever logged.

mod batch;
#[cfg(unix)]
mod pty;

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, LazyLock, Mutex,
    },
};

#[cfg(unix)]
use std::time::Duration;

use serde::Serialize;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Runtime, State, Webview,
};
use tokio::sync::{mpsc, oneshot};

use self::batch::Credit;
use crate::state::AppState;
use crate::storage::registry::{self, LOCAL_ID};

enum Cmd {
    Write(Vec<u8>),
    Resize(u16, u16),
    /// whether a program other than the shell has the terminal (a local shell answers; SSH can't)
    Busy(oneshot::Sender<bool>),
}

struct Session {
    /// the web view the terminal is drawn in
    label: String,
    cmds: mpsc::UnboundedSender<Cmd>,
    credit: Arc<Credit>,
    task: tokio::task::AbortHandle,
    /// an SSH session: the server doesn't say whether a program runs in it
    remote: bool,
}

static SESSIONS: LazyLock<Mutex<HashMap<u32, Session>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
/// Bumped for a web view each time its page (re)loads: a terminal still connecting from the page
/// before is dropped instead of kept for nobody.
static PAGE_GEN: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);

fn page_gen(label: &str) -> u64 {
    PAGE_GEN.lock().unwrap().get(label).copied().unwrap_or(0)
}

/// How many terminals web view `label` has open (a window hidden to the tray keeps them).
pub fn count_for(label: &str) -> usize {
    SESSIONS.lock().unwrap().values().filter(|s| s.label == label).count()
}

/// How long a local shell may take to say whether a program runs in it.
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

/// How many terminals hold something that quitting would end: a local one with a program in the
/// foreground (or one that doesn't answer in time: when in doubt, busy), and every open SSH one
/// (the server can't say what runs there, and closing it ends the program).
pub async fn busy_sessions() -> usize {
    let asks: Vec<(bool, mpsc::UnboundedSender<Cmd>)> =
        SESSIONS.lock().unwrap().values().map(|s| (s.remote, s.cmds.clone())).collect();
    let mut n = 0;
    for (remote, cmds) in asks {
        if remote {
            n += 1;
            continue;
        }
        let (tx, rx) = oneshot::channel();
        if cmds.send(Cmd::Busy(tx)).is_err() {
            continue;
        }
        // a shell that already ended (its sender dropped) isn't running anything
        match tokio::time::timeout(BUSY_WAIT, rx).await {
            Ok(Ok(true)) | Err(_) => n += 1,
            _ => {}
        }
    }
    n
}

/// Ends every terminal of web view `label`: its page is loading anew, or it is gone.
pub fn close_for(label: &str) {
    *PAGE_GEN.lock().unwrap().entry(label.to_string()).or_default() += 1;
    let gone: Vec<Session> = {
        let mut all = SESSIONS.lock().unwrap();
        let ids: Vec<u32> = all.iter().filter(|(_, s)| s.label == label).map(|(id, _)| *id).collect();
        ids.into_iter().filter_map(|id| all.remove(&id)).collect()
    };
    for s in gone {
        s.task.abort();
        s.credit.close();
    }
}

fn close(id: u32) {
    let s = SESSIONS.lock().unwrap().remove(&id);
    if let Some(s) = s {
        s.task.abort();
        s.credit.close();
    }
}

/// Characters a word may hold and still need no quotes in any shell.
fn plain(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_-./+:@%,=".contains(c)
}

/// `s` as one word for any shell (bash, zsh, sh, fish, csh): as it is when it is plain, otherwise
/// quoted as [`crate::actions::quote`] does (quotes and backslashes outside the single quotes).
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(plain) {
        return s.to_string();
    }
    crate::actions::quote(s)
}

pub(crate) const FILES_ONLY: &str = "This account is for file transfers only: the server gives it no shell, so a terminal can't open here.";

/// The line typed into a fresh remote shell to go to folder `dir` (absolute, "~" or "~/…"), with
/// a space in front so shells that skip such lines keep it out of their history. None when there
/// is nothing to do (the home folder) or `dir` holds control characters, which typing would act on.
pub fn cd_line(dir: &str) -> Option<String> {
    if dir.is_empty() || dir == "~" || dir.chars().any(char::is_control) {
        return None;
    }
    Some(match dir.strip_prefix("~/") {
        // the ~ stays outside the quotes, so the shell still expands it
        Some(rest) => format!(" cd ~/{}", shell_quote(rest)),
        None => format!(" cd {}", shell_quote(dir)),
    })
}

/// The `cd` line for a fresh shell on `backend`'s server, only when its login shell is known to
/// read the quoting as Kybl writes it (POSIX shells, fish, csh; asked once per server, see
/// storage/sftp/command.rs). On cmd.exe or PowerShell (Windows OpenSSH) a folder name such as
/// `x&calc&y` would run as a command, so nothing is typed there, nor when the server doesn't say.
pub(crate) async fn remote_cd(backend: &crate::storage::sftp::SftpBackend, dir: &str) -> Option<String> {
    use crate::storage::sftp::command::{for_csh, Shell};
    let line = cd_line(dir)?;
    match tokio::time::timeout(Duration::from_secs(10), backend.login_shell()).await {
        Ok(Ok(Shell::Posix)) => Some(line),
        Ok(Ok(Shell::Csh)) => Some(for_csh(&line)),
        _ => None,
    }
}

/// LANG for a shell: the app's own, or on a Mac one made from the system's region (an app started
/// from the Dock has none), when the system has that locale; else a UTF-8 default.
fn lang() -> String {
    static LANG: LazyLock<String> = LazyLock::new(|| {
        if let Some(l) = std::env::var("LANG").ok().filter(|l| !l.is_empty()) {
            return l;
        }
        #[cfg(target_os = "macos")]
        {
            let out = std::process::Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLocale"]).output();
            if let Some(loc) = out.ok().and_then(|o| String::from_utf8(o.stdout).ok()) {
                let loc = loc.trim().split('@').next().unwrap_or("").to_string();
                let name = format!("{loc}.UTF-8");
                if !loc.is_empty() && std::path::Path::new("/usr/share/locale").join(&name).exists() {
                    return name;
                }
            }
            "en_US.UTF-8".into()
        }
        #[cfg(not(target_os = "macos"))]
        "C.UTF-8".into()
    });
    LANG.clone()
}

/// The user's login shell: $SHELL, else the account's shell, else the system's default.
#[cfg(unix)]
fn login_shell() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Some(s) = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_absolute() && p.exists()) {
        return s;
    }
    let from_account = unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            None
        } else {
            std::ffi::CStr::from_ptr((*pw).pw_shell).to_str().ok().map(PathBuf::from)
        }
    };
    if let Some(s) = from_account.filter(|p| p.is_absolute() && p.exists()) {
        return s;
    }
    if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    id: u32,
    /// SFTP: where the connection's folder is on the server ("/var/www", "~", "~/site"), so the
    /// page can write the path of a dropped file; None on this computer
    remote_base: Option<String>,
}

/// Starts a shell in folder `prefix` of root `bucket` of connection `profile_id` (This Mac or an
/// SFTP connection), on a terminal of `cols` × `rows`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn terminal_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    webview: Webview<R>,
    profile_id: String,
    bucket: String,
    prefix: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<TermInfo, String> {
    let label = webview.label().to_string();
    let page = page_gen(&label);
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::channel(batch::QUEUE);
    let (exit_tx, exit_rx) = oneshot::channel();
    let mut remote_base = None;

    let task = if profile_id == LOCAL_ID {
        open_local(&app, &state, &bucket, &prefix, cols, rows, cmd_rx, out_tx, exit_tx).await?
    } else {
        let backend = registry::sftp_for(&app, &state, &profile_id).await?;
        // an account for file transfers only has no shell: say so, rather than open a "terminal"
        // that is the SFTP server, silent until the first key ends it
        if let Ok(Ok(crate::storage::sftp::command::Shell::FilesOnly)) = tokio::time::timeout(Duration::from_secs(10), backend.login_shell()).await {
            return Err(FILES_ONLY.into());
        }
        let base = backend.shell_dir("")?;
        let dir = backend.shell_dir(&prefix)?;
        let cd = remote_cd(&backend, &dir).await;
        let (handle, ch) = backend.open_shell(cols as u32, rows as u32, Some(&lang())).await?;
        remote_base = Some(base);
        tokio::spawn(run_ssh(handle, ch, cd, cmd_rx, out_tx, exit_tx)).abort_handle()
    };

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let credit = Arc::new(Credit::default());
    {
        let mut all = SESSIONS.lock().unwrap();
        // the page reloaded while this was connecting: nobody is left to show it
        if page_gen(&label) != page {
            task.abort();
            return Err("The page reloaded.".into());
        }
        all.insert(id, Session { label, cmds: cmd_tx, credit: credit.clone(), task, remote: remote_base.is_some() });
    }
    tokio::spawn(async move {
        batch::pump(out_rx, credit, batch::WINDOW, batch::MAX_BATCH, |b| on_output.send(InvokeResponseBody::Raw(b)).is_ok()).await;
        // the shell ended (not closed by the page): say how
        if let Ok(code) = exit_rx.await {
            let _ = on_output.send(InvokeResponseBody::Json(serde_json::json!({ "exit": code }).to_string()));
        }
        close(id);
    });
    Ok(TermInfo { id, remote_base })
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
async fn open_local<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    bucket: &str,
    prefix: &str,
    cols: u16,
    rows: u16,
    cmds: mpsc::UnboundedReceiver<Cmd>,
    out: mpsc::Sender<Vec<u8>>,
    exit: oneshot::Sender<Option<i32>>,
) -> Result<tokio::task::AbortHandle, String> {
    let disk = registry::open(app, state, LOCAL_ID).await?;
    let cwd = disk
        .local_path(bucket, prefix)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::var_os("HOME").map(Into::into))
        .unwrap_or_else(|| "/".into());
    let shell = login_shell();
    let env = [("TERM", "xterm-256color".to_string()), ("COLORTERM", "truecolor".to_string()), ("LANG", lang()), ("TERM_PROGRAM", "Kybl".to_string())];
    let (pty, ev) = pty::Pty::spawn(&shell, &[std::ffi::OsStr::new("-l")], &cwd, &env, cols, rows, batch::QUEUE).map_err(|e| format!("Couldn't start {}. {e}", shell.display()))?;
    Ok(tokio::spawn(run_pty(pty, ev, cmds, out, exit)).abort_handle())
}

#[cfg(not(unix))]
#[allow(clippy::too_many_arguments)]
async fn open_local<R: Runtime>(
    _app: &AppHandle<R>,
    _state: &AppState,
    _bucket: &str,
    _prefix: &str,
    _cols: u16,
    _rows: u16,
    _cmds: mpsc::UnboundedReceiver<Cmd>,
    _out: mpsc::Sender<Vec<u8>>,
    _exit: oneshot::Sender<Option<i32>>,
) -> Result<tokio::task::AbortHandle, String> {
    Err("Terminals on this computer aren't available on this system yet. SFTP connections can open one.".into())
}

/// A local shell's life: input and size changes in, and once it ends, a moment for the last of its
/// output before the terminal stops being read (a job left in the background may keep it open).
#[cfg(unix)]
async fn run_pty(mut pty: pty::Pty, ev: pty::PtyEvents, mut cmds: mpsc::UnboundedReceiver<Cmd>, out: mpsc::Sender<Vec<u8>>, exit: oneshot::Sender<Option<i32>>) {
    let pty::PtyEvents { output: mut from_pty, exit: mut ended } = ev;
    // the reader's chunks go on to the pump through here, so this task sees when they stop
    let progress = Arc::new(Progress::default());
    let p = progress.clone();
    let mut forward = tokio::spawn(async move {
        while let Some(c) = from_pty.recv().await {
            p.sending.store(true, Ordering::SeqCst);
            let sent = out.send(c).await;
            p.sending.store(false, Ordering::SeqCst);
            if sent.is_err() {
                break;
            }
            p.moved.fetch_add(1, Ordering::SeqCst);
        }
    });
    let _stop = AbortOnDrop(forward.abort_handle());
    loop {
        tokio::select! {
            c = cmds.recv() => match c {
                Some(Cmd::Write(b)) => pty.write(b),
                Some(Cmd::Resize(c, r)) => pty.resize(c, r),
                Some(Cmd::Busy(tx)) => {
                    let _ = tx.send(pty.busy());
                }
                None => return,
            },
            code = &mut ended => {
                // (`forward` ends once the terminal has no more output)
                let drained = drain(&mut forward, &progress, DRAIN_QUIET, DRAIN_STUCK).await;
                if !drained {
                    pty.stop_reading();
                }
                let _ = exit.send(code.ok().flatten());
                return;
            }
        }
    }
}

/// How the forwarder of a local shell's output is getting on.
#[cfg(unix)]
#[derive(Default)]
struct Progress {
    /// chunks handed on to the page so far
    moved: std::sync::atomic::AtomicU64,
    /// waiting for the page to take a chunk (it is behind)
    sending: std::sync::atomic::AtomicBool,
}

/// After the shell ended: nothing more for this long, and nothing waiting for the page, means a
/// job left in the background holds the terminal open.
#[cfg(unix)]
const DRAIN_QUIET: Duration = Duration::from_millis(300);
/// The page took nothing for this long while output waited for it: given up on.
#[cfg(unix)]
const DRAIN_STUCK: Duration = Duration::from_secs(5);
/// At most this long in all (a background job that keeps printing).
#[cfg(unix)]
const DRAIN_MAX: Duration = Duration::from_secs(30);

/// Waits for the forwarder to hand on the last of the output: as long as it keeps going, or the
/// page is still taking chunks (a long `cat` at the end), not a fixed moment. True when it ended.
#[cfg(unix)]
async fn drain(forward: &mut tokio::task::JoinHandle<()>, progress: &Progress, quiet: Duration, stuck: Duration) -> bool {
    let mut last = progress.moved.load(Ordering::SeqCst);
    let mut idle = Duration::ZERO;
    let end = tokio::time::Instant::now() + DRAIN_MAX;
    loop {
        if tokio::time::Instant::now() >= end {
            return false;
        }
        if tokio::time::timeout(quiet, &mut *forward).await.is_ok() {
            return true;
        }
        let now = progress.moved.load(Ordering::SeqCst);
        if now != last {
            last = now;
            idle = Duration::ZERO;
            continue;
        }
        idle += quiet;
        if !progress.sending.load(Ordering::SeqCst) || idle >= stuck {
            return false;
        }
    }
}

struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A remote shell's life: its output out, input and size changes in, until the server closes the
/// channel (the shell ended) or the connection drops.
async fn run_ssh(
    handle: russh::client::Handle<crate::storage::sftp::hostkey::HostCheck>,
    ch: russh::Channel<russh::client::Msg>,
    cd: Option<String>,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
    out: mpsc::Sender<Vec<u8>>,
    exit: oneshot::Sender<Option<i32>>,
) {
    use russh::ChannelMsg;
    let (mut rd, wr) = ch.split();
    if let Some(line) = cd {
        let _ = wr.data_bytes(format!("{line}\r").into_bytes()).await;
    }
    let mut code = None;
    loop {
        tokio::select! {
            m = rd.wait() => match m {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if out.send(data.to_vec()).await.is_err() {
                        break;
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
            c = cmds.recv() => match c {
                Some(Cmd::Write(b)) => {
                    if wr.data_bytes(b).await.is_err() {
                        break;
                    }
                }
                Some(Cmd::Resize(c, r)) => {
                    let _ = wr.window_change(c as u32, r as u32, 0, 0).await;
                }
                // the server doesn't say what runs in the shell: not known (the page goes by the prompt)
                Some(Cmd::Busy(_)) => {}
                None => break,
            },
        }
    }
    drop(out);
    let _ = exit.send(code);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), handle.disconnect(russh::Disconnect::ByApplication, "", "")).await;
}

fn session<T>(id: u32, f: impl FnOnce(&Session) -> T) -> Option<T> {
    SESSIONS.lock().unwrap().get(&id).map(f)
}

/// Typed input (`binary`: one byte per character, xterm.js's legacy mouse reports).
#[tauri::command]
pub fn terminal_write(id: u32, data: String, binary: Option<bool>) {
    let bytes = if binary == Some(true) { data.chars().map(|c| c as u32 as u8).collect() } else { data.into_bytes() };
    session(id, |s| s.cmds.send(Cmd::Write(bytes)));
}

#[tauri::command]
pub fn terminal_resize(id: u32, cols: u16, rows: u16) {
    session(id, |s| s.cmds.send(Cmd::Resize(cols.max(1), rows.max(1))));
}

/// The page drew `bytes` more of the output (flow control, see [`batch`]).
#[tauri::command]
pub fn terminal_ack(id: u32, bytes: u32) {
    session(id, |s| s.credit.ack(bytes as usize));
}

/// Whether a program runs in the terminal's foreground (a terminal pane following its folder
/// types `cd` only into a shell at rest): None over SSH, where it can't be told.
#[tauri::command]
pub async fn terminal_busy(id: u32) -> Option<bool> {
    let (tx, rx) = oneshot::channel();
    session(id, |s| s.cmds.send(Cmd::Busy(tx)).ok())??;
    rx.await.ok()
}

/// The pane closed: the shell ends.
#[tauri::command]
pub fn terminal_close(id: u32) {
    close(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell that ended while the page was behind: its last output still goes out, as long as
    /// the page keeps taking it; a terminal held open by a quiet background job is let go soon.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_last_output_waits_for_a_slow_page() {
        let (out, mut page) = mpsc::channel::<u32>(1);
        let progress = Arc::new(Progress::default());
        let p = progress.clone();
        // 20 chunks are left, and the page takes one every 50 ms (1 s in all, past the quiet time)
        let mut forward = tokio::spawn(async move {
            for c in 0..20 {
                p.sending.store(true, Ordering::SeqCst);
                let sent = out.send(c).await;
                p.sending.store(false, Ordering::SeqCst);
                if sent.is_err() {
                    break;
                }
                p.moved.fetch_add(1, Ordering::SeqCst);
            }
        });
        let reader = tokio::spawn(async move {
            let mut got = vec![];
            while let Some(c) = page.recv().await {
                got.push(c);
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            got
        });
        assert!(drain(&mut forward, &progress, Duration::from_millis(100), Duration::from_secs(5)).await);
        assert_eq!(reader.await.unwrap(), (0..20).collect::<Vec<_>>());

        // nothing to hand on, and nothing coming (a background job keeps the terminal open)
        let idle = Arc::new(Progress::default());
        let mut held = tokio::spawn(std::future::pending::<()>());
        let t = std::time::Instant::now();
        assert!(!drain(&mut held, &idle, Duration::from_millis(100), Duration::from_secs(5)).await);
        assert!(t.elapsed() < Duration::from_secs(1));
        held.abort();
    }

    #[test]
    fn plain_words_stay_as_they_are() {
        assert_eq!(shell_quote("/var/www/site-1.2"), "/var/www/site-1.2");
        assert_eq!(shell_quote("a+b@c:d,e=f%g"), "a+b@c:d,e=f%g");
    }

    #[test]
    fn anything_else_is_single_quoted() {
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("My Files"), "'My Files'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("$(rm -rf ~); `x` \"y\" *?[a] !h"), "'$(rm -rf ~); `x` \"y\" *?[a] !h'");
        assert_eq!(shell_quote("~/x"), "'~/x'");
        assert_eq!(shell_quote("ünï"), "'ünï'");
    }

    #[test]
    fn cd_line_goes_to_absolute_and_home_folders() {
        assert_eq!(cd_line("/var/www").as_deref(), Some(" cd /var/www"));
        assert_eq!(cd_line("/srv/My Site's").as_deref(), Some(r" cd '/srv/My Site'\''s'"));
        // the tilde is left for the shell to expand
        assert_eq!(cd_line("~/www/a b").as_deref(), Some(" cd ~/'www/a b'"));
        assert_eq!(cd_line("~/www").as_deref(), Some(" cd ~/www"));
    }

    #[test]
    fn cd_line_skips_home_and_refuses_control_characters() {
        assert_eq!(cd_line("~"), None);
        assert_eq!(cd_line(""), None);
        assert_eq!(cd_line("/tmp/a\nrm -rf ~"), None);
        assert_eq!(cd_line("/tmp/a\rb"), None);
        assert_eq!(cd_line("/tmp/\x1b[31m"), None);
    }

    /// An SSH server whose "shell" answers each typed line with `ran:<line>`, reports size changes
    /// and ends with status 7 on `exit`.
    struct FakeShell {
        line: String,
        channels: Vec<russh::Channel<russh::server::Msg>>,
        /// what an exec channel prints (the login shell probe's answer)
        probe: &'static str,
    }

    /// A [`FakeShell`] server on a free port, answering the shell probe with `probe`: (port, host key fingerprint).
    async fn fake_server(probe: &'static str) -> (u16, String) {
        use russh::keys::{ssh_key::private::Ed25519Keypair, HashAlg, PrivateKey};
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[9; 32]));
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(russh::server::Config { keys: vec![key], auth_rejection_time: Duration::from_millis(10), ..Default::default() });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let config = config.clone();
                tokio::spawn(async move {
                    if let Ok(s) = russh::server::run_stream(config, tcp, FakeShell { line: String::new(), channels: vec![], probe }).await {
                        let _ = s.await;
                    }
                });
            }
        });
        (port, fp)
    }

    impl russh::server::Handler for FakeShell {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.channels.push(channel);
            reply.accept().await;
            Ok(())
        }

        /// SFTP (the connection the shell probe runs on), answering every stat with a folder
        #[cfg(unix)]
        async fn subsystem_request(&mut self, id: russh::ChannelId, name: &str, session: &mut russh::server::Session) -> Result<(), Self::Error> {
            match (self.channels.iter().position(|c| c.id() == id), name) {
                (Some(i), "sftp") => {
                    let ch = self.channels.remove(i);
                    session.channel_success(id)?;
                    tokio::spawn(russh_sftp::server::run(ch.into_stream(), crate::devtools::content::sftp_tests::Files));
                }
                _ => session.channel_failure(id)?,
            }
            Ok(())
        }

        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            let (handle, probe) = (session.handle(), self.probe);
            tokio::spawn(async move {
                let _ = handle.data(channel, probe.as_bytes().to_vec()).await;
                let _ = handle.exit_status_request(channel, 0).await;
                let _ = handle.eof(channel).await;
                let _ = handle.close(channel).await;
            });
            Ok(())
        }

        async fn shell_request(&mut self, channel: russh::ChannelId, session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.data(channel, &b"$ "[..])?;
            Ok(())
        }

        async fn window_change_request(
            &mut self,
            channel: russh::ChannelId,
            cols: u32,
            rows: u32,
            _pw: u32,
            _ph: u32,
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            session.data(channel, format!("resized:{cols}x{rows}\r\n").into_bytes())?;
            Ok(())
        }

        async fn data(&mut self, channel: russh::ChannelId, data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            for &b in data {
                if b != b'\r' {
                    self.line.push(b as char);
                    continue;
                }
                let line = std::mem::take(&mut self.line);
                if line == "exit" {
                    session.exit_status_request(channel, 7)?;
                    session.eof(channel)?;
                    session.close(channel)?;
                    return Ok(());
                }
                session.data(channel, format!("ran:{line}\r\n$ ").into_bytes())?;
            }
            Ok(())
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_remote_shell_goes_to_the_folder_takes_input_and_reports_its_exit() {
        use crate::state::NetConfig;
        use crate::storage::{net::Secrets, sftp::SftpBackend};
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (port, fp) = fake_server("motd\r\nkybl'sh a!#b c\\!d\r\n").await;
            let cfg = NetConfig { host: "127.0.0.1".into(), port, user: "me".into(), host_key: Some(fp), base_path: "/srv/My Site".into(), ..Default::default() };
            let b = SftpBackend::new(&cfg, Secrets { password: Some("pw".into()), ssh: None }).unwrap();
            let cd = remote_cd(&b, &b.shell_dir("sub/").unwrap()).await;
            assert_eq!(cd.as_deref(), Some(" cd '/srv/My Site/sub'"));
            let (handle, ch) = b.open_shell(80, 24, Some("en_US.UTF-8")).await.unwrap();
            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (out_tx, mut out_rx) = mpsc::channel(batch::QUEUE);
            let (exit_tx, exit_rx) = oneshot::channel();
            tokio::spawn(run_ssh(handle, ch, cd, cmd_rx, out_tx, exit_tx));
            let mut out = String::new();
            let mut until = async |want: &str, out: &mut String| {
                while !out.contains(want) {
                    let c = tokio::time::timeout(Duration::from_secs(10), out_rx.recv()).await.expect("no output").expect("closed early");
                    out.push_str(&String::from_utf8_lossy(&c));
                }
            };
            until("ran: cd '/srv/My Site/sub'", &mut out).await;
            cmd_tx.send(Cmd::Resize(100, 30)).unwrap();
            until("resized:100x30", &mut out).await;
            cmd_tx.send(Cmd::Write(b"exit\r".to_vec())).unwrap();
            let code = tokio::time::timeout(Duration::from_secs(10), exit_rx).await.unwrap().unwrap();
            assert_eq!(code, Some(7));
        });
    }

    /// A server whose login shell isn't a Unix one (cmd.exe, PowerShell on Windows OpenSSH) gets no
    /// `cd` typed: a folder named `x&calc&y` would run there (S1-7). csh gets its `!` escaped.
    #[cfg(unix)]
    #[test]
    fn no_cd_is_typed_into_a_shell_that_isnt_known() {
        use crate::state::NetConfig;
        use crate::storage::{net::Secrets, sftp::SftpBackend};
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            for (probe, want) in [
                // cmd.exe echoes the quotes back as they are
                ("'kybl'\\''sh' 'a!#b' 'c\\!d'\r\n", None),
                ("kybl'sh a<words>b c!d\r\n", Some(r" cd '/srv/My Site/x&calc&y/a\!b'")),
            ] {
                let (port, fp) = fake_server(probe).await;
                let cfg = NetConfig { host: "127.0.0.1".into(), port, user: "me".into(), host_key: Some(fp), base_path: "/srv/My Site".into(), ..Default::default() };
                let b = SftpBackend::new(&cfg, Secrets { password: Some("pw".into()), ssh: None }).unwrap();
                assert_eq!(remote_cd(&b, &b.shell_dir("x&calc&y/a!b/").unwrap()).await.as_deref(), want, "{probe:?}");
            }
        });
    }

    #[test]
    fn quoted_words_come_back_whole_from_a_real_shell() {
        // what the shell makes of the quoting is the test that matters
        for s in ["My Files", "it's", "a'b'c", "$HOME `id` \"q\" \\ *", "-n", "ünï"] {
            let out = std::process::Command::new("/bin/sh").arg("-c").arg(format!("printf %s {}", shell_quote(s))).output().unwrap();
            assert_eq!(String::from_utf8(out.stdout).unwrap(), s);
        }
    }

    /// Against a real sshd (env KYBL_SSH_PORT, KYBL_SSH_KEY file, KYBL_SSH_FP, KYBL_SSH_USER): ignored by default.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn real_sshd_shell() {
        use crate::state::{NetAuth, NetConfig};
        use crate::storage::{net::{Secrets, SshKey}, sftp::SftpBackend};
        let env = |k: &str| std::env::var(k).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let cfg = NetConfig { host: "127.0.0.1".into(), port: env("KYBL_SSH_PORT").parse().unwrap(), user: env("KYBL_SSH_USER"), host_key: Some(env("KYBL_SSH_FP")), auth: NetAuth::Key, base_path: "/tmp".into(), ..Default::default() };
            let key = std::fs::read_to_string(env("KYBL_SSH_KEY")).unwrap();
            let b = SftpBackend::new(&cfg, Secrets { password: None, ssh: Some(SshKey { private_key: key, passphrase: None }) }).unwrap();
            let t0 = std::time::Instant::now();
            let sh = b.login_shell().await;
            eprintln!("SHELL = {sh:?} in {:?}", t0.elapsed());
            if std::env::var("KYBL_SSH_FILES_ONLY").is_ok() {
                assert!(matches!(sh, Ok(crate::storage::sftp::command::Shell::FilesOnly)));
                assert!(t0.elapsed() < Duration::from_secs(3));
                return;
            }
            let cd = remote_cd(&b, &b.shell_dir("").unwrap()).await;
            eprintln!("cd = {cd:?}");
            let (handle, ch) = b.open_shell(80, 24, Some("en_US.UTF-8")).await.unwrap();
            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (out_tx, mut out_rx) = mpsc::channel(batch::QUEUE);
            let (exit_tx, mut exit_rx) = oneshot::channel();
            tokio::spawn(run_ssh(handle, ch, cd, cmd_rx, out_tx, exit_tx));
            let mut out = String::new();
            let mut sent = false;
            let t = std::time::Instant::now();
            while t.elapsed() < Duration::from_secs(6) {
                if !sent && t.elapsed() > Duration::from_secs(2) {
                    eprintln!("--- typing");
                    cmd_tx.send(Cmd::Write(b"echo KYBL-$((40+2))\r".to_vec())).unwrap();
                    sent = true;
                }
                if let Ok(Some(c)) = tokio::time::timeout(Duration::from_millis(200), out_rx.recv()).await {
                    out.push_str(&String::from_utf8_lossy(&c));
                }
                if let Ok(code) = exit_rx.try_recv() { eprintln!("EXIT {code:?} at {:?}", t.elapsed()); break; }
            }
            eprintln!("OUTPUT: {out:?}");
            assert!(out.contains("KYBL-42"));
        });
    }
}
