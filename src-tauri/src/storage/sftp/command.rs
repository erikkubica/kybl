//! Running a shell command on an SFTP server over the same SSH sign-in (an `exec` channel): what
//! custom actions with "On the server" use. The server runs it with the user's login shell.

use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex,
    },
    time::Duration,
};

use russh::{ChannelMsg, Sig};

use super::{ssh_error, SftpBackend};
use crate::storage::{HashKind, SResult, StorageError};

/// Servers (`user@host`) that ran no hash command: files there are checked by size only.
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
    /// stderr). Setting `cancel` sends the command SIGTERM, then closes the channel.
    pub async fn exec(&self, command: &str, cancel: &AtomicBool, mut on_data: impl FnMut(bool, &[u8])) -> SResult<ExecEnd> {
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
                    Some(ChannelMsg::Failure) => return Err(StorageError::other("The server refused to run commands for this user.")),
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
        let who = format!("{}@{}", self.user, self.host);
        if NO_HASH.lock().unwrap().contains(&who) {
            return Ok(None);
        }
        let q = crate::actions::quote(&self.remote_path(key).await?);
        let cmd = format!("sha256sum -b -- {q} 2>/dev/null || shasum -a 256 -b -- {q} 2>/dev/null || md5sum -b -- {q} 2>/dev/null || md5 -q -- {q} 2>/dev/null");
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
        let parsed = match ran {
            Ok(end) if !end.stopped => parse_hash(&String::from_utf8_lossy(&out)),
            _ => None,
        };
        if parsed.is_none() {
            NO_HASH.lock().unwrap().insert(who);
        }
        Ok(parsed)
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
}
