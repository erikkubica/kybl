//! Uploads: one request for small files, parallel multipart for big ones.
//!
//! A big upload sends several parts at once (the transfer settings say how many) and retries a
//! part that fails a few times before giving up. When it does give up, the upload id and the
//! parts that made it are kept (in memory, per transfer id), so Retry carries on from there
//! instead of sending the whole file again. A cancelled upload is aborted on the server, so its
//! parts stop costing storage.

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    task::{Context, Poll},
    time::{Duration, SystemTime},
};

use aws_sdk_s3::{
    primitives::{ByteStream, Length, SdkBody},
    types::{CompletedMultipartUpload, CompletedPart},
    Client,
};
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};

use crate::{
    state::{err, sdk_err},
    storage::{PartRecord, ResumeState},
    transfers::{Hold, Outcome, Progress},
    tuning::{self, UP},
};

pub(crate) const SINGLE_PUT_LIMIT: u64 = 16 * 1024 * 1024;
const MIN_PART_SIZE: u64 = 16 * 1024 * 1024;
/// Tries per part before the upload gives up (and can be retried from where it stopped).
const PART_TRIES: u32 = 3;

/// How much of a file is read and handed to the network at a time. Smaller chunks mean smoother
/// progress; a request is one SDK call, so without this a 16 MB upload shows 0% until it ends.
pub(crate) const CHUNK: usize = 64 * 1024;

/// A request body that counts the bytes it hands over, so progress can follow a single request,
/// and holds back the next chunk while the bandwidth cap asks it to.
struct Counting<B> {
    inner: B,
    sent: Arc<AtomicU64>,
    wait: Option<tuning::Wait>,
}

impl<B: Body<Data = Bytes> + Unpin> Body for Counting<B> {
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        if let Some(w) = self.wait.as_mut() {
            if w.as_mut().poll(cx).is_pending() {
                return Poll::Pending;
            }
            self.wait = None;
        }
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &polled
            && let Some(data) = frame.data_ref()
        {
            self.sent.fetch_add(data.len() as u64, Ordering::Relaxed);
            self.wait = UP.take_wait(data.len());
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// `len` bytes of the file from `offset`, streamed from disk `CHUNK` bytes at a time (nothing is
/// held in memory) and counted into `sent`. The SDK can restart it to retry a failed request: the
/// file is opened again and the counter restarts with it.
pub(crate) async fn file_body(path: &str, offset: u64, len: u64, sent: Arc<AtomicU64>) -> Result<ByteStream, String> {
    let stream = ByteStream::read_from()
        .path(path)
        .offset(offset)
        .length(Length::Exact(len))
        .buffer_size(CHUNK)
        .build()
        .await
        .map_err(err)?;
    let body = stream.into_inner().map(move |inner| {
        sent.store(0, Ordering::Relaxed);
        SdkBody::from_body_1_x(Counting { inner, sent: sent.clone(), wait: None })
    });
    Ok(ByteStream::new(body))
}

/// Runs a request while reporting `base + bytes sent so far` every 150 ms. Returns None when the
/// transfer was cancelled (the request is dropped, which stops it).
async fn drive<T>(
    request: impl Future<Output = T>,
    sent: &AtomicU64,
    base: u64,
    total: u64,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Option<T> {
    tokio::pin!(request);
    let mut tick = tokio::time::interval(Duration::from_millis(150));
    loop {
        tokio::select! {
            out = &mut request => return Some(out),
            _ = tick.tick() => {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                progress((base + sent.load(Ordering::Relaxed)).min(total), total);
            }
        }
    }
}

/// Part size for a file: S3 allows at most 10,000 parts, so very large files get bigger parts.
pub(crate) fn part_size_for(total: u64) -> u64 {
    MIN_PART_SIZE.max(total.div_ceil(9000))
}

/// The parts of a `total`-byte file: (part number, offset, length).
pub(crate) fn part_plan(total: u64, part_size: u64) -> Vec<(i32, u64, u64)> {
    let mut parts = Vec::new();
    let (mut offset, mut n) = (0u64, 1i32);
    while offset < total {
        let len = part_size.min(total - offset);
        parts.push((n, offset, len));
        offset += len;
        n += 1;
    }
    parts
}

/// A multipart upload in progress: what Retry needs to carry on.
#[derive(Clone)]
pub(crate) struct Multipart {
    upload_id: String,
    part_size: u64,
    /// finished parts: number → ETag
    parts: BTreeMap<i32, String>,
}

impl Multipart {
    /// As kept across a restart (`resume`).
    pub(crate) fn to_resume(&self, total: u64) -> ResumeState {
        let sizes: HashMap<i32, u64> = part_plan(total, self.part_size).into_iter().map(|(n, _, len)| (n, len)).collect();
        ResumeState {
            upload_id: self.upload_id.clone(),
            part_size: self.part_size,
            parts: self
                .parts
                .iter()
                .map(|(n, etag)| PartRecord { number: *n as u32, size: sizes.get(n).copied().unwrap_or(0), etag: etag.clone() })
                .collect(),
        }
    }

    fn from_resume(rs: &ResumeState) -> Self {
        Self { upload_id: rs.upload_id.clone(), part_size: rs.part_size, parts: rs.parts.iter().map(|p| (p.number as i32, p.etag.clone())).collect() }
    }

    pub(crate) fn part_size(&self) -> u64 {
        self.part_size
    }
}

/// Told the multipart upload's state each time it changes (created, a part landed), so it can be
/// kept across a restart.
pub(crate) type OnState<'a> = Option<&'a (dyn Fn(&Multipart) + Send + Sync)>;

/// The local file as it was when the upload started (size, modification time in ms); a retry only
/// resumes if it still matches.
pub(crate) type FileStamp = (u64, Option<i64>);

pub(crate) async fn stamp(path: &str) -> Result<FileStamp, String> {
    let m = tokio::fs::metadata(path).await.map_err(err)?;
    let ms = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    Ok((m.len(), ms))
}

/// Takes in an upload kept from an earlier run, so the next start of transfer `id` carries on.
#[allow(clippy::too_many_arguments)]
pub(crate) fn adopt(id: &str, client: &Client, profile_id: &str, bucket: &str, key: &str, path: &str, stamp: FileStamp, rs: &ResumeState) {
    let mut pending = PENDING.lock().unwrap();
    if pending.contains_key(id) {
        return;
    }
    let p = Pending {
        client: client.clone(),
        profile_id: profile_id.into(),
        bucket: bucket.into(),
        key: key.into(),
        path: path.into(),
        stamp,
        mp: Multipart::from_resume(rs),
    };
    pending.insert(id.to_string(), p);
}

/// The upload kept for transfer `id`, if any.
pub(crate) fn kept(id: &str) -> Option<Multipart> {
    PENDING.lock().unwrap().get(id).map(|p| p.mp.clone())
}

/// What a paused upload hands back instead of finishing: everything it did is kept.
pub(crate) const PAUSED: &str = "Paused";

/// A failed upload kept for Retry.
struct Pending {
    client: Client,
    profile_id: String,
    bucket: String,
    key: String,
    path: String,
    stamp: FileStamp,
    mp: Multipart,
}

static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> = LazyLock::new(Default::default);

/// Every multipart upload open on a server right now (transfers and sync), so quitting can abort
/// them instead of leaving their parts behind.
static OPEN: LazyLock<Mutex<HashMap<u64, OpenUpload>>> = LazyLock::new(Default::default);
/// (client, bucket, key, upload id)
type OpenUpload = (Client, String, String, String);
static OPEN_IDS: AtomicU64 = AtomicU64::new(0);

/// Removes its entry from [`OPEN`] when the upload is no longer running here.
pub(crate) struct OpenGuard(u64);

impl OpenGuard {
    pub(crate) fn new(client: &Client, bucket: &str, key: &str, upload_id: &str) -> Self {
        let id = OPEN_IDS.fetch_add(1, Ordering::Relaxed);
        OPEN.lock().unwrap().insert(id, (client.clone(), bucket.into(), key.into(), upload_id.into()));
        Self(id)
    }
}

impl Drop for OpenGuard {
    fn drop(&mut self) {
        OPEN.lock().unwrap().remove(&self.0);
    }
}

async fn abort(client: &Client, bucket: &str, key: &str, upload_id: &str) {
    let gone = match client.abort_multipart_upload().bucket(bucket).key(key).upload_id(upload_id).send().await {
        Ok(_) => true,
        Err(e) => upload_gone(&sdk_err(e)),
    };
    // otherwise still on the server: the next start tries again (see leftovers.rs)
    if gone {
        crate::leftovers::upload_ended(upload_id);
    }
}

/// Aborts every open and every kept multipart upload, waiting at most `limit` (used on quit).
pub async fn abort_all(limit: Duration) {
    let mut jobs: Vec<OpenUpload> = OPEN.lock().unwrap().values().cloned().collect();
    jobs.extend(
        PENDING
            .lock()
            .unwrap()
            .drain()
            .map(|(_, p)| (p.client, p.bucket, p.key, p.mp.upload_id)),
    );
    // paused and interrupted transfers kept for the next start carry on from their parts
    jobs.retain(|j| !crate::resume::keeps_upload(&j.3));
    let mut set = tokio::task::JoinSet::new();
    for (c, b, k, u) in jobs {
        set.spawn(async move { abort(&c, &b, &k, &u).await });
    }
    let _ = tokio::time::timeout(limit, async { while set.join_next().await.is_some() {} }).await;
}

/// Drops the kept state of a failed upload and aborts it on the server (the user gave up on it).
pub fn forget(id: &str) -> bool {
    let Some(p) = PENDING.lock().unwrap().remove(id) else { return false };
    tauri::async_runtime::spawn(async move { abort(&p.client, &p.bucket, &p.key, &p.mp.upload_id).await });
    true
}

/// Is the error the server saying it no longer knows this upload id (aborted, or expired)?
fn upload_gone(e: &str) -> bool {
    e.contains("NoSuchUpload")
}

/// Uploads a file, fresh, as sync does: a failed multipart upload is aborted, never kept.
#[cfg_attr(mobile, allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_file(
    client: &Client,
    profile_id: &str,
    bucket: &str,
    key: &str,
    path: &str,
    cancel: &Arc<AtomicBool>,
    progress: Progress<'_>,
) -> Result<Outcome, String> {
    let mut mp = None;
    let r = upload(client, profile_id, bucket, key, path, cancel, progress, None, None, None, &mut mp).await;
    if r.is_err()
        && let Some(m) = mp
    {
        abort(client, bucket, key, &m.upload_id).await;
    }
    r
}

/// Uploads a file for the transfer `id`. A retry of an upload that failed earlier (same id,
/// same connection, bucket, key and unchanged file) carries on from the parts that made it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_resumable(
    client: &Client,
    id: &str,
    profile_id: &str,
    bucket: &str,
    key: &str,
    path: &str,
    cancel: &Arc<AtomicBool>,
    progress: Progress<'_>,
    hold: Hold<'_>,
    pause: &AtomicBool,
    on_state: OnState<'_>,
) -> Result<Outcome, String> {
    let now = stamp(path).await?;
    let kept = PENDING.lock().unwrap().remove(id);
    let mut mp = match kept {
        Some(p) if p.profile_id == profile_id && p.bucket == bucket && p.key == key && p.path == path && p.stamp == now => Some(p.mp),
        Some(p) => {
            // something changed: the old parts are of no use any more
            abort(&p.client, &p.bucket, &p.key, &p.mp.upload_id).await;
            None
        }
        None => None,
    };
    let resumed = mp.is_some();
    let mut r = upload(client, profile_id, bucket, key, path, cancel, progress, hold, Some(pause), on_state, &mut mp).await;
    if resumed && matches!(&r, Err(e) if upload_gone(e)) {
        // the server dropped the old upload (it expires them after a while): start over
        if let Some(m) = mp.take() {
            crate::leftovers::upload_ended(&m.upload_id);
        }
        r = upload(client, profile_id, bucket, key, path, cancel, progress, hold, Some(pause), on_state, &mut mp).await;
    }
    if r.is_err()
        && let Some(m) = mp
    {
        let kept = Pending {
            client: client.clone(),
            profile_id: profile_id.into(),
            bucket: bucket.into(),
            key: key.into(),
            path: path.into(),
            stamp: now,
            mp: m,
        };
        PENDING.lock().unwrap().insert(id.to_string(), kept);
    }
    r
}

/// The upload itself. `mp` carries a multipart upload in and out: given one, its finished parts
/// are skipped; on error it holds what was done (the caller keeps or aborts it); on cancel the
/// upload is aborted here and `mp` is cleared.
#[allow(clippy::too_many_arguments)]
async fn upload(
    client: &Client,
    profile_id: &str,
    bucket: &str,
    key: &str,
    path: &str,
    cancel: &Arc<AtomicBool>,
    progress: Progress<'_>,
    hold: Hold<'_>,
    pause: Option<&AtomicBool>,
    on_state: OnState<'_>,
    mp: &mut Option<Multipart>,
) -> Result<Outcome, String> {
    let total = tokio::fs::metadata(path).await.map_err(err)?.len();
    let content_type = mime_guess::from_path(path).first_or_octet_stream().to_string();
    progress(0, total);
    // photos carry their placeholder as metadata, so other devices can show it with one HEAD
    // (a resumed multipart upload already has its metadata: nothing to work out)
    let placeholder = if mp.is_none() { crate::placeholders::prepare_upload(path, total).await } else { None };
    let thumbhash = placeholder.as_ref().map(|p| p.hash.clone());

    if total <= SINGLE_PUT_LIMIT && mp.is_none() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(Outcome::Cancelled);
        }
        let sent = Arc::new(AtomicU64::new(0));
        let body = file_body(path, 0, total, sent.clone()).await?;
        let request = client
            .put_object()
            .bucket(bucket)
            .key(key)
            .content_type(&content_type)
            .set_metadata(thumbhash.map(|h| [("thumbhash".to_string(), h)].into()))
            .content_length(total as i64)
            .body(body)
            .send();
        return match drive(request, &sent, 0, total, cancel, progress).await {
            None => Ok(Outcome::Cancelled),
            Some(r) => {
                let out = r.map_err(sdk_err)?;
                if let Some(p) = &placeholder {
                    crate::placeholders::uploaded(profile_id, bucket, key, out.e_tag(), total, p).await;
                }
                Ok(Outcome::Done)
            }
        };
    }

    if mp.is_none() {
        let created = client
            .create_multipart_upload()
            .bucket(bucket)
            .key(key)
            .content_type(&content_type)
            .set_metadata(thumbhash.map(|h| [("thumbhash".to_string(), h)].into()))
            .send()
            .await
            .map_err(sdk_err)?;
        let upload_id = created.upload_id().unwrap_or_default().to_string();
        // written down until completed or aborted, in case the app ends before either
        crate::leftovers::upload_started(profile_id, bucket, key, &upload_id);
        *mp = Some(Multipart { upload_id, part_size: part_size_for(total), parts: BTreeMap::new() });
        if let (Some(f), Some(m)) = (on_state, mp.as_ref()) {
            f(m);
        }
    }
    let m = mp.as_mut().expect("set above");
    let _open = OpenGuard::new(client, bucket, key, &m.upload_id);

    match send_parts(client, bucket, key, path, total, m, cancel, progress, hold, on_state).await {
        Ok(true) => {}
        // paused: the upload stays open on the server and `mp` keeps its parts, to carry on later
        Ok(false) if pause.is_some_and(|p| p.load(Ordering::Relaxed)) => return Err(PAUSED.into()),
        Ok(false) => {
            abort(client, bucket, key, &m.upload_id).await;
            *mp = None;
            return Ok(Outcome::Cancelled);
        }
        Err(e) => return Err(e),
    }
    let parts: Vec<CompletedPart> = m
        .parts
        .iter()
        .map(|(n, etag)| CompletedPart::builder().e_tag(etag).part_number(*n).build())
        .collect();
    let asked = SystemTime::now();
    let completed = client
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&m.upload_id)
        .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
        .send()
        .await;
    match completed {
        Ok(out) => {
            if let Some(p) = &placeholder {
                crate::placeholders::uploaded(profile_id, bucket, key, out.e_tag(), total, p).await;
            }
        }
        Err(e) => {
            let e = sdk_err(e);
            // The answer can be lost (a timeout, a dropped connection) after the server put the file
            // together. Aborting or retrying then would throw away a finished upload: look first.
            if !completed_anyway(client, bucket, key, total, m.parts.len(), asked).await {
                return Err(e);
            }
        }
    }
    crate::leftovers::upload_ended(&m.upload_id);
    *mp = None;
    progress(total, total);
    Ok(Outcome::Done)
}

/// Did a CompleteMultipartUpload whose answer went missing go through anyway? The object is
/// there with the file's size, a multipart ETag of as many parts (`"…-3"`), and was written
/// around the time it was asked for (servers' clocks may be up to 15 minutes off).
async fn completed_anyway(client: &Client, bucket: &str, key: &str, total: u64, parts: usize, asked: SystemTime) -> bool {
    let Ok(head) = client.head_object().bucket(bucket).key(key).send().await else { return false };
    let modified = head.last_modified().and_then(|d| SystemTime::try_from(*d).ok());
    looks_completed(head.content_length(), head.e_tag(), modified, total, parts, asked)
}

fn looks_completed(len: Option<i64>, etag: Option<&str>, modified: Option<SystemTime>, total: u64, parts: usize, asked: SystemTime) -> bool {
    let skew = Duration::from_secs(15 * 60);
    let size_ok = len == Some(total as i64);
    let etag_ok = etag.is_some_and(|t| t.trim_matches('"').ends_with(&format!("-{parts}")));
    let time_ok = modified.is_some_and(|m| m + skew >= asked);
    size_ok && etag_ok && time_ok
}

/// Sends the parts not yet in `m.parts`, several at once. Ok(false) when cancelled.
#[allow(clippy::too_many_arguments)]
async fn send_parts(
    client: &Client,
    bucket: &str,
    key: &str,
    path: &str,
    total: u64,
    m: &mut Multipart,
    cancel: &Arc<AtomicBool>,
    progress: Progress<'_>,
    hold: Hold<'_>,
    on_state: OnState<'_>,
) -> Result<bool, String> {
    let plan = part_plan(total, m.part_size);
    let mut done_bytes: u64 = plan.iter().filter(|p| m.parts.contains_key(&p.0)).map(|p| p.2).sum();
    let mut queue = plan.into_iter().filter(|p| !m.parts.contains_key(&p.0)).collect::<std::collections::VecDeque<_>>();
    let mut running: HashMap<i32, (u64, Arc<AtomicU64>)> = HashMap::new();
    let mut set = tokio::task::JoinSet::new();
    let mut tick = tokio::time::interval(Duration::from_millis(150));
    progress(done_bytes, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            set.abort_all();
            return Ok(false);
        }
        // "Wi-Fi only" and the phone moved to mobile data: stop sending (the parts in flight go
        // back in the queue), keep the parts that made it, and carry on once it is back on Wi-Fi
        if let Some(paused) = hold
            && crate::tuning::hold_for_wifi()
        {
            set.abort_all();
            while set.join_next().await.is_some() {}
            let again: Vec<_> = part_plan(total, m.part_size).into_iter().filter(|p| running.contains_key(&p.0)).collect();
            running.clear();
            for p in again.into_iter().rev() {
                queue.push_front(p);
            }
            paused(done_bytes, total);
            if !crate::tuning::wait_for_wifi(cancel).await {
                return Ok(false);
            }
            progress(done_bytes, total);
        }
        // the setting is read as parts start, so a change applies to an upload already running
        while set.len() < crate::tuning::part_concurrency() {
            let Some((n, offset, len)) = queue.pop_front() else { break };
            let sent = Arc::new(AtomicU64::new(0));
            running.insert(n, (len, sent.clone()));
            let (client, bucket, key, path, upload_id, cancel) =
                (client.clone(), bucket.to_string(), key.to_string(), path.to_string(), m.upload_id.clone(), cancel.clone());
            set.spawn(async move {
                let r = send_part(&client, &bucket, &key, &path, &upload_id, n, offset, len, &sent, &cancel).await;
                (n, r)
            });
        }
        if set.is_empty() {
            return Ok(true);
        }
        tokio::select! {
            joined = set.join_next() => {
                let Some(joined) = joined else { continue };
                let (n, r) = joined.map_err(err)?;
                let (len, _) = running.remove(&n).unwrap_or_default();
                match r {
                    Ok(Some(etag)) => {
                        m.parts.insert(n, etag);
                        done_bytes += len;
                        if let Some(f) = on_state {
                            f(m);
                        }
                    }
                    Ok(None) => {
                        set.abort_all();
                        return Ok(false);
                    }
                    Err(e) => {
                        // parts still in flight are dropped; Retry sends them again
                        set.abort_all();
                        return Err(e);
                    }
                }
            }
            _ = tick.tick() => {
                let in_flight: u64 = running.values().map(|(len, s)| s.load(Ordering::Relaxed).min(*len)).sum();
                progress((done_bytes + in_flight).min(total), total);
            }
        }
    }
}

/// One part, tried up to [`PART_TRIES`] times with a growing pause. Ok(None) when cancelled.
#[allow(clippy::too_many_arguments)]
async fn send_part(
    client: &Client,
    bucket: &str,
    key: &str,
    path: &str,
    upload_id: &str,
    n: i32,
    offset: u64,
    len: u64,
    sent: &Arc<AtomicU64>,
    cancel: &AtomicBool,
) -> Result<Option<String>, String> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let body = file_body(path, offset, len, sent.clone()).await?;
        let r = client
            .upload_part()
            .bucket(bucket)
            .key(key)
            .upload_id(upload_id)
            .part_number(n)
            .content_length(len as i64)
            .body(body)
            .send()
            .await;
        match r {
            Ok(out) => return Ok(Some(out.e_tag().unwrap_or_default().to_string())),
            Err(e) => {
                let e = sdk_err(e);
                if attempt >= PART_TRIES || upload_gone(&e) {
                    return Err(e);
                }
                sent.store(0, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};
    use std::time::Instant;

    #[test]
    fn a_completed_upload_is_recognised_after_a_lost_answer() {
        let asked = SystemTime::now();
        let ago = |s: u64| Some(asked - Duration::from_secs(s));
        assert!(looks_completed(Some(100), Some("\"abc-3\""), ago(5), 100, 3, asked));
        assert!(!looks_completed(Some(99), Some("\"abc-3\""), ago(5), 100, 3, asked), "other size");
        assert!(!looks_completed(Some(100), Some("\"abc\""), ago(5), 100, 3, asked), "a single PUT, not ours");
        assert!(!looks_completed(Some(100), Some("\"abc-13\""), ago(5), 100, 3, asked), "other part count");
        assert!(!looks_completed(Some(100), Some("\"abc-3\""), ago(3600), 100, 3, asked), "an older upload");
        assert!(!looks_completed(None, None, None, 100, 3, asked));
    }

    #[test]
    fn parts_cover_the_file_exactly() {
        assert!(part_plan(0, 10).is_empty());
        assert_eq!(part_plan(25, 10), vec![(1, 0, 10), (2, 10, 10), (3, 20, 5)]);
        assert_eq!(part_plan(20, 10), vec![(1, 0, 10), (2, 10, 10)]);
        // never more than 10,000 parts, whatever the size
        for total in [17u64 << 20, 5 << 30, 1 << 40, 5u64 << 40] {
            let ps = part_size_for(total);
            assert!(ps >= MIN_PART_SIZE);
            let plan = part_plan(total, ps);
            assert!(plan.len() <= 10_000, "{total}: {} parts", plan.len());
            assert_eq!(plan.iter().map(|p| p.2).sum::<u64>(), total);
        }
    }

    #[test]
    fn file_body_streams_the_range_in_small_chunks_and_counts_it() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir().join(format!("kybl-body-{}", uuid::Uuid::new_v4()));
            let data: Vec<u8> = (0..CHUNK * 3 + 100).map(|i| (i % 251) as u8).collect();
            tokio::fs::write(&path, &data).await.unwrap();
            let sent = Arc::new(AtomicU64::new(0));
            let (offset, len) = (100u64, (CHUNK * 2 + 50) as u64);
            let mut body = file_body(path.to_str().unwrap(), offset, len, sent.clone()).await.unwrap().into_inner();
            assert_eq!(http_body::Body::size_hint(&body).exact(), Some(len));
            let mut got = Vec::new();
            while let Some(frame) = std::future::poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
                let chunk = frame.unwrap().into_data().unwrap();
                assert!(chunk.len() <= CHUNK, "read in small chunks, not all at once");
                got.extend_from_slice(&chunk);
                assert_eq!(sent.load(Ordering::Relaxed), got.len() as u64, "progress follows every chunk");
            }
            assert_eq!(got, data[offset as usize..(offset + len) as usize]);
            // a retry starts over from the beginning of the range, and so does the count
            let mut again = body.try_clone().expect("retryable");
            assert_eq!(sent.load(Ordering::Relaxed), 0);
            let first = std::future::poll_fn(|cx| Pin::new(&mut again).poll_frame(cx)).await.unwrap().unwrap();
            assert_eq!(first.into_data().unwrap()[0], data[offset as usize]);
            let _ = tokio::fs::remove_file(&path).await;
        });
    }

    /// An upload that fails halfway keeps its finished parts; Retry (same id, same file) sends
    /// only the rest. Needs `KYBL_TEST_MULTIPART_ENDPOINT` (see below).
    #[cfg(unix)]
    #[test]
    fn a_retried_upload_skips_the_parts_already_sent() {
        use std::os::unix::fs::PermissionsExt;
        let Ok(endpoint) = std::env::var("KYBL_TEST_MULTIPART_ENDPOINT") else {
            return eprintln!("skipped: KYBL_TEST_MULTIPART_ENDPOINT not set");
        };
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&p, "testsecret");
        tauri::async_runtime::block_on(async move {
            let dir = std::env::temp_dir().join(format!("kybl-resume-up-{}", uuid::Uuid::new_v4()));
            tokio::fs::create_dir_all(&dir).await.unwrap();
            let path = dir.join("big.bin");
            let size = 3 * MIN_PART_SIZE as usize + 1234;
            let data: Vec<u8> = (0..size).map(|i| (i % 253) as u8).collect();
            tokio::fs::write(&path, &data).await.unwrap();
            let p = path.to_str().unwrap().to_string();
            let key = format!("resume-{}/big.bin", uuid::Uuid::new_v4());
            let id = uuid::Uuid::new_v4().to_string();
            let cancel = Arc::new(AtomicBool::new(false));
            // the first attempt loses read access to the file once the first part is in: the
            // parts still to go fail, as if the network had dropped (one part at a time, so the
            // later parts open the file after that)
            crate::tuning::apply(crate::tuning::TransferPrefs { part_concurrency: 1, ..crate::tuning::current() });
            let locked = AtomicBool::new(false);
            let r = upload_resumable(&client, &id, "t", "testbucket", &key, &p, &cancel, &|done, _| {
                if done >= MIN_PART_SIZE && !locked.swap(true, Ordering::SeqCst) {
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
                }
            }, None, &AtomicBool::new(false), None)
            .await;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            crate::tuning::apply(crate::tuning::TransferPrefs::default());
            assert!(r.is_err(), "the first attempt fails");
            let kept = PENDING.lock().unwrap().get(&id).map(|p| p.mp.parts.len()).unwrap_or(0);
            assert!(kept >= 1, "finished parts are kept for Retry");

            // Retry: the first progress after the start already counts the kept parts
            let seen = Mutex::new(Vec::<u64>::new());
            let r = upload_resumable(&client, &id, "t", "testbucket", &key, &p, &cancel, &|done, _| seen.lock().unwrap().push(done), None, &AtomicBool::new(false), None)
                .await
                .unwrap();
            assert!(matches!(r, Outcome::Done));
            let seen = seen.into_inner().unwrap();
            assert_eq!(seen[0], 0);
            assert!(seen[1] >= kept as u64 * MIN_PART_SIZE, "resumed after the kept parts: {seen:?}");
            assert!(!PENDING.lock().unwrap().contains_key(&id));
            let mut got = client.get_object().bucket("testbucket").key(&key).send().await.unwrap();
            let mut back = Vec::new();
            while let Some(c) = got.body.try_next().await.unwrap() {
                back.extend_from_slice(&c);
            }
            assert!(back == data, "the resumed upload is whole and in order");
            let _ = tokio::fs::remove_dir_all(&dir).await;
        });
    }

    /// Needs a multipart-capable throwaway S3 server in `KYBL_TEST_MULTIPART_ENDPOINT`. Set
    /// `KYBL_TEST_SLOW=1` behind a rate-limited proxy to also check that progress moves inside a file.
    #[test]
    fn uploads_arrive_intact_and_report_progress_inside_a_file() {
        // rclone's S3 server can't do multipart uploads, so this test has its own server,
        // for example adobe/s3mock with a `testbucket` bucket.
        let Ok(endpoint) = std::env::var("KYBL_TEST_MULTIPART_ENDPOINT") else {
            return eprintln!("skipped: KYBL_TEST_MULTIPART_ENDPOINT not set");
        };
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&p, "testsecret");
        tauri::async_runtime::block_on(async move {
            let dir = std::env::temp_dir().join(format!("kybl-up-{}", uuid::Uuid::new_v4()));
            tokio::fs::create_dir_all(&dir).await.unwrap();
            let base = format!("up-{}/", uuid::Uuid::new_v4());
            for (name, size) in [("small.bin", 3usize << 20), ("big.bin", 50 << 20)] {
                let path = dir.join(name);
                let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
                tokio::fs::write(&path, &data).await.unwrap();
                let seen = Mutex::new(Vec::<u64>::new());
                let started = Instant::now();
                let cancel = Arc::new(AtomicBool::new(false));
                let r = upload_file(&client, "t", "testbucket", &format!("{base}{name}"), path.to_str().unwrap(), &cancel, &|done, total| {
                    assert_eq!(total, size as u64);
                    seen.lock().unwrap().push(done);
                })
                .await
                .unwrap();
                assert!(matches!(r, Outcome::Done));
                let mut got = client.get_object().bucket("testbucket").key(format!("{base}{name}")).send().await.unwrap();
                let mut back = Vec::new();
                while let Some(c) = got.body.try_next().await.unwrap() {
                    back.extend_from_slice(&c);
                }
                assert!(back == data, "{name} arrived whole and in order");
                let seen = seen.into_inner().unwrap();
                assert!(seen.iter().all(|&d| d <= size as u64));
                assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress never goes backwards: {seen:?}");
                if std::env::var("KYBL_TEST_SLOW").is_ok() && started.elapsed() > Duration::from_secs(2) {
                    let inside = seen.iter().filter(|&&d| d > 0 && d < size as u64).count();
                    assert!(inside >= 3, "{name}: expected progress inside the file, got {seen:?}");
                }
            }
            // a cancelled upload stops and leaves nothing behind
            let path = dir.join("big.bin");
            let stop = Arc::new(AtomicBool::new(true));
            let r = upload_file(&client, "t", "testbucket", &format!("{base}cancelled.bin"), path.to_str().unwrap(), &stop, &|_, _| {})
                .await
                .unwrap();
            assert!(matches!(r, Outcome::Cancelled));
            assert!(client.head_object().bucket("testbucket").key(format!("{base}cancelled.bin")).send().await.is_err());
            assert!(!OPEN.lock().unwrap().values().any(|o| o.2.ends_with("cancelled.bin")), "nothing left open");
            let _ = tokio::fs::remove_dir_all(&dir).await;
        });
    }
}
