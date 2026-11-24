//! Checking a file once it has been uploaded or downloaded (Settings → Transfers → "Verify files
//! after copying"): the size always, and with "Checksum when available" a content hash wherever
//! both sides can give one cheaply.
//!
//! | where | hash compared with the local file |
//! |---|---|
//! | S3, one-request upload | the ETag (the MD5) |
//! | S3, multipart | the ETag: the MD5 of the parts' MD5s with "-N", worked out locally with the same part size (known for an upload; for a download the usual part sizes are tried, and a size match is all it says when none fits) |
//! | S3 with SSE-KMS / SSE-C, Kybl Storage (encrypted at rest) | none: their ETags aren't MD5s of the content, so size only |
//! | Google Drive | `md5Checksum` |
//! | Dropbox | `content_hash` |
//! | OneDrive | `quickXorHash` (or `sha256Hash` where the account gives it) |
//! | SFTP | `sha256sum` / `shasum` / `md5sum` run on the server over SSH, when the account may run commands |
//! | FTP, WebDAV, this Mac | none: size only |
//!
//! A mismatch fails the transfer with the reason; a size-only check when a checksum was asked for
//! is reported as such (the Done list shows what was checked).

use std::{io::Read, path::Path};

use md5::{Digest, Md5};
use tauri::{AppHandle, Manager};

use crate::{
    state::AppState,
    storage::{extras::hashes, registry, Conn, HashKind},
    tuning::VerifyMode,
};

/// What the other side says about the file.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct Remote {
    pub size: Option<u64>,
    /// a real MD5 of the content (lowercase hex)
    pub md5: Option<String>,
    /// an S3 multipart ETag: (MD5 of the part MD5s, number of parts)
    pub multipart: Option<(String, u64)>,
    /// the part size of that multipart upload, when known (our own upload)
    pub part_size: Option<u64>,
    pub sha256: Option<String>,
    /// base64, as OneDrive gives it
    pub quickxor: Option<String>,
    pub dropbox: Option<String>,
}

/// The local file's hashes that can be compared with `Remote`.
#[derive(Default, Debug, PartialEq)]
pub struct Local {
    pub md5: Option<String>,
    /// (part size, multipart ETag "<hex>-<n>") for each part size tried
    pub multipart: Vec<(u64, String)>,
    pub sha256: Option<String>,
    pub quickxor: Option<String>,
    pub dropbox: Option<String>,
}

/// What was checked: "size", "md5", "etag" (an S3 multipart ETag), "sha256", "quickxor", "dropbox".
pub type Checked = &'static str;

pub fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Reads an S3 ETag: a plain MD5, or a multipart one ("<md5 of part md5s>-<parts>").
pub fn read_etag(etag: &str) -> (Option<String>, Option<(String, u64)>) {
    let t = etag.trim().trim_matches('"').to_ascii_lowercase();
    match t.split_once('-') {
        Some((h, n)) if is_hex(h, 32) => match n.parse::<u64>() {
            Ok(n) if n >= 1 => (None, Some((h.to_string(), n))),
            _ => (None, None),
        },
        None if is_hex(&t, 32) => (Some(t), None),
        _ => (None, None),
    }
}

/// Part sizes a `parts`-part upload of `total` bytes may have used: the usual ones (Kybl's own,
/// the AWS tools' 8 MiB, 5 MiB, and round MiB sizes) that split the file into exactly that many.
pub fn candidate_part_sizes(total: u64, parts: u64) -> Vec<u64> {
    const MIB: u64 = 1024 * 1024;
    if parts <= 1 {
        // one part: its size doesn't change the ETag
        return vec![total.max(1)];
    }
    let mut c = vec![crate::multipart::part_size_for(total), crate::storage::s3_stream::part_size(Some(total))];
    c.extend([5, 8, 16, 32, 64, 100, 128, 256, 512, 1024].map(|m| m * MIB));
    // the smallest whole MiB giving that many parts (tools that divide the file evenly)
    c.push(total.div_ceil(parts).div_ceil(MIB) * MIB);
    c.push(total.div_ceil(parts));
    let mut out = Vec::new();
    for p in c {
        if p > 0 && total.div_ceil(p) == parts && !out.contains(&p) {
            out.push(p);
        }
    }
    out.truncate(6);
    out
}

/// Which local hashes to work out for `r` (a `total`-byte file).
fn wanted(r: &Remote, total: u64) -> (bool, Vec<u64>, bool, bool, bool) {
    let parts = match (&r.multipart, r.part_size) {
        (Some(_), Some(p)) => vec![p],
        (Some((_, n)), None) => candidate_part_sizes(total, *n),
        _ => vec![],
    };
    (r.md5.is_some(), parts, r.sha256.is_some(), r.quickxor.is_some(), r.dropbox.is_some())
}

/// Hashes the local file in one read, only what `r` can be compared with.
pub fn hash_file(path: &Path, r: &Remote) -> std::io::Result<Local> {
    let total = std::fs::metadata(path)?.len();
    let (want_md5, part_sizes, want_sha, want_qx, want_dbx) = wanted(r, total);
    let mut md5 = want_md5.then(Md5::new);
    let mut sha = want_sha.then(|| ring::digest::Context::new(&ring::digest::SHA256));
    let mut qx = want_qx.then(hashes::QuickXor::new);
    let mut dbx = want_dbx.then(hashes::DropboxHash::new);
    // per part size: (MD5 of the current part, bytes in it, the part MD5s so far, parts)
    let mut multi: Vec<(u64, Md5, u64, Md5, u64)> = part_sizes.iter().map(|&p| (p, Md5::new(), 0, Md5::new(), 0)).collect();
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        if let Some(h) = md5.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = sha.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = qx.as_mut() {
            h.update(chunk);
        }
        if let Some(h) = dbx.as_mut() {
            h.update(chunk);
        }
        for (size, part, in_part, all, count) in multi.iter_mut() {
            let mut rest = chunk;
            while !rest.is_empty() {
                let take = ((*size - *in_part) as usize).min(rest.len());
                part.update(&rest[..take]);
                *in_part += take as u64;
                rest = &rest[take..];
                if *in_part == *size {
                    all.update(std::mem::take(part).finalize());
                    *in_part = 0;
                    *count += 1;
                }
            }
        }
    }
    let multipart = multi
        .into_iter()
        .map(|(size, part, in_part, mut all, mut count)| {
            if in_part > 0 || count == 0 {
                all.update(part.finalize());
                count += 1;
            }
            (size, format!("{}-{count}", hex(&all.finalize())))
        })
        .collect();
    Ok(Local {
        md5: md5.map(|h| hex(&h.finalize())),
        multipart,
        sha256: sha.map(|h| hex(h.finish().as_ref())),
        quickxor: qx.map(|h| h.finish_base64()),
        dropbox: dbx.map(|h| h.finish()),
    })
}

/// The verdict: what was checked, or why the copy doesn't match.
pub fn judge(r: &Remote, l: &Local, local_size: u64) -> Result<Checked, String> {
    if let Some(s) = r.size
        && s != local_size
    {
        return Err(format!("The sizes don't match: {local_size} bytes here, {s} on the server."));
    }
    let differ = |what: &str| Err(format!("The {what} checksums don't match, so the copy isn't the same as the original."));
    if let (Some(a), Some(b)) = (&r.sha256, &l.sha256) {
        return if a.eq_ignore_ascii_case(b) { Ok("sha256") } else { differ("SHA-256") };
    }
    if let (Some(a), Some(b)) = (&r.md5, &l.md5) {
        return if a.eq_ignore_ascii_case(b) { Ok("md5") } else { differ("MD5") };
    }
    if let Some((h, n)) = &r.multipart {
        let want = format!("{h}-{n}");
        let hit = l.multipart.iter().any(|(_, e)| e.eq_ignore_ascii_case(&want));
        match (hit, r.part_size) {
            (true, _) => return Ok("etag"),
            // our own upload: the part size is known, so a different ETag is a different file
            (false, Some(_)) if !l.multipart.is_empty() => return differ("ETag"),
            // someone else's upload with a part size none of the usual ones: can't tell
            _ => {}
        }
    }
    if let (Some(a), Some(b)) = (&r.quickxor, &l.quickxor) {
        return if a == b { Ok("quickxor") } else { differ("QuickXor") };
    }
    if let (Some(a), Some(b)) = (&r.dropbox, &l.dropbox) {
        return if a.eq_ignore_ascii_case(b) { Ok("dropbox") } else { differ("Dropbox content hash") };
    }
    Ok("size")
}

/// What the other side says about the file at `bucket`/`key`, hashes only for a checksum check.
/// `part_size`: the part size of our own multipart upload of it.
async fn remote(app: &AppHandle, conn: &Conn, profile_id: &str, bucket: &str, key: &str, checksum: bool, part_size: Option<u64>) -> Result<Remote, String> {
    let state = app.state::<AppState>();
    match conn {
        Conn::S3(client) => {
            // a pooled connection that died without a word would leave this waiting for as long
            // as the system takes to notice: a HEAD gets a minute
            let head = tokio::time::timeout(std::time::Duration::from_secs(60), client.head_object().bucket(bucket).key(key).send())
                .await
                .map_err(|_| "The server didn't answer in time.".to_string())?
                .map_err(crate::state::sdk_err)?;
            let mut r = Remote { size: head.content_length().map(|n| n.max(0) as u64), ..Default::default() };
            // KMS and customer-key encryption make ETags that aren't MD5s of the content, and so
            // do providers encrypting at rest (Kybl Storage: its capabilities say no MD5s)
            let encrypted = head.sse_customer_algorithm().is_some()
                || head.server_side_encryption().is_some_and(|s| s.as_str().starts_with("aws:kms"));
            let md5_etags = registry::open(app, &state, profile_id).await.map(|s| s.caps().hashes.contains(&HashKind::Md5)).unwrap_or(false);
            if checksum && md5_etags && !encrypted {
                let (md5, multipart) = read_etag(head.e_tag().unwrap_or_default());
                r.md5 = md5;
                r.part_size = multipart.as_ref().and(part_size);
                r.multipart = multipart;
            }
            Ok(r)
        }
        Conn::Other(s) => {
            let e = s.stat(bucket, key).await?.ok_or("The file isn't on the server.")?;
            let mut r = Remote { size: Some(e.size.max(0) as u64), ..Default::default() };
            if !checksum {
                return Ok(r);
            }
            let caps = s.caps();
            r.md5 = e.hashes.md5.as_deref().filter(|m| is_hex(m, 32)).map(str::to_ascii_lowercase);
            if r.md5.is_none() && caps.hashes.contains(&HashKind::Md5) {
                r.md5 = e.etag.as_deref().map(|t| t.trim_matches('"').to_ascii_lowercase()).filter(|t| is_hex(t, 32));
            }
            r.sha256 = e.hashes.sha256.as_deref().filter(|h| is_hex(h, 64)).map(str::to_ascii_lowercase);
            r.quickxor = e.hashes.quickxor.clone().filter(|h| !h.is_empty());
            r.dropbox = e.hashes.dropbox.as_deref().filter(|h| is_hex(h, 64)).map(str::to_ascii_lowercase);
            if r.md5.is_none() && r.sha256.is_none() && r.quickxor.is_none() && r.dropbox.is_none() {
                match s.remote_hash(bucket, key, e.size.max(0) as u64).await {
                    Ok(Some((HashKind::Sha256, h))) => r.sha256 = Some(h),
                    Ok(Some((HashKind::Md5, h))) => r.md5 = Some(h),
                    _ => {}
                }
            }
            Ok(r)
        }
    }
}

/// Why a check didn't pass: only a `Mismatch` says the copy is different; `Unverified` means the
/// check itself couldn't run (network, a refused HEAD, the local file unreadable), so the copy
/// may well be fine and must not be thrown away.
#[derive(Debug, Clone, PartialEq)]
pub enum CheckErr {
    Unverified(String),
    Mismatch(String),
}

impl std::fmt::Display for CheckErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckErr::Unverified(e) => write!(f, "Couldn't check the copy: {e}"),
            CheckErr::Mismatch(e) => f.write_str(e),
        }
    }
}

/// Checks a transferred file as the settings ask. Ok(None): not checked (verify is off).
pub async fn check(app: &AppHandle, conn: &Conn, profile_id: &str, bucket: &str, key: &str, local: &Path, part_size: Option<u64>) -> Result<Option<Checked>, CheckErr> {
    let mode = crate::tuning::verify_mode();
    if mode == VerifyMode::Off {
        return Ok(None);
    }
    let checksum = mode == VerifyMode::Checksum;
    let unverified = |e: String| CheckErr::Unverified(e);
    let local_size = tokio::fs::metadata(local).await.map_err(|e| unverified(e.to_string()))?.len();
    let r = remote(app, conn, profile_id, bucket, key, checksum, part_size).await.map_err(unverified)?;
    let l = if checksum {
        let (path, rr) = (local.to_path_buf(), r.clone());
        tokio::task::spawn_blocking(move || hash_file(&path, &rr)).await.map_err(|e| unverified(e.to_string()))?.map_err(|e| unverified(e.to_string()))?
    } else {
        Local::default()
    };
    judge(&r, &l, local_size).map(Some).map_err(CheckErr::Mismatch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md5_hex(b: &[u8]) -> String {
        hex(&Md5::digest(b))
    }

    /// The multipart ETag the way S3 makes it: MD5 of the parts' binary MD5s, "-N".
    fn s3_multipart_etag(data: &[u8], part: usize) -> String {
        let mut all = Vec::new();
        let chunks: Vec<&[u8]> = data.chunks(part).collect();
        for c in &chunks {
            all.extend_from_slice(&Md5::digest(c));
        }
        format!("{}-{}", md5_hex(&all), chunks.len())
    }

    fn tmp_file(data: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("kybl-verify-{}", uuid::Uuid::new_v4()));
        std::fs::write(&p, data).unwrap();
        p
    }

    #[test]
    fn etags_are_read_as_md5s_or_multipart() {
        assert_eq!(read_etag("\"5D41402ABC4B2A76B9719D911017C592\""), (Some("5d41402abc4b2a76b9719d911017c592".into()), None));
        assert_eq!(read_etag("5d41402abc4b2a76b9719d911017c592-12"), (None, Some(("5d41402abc4b2a76b9719d911017c592".into(), 12))));
        for odd in ["", "abc", "W/\"x\"", "5d41402abc4b2a76b9719d911017c592-", "5d41402abc4b2a76b9719d911017c592-0", "zz41402abc4b2a76b9719d911017c592"] {
            assert_eq!(read_etag(odd), (None, None), "{odd:?}");
        }
    }

    #[test]
    fn the_multipart_etag_is_worked_out_like_s3_does() {
        // 3 parts of 1000 bytes and a short last one; the hashing reads 1 MiB at a time, so a
        // part size not dividing that tests parts spanning reads
        let data: Vec<u8> = (0..3_500u32).map(|i| (i * 7 % 251) as u8).collect();
        let path = tmp_file(&data);
        let r = Remote { multipart: Some(("x".into(), 4)), part_size: Some(1000), ..Default::default() };
        let l = hash_file(&path, &r).unwrap();
        assert_eq!(l.multipart, vec![(1000, s3_multipart_etag(&data, 1000))]);
        // a file exactly filling its parts has no empty extra part
        let even: Vec<u8> = vec![9; 3_000];
        let p2 = tmp_file(&even);
        let l2 = hash_file(&p2, &Remote { multipart: Some(("x".into(), 3)), part_size: Some(1000), ..Default::default() }).unwrap();
        assert_eq!(l2.multipart[0].1, s3_multipart_etag(&even, 1000));
        assert!(l2.multipart[0].1.ends_with("-3"));
        // and across the 1 MiB read size
        let big: Vec<u8> = (0..(3 << 20) + 17).map(|i| (i % 253) as u8).collect();
        let p3 = tmp_file(&big);
        let part = (1 << 20) + 4096;
        let l3 = hash_file(&p3, &Remote { multipart: Some(("x".into(), 3)), part_size: Some(part as u64), md5: Some("x".into()), ..Default::default() }).unwrap();
        assert_eq!(l3.multipart[0].1, s3_multipart_etag(&big, part));
        assert_eq!(l3.md5.as_deref(), Some(md5_hex(&big).as_str()));
        for p in [path, p2, p3] {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn part_sizes_tried_for_a_download_give_that_many_parts() {
        const MIB: u64 = 1024 * 1024;
        let total = 100 * MIB + 5;
        let c = candidate_part_sizes(total, 13);
        assert!(c.contains(&(8 * MIB)), "the AWS tools' 8 MiB: {c:?}");
        assert!(c.iter().all(|p| total.div_ceil(*p) == 13), "{c:?}");
        assert!(c.len() <= 6);
        assert_eq!(candidate_part_sizes(total, 1), vec![total]);
        // Kybl's own uploads (16 MiB parts) are always among them
        let t2 = 50 * MIB;
        assert!(candidate_part_sizes(t2, 4).contains(&(16 * MIB)));
    }

    #[test]
    fn verdicts() {
        let local = Local { md5: Some("aa".into()), sha256: Some("bb".into()), multipart: vec![(10, "cc-2".into())], ..Default::default() };
        // size first
        let r = Remote { size: Some(9), md5: Some("aa".into()), ..Default::default() };
        assert!(judge(&r, &local, 10).unwrap_err().contains("sizes"));
        assert_eq!(judge(&Remote { size: Some(10), ..Default::default() }, &local, 10), Ok("size"));
        assert_eq!(judge(&Remote { size: Some(10), md5: Some("AA".into()), ..Default::default() }, &local, 10), Ok("md5"));
        assert!(judge(&Remote { size: Some(10), md5: Some("ab".into()), ..Default::default() }, &local, 10).is_err());
        // SHA-256 wins over MD5 when both are there
        assert_eq!(judge(&Remote { sha256: Some("bb".into()), md5: Some("zz".into()), ..Default::default() }, &local, 10), Ok("sha256"));
        // multipart: ours (part size known) must match; someone else's that fits no guess is size only
        let ours = Remote { multipart: Some(("cc".into(), 2)), part_size: Some(10), ..Default::default() };
        assert_eq!(judge(&ours, &local, 10), Ok("etag"));
        let ours_bad = Remote { multipart: Some(("dd".into(), 2)), part_size: Some(10), ..Default::default() };
        assert!(judge(&ours_bad, &local, 10).is_err());
        let theirs = Remote { multipart: Some(("dd".into(), 2)), ..Default::default() };
        assert_eq!(judge(&theirs, &local, 10), Ok("size"), "an unknown part size proves nothing");
        // cloud drives
        let qx = Local { quickxor: Some("AAA=".into()), ..Default::default() };
        assert_eq!(judge(&Remote { quickxor: Some("AAA=".into()), ..Default::default() }, &qx, 0), Ok("quickxor"));
        assert!(judge(&Remote { quickxor: Some("AAB=".into()), ..Default::default() }, &qx, 0).is_err());
    }

    #[test]
    fn provider_hashes_are_worked_out_locally_the_same_way() {
        let data = b"hello world";
        let path = tmp_file(data);
        let r = Remote { sha256: Some(String::new()), quickxor: Some(String::new()), dropbox: Some(String::new()), md5: Some(String::new()), ..Default::default() };
        let l = hash_file(&path, &r).unwrap();
        assert_eq!(l.md5.as_deref(), Some("5eb63bbbe01eeed093cb22bb8f5acdc3"));
        assert_eq!(l.sha256.as_deref(), Some("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"));
        assert!(l.quickxor.is_some() && l.dropbox.is_some());
        // nothing asked for: nothing worked out
        assert_eq!(hash_file(&path, &Remote::default()).unwrap(), Local::default());
        let _ = std::fs::remove_file(path);
    }
}
