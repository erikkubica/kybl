//! What a sync run should do, decided without touching a disk or a server.
//!
//! Three snapshots go in: the local folder as it is now, the other side as it is now, and the
//! *base*: both sides as they were when each path was last in sync. Comparing each side with the
//! base is what tells "changed here" from "changed there" from "deleted"; comparing the two sides
//! with each other never can. Out come the steps. The runner carries them out and records the new
//! base after each one, so an interrupted run simply plans what is left next time.
//!
//! Paths are relative to the synced folder, `/`-separated and NFC-normalised ([`nfc`]): macOS
//! hands out decomposed names, servers keep whatever they were sent, and "é" must be one file.
//!
//! Phone backup reuses [`plan_upload`] with `mirror_deletes = false, adopt_existing = true`.

// shared with phone backup, which uses parts desktop sync doesn't (and none of it on phones yet)
#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

/// The deletions a run may make before it stops to ask: more than this many, and more than a
/// fifth of the tracked files.
pub const GUARD_MIN: usize = 50;
/// How long after Kybl deleted a file a listing that still shows it is taken as lagging behind
/// (and the file as still deleted) rather than as the file being put back.
pub const ZOMBIE_WINDOW_MS: i64 = 15 * 60 * 1000;
/// Tombstones are kept this long (what was deleted where), then forgotten.
pub const TOMBSTONE_KEEP_MS: i64 = 30 * 24 * 3600 * 1000;

/// `s` in Unicode normalisation form C (composed), the form paths are compared in.
pub fn nfc(s: &str) -> String {
    if s.is_ascii() { s.to_string() } else { s.nfc().collect() }
}

// ---------------------------------------------------------------- snapshots

/// A file in the local folder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocalMeta {
    pub size: u64,
    /// modification time, ms since the epoch
    pub mtime: i64,
    /// the file's identity on its disk (device and inode), which survives a rename
    pub file_id: Option<String>,
    /// the content's MD5 (hex), only worked out where it settles a comparison
    pub md5: Option<String>,
}

impl LocalMeta {
    pub fn new(size: u64, mtime: i64) -> Self {
        Self { size, mtime, ..Default::default() }
    }
}

/// A file on the other side.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteMeta {
    pub size: u64,
    /// "" when the store has none
    pub etag: String,
    /// ms since the epoch; 0 when unknown
    pub modified: i64,
    /// stable id on stores that have them (Drive, OneDrive, Dropbox), which survives a rename
    pub id: Option<String>,
    /// the content's MD5 (hex) when the store tells it
    pub md5: Option<String>,
}

impl RemoteMeta {
    pub fn new(size: u64, etag: &str, modified: i64) -> Self {
        Self { size, etag: etag.to_string(), modified, ..Default::default() }
    }
}

/// Both sides of a path as they were when it was last in sync.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseEntry {
    pub l_size: u64,
    pub l_mtime: i64,
    pub l_fileid: Option<String>,
    pub r_etag: String,
    pub r_size: u64,
    /// 0 when unknown (rows from before sync.db only knew the ETag)
    pub r_mtime: i64,
    pub r_id: Option<String>,
}

impl BaseEntry {
    pub fn of(l: &LocalMeta, r: &RemoteMeta) -> Self {
        Self {
            l_size: l.size,
            l_mtime: l.mtime,
            l_fileid: l.file_id.clone(),
            r_etag: r.etag.clone(),
            r_size: r.size,
            r_mtime: r.modified,
            r_id: r.id.clone(),
        }
    }

    /// The local file is still what was synced.
    pub fn local_matches(&self, l: &LocalMeta) -> bool {
        self.l_size == l.size && self.l_mtime == l.mtime
    }

    /// The remote file is still what was synced: same ETag where both are known, else the same
    /// size (and time, when that was recorded).
    pub fn remote_matches(&self, r: &RemoteMeta) -> bool {
        if !self.r_etag.is_empty() && !r.etag.is_empty() {
            return self.r_etag == r.etag;
        }
        self.r_size == r.size && (self.r_mtime == 0 || r.modified == 0 || self.r_mtime == r.modified)
    }

    fn remote_view(&self) -> RemoteMeta {
        RemoteMeta { size: self.r_size, etag: self.r_etag.clone(), modified: self.r_mtime, id: self.r_id.clone(), md5: None }
    }
}

/// The base of one mapping: a map from path to [`BaseEntry`] (the runner loads it from sync.db,
/// phone backup from its own index).
pub trait BaseState {
    fn entry(&self, path: &str) -> Option<&BaseEntry>;
    /// every tracked path, in no particular order
    fn paths(&self) -> Vec<&str>;
    fn count(&self) -> usize;
}

impl BaseState for HashMap<String, BaseEntry> {
    fn entry(&self, path: &str) -> Option<&BaseEntry> {
        self.get(path)
    }
    fn paths(&self) -> Vec<&str> {
        self.keys().map(String::as_str).collect()
    }
    fn count(&self) -> usize {
        self.len()
    }
}

/// The remote view of a base: what the other side looks like if nothing changed there (a quick
/// run that only looks at the local folder, or a change feed applied on top).
pub fn remote_from_base(base: &dyn BaseState) -> HashMap<String, RemoteMeta> {
    base.paths().into_iter().filter_map(|p| Some((p.to_string(), base.entry(p)?.remote_view()))).collect()
}

/// Paths a run leaves alone entirely: folders or files that couldn't be read, and names that
/// collide once normalised. Missing from a snapshot for those reasons is not "deleted", so they
/// (and their base rows) are kept out of planning: nothing is sent, fetched or deleted for them
/// on either side, and their base stays for the next run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Excluded {
    /// each path covers itself and everything below it
    paths: BTreeSet<String>,
}

impl Excluded {
    pub fn add(&mut self, path: &str) {
        self.paths.insert(nfc(path.trim_end_matches('/')));
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    /// True for an excluded path, or one inside an excluded folder ("" covers everything).
    pub fn covers(&self, path: &str) -> bool {
        if self.paths.contains("") {
            return true;
        }
        let mut p = path;
        loop {
            if self.paths.contains(p) {
                return true;
            }
            match p.rfind('/') {
                Some(i) => p = &p[..i],
                None => return false,
            }
        }
    }

    /// Takes the excluded paths out of a snapshot or a base.
    pub fn strip<V>(&self, m: &mut HashMap<String, V>) {
        if !self.is_empty() {
            m.retain(|k, _| !self.covers(k));
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &String> {
        self.paths.iter()
    }
}

fn sorted<V>(m: &HashMap<String, V>) -> Vec<(&String, &V)> {
    let mut v: Vec<_> = m.iter().collect();
    v.sort_by(|a, b| a.0.cmp(b.0));
    v
}

// ---------------------------------------------------------------- deletions and the guard

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Local,
    Remote,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Local => "local",
            Side::Remote => "remote",
        }
    }
    pub fn parse(s: &str) -> Option<Side> {
        match s {
            "local" => Some(Side::Local),
            "remote" => Some(Side::Remote),
            _ => None,
        }
    }
}

/// The mass-delete guard of a run.
#[derive(Clone, Debug, Default)]
pub struct Guard {
    /// stop at more than max(50, 20%) deletions (an empty side always stops)
    pub enabled: bool,
    /// deletions the user confirmed: they go ahead whatever the counts
    pub confirmed: HashSet<(String, Side)>,
}

impl Guard {
    pub fn on() -> Self {
        Self { enabled: true, confirmed: HashSet::new() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldReason {
    /// this side looks empty (an unmounted disk, a wrong folder) while files were tracked
    SideEmpty(Side),
    /// more deletions than the guard allows in one go
    TooMany,
}

/// Deletions held back until the user confirms them. Their base rows stay, so the next run holds
/// them again; "Keep the files" forgets the rows instead, which brings the files back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub reason: HoldReason,
    /// (path, side to delete on)
    pub items: Vec<(String, Side)>,
}

/// True when deleting `deletes` of `tracked` files at once needs a confirmation.
pub fn too_many_deletes(deletes: usize, tracked: usize) -> bool {
    deletes > GUARD_MIN.max(tracked / 5)
}

/// Splits deletions into those that go ahead and those the guard holds.
fn hold(deletes: Vec<(String, Side)>, tracked: usize, empty: Option<Side>, g: &Guard) -> (Vec<(String, Side)>, Option<Held>) {
    let (ok, rest): (Vec<_>, Vec<_>) = deletes.into_iter().partition(|d| g.confirmed.contains(d));
    if rest.is_empty() {
        return (ok, None);
    }
    let reason = match empty {
        Some(side) => Some(HoldReason::SideEmpty(side)),
        None if g.enabled && too_many_deletes(rest.len(), tracked) => Some(HoldReason::TooMany),
        None => None,
    };
    match reason {
        Some(reason) => (ok, Some(Held { reason, items: rest })),
        None => (ok.into_iter().chain(rest).collect(), None),
    }
}

/// The side that looks empty while files are tracked, if one does.
fn empty_side(tracked: usize, local_empty: bool, remote_empty: bool) -> Option<Side> {
    if tracked == 0 {
        None
    } else if local_empty {
        Some(Side::Local)
    } else if remote_empty {
        Some(Side::Remote)
    } else {
        None
    }
}

// ---------------------------------------------------------------- one-way: upload

#[derive(Clone, Debug)]
pub struct UploadPlanOpts {
    /// a file deleted here is deleted on the other side too
    pub mirror_deletes: bool,
    /// an untracked file already there with the same size (and not older) is recorded as synced
    /// instead of being sent again
    pub adopt_existing: bool,
    pub guard: Guard,
}

impl Default for UploadPlanOpts {
    fn default() -> Self {
        Self { mirror_deletes: false, adopt_existing: true, guard: Guard::default() }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UploadPlan {
    /// paths to send
    pub uploads: Vec<String>,
    /// already there: record as synced
    pub adopt: Vec<(String, BaseEntry)>,
    /// tracked paths gone here that stay on the other side: just forget them
    pub forget: Vec<String>,
    pub delete_remote: Vec<String>,
    pub held: Option<Held>,
}

/// Backing up the local folder. `remote` is None on a quick run, which trusts the base for the
/// other side and only looks for local changes; with a listing, files missing or replaced there
/// are sent again.
pub fn plan_upload(local: &HashMap<String, LocalMeta>, base: &dyn BaseState, remote: Option<&HashMap<String, RemoteMeta>>, opts: &UploadPlanOpts) -> UploadPlan {
    let mut p = UploadPlan::default();
    for (rel, lf) in sorted(local) {
        let tracked = base.entry(rel);
        let unchanged = tracked.is_some_and(|t| t.local_matches(lf));
        let need = match remote {
            Some(r) => {
                let rf = r.get(rel);
                if unchanged {
                    // gone from the other side or replaced there: local is the source of truth
                    rf.is_none_or(|rf| rf.size != lf.size)
                } else if let Some(rf) = rf.filter(|rf| opts.adopt_existing && tracked.is_none() && same_content(lf, rf)) {
                    // first run over an existing copy: adopt it instead of uploading again. A
                    // size match alone is never enough (a remote time is often just the upload's)
                    p.adopt.push((rel.clone(), BaseEntry::of(lf, rf)));
                    false
                } else {
                    true
                }
            }
            None => !unchanged,
        };
        if need {
            p.uploads.push(rel.clone());
        }
    }
    let mut gone: Vec<&str> = base.paths().into_iter().filter(|k| !local.contains_key(*k)).collect();
    gone.sort_unstable();
    let mut deletes = Vec::new();
    for rel in gone {
        if opts.mirror_deletes {
            deletes.push((rel.to_string(), Side::Remote));
        } else {
            p.forget.push(rel.to_string());
        }
    }
    let empty = empty_side(base.count(), local.is_empty(), false);
    let (go, held) = hold(deletes, base.count(), empty, &opts.guard);
    p.delete_remote = go.into_iter().map(|(p, _)| p).collect();
    p.held = held;
    p
}

// ---------------------------------------------------------------- one-way: download

#[derive(Clone, Debug, Default)]
pub struct DownloadPlanOpts {
    /// files removed on the other side go to the Trash here (only ones not edited here)
    pub mirror_deletes: bool,
    pub guard: Guard,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DownloadPlan {
    /// (path, keep the local file aside first because it was edited here too)
    pub downloads: Vec<(String, bool)>,
    pub adopt: Vec<(String, BaseEntry)>,
    pub forget: Vec<String>,
    pub trash_local: Vec<String>,
    pub held: Option<Held>,
    /// local edits left alone (the remote file didn't change)
    pub kept_edits: usize,
}

impl DownloadPlan {
    pub fn conflicts(&self) -> usize {
        self.downloads.iter().filter(|(_, keep)| *keep).count()
    }
}

/// Mirroring the other side into the local folder.
pub fn plan_download(local: &HashMap<String, LocalMeta>, base: &dyn BaseState, remote: &HashMap<String, RemoteMeta>, opts: &DownloadPlanOpts) -> DownloadPlan {
    let mut p = DownloadPlan::default();
    for (rel, rf) in sorted(remote) {
        let tracked = base.entry(rel);
        let lf = local.get(rel);
        let local_matches = |t: &BaseEntry| lf.is_some_and(|l| t.local_matches(l));
        // None = nothing to do, Some(keep_local) = download, keeping the local file aside if true
        let action = match tracked {
            Some(t) if t.remote_matches(rf) => match lf {
                None => Some(false), // deleted locally: the mirror puts it back
                Some(_) => {
                    if !local_matches(t) {
                        p.kept_edits += 1;
                    }
                    None
                }
            },
            Some(t) => match lf {
                None => Some(false),
                Some(_) if local_matches(t) => Some(false),
                Some(_) => Some(true), // changed on both sides
            },
            None => match lf {
                None => Some(false),
                // already here (a first run over an existing copy): only when it is surely
                // the same file; otherwise the local one is kept aside as a copy
                Some(l) if same_content(l, rf) => {
                    p.adopt.push((rel.clone(), BaseEntry::of(l, rf)));
                    None
                }
                Some(_) => Some(true),
            },
        };
        if let Some(keep_local) = action {
            p.downloads.push((rel.clone(), keep_local));
        }
    }
    let mut gone: Vec<&str> = base.paths().into_iter().filter(|k| !remote.contains_key(*k)).collect();
    gone.sort_unstable();
    let mut trash = Vec::new();
    for rel in gone {
        let t = base.entry(rel).cloned().unwrap_or_default();
        // only remove a file the user hasn't touched since it was downloaded
        if opts.mirror_deletes && local.get(rel).is_some_and(|l| t.local_matches(l)) {
            trash.push((rel.to_string(), Side::Local));
        } else {
            p.forget.push(rel.to_string());
        }
    }
    let empty = empty_side(base.count(), false, remote.is_empty());
    let (go, held) = hold(trash, base.count(), empty, &opts.guard);
    p.trash_local = go.into_iter().map(|(p, _)| p).collect();
    p.held = held;
    p
}

// ---------------------------------------------------------------- two-way

/// A deletion Kybl made, remembered so a listing that lags behind doesn't bring the file back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tombstone {
    pub path: String,
    /// where Kybl deleted it
    pub side: Side,
    /// the path's base when it was deleted
    pub base: BaseEntry,
    pub deleted_at: i64,
}

#[derive(Clone, Debug, Default)]
pub struct TwoWayOpts {
    pub guard: Guard,
    /// the local disk treats "a.txt" and "A.txt" as one name (macOS and Windows by default)
    pub case_insensitive: bool,
    /// this computer's name, for conflict copies
    pub device: String,
    /// today as YYYY-MM-DD, for conflict copies
    pub date: String,
    /// now, ms since the epoch (tombstones)
    pub now: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    /// send the local file over (new, or replacing the remote one)
    Push(String),
    /// bring the remote file here
    Pull(String),
    /// to the Trash
    DeleteLocal(String),
    DeleteRemote(String),
    /// renamed on the other side: rename the local file to match
    RenameLocal { from: String, to: String },
    /// renamed here: rename the remote file to match
    RenameRemote { from: String, to: String },
    /// changed on both sides: the remote version keeps the name, the local one is renamed to
    /// `copy` and sent over too
    Conflict { path: String, copy: String },
    /// the same content on both sides already: record it as synced
    Adopt(String, BaseEntry),
    /// gone from both sides: forget it
    DropBase(String),
    /// a tombstone that no longer applies (the file is back for real)
    ClearTombstone(String, Side),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// another remote file has the same name in different capitals, and this disk can't hold both
    CaseClash { with: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skip {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TwoWayPlan {
    pub ops: Vec<Op>,
    pub held: Option<Held>,
    pub skipped: Vec<Skip>,
}

impl TwoWayPlan {
    pub fn count(&self, f: impl Fn(&Op) -> bool) -> usize {
        self.ops.iter().filter(|o| f(o)).count()
    }
}

/// How one side changed since the base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delta {
    /// unchanged, or absent on both the side and the base
    None,
    Created,
    Modified,
    Deleted,
}

pub fn delta_local(b: Option<&BaseEntry>, l: Option<&LocalMeta>) -> Delta {
    match (b, l) {
        (None, None) => Delta::None,
        (None, Some(_)) => Delta::Created,
        (Some(_), None) => Delta::Deleted,
        (Some(b), Some(l)) => if b.local_matches(l) { Delta::None } else { Delta::Modified },
    }
}

pub fn delta_remote(b: Option<&BaseEntry>, r: Option<&RemoteMeta>) -> Delta {
    match (b, r) {
        (None, None) => Delta::None,
        (None, Some(_)) => Delta::Created,
        (Some(_), None) => Delta::Deleted,
        (Some(b), Some(r)) => if b.remote_matches(r) { Delta::None } else { Delta::Modified },
    }
}

/// Untracked or changed on both sides: is it the same content anyway? By MD5 where both are
/// known (the runner hashes the local file when the other side has one); without hashes only
/// when the sizes match and the times are within 2 s. A size match alone is never enough: two
/// different files of the same size would be recorded as in sync and one of them lost, so
/// anything unsure is kept both ways as a conflict instead.
fn same_content(l: &LocalMeta, r: &RemoteMeta) -> bool {
    if l.size != r.size {
        return false;
    }
    match (&l.md5, &r.md5) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => r.modified != 0 && (l.mtime - r.modified).abs() <= 2000,
    }
}

/// Paths whose MD5 the runner should work out before planning: on both sides with the same size,
/// changed since the base, where the other side knows its MD5.
pub fn hash_candidates(local: &HashMap<String, LocalMeta>, remote: &HashMap<String, RemoteMeta>, base: &dyn BaseState) -> Vec<String> {
    let mut out: Vec<String> = local
        .iter()
        .filter(|(p, l)| {
            let Some(r) = remote.get(*p) else { return false };
            if r.md5.is_none() || l.md5.is_some() || r.size != l.size {
                return false;
            }
            base.entry(p).is_none_or(|b| !b.local_matches(l) && !b.remote_matches(r))
        })
        .map(|(p, _)| p.clone())
        .collect();
    out.sort();
    out
}

/// "dir/report.docx" -> "dir/report (conflict MacBook 2026-11-22).docx", numbered when taken.
pub fn conflict_name(path: &str, device: &str, date: &str, taken: impl Fn(&str) -> bool) -> String {
    let (dir, name) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let label = if device.is_empty() { format!("conflict {date}") } else { format!("conflict {device} {date}") };
    (1..)
        .map(|n| {
            let num = if n == 1 { String::new() } else { format!(" {n}") };
            format!("{dir}{stem} ({label}{num}){ext}")
        })
        .find(|c| !taken(c))
        .expect("some number is free")
}

/// The two-way plan: renames first, then each path by how it changed on each side.
///
/// | local \ remote | none | created/modified | deleted |
/// |---|---|---|---|
/// | none | – | pull | delete local (Trash) |
/// | created/modified | push | same content: record; else conflict copy | push (the edit wins) |
/// | deleted | delete remote | pull (the edit wins) | forget |
pub fn plan_twoway(
    local: &HashMap<String, LocalMeta>,
    remote: &HashMap<String, RemoteMeta>,
    base: &dyn BaseState,
    tombstones: &[Tombstone],
    opts: &TwoWayOpts,
) -> TwoWayPlan {
    let mut plan = TwoWayPlan::default();
    let mut local = local.clone();
    let mut remote = remote.clone();

    // ---- names that differ only in capitals
    if opts.case_insensitive {
        // On this disk "photos/a.jpg" *is* "Photos/a.jpg": a local name that matches a tracked or
        // remote one but for capitals is that file, under the name the other side knows.
        let mut known: HashMap<String, String> = HashMap::new();
        for k in base.paths().into_iter().chain(remote.keys().map(String::as_str)) {
            known.entry(k.to_lowercase()).or_insert_with(|| k.to_string());
        }
        let renames: Vec<(String, String)> = local
            .keys()
            .filter(|k| base.entry(k).is_none() && !remote.contains_key(*k))
            .filter_map(|k| known.get(&k.to_lowercase()).filter(|o| *o != k).map(|o| (k.clone(), o.clone())))
            .collect();
        for (from, to) in renames {
            if !local.contains_key(&to) && let Some(m) = local.remove(&from) {
                local.insert(to, m);
            }
        }
        // two remote files that differ only in capitals can't both live here: keep the tracked
        // one (or the one already here, or the first), skip and report the others
        let mut groups: HashMap<String, Vec<String>> = HashMap::new();
        for k in remote.keys() {
            groups.entry(k.to_lowercase()).or_default().push(k.clone());
        }
        let mut clashes: Vec<Vec<String>> = groups.into_values().filter(|g| g.len() > 1).collect();
        clashes.sort();
        for mut g in clashes {
            g.sort();
            let keep = g
                .iter()
                .find(|k| base.entry(k).is_some())
                .or_else(|| g.iter().find(|k| local.contains_key(*k)))
                .unwrap_or(&g[0])
                .clone();
            for k in g.into_iter().filter(|k| *k != keep) {
                remote.remove(&k);
                plan.skipped.push(Skip { path: k, reason: SkipReason::CaseClash { with: keep.clone() } });
            }
        }
    }

    // ---- tombstones: a listing that still shows what Kybl just deleted
    let mut ts: Vec<&Tombstone> = tombstones.iter().collect();
    ts.sort_by(|a, b| (&a.path, a.side).cmp(&(&b.path, b.side)));
    for t in ts {
        if base.entry(&t.path).is_some() {
            continue;
        }
        let fresh = opts.now - t.deleted_at <= ZOMBIE_WINDOW_MS;
        let lingers_remote = remote.get(&t.path).is_some_and(|r| t.base.remote_matches(r));
        let lingers_local = local.get(&t.path).is_some_and(|l| t.base.local_matches(l));
        let back = remote.contains_key(&t.path) || local.contains_key(&t.path);
        if fresh && (lingers_remote || lingers_local) {
            if lingers_remote {
                remote.remove(&t.path);
            }
            if lingers_local {
                local.remove(&t.path);
            }
            // the delete didn't stick where Kybl made it: make it again (deleting is idempotent)
            let again = match t.side {
                Side::Remote if lingers_remote && !local.contains_key(&t.path) => Some(Op::DeleteRemote(t.path.clone())),
                Side::Local if lingers_local && !remote.contains_key(&t.path) => Some(Op::DeleteLocal(t.path.clone())),
                _ => None,
            };
            plan.ops.extend(again);
        } else if back {
            // put back on purpose, or something new under the old name
            plan.ops.push(Op::ClearTombstone(t.path.clone(), t.side));
        }
    }

    // ---- renames, before anything is taken for a delete plus a create
    let mut moved: HashMap<String, BaseEntry> = HashMap::new();
    let mut gone: HashSet<String> = HashSet::new();
    let mut base_paths: Vec<&str> = base.paths();
    base_paths.sort_unstable();

    // renamed here: a tracked path vanished and an untracked one appeared with the same file id
    // (or, without ids, the same size and time); the remote file must still be the synced one
    let new_local: Vec<&String> = {
        let mut v: Vec<&String> = local.keys().filter(|k| base.entry(k).is_none()).collect();
        v.sort();
        v
    };
    let mut claimed: HashSet<String> = HashSet::new();
    for old in &base_paths {
        let b = base.entry(old).expect("listed");
        if local.contains_key(*old) || !remote.get(*old).is_some_and(|r| b.remote_matches(r)) {
            continue;
        }
        let found: Vec<&&String> = new_local
            .iter()
            .filter(|n| !claimed.contains(n.as_str()) && !remote.contains_key(n.as_str()))
            .filter(|n| {
                let l = &local[n.as_str()];
                // the same id *and* the same size and time: a disk hands a deleted file's id to
                // the next new file, so an id alone could tie two unrelated files together. A
                // file renamed and edited is a delete (to the Trash) and an upload instead.
                let same = b.l_size == l.size && b.l_mtime == l.mtime;
                match (&b.l_fileid, &l.file_id) {
                    (Some(a), Some(c)) => a == c && same,
                    (None, _) | (_, None) => same,
                }
            })
            .collect();
        if let [to] = found.as_slice() {
            let to = to.to_string();
            claimed.insert(to.clone());
            gone.insert(old.to_string());
            moved.insert(to.clone(), b.clone());
            // as it will be once renamed there
            if let Some(m) = remote.remove(*old) {
                remote.insert(to.clone(), m);
            }
            plan.ops.push(Op::RenameRemote { from: old.to_string(), to });
        }
    }

    // renamed on the other side: a tracked path vanished there and an untracked one appeared
    // with the same id (or the same ETag and size); the local file must still be the synced one
    let new_remote: Vec<&String> = {
        let mut v: Vec<&String> = remote.keys().filter(|k| base.entry(k).is_none() && !moved.contains_key(*k)).collect();
        v.sort();
        v
    };
    for old in &base_paths {
        if gone.contains(*old) {
            continue;
        }
        let b = base.entry(old).expect("listed");
        if remote.contains_key(*old) || !local.get(*old).is_some_and(|l| b.local_matches(l)) {
            continue;
        }
        let found: Vec<&&String> = new_remote
            .iter()
            .filter(|n| !claimed.contains(n.as_str()) && !local.contains_key(n.as_str()))
            .filter(|n| {
                let r = &remote[n.as_str()];
                match (&b.r_id, &r.id) {
                    (Some(a), Some(c)) => a == c,
                    _ => !b.r_etag.is_empty() && b.r_etag == r.etag && b.r_size == r.size,
                }
            })
            .collect();
        if let [to] = found.as_slice() {
            let to = to.to_string();
            claimed.insert(to.clone());
            gone.insert(old.to_string());
            moved.insert(to.clone(), b.clone());
            if let Some(m) = local.remove(*old) {
                local.insert(to.clone(), m);
            }
            plan.ops.push(Op::RenameLocal { from: old.to_string(), to });
        }
    }
    // a rename moves the base, so a renamed-and-edited file is a rename and then a push or pull
    let eff = |p: &str| -> Option<BaseEntry> {
        if let Some(b) = moved.get(p) {
            return Some(b.clone());
        }
        if gone.contains(p) { None } else { base.entry(p).cloned() }
    };

    // ---- every path by how each side changed
    let mut all: BTreeSet<String> = BTreeSet::new();
    all.extend(base_paths.iter().filter(|p| !gone.contains(**p)).map(|p| p.to_string()));
    all.extend(moved.keys().cloned());
    all.extend(local.keys().cloned());
    all.extend(remote.keys().cloned());
    let mut copies: HashSet<String> = HashSet::new();
    let mut deletes: Vec<(String, Side)> = Vec::new();
    for path in &all {
        if gone.contains(path) && !moved.contains_key(path) {
            continue;
        }
        let b = eff(path);
        let (l, r) = (local.get(path), remote.get(path));
        let (dl, dr) = (delta_local(b.as_ref(), l), delta_remote(b.as_ref(), r));
        use Delta::*;
        match (dl, dr) {
            (None, None) => {}
            (None, Created | Modified) => plan.ops.push(Op::Pull(path.clone())),
            (None, Deleted) => deletes.push((path.clone(), Side::Local)),
            (Created | Modified, None) => plan.ops.push(Op::Push(path.clone())),
            (Created | Modified, Created | Modified) => {
                let (l, r) = (l.expect("changed"), r.expect("changed"));
                if same_content(l, r) {
                    plan.ops.push(Op::Adopt(path.clone(), BaseEntry::of(l, r)));
                } else {
                    let copy = conflict_name(path, &opts.device, &opts.date, |c| {
                        local.contains_key(c) || remote.contains_key(c) || base.entry(c).is_some() || copies.contains(c)
                    });
                    copies.insert(copy.clone());
                    plan.ops.push(Op::Conflict { path: path.clone(), copy });
                }
            }
            (Created | Modified, Deleted) => plan.ops.push(Op::Push(path.clone())),
            (Deleted, None) => deletes.push((path.clone(), Side::Remote)),
            (Deleted, Created | Modified) => plan.ops.push(Op::Pull(path.clone())),
            (Deleted, Deleted) => plan.ops.push(Op::DropBase(path.clone())),
        }
    }

    // ---- the guard over every deletion of the run, repeated ones included
    let again: Vec<(String, Side)> = plan
        .ops
        .iter()
        .filter_map(|o| match o {
            Op::DeleteLocal(p) => Some((p.clone(), Side::Local)),
            Op::DeleteRemote(p) => Some((p.clone(), Side::Remote)),
            _ => None,
        })
        .collect();
    plan.ops.retain(|o| !matches!(o, Op::DeleteLocal(_) | Op::DeleteRemote(_)));
    deletes.extend(again);
    let empty = empty_side(base.count(), local.is_empty(), remote.is_empty());
    let (go, held) = hold(deletes, base.count(), empty, &opts.guard);
    plan.ops.extend(go.into_iter().map(|(p, side)| match side {
        Side::Local => Op::DeleteLocal(p),
        Side::Remote => Op::DeleteRemote(p),
    }));
    plan.held = held;
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(size: u64, mtime: i64) -> LocalMeta {
        LocalMeta::new(size, mtime)
    }
    fn li(size: u64, mtime: i64, id: &str) -> LocalMeta {
        LocalMeta { file_id: Some(id.into()), ..l(size, mtime) }
    }
    fn r(size: u64, etag: &str) -> RemoteMeta {
        RemoteMeta::new(size, etag, 1000)
    }
    fn b(ls: u64, lm: i64, rs: u64, etag: &str) -> BaseEntry {
        BaseEntry { l_size: ls, l_mtime: lm, r_size: rs, r_etag: etag.into(), r_mtime: 1000, ..Default::default() }
    }
    fn map<V: Clone>(items: &[(&str, V)]) -> HashMap<String, V> {
        items.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }
    fn opts() -> TwoWayOpts {
        TwoWayOpts { guard: Guard::on(), device: "Mac".into(), date: "2026-11-22".into(), now: 10_000_000, ..Default::default() }
    }
    fn two(local: &[(&str, LocalMeta)], remote: &[(&str, RemoteMeta)], base: &[(&str, BaseEntry)]) -> TwoWayPlan {
        plan_twoway(&map(local), &map(remote), &map(base), &[], &opts())
    }
    fn s(x: &str) -> String {
        x.to_string()
    }

    #[test]
    fn excluded_paths_are_never_planned_as_deletions() {
        let mut ex = Excluded::default();
        ex.add("locked/");
        ex.add("cafe\u{301}.txt");
        assert!(ex.covers("locked") && ex.covers("locked/a/b.txt") && ex.covers("caf\u{e9}.txt"));
        assert!(!ex.covers("lockedx/a") && !ex.covers("other.txt"));
        // "locked/a.txt" couldn't be read here, "café.txt" collides: both look gone locally
        let mut local = map(&[("ok.txt", l(1, 1))]);
        let mut remote = map(&[("ok.txt", r(1, "e")), ("locked/a.txt", r(2, "f")), ("caf\u{e9}.txt", r(3, "g"))]);
        let mut base = map(&[("ok.txt", b(1, 1, 1, "e")), ("locked/a.txt", b(2, 2, 2, "f")), ("caf\u{e9}.txt", b(3, 3, 3, "g"))]);
        ex.strip(&mut local);
        ex.strip(&mut remote);
        ex.strip(&mut base);
        let p = plan_twoway(&local, &remote, &base, &[], &opts());
        assert!(p.ops.is_empty() && p.held.is_none(), "{p:?}");
        let mut all = Excluded::default();
        all.add("");
        assert!(all.covers("anything/at/all"));
    }

    // ---- the ΔL × ΔR table, cell by cell

    #[test]
    fn nothing_changed_does_nothing() {
        let p = two(&[("a", l(1, 5))], &[("a", r(1, "e"))], &[("a", b(1, 5, 1, "e"))]);
        assert_eq!(p, TwoWayPlan::default());
    }

    #[test]
    fn unchanged_here_changed_there_pulls() {
        // modified there
        assert_eq!(two(&[("a", l(1, 5))], &[("a", r(2, "f"))], &[("a", b(1, 5, 1, "e"))]).ops, vec![Op::Pull(s("a"))]);
        // created there
        assert_eq!(two(&[], &[("a", r(2, "f"))], &[]).ops, vec![Op::Pull(s("a"))]);
    }

    #[test]
    fn unchanged_here_deleted_there_deletes_here() {
        let base = [("a", b(1, 5, 1, "e")), ("keep", b(1, 5, 1, "k"))];
        let p = two(&[("a", l(1, 5)), ("keep", l(1, 5))], &[("keep", r(1, "k"))], &base);
        assert_eq!(p.ops, vec![Op::DeleteLocal(s("a"))]);
    }

    #[test]
    fn changed_here_unchanged_there_pushes() {
        assert_eq!(two(&[("a", l(2, 6))], &[("a", r(1, "e"))], &[("a", b(1, 5, 1, "e"))]).ops, vec![Op::Push(s("a"))]);
        assert_eq!(two(&[("new", l(2, 6))], &[], &[]).ops, vec![Op::Push(s("new"))]);
    }

    #[test]
    fn changed_on_both_sides_is_a_conflict_with_a_named_copy() {
        let p = two(&[("dir/report.docx", l(2, 6))], &[("dir/report.docx", r(3, "f"))], &[("dir/report.docx", b(1, 5, 1, "e"))]);
        assert_eq!(p.ops, vec![Op::Conflict { path: s("dir/report.docx"), copy: s("dir/report (conflict Mac 2026-11-22).docx") }]);
        // created on both sides with different content
        let p = two(&[("a.txt", l(2, 6))], &[("a.txt", r(3, "f"))], &[]);
        assert!(matches!(&p.ops[..], [Op::Conflict { .. }]));
    }

    #[test]
    fn changed_on_both_sides_to_the_same_content_just_records_it() {
        let mut lm = l(4, 6);
        lm.md5 = Some("ABC".into());
        let rm = RemoteMeta { md5: Some("abc".into()), ..r(4, "abc") };
        let p = plan_twoway(&map(&[("a", lm.clone())]), &map(&[("a", rm.clone())]), &map(&[("a", b(1, 5, 1, "e"))]), &[], &opts());
        assert_eq!(p.ops, vec![Op::Adopt(s("a"), BaseEntry::of(&lm, &rm))]);
        // different hashes: a conflict even at the same size
        let rm2 = RemoteMeta { md5: Some("def".into()), ..rm };
        let p = plan_twoway(&map(&[("a", lm)]), &map(&[("a", rm2)]), &map(&[("a", b(1, 5, 1, "e"))]), &[], &opts());
        assert!(matches!(&p.ops[..], [Op::Conflict { .. }]));
        // first sync over an existing copy without hashes: same size and time (within 2 s) is
        // adopted; same size alone is not proof, so both versions are kept
        let p = two(&[("a", l(4, 2900))], &[("a", r(4, "x"))], &[]);
        assert!(matches!(&p.ops[..], [Op::Adopt(..)]));
        let p = two(&[("a", l(4, 3100))], &[("a", r(4, "x"))], &[]);
        assert!(matches!(&p.ops[..], [Op::Conflict { .. }]), "{p:?}");
        let p = two(&[("a", l(4, 6))], &[("a", RemoteMeta { modified: 0, ..r(4, "x") })], &[]);
        assert!(matches!(&p.ops[..], [Op::Conflict { .. }]), "no time there either: {p:?}");
        // edited on both sides to the same size without hashes or matching times: keep both
        let p = two(&[("a", l(4, 600_000))], &[("a", r(4, "x"))], &[("a", b(1, 5, 1, "e"))]);
        assert!(matches!(&p.ops[..], [Op::Conflict { .. }]));
    }

    #[test]
    fn changed_here_deleted_there_pushes_the_edit() {
        let base = [("a", b(1, 5, 1, "e")), ("k", b(1, 5, 1, "k"))];
        let p = two(&[("a", l(2, 6)), ("k", l(1, 5))], &[("k", r(1, "k"))], &base);
        assert_eq!(p.ops, vec![Op::Push(s("a"))]);
    }

    #[test]
    fn deleted_here_unchanged_there_deletes_there() {
        let base = [("a", b(1, 5, 1, "e")), ("k", b(1, 5, 1, "k"))];
        let p = two(&[("k", l(1, 5))], &[("a", r(1, "e")), ("k", r(1, "k"))], &base);
        assert_eq!(p.ops, vec![Op::DeleteRemote(s("a"))]);
    }

    #[test]
    fn deleted_here_changed_there_pulls_the_edit() {
        let base = [("a", b(1, 5, 1, "e")), ("k", b(1, 5, 1, "k"))];
        let p = two(&[("k", l(1, 5))], &[("a", r(9, "f")), ("k", r(1, "k"))], &base);
        assert_eq!(p.ops, vec![Op::Pull(s("a"))]);
    }

    #[test]
    fn deleted_on_both_sides_forgets_it() {
        let base = [("a", b(1, 5, 1, "e")), ("k", b(1, 5, 1, "k"))];
        let p = two(&[("k", l(1, 5))], &[("k", r(1, "k"))], &base);
        assert_eq!(p.ops, vec![Op::DropBase(s("a"))]);
    }

    #[test]
    fn rows_without_a_remote_time_or_etag_compare_by_size() {
        // a row imported from one-way sync's database knows only size, time and (maybe) ETag
        let old = BaseEntry { l_size: 3, l_mtime: 5, r_size: 3, ..Default::default() };
        assert!(old.remote_matches(&r(3, "anything")));
        assert!(!old.remote_matches(&r(4, "anything")));
        let p = two(&[("a", l(3, 5))], &[("a", r(3, "e"))], &[("a", old)]);
        assert!(p.ops.is_empty());
        // stores without ETags (SFTP) compare size and time
        let sftp = BaseEntry { l_size: 3, l_mtime: 5, r_size: 3, r_mtime: 1000, ..Default::default() };
        assert!(sftp.remote_matches(&RemoteMeta::new(3, "", 1000)));
        assert!(!sftp.remote_matches(&RemoteMeta::new(3, "", 2000)));
    }

    // ---- renames

    #[test]
    fn a_local_rename_is_mirrored_as_a_rename() {
        let base = [("old.txt", BaseEntry { l_fileid: Some("1:42".into()), ..b(3, 5, 3, "e") })];
        let p = two(&[("new.txt", li(3, 5, "1:42"))], &[("old.txt", r(3, "e"))], &base);
        assert_eq!(p.ops, vec![Op::RenameRemote { from: s("old.txt"), to: s("new.txt") }]);
        // renamed and edited (or a new file that got a deleted one's id): no rename is assumed,
        // the new file goes up and the old one to the trash
        let p = two(&[("new.txt", li(9, 7, "1:42"))], &[("old.txt", r(3, "e"))], &base);
        assert_eq!(p.ops, vec![Op::Push(s("new.txt")), Op::DeleteRemote(s("old.txt"))]);
        let p = two(&[("new.txt", li(3, 6, "1:42"))], &[("old.txt", r(3, "e"))], &base);
        assert_eq!(p.ops, vec![Op::Push(s("new.txt")), Op::DeleteRemote(s("old.txt"))]);
    }

    #[test]
    fn without_file_ids_a_rename_is_matched_by_size_and_time() {
        let p = two(&[("b/x.txt", l(3, 5))], &[("a/x.txt", r(3, "e"))], &[("a/x.txt", b(3, 5, 3, "e"))]);
        assert_eq!(p.ops, vec![Op::RenameRemote { from: s("a/x.txt"), to: s("b/x.txt") }]);
        // two candidates: no guessing, it is a delete and a create
        let p = two(&[("b/x.txt", l(3, 5)), ("c/x.txt", l(3, 5))], &[("a/x.txt", r(3, "e"))], &[("a/x.txt", b(3, 5, 3, "e"))]);
        assert!(!p.ops.iter().any(|o| matches!(o, Op::RenameRemote { .. })));
        assert!(p.ops.contains(&Op::DeleteRemote(s("a/x.txt"))));
        assert!(p.ops.contains(&Op::Push(s("b/x.txt"))) && p.ops.contains(&Op::Push(s("c/x.txt"))));
    }

    #[test]
    fn a_remote_rename_is_mirrored_as_a_local_rename() {
        let p = two(&[("old.txt", l(3, 5))], &[("new.txt", r(3, "e"))], &[("old.txt", b(3, 5, 3, "e"))]);
        assert_eq!(p.ops, vec![Op::RenameLocal { from: s("old.txt"), to: s("new.txt") }]);
        // by stable id (Drive), even with a new ETag: a rename, then the new content comes down
        let base = [("old.txt", BaseEntry { r_id: Some("id1".into()), ..b(3, 5, 3, "e") })];
        let moved = RemoteMeta { id: Some("id1".into()), ..r(4, "f") };
        let p = plan_twoway(&map(&[("old.txt", l(3, 5))]), &map(&[("new.txt", moved)]), &map(&base), &[], &opts());
        assert_eq!(p.ops, vec![Op::RenameLocal { from: s("old.txt"), to: s("new.txt") }, Op::Pull(s("new.txt"))]);
    }

    #[test]
    fn a_rename_on_a_side_whose_other_copy_changed_is_not_a_rename() {
        // renamed here, but edited there meanwhile: the edit is pulled back, the new name pushed
        let base = [("old.txt", BaseEntry { l_fileid: Some("7".into()), ..b(3, 5, 3, "e") })];
        let p = two(&[("new.txt", li(3, 5, "7"))], &[("old.txt", r(8, "f"))], &base);
        assert_eq!(p.ops, vec![Op::Push(s("new.txt")), Op::Pull(s("old.txt"))]);
    }

    #[test]
    fn the_same_rename_on_both_sides_settles_into_the_base() {
        let p = two(&[("new.txt", l(3, 5))], &[("new.txt", r(3, "e"))], &[("old.txt", b(3, 5, 3, "e"))]);
        assert_eq!(p.ops, vec![Op::Adopt(s("new.txt"), BaseEntry::of(&l(3, 5), &r(3, "e"))), Op::DropBase(s("old.txt"))]);
    }

    // ---- conflict names

    #[test]
    fn conflict_copies_are_named_and_numbered() {
        assert_eq!(conflict_name("a/b.tar.gz", "Mac", "2026-11-22", |_| false), "a/b.tar (conflict Mac 2026-11-22).gz");
        assert_eq!(conflict_name(".env", "Mac", "2026-11-22", |_| false), ".env (conflict Mac 2026-11-22)");
        assert_eq!(conflict_name("README", "", "2026-11-22", |_| false), "README (conflict 2026-11-22)");
        let taken = |c: &str| c == "x (conflict Mac 2026-11-22).txt";
        assert_eq!(conflict_name("x.txt", "Mac", "2026-11-22", taken), "x (conflict Mac 2026-11-22 2).txt");
        // a copy name already on either side is skipped
        let p = two(&[("x.txt", l(2, 6)), ("x (conflict Mac 2026-11-22).txt", l(1, 1))], &[("x.txt", r(3, "f"))], &[("x.txt", b(1, 5, 1, "e"))]);
        assert!(p.ops.contains(&Op::Conflict { path: s("x.txt"), copy: s("x (conflict Mac 2026-11-22 2).txt") }));
    }

    // ---- the mass-delete guard

    #[test]
    fn many_deletions_wait_for_a_confirmation() {
        let n = 60;
        let names: Vec<String> = (0..100).map(|i| format!("f{i:03}")).collect();
        let base: HashMap<String, BaseEntry> = names.iter().map(|k| (k.clone(), b(1, 5, 1, "e"))).collect();
        let local: HashMap<String, LocalMeta> = names.iter().skip(n).map(|k| (k.clone(), l(1, 5))).collect();
        let remote: HashMap<String, RemoteMeta> = names.iter().map(|k| (k.clone(), r(1, "e"))).collect();
        let p = plan_twoway(&local, &remote, &base, &[], &opts());
        let held = p.held.expect("held");
        assert_eq!(held.reason, HoldReason::TooMany);
        assert_eq!(held.items.len(), n);
        assert!(p.ops.is_empty(), "nothing is deleted while held");
        // confirmed: they go ahead
        let mut o = opts();
        o.guard.confirmed = held.items.into_iter().collect();
        let p = plan_twoway(&local, &remote, &base, &[], &o);
        assert!(p.held.is_none());
        assert_eq!(p.count(|o| matches!(o, Op::DeleteRemote(_))), n);
        // with the guard off, 60 of 100 just happen
        let mut o = opts();
        o.guard.enabled = false;
        assert!(plan_twoway(&local, &remote, &base, &[], &o).held.is_none());
    }

    #[test]
    fn up_to_fifty_or_a_fifth_is_fine() {
        assert!(!too_many_deletes(50, 10));
        assert!(too_many_deletes(51, 10));
        assert!(!too_many_deletes(200, 1000));
        assert!(too_many_deletes(201, 1000));
    }

    #[test]
    fn an_empty_side_never_deletes_the_other() {
        let base = [("a", b(1, 5, 1, "e")), ("b", b(1, 5, 1, "e"))];
        let p = two(&[], &[("a", r(1, "e")), ("b", r(1, "e"))], &base);
        assert_eq!(p.held.as_ref().unwrap().reason, HoldReason::SideEmpty(Side::Local));
        assert!(p.ops.is_empty());
        let p = two(&[("a", l(1, 5)), ("b", l(1, 5))], &[], &base);
        assert_eq!(p.held.as_ref().unwrap().reason, HoldReason::SideEmpty(Side::Remote));
        // even with the guard off
        let mut o = opts();
        o.guard.enabled = false;
        assert!(plan_twoway(&HashMap::new(), &map(&[("a", r(1, "e"))]), &map(&base), &[], &o).held.is_some());
        // a first sync into an empty folder deletes nothing, so nothing is held
        assert!(two(&[], &[("a", r(1, "e"))], &[]).held.is_none());
    }

    // ---- tombstones

    fn tomb(path: &str, side: Side, base: BaseEntry, at: i64) -> Tombstone {
        Tombstone { path: path.into(), side, base, deleted_at: at }
    }

    #[test]
    fn a_listing_that_lags_behind_does_not_bring_a_deleted_file_back() {
        // Kybl deleted "a" remotely a minute ago, but the listing still shows it
        let t = tomb("a", Side::Remote, b(1, 5, 1, "e"), 10_000_000 - 60_000);
        let (local, remote, base) = (map(&[("k", l(1, 5))]), map(&[("a", r(1, "e")), ("k", r(1, "k"))]), map(&[("k", b(1, 5, 1, "k"))]));
        let p = plan_twoway(&local, &remote, &base, std::slice::from_ref(&t), &opts());
        assert_eq!(p.ops, vec![Op::DeleteRemote(s("a"))], "deleted again, not pulled");
        // planning the same again gives the same: deleting is idempotent
        let again = plan_twoway(&local, &remote, &base, &[t], &opts());
        assert_eq!(again.ops, p.ops);
    }

    #[test]
    fn a_trashed_local_file_does_not_return_through_a_stale_remote_listing() {
        // remote deleted "a", Kybl moved the local copy to the Trash, the listing still has it
        let t = tomb("a", Side::Local, b(1, 5, 1, "e"), 10_000_000 - 1000);
        let p = plan_twoway(&HashMap::new(), &map(&[("a", r(1, "e"))]), &HashMap::<String, BaseEntry>::new(), &[t], &opts());
        assert!(p.ops.is_empty(), "{:?}", p.ops);
    }

    #[test]
    fn a_file_put_back_later_or_replaced_is_a_new_file() {
        // the same content, long after: put back on purpose
        let t = tomb("a", Side::Remote, b(1, 5, 1, "e"), 0);
        let p = plan_twoway(&HashMap::new(), &map(&[("a", r(1, "e"))]), &HashMap::<String, BaseEntry>::new(), &[t], &opts());
        assert_eq!(p.ops, vec![Op::ClearTombstone(s("a"), Side::Remote), Op::Pull(s("a"))]);
        // other content under the old name, right away
        let t = tomb("a", Side::Remote, b(1, 5, 1, "e"), 10_000_000 - 1000);
        let p = plan_twoway(&HashMap::new(), &map(&[("a", r(7, "new"))]), &HashMap::<String, BaseEntry>::new(), &[t], &opts());
        assert_eq!(p.ops, vec![Op::ClearTombstone(s("a"), Side::Remote), Op::Pull(s("a"))]);
    }

    #[test]
    fn an_interrupted_delete_finishes_on_the_next_run() {
        // the remote delete went through but the run ended before the base row was dropped
        let base = [("a", b(1, 5, 1, "e")), ("k", b(1, 5, 1, "k"))];
        let p = two(&[("k", l(1, 5))], &[("k", r(1, "k"))], &base);
        assert_eq!(p.ops, vec![Op::DropBase(s("a"))]);
        // ...or before it went through: it is made again
        let p = two(&[("k", l(1, 5))], &[("a", r(1, "e")), ("k", r(1, "k"))], &base);
        assert_eq!(p.ops, vec![Op::DeleteRemote(s("a"))]);
    }

    // ---- Unicode and capitals

    #[test]
    fn decomposed_names_are_the_same_file() {
        let composed = "caf\u{e9}.txt";
        let decomposed = "cafe\u{301}.txt";
        assert_ne!(composed, decomposed);
        assert_eq!(nfc(decomposed), composed);
        assert_eq!(nfc("plain/ascii.txt"), "plain/ascii.txt");
        // snapshots are keyed by nfc(): the local NFD name meets the remote NFC one
        let p = two(&[(&nfc(decomposed), l(1, 5))], &[(composed, r(1, "e"))], &[(composed, b(1, 5, 1, "e"))]);
        assert!(p.ops.is_empty());
    }

    #[test]
    fn names_that_differ_only_in_capitals_are_skipped_and_reported() {
        let mut o = opts();
        o.case_insensitive = true;
        let p = plan_twoway(&HashMap::new(), &map(&[("Readme.md", r(1, "a")), ("README.md", r(2, "b"))]), &HashMap::<String, BaseEntry>::new(), &[], &o);
        assert_eq!(p.ops, vec![Op::Pull(s("README.md"))]);
        assert_eq!(p.skipped, vec![Skip { path: s("Readme.md"), reason: SkipReason::CaseClash { with: s("README.md") } }]);
        // the tracked one wins
        let p = plan_twoway(&map(&[("Readme.md", l(1, 5))]), &map(&[("Readme.md", r(1, "a")), ("README.md", r(2, "b"))]), &map(&[("Readme.md", b(1, 5, 1, "a"))]), &[], &o);
        assert!(p.ops.is_empty());
        assert_eq!(p.skipped[0].path, "README.md");
        // a case-sensitive disk keeps both
        let p = plan_twoway(&HashMap::new(), &map(&[("Readme.md", r(1, "a")), ("README.md", r(2, "b"))]), &HashMap::<String, BaseEntry>::new(), &[], &opts());
        assert_eq!(p.count(|o| matches!(o, Op::Pull(_))), 2);
    }

    #[test]
    fn a_local_name_in_other_capitals_is_the_tracked_file() {
        // pulled as "photos/a.jpg" into an existing "Photos" folder: the disk reports "Photos/a.jpg"
        let mut o = opts();
        o.case_insensitive = true;
        let p = plan_twoway(&map(&[("Photos/a.jpg", l(1, 5))]), &map(&[("photos/a.jpg", r(1, "e"))]), &map(&[("photos/a.jpg", b(1, 5, 1, "e"))]), &[], &o);
        assert!(p.ops.is_empty(), "{:?}", p.ops);
    }

    // ---- hashing only where it settles something

    #[test]
    fn only_ambiguous_files_are_hashed() {
        let local = map(&[("same", l(4, 6)), ("diff", l(4, 6)), ("tracked", l(1, 5)), ("nomd5", l(4, 6))]);
        let remote = map(&[
            ("same", RemoteMeta { md5: Some("x".into()), ..r(4, "x") }),
            ("diff", RemoteMeta { md5: Some("y".into()), ..r(5, "y") }),
            ("tracked", RemoteMeta { md5: Some("z".into()), ..r(1, "z") }),
            ("nomd5", r(4, "n")),
        ]);
        let base = map(&[("tracked", b(1, 5, 1, "z"))]);
        assert_eq!(hash_candidates(&local, &remote, &base), vec![s("same")]);
    }

    // ---- one-way planners: today's behaviour

    #[test]
    fn upload_sends_new_and_changed_files_only() {
        let local = map(&[("a", l(1, 5)), ("b", l(2, 6)), ("c", l(3, 7))]);
        let base = map(&[("a", b(1, 5, 1, "")), ("b", b(2, 1, 2, ""))]);
        let p = plan_upload(&local, &base, None, &UploadPlanOpts::default());
        assert_eq!(p.uploads, vec![s("b"), s("c")]);
        // a full run also restores what went missing there, and adopts an identical copy
        let remote = map(&[("b", r(2, "x")), ("c", RemoteMeta::new(3, "y", 9))]);
        let p = plan_upload(&local, &base, Some(&remote), &UploadPlanOpts::default());
        assert_eq!(p.uploads, vec![s("a"), s("b")]);
        assert_eq!(p.adopt, vec![(s("c"), BaseEntry::of(&l(3, 7), &RemoteMeta::new(3, "y", 9)))]);
        // backup without adopting sends it
        let o = UploadPlanOpts { adopt_existing: false, ..Default::default() };
        assert_eq!(plan_upload(&local, &base, Some(&remote), &o).uploads, vec![s("a"), s("b"), s("c")]);
    }

    #[test]
    fn upload_adopts_only_a_copy_proven_the_same() {
        let local = map(&[("log", l(10, 5_000)), ("hashed", LocalMeta { md5: Some("aa".into()), ..l(10, 5_000) }), ("other", LocalMeta { md5: Some("aa".into()), ..l(10, 5_000) })]);
        let base: HashMap<String, BaseEntry> = HashMap::new();
        // same size, and newer there (an upload time): not proof, it's sent
        let remote = map(&[
            ("log", RemoteMeta::new(10, "e", 900_000)),
            ("hashed", RemoteMeta { md5: Some("AA".into()), ..RemoteMeta::new(10, "e", 900_000) }),
            ("other", RemoteMeta { md5: Some("bb".into()), ..RemoteMeta::new(10, "e", 5_000) }),
        ]);
        let p = plan_upload(&local, &base, Some(&remote), &UploadPlanOpts::default());
        assert_eq!(p.adopt.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["hashed"]);
        assert_eq!(p.uploads, vec![s("log"), s("other")], "another MD5 is another file whatever the times");
        // times within the tolerance and no hashes: the same file
        let remote = map(&[("log", RemoteMeta::new(10, "e", 6_500))]);
        let p = plan_upload(&map(&[("log", l(10, 5_000))]), &base, Some(&remote), &UploadPlanOpts::default());
        assert_eq!(p.adopt.len(), 1);
    }

    #[test]
    fn upload_deletes_only_when_mirroring_and_never_from_an_empty_folder() {
        let base = map(&[("a", b(1, 5, 1, "")), ("gone", b(1, 5, 1, ""))]);
        let local = map(&[("a", l(1, 5))]);
        let p = plan_upload(&local, &base, None, &UploadPlanOpts::default());
        assert_eq!((p.forget.clone(), p.delete_remote.clone()), (vec![s("gone")], vec![]));
        let o = UploadPlanOpts { mirror_deletes: true, ..Default::default() };
        let p = plan_upload(&local, &base, None, &o);
        assert_eq!(p.delete_remote, vec![s("gone")]);
        let p = plan_upload(&HashMap::new(), &base, None, &o);
        assert!(p.delete_remote.is_empty());
        assert_eq!(p.held.unwrap().reason, HoldReason::SideEmpty(Side::Local));
    }

    #[test]
    fn download_keeps_local_edits_and_copies_on_conflict() {
        let base = map(&[("same", b(1, 5, 1, "e")), ("edited", b(1, 5, 1, "e")), ("both", b(1, 5, 1, "e")), ("removed", b(1, 5, 1, "e"))]);
        let local = map(&[("same", l(1, 5)), ("edited", l(2, 6)), ("both", l(2, 6)), ("removed", l(1, 5)), ("adopt", l(4, 1))]);
        let remote = map(&[("same", r(1, "e")), ("edited", r(1, "e")), ("both", r(3, "f")), ("adopt", r(4, "g")), ("new", r(1, "n"))]);
        let p = plan_download(&local, &base, &remote, &DownloadPlanOpts::default());
        assert_eq!(p.downloads, vec![(s("both"), true), (s("new"), false)]);
        assert_eq!(p.kept_edits, 1);
        assert_eq!(p.conflicts(), 1);
        assert_eq!(p.adopt.len(), 1);
        assert_eq!(p.forget, vec![s("removed")]);
        let p = plan_download(&local, &base, &remote, &DownloadPlanOpts { mirror_deletes: true, guard: Guard::on() });
        assert_eq!(p.trash_local, vec![s("removed")]);
        // an empty listing never empties the folder
        let p = plan_download(&local, &base, &HashMap::new(), &DownloadPlanOpts { mirror_deletes: true, guard: Guard::default() });
        assert!(p.trash_local.is_empty());
        assert_eq!(p.held.unwrap().reason, HoldReason::SideEmpty(Side::Remote));
        // an untracked local file of the same size but another time (and no hash): kept aside
        let p = plan_download(&map(&[("x", l(4, 900_000))]), &HashMap::new(), &map(&[("x", r(4, "g"))]), &DownloadPlanOpts::default());
        assert_eq!(p.downloads, vec![(s("x"), true)]);
        assert!(p.adopt.is_empty());
        // the same with matching hashes: adopted whatever the times
        let lm = LocalMeta { md5: Some("aa".into()), ..l(4, 900_000) };
        let rm = RemoteMeta { md5: Some("AA".into()), ..r(4, "g") };
        let p = plan_download(&map(&[("x", lm)]), &HashMap::new(), &map(&[("x", rm)]), &DownloadPlanOpts::default());
        assert_eq!(p.adopt.len(), 1);
    }
}
