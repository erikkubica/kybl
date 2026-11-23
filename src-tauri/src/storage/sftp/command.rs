//! Running a shell command on an SFTP server over the same SSH sign-in (an `exec` channel): what
//! custom actions with "On the server" use. The server runs it with the user's login shell.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use russh::{ChannelMsg, Sig};

use super::{ssh_error, SftpBackend};
use crate::storage::{SResult, StorageError};

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

    /// Closes the SSH connection (a connection opened just to run a command).
    pub async fn disconnect(&self) {
        if let Some(c) = self.conn.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), c.handle.disconnect(russh::Disconnect::ByApplication, "", "")).await;
        }
    }
}
