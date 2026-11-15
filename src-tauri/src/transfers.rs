use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

use aws_sdk_s3::{
    primitives::{ByteStream, Length, SdkBody},
    types::{CompletedMultipartUpload, CompletedPart},
    Client,
};
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::state::{client_for, err, sdk_err, AppState};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferEvent {
    id: String,
    /// queued | running | done | error | cancelled
    state: &'static str,
    bytes: u64,
    total: u64,
    error: Option<String>,
}

fn emit(app: &AppHandle, id: &str, state: &'static str, bytes: u64, total: u64, error: Option<String>) {
    let _ = app.emit(
        "transfer",
        TransferEvent { id: id.to_string(), state, bytes, total, error },
    );
}

pub(crate) enum Outcome {
    Done,
    Cancelled,
}

const SINGLE_PUT_LIMIT: u64 = 16 * 1024 * 1024;
const MIN_PART_SIZE: u64 = 16 * 1024 * 1024;

/// Progress callback: (bytes done, total bytes).
pub(crate) type Progress<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// How much of a file is read and handed to the network at a time. Smaller chunks mean smoother
/// progress; a request is one SDK call, so without this a 16 MB upload shows 0% until it ends.
const CHUNK: usize = 64 * 1024;

/// A request body that counts the bytes it hands over, so progress can follow a single request.
struct Counting<B> {
    inner: B,
    sent: Arc<AtomicU64>,
}

impl<B: Body<Data = Bytes> + Unpin> Body for Counting<B> {
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &polled {
            if let Some(data) = frame.data_ref() {
                self.sent.fetch_add(data.len() as u64, Ordering::Relaxed);
            }
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
async fn file_body(path: &str, offset: u64, len: u64, sent: Arc<AtomicU64>) -> Result<ByteStream, String> {
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
        SdkBody::from_body_1_x(Counting { inner, sent: sent.clone() })
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

pub(crate) async fn upload_file(
    client: &Client,
    bucket: &str,
    key: &str,
    path: &str,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<Outcome, String> {
    let total = tokio::fs::metadata(path).await.map_err(err)?.len();
    let content_type = mime_guess::from_path(path).first_or_octet_stream().to_string();
    progress(0, total);

    if total <= SINGLE_PUT_LIMIT {
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
            .content_length(total as i64)
            .body(body)
            .send();
        return match drive(request, &sent, 0, total, cancel, progress).await {
            None => Ok(Outcome::Cancelled),
            Some(r) => r.map(|_| Outcome::Done).map_err(sdk_err),
        };
    }

    // S3 allows at most 10,000 parts: grow the part size for very large files.
    let part_size = MIN_PART_SIZE.max(total.div_ceil(9000));
    let created = client
        .create_multipart_upload()
        .bucket(bucket)
        .key(key)
        .content_type(&content_type)
        .send()
        .await
        .map_err(sdk_err)?;
    let upload_id = created.upload_id().unwrap_or_default().to_string();

    let run = async {
        let mut parts: Vec<CompletedPart> = Vec::new();
        let mut sent = 0u64;
        let mut n = 1i32;
        while sent < total {
            if cancel.load(Ordering::Relaxed) {
                return Ok::<Option<Vec<CompletedPart>>, String>(None);
            }
            let want = part_size.min(total - sent);
            let in_part = Arc::new(AtomicU64::new(0));
            let body = file_body(path, sent, want, in_part.clone()).await?;
            let request = client
                .upload_part()
                .bucket(bucket)
                .key(key)
                .upload_id(&upload_id)
                .part_number(n)
                .content_length(want as i64)
                .body(body)
                .send();
            let Some(r) = drive(request, &in_part, sent, total, cancel, progress).await else {
                return Ok(None);
            };
            let r = r.map_err(sdk_err)?;
            parts.push(
                CompletedPart::builder()
                    .set_e_tag(r.e_tag().map(|s| s.to_string()))
                    .part_number(n)
                    .build(),
            );
            sent += want;
            n += 1;
            progress(sent, total);
        }
        Ok(Some(parts))
    }
    .await;

    match run {
        Ok(Some(parts)) => {
            client
                .complete_multipart_upload()
                .bucket(bucket)
                .key(key)
                .upload_id(&upload_id)
                .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
                .send()
                .await
                .map_err(sdk_err)?;
            Ok(Outcome::Done)
        }
        other => {
            let _ = client
                .abort_multipart_upload()
                .bucket(bucket)
                .key(key)
                .upload_id(&upload_id)
                .send()
                .await;
            match other {
                Ok(None) => Ok(Outcome::Cancelled),
                Err(e) => Err(e),
                Ok(Some(_)) => unreachable!(),
            }
        }
    }
}

pub(crate) async fn download_file(
    client: &Client,
    bucket: &str,
    key: &str,
    dest: &str,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<Outcome, String> {
    let mut out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(sdk_err)?;
    let total = out.content_length().unwrap_or(0).max(0) as u64;
    progress(0, total);

    let dest_path = std::path::PathBuf::from(dest);
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(err)?;
    }
    let part_path = std::path::PathBuf::from(format!("{dest}.s3part"));
    let mut file = tokio::fs::File::create(&part_path).await.map_err(err)?;
    let mut got = 0u64;
    let mut last_emit = Instant::now();
    let result: Result<bool, String> = async {
        while let Some(chunk) = out.body.try_next().await.map_err(err)? {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            file.write_all(&chunk).await.map_err(err)?;
            got += chunk.len() as u64;
            if last_emit.elapsed() > Duration::from_millis(150) {
                progress(got, total);
                last_emit = Instant::now();
            }
        }
        file.flush().await.map_err(err)?;
        Ok(true)
    }
    .await;
    drop(file);
    match result {
        Ok(true) => {
            tokio::fs::rename(&part_path, &dest_path).await.map_err(err)?;
            Ok(Outcome::Done)
        }
        Ok(false) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            Ok(Outcome::Cancelled)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            Err(e)
        }
    }
}

/// A file picked on a phone comes as a URL, not a path: `content://…` on Android (a document
/// another app hands over, only readable through the system) or `file://…` on iOS. A file URL is
/// just a path. Anything else is copied once into the cache under the object's own name (so its
/// content type still reads right) and that copy is uploaded; the second value is the copy to
/// remove afterwards.
async fn local_source(app: &AppHandle, local: &str, key: &str) -> Result<(String, Option<std::path::PathBuf>), String> {
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
    if !local.contains("://") {
        return Ok((local.to_string(), None));
    }
    let fp: FilePath = local.parse().map_err(err)?;
    if let FilePath::Url(u) = &fp {
        if u.scheme() == "file" {
            let p = u.to_file_path().map_err(|_| format!("Not a file: {local}"))?;
            return Ok((p.to_string_lossy().into_owned(), None));
        }
    }
    let name = key.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("upload");
    let dir = app.path().app_cache_dir().map_err(err)?.join("uploads").join(uuid::Uuid::new_v4().to_string());
    let dest = dir.join(name);
    let app = app.clone();
    let dest2 = dest.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(err)?;
        let mut opts = OpenOptions::new();
        opts.read(true);
        let mut src = app.fs().open(fp, opts).map_err(|e| format!("Could not read the picked file: {e}"))?;
        let mut out = std::fs::File::create(&dest2).map_err(err)?;
        std::io::copy(&mut src, &mut out).map_err(err)?;
        Ok(())
    })
    .await
    .map_err(err)??;
    Ok((dest.to_string_lossy().into_owned(), Some(dest)))
}

#[derive(Clone, Copy)]
enum Kind {
    Upload,
    Download,
}

async fn spawn_transfer(
    app: AppHandle,
    state: &AppState,
    kind: Kind,
    id: String,
    profile_id: String,
    bucket: String,
    key: String,
    local: String,
) -> Result<(), String> {
    let client = client_for(&app, state, &profile_id).await?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(id.clone(), cancel.clone());
    let slots = state.transfer_slots(&profile_id).await;
    emit(&app, &id, "queued", 0, 0, None);

    tauri::async_runtime::spawn(async move {
        let _permit = slots.acquire_owned().await;
        let mut done_bytes = 0u64;
        let result = if cancel.load(Ordering::Relaxed) {
            Ok(Outcome::Cancelled)
        } else {
            let report = |done: u64, total: u64| emit(&app, &id, "running", done, total, None);
            match kind {
                Kind::Upload => match local_source(&app, &local, &key).await {
                    Ok((path, temp)) => {
                        let r = upload_file(&client, &bucket, &key, &path, &cancel, &report).await;
                        if let Ok(Outcome::Done) = r {
                            done_bytes = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
                        }
                        if let Some(t) = temp.as_ref().and_then(|t| t.parent()) {
                            let _ = tokio::fs::remove_dir_all(t).await;
                        }
                        r
                    }
                    Err(e) => Err(e),
                },
                Kind::Download => {
                    let r = download_file(&client, &bucket, &key, &local, &cancel, &report).await;
                    done_bytes = tokio::fs::metadata(&local).await.map(|m| m.len()).unwrap_or(0);
                    r
                }
            }
        };
        match result {
            Ok(Outcome::Done) => emit(&app, &id, "done", done_bytes, done_bytes, None),
            Ok(Outcome::Cancelled) => emit(&app, &id, "cancelled", 0, 0, None),
            Err(e) => emit(&app, &id, "error", 0, 0, Some(e)),
        }
        app.state::<AppState>().cancels.lock().await.remove(&id);
    });
    Ok(())
}

#[tauri::command]
pub async fn start_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    profile_id: String,
    bucket: String,
    key: String,
    local_path: String,
) -> Result<(), String> {
    spawn_transfer(app, &state, Kind::Upload, id, profile_id, bucket, key, local_path).await
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    profile_id: String,
    bucket: String,
    key: String,
    dest_path: String,
) -> Result<(), String> {
    spawn_transfer(app, &state, Kind::Download, id, profile_id, bucket, key, dest_path).await
}

#[tauri::command]
pub async fn cancel_transfer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().await.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{build_client, Profile};
    use std::sync::Mutex;

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

    /// Needs a multipart-capable throwaway S3 server in `S3B_TEST_MULTIPART_ENDPOINT`. Set
    /// `S3B_TEST_SLOW=1` behind a rate-limited proxy to also check that progress moves inside a file.
    #[test]
    fn uploads_arrive_intact_and_report_progress_inside_a_file() {
        // rclone's S3 server can't do multipart uploads, so this test has its own server,
        // for example adobe/s3mock with a `testbucket` bucket.
        let Ok(endpoint) = std::env::var("S3B_TEST_MULTIPART_ENDPOINT") else {
            return eprintln!("skipped: S3B_TEST_MULTIPART_ENDPOINT not set");
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
        };
        let client = build_client(&p, "testsecret");
        tauri::async_runtime::block_on(async move {
            let dir = std::env::temp_dir().join(format!("kybl-up-{}", uuid::Uuid::new_v4()));
            tokio::fs::create_dir_all(&dir).await.unwrap();
            let base = format!("up-{}/", uuid::Uuid::new_v4());
            for (name, size) in [("small.bin", 3usize << 20), ("big.bin", 20 << 20)] {
                let path = dir.join(name);
                tokio::fs::write(&path, vec![42u8; size]).await.unwrap();
                let seen = Mutex::new(Vec::<u64>::new());
                let started = Instant::now();
                let cancel = AtomicBool::new(false);
                let r = upload_file(&client, "testbucket", &format!("{base}{name}"), path.to_str().unwrap(), &cancel, &|done, total| {
                    assert_eq!(total, size as u64);
                    seen.lock().unwrap().push(done);
                })
                .await
                .unwrap();
                assert!(matches!(r, Outcome::Done));
                let head = client.head_object().bucket("testbucket").key(format!("{base}{name}")).send().await.unwrap();
                assert_eq!(head.content_length(), Some(size as i64), "{name} arrived whole");
                let seen = seen.into_inner().unwrap();
                assert!(seen.iter().all(|&d| d <= size as u64));
                assert!(seen.windows(2).all(|w| w[0] <= w[1]), "progress never goes backwards: {seen:?}");
                if std::env::var("S3B_TEST_SLOW").is_ok() && started.elapsed() > Duration::from_secs(2) {
                    let inside = seen.iter().filter(|&&d| d > 0 && d < size as u64).count();
                    assert!(inside >= 3, "{name}: expected progress inside the file, got {seen:?}");
                }
            }
            // a cancelled upload stops and leaves nothing behind
            let path = dir.join("big.bin");
            let stop = AtomicBool::new(true);
            let r = upload_file(&client, "testbucket", &format!("{base}cancelled.bin"), path.to_str().unwrap(), &stop, &|_, _| {})
                .await
                .unwrap();
            assert!(matches!(r, Outcome::Cancelled));
            assert!(client.head_object().bucket("testbucket").key(format!("{base}cancelled.bin")).send().await.is_err());
            let _ = tokio::fs::remove_dir_all(&dir).await;
        });
    }
}
