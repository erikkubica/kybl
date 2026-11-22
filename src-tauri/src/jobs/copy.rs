//! Copying one planned item: decide what to do about a file already at the destination, pick a
//! route (a native move, a copy on the server, or streaming the bytes through), and verify.

use std::{
    io,
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
        s3_stream, ByteStream, Entry, ErrKind, FolderMode, Loc, PartRecord, RenameMode, Reopen, ResumeState, SResult, ServerCopy, Storage, StorageError,
        WriteOpts, WriteOutcome, WriteSource,
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

pub enum Decision {
    Write(String),
    /// leave what is there; `same`: it is the same file (a move may delete the original)
    Skip { same: bool },
}

/// The conflict policy, applied to what is at the destination now. A copy that is already there
/// (a job resumed after a crash that hid its last few copies) is skipped by every policy.
pub fn decide_with(conflict: Conflict, item: &Item, existing: Option<(&Entry, Option<String>)>) -> Decision {
    let Some((ex, ex_md5)) = existing else { return Decision::Write(item.dst_path.clone()) };
    let same = same_file(item, ex, ex_md5.as_deref());
    let write = || Decision::Write(item.dst_path.clone());
    match conflict {
        // replace unless it's provably the same bytes
        Conflict::Overwrite if same == Same::Strong => Decision::Skip { same: true },
        Conflict::Overwrite => write(),
        Conflict::Skip => Decision::Skip { same: same != Same::Different },
        _ if same != Same::Different => Decision::Skip { same: true },
        Conflict::SkipIdentical => write(),
        Conflict::NewerWins if newer(item.mtime, ex.modified) => write(),
        Conflict::NewerWins => Decision::Skip { same: false },
        // a free name is picked by the caller
        Conflict::KeepBoth => Decision::Write(String::new()),
    }
}

async fn decide(ctx: &Ctx, item: &Item) -> SResult<Decision> {
    let root = &ctx.spec.dst.root;
    let ex = ctx.dst.stat(root, &item.dst_path).await?;
    let ex = ex.filter(|e| !e.is_dir());
    let md5 = ex.as_ref().and_then(|e| md5_of(e, ctx.dst.caps()));
    Ok(match decide_with(ctx.spec.conflict, item, ex.as_ref().map(|e| (e, md5))) {
        Decision::Write(p) if p.is_empty() => Decision::Write(free_name(&*ctx.dst, root, &item.dst_path).await?),
        d => d,
    })
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

async fn free_name(dst: &dyn Storage, root: &str, path: &str) -> SResult<String> {
    for n in 1..10_000 {
        let p = numbered(path, n);
        if dst.stat(root, &p).await?.is_none() {
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
    // an upload already under way was decided on before
    if item.upload_id.is_none() {
        match decide(ctx, item).await? {
            Decision::Skip { same } => return Ok(Outcome::Ended(if mv && same { End::SkippedCopied } else { End::Skipped })),
            Decision::Write(p) => {
                if p != dst_path {
                    db::set_dst_path(&ctx.db.lock().unwrap(), &ctx.job_id, &item.src_path, &p).map_err(StorageError::other)?;
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
    Ok(Outcome::Ended(if mv { End::Copied } else { End::Done }))
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

/// The whole source file as one stream, refusing a file whose size changed since planning.
async fn open_whole(ctx: &Ctx, item: &Item, remote: bool, hasher: Option<&Running>) -> SResult<ByteStream> {
    let size = item.size.max(0) as u64;
    let r = ctx.src.read(&ctx.spec.src.root, &item.src_path, None, None).await?;
    if let Some(t) = r.total.or(r.len)
        && t != size
    {
        return Err(changed(t, size));
    }
    let body = throttled(r.body, remote);
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
            let (src, root, path) = (ctx.src.clone(), spec.src.root.clone(), item.src_path.clone());
            // each part read on its own, several at once
            let reopen: Reopen = Box::new(move |off| {
                let (src, root, path) = (src.clone(), root.clone(), path.clone());
                Box::pin(async move {
                    let end = (off + part).min(size);
                    let r = src.read(&root, &path, Some(off..end), None).await.map_err(io::Error::other)?;
                    if let Some(t) = r.total
                        && t != size
                    {
                        return Err(io::Error::other(changed(t, size)));
                    }
                    Ok(throttled(r.body, remote))
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
        let skip = |d: Decision, s: bool| matches!(d, Decision::Skip { same } if same == s);
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

    #[test]
    fn numbered_names() {
        assert_eq!(numbered("d/photo.jpg", 1), "d/photo (1).jpg");
        assert_eq!(numbered("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(numbered("d/.env", 1), "d/.env (1)");
        assert_eq!(numbered("README", 3), "README (3)");
    }
}
