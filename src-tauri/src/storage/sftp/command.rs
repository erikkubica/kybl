//! Running a shell command on an SFTP server over the same SSH sign-in (an `exec` channel): what
//! custom actions with "On the server" use. The server runs it with the user's login shell.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex,
    },
    time::Duration,
};

use russh::{ChannelMsg, Sig};

use super::{ssh_error, SftpBackend};
use crate::storage::{ErrKind, HashKind, SResult, StorageError};

/// Servers (`user@host:port`) that ran no hash command: files there are checked by size only.
static NO_HASH: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// The hash at the start of a hash command's output ("<hex>  name", or the bare hex of `md5 -q`).
fn parse_hash(out: &str) -> Option<(HashKind, String)> {
    let word = out.split_whitespace().next()?.trim_start_matches('\\').to_ascii_lowercase();
    if !word.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match word.len() {
        64 => Some((HashKind::Sha256, word)),
        32 => Some((HashKind::Md5, word)),
        _ => None,
    }
}

const RAN: &str = "kybl:ran";
const NO_TOOL: &str = "kybl:no-hash-tool";

/// The hash command for the file at `path` on the server: the first hash tool it has, then a line
/// saying the script ran at all. Run by `sh`, whatever the login shell is (fish, csh). None for a
/// path with a line break or another control character (see [`crate::actions::plain_text`]).
fn hash_command(path: &str) -> Option<String> {
    let q = crate::actions::quote(path);
    let script = format!(
        "if command -v sha256sum >/dev/null 2>&1; then sha256sum -b -- {q}; \
         elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -b -- {q}; \
         elif command -v md5sum >/dev/null 2>&1; then md5sum -b -- {q}; \
         elif command -v md5 >/dev/null 2>&1; then md5 -q -- {q}; \
         else echo {NO_TOOL}; fi 2>/dev/null; echo {RAN}"
    );
    crate::actions::sh_c(&script)
}

/// How a server's login shell reads what [`crate::actions::quote`] writes.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Shell {
    /// sh, bash, zsh, dash, ksh, fish: the quoting holds as it is
    Posix,
    /// csh, tcsh: the quoting holds, but `!` is history expansion even inside single quotes
    /// (`!#` pastes the line's earlier words in raw), so every `!` is sent as `\!` (see [`for_csh`])
    Csh,
    /// cmd.exe, PowerShell, nushell, a menu: no commands are sent
    Other,
}

/// Servers (`user@host:port`) and their login shell, once known for sure.
static SHELLS: LazyLock<Mutex<HashMap<String, Shell>>> = LazyLock::new(Default::default);

/// Asked once per server before any command goes there. POSIX shells and fish print
/// [`PROBE_POSIX`]. csh and tcsh expand `!#` (into the line's earlier words) and drop the `\` of
/// `\!`, so their answer ends in [`PROBE_CSH_END`]. cmd.exe and PowerShell (Windows OpenSSH)
/// don't read single quotes that way, and there a quoted file name would not stay one word (`&`,
/// `|` and `%` are live in cmd.exe).
const PROBE: &str = r"echo 'kybl'\''sh' 'a!#b' 'c\!d'";
const PROBE_POSIX: &str = r"kybl'sh a!#b c\!d";
const PROBE_CSH_END: &str = " c!d";

/// What the probe's output says, from whichever line holds the exact answer: startup files may
/// print before it, and an exit trap, a login wrapper's footer or a "connection closed" notice
/// after it. `Other` (kept for the run) only when no line is an answer at all; None when nothing
/// came back (nothing printed, or the connection dropped): asked again.
fn read_probe(out: &str, exited: bool) -> Option<Shell> {
    let lines: Vec<&str> = out.lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.trim().is_empty()).collect();
    let csh = |l: &str| l.starts_with("kybl'sh ") && l.ends_with(PROBE_CSH_END) && !l.contains(r"\!");
    if lines.iter().rev().any(|l| *l == PROBE_POSIX) {
        return Some(Shell::Posix);
    }
    if lines.iter().rev().any(|l| csh(l)) {
        return Some(Shell::Csh);
    }
    match lines.last() {
        Some(_) if exited => Some(Shell::Other),
        _ => None,
    }
}

/// `command` as csh must get it: every `!` written `\!` (csh drops the `\`, also inside single
/// quotes, and the `!` is then plain), except the `$!` of a POSIX script (the last background
/// job's pid; `$\!` is an error in csh) when nothing csh would expand follows it.
fn for_csh(command: &str) -> String {
    let mut out = String::with_capacity(command.len() + 8);
    let mut prev = '\0';
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        // only ASCII blanks: csh reads `!` before a Unicode space (U+00A0, U+3000…) as an event
        let pid = prev == '$' && chars.peek().is_none_or(|n| matches!(n, ' ' | '\t' | ';' | '"' | '\'' | ')' | '&' | '|'));
        if c == '!' && !pid {
            out.push('\\');
        }
        out.push(c);
        prev = c;
    }
    out
}

pub const NOT_POSIX: &str = "Kybl runs commands only on servers with a Unix shell (sh, bash, zsh, fish or csh). This one has another (Windows?) or none.";

const NO_PROBE_ANSWER: &str = "The server didn't say which shell it has. Try again.";

/// What a hash command's output says.
#[derive(Debug, PartialEq)]
enum HashRun {
    Hash(HashKind, String),
    /// no hash tool, or no shell that runs commands (an SFTP-only account): not asked again
    NoCommands,
    /// the tools are there but this file gave no hash (unreadable, gone): ask again next time
    ThisFile,
}

/// `code` is the exit status. The shell probe has already shown the server runs commands, so
/// a run without the closing line means /bin/sh is missing only when the shell said "not found"
/// (127). Anything else (csh refusing one odd name, say) is this file only: one name must not
/// turn checking off for the whole server.
fn read_hash_run(out: &str, code: Option<u32>) -> HashRun {
    if let Some((kind, hex)) = parse_hash(out) {
        return HashRun::Hash(kind, hex);
    }
    if out.contains(NO_TOOL) || (!out.contains(RAN) && code == Some(127)) {
        return HashRun::NoCommands;
    }
    HashRun::ThisFile
}

/// A hash command that couldn't run at all. Only the server refusing the command request itself
/// means it runs none for this user; anything else may pass (a dropped connection, a channel
/// refused while the server's MaxSessions are taken by transfers): this file only.
fn failed_run(e: &StorageError) -> HashRun {
    if e.kind == ErrKind::Unsupported {
        HashRun::NoCommands
    } else {
        HashRun::ThisFile
    }
}

/// The command was stopped by us, or the server gave its exit status.
fn ended_properly(end: &ExecEnd) -> bool {
    end.stopped || end.code.is_some()
}

/// How a command on the server ended.
pub struct ExecEnd {
    /// the exit status, None when the server didn't say (stopped, or the connection dropped)
    pub code: Option<u32>,
    /// `cancel` was set and the command was told to stop
    pub stopped: bool,
}

impl SftpBackend {
    /// The absolute path on the server of a key (the connection's folder plus the key).
    pub async fn remote_path(&self, key: &str) -> SResult<String> {
        self.path(key.trim_end_matches('/')).await
    }

    /// Runs `command` on the server and hands its output to `on_data` as it comes (`true` for
    /// stderr). Setting `cancel` sends the command SIGTERM, then closes the channel. Refused on a
    /// server whose login shell isn't a POSIX-like one (see [`PROBE`]).
    pub async fn exec(&self, command: &str, cancel: &AtomicBool, on_data: impl FnMut(bool, &[u8])) -> SResult<ExecEnd> {
        match self.login_shell().await? {
            Shell::Posix => self.exec_raw(command, cancel, on_data).await,
            Shell::Csh => self.exec_raw(&for_csh(command), cancel, on_data).await,
            Shell::Other => Err(StorageError::other(NOT_POSIX)),
        }
    }

    /// The account's login shell (see [`PROBE`]), asked once per server. Only a clear answer is
    /// kept: a dropped connection or no output at all is an error, asked again next time.
    async fn login_shell(&self) -> SResult<Shell> {
        let who = format!("{}@{}:{}", self.user, self.host, self.port);
        if let Some(sh) = SHELLS.lock().unwrap().get(&who).copied() {
            return Ok(sh);
        }
        let stop = AtomicBool::new(false);
        // the end of what it prints is enough (startup files can print a lot before the answer)
        let mut out = Vec::new();
        let run = self.exec_raw(PROBE, &stop, |err, d| {
            if !err {
                out.extend_from_slice(d);
                if out.len() > 4096 {
                    out.drain(..out.len() - 1024);
                }
            }
        });
        let end = tokio::time::timeout(Duration::from_secs(20), run).await.map_err(|_| StorageError::other("The server didn't answer in time."))??;
        let sh = read_probe(&String::from_utf8_lossy(&out), end.code.is_some()).ok_or_else(|| StorageError::new(ErrKind::Network, NO_PROBE_ANSWER))?;
        SHELLS.lock().unwrap().insert(who, sh);
        Ok(sh)
    }

    async fn exec_raw(&self, command: &str, cancel: &AtomicBool, mut on_data: impl FnMut(bool, &[u8])) -> SResult<ExecEnd> {
        let c = self.conn().await?;
        let mut ch = c.handle.channel_open_session().await.map_err(|e| ssh_error(e, &self.host))?;
        ch.exec(true, command)
            .await
            .map_err(|e| StorageError::other("The server didn't run the command.").with_detail(e.to_string()))?;
        let mut code = None;
        let mut stopped_at: Option<tokio::time::Instant> = None;
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                msg = ch.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => on_data(false, &data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => on_data(true, &data),
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    // the server said no to running commands at all (its answer to the exec request)
                    Some(ChannelMsg::Failure) => return Err(StorageError::new(ErrKind::Unsupported, "The server refused to run commands for this user.")),
                    Some(_) => {}
                    None => break,
                },
                _ = tick.tick() => {
                    if !cancel.load(Ordering::Relaxed) {
                        continue;
                    }
                    match stopped_at {
                        None => {
                            stopped_at = Some(tokio::time::Instant::now());
                            // not every server passes signals on; closing the channel is the fallback
                            let _ = ch.signal(Sig::TERM).await;
                        }
                        Some(t) if t.elapsed() > Duration::from_secs(2) => {
                            let _ = ch.signal(Sig::KILL).await;
                            let _ = ch.close().await;
                            break;
                        }
                        Some(_) => {}
                    }
                }
            }
        }
        Ok(ExecEnd { code, stopped: stopped_at.is_some() })
    }

    /// The SHA-256 (or MD5) of a file as the server works it out, for checking a copy: tries
    /// `sha256sum`, `shasum -a 256`, `md5sum` and BSD `md5` in turn. None when the server runs no
    /// such command (an SFTP-only account, no shell); such a server isn't asked again this run.
    /// Given at most 20 s plus the time to read the file at 50 MB/s.
    pub async fn hash_on_server(&self, key: &str, size: u64) -> SResult<Option<(HashKind, String)>> {
        let who = format!("{}@{}:{}", self.user, self.host, self.port);
        if NO_HASH.lock().unwrap().contains(&who) {
            return Ok(None);
        }
        // a name no shell quoting holds safely: checked by size only
        let Some(cmd) = hash_command(&self.remote_path(key).await?) else { return Ok(None) };
        let stop = AtomicBool::new(false);
        let mut out = Vec::new();
        let deadline = Duration::from_secs(20) + Duration::from_secs_f64(size as f64 / 50e6);
        let ran = tokio::select! {
            r = self.exec(&cmd, &stop, |err, d| if !err && out.len() < 4096 { out.extend_from_slice(d) }) => r,
            _ = async {
                tokio::time::sleep(deadline).await;
                stop.store(true, Ordering::Relaxed);
                std::future::pending::<()>().await
            } => unreachable!(),
        };
        let run = match ran {
            // the channel closed with no exit status (the connection dropped mid-way, perhaps
            // after part of the output): this file only, never "no commands here"
            Ok(end) if !ended_properly(&end) => HashRun::ThisFile,
            Ok(end) if !end.stopped => read_hash_run(&String::from_utf8_lossy(&out), end.code),
            // out of time (a slow disk, a huge file): this file only
            Ok(_) => HashRun::ThisFile,
            Err(e) => failed_run(&e),
        };
        Ok(match run {
            HashRun::Hash(kind, hex) => Some((kind, hex)),
            HashRun::NoCommands => {
                NO_HASH.lock().unwrap().insert(who);
                None
            }
            HashRun::ThisFile => None,
        })
    }

    /// Closes the SSH connection (a connection opened just to run a command).
    pub async fn disconnect(&self) {
        if let Some(c) = self.conn.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), c.handle.disconnect(russh::Disconnect::ByApplication, "", "")).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_command_output_is_read() {
        let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(parse_hash(&format!("{sha} *dir/a b.txt\n")), Some((HashKind::Sha256, sha.into())));
        assert_eq!(parse_hash("D41D8CD98F00B204E9800998ECF8427E\n"), Some((HashKind::Md5, "d41d8cd98f00b204e9800998ecf8427e".into())));
        // GNU tools escape names with odd characters by starting the line with a backslash
        assert_eq!(parse_hash(&format!("\\{sha}  a\\nb\n")).map(|h| h.0), Some(HashKind::Sha256));
        for nothing in ["", "sha256sum: not found", "Permission denied", "abc123  x"] {
            assert_eq!(parse_hash(nothing), None, "{nothing:?}");
        }
    }

    /// Only a server without the tools (or without a shell) stops being asked; one file that
    /// gives no hash doesn't turn checking off for the whole server.
    #[test]
    fn only_missing_tools_turn_hashing_off() {
        let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(read_hash_run(&format!("{sha}  a\n{RAN}\n"), Some(0)), HashRun::Hash(HashKind::Sha256, sha.into()));
        // unreadable or deleted file: the tool ran and printed nothing
        assert_eq!(read_hash_run(&format!("{RAN}\n"), Some(0)), HashRun::ThisFile);
        assert_eq!(read_hash_run(&format!("{NO_TOOL}\n{RAN}\n"), Some(0)), HashRun::NoCommands);
        // no /bin/sh to run the script: "not found"
        assert_eq!(read_hash_run("", Some(127)), HashRun::NoCommands);
        // csh refusing a line ("Event not found", exit 1) or no exit status: this file only
        assert_eq!(read_hash_run("", Some(1)), HashRun::ThisFile);
        assert_eq!(read_hash_run("", None), HashRun::ThisFile);
        // the exec request refused outright: no commands; a channel that couldn't open (all
        // sessions busy with transfers) or a dropped connection: only this file
        assert_eq!(failed_run(&StorageError::new(ErrKind::Unsupported, "refused")), HashRun::NoCommands);
        assert_eq!(failed_run(&StorageError::other("The server didn't run the command.")), HashRun::ThisFile);
        assert_eq!(failed_run(&StorageError::new(ErrKind::Network, "dropped")), HashRun::ThisFile);
    }

    /// A channel that closed without an exit status (a dropped connection) is no verdict: the
    /// shell probe isn't remembered and hashing isn't turned off for the server.
    #[test]
    fn a_dropped_channel_is_no_verdict() {
        let dropped = ExecEnd { code: None, stopped: false };
        assert!(!ended_properly(&dropped));
        // the shell probe: no output and no exit status is no answer; an answer that came is read
        assert_eq!(read_probe("", false), None);
        let exited = ExecEnd { code: Some(1), stopped: false };
        assert!(ended_properly(&exited));
        assert!(ended_properly(&ExecEnd { code: None, stopped: true }));
    }

    /// The command as a login shell runs it, on a file with a quote and a space in its name.
    #[cfg(unix)]
    #[test]
    fn the_hash_command_runs_in_a_shell() {
        let dir = std::env::temp_dir().join(format!("kybl-hash-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("it's here.bin");
        std::fs::write(&file, b"").unwrap();
        let run = |path: &std::path::Path| {
            let out = std::process::Command::new("sh").arg("-c").arg(hash_command(&path.to_string_lossy()).unwrap()).output().unwrap();
            read_hash_run(&String::from_utf8_lossy(&out.stdout), out.status.code().map(|c| c as u32))
        };
        match run(&file) {
            HashRun::Hash(_, hex) => assert!(hex == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" || hex == "d41d8cd98f00b204e9800998ecf8427e"),
            other => panic!("{other:?}"),
        }
        assert_eq!(run(&dir.join("gone")), HashRun::ThisFile);
        // a newline in the name: nothing is sent (size-only check)
        assert!(hash_command("/srv/a'\ntouch /tmp/x\n'").is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    /// Every shell answers the probe as its kind; cmd.exe echoes it back as typed.
    #[cfg(unix)]
    #[test]
    fn the_shell_probe_tells_shells_apart() {
        let shells = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh", "/bin/tcsh", "/bin/csh", "/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"];
        for sh in shells.into_iter().filter(|p| std::path::Path::new(p).exists()) {
            let out = std::process::Command::new(sh).arg("-c").arg(PROBE).output().unwrap();
            let want = if sh.ends_with("csh") { Shell::Csh } else { Shell::Posix };
            assert_eq!(read_probe(&String::from_utf8_lossy(&out.stdout), true), Some(want), "{sh}");
        }
        assert_eq!(read_probe("kybl'sh a!#b c\\!d\r\n", true), Some(Shell::Posix));
        // startup files that print something first
        assert_eq!(read_probe("Welcome!\nconda: base\n\nkybl'sh a!#b c\\!d\n\n", true), Some(Shell::Posix));
        // and something printed after it (an EXIT trap, a login wrapper's footer)
        assert_eq!(read_probe("kybl'sh a!#b c\\!d\nLogged out at 12:00.\n", true), Some(Shell::Posix));
        assert_eq!(read_probe("motd\nkybl'sh a<words>b c!d\r\nbye\r\n", true), Some(Shell::Csh));
        // cmd.exe prints the line as it is; PowerShell's echo puts each word on its own line
        for not in [r"'kybl'\''sh' 'a!#b' 'c\!d'", "kybl\n\\'sh\na!#b\nc\\!d", "This service allows sftp connections only.\n"] {
            assert_eq!(read_probe(not, true), Some(Shell::Other), "{not:?}");
        }
        // no answer (dropped, or nothing came back) is not kept: asked again
        assert_eq!(read_probe("", true), None);
        assert_eq!(read_probe("", false), None);
        assert_eq!(read_probe("kybl", false), None);
    }

    /// The csh hole: a folder named `;touch pwn1;` and an item named `x!#`, the way a server
    /// action sends them. As tcsh/csh get it, nothing runs and the names come back.
    #[cfg(unix)]
    #[test]
    fn csh_history_expansion_is_escaped() {
        use crate::actions::quote;
        let dir = std::env::temp_dir().join(format!("kybl-csh-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join(";touch pwn1;")).unwrap();
        let pwned = || dir.join("pwn1").exists() || dir.join(";touch pwn1;").join("pwn1").exists();
        for sh in ["/bin/tcsh", "/bin/csh"].into_iter().filter(|p| std::path::Path::new(p).exists()) {
            // the hole is real without the escaping
            let raw = format!("cd {} && printf '%s\\n' {}", quote(";touch pwn1;"), quote("x!#"));
            std::process::Command::new(sh).arg("-f").arg("-c").arg(&raw).current_dir(&dir).output().unwrap();
            assert!(pwned(), "{sh}: expected the unescaped line to run touch");
            std::fs::remove_file(dir.join("pwn1")).ok();
            std::fs::remove_file(dir.join(";touch pwn1;").join("pwn1")).ok();
            for item in ["x!#", "y!#:0", "z!!", "a$!#", r"b\!#", "c!$", "!.git", "d!-1"] {
                let line = format!("cd {} && printf '%s\\n' {}", quote(";touch pwn1;"), quote(item));
                let out = std::process::Command::new(sh).arg("-f").arg("-c").arg(for_csh(&line)).current_dir(&dir).output().unwrap();
                assert!(!pwned(), "{sh} {item}");
                // `$!` then `#` is a variable to csh: an error there, never run
                if !item.contains("$!") {
                    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("{item}\n"), "{sh} {item}: {}", String::from_utf8_lossy(&out.stderr));
                }
            }
            // a script's `$!` (a background pid) still works
            let out = std::process::Command::new(sh).arg("-f").arg("-c").arg(for_csh(&crate::actions::sh_c("sleep 0 & P=$!; wait $P; echo ok").unwrap())).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "ok\n", "{sh}: {}", String::from_utf8_lossy(&out.stderr));
            // and ripgrep's `!.git` in a search script reaches sh as written
            let out = std::process::Command::new(sh).arg("-f").arg("-c").arg(for_csh(&crate::actions::sh_c("printf '%s\\n' '!.git'").unwrap())).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "!.git\n", "{sh}");
            // `$!` before a Unicode space is escaped too (csh would look it up as an event)
            for name in ["a$!\u{a0}b", "a$!\u{3000}b", "a$!\u{2003}b"] {
                let cmd = for_csh(&crate::actions::sh_c(&format!("printf '%s\\n' {}", quote(name))).unwrap());
                let out = std::process::Command::new(sh).arg("-f").arg("-c").arg(&cmd).output().unwrap();
                assert_eq!(String::from_utf8_lossy(&out.stdout), format!("{name}\n"), "{sh} {name:?}: {}", String::from_utf8_lossy(&out.stderr));
            }
        }
        std::fs::remove_dir_all(dir).ok();
    }
}
