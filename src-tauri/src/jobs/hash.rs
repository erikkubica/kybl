//! Content hashes for verifying copies: what a provider reports, and MD5s computed as bytes pass.
//! (S3 targets are checked per part by the server, see `storage::s3_stream`.)

use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use md5::{Digest, Md5};

use crate::storage::{ByteStream, Capabilities, Entry, HashKind};

pub fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn is_md5_hex(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The MD5 of a file as its store reports it, as lowercase hex: a hash the provider gives, or an
/// S3 ETag on providers where a single-request upload's ETag is the MD5 (multipart ETags, "…-N",
/// aren't). A provider hash that isn't 32 hex digits (base64 slipping through, say) is no hash:
/// lowercasing base64 makes a different value, and a wrong hash fails or passes copies wrongly.
pub fn md5_of(e: &Entry, caps: &Capabilities) -> Option<String> {
    if let Some(m) = &e.hashes.md5 {
        return is_md5_hex(m).then(|| m.to_ascii_lowercase());
    }
    if !caps.hashes.contains(&HashKind::Md5) {
        return None;
    }
    let tag = e.etag.as_deref()?.trim_matches('"').to_ascii_lowercase();
    is_md5_hex(&tag).then_some(tag)
}

/// An MD5 being computed over a stream (see [`tap`]).
#[derive(Clone, Default)]
pub struct Running(Arc<Mutex<Md5>>);

impl Running {
    pub fn hex(&self) -> String {
        hex(&self.0.lock().unwrap().clone().finalize())
    }
}

/// Passes `body` through unchanged while hashing it.
pub fn tap(body: ByteStream, h: &Running) -> ByteStream {
    let h = h.0.clone();
    Box::pin(body.inspect(move |chunk| {
        if let Ok(c) = chunk {
            h.lock().unwrap().update(c);
        }
    }))
}

/// Reads a stream to its end and returns its MD5 (re-reading a copy on this device's disk).
pub async fn md5_stream(mut body: ByteStream) -> std::io::Result<String> {
    let mut h = Md5::new();
    while let Some(c) = body.next().await {
        h.update(c?);
    }
    Ok(hex(&h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Hashes;

    #[test]
    fn md5s_come_from_hashes_or_plain_etags() {
        let caps = crate::storage::s3::s3_caps("aws", crate::storage::s3::Quirks::for_provider("aws"));
        let e = Entry { etag: Some("\"5D41402ABC4B2A76B9719D911017C592\"".into()), ..Default::default() };
        assert_eq!(md5_of(&e, &caps).as_deref(), Some("5d41402abc4b2a76b9719d911017c592"));
        let multi = Entry { etag: Some("5d41402abc4b2a76b9719d911017c592-3".into()), ..Default::default() };
        assert_eq!(md5_of(&multi, &caps), None);
        // Kybl Storage encrypts at rest: its ETags say nothing about the content
        let kybl = crate::storage::s3::s3_caps("kybl", crate::storage::s3::Quirks::for_provider("kybl"));
        assert_eq!(md5_of(&e, &kybl), None);
        let given = Entry { hashes: Hashes { md5: Some("5D41402ABC4B2A76B9719D911017C592".into()), ..Default::default() }, ..Default::default() };
        assert_eq!(md5_of(&given, &Capabilities::default()).as_deref(), Some("5d41402abc4b2a76b9719d911017c592"));
        // base64 (as Azure and Google Cloud send it) is never lowercased into a "hash"
        let b64 = Entry { hashes: Hashes { md5: Some("XUFAKrxLKna5cZ2REBfFkg==".into()), ..Default::default() }, ..Default::default() };
        assert_eq!(md5_of(&b64, &Capabilities::default()), None);
        let short = Entry { hashes: Hashes { md5: Some("ABC".into()), ..Default::default() }, ..Default::default() };
        assert_eq!(md5_of(&short, &Capabilities::default()), None);
    }

    #[test]
    fn tapping_hashes_what_passes() {
        tauri::async_runtime::block_on(async {
            let chunks: Vec<std::io::Result<bytes::Bytes>> = vec![Ok("hel".into()), Ok("lo".into())];
            let h = Running::default();
            let out = md5_stream(tap(Box::pin(futures_util::stream::iter(chunks)), &h)).await.unwrap();
            assert_eq!(out, "5d41402abc4b2a76b9719d911017c592");
            assert_eq!(h.hex(), out);
        });
    }
}
