//! Trust on first use for SFTP servers.
//!
//! A connection remembers its server's key as a SHA-256 fingerprint (`NetConfig::host_key`,
//! "SHA256:..." as OpenSSH prints it). Connecting to a server whose key isn't known yet fails
//! with `ErrKind::UnknownHost`; the error's detail starts with `host-key-unknown SHA256:...`, so
//! the UI can ask "Trust this server?" and save the fingerprint. A key that differs from the saved
//! one fails with `ErrKind::HostKeyChanged` (`host-key-changed SHA256:new expected SHA256:old`),
//! and nothing is sent to that server.

use std::sync::{Arc, Mutex};

use russh::keys::{HashAlg, PublicKeyOrCertificate};

use crate::storage::{ErrKind, StorageError};

/// The SSH client handler: accepts the server only when its key is the trusted one, and notes
/// the fingerprint it saw either way.
pub struct HostCheck {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl HostCheck {
    pub fn new(expected: Option<String>) -> (Self, Arc<Mutex<Option<String>>>) {
        let seen = Arc::new(Mutex::new(None));
        (Self { expected, seen: seen.clone() }, seen)
    }
}

impl russh::client::Handler for HostCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let data = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().clone(),
        };
        let fp = data.fingerprint(HashAlg::Sha256).to_string();
        let ok = self.expected.as_deref().is_some_and(|e| same(e, &fp));
        *self.seen.lock().unwrap() = Some(fp);
        Ok(ok)
    }
}

/// Fingerprints compare without the "SHA256:" prefix, base64 padding or surrounding spaces.
pub fn same(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_start_matches("SHA256:").trim_end_matches('=').to_string();
    norm(a) == norm(b)
}

/// The error for a connection the key check stopped, if that is what happened.
pub fn refusal(e: &russh::Error, seen: Option<String>, expected: Option<&str>) -> Option<StorageError> {
    if !matches!(e, russh::Error::UnknownKey) {
        return None;
    }
    let seen = seen?;
    Some(match expected {
        None => unknown(&seen),
        Some(exp) => changed(&seen, exp),
    })
}

pub fn unknown(fp: &str) -> StorageError {
    StorageError::new(
        ErrKind::UnknownHost,
        "Kybl hasn't connected to this server before. Check that the server's fingerprint matches, then trust it to connect.",
    )
    .with_detail(format!("host-key-unknown {fp}"))
}

pub fn changed(seen: &str, expected: &str) -> StorageError {
    StorageError::new(
        ErrKind::HostKeyChanged,
        "The server's identity changed. Someone may be intercepting the connection, so Kybl didn't connect. If the server was reinstalled or its key replaced, remove the saved fingerprint in the connection's settings and connect again.",
    )
    .with_detail(format!("host-key-changed {seen} expected {expected}"))
}

/// The fingerprint in an unknown-host error's text, for the UI to save once the user trusts it.
pub fn fingerprint_in(error: &str) -> Option<&str> {
    let at = error.find("host-key-unknown ")? + "host-key-unknown ".len();
    error[at..].split_whitespace().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_compare_loosely() {
        assert!(same("SHA256:abc=", "abc"));
        assert!(same(" SHA256:abc ", "SHA256:abc"));
        assert!(!same("SHA256:abc", "SHA256:abd"));
    }

    #[test]
    fn refusals_carry_the_fingerprint() {
        let e = refusal(&russh::Error::UnknownKey, Some("SHA256:new".into()), None).unwrap();
        assert_eq!(e.kind, ErrKind::UnknownHost);
        let s = String::from(e);
        assert_eq!(fingerprint_in(&s), Some("SHA256:new"));
        let e = refusal(&russh::Error::UnknownKey, Some("SHA256:new".into()), Some("SHA256:old")).unwrap();
        assert_eq!(e.kind, ErrKind::HostKeyChanged);
        assert!(e.message.starts_with("The server's identity changed"));
        assert!(refusal(&russh::Error::Disconnect, Some("x".into()), None).is_none());
    }
}
