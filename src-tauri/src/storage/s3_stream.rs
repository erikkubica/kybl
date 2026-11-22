//! Uploading to S3 from a stream that isn't a local file (copying between connections).
//!
//! - **Integrity:** every request that carries bytes (the single PUT of a small file and every
//!   UploadPart) sends `Content-MD5`, so the server refuses a body damaged on the way. This works
//!   where ETags aren't MD5s (Kybl Storage encrypts at rest with SSE-C). Where they are, the
//!   finished object's ETag is checked too (the MD5, or for multipart the MD5 of the part MD5s
//!   with "-N").
//! - **Bounded memory:** part buffers are taken from one byte budget shared by every upload
//!   ([`BUDGET_BYTES`]: 256 MiB on computers, 64 MiB on phones). A part is kept in memory until
//!   the server has it, so a failed part is retried without reading the source again.
//! - **Parallel and resumable:** with a known length and a `reopen` that can start the source at
//!   any offset, each part is read on its own (`reopen(offset)`, reading exactly that part) and
//!   several are in flight at once. Such an upload can carry on later from `WriteOpts::resume`:
//!   the parts the server confirms (`ListParts`) are skipped. Without `reopen` the stream is read
//!   once, in order, and an interrupted upload starts over.
//! - **Who cleans up:** with `WriteOpts::on_part` set the caller is keeping the upload resumable,
//!   so a cancelled or failed upload is left open for it to resume or [`abort`]. Without it, a
//!   cancelled or failed upload is aborted here, so its parts stop costing storage.
//!
//! `on_part` contract: a new upload is announced as part number **0**, with `etag` = the upload id
//! and `size` = the part size; then each part as the server confirms it. Save them as a
//! `ResumeState` to resume.

use std::{
    collections::BTreeMap,
    convert::Infallible,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock,
    },
    task::{Context, Poll},
    time::Duration,
};

use aws_sdk_s3::{
    primitives::{ByteStream as S3Body, SdkBody},
    types::{CompletedMultipartUpload, CompletedPart},
    Client,
};
use base64::Engine;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use http_body::{Body, Frame, SizeHint};
use md5::{Digest, Md5};
use tokio::sync::{Semaphore, SemaphorePermit};

use super::{s3::S3Backend, ByteStream, Entry, ErrKind, PartRecord, Progress, Reopen, SResult, StorageError, WriteOpts, WriteOutcome};
use crate::{
    multipart::{part_plan, part_size_for, CHUNK, SINGLE_PUT_LIMIT},
    state::sdk_err,
    tuning::LIMITER,
};

/// Memory all stream uploads may hold in part buffers at once.
pub const BUDGET_BYTES: u64 = if cfg!(any(target_os = "android", target_os = "ios")) { 64 << 20 } else { 256 << 20 };
/// S3's limits on parts.
const MIN_PART: u64 = 5 << 20;
const MAX_PART: u64 = 5 << 30;
const MAX_PARTS: u64 = 10_000;
/// Part size when the length isn't known: 64 MiB parts allow 640 GB.
const UNKNOWN_LEN_PART: u64 = 64 << 20;
const PART_TRIES: u32 = 3;

/// The budget, in KiB (a semaphore counts in u32 per acquire).
static BUDGET: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new((BUDGET_BYTES >> 10) as usize));

/// Holds `n` bytes of the budget while a buffer of that size lives. A buffer bigger than the whole
/// budget (huge parts of multi-terabyte files) takes all of it rather than waiting forever.
async fn reserve(n: u64) -> SemaphorePermit<'static> {
    let kib = n.min(BUDGET_BYTES).div_ceil(1024).max(1) as u32;
    BUDGET.acquire_many(kib).await.expect("the budget is never closed")
}

/// The part size for a stream of `len` bytes: 16 MiB, bigger for files that would need more than
/// S3's 10,000 parts. Callers that read parts themselves use this to cut the same parts.
pub fn part_size(len: Option<u64>) -> u64 {
    match len {
        Some(n) => fit_part(part_size_for(n), n),
        None => UNKNOWN_LEN_PART,
    }
}

fn fit_part(part: u64, len: u64) -> u64 {
    part.clamp(MIN_PART, MAX_PART).max(len.div_ceil(MAX_PARTS)).min(MAX_PART)
}

fn md5_hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn is_md5_hex(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn bare(etag: &str) -> String {
    etag.trim_matches('"').to_ascii_lowercase()
}

/// The ETag S3 gives a multipart object: the MD5 of the parts' MD5s, then "-" and the count.
/// None when a part's ETag isn't an MD5 (encrypting servers).
pub fn multipart_etag(part_etags: &[String]) -> Option<String> {
    let mut h = Md5::new();
    for e in part_etags {
        let b = bare(e);
        if !is_md5_hex(&b) {
            return None;
        }
        h.update(hex_bytes(&b)?);
    }
    Some(format!("{}-{}", md5_hex(&h.finalize()), part_etags.len()))
}

fn upload_gone(e: &StorageError) -> bool {
    e.to_string().contains("NoSuchUpload")
}

fn damaged() -> StorageError {
    StorageError::other("The copy didn't arrive intact, so it will be sent again.")
}

/// Aborts an upload (a cancelled job, or one that won't be resumed). Errors are ignored: an
/// upload the server already dropped is just as gone.
pub async fn abort(s3: &S3Backend, bucket: &str, key: &str, upload_id: &str) {
    let _ = s3.client().abort_multipart_upload().bucket(bucket).key(key).upload_id(upload_id).send().await;
}

// ---------------------------------------------------------------- request bodies

/// A part held in memory, handed to the network a chunk at a time: counts what went out (for
/// progress) and holds back while the bandwidth cap asks it to.
struct PartBody {
    data: Bytes,
    pos: usize,
    sent: Arc<AtomicU64>,
    wait: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl Body for PartBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if let Some(w) = self.wait.as_mut() {
            if w.as_mut().poll(cx).is_pending() {
                return Poll::Pending;
            }
            self.wait = None;
        }
        if self.pos >= self.data.len() {
            return Poll::Ready(None);
        }
        let end = (self.pos + CHUNK).min(self.data.len());
        let chunk = self.data.slice(self.pos..end);
        self.pos = end;
        self.sent.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        let pause = LIMITER.take(chunk.len());
        if !pause.is_zero() {
            self.wait = Some(Box::pin(tokio::time::sleep(pause)));
        }
        Poll::Ready(Some(Ok(Frame::data(chunk))))
    }

    fn is_end_stream(&self) -> bool {
        self.pos >= self.data.len()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact((self.data.len() - self.pos) as u64)
    }
}

/// A retryable request body over `data`; a retry starts the count over.
fn part_body(data: Bytes, sent: Arc<AtomicU64>) -> S3Body {
    S3Body::new(SdkBody::retryable(move || {
        sent.store(0, Ordering::Relaxed);
        SdkBody::from_body_1_x(PartBody { data: data.clone(), pos: 0, sent: sent.clone(), wait: None })
    }))
}

/// Reads up to `n` bytes (fewer only at the end of the stream). None when cancelled.
async fn read_up_to(body: &mut ByteStream, n: u64, cancel: &AtomicBool) -> SResult<Option<Bytes>> {
    let mut buf = BytesMut::with_capacity(n.min(UNKNOWN_LEN_PART) as usize);
    while (buf.len() as u64) < n {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let Some(chunk) = body.next().await else { break };
        let chunk = chunk?;
        let room = n as usize - buf.len();
        if chunk.len() > room {
            // a source that ignored the end of a range: keep only what was asked for
            buf.extend_from_slice(&chunk[..room]);
        } else {
            buf.extend_from_slice(&chunk);
        }
    }
    Ok(Some(buf.freeze()))
}

// ---------------------------------------------------------------- requests

async fn put_single(
    client: &Client,
    bucket: &str,
    key: &str,
    content_type: &str,
    data: Bytes,
    etag_is_md5: bool,
    sent: Arc<AtomicU64>,
) -> SResult<String> {
    let digest = Md5::digest(&data);
    let out = client
        .put_object()
        .bucket(bucket)
        .key(key)
        .content_type(content_type)
        .content_length(data.len() as i64)
        .content_md5(base64::engine::general_purpose::STANDARD.encode(digest))
        .body(part_body(data, sent))
        .send()
        .await
        .map_err(sdk_err)?;
    let etag = out.e_tag().map(bare).unwrap_or_default();
    if etag_is_md5 && is_md5_hex(&etag) && etag != md5_hex(&digest) {
        return Err(damaged());
    }
    Ok(etag)
}

/// One part, tried up to [`PART_TRIES`] times with a growing pause. Returns its ETag.
#[allow(clippy::too_many_arguments)]
async fn put_part(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
    n: i32,
    data: Bytes,
    sent: &Arc<AtomicU64>,
    cancel: &AtomicBool,
) -> SResult<Option<String>> {
    let md5 = base64::engine::general_purpose::STANDARD.encode(Md5::digest(&data));
    let mut attempt = 0;
    loop {
        attempt += 1;
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let r = client
            .upload_part()
            .bucket(bucket)
            .key(key)
            .upload_id(upload_id)
            .part_number(n)
            .content_length(data.len() as i64)
            .content_md5(&md5)
            .body(part_body(data.clone(), sent.clone()))
            .send()
            .await;
        match r {
            Ok(out) => return Ok(Some(out.e_tag().unwrap_or_default().to_string())),
            Err(e) => {
                let e: StorageError = sdk_err(e).into();
                if attempt >= PART_TRIES || upload_gone(&e) {
                    return Err(e);
                }
                sent.store(0, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
        }
    }
}

/// The parts the server has for an upload: number → (size, ETag).
async fn list_parts(client: &Client, bucket: &str, key: &str, upload_id: &str) -> SResult<BTreeMap<i32, (u64, String)>> {
    let mut parts = BTreeMap::new();
    let mut marker: Option<String> = None;
    loop {
        let out = client
            .list_parts()
            .bucket(bucket)
            .key(key)
            .upload_id(upload_id)
            .set_part_number_marker(marker.clone())
            .send()
            .await
            .map_err(sdk_err)?;
        for p in out.parts() {
            if let (Some(n), Some(etag)) = (p.part_number(), p.e_tag()) {
                parts.insert(n, (p.size().unwrap_or(0).max(0) as u64, etag.to_string()));
            }
        }
        match out.next_part_number_marker() {
            Some(m) if out.is_truncated().unwrap_or(false) && Some(m) != marker.as_deref() => marker = Some(m.to_string()),
            _ => return Ok(parts),
        }
    }
}

/// Reports `base + bytes in flight` every 150 ms while `fut` runs.
async fn ticking<T>(fut: impl Future<Output = T>, report: impl Fn()) -> T {
    tokio::pin!(fut);
    let mut tick = tokio::time::interval(Duration::from_millis(150));
    loop {
        tokio::select! {
            out = &mut fut => return out,
            _ = tick.tick() => report(),
        }
    }
}

// ---------------------------------------------------------------- the upload

/// Uploads `body` (of `len` bytes, when known) to `bucket`/`key`; see the module notes.
#[allow(clippy::too_many_arguments)]
pub async fn upload_stream(
    s3: &S3Backend,
    bucket: &str,
    key: &str,
    len: Option<u64>,
    mut body: ByteStream,
    reopen: Option<Reopen>,
    mut opts: WriteOpts<'_>,
    progress: Progress<'_>,
    cancel: &Arc<AtomicBool>,
) -> SResult<WriteOutcome> {
    let client = s3.client().clone();
    let etag_is_md5 = s3.quirks().etag_is_md5;
    let content_type = opts.content_type.clone().unwrap_or_else(|| mime_guess::from_path(key).first_or_octet_stream().to_string());
    let on_part = opts.on_part;
    let tracked = on_part.is_some();
    let announce = move |p: PartRecord| {
        if let Some(f) = on_part {
            f(p)
        }
    };
    progress(0, len.unwrap_or(0));

    // small and of known length: one request
    if let Some(n) = len
        && n <= SINGLE_PUT_LIMIT
    {
        if let Some(rs) = opts.resume.take() {
            abort(s3, bucket, key, &rs.upload_id).await;
        }
        let _permit = reserve(n).await;
        let Some(data) = read_up_to(&mut body, n, cancel).await? else { return Ok(WriteOutcome::Cancelled) };
        if data.len() as u64 != n {
            return Err(StorageError::other("The file changed while it was being copied.")
                .with_detail(format!("expected {n} bytes, read {}", data.len())));
        }
        let sent = Arc::new(AtomicU64::new(0));
        let r = ticking(put_single(&client, bucket, key, &content_type, data, etag_is_md5, sent.clone()), || {
            progress(sent.load(Ordering::Relaxed).min(n), n)
        });
        let etag = tokio::select! {
            r = r => r?,
            _ = wait_cancel(cancel) => return Ok(WriteOutcome::Cancelled),
        };
        progress(n, n);
        return Ok(WriteOutcome::Done(done_entry(s3, bucket, key, n, etag).await));
    }

    let part = match (opts.part_size, len) {
        (Some(p), Some(n)) => fit_part(p, n),
        (Some(p), None) => p.clamp(MIN_PART, MAX_PART),
        (None, l) => part_size(l),
    };
    let parallel = matches!((&reopen, len), (Some(_), Some(_)));

    // an earlier attempt to carry on with: keep the parts the server confirms
    let mut parts: BTreeMap<i32, (u64, String)> = BTreeMap::new();
    let mut upload_id: Option<String> = None;
    if let Some(rs) = opts.resume.take() {
        if parallel && rs.part_size == part {
            match list_parts(&client, bucket, key, &rs.upload_id).await {
                Ok(have) => {
                    let plan = part_plan(len.unwrap_or(0), part);
                    for (n, _, plen) in plan {
                        if let Some((size, etag)) = have.get(&n)
                            && *size == plen
                        {
                            parts.insert(n, (plen, etag.clone()));
                        }
                    }
                    upload_id = Some(rs.upload_id);
                }
                Err(e) if upload_gone(&e) => {}
                Err(e) => return Err(e),
            }
        } else {
            // can't continue it (the source can't be read from the middle, or parts changed)
            abort(s3, bucket, key, &rs.upload_id).await;
        }
    }

    let result = if parallel {
        let reopen = Arc::new(reopen.expect("checked"));
        let n = len.expect("checked");
        if upload_id.is_none() {
            let id = create(&client, bucket, key, &content_type).await?;
            announce(PartRecord { number: 0, size: part, etag: id.clone() });
            upload_id = Some(id);
        }
        let id = upload_id.clone().expect("set above");
        send_parallel(&client, bucket, key, &id, n, part, reopen, &mut parts, opts.parts_in_flight, &announce, progress, cancel).await
    } else {
        send_sequential(&client, bucket, key, &content_type, &mut body, len, part, etag_is_md5, &mut upload_id, &mut parts, opts.parts_in_flight, &announce, progress, cancel)
            .await
    };

    let total = parts.values().map(|p| p.0).sum::<u64>();
    match result {
        Ok(Sent::Done) => {}
        Ok(Sent::Single(etag, n)) => {
            progress(n, n);
            return Ok(WriteOutcome::Done(done_entry(s3, bucket, key, n, etag).await));
        }
        Ok(Sent::Cancelled) => {
            if !tracked && let Some(id) = &upload_id {
                abort(s3, bucket, key, id).await;
            }
            return Ok(WriteOutcome::Cancelled);
        }
        Err(e) => {
            if let Some(id) = &upload_id
                && (!tracked || upload_gone(&e))
            {
                abort(s3, bucket, key, id).await;
            }
            return Err(e);
        }
    }
    let id = upload_id.expect("a multipart upload was made");
    if let Some(n) = len
        && total != n
    {
        if !tracked {
            abort(s3, bucket, key, &id).await;
        }
        return Err(StorageError::other("The file changed while it was being copied.").with_detail(format!("expected {n} bytes, sent {total}")));
    }
    let completed: Vec<CompletedPart> = parts.iter().map(|(n, (_, etag))| CompletedPart::builder().e_tag(etag).part_number(*n).build()).collect();
    let out = client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&id)
        .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(completed)).build())
        .send()
        .await
        .map_err(|e| StorageError::from(sdk_err(e)))?;
    let etag = out.e_tag().map(bare).unwrap_or_default();
    let etags: Vec<String> = parts.values().map(|p| p.1.clone()).collect();
    if etag_is_md5
        && let Some(expected) = multipart_etag(&etags)
        && etag.contains('-')
        && etag != expected
    {
        return Err(damaged().with_detail(format!("ETag {etag}, expected {expected}")));
    }
    progress(total, total);
    Ok(WriteOutcome::Done(done_entry(s3, bucket, key, total, etag).await))
}

enum Sent {
    Done,
    /// short enough for one request after all (a stream of unknown length): (ETag, size)
    Single(String, u64),
    Cancelled,
}

async fn wait_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn create(client: &Client, bucket: &str, key: &str, content_type: &str) -> SResult<String> {
    let out = client.create_multipart_upload().bucket(bucket).key(key).content_type(content_type).send().await.map_err(sdk_err)?;
    out.upload_id().map(str::to_string).ok_or_else(|| StorageError::other("The server didn't start the upload."))
}

/// What the finished object is: from the server when it answers, else what was sent.
async fn done_entry(s3: &S3Backend, bucket: &str, key: &str, size: u64, etag: String) -> Entry {
    use super::Storage;
    match s3.stat(bucket, key).await {
        Ok(Some(e)) => e,
        _ => Entry { key: key.to_string(), size: size as i64, etag: (!etag.is_empty()).then_some(etag), ..Default::default() },
    }
}

fn parts_in_flight(asked: usize) -> usize {
    if asked > 0 { asked } else { crate::tuning::part_concurrency() }.max(1)
}

/// Each missing part read from the source on its own (`reopen(offset)`) and sent, several at once.
#[allow(clippy::too_many_arguments)]
async fn send_parallel(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
    total: u64,
    part: u64,
    reopen: Arc<Reopen>,
    parts: &mut BTreeMap<i32, (u64, String)>,
    asked_in_flight: usize,
    announce: &(dyn Fn(PartRecord) + Send + Sync),
    progress: Progress<'_>,
    cancel: &Arc<AtomicBool>,
) -> SResult<Sent> {
    let mut queue: std::collections::VecDeque<_> = part_plan(total, part).into_iter().filter(|p| !parts.contains_key(&p.0)).collect();
    let mut done: u64 = parts.values().map(|p| p.0).sum();
    let mut running: BTreeMap<i32, (u64, Arc<AtomicU64>)> = BTreeMap::new();
    let mut set = tokio::task::JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_millis(150));
    progress(done, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            set.abort_all();
            return Ok(Sent::Cancelled);
        }
        while set.len() < parts_in_flight(asked_in_flight) {
            let Some((n, offset, plen)) = queue.pop_front() else { break };
            let sent = Arc::new(AtomicU64::new(0));
            running.insert(n, (plen, sent.clone()));
            let (client, bucket, key, upload_id, reopen, cancel) =
                (client.clone(), bucket.to_string(), key.to_string(), upload_id.to_string(), reopen.clone(), cancel.clone());
            set.spawn(async move {
                let _permit = reserve(plen).await;
                let r = read_and_put(&client, &bucket, &key, &upload_id, n, offset, plen, &reopen, &sent, &cancel).await;
                (n, plen, r)
            });
        }
        if set.is_empty() {
            return Ok(Sent::Done);
        }
        tokio::select! {
            joined = set.join_next() => {
                let Some(joined) = joined else { continue };
                let (n, plen, r) = joined.map_err(|e| StorageError::other(e.to_string()))?;
                running.remove(&n);
                match r {
                    Ok(Some(etag)) => {
                        announce(PartRecord { number: n as u32, size: plen, etag: etag.clone() });
                        parts.insert(n, (plen, etag));
                        done += plen;
                    }
                    Ok(None) => {
                        set.abort_all();
                        return Ok(Sent::Cancelled);
                    }
                    Err(e) => {
                        set.abort_all();
                        return Err(e);
                    }
                }
            }
            _ = tick.tick() => {
                let in_flight: u64 = running.values().map(|(l, s)| s.load(Ordering::Relaxed).min(*l)).sum();
                progress((done + in_flight).min(total), total);
            }
        }
    }
}

/// Reads one part from the source and sends it; a failed read is tried again like a failed send.
#[allow(clippy::too_many_arguments)]
async fn read_and_put(
    client: &Client,
    bucket: &str,
    key: &str,
    upload_id: &str,
    n: i32,
    offset: u64,
    len: u64,
    reopen: &Reopen,
    sent: &Arc<AtomicU64>,
    cancel: &AtomicBool,
) -> SResult<Option<String>> {
    let mut attempt = 0;
    let data = loop {
        attempt += 1;
        let read = async {
            let mut s = reopen(offset).await?;
            read_up_to(&mut s, len, cancel).await
        };
        match read.await {
            Ok(None) => return Ok(None),
            Ok(Some(d)) if d.len() as u64 == len => break d,
            Ok(Some(d)) => {
                return Err(StorageError::other("The file changed while it was being copied.")
                    .with_detail(format!("part {n}: expected {len} bytes, read {}", d.len())));
            }
            Err(e) if attempt < PART_TRIES && !matches!(e.kind, ErrKind::NotFound | ErrKind::Conflict | ErrKind::PermissionDenied) => {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
            Err(e) => return Err(e),
        }
    };
    put_part(client, bucket, key, upload_id, n, data, sent, cancel).await
}

/// The stream read once, in order: a part buffered, then sent while the next one is read.
#[allow(clippy::too_many_arguments)]
async fn send_sequential(
    client: &Client,
    bucket: &str,
    key: &str,
    content_type: &str,
    body: &mut ByteStream,
    len: Option<u64>,
    part: u64,
    etag_is_md5: bool,
    upload_id: &mut Option<String>,
    parts: &mut BTreeMap<i32, (u64, String)>,
    asked_in_flight: usize,
    announce: &(dyn Fn(PartRecord) + Send + Sync),
    progress: Progress<'_>,
    cancel: &Arc<AtomicBool>,
) -> SResult<Sent> {
    let mut set = tokio::task::JoinSet::new();
    let mut running: BTreeMap<i32, (u64, Arc<AtomicU64>)> = BTreeMap::new();
    let mut done = 0u64;
    let mut read_total = 0u64;
    let mut number = 1i32;
    let mut ended = false;
    let report = |done: u64, running: &BTreeMap<i32, (u64, Arc<AtomicU64>)>, read_total: u64| {
        let in_flight: u64 = running.values().map(|(l, s)| s.load(Ordering::Relaxed).min(*l)).sum();
        let total = len.unwrap_or(read_total);
        progress((done + in_flight).min(total), total);
    };
    loop {
        // start the next part while there is room
        while !ended && set.len() < parts_in_flight(asked_in_flight) {
            let permit = reserve(part).await;
            let Some(data) = read_up_to(body, part, cancel).await? else {
                set.abort_all();
                return Ok(Sent::Cancelled);
            };
            read_total += data.len() as u64;
            let short = (data.len() as u64) < part;
            if short {
                ended = true;
            }
            if number == 1 && short {
                // all of it fits in one request
                drop(permit);
                let n = data.len() as u64;
                let sent = Arc::new(AtomicU64::new(0));
                let etag = ticking(put_single(client, bucket, key, content_type, data, etag_is_md5, sent.clone()), || {
                    progress(sent.load(Ordering::Relaxed).min(n), n)
                })
                .await?;
                return Ok(Sent::Single(etag, n));
            }
            if data.is_empty() {
                break;
            }
            if upload_id.is_none() {
                let id = create(client, bucket, key, content_type).await?;
                announce(PartRecord { number: 0, size: part, etag: id.clone() });
                *upload_id = Some(id);
            }
            let id = upload_id.clone().expect("set above");
            let plen = data.len() as u64;
            let sent = Arc::new(AtomicU64::new(0));
            running.insert(number, (plen, sent.clone()));
            let (client, bucket, key, cancel, n) = (client.clone(), bucket.to_string(), key.to_string(), cancel.clone(), number);
            set.spawn(async move {
                let _permit = permit;
                let r = put_part(&client, &bucket, &key, &id, n, data, &sent, &cancel).await;
                (n, plen, r)
            });
            number += 1;
            report(done, &running, read_total);
        }
        if set.is_empty() {
            return Ok(Sent::Done);
        }
        let joined = ticking(set.join_next(), || report(done, &running, read_total)).await;
        let Some(joined) = joined else { continue };
        let (n, plen, r) = joined.map_err(|e| StorageError::other(e.to_string()))?;
        running.remove(&n);
        match r {
            Ok(Some(etag)) => {
                announce(PartRecord { number: n as u32, size: plen, etag: etag.clone() });
                parts.insert(n, (plen, etag));
                done += plen;
            }
            Ok(None) => {
                set.abort_all();
                return Ok(Sent::Cancelled);
            }
            Err(e) => {
                set.abort_all();
                return Err(e);
            }
        }
        if cancel.load(Ordering::Relaxed) {
            set.abort_all();
            return Ok(Sent::Cancelled);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_sizes_stay_within_s3_limits() {
        assert_eq!(part_size(Some(100 << 20)), 16 << 20);
        for n in [1u64 << 30, 200 << 30, 5u64 << 40] {
            let p = part_size(Some(n));
            assert!((MIN_PART..=MAX_PART).contains(&p));
            assert!(n.div_ceil(p) <= MAX_PARTS, "{n}: {} parts", n.div_ceil(p));
        }
        assert_eq!(part_size(None), UNKNOWN_LEN_PART);
        // a caller's part size is raised when it would need too many parts, and kept above 5 MiB
        assert_eq!(fit_part(1, 10 << 20), MIN_PART);
        assert!(fit_part(MIN_PART, 1 << 40).div_ceil(1) >= (1u64 << 40).div_ceil(MAX_PARTS));
    }

    #[test]
    fn multipart_etags_are_md5_of_md5s() {
        let a = md5_hex(&Md5::digest(b"hello"));
        let b = md5_hex(&Md5::digest(b"world"));
        let mut h = Md5::new();
        h.update(Md5::digest(b"hello"));
        h.update(Md5::digest(b"world"));
        assert_eq!(multipart_etag(&[format!("\"{a}\""), b]).unwrap(), format!("{}-2", md5_hex(&h.finalize())));
        // encrypting servers' part ETags aren't MD5s: nothing to compare against
        assert_eq!(multipart_etag(&["not-an-md5".into()]), None);
    }

    #[test]
    fn part_bodies_go_out_in_chunks_and_count() {
        tauri::async_runtime::block_on(async {
            let data = Bytes::from(vec![3u8; CHUNK * 2 + 10]);
            let sent = Arc::new(AtomicU64::new(0));
            let mut body = PartBody { data: data.clone(), pos: 0, sent: sent.clone(), wait: None };
            let mut got = 0;
            while let Some(f) = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
                let c = f.unwrap().into_data().unwrap();
                assert!(c.len() <= CHUNK);
                got += c.len();
                assert_eq!(sent.load(Ordering::Relaxed), got as u64);
            }
            assert_eq!(got, data.len());
        });
    }

    #[test]
    fn reads_stop_at_the_asked_length() {
        tauri::async_runtime::block_on(async {
            let chunks: Vec<std::io::Result<Bytes>> = vec![Ok(Bytes::from_static(b"abcdef")), Ok(Bytes::from_static(b"ghij"))];
            let mut s: ByteStream = Box::pin(futures_util::stream::iter(chunks));
            let never = AtomicBool::new(false);
            assert_eq!(&read_up_to(&mut s, 8, &never).await.unwrap().unwrap()[..], b"abcdefgh");
            let stop = AtomicBool::new(true);
            assert!(read_up_to(&mut s, 8, &stop).await.unwrap().is_none());
        });
    }
}
