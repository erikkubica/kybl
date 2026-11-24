//! Carries out a sync plan between a local folder and any connection (S3 through its adapter,
//! SFTP, WebDAV, cloud drives, or another local folder).
//!
//! Transfers go through the same code as the transfer list: S3 downloads resume dropped
//! connections, uploads use multipart, everything counts against the bandwidth cap, partial
//! downloads (`.s3part`) and unfinished multipart uploads are tracked for clean-up. The base is
//! written after every finished step, so a run that stops half-way is simply planned again.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::task::JoinSet;

use super::{
    local::{self, build_ignore, is_ignored, local_meta, local_path_of, now_ms, LocalSnapshot, REMOTE_TRASH},
    plan::{self, BaseEntry, Guard, Held, HoldReason, Op, RemoteMeta, Side, SkipReason, TwoWayOpts},
    remote::{self, RemoteSnapshot},
    state::{PendingDelete, SyncDb},
};
use crate::{
    storage::{generic_cmds, ConnKind, Loc, Precondition, Storage, WriteOpts, WriteOutcome, WriteSource},
    transfers::Outcome,
};

/// Parallel transfers per mapping.
const CONCURRENCY: usize = 4;

/// Progress of a run, as the status line shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tick {
    pub done: u32,
    pub total: u32,
    pub bytes: u64,
    pub total_bytes: u64,
    /// the file everybody is waiting for
    pub current: Option<String>,
}

#[derive(Default, Debug)]
pub struct RunResult {
    /// what the run did, e.g. "3 uploaded · 1 deleted on S3"
    pub summary: String,
    pub errors: Vec<String>,
    /// files tracked as in sync
    pub files: usize,
    /// conflict copies waiting for the user
    pub conflicts: usize,
    /// deletions held for a confirmation
    pub pending: usize,
}

/// One mapping's run: where the two sides are and how to treat deletions.
pub struct Engine<'a> {
    pub id: String,
    pub local_root: PathBuf,
    pub remote: Arc<dyn Storage>,
    /// the bucket (or root) on the other side
    pub root: String,
    /// "" or ending with "/"
    pub prefix: String,
    pub ignore: Vec<String>,
    pub mirror_deletes: bool,
    /// deleted remote files go to `<prefix>.kybl-trash/<date>/` where the store has no trash
    pub remote_trash: bool,
    pub delete_guard: bool,
    /// local deletions go to the system Trash (false: removed, for tests)
    pub local_trash: bool,
    pub db: &'a SyncDb,
    pub cancel: Arc<AtomicBool>,
    pub report: &'a (dyn Fn(Tick) + Send + Sync),
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// The summary part for names left alone because they collide once normalised.
fn dupes_note(n: usize) -> Option<String> {
    (n > 0).then(|| format!("{} skipped: the same name is spelled two ways (accents), so Kybl left it alone", plural(n, "name")))
}

/// "t/2026-11-22/dir/a.txt" -> "t/2026-11-22/dir/a (2).txt"
fn numbered(key: &str, n: u32) -> String {
    let (dir, name) = match key.rfind('/') {
        Some(i) => (&key[..=i], &key[i + 1..]),
        None => ("", key),
    };
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{dir}{} ({n}){}", &name[..i], &name[i..]),
        _ => format!("{dir}{name} ({n})"),
    }
}

/// Byte progress of one run: finished files plus what the running transfers have sent so far.
#[derive(Default)]
struct RunBytes {
    finished: AtomicU64,
    /// rel -> (bytes sent, size) of transfers in flight
    active: std::sync::Mutex<HashMap<String, (u64, u64)>>,
}

impl RunBytes {
    fn total(&self) -> u64 {
        self.finished.load(Ordering::Relaxed) + self.active.lock().unwrap().values().map(|(s, _)| *s).sum::<u64>()
    }
    fn slowest(&self) -> Option<String> {
        self.active.lock().unwrap().iter().max_by_key(|(_, (sent, size))| size.saturating_sub(*sent)).map(|(rel, _)| rel.clone())
    }
}

/// What the local file must still be when a download is about to replace it: the plan saw it
/// that way, and an edit made since must not be overwritten.
#[derive(Clone, Copy, Debug)]
enum Expect {
    Absent,
    Matches(u64, i64),
}

enum Job {
    Up { rel: String, path: PathBuf, key: String, size: u64, mtime: i64, file_id: Option<String>, pre: Precondition },
    Down { rel: String, key: String, dest: PathBuf, remote: RemoteMeta, keep_local: bool, expect: Expect },
}

impl Job {
    fn rel(&self) -> &str {
        match self {
            Job::Up { rel, .. } | Job::Down { rel, .. } => rel,
        }
    }
    fn size(&self) -> u64 {
        match self {
            Job::Up { size, .. } => *size,
            Job::Down { remote, .. } => remote.size,
        }
    }
}

enum Done {
    Synced(BaseEntry),
    /// changed again while the run was going: the next run looks at it afresh
    Skipped,
    /// can't happen until the user acts (a folder here where the other side has a file of that
    /// name): a notice that stands, and not a reason to read the same changes again (B4-2)
    Blocked(String),
    Cancelled,
}

struct JobCtx {
    remote: Arc<dyn Storage>,
    root: String,
    /// the synced folder: downloads never write through a link below it
    local_root: PathBuf,
    md5: bool,
    cancel: Arc<AtomicBool>,
}

async fn exec(job: Job, ctx: Arc<JobCtx>, bytes: Arc<RunBytes>) -> (String, Result<Done, String>) {
    let rel = job.rel().to_string();
    let size = job.size();
    bytes.active.lock().unwrap().insert(rel.clone(), (0, size));
    let (b, r) = (bytes.clone(), rel.clone());
    let progress = move |sent: u64, total: u64| {
        b.active.lock().unwrap().insert(r.clone(), (sent, total.max(size)));
    };
    let out = exec_transfer(job, &ctx, &progress).await;
    bytes.active.lock().unwrap().remove(&rel);
    if matches!(out, Ok(Done::Synced(_))) {
        bytes.finished.fetch_add(size, Ordering::Relaxed);
    }
    (rel, out)
}

async fn exec_transfer(job: Job, ctx: &JobCtx, progress: &(dyn Fn(u64, u64) + Send + Sync)) -> Result<Done, String> {
    match job {
        Job::Up { path, key, size, mtime, file_id, pre, .. } => {
            let opts = WriteOpts { modified: Some(mtime), precondition: pre, ..Default::default() };
            match ctx.remote.write(&ctx.root, &key, WriteSource::Path(path), opts, progress, &ctx.cancel).await? {
                WriteOutcome::Done(e) => {
                    let r = remote::remote_meta(&e, ctx.md5);
                    // record what was scanned: an edit made during the upload is picked up next run
                    Ok(Done::Synced(BaseEntry {
                        l_size: size,
                        l_mtime: mtime,
                        l_fileid: file_id,
                        r_size: if r.etag.is_empty() && r.size == 0 { size } else { r.size },
                        r_etag: r.etag,
                        r_mtime: r.modified,
                        r_id: r.id,
                    }))
                }
                WriteOutcome::Cancelled => Ok(Done::Cancelled),
                WriteOutcome::Conflict(_) => Ok(Done::Skipped),
            }
        }
        Job::Down { key, dest, remote, keep_local, expect, .. } => {
            // a folder on the way that is a link (`work -> ~/Documents`) isn't in the scan, so
            // the file looks absent here: writing it would land outside the synced folder
            local::no_link_on_the_way(&ctx.local_root, &dest)?;
            let now = std::fs::metadata(&dest).ok();
            if now.as_ref().is_some_and(|m| !m.is_file()) {
                // not a race that the next run settles: it stays so until the user renames one
                return Ok(Done::Blocked("a folder with this name is here, where the other side has a file. Rename one of them to sync it.".into()));
            }
            let still = match (expect, &now) {
                (Expect::Absent, None) => true,
                (Expect::Matches(s, m), Some(meta)) => meta.len() == s && local::mtime_ms(meta) == m,
                _ => false,
            };
            if !still {
                return Ok(Done::Skipped);
            }
            if keep_local && now.is_some() {
                std::fs::rename(&dest, local::local_copy_path(&dest)).map_err(|e| format!("could not keep the local copy: {e}"))?;
            }
            let out = match ctx.remote.as_s3() {
                // S3 keeps its own download path: it carries on after a dropped connection
                Some(s3) => crate::transfers::download_file(s3.client(), &ctx.root, &key, &dest.to_string_lossy(), &ctx.cancel, progress).await?,
                None => generic_cmds::download(&*ctx.remote, &ctx.root, &key, &dest, &ctx.cancel, progress, None).await?,
            };
            match out {
                Outcome::Done => {
                    // the remote file's time, so Finder shows when it was made, not downloaded
                    local::set_mtime(&dest, remote.modified);
                    if ctx.remote.local_path(&ctx.root, &key).is_none() {
                        crate::platform::quarantine::mark(&dest);
                    }
                    let meta = std::fs::metadata(&dest).map_err(|e| e.to_string())?;
                    Ok(Done::Synced(BaseEntry::of(&local_meta(&meta), &remote)))
                }
                Outcome::Cancelled => Ok(Done::Cancelled),
            }
        }
    }
}

impl Engine<'_> {
    fn md5(&self) -> bool {
        remote::etag_is_md5(&*self.remote)
    }

    /// How the other side is called in summaries ("deleted on S3").
    fn there(&self) -> String {
        match self.remote.kind() {
            ConnKind::Local => "the other folder".into(),
            k => k.label().to_string(),
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn check_root(&self) -> Result<(), String> {
        if self.local_root.is_dir() {
            Ok(())
        } else {
            Err(format!("The folder {} is missing. Is the drive connected?", self.local_root.display()))
        }
    }

    /// The base, minus paths the ignore rules now cover: newly ignored files are forgotten, never
    /// deleted.
    fn load_base(&self, gi: &ignore::gitignore::Gitignore) -> Result<HashMap<String, BaseEntry>, String> {
        let mut base = self.db.load_base(&self.id)?;
        let ignored: Vec<String> = base.keys().filter(|k| is_ignored(gi, k)).cloned().collect();
        self.db.drop_base_many(&self.id, &ignored)?;
        base.retain(|k, _| !ignored.contains(k));
        Ok(base)
    }

    async fn scan_local(&self, gi: &ignore::gitignore::Gitignore, base: &HashMap<String, BaseEntry>, dirty: Option<HashSet<PathBuf>>) -> Result<LocalSnapshot, String> {
        let (root, gi, base) = (self.local_root.clone(), gi.clone(), base.clone());
        tokio::task::spawn_blocking(move || match dirty {
            Some(d) if !base.is_empty() => local::rescan_dirty(&root, &gi, &base, &d),
            _ => local::scan_local(&root, &gi),
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// What this run leaves alone: folders and files that couldn't be read here, links here (a
    /// synced folder replaced by a link isn't deleted on the other side, and nothing is written
    /// through it), and names that collide once normalised on either side. They are taken out of
    /// both snapshots and the base, so nothing is deleted (or sent) for them; the base rows stay
    /// in sync.db for the next run. Links are left alone without a word (they are common: a
    /// project's `node_modules/.bin`, a `.venv`), and must not turn every run into a failure.
    /// Answers the notice to show for the unreadable ones; Err when the folder itself can't be
    /// read (nothing in it can be trusted to be gone).
    fn exclude(
        &self,
        base: &mut HashMap<String, BaseEntry>,
        local: &mut LocalSnapshot,
        remote: Option<&mut RemoteSnapshot>,
    ) -> Result<Vec<String>, String> {
        if local.unreadable.iter().any(|p| p.is_empty()) {
            return Err(format!("Kybl can't read the folder {}. Check that it is allowed to, then sync again.", self.local_root.display()));
        }
        if local.partial
            && let Some(r) = &remote
        {
            // a quick run looked only at what changed here: a change the other side reports
            // below a link that was already here is left alone too, not failed (B4-1)
            let fresh = r.files.keys().filter(|k| !base.contains_key(*k) && !local.files.contains_key(*k)).map(String::as_str);
            let found = local::links_above(&self.local_root, fresh, &mut HashMap::new());
            local.links.extend(found);
        }
        let mut ex = plan::Excluded::default();
        for p in local.unreadable.iter().chain(&local.dupes).chain(&local.links) {
            ex.add(p);
        }
        if let Some(r) = &remote {
            for p in r.dupes.iter().chain(&r.links) {
                ex.add(p);
            }
        }
        if ex.is_empty() {
            return Ok(vec![]);
        }
        ex.strip(base);
        ex.strip(&mut local.files);
        if let Some(r) = remote {
            ex.strip(&mut r.files);
        }
        let mut notes = Vec::new();
        let mut unreadable = local.unreadable.clone();
        unreadable.sort();
        unreadable.dedup();
        match unreadable.as_slice() {
            [] => {}
            [one] => notes.push(format!("Kybl couldn't read {one} on this computer, so it was left alone this time (nothing in it was synced or deleted).")),
            [first, ..] => notes.push(format!(
                "Kybl couldn't read {} on this computer (like {first}), so they were left alone this time (nothing in them was synced or deleted).",
                plural(unreadable.len(), "item")
            )),
        }
        Ok(notes)
    }

    /// Works out local MD5s only where they decide between "the same" and "a conflict" (both
    /// sides changed or untracked, same size, and the other side knows its MD5).
    async fn fill_md5(&self, local: &mut LocalSnapshot, remote: &RemoteSnapshot, base: &HashMap<String, BaseEntry>) -> Result<(), String> {
        let want = plan::hash_candidates(&local.files, &remote.files, base);
        if want.is_empty() {
            return Ok(());
        }
        let paths: Vec<(String, PathBuf)> = want.iter().map(|r| (r.clone(), local.path(&self.local_root, r))).collect();
        let sums = tokio::task::spawn_blocking(move || paths.into_iter().filter_map(|(r, p)| Some((r, local::md5_file(&p).ok()?))).collect::<Vec<_>>())
            .await
            .map_err(|e| e.to_string())?;
        for (r, sum) in sums {
            if let Some(l) = local.files.get_mut(&r) {
                l.md5 = Some(sum);
            }
        }
        Ok(())
    }

    async fn scan_remote(&self, gi: &ignore::gitignore::Gitignore) -> Result<RemoteSnapshot, String> {
        Ok(remote::scan_remote(&*self.remote, &self.root, &self.prefix, gi, &self.cancel).await?)
    }

    /// The remote key a local path goes to: the stored spelling where the file is known there,
    /// else the name as it is on this disk.
    fn push_key(&self, rel: &str, local: &LocalSnapshot, remote: &RemoteSnapshot) -> String {
        if remote.files.contains_key(rel) {
            remote.key(&self.prefix, rel)
        } else {
            format!("{}{}", self.prefix, local.raw.get(rel).map(String::as_str).unwrap_or(rel))
        }
    }

    fn pull_dest(&self, rel: &str, local: &LocalSnapshot, remote: &RemoteSnapshot) -> PathBuf {
        if local.files.contains_key(rel) {
            local.path(&self.local_root, rel)
        } else {
            local_path_of(&self.local_root, remote.raw.get(rel).map(String::as_str).unwrap_or(rel))
        }
    }

    /// Runs the transfers with limited parallelism, writing the base and reporting as they
    /// finish. Answers how many uploads and downloads made it, and whether any was skipped
    /// because its file changed again meanwhile (left for the next run to look at afresh).
    /// Transfers that wait for the user ([`Done::Blocked`]) go to `notices`, not `errors`.
    async fn run_jobs(&self, jobs: Vec<Job>, total: u32, errors: &mut Vec<String>, notices: &mut Vec<String>) -> (usize, usize, bool) {
        let ups: HashSet<String> = jobs.iter().filter(|j| matches!(j, Job::Up { .. })).map(|j| j.rel().to_string()).collect();
        let total_bytes: u64 = jobs.iter().map(Job::size).sum();
        let bytes = Arc::new(RunBytes::default());
        let ctx = Arc::new(JobCtx { remote: self.remote.clone(), root: self.root.clone(), local_root: self.local_root.clone(), md5: self.md5(), cancel: self.cancel.clone() });
        let mut set = JoinSet::new();
        let mut queue = jobs.into_iter();
        let (mut done, mut up_ok, mut down_ok, mut skipped) = (0u32, 0usize, 0usize, false);
        // a single big file can take many minutes: report byte progress on a timer, not only per file
        let mut tick = tokio::time::interval(Duration::from_millis(400));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            while set.len() < CONCURRENCY && !self.cancelled() {
                let Some(job) = queue.next() else { break };
                set.spawn(exec(job, ctx.clone(), bytes.clone()));
            }
            if set.is_empty() {
                break;
            }
            tokio::select! {
                joined = set.join_next() => {
                    let Some(joined) = joined else { break };
                    done += 1;
                    if let Ok((rel, res)) = joined {
                        match res {
                            Ok(Done::Synced(b)) => match self.db.put_base(&self.id, &rel, &b, now_ms()) {
                                Ok(()) if ups.contains(&rel) => up_ok += 1,
                                Ok(()) => down_ok += 1,
                                Err(e) => errors.push(format!("{rel}: {e}")),
                            },
                            Ok(Done::Skipped) => skipped = true,
                            Ok(Done::Blocked(why)) => notices.push(format!("{rel}: {why}")),
                            Ok(Done::Cancelled) => {}
                            Err(e) if e == crate::storage::CANCELLED => {}
                            Err(e) => errors.push(format!("{rel}: {e}")),
                        }
                    }
                }
                _ = tick.tick() => {}
            }
            (self.report)(Tick { done, total, bytes: bytes.total(), total_bytes, current: bytes.slowest() });
        }
        (up_ok, down_ok, skipped)
    }

    /// Deletes (or moves to the remote trash) the given paths on the other side. Answers the
    /// paths that are gone.
    async fn delete_remote(&self, items: &[(String, String)], errors: &mut Vec<String>) -> Vec<String> {
        let mut gone = Vec::new();
        if items.is_empty() || self.cancelled() {
            return gone;
        }
        if self.remote_trash && !self.remote.caps().trash {
            let day = local::ymd(now_ms());
            for (rel, key) in items {
                if self.cancelled() {
                    break;
                }
                let inside = key.strip_prefix(&self.prefix).unwrap_or(rel);
                let first = format!("{}{REMOTE_TRASH}/{day}/{inside}", self.prefix);
                // a file deleted twice the same day keeps both trashed versions
                let mut to = first.clone();
                let mut n = 1;
                let free = loop {
                    match self.remote.stat(&self.root, &to).await {
                        Ok(None) => break true,
                        Ok(Some(_)) if n < 1000 => {
                            n += 1;
                            to = numbered(&first, n);
                        }
                        Ok(Some(_)) => break false,
                        Err(e) => {
                            errors.push(format!("{rel}: {}", e.message));
                            break false;
                        }
                    }
                };
                if !free {
                    continue;
                }
                match self.remote.rename(&Loc::new(&self.root, key), &Loc::new(&self.root, to), false).await {
                    Ok(()) => gone.push(rel.clone()),
                    Err(e) if e.kind == crate::storage::ErrKind::NotFound => gone.push(rel.clone()),
                    Err(e) => errors.push(format!("{rel}: {}", e.message)),
                }
            }
            return gone;
        }
        for chunk in items.chunks(1000) {
            if self.cancelled() {
                break;
            }
            let keys: Vec<String> = chunk.iter().map(|(_, k)| k.clone()).collect();
            match self.remote.delete(&self.root, &keys, &[], &self.cancel, &|_, _| {}).await {
                Ok(_) => gone.extend(chunk.iter().map(|(r, _)| r.clone())),
                Err(e) if e.is_cancelled() => break,
                Err(e) => errors.push(format!("{}: {}", chunk[0].0, e.message)),
            }
        }
        gone
    }

    /// Moves local files to the Trash, each only if it is still what the base says (an edit made
    /// meanwhile wins). Answers the paths that are gone.
    async fn delete_local(&self, items: Vec<(String, PathBuf)>, base: &HashMap<String, BaseEntry>, errors: &mut Vec<String>) -> Vec<String> {
        if items.is_empty() || self.cancelled() {
            return Vec::new();
        }
        let (root, trash) = (self.local_root.clone(), self.local_trash);
        let checks: Vec<(String, PathBuf, Option<BaseEntry>)> = items.into_iter().map(|(rel, p)| {
            let b = base.get(&rel).cloned();
            (rel, p, b)
        }).collect();
        let res = tokio::task::spawn_blocking(move || {
            let mut ok: Vec<(String, PathBuf)> = Vec::new();
            for (rel, p, b) in checks {
                // a folder replaced by a link since it was synced: what's behind it isn't ours
                if local::link_on_the_way(&root, &p).is_some() {
                    continue;
                }
                let same = match (std::fs::metadata(&p), b) {
                    (Ok(m), Some(b)) => b.local_matches(&local_meta(&m)),
                    (Err(_), _) => true, // already gone
                    (Ok(_), None) => false,
                };
                if same {
                    ok.push((rel, p));
                }
            }
            let paths: Vec<PathBuf> = ok.iter().map(|(_, p)| p.clone()).filter(|p| p.exists()).collect();
            let r = local::remove_local(&paths, trash);
            if r.is_ok() {
                for p in &paths {
                    if let Some(dir) = p.parent() {
                        local::prune_empty(&root, dir.to_path_buf());
                    }
                }
            }
            r.map(|_| ok.into_iter().map(|(rel, _)| rel).collect::<Vec<String>>())
        })
        .await;
        match res {
            Ok(Ok(gone)) => gone,
            Ok(Err(e)) => {
                errors.push(e);
                Vec::new()
            }
            Err(e) => {
                errors.push(e.to_string());
                Vec::new()
            }
        }
    }

    /// Remembers what the guard holds back, and says so as a problem to look at.
    fn note_held(&self, held: &Option<Held>, local: &LocalSnapshot, remote: Option<&RemoteSnapshot>, base: &HashMap<String, BaseEntry>, errors: &mut Vec<String>) -> Result<usize, String> {
        let Some(h) = held else {
            self.db.set_pending(&self.id, &[])?;
            return Ok(0);
        };
        let items: Vec<PendingDelete> = h
            .items
            .iter()
            .map(|(path, side)| {
                let size = match side {
                    Side::Local => local.files.get(path).map(|l| l.size),
                    Side::Remote => remote.and_then(|r| r.files.get(path)).map(|r| r.size),
                }
                .or_else(|| base.get(path).map(|b| b.l_size))
                .unwrap_or(0);
                PendingDelete { path: path.clone(), side: *side, size }
            })
            .collect();
        self.db.set_pending(&self.id, &items)?;
        let n = plural(items.len(), "file");
        errors.push(match h.reason {
            HoldReason::SideEmpty(Side::Local) => format!(
                "The folder on this computer is empty, so {n} on {} were kept. If you really emptied it, confirm the deletions.",
                self.there()
            ),
            HoldReason::SideEmpty(Side::Remote) => {
                format!("The folder on {} looks empty, so {n} here were kept. If that's right, confirm the deletions.", self.there())
            }
            HoldReason::TooMany => format!("{n} would be deleted at once, so Kybl is waiting for you to confirm the deletions."),
        });
        Ok(items.len())
    }

    /// Clears a used confirmation once a run got through.
    fn finish(&self, confirmed_used: bool) -> Result<(), String> {
        if !self.cancelled() {
            self.db.set_last_sync(&self.id, now_ms())?;
            if confirmed_used {
                self.db.set_confirm(&self.id, false)?;
            }
        }
        Ok(())
    }

    fn guard(&self) -> Result<Guard, String> {
        Ok(Guard { enabled: self.delete_guard, confirmed: self.db.confirmed(&self.id)? })
    }

    // ---------------------------------------------------------------- upload

    /// Backs the local folder up. `full` also lists the other side (catching files changed or
    /// removed there); `dirty` (what the watcher saw) rescans only those paths.
    pub async fn upload(&self, full: bool, dirty: Option<HashSet<PathBuf>>) -> Result<RunResult, String> {
        self.check_root()?;
        let gi = build_ignore(&self.local_root, &self.ignore);
        let mut base = self.load_base(&gi)?;
        let mut local = self.scan_local(&gi, &base, if full { None } else { dirty }).await?;
        let mut remote = if full || base.is_empty() { Some(self.scan_remote(&gi).await?) } else { None };
        let unreadable = self.exclude(&mut base, &mut local, remote.as_mut())?;
        if let Some(r) = &remote {
            // an untracked file of the same size there is adopted only on proof (its MD5)
            self.fill_md5(&mut local, r, &base).await?;
        }
        let guard = self.guard()?;
        let confirmed_used = !guard.confirmed.is_empty();
        let opts = plan::UploadPlanOpts { mirror_deletes: self.mirror_deletes, adopt_existing: true, guard };
        let p = plan::plan_upload(&local.files, &base, remote.as_ref().map(|r| &r.files), &opts);
        let now = now_ms();
        self.db.put_base_many(&self.id, &p.adopt, now)?;
        self.db.drop_base_many(&self.id, &p.forget)?;

        let empty = RemoteSnapshot::default();
        let rs = remote.as_ref().unwrap_or(&empty);
        let jobs: Vec<Job> = p
            .uploads
            .iter()
            .map(|rel| {
                let l = &local.files[rel];
                Job::Up {
                    rel: rel.clone(),
                    path: local.path(&self.local_root, rel),
                    key: self.push_key(rel, &local, rs),
                    size: l.size,
                    mtime: l.mtime,
                    file_id: l.file_id.clone(),
                    pre: Precondition::None,
                }
            })
            .collect();
        let mut errors: Vec<String> = unreadable.into_iter().collect();
        let pending = self.note_held(&p.held, &local, remote.as_ref(), &base, &mut errors)?;
        let total = (jobs.len() + p.delete_remote.len()) as u32;
        if total > 0 {
            (self.report)(Tick { total, ..Default::default() });
        }
        let mut notices = Vec::new();
        let (uploaded, _, _) = self.run_jobs(jobs, total, &mut errors, &mut notices).await;
        errors.append(&mut notices);
        let dels: Vec<(String, String)> = p.delete_remote.iter().map(|rel| (rel.clone(), self.push_key(rel, &local, rs))).collect();
        let deleted = self.delete_remote(&dels, &mut errors).await;
        self.db.drop_base_many(&self.id, &deleted)?;
        self.finish(confirmed_used)?;
        let mut parts = Vec::new();
        if uploaded > 0 {
            parts.push(format!("{uploaded} uploaded"));
        }
        if !deleted.is_empty() {
            parts.push(format!("{} deleted on {}", deleted.len(), self.there()));
        }
        parts.extend(dupes_note(local.dupes.len() + remote.as_ref().map_or(0, |r| r.dupes.len())));
        Ok(RunResult { summary: parts.join(" · "), errors, files: self.db.base_count(&self.id)?, conflicts: 0, pending })
    }

    // ---------------------------------------------------------------- download

    /// Mirrors the other side into the local folder.
    pub async fn download(&self) -> Result<RunResult, String> {
        self.check_root()?;
        let gi = build_ignore(&self.local_root, &self.ignore);
        let mut remote = self.scan_remote(&gi).await?;
        let mut base = self.load_base(&gi)?;
        let mut local = self.scan_local(&gi, &base, None).await?;
        let unreadable = self.exclude(&mut base, &mut local, Some(&mut remote))?;
        self.fill_md5(&mut local, &remote, &base).await?;
        let guard = self.guard()?;
        let confirmed_used = !guard.confirmed.is_empty();
        let p = plan::plan_download(&local.files, &base, &remote.files, &plan::DownloadPlanOpts { mirror_deletes: self.mirror_deletes, guard });
        let now = now_ms();
        self.db.put_base_many(&self.id, &p.adopt, now)?;
        self.db.drop_base_many(&self.id, &p.forget)?;

        let jobs: Vec<Job> = p
            .downloads
            .iter()
            .map(|(rel, keep_local)| Job::Down {
                rel: rel.clone(),
                key: remote.key(&self.prefix, rel),
                dest: self.pull_dest(rel, &local, &remote),
                remote: remote.files[rel].clone(),
                keep_local: *keep_local,
                // replace (or set aside) only what the plan saw: an edit made during the run
                // waits for the next one instead of being overwritten
                expect: match local.files.get(rel) {
                    Some(l) => Expect::Matches(l.size, l.mtime),
                    None => Expect::Absent,
                },
            })
            .collect();
        let mut errors: Vec<String> = unreadable.into_iter().collect();
        let pending = self.note_held(&p.held, &local, Some(&remote), &base, &mut errors)?;
        let total = (jobs.len() + p.trash_local.len()) as u32;
        if total > 0 {
            (self.report)(Tick { total, ..Default::default() });
        }
        let mut notices = Vec::new();
        let (_, downloaded, _) = self.run_jobs(jobs, total, &mut errors, &mut notices).await;
        errors.append(&mut notices);
        let trash: Vec<(String, PathBuf)> = p.trash_local.iter().map(|rel| (rel.clone(), local.path(&self.local_root, rel))).collect();
        let trashed = self.delete_local(trash, &base, &mut errors).await;
        self.db.drop_base_many(&self.id, &trashed)?;
        self.finish(confirmed_used)?;
        let mut parts = Vec::new();
        if downloaded > 0 {
            parts.push(format!("{downloaded} downloaded"));
        }
        if !trashed.is_empty() {
            parts.push(format!("{} moved to Trash", trashed.len()));
        }
        if p.conflicts() > 0 {
            parts.push(format!("{} kept as local copies", plural(p.conflicts(), "edited file")));
        }
        if p.kept_edits > 0 {
            parts.push(format!("{} not overwritten", plural(p.kept_edits, "local edit")));
        }
        parts.extend(dupes_note(local.dupes.len() + remote.dupes.len()));
        Ok(RunResult { summary: parts.join(" · "), errors, files: self.db.base_count(&self.id)?, conflicts: 0, pending })
    }

    // ---------------------------------------------------------------- two-way

    /// The remote snapshot of a two-way run: a full listing on `full` runs (and the first one),
    /// the change feed where the store has one, else the base (a quick run after a local change).
    /// The other side for a two-way run, and where its change feed goes on from: saved by the run
    /// only once it got through everything (see [`NextCursor`]).
    async fn twoway_remote(&self, gi: &ignore::gitignore::Gitignore, base: &HashMap<String, BaseEntry>, full: bool) -> Result<(RemoteSnapshot, Option<NextCursor>), String> {
        let cursor = self.db.cursor(&self.id)?;
        if !full && !base.is_empty() {
            if let Some(c) = cursor.remote_cursor.filter(|_| self.remote.caps().changes) {
                match remote::scan_changes(&*self.remote, &self.root, &self.prefix, gi, base, c, &self.cancel).await {
                    Ok((snap, next)) => return Ok((snap, Some(NextCursor::Changes(next)))),
                    Err(e) if e.is_cancelled() => return Err(e.into()),
                    Err(_) => {} // an expired cursor: list in full
                }
            } else {
                return Ok((RemoteSnapshot { files: plan::remote_from_base(base), ..Default::default() }, None));
            }
        }
        // taken before listing: a change made while the listing runs is in the feed after it
        let next = remote::fresh_cursor(&*self.remote, &self.root).await;
        let snap = self.scan_remote(gi).await?;
        Ok((snap, Some(NextCursor::Full { at: now_ms(), cursor: next })))
    }

    /// Keeps both sides the same: changes on either side are copied to the other.
    pub async fn twoway(&self, full: bool, dirty: Option<HashSet<PathBuf>>) -> Result<RunResult, String> {
        self.check_root()?;
        let gi = build_ignore(&self.local_root, &self.ignore);
        let mut base = self.load_base(&gi)?;
        let mut local = self.scan_local(&gi, &base, if full { None } else { dirty }).await?;
        let (mut remote, next_cursor) = self.twoway_remote(&gi, &base, full).await?;
        // a path this computer can't read is left alone; the other side's changes under it are
        // then not handled, and the feed has to be read from here again next time
        let skipped_changes = {
            let mut ex = plan::Excluded::default();
            local.unreadable.iter().for_each(|p| ex.add(p));
            ex.other_side_changed(&base, &remote.files)
        };
        let unreadable = self.exclude(&mut base, &mut local, Some(&mut remote))?;
        let now = now_ms();
        self.db.purge_tombstones(now)?;
        let tombstones = self.db.tombstones(&self.id)?;
        let root = self.local_root.clone();
        let case_insensitive = tokio::task::spawn_blocking(move || local::case_insensitive(&root)).await.map_err(|e| e.to_string())?;

        self.fill_md5(&mut local, &remote, &base).await?;

        let guard = self.guard()?;
        let confirmed_used = !guard.confirmed.is_empty();
        let opts = TwoWayOpts { guard, case_insensitive, device: local::device_name(), date: local::ymd(now), now };
        let plan = plan::plan_twoway(&local.files, &remote.files, &base, &tombstones, &opts);
        let mut errors: Vec<String> = unreadable.into_iter().collect();
        let pending = self.note_held(&plan.held, &local, Some(&remote), &base, &mut errors)?;
        // the notices so far stand until the user acts (an unreadable folder, deletions waiting
        // for a confirmation); only what comes after them is a failure of this run
        let mut standing = errors.len();
        // a deletion here that waits for a confirmation came from the other side's changes:
        // they are read again until it is confirmed
        let held_from_feed = plan.held.as_ref().is_some_and(|h| h.items.iter().any(|(_, side)| *side == Side::Local));

        // ---- quick steps first: records, renames, setting conflicts aside
        let (mut renamed, mut conflicts) = (0usize, 0usize);
        // something the plan wanted done was left for the next run (its file changed again
        // meanwhile): the feed that reported it has to be read again (B4-3)
        let mut left_alone = false;
        let mut jobs: Vec<Job> = Vec::new();
        let mut del_local: Vec<(String, PathBuf)> = Vec::new();
        let mut del_remote: Vec<(String, String)> = Vec::new();
        for op in &plan.ops {
            if self.cancelled() {
                break;
            }
            match op {
                Op::ClearTombstone(p, side) => self.db.clear_tombstones(&self.id, &[(p.clone(), *side)])?,
                Op::Adopt(p, b) => self.db.put_base(&self.id, p, b, now)?,
                Op::DropBase(p) => self.db.drop_base_many(&self.id, std::slice::from_ref(p))?,
                Op::RenameRemote { from, to } => {
                    let (Some(b), Some(_)) = (base.get(from), local.files.get(to)) else { continue };
                    let src = remote.key(&self.prefix, from);
                    let dst = format!("{}{}", self.prefix, local.raw.get(to).map(String::as_str).unwrap_or(to));
                    match self.remote.rename(&Loc::new(&self.root, &src), &Loc::new(&self.root, &dst), false).await {
                        Ok(()) => {
                            // the remote file at the new name is the synced content: record it
                            // with its new ETag (a copy can change it); a local edit still goes up
                            let r = match self.remote.stat(&self.root, &dst).await {
                                Ok(Some(e)) => remote::remote_meta(&e, self.md5()),
                                _ => remote.files.get(from).cloned().unwrap_or_default(),
                            };
                            let moved = BaseEntry { r_etag: r.etag.clone(), r_size: r.size, r_mtime: r.modified, r_id: r.id.clone(), ..b.clone() };
                            self.db.move_base(&self.id, from, to, &moved, now)?;
                            // a push of an edit made along with the rename replaces this file
                            remote.files.remove(from);
                            remote.files.insert(to.clone(), r);
                            if let Some(raw) = dst.strip_prefix(&self.prefix).filter(|raw| raw != to) {
                                remote.raw.insert(to.clone(), raw.to_string());
                            }
                            renamed += 1;
                        }
                        Err(e) => errors.push(format!("{from}: {}", e.message)),
                    }
                }
                Op::RenameLocal { from, to } => {
                    let Some(b) = base.get(from) else { continue };
                    let src = local.path(&self.local_root, from);
                    let dst = self.pull_dest(to, &local, &remote);
                    let root = &self.local_root;
                    let res = (|| -> std::io::Result<std::fs::Metadata> {
                        if let Err(e) = local::no_link_on_the_way(root, &dst).and_then(|_| local::no_link_on_the_way(root, &src)) {
                            return Err(std::io::Error::other(e));
                        }
                        if let Some(parent) = dst.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        // a change of capitals on a disk that ignores case finds the file itself (a plain
                        // rename then); anything else never replaces what is at the new name
                        if dst.exists() && local::same_entry(&src, &dst) {
                            std::fs::rename(&src, &dst)?;
                        } else {
                            crate::storage::local::fsops::rename_noreplace(&src, &dst).map_err(|e| match e.kind() {
                                std::io::ErrorKind::AlreadyExists => std::io::Error::new(std::io::ErrorKind::AlreadyExists, "something with the new name is already here"),
                                _ => e,
                            })?;
                        }
                        std::fs::metadata(&dst)
                    })();
                    match res {
                        Ok(meta) => {
                            if let Some(dir) = src.parent() {
                                local::prune_empty(&self.local_root, dir.to_path_buf());
                            }
                            // the local file at the new name is the synced content; new remote
                            // content still comes down
                            let l = local_meta(&meta);
                            let moved = BaseEntry { l_size: l.size, l_mtime: l.mtime, l_fileid: l.file_id.clone(), ..b.clone() };
                            self.db.move_base(&self.id, from, to, &moved, now)?;
                            local.files.remove(from);
                            local.files.insert(to.clone(), l);
                            renamed += 1;
                        }
                        Err(e) => errors.push(format!("{from}: {e}")),
                    }
                }
                Op::Conflict { path, copy } => {
                    let Some(l) = local.files.get(path) else { continue };
                    let src = local.path(&self.local_root, path);
                    let dst = local_path_of(&self.local_root, copy);
                    // only set aside what the plan saw: a newer edit is looked at next run
                    let same = std::fs::metadata(&src).is_ok_and(|m| m.len() == l.size && local::mtime_ms(&m) == l.mtime);
                    if !same || dst.exists() {
                        left_alone = true;
                        continue;
                    }
                    if let Err(e) = local::no_link_on_the_way(&self.local_root, &dst) {
                        errors.push(format!("{path}: {e}"));
                        continue;
                    }
                    if let Err(e) = std::fs::rename(&src, &dst) {
                        errors.push(format!("{path}: couldn't keep this computer's version: {e}"));
                        continue;
                    }
                    self.db.add_conflict(&self.id, path, copy, now)?;
                    conflicts += 1;
                    if let Some(r) = remote.files.get(path) {
                        jobs.push(Job::Down { rel: path.clone(), key: remote.key(&self.prefix, path), dest: src, remote: r.clone(), keep_local: false, expect: Expect::Absent });
                    }
                    jobs.push(Job::Up {
                        rel: copy.clone(),
                        path: dst,
                        key: format!("{}{copy}", self.prefix),
                        size: l.size,
                        mtime: l.mtime,
                        file_id: l.file_id.clone(),
                        pre: Precondition::IfNoneMatch,
                    });
                }
                Op::Push(p) => {
                    let Some(l) = local.files.get(p) else { continue };
                    // replace only what the plan saw there (or nothing): an edit made there
                    // meanwhile becomes a conflict next run instead of being overwritten
                    let pre = push_precondition(remote.files.get(p));
                    jobs.push(Job::Up {
                        rel: p.clone(),
                        path: local.path(&self.local_root, p),
                        key: self.push_key(p, &local, &remote),
                        size: l.size,
                        mtime: l.mtime,
                        file_id: l.file_id.clone(),
                        pre,
                    });
                }
                Op::Pull(p) => {
                    let Some(r) = remote.files.get(p) else { continue };
                    let expect = match local.files.get(p) {
                        Some(l) => Expect::Matches(l.size, l.mtime),
                        None => Expect::Absent,
                    };
                    jobs.push(Job::Down { rel: p.clone(), key: remote.key(&self.prefix, p), dest: self.pull_dest(p, &local, &remote), remote: r.clone(), keep_local: false, expect });
                }
                Op::DeleteLocal(p) => del_local.push((p.clone(), local.path(&self.local_root, p))),
                Op::DeleteRemote(p) => del_remote.push((p.clone(), remote.key(&self.prefix, p))),
            }
        }

        // ---- transfers
        let total = (jobs.len() + del_local.len() + del_remote.len()) as u32;
        if total > 0 {
            (self.report)(Tick { total, ..Default::default() });
        }
        let mut notices = Vec::new();
        let (ups, downs, skipped_jobs) = self.run_jobs(jobs, total, &mut errors, &mut notices).await;
        left_alone |= skipped_jobs;
        // they stand with the notices before them: shown each run until the user acts, without
        // holding the change feed back
        for n in notices {
            errors.insert(standing, n);
            standing += 1;
        }

        // ---- deletions last, each remembered first so a lagging listing can't undo it
        let mut deleted = 0usize;
        if !self.cancelled() {
            for (p, _) in &del_remote {
                if let Some(b) = base.get(p) {
                    self.db.put_tombstone(&self.id, p, Side::Remote, b, now)?;
                }
            }
            let gone = self.delete_remote(&del_remote, &mut errors).await;
            let failed: Vec<(String, Side)> = del_remote.iter().filter(|(p, _)| !gone.contains(p)).map(|(p, _)| (p.clone(), Side::Remote)).collect();
            self.db.clear_tombstones(&self.id, &failed)?;
            self.db.drop_base_many(&self.id, &gone)?;
            deleted += gone.len();

            for (p, _) in &del_local {
                if let Some(b) = base.get(p) {
                    self.db.put_tombstone(&self.id, p, Side::Local, b, now)?;
                }
            }
            let gone = self.delete_local(del_local.clone(), &base, &mut errors).await;
            let failed: Vec<(String, Side)> = del_local.iter().filter(|(p, _)| !gone.contains(p)).map(|(p, _)| (p.clone(), Side::Local)).collect();
            // a file edited here since the scan is kept, without an error
            left_alone |= !failed.is_empty();
            self.db.clear_tombstones(&self.id, &failed)?;
            self.db.drop_base_many(&self.id, &gone)?;
            deleted += gone.len();
        }
        self.finish(confirmed_used)?;
        // the feed is only "handled up to here" once everything in it was: after a failed
        // transfer or delete, a stop, or a change this run had to leave alone, the next quick run
        // reads the same changes again. A standing notice alone doesn't hold it back, or every
        // run would re-read (or, with an expired cursor, re-list) the other side until it's gone.
        if errors.len() == standing && !skipped_changes && !left_alone && !held_from_feed && !self.cancelled() {
            match next_cursor {
                Some(NextCursor::Changes(c)) => self.db.set_remote_cursor(&self.id, Some(&c))?,
                Some(NextCursor::Full { at, cursor }) => self.db.set_full_scan(&self.id, at, cursor.as_deref())?,
                None => {}
            }
        }

        let mut parts = Vec::new();
        let ups = ups - conflicts.min(ups);
        if ups > 0 {
            parts.push(format!("{ups} uploaded"));
        }
        let downs = downs - conflicts.min(downs);
        if downs > 0 {
            parts.push(format!("{downs} downloaded"));
        }
        if renamed > 0 {
            parts.push(format!("{renamed} renamed"));
        }
        if deleted > 0 {
            parts.push(format!("{deleted} deleted"));
        }
        if conflicts > 0 {
            parts.push(format!("{} kept as copies", plural(conflicts, "conflict")));
        }
        let clashes = plan.skipped.iter().filter(|s| matches!(s.reason, SkipReason::CaseClash { .. })).count() + remote.dupes.len() + local.dupes.len();
        if clashes > 0 {
            parts.push(format!("{} skipped: the same name differs only in capitals or accents", plural(clashes, "file")));
        }
        Ok(RunResult {
            summary: parts.join(" · "),
            errors,
            files: self.db.base_count(&self.id)?,
            conflicts: self.db.conflicts(&self.id)?.len(),
            pending,
        })
    }
}

/// Settles a conflict copy: keep both (just forget the conflict), keep the other side's version
/// (the copy goes to the Trash; the next run deletes it remotely), or keep this computer's
/// version (it replaces the original, which the next run sends over).
pub fn resolve_conflict(db: &SyncDb, id: &str, root: &Path, copy: &str, keep: &str, trash: bool) -> Result<(), String> {
    let row = db.conflicts(id)?.into_iter().find(|c| c.copy == copy).ok_or("This conflict was already settled.")?;
    let copy_path = local_path_of(root, &row.copy);
    let orig_path = local_path_of(root, &row.path);
    match keep {
        "both" => {}
        "original" => {
            if copy_path.exists() {
                local::remove_local(std::slice::from_ref(&copy_path), trash)?;
            }
        }
        "copy" => {
            if !copy_path.exists() {
                return Err("This computer's version isn't there any more.".into());
            }
            if orig_path.exists() {
                local::remove_local(std::slice::from_ref(&orig_path), trash)?;
            }
            std::fs::rename(&copy_path, &orig_path).map_err(|e| format!("Couldn't put this computer's version back: {e}"))?;
            // a fresh time, so the next run sees an edit to send over
            let _ = filetime::set_file_mtime(&orig_path, filetime::FileTime::now());
        }
        _ => return Err("Unknown choice".into()),
    }
    db.remove_conflict(id, copy)
}

/// Where the other side's change feed goes on from after a two-way run.
enum NextCursor {
    /// a quick run read the feed up to here
    Changes(String),
    /// a full run listed everything; the feed's position from just before the listing
    Full { at: i64, cursor: Option<String> },
}

/// What a push may replace: only the remote file the plan saw there (or nothing), so an edit
/// made there meanwhile becomes a conflict next run instead of being overwritten. Stores without
/// ETags compare its size and time as listed.
fn push_precondition(seen: Option<&RemoteMeta>) -> Precondition {
    match seen {
        None => Precondition::IfNoneMatch,
        Some(r) if !r.etag.is_empty() => Precondition::IfMatch(r.etag.clone()),
        Some(r) => Precondition::IfUnchanged { etag: None, size: r.size as i64, modified: (r.modified != 0).then_some(r.modified) },
    }
}

#[cfg(test)]
mod tests;
