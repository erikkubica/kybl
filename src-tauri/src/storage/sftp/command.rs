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

/// Servers (`user@host:port`) and whether their login shell reads POSIX quoting.
static SHELLS: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Default::default);

/// Asked once per server before any command goes there. POSIX shells, fish and csh all print
/// [`PROBE_ANSWER`]; cmd.exe and PowerShell (Windows OpenSSH) don't read single quotes that way,
/// and there a quoted file name would not stay one word (`&`, `|` and `%` are live in cmd.exe).
const PROBE: &str = r"echo 'kybl'\''sh'";
const PROBE_ANSWER: &str = "kybl'sh";

fn probe_says_posix(out: &str) -> bool {
    out.trim_end_matches(['\r', '\n']) == PROBE_ANSWER
}

pub const NOT_POSIX: &str = "Kybl runs commands only on servers with a Unix shell (sh, bash, zsh, fish or csh). This one has another (Windows?) or none.";

/// What a hash command's output says.
#[derive(Debug, PartialEq)]
enum HashRun {
    Hash(HashKind, String),
    /// no hash tool, or no shell that runs commands (an SFTP-only account): not asked again
    NoCommands,
    /// the tools are there but this file gave no hash (unreadable, gone): ask again next time
    ThisFile,
}

fn read_hash_run(out: &str) -> HashRun {
    if let Some((kind, hex)) = parse_hash(out) {
        return HashRun::Hash(kind, hex);
    }
    // without the closing line our script never ran (a forced `internal-sftp`, a menu shell)
    if out.contains(NO_TOOL) || !out.contains(RAN) {
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
        self.posix_shell().await?;
        self.exec_raw(command, cancel, on_data).await
    }

    /// Whether the account's login shell reads quoting as [`crate::actions::quote`] writes it;
    /// asked once per server, an error when it doesn't.
    async fn posix_shell(&self) -> SResult<()> {
        let who = format!("{}@{}:{}", self.user, self.host, self.port);
        let known = SHELLS.lock().unwrap().get(&who).copied();
        let ok = match known {
            Some(ok) => ok,
            None => {
                let stop = AtomicBool::new(false);
                let mut out = Vec::new();
                let run = self.exec_raw(PROBE, &stop, |err, d| {
                    if !err && out.len() < 256 {
                        out.extend_from_slice(d);
                    }
                });
                tokio::time::timeout(Duration::from_secs(20), run).await.map_err(|_| StorageError::other("The server didn't answer in time."))??;
                let ok = probe_says_posix(&String::from_utf8_lossy(&out));
                SHELLS.lock().unwrap().insert(who, ok);
                ok
            }
        };
        if ok {
            Ok(())
        } else {
            Err(StorageError::other(NOT_POSIX))
        }
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
            Ok(end) if !end.stopped => read_hash_run(&String::from_utf8_lossy(&out)),
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
        assert_eq!(read_hash_run(&format!("{sha}  a\n{RAN}\n")), HashRun::Hash(HashKind::Sha256, sha.into()));
        // unreadable or deleted file: the tool ran and printed nothing
        assert_eq!(read_hash_run(&format!("{RAN}\n")), HashRun::ThisFile);
        assert_eq!(read_hash_run(&format!("{NO_TOOL}\n{RAN}\n")), HashRun::NoCommands);
        // a forced sftp-only account answers with its own text, never our closing line
        assert_eq!(read_hash_run("This service allows sftp connections only.\n"), HashRun::NoCommands);
        assert_eq!(read_hash_run(""), HashRun::NoCommands);
        // the exec request refused outright: no commands; a channel that couldn't open (all
        // sessions busy with transfers) or a dropped connection: only this file
        assert_eq!(failed_run(&StorageError::new(ErrKind::Unsupported, "refused")), HashRun::NoCommands);
        assert_eq!(failed_run(&StorageError::other("The server didn't run the command.")), HashRun::ThisFile);
        assert_eq!(failed_run(&StorageError::new(ErrKind::Network, "dropped")), HashRun::ThisFile);
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
            read_hash_run(&String::from_utf8_lossy(&out.stdout))
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

    /// Every shell that reads `quote` right answers the probe; cmd.exe echoes it back as typed.
    #[cfg(unix)]
    #[test]
    fn the_shell_probe_tells_posix_shells_apart() {
        let shells = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh", "/bin/tcsh", "/bin/csh", "/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"];
        for sh in shells.into_iter().filter(|p| std::path::Path::new(p).exists()) {
            let out = std::process::Command::new(sh).arg("-c").arg(PROBE).output().unwrap();
            assert!(probe_says_posix(&String::from_utf8_lossy(&out.stdout)), "{sh}");
        }
        assert!(probe_says_posix("kybl'sh\r\n"));
        // cmd.exe prints the line as it is; PowerShell's echo puts each word on its own line
        for not in [r"'kybl'\''sh'", "kybl\n\\'sh", "", "This service allows sftp connections only.\n"] {
            assert!(!probe_says_posix(not), "{not:?}");
        }
    }
}
