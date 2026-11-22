//! Uploads to Drive: one multipart request up to 5 MB, a resumable upload session above that.
//! A session goes up in 8 MiB pieces (a multiple of 256 KiB, as Drive requires); after a dropped
//! connection Kybl asks the session how far it got and carries on from there, and a job can
//! resume it later from `ResumeState.upload_id` (the session address, also handed out as the
//! `etag` of each `PartRecord`).

use std::sync::atomic::AtomicBool;

use serde_json::json;

use super::api::{DFile, FILE_FIELDS};
use crate::oauth::http::{backoff, check, enc, read_json, unexpected, Api};
use crate::storage::{extras::{self, Source}, ErrKind, PartRecord, Progress, SResult, StorageError, WriteOpts};

/// Files up to this size go up in one request.
pub const SIMPLE_MAX: u64 = 5 * 1024 * 1024;
const QUANTUM: u64 = 256 * 1024;
const DEFAULT_PIECE: u64 = 8 * 1024 * 1024;
/// Failed pieces in a row before giving up.
const FAILURES: u32 = 5;

pub struct Target<'a> {
    /// the file being replaced (keeps its id, sharing and history)
    pub existing: Option<&'a str>,
    pub parent: &'a str,
    pub name: &'a str,
    pub mime: &'a str,
}

impl Target<'_> {
    fn meta(&self) -> String {
        match self.existing {
            Some(_) => json!({ "mimeType": self.mime }).to_string(),
            None => json!({ "name": self.name, "parents": [self.parent], "mimeType": self.mime }).to_string(),
        }
    }
    fn url(&self, base: &str, kind: &str) -> String {
        let tail = format!("uploadType={kind}&supportsAllDrives=true&fields={}", enc(FILE_FIELDS));
        match self.existing {
            Some(id) => format!("{base}/upload/drive/v3/files/{}?{tail}", enc(id)),
            None => format!("{base}/upload/drive/v3/files?{tail}"),
        }
    }
}

/// Uploads `src`; None when cancelled.
pub async fn upload(api: &Api, base: &str, t: Target<'_>, mut src: Source, opts: &WriteOpts<'_>, progress: Progress<'_>, cancel: &AtomicBool) -> SResult<Option<DFile>> {
    let total = src.len;
    progress(0, total.unwrap_or(0));
    if opts.resume.is_none() && total.is_some_and(|n| n <= SIMPLE_MAX) {
        let bytes = match src.rest(SIMPLE_MAX, cancel).await {
            Err(e) if e.is_cancelled() => return Ok(None),
            r => r?,
        };
        let n = bytes.len() as u64;
        let f = simple(api, base, &t, bytes).await?;
        progress(n, n);
        return Ok(Some(f));
    }
    resumable(api, base, &t, src, opts, progress, cancel).await
}

async fn simple(api: &Api, base: &str, t: &Target<'_>, bytes: bytes::Bytes) -> SResult<DFile> {
    let boundary = format!("kybl-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n{}\r\n--{boundary}\r\ncontent-type: {}\r\n\r\n", t.meta(), t.mime).as_bytes());
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let body = bytes::Bytes::from(body);
    let url = t.url(base, "multipart");
    let ctype = format!("multipart/related; boundary={boundary}");
    let existing = t.existing.is_some();
    api.json(|c| {
        let r = if existing { c.patch(&url) } else { c.post(&url) };
        r.header("content-type", &ctype).body(body.clone())
    })
    .await
}

/// Opens an upload session; its address.
async fn start(api: &Api, base: &str, t: &Target<'_>, total: Option<u64>) -> SResult<String> {
    let url = t.url(base, "resumable");
    let meta = t.meta();
    let existing = t.existing.is_some();
    let res = api
        .ok(|c| {
            let r = if existing { c.patch(&url) } else { c.post(&url) };
            let r = r.header("content-type", "application/json; charset=UTF-8").header("x-upload-content-type", t.mime);
            let r = match total {
                Some(n) => r.header("x-upload-content-length", n),
                None => r,
            };
            r.body(meta.clone())
        })
        .await?;
    res.headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| unexpected(api.kind, "no upload session address"))
}

enum Status {
    /// the server has everything before this byte
    At(u64),
    Done(DFile),
    /// the session expired or never existed
    Gone,
}

/// How far a session got.
async fn status(api: &Api, session: &str, total: Option<u64>) -> SResult<Status> {
    let range = format!("bytes */{}", total.map_or("*".to_string(), |t| t.to_string()));
    let res = api.send(|c| c.put(session).header("content-range", &range).header("content-length", 0)).await?;
    match res.status().as_u16() {
        308 => Ok(Status::At(extras::received_upto(res.headers().get("range").and_then(|v| v.to_str().ok())))),
        200 | 201 => Ok(Status::Done(read_json(api.kind, res).await?)),
        404 | 410 => Ok(Status::Gone),
        _ => Err(check(api.kind, res).await.err().unwrap_or_else(|| unexpected(api.kind, "upload status"))),
    }
}

async fn resumable(api: &Api, base: &str, t: &Target<'_>, mut src: Source, opts: &WriteOpts<'_>, progress: Progress<'_>, cancel: &AtomicBool) -> SResult<Option<DFile>> {
    let total = src.len;
    let piece = opts.part_size.map(|p| (p / QUANTUM).max(1) * QUANTUM).unwrap_or(DEFAULT_PIECE);
    let mut offset = 0u64;
    let mut session = None;
    if let Some(rs) = &opts.resume {
        match status(api, &rs.upload_id, total).await? {
            Status::Done(f) => return Ok(Some(f)),
            Status::At(o) => {
                session = Some(rs.upload_id.clone());
                offset = o;
            }
            Status::Gone => {}
        }
    }
    let mut session = match session {
        Some(s) => s,
        None => start(api, base, t, total).await?,
    };
    let mut restarted = false;
    let mut failures = 0u32;
    let abort = |session: String| async move {
        let _ = api.send(|c| c.delete(&session)).await;
        Ok(None)
    };
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return abort(session).await;
        }
        src.seek(offset).await?;
        let chunk = match src.chunk(piece as usize, cancel).await {
            Err(e) if e.is_cancelled() => return abort(session).await,
            r => r?,
        };
        let end = offset + chunk.len() as u64;
        if let Some(t) = total
            && chunk.len() as u64 != piece
            && end < t
        {
            return Err(StorageError::other("The file got shorter while it was uploading. Try again."));
        }
        let last = match total {
            Some(t) => end >= t,
            None => (chunk.len() as u64) < piece,
        };
        let range = if chunk.is_empty() {
            format!("bytes */{end}")
        } else {
            let of = match total {
                Some(t) => t.to_string(),
                None if last => end.to_string(),
                None => "*".into(),
            };
            format!("bytes {offset}-{}/{of}", end - 1)
        };
        let len = chunk.len();
        let sent = api.send(|c| c.put(&session).header("content-range", &range).header("content-length", len).body(chunk.clone())).await;
        let res = match sent {
            Ok(r) => r,
            Err(e) if e.kind == ErrKind::Network && failures < FAILURES => {
                failures += 1;
                tokio::time::sleep(backoff(failures)).await;
                match status(api, &session, total).await? {
                    Status::Done(f) => return Ok(Some(f)),
                    Status::At(o) => offset = o,
                    Status::Gone => return Err(StorageError::other("Google Drive dropped the upload. Try again.")),
                }
                continue;
            }
            Err(e) => return Err(e),
        };
        match res.status().as_u16() {
            200 | 201 => {
                progress(end, end);
                return Ok(Some(read_json(api.kind, res).await?));
            }
            308 => {
                let got = extras::received_upto(res.headers().get("range").and_then(|v| v.to_str().ok()));
                if chunk.is_empty() || (got <= offset && failures >= FAILURES) {
                    return Err(StorageError::other("Google Drive didn't take the end of the upload. Try again."));
                }
                if got <= offset {
                    // nothing of this piece arrived: send it again
                    failures += 1;
                } else {
                    failures = 0;
                    if let Some(f) = opts.on_part {
                        f(PartRecord { number: (offset / piece) as u32 + 1, size: got - offset, etag: session.clone() });
                    }
                }
                offset = got;
                progress(offset, total.unwrap_or(offset));
            }
            404 | 410 if !restarted => {
                restarted = true;
                session = start(api, base, t, total).await?;
                offset = 0;
            }
            s if s >= 500 && failures < FAILURES => {
                failures += 1;
                tokio::time::sleep(backoff(failures)).await;
                match status(api, &session, total).await? {
                    Status::Done(f) => return Ok(Some(f)),
                    Status::At(o) => offset = o,
                    Status::Gone => return Err(StorageError::other("Google Drive dropped the upload. Try again.")),
                }
            }
            _ => return Err(check(api.kind, res).await.err().unwrap_or_else(|| unexpected(api.kind, "upload"))),
        }
    }
}
