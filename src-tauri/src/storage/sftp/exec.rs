//! Running a command on the server over the SFTP connection's SSH session (an exec channel next
//! to the SFTP one). Used for work the server does far faster itself than over the wire: zipping
//! and unpacking archives in place (src/archive). Servers that only allow SFTP (ForceCommand
//! internal-sftp, chroots) refuse the channel or have no shell; callers fall back then.

use std::sync::atomic::{AtomicBool, Ordering};

use russh::ChannelMsg;

use super::SftpBackend;
use crate::storage::{ErrKind, SResult, StorageError};

/// What a command left: its exit status (None when the server sent none) and its output.
#[derive(Debug, Default)]
pub struct ExecOut {
    pub status: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

/// `s` quoted for a POSIX shell.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

impl SftpBackend {
    /// The server's absolute path of `key`.
    pub async fn server_path(&self, key: &str) -> SResult<String> {
        self.path(key).await
    }

    /// Runs `cmd` with the user's login shell on the server and waits for it. `cancel` closes the
    /// channel (the server may let the command finish anyway).
    pub async fn exec(&self, cmd: &str, cancel: &AtomicBool) -> SResult<ExecOut> {
        let c = self.conn().await?;
        let mut ch = c
            .handle
            .channel_open_session()
            .await
            .map_err(|e| StorageError::new(ErrKind::Unsupported, "The server doesn't run commands over this connection.").with_detail(e.to_string()))?;
        ch.exec(true, cmd).await.map_err(|e| StorageError::new(ErrKind::Unsupported, "The server doesn't run commands over this connection.").with_detail(e.to_string()))?;
        let mut out = ExecOut::default();
        let (mut so, mut se) = (Vec::new(), Vec::new());
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = ch.close().await;
                return Err(StorageError::cancelled());
            }
            let msg = tokio::time::timeout(std::time::Duration::from_millis(250), ch.wait()).await;
            let Ok(msg) = msg else { continue };
            match msg {
                Some(ChannelMsg::Data { data }) => so.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => se.extend_from_slice(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => out.status = Some(exit_status),
                Some(ChannelMsg::Failure) => return Err(StorageError::new(ErrKind::Unsupported, "The server doesn't run commands over this connection.")),
                Some(_) => {}
                None => break,
            }
            // keep what a runaway command prints bounded
            so.truncate(1 << 20);
            se.truncate(1 << 20);
        }
        out.stdout = String::from_utf8_lossy(&so).into_owned();
        out.stderr = String::from_utf8_lossy(&se).into_owned();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::sh_quote;

    #[test]
    fn quotes_for_the_shell() {
        assert_eq!(sh_quote("a b"), "'a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
    }
}
