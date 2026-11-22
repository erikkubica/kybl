//! Copying one planned item: decide what to do about a file already at the destination, pick a
//! route (a native move, a copy on the server, or streaming the bytes through), and verify.

use std::{
    io,
    ops::Range,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use futures_util::StreamExt;

use super::{
    db::{self, End, Item},
    hash::{self, md5_of, Running},
    types::{Conflict, JobMode, JobSpec, Verify},
    Db,
};
use crate::{
    multipart::SINGLE_PUT_LIMIT,
    storage::{
        fold_path, s3_stream, ByteStream, Entry, ErrKind, FolderMode, Loc, PartRecord, ReadStream, RenameMode, Reopen, ResumeState, SResult, ServerCopy,
        Storage, StorageError, WriteOpts, WriteOutcome, WriteSource,
    },
    tuning::LIMITER,
};

/// Times a file is tried before it is reported as failed.
pub const MAX_ATTEMPTS: i64 = 3;
/// Modification times this close count as the same (FAT disks keep 2-second times).
const TIME_SLACK_MS: i64 = 2000;

/// What a running job shares with its copies.
pub struct Ctx {
    pub job_id: String,
    pub spec: Arc<JobSpec>,
    pub src: Arc<dyn Storage>,
    pub dst: Arc<dyn Storage>,
    /// source and destination are the same connection
    pub same_conn: bool,
    pub db: Db,
    pub stop: Arc<AtomicBool>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Ended(End),
    /// worth another try (counts as an attempt)
    Retry(String),
    Failed(String),
    /// the network dropped: back in line, and the job waits a little
    Network(String),
    NeedsAuth(String),
    /// the job is pausing or stopping
    Stopped,
}

pub async fn copy_item(ctx: &Ctx, item: Item, inflight: Arc<AtomicU64>) -> Outcome {
    let r = if item.is_dir { make_dir(ctx, &item).await } else { copy_file(ctx, &item, &inflight).await };
    match r {
        Ok(o) => o,
        Err(e) => classify(ctx, &item, e).await,
    }
}

async fn classify(ctx: &Ctx, item: &Item, e: StorageError) -> Outcome {
    if ctx.stop.load(Ordering::Relaxed) || e.is_cancelled() {
        return Outcome::Stopped;
    }
    let say = e.to_string();
    match e.kind {
        ErrKind::NeedsAuth => Outcome::NeedsAuth(say),
        ErrKind::Network => Outcome::Network(say),
        ErrKind::NotFound if !item.is_dir => match ctx.src.stat(&ctx.spec.src.root, &item.src_path).await {
            Ok(None) => Outcome::Failed("This file isn't there any more. It may have been moved or deleted.".into()),
            // the source is there: the destination is what's missing (a deleted bucket or folder)
            _ => Outcome::Failed(say),
        },
        ErrKind::TooLarge | ErrKind::PermissionDenied | ErrKind::Unsupported | ErrKind::NotFound => Outcome::Failed(say),
        // the source changed since planning: copy it as it is now
        ErrKind::Conflict => {
            if let Ok(Some(now)) = ctx.src.stat(&ctx.spec.src.root, &item.src_path).await {
                abort_upload(ctx, item).await;
                let md5 = md5_of(&now, ctx.src.caps());
                let _ = db::update_src(&ctx.db.lock().unwrap(), &ctx.job_id, &item.src_path, now.size, now.etag.as_deref(), now.modified, md5.as_deref());
            }
            Outcome::Retry("The file changed while it was being copied.".into())
        }
        _ => Outcome::Retry(say),
    }
}

/// Drops an item's unfinished multipart upload (its source changed, so the parts are stale).
pub async fn abort_upload(ctx: &Ctx, item: &Item) {
    if let (Some(s3), Some(id)) = (ctx.dst.as_s3(), &item.upload_id) {
        s3_stream::abort(s3, &ctx.spec.dst.root, &item.dst_path, id).await;
    }
}

fn mode_end(spec: &JobSpec) -> End {
    if spec.mode == JobMode::Move { End::Copied } else { End::Done }
}

/// A folder: made at the destination, so empty folders come along too. Stores whose folders are
/// key prefixes only get a folder marker when nothing else will be copied into the folder.
async fn make_dir(ctx: &Ctx, item: &Item) -> SResult<Outcome> {
    let real = ctx.dst.caps().folders == FolderMode::Real;
    let empty = !db::has_children(&ctx.db.lock().unwrap(), &ctx.job_id, &item.src_path).map_err(StorageError::other)?;
    if !item.dst_path.is_empty() && (real || empty) {
        ctx.dst.mkdir(&ctx.spec.dst.root, &item.dst_path).await?;
    }
    Ok(Outcome::Ended(mode_end(&ctx.spec)))
}

/// How sure we are that the file at the destination is the source's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Same {
    /// sizes and content hashes match
    Strong,
    /// sizes match, and the copy isn't older than the source (or no times to compare)
    Weak,
    Different,
}

pub fn same_file(item: &Item, dst: &Entry, dst_md5: Option<&str>) -> Same {
    if dst.size != item.size {
        return Same::Different;
    }
    if let (Some(a), Some(b)) = (item.md5.as_deref(), dst_md5) {
        return if a.eq_ignore_ascii_case(b) { Same::Strong } else { Same::Different };
    }
    match (item.mtime, dst.modified) {
        // a copy is as new as the original (times kept) or newer (the time it was made)
        (Some(s), Some(d)) if d + TIME_SLACK_MS < s => Same::Different,
        _ => Same::Weak,
    }
}

fn newer(src: Option<i64>, dst: Option<i64>) -> bool {
    matches!((src, dst), (Some(s), Some(d)) if s > d + TIME_SLACK_MS)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Write(String),
    /// leave what is there; `same`: how sure it is the same file (only a [`Same::Strong`] match
    /// lets a move delete the original)
    Skip { same: Same },
    /// what is at the destination is the source itself
    InPlace,
}

/// The conflict policy, applied to what is at the destination now. A copy that is already there
/// (a job resumed after a crash that hid its last few copies) is skipped by every policy.
pub fn decide_with(conflict: Conflict, item: &Item, existing: Option<(&Entry, Option<String>)>) -> Decision {
    let Some((ex, ex_md5)) = existing else { return Decision::Write(item.dst_path.clone()) };
    let same = same_file(item, ex, ex_md5.as_deref());
    let write = || Decision::Write(item.dst_path.clone());
    match conflict {
        // replace unless it's provably the same bytes
        Conflict::Overwrite if same == Same::Strong => Decision::Skip { same },
        Conflict::Overwrite => write(),
        Conflict::Skip => Decision::Skip { same },
        _ if same != Same::Different => Decision::Skip { same },
        Conflict::SkipIdentical => write(),
        Conflict::NewerWins if newer(item.mtime, ex.modified) => write(),
        Conflict::NewerWins => Decision::Skip { same },
        // a free name is picked by the caller
        Conflict::KeepBoth => Decision::Write(String::new()),
    }
}

/// What to do, and what is at the destination now.
async fn decide(ctx: &Ctx, item: &Item) -> SResult<(Decision, Option<Entry>)> {
    let root = &ctx.spec.dst.root;
    let ex = ctx.dst.stat(root, &item.dst_path).await?;
    let ex = ex.filter(|e| !e.is_dir());
    if let Some(e) = &ex
        && same_place(ctx, item, e).await?
    {
        return Ok((Decision::InPlace, ex));
    }
    let md5 = ex.as_ref().and_then(|e| md5_of(e, ctx.dst.caps()));
    let d = match decide_with(ctx.spec.conflict, item, ex.as_ref().map(|e| (e, md5))) {
        Decision::Write(p) if p.is_empty() => Decision::Write(free_name(ctx, item).await?),
        d => d,
    };
    Ok((d, ex))
}

/// The file at the destination (`dst`, at `item.dst_path`) is the source file itself: the same
/// path in the same storage (two connections saved for one place count as one), the same file on
/// this device's disk (roots like Home and Desktop overlap, and names can differ in case), or the
/// same file id in one account. Moving it "there" must not delete it.
pub async fn same_place(ctx: &Ctx, item: &Item, dst: &Entry) -> SResult<bool> {
    let spec = &ctx.spec;
    let same_kind = ctx.src.kind() == ctx.dst.kind();
    let same_store = ctx.same_conn || (same_kind && ctx.src.place_id().is_some() && ctx.src.place_id() == ctx.dst.place_id());
    if same_store && spec.src.root == spec.dst.root {
        let k = ctx.dst.kind();
        if fold_path(k, &item.src_path) == fold_path(k, &item.dst_path) {
            return Ok(true);
        }
    }
    if ctx.src.caps().local_paths && ctx.dst.caps().local_paths {
        let (Some(a), Some(b)) = (ctx.src.local_path(&spec.src.root, &item.src_path), ctx.dst.local_path(&spec.dst.root, &item.dst_path)) else {
            return Ok(false);
        };
        return Ok(tokio::task::spawn_blocking(move || same_local_file(&a, &b)).await.unwrap_or(false));
    }
    if same_kind
        && let Some(id) = &dst.id
        && let Some(src) = ctx.src.stat(&spec.src.root, &item.src_path).await?
    {
        return Ok(src.id.as_ref() == Some(id));
    }
    Ok(false)
}

/// Two paths on this device's disk name one file (links followed: a link to the file counts).
fn same_local_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x.to_string_lossy().to_lowercase() == y.to_string_lossy().to_lowercase(),
            _ => false,
        }
    }
}

/// A file the job only knows the size (and time) of on both sides: hashed where both sides can
/// give a hash (this device's files are read), to tell whether a move may delete the original.
async fn confirm_same(ctx: &Ctx, item: &Item, dst: &Entry) -> SResult<bool> {
    let src_md5 = match &item.md5 {
        Some(m) => Some(m.clone()),
        None if ctx.src.caps().local_paths => {
            let r = ctx.src.read(&ctx.spec.src.root, &item.src_path, None, item.etag.as_deref()).await?;
            Some(hash::md5_stream(r.body).await?)
        }
        None => None,
    };
    let Some(src_md5) = src_md5 else { return Ok(false) };
    let dst_md5 = match md5_of(dst, ctx.dst.caps()) {
        Some(m) => Some(m),
        None if ctx.dst.caps().local_paths => {
            let r = ctx.dst.read(&ctx.spec.dst.root, &item.dst_path, None, None).await?;
            Some(hash::md5_stream(r.body).await?)
        }
        None => None,
    };
    Ok(dst_md5.is_some_and(|d| d.eq_ignore_ascii_case(&src_md5)))
}

/// "dir/name.ext" → "dir/name (1).ext", the first that isn't taken.
pub fn numbered(path: &str, n: u32) -> String {
    let (dir, name) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    format!("{dir}{stem} ({n}){ext}")
}

/// The first numbered name that is free at the destination and that no other file of the job
/// is headed for.
async fn free_name(ctx: &Ctx, item: &Item) -> SResult<String> {
    let kind = ctx.dst.kind();
    for n in 1..10_000 {
        let p = numbered(&item.dst_path, n);
        if db::dst_taken(&ctx.db.lock().unwrap(), &ctx.job_id, &fold_path(kind, &p), &item.src_path).map_err(StorageError::other)? {
            continue;
        }
        if ctx.dst.stat(&ctx.spec.dst.root, &p).await?.is_none() {
            return Ok(p);
        }
    }
    Err(StorageError::exists())
}

fn server_copy_ok(ctx: &Ctx) -> bool {
    ctx.same_conn
        && match ctx.src.caps().server_copy {
            ServerCopy::CrossRoot => true,
            ServerCopy::SameRoot => ctx.spec.src.root == ctx.spec.dst.root,
            ServerCopy::None => false,
        }
}

async fn copy_file(ctx: &Ctx, item: &Item, inflight: &Arc<AtomicU64>) -> SResult<Outcome> {
    let spec = &ctx.spec;
    let mv = spec.mode == JobMode::Move;
    let mut dst_path = item.dst_path.clone();
    if item.upload_id.is_some() {
        // an upload already under way was decided on before; its parts are only good while
        // the source is still what they were read from
        if let Some(o) = source_changed(ctx, item).await? {
            return Ok(o);
        }
    } else {
        match decide(ctx, item).await? {
            (Decision::InPlace, _) => return Ok(Outcome::Ended(End::InPlace)),
            (Decision::Skip { same }, found) => {
                let end = match same {
                    _ if !mv => End::Skipped,
                    Same::Strong => End::SkippedCopied,
                    Same::Weak if found.is_some() && confirm_same(ctx, item, found.as_ref().unwrap()).await? => End::SkippedCopied,
                    Same::Weak => End::SkippedUnsure,
                    Same::Different => End::Skipped,
                };
                if end == End::SkippedCopied
                    && let Some(f) = &found
                {
                    db::record_dst(&ctx.db.lock().unwrap(), &ctx.job_id, &item.src_path, f.etag.as_deref(), f.size, f.modified).map_err(StorageError::other)?;
                }
                return Ok(Outcome::Ended(end));
            }
            (Decision::Write(p), _) => {
                if p != dst_path {
                    let fold = fold_path(ctx.dst.kind(), &p);
                    db::set_dst_path(&ctx.db.lock().unwrap(), &ctx.job_id, &item.src_path, &p, &fold).map_err(StorageError::other)?;
                    dst_path = p;
                }
            }
        }
    }
    let from = Loc::new(&spec.src.root, &item.src_path);
    let to = Loc::new(&spec.dst.root, &dst_path);
    let size = item.size.max(0) as u64;

    // a move inside one connection that renames natively: nothing to copy or verify
    if mv && ctx.same_conn && ctx.src.caps().rename == RenameMode::Native {
        ctx.src.rename(&from, &to, false).await?;
        inflight.store(size, Ordering::Relaxed);
        return Ok(Outcome::Ended(End::Done));
    }

    let (entry, read_md5) = if server_copy_ok(ctx) {
        ctx.src.copy(&from, &to, false).await?;
        inflight.store(size, Ordering::Relaxed);
        let e = ctx.dst.stat(&spec.dst.root, &dst_path).await?.ok_or_else(|| StorageError::other("The copy isn't at the destination."))?;
        (e, None)
    } else {
        match stream(ctx, item, &dst_path, inflight).await? {
            Some(done) => done,
            None => return Ok(Outcome::Stopped),
        }
    };
    if let Err(e) = verify(ctx, item, &dst_path, &entry, read_md5).await {
        // don't leave a bad copy behind (it would look like a finished one)
        let never = AtomicBool::new(false);
        let _ = ctx.dst.delete(&spec.dst.root, std::slice::from_ref(&dst_path), &[], &never, &|_, _| {}).await;
        return Err(e);
    }
    if mv {
        // the copy as the destination reports it now: the original is only deleted while the
        // copy is still this
        let now = ctx.dst.stat(&spec.dst.root, &dst_path).await?.ok_or_else(|| StorageError::other("The copy isn't at the destination."))?;
        db::record_dst(&ctx.db.lock().unwrap(), &ctx.job_id, &item.src_path, now.etag.as_deref(), now.size, now.modified).map_err(StorageError::other)?;
    }
    Ok(Outcome::Ended(if mv { End::Copied } else { End::Done }))
}

/// Whether the file is still what was planned (size, and ETag or time where there are some).
pub fn unchanged(item: &Item, now: &Entry) -> bool {
    if now.size != item.size {
        return false;
    }
    match (&item.etag, &now.etag) {
        (Some(a), Some(b)) => a.trim_matches('"') == b.trim_matches('"'),
        _ => !matches!((item.mtime, now.modified), (Some(a), Some(b)) if a != b),
    }
}

/// Before carrying on with an interrupted upload: if the source changed since its first parts
/// were read, the parts are dropped and the file is copied again from the start.
async fn source_changed(ctx: &Ctx, item: &Item) -> SResult<Option<Outcome>> {
    let now = ctx.src.stat(&ctx.spec.src.root, &item.src_path).await?.ok_or_else(StorageError::not_found)?;
    if unchanged(item, &now) {
        return Ok(None);
    }
    abort_upload(ctx, item).await;
    let md5 = md5_of(&now, ctx.src.caps());
    db::update_src(&ctx.db.lock().unwrap(), &ctx.job_id, &item.src_path, now.size, now.etag.as_deref(), now.modified, md5.as_deref()).map_err(StorageError::other)?;
    Ok(Some(Outcome::Retry("The file changed since its copy began, so it's being copied again from the start.".into())))
}

/// Holds reads to the bandwidth cap (bytes from the network; this device's own disk isn't).
fn throttled(body: ByteStream, remote: bool) -> ByteStream {
    if !remote {
        return body;
    }
    Box::pin(body.then(|chunk| async move {
        if let Ok(c) = &chunk {
            LIMITER.throttle(c.len()).await;
        }
        chunk
    }))
}

fn changed(now: u64, planned: u64) -> StorageError {
    StorageError::new(ErrKind::Conflict, "The file changed while it was being copied.").with_detail(format!("{now} bytes now, {planned} when the job started"))
}

/// Exactly `n` bytes of `body`: anything past them is dropped, and a body that ends early is an
/// error (a short read must never pass for a whole part or file).
pub fn exactly(body: ByteStream, n: u64) -> ByteStream {
    Box::pin(futures_util::stream::unfold(Some((body, n)), |st| async move {
        let (mut body, left) = st?;
        if left == 0 {
            return None;
        }
        match body.next().await {
            Some(Ok(mut c)) => {
                if c.len() as u64 > left {
                    c.truncate(left as usize);
                }
                let rest = left - c.len() as u64;
                Some((Ok(c), Some((body, rest))))
            }
            Some(Err(e)) => Some((Err(e), None)),
            None => Some((Err(io::Error::new(io::ErrorKind::UnexpectedEof, format!("the file ended {left} bytes early"))), None)),
        }
    }))
}

/// Drops the first `n` bytes of `body`.
fn skip_bytes(body: ByteStream, n: u64) -> ByteStream {
    Box::pin(futures_util::stream::unfold((body, n), |(mut body, mut left)| async move {
        loop {
            match body.next().await? {
                Ok(mut c) if left > 0 => {
                    let k = left.min(c.len() as u64) as usize;
                    left -= k as u64;
                    let _ = c.split_to(k);
                    if !c.is_empty() {
                        return Some((Ok(c), (body, 0)));
                    }
                }
                other => return Some((other, (body, left))),
            }
        }
    }))
}

/// The bytes `want` of a ranged read, checked against what the server says it sent: a store
/// that ignored the range and sent the whole file is skipped forward, and a different range is
/// refused (copying it would put the wrong bytes in this part of the file).
pub fn ranged_body(r: ReadStream, want: Range<u64>) -> SResult<ByteStream> {
    let n = want.end - want.start;
    match &r.range {
        Some(got) if got.start != want.start => Err(StorageError::other("The server sent a different part of the file than was asked for.")
            .with_detail(format!("asked for bytes {}-{}, got {}-{}", want.start, want.end, got.start, got.end))),
        Some(_) => Ok(exactly(r.body, n)),
        None => Ok(exactly(skip_bytes(r.body, want.start), n)),
    }
}

/// The whole source file as one stream, refusing a file whose size changed since planning.
async fn open_whole(ctx: &Ctx, item: &Item, remote: bool, hasher: Option<&Running>) -> SResult<ByteStream> {
    let size = item.size.max(0) as u64;
    // the ETag planned: a store that can check it refuses a file that changed since
    let r = ctx.src.read(&ctx.spec.src.root, &item.src_path, None, item.etag.as_deref()).await?;
    if let Some(t) = r.total.or(r.len)
        && t != size
    {
        return Err(changed(t, size));
    }
    let body = throttled(exactly(r.body, size), remote);
    Ok(match hasher {
        Some(h) => hash::tap(body, h),
        None => body,
    })
}

/// Streams the bytes through. Some((what was written, MD5 of what was read when it was hashed)),
/// None when stopped.
async fn stream(ctx: &Ctx, item: &Item, dst_path: &str, inflight: &Arc<AtomicU64>) -> SResult<Option<(Entry, Option<String>)>> {
    let spec = &ctx.spec;
    let size = item.size.max(0) as u64;
    let remote = !ctx.src.caps().local_paths;
    let hashing = spec.verify == Verify::Hash;
    let hasher = Running::default();
    let progress = |done: u64, _total: u64| inflight.store(done, Ordering::Relaxed);
    let modified = if spec.preserve_mtime { item.mtime } else { None };

    let hash_with = hashing.then_some(&hasher);

    if let Some(s3) = ctx.dst.as_s3() {
        let part = s3_stream::part_size(Some(size));
        let resume = match (&item.upload_id, &item.parts_json) {
            (Some(id), Some(json)) => serde_json::from_str::<ResumeState>(json).ok().filter(|r| r.upload_id == *id),
            _ => None,
        };
        let state = Mutex::new(resume.clone());
        let (db, job_id, src_path) = (ctx.db.clone(), ctx.job_id.clone(), item.src_path.clone());
        // every part is saved as it lands, so a restart only sends what is missing
        let on_part = move |p: PartRecord| {
            let mut st = state.lock().unwrap();
            if p.number == 0 {
                *st = Some(ResumeState { upload_id: p.etag, part_size: p.size, parts: vec![] });
            } else if let Some(rs) = st.as_mut() {
                rs.parts.retain(|q| q.number != p.number);
                rs.parts.push(p);
            }
            if let Some(rs) = st.as_ref() {
                let json = serde_json::to_string(rs).ok();
                let _ = db::set_upload(&db.lock().unwrap(), &job_id, &src_path, Some(&rs.upload_id), json.as_deref());
            }
        };
        let ranged = ctx.src.caps().range_read && size > SINGLE_PUT_LIMIT;
        let (body, reopen): (ByteStream, Option<Reopen>) = if ranged {
            let (src, root, path, etag) = (ctx.src.clone(), spec.src.root.clone(), item.src_path.clone(), item.etag.clone());
            // each part read on its own, several at once, each from the version planned (so a
            // file changing midway can't end up as a mix of two versions)
            let reopen: Reopen = Box::new(move |off| {
                let (src, root, path, etag) = (src.clone(), root.clone(), path.clone(), etag.clone());
                Box::pin(async move {
                    let end = (off + part).min(size);
                    let r = src.read(&root, &path, Some(off..end), etag.as_deref()).await.map_err(io::Error::other)?;
                    if let Some(t) = r.total
                        && t != size
                    {
                        return Err(io::Error::other(changed(t, size)));
                    }
                    Ok(throttled(ranged_body(r, off..end).map_err(io::Error::other)?, remote))
                })
            });
            (Box::pin(futures_util::stream::empty()), Some(reopen))
        } else {
            (open_whole(ctx, item, remote, hash_with).await?, None)
        };
        let opts = WriteOpts { part_size: Some(part), resume, on_part: Some(&on_part), modified, ..Default::default() };
        return match s3_stream::upload_stream(s3, &spec.dst.root, dst_path, Some(size), body, reopen, opts, &progress, &ctx.stop).await? {
            WriteOutcome::Done(e) => Ok(Some((e, (hashing && !ranged).then(|| hasher.hex())))),
            WriteOutcome::Cancelled => Ok(None),
            WriteOutcome::Conflict(_) => Err(StorageError::conflict()),
        };
    }

    let body = open_whole(ctx, item, remote, hash_with).await?;
    let opts = WriteOpts { modified, ..Default::default() };
    match ctx.dst.write(&spec.dst.root, dst_path, WriteSource::Stream { len: Some(size), body, reopen: None }, opts, &progress, &ctx.stop).await? {
        WriteOutcome::Done(e) => Ok(Some((e, hashing.then(|| hasher.hex())))),
        WriteOutcome::Cancelled => Ok(None),
        WriteOutcome::Conflict(_) => Err(StorageError::conflict()),
    }
}

/// Size always; with `verify: hash`, content hashes wherever there are two to compare: what was
/// read against what the source reports, and against the copy (re-read when it's on this
/// device, or as the destination reports it). S3 targets were checked per part on arrival.
async fn verify(ctx: &Ctx, item: &Item, dst_path: &str, entry: &Entry, read_md5: Option<String>) -> SResult<()> {
    if entry.size != item.size {
        return Err(StorageError::other("The copy came out a different size than the original, so it will be sent again.")
            .with_detail(format!("{} bytes instead of {}", entry.size, item.size)));
    }
    if ctx.spec.verify != Verify::Hash {
        return Ok(());
    }
    if let (Some(r), Some(s)) = (&read_md5, &item.md5)
        && !r.eq_ignore_ascii_case(s)
    {
        return Err(StorageError::new(ErrKind::Conflict, "The file read differently than its server reports, so it will be read again."));
    }
    let Some(want) = read_md5.or_else(|| item.md5.clone()) else { return Ok(()) };
    let have = if ctx.dst.caps().local_paths {
        let r = ctx.dst.read(&ctx.spec.dst.root, dst_path, None, None).await?;
        Some(hash::md5_stream(r.body).await?)
    } else {
        md5_of(entry, ctx.dst.caps())
    };
    match have {
        Some(h) if !h.eq_ignore_ascii_case(&want) => {
            Err(StorageError::other("The copy's contents don't match the original, so it will be sent again.").with_detail(format!("MD5 {h}, expected {want}")))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(size: i64, mtime: Option<i64>, md5: Option<&str>) -> Item {
        Item { src_path: "a.txt".into(), dst_path: "d/a.txt".into(), size, mtime, md5: md5.map(str::to_string), ..Default::default() }
    }

    fn entry(size: i64, modified: Option<i64>) -> Entry {
        Entry { key: "d/a.txt".into(), size, modified, ..Default::default() }
    }

    #[test]
    fn sameness() {
        assert_eq!(same_file(&item(3, None, None), &entry(4, None), None), Same::Different);
        assert_eq!(same_file(&item(3, None, Some("ab")), &entry(3, None), Some("AB")), Same::Strong);
        assert_eq!(same_file(&item(3, None, Some("ab")), &entry(3, None), Some("cd")), Same::Different);
        assert_eq!(same_file(&item(3, Some(10_000), None), &entry(3, Some(50_000)), None), Same::Weak);
        assert_eq!(same_file(&item(3, Some(10_000), None), &entry(3, Some(9_000)), None), Same::Weak, "within the slack");
        assert_eq!(same_file(&item(3, Some(10_000), None), &entry(3, Some(1_000)), None), Same::Different, "the copy is older");
    }

    #[test]
    fn policies() {
        let src = item(3, Some(100_000), None);
        let older = entry(5, Some(1_000));
        let newer_dst = entry(5, Some(900_000));
        let same = entry(3, Some(200_000));
        let w = |d: Decision| matches!(d, Decision::Write(p) if p == "d/a.txt");
        let skip = |d: Decision, s: bool| matches!(d, Decision::Skip { same } if (same != Same::Different) == s);
        assert!(w(decide_with(Conflict::SkipIdentical, &src, None)), "nothing there: write");
        assert!(w(decide_with(Conflict::SkipIdentical, &src, Some((&older, None)))));
        assert!(skip(decide_with(Conflict::SkipIdentical, &src, Some((&same, None))), true));
        assert!(skip(decide_with(Conflict::Skip, &src, Some((&older, None))), false));
        assert!(skip(decide_with(Conflict::Skip, &src, Some((&same, None))), true));
        assert!(w(decide_with(Conflict::Overwrite, &src, Some((&same, None)))), "weakly the same: overwrite anyway");
        let hashed = item(3, None, Some("ab"));
        assert!(skip(decide_with(Conflict::Overwrite, &hashed, Some((&same, Some("ab".into())))), true));
        assert!(w(decide_with(Conflict::NewerWins, &src, Some((&older, None)))));
        assert!(skip(decide_with(Conflict::NewerWins, &src, Some((&newer_dst, None))), false));
        assert!(matches!(decide_with(Conflict::KeepBoth, &src, Some((&older, None))), Decision::Write(p) if p.is_empty()));
        assert!(skip(decide_with(Conflict::KeepBoth, &src, Some((&same, None))), true));
    }

    /// Only provably identical files may let a move delete the original: every policy says how
    /// sure it is, and a size-and-time match is never Strong.
    #[test]
    fn skips_say_how_sure_they_are() {
        let src = item(3, Some(100_000), None);
        let weak = entry(3, Some(200_000));
        for c in [Conflict::SkipIdentical, Conflict::Skip, Conflict::KeepBoth, Conflict::NewerWins] {
            assert_eq!(decide_with(c, &src, Some((&weak, None))), Decision::Skip { same: Same::Weak }, "{c:?}");
        }
        let hashed = item(3, None, Some("ab"));
        for c in [Conflict::SkipIdentical, Conflict::Skip, Conflict::KeepBoth, Conflict::NewerWins, Conflict::Overwrite] {
            assert_eq!(decide_with(c, &hashed, Some((&weak, Some("AB".into())))), Decision::Skip { same: Same::Strong }, "{c:?}");
        }
        assert_eq!(decide_with(Conflict::Skip, &src, Some((&entry(9, None), None))), Decision::Skip { same: Same::Different });
    }

    fn body_of(chunks: &[&'static [u8]]) -> ByteStream {
        Box::pin(futures_util::stream::iter(chunks.iter().map(|c| Ok(bytes::Bytes::from_static(c))).collect::<Vec<_>>()))
    }

    async fn all(b: ByteStream) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut b = b;
        while let Some(c) = b.next().await {
            out.extend_from_slice(&c?);
        }
        Ok(out)
    }

    fn read_of(chunks: &[&'static [u8]], range: Option<Range<u64>>) -> ReadStream {
        ReadStream { body: body_of(chunks), len: None, total: Some(10), range, etag: None, content_type: None }
    }

    /// A store that ignores the range sends the whole file: the part is cut out of it. A
    /// different range is refused, and a short body is an error, never a short part.
    #[test]
    fn ranged_reads_are_checked() {
        tauri::async_runtime::block_on(async {
            let whole: &[&'static [u8]] = &[b"0123", b"4567", b"89"];
            assert_eq!(all(ranged_body(read_of(whole, None), 3..7).unwrap()).await.unwrap(), b"3456");
            assert_eq!(all(ranged_body(read_of(&[b"3456"], Some(3..7)), 3..7).unwrap()).await.unwrap(), b"3456");
            assert!(ranged_body(read_of(&[b"0123"], Some(0..4)), 3..7).is_err(), "another range");
            assert!(all(ranged_body(read_of(&[b"34"], Some(3..5)), 3..7).unwrap()).await.is_err(), "too short");
            assert!(all(ranged_body(read_of(&[b"0123"], None), 3..7).unwrap()).await.is_err(), "whole file too short");
            assert_eq!(all(exactly(body_of(&[b"abc", b"def"]), 4)).await.unwrap(), b"abcd");
        });
    }

    #[test]
    fn unchanged_sources() {
        let mut it = item(3, Some(1000), None);
        it.etag = Some("\"e1\"".into());
        let now = |size, etag: Option<&str>, modified| Entry { size, etag: etag.map(str::to_string), modified, ..Default::default() };
        assert!(unchanged(&it, &now(3, Some("e1"), Some(5))), "quotes don't count; ETags win over times");
        assert!(!unchanged(&it, &now(3, Some("e2"), Some(1000))));
        assert!(!unchanged(&it, &now(4, Some("e1"), Some(1000))));
        it.etag = None;
        assert!(unchanged(&it, &now(3, None, Some(1000))));
        assert!(!unchanged(&it, &now(3, None, Some(2000))));
    }

    #[test]
    fn numbered_names() {
        assert_eq!(numbered("d/photo.jpg", 1), "d/photo (1).jpg");
        assert_eq!(numbered("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(numbered("d/.env", 1), "d/.env (1)");
        assert_eq!(numbered("README", 3), "README (3)");
    }
}
