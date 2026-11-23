//! The user's own command-line tools (git, ripgrep, grep): found once, run with an argument list
//! (never through a shell), time-boxed, and stopped when asked.
//!
//! An app opened from the Finder gets a short PATH (/usr/bin:/bin:…), so the usual install places
//! (Homebrew, MacPorts, cargo) are looked in too. On macOS /usr/bin/git is only a stub until the
//! developer tools are installed, and running it opens the system's "install the tools" dialog:
//! it counts as missing then.

use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

/// Where `name` is installed, or None. Looked up once per run of the app.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    static FOUND: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();
    let found = FOUND.get_or_init(Default::default);
    if let Some(p) = found.lock().unwrap().get(name) {
        return p.clone();
    }
    let p = lookup(name);
    found.lock().unwrap().insert(name.to_string(), p.clone());
    p
}

fn lookup(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if cfg!(unix) {
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin", "/bin"] {
            dirs.push(PathBuf::from(d));
        }
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(Path::new(&home).join(".cargo/bin"));
        }
    }
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file() && usable(p))
}

#[cfg(target_os = "macos")]
fn usable(p: &Path) -> bool {
    // the developer-tools stubs in /usr/bin: real only once Xcode or its command line tools are in
    const STUBS: [&str; 1] = ["/usr/bin/git"];
    if !STUBS.iter().any(|s| p == Path::new(s)) {
        return true;
    }
    let Ok(out) = Command::new("/usr/bin/xcode-select").arg("-p").stdin(Stdio::null()).stderr(Stdio::null()).output() else {
        return false;
    };
    let dev = String::from_utf8_lossy(&out.stdout).trim().to_string();
    out.status.success() && !dev.is_empty() && Path::new(&dev).join("usr/bin").join(p.file_name().unwrap_or_default()).is_file()
}

#[cfg(not(target_os = "macos"))]
fn usable(_p: &Path) -> bool {
    true
}

/// A command for `tool`: plain C locale, no input, no console window on Windows.
pub fn command(tool: &Path) -> Command {
    let mut c = Command::new(tool);
    c.env("LC_ALL", "C").env("LANG", "C").stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[derive(Debug)]
pub enum RunError {
    /// it didn't finish within the time given (and was stopped)
    TimedOut,
    /// it couldn't be started
    Failed,
}

/// Runs `cmd` to the end and gives its exit status and standard output; stops it after `limit`.
pub fn run_capture(mut cmd: Command, limit: Duration) -> Result<(ExitStatus, Vec<u8>), RunError> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| RunError::Failed)?;
    let mut out = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(limit) {
        Ok(buf) => {
            let status = child.wait().map_err(|_| RunError::Failed)?;
            Ok((status, buf))
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(RunError::TimedOut)
        }
    }
}

/// How a streamed run ended.
#[derive(Debug, PartialEq, Eq)]
pub enum StreamEnd {
    /// ran to the end: its exit code (None when killed by a signal)
    Exited(Option<i32>),
    /// `on_chunk` asked to stop (enough results)
    Stopped,
    Cancelled,
    TimedOut,
}

/// Runs `cmd`, handing its standard output to `on_chunk` as it comes (false: stop it). Stops it
/// when `cancel` is set or `deadline` passes. Also gives the end of what it wrote to stderr.
pub fn run_streaming(mut cmd: Command, cancel: &AtomicBool, deadline: Instant, mut on_chunk: impl FnMut(&[u8]) -> bool) -> std::io::Result<(StreamEnd, String)> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (err_tx, err_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err.read_to_end(&mut buf);
        let start = buf.len().saturating_sub(2000);
        let _ = err_tx.send(String::from_utf8_lossy(&buf[start..]).trim().to_string());
    });
    let end = loop {
        if cancel.load(Ordering::Relaxed) {
            break Some(StreamEnd::Cancelled);
        }
        let now = Instant::now();
        if now >= deadline {
            break Some(StreamEnd::TimedOut);
        }
        match rx.recv_timeout((deadline - now).min(Duration::from_millis(100))) {
            Ok(chunk) => {
                if !on_chunk(&chunk) {
                    break Some(StreamEnd::Stopped);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
        }
    };
    let end = match end {
        Some(stop) => {
            let _ = child.kill();
            let _ = child.wait();
            stop
        }
        None => StreamEnd::Exited(child.wait()?.code()),
    };
    drop(rx);
    // something it started may still hold stderr open: don't wait on that
    let tail = err_rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
    Ok((end, tail))
}

/// `s` as one shell word: as it is when plain, else quoted as [`crate::actions::quote`] does
/// (read back the same by POSIX shells, fish and csh).
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:,+@%".contains(&b)) {
        return s.to_string();
    }
    crate::actions::quote(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_keeps_every_word_whole() {
        assert_eq!(shell_quote("rg"), "rg");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    /// The words survive two shells (the login shell, then `sh -c`), as the SFTP search sends them.
    #[cfg(unix)]
    #[test]
    fn quoted_words_reach_the_command_unchanged() {
        let words = ["plain", "two words", "it's", "\"dq\"", "$(touch /tmp/kybl-pwned)", "`id`", "a;b|c&d", "*.rs", "back\\slash", "new\nline", "-e", "--", "!bang", "~/x", "${HOME}", "'"];
        let script = format!("printf '%s\\0' {}", words.iter().map(|w| shell_quote(w)).collect::<Vec<_>>().join(" "));
        let outer = format!("sh -c {}", shell_quote(&script));
        let out = Command::new("/bin/sh").arg("-c").arg(&outer).output().unwrap();
        assert!(out.status.success());
        let got: Vec<String> = out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
        assert_eq!(got, words);
        assert!(!Path::new("/tmp/kybl-pwned").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_run_is_time_boxed_and_cancellable() {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg("sleep 5");
        let t = Instant::now();
        assert!(matches!(run_capture(c, Duration::from_millis(200)), Err(RunError::TimedOut)));
        assert!(t.elapsed() < Duration::from_secs(2));

        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg("echo one; echo two; sleep 5");
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let (end, _) = run_streaming(c, &cancel, Instant::now() + Duration::from_secs(10), |b| {
            seen.extend_from_slice(b);
            !seen.ends_with(b"two\n")
        })
        .unwrap();
        assert_eq!(end, StreamEnd::Stopped);
        assert!(t.elapsed() < Duration::from_secs(4));
    }
}
