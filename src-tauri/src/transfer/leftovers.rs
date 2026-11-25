//! What transfers leave behind until they end: multipart uploads on the server (their parts cost
//! storage until the upload is completed or aborted) and partial downloads (`.s3part` files).
//!
//! Quitting cleans those up (app/quit.rs), but the app can also end without that: killed, crashed,
//! the computer shut down, a phone ending the process. So they are written down in a small file
//! in the app's data folder, and the next start aborts the uploads and removes the partial files
//! an earlier run left behind. Transfer ids don't survive a restart, so none of those can be
//! retried any more anyway. Only files written down here are ever removed, never anything Kybl
//! didn't create.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{transfer::dest, state::AppState};

/// Each run keeps its ledger in a folder of its own below the data folder (`<RUNS>/<run>/FILE`,
/// see `instance_dir`), so a second Kybl starting never cleans up what the first is still using.
/// The same folder holds the run's kept transfers (`resume`), see [`run_dir`].
/// `FILE` directly in the data folder is the one shared ledger older versions kept.
const RUNS: &str = "leftovers";
const FILE: &str = "leftovers.json";
/// An upload that still can't be aborted after this long (the server unreachable every start)
/// is let go: by then most servers have dropped it themselves.
const GIVE_UP_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Upload {
    profile_id: String,
    bucket: String,
    key: String,
    upload_id: String,
    /// seconds since 1970
    created: u64,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Clone)]
struct Ledger {
    #[serde(default)]
    uploads: Vec<Upload>,
    /// `.s3part` files
    #[serde(default)]
    partials: BTreeSet<PathBuf>,
}

static PATH: OnceLock<PathBuf> = OnceLock::new();
static LEDGER: Mutex<Ledger> = Mutex::new(Ledger { uploads: Vec::new(), partials: BTreeSet::new() });
/// Held while the ledger is written.
static WRITING: Mutex<()> = Mutex::new(());
/// A save is already on its way.
static SAVING: AtomicBool = AtomicBool::new(false);
/// This run's folder, and the ledger file in it with what was taken over (until `start` has it).
static RUN: OnceLock<Option<PathBuf>> = OnceLock::new();
static TAKEN: Mutex<Option<(PathBuf, Ledger)>> = Mutex::new(None);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn change(f: impl FnOnce(&mut Ledger)) {
    f(&mut LEDGER.lock().unwrap());
    if PATH.get().is_none() || SAVING.swap(true, Ordering::SeqCst) {
        return;
    }
    // many small files (sync) start and end in quick succession: save at most once a second
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        SAVING.store(false, Ordering::SeqCst);
        save();
    });
}

/// Writes the ledger now (to a temporary file of its own, flushed to disk and renamed over it, so
/// a crash never leaves half of it). Partial files that are gone meanwhile are dropped from it
/// first. One save at a time, each writing what is current then, so an older list never lands
/// after a newer one.
pub fn save() {
    let _ = save_now();
}

fn save_now() -> std::io::Result<()> {
    let Some(path) = PATH.get() else { return Err(std::io::Error::other("no ledger yet")) };
    let _one = WRITING.lock().unwrap();
    // The files are looked at without the ledger locked: with tens of thousands of queued
    // downloads this is a lot of stats, and every starting download waits on the lock.
    let listed: Vec<PathBuf> = LEDGER.lock().unwrap().partials.iter().cloned().collect();
    let gone: Vec<PathBuf> = listed.into_iter().filter(|p| !p.exists()).collect();
    let json = {
        let mut l = LEDGER.lock().unwrap();
        for p in &gone {
            // looked at again: a download may have made the file again since
            if !p.exists() {
                l.partials.remove(p);
            }
        }
        serde_json::to_vec(&*l)
    };
    crate::state::write_atomic(path, &json.map_err(std::io::Error::other)?)
}

/// How often a running Kybl looks for runs that ended meanwhile (another copy that quit or
/// crashed): their folders of copies are removed, their ledgers and kept transfers taken over.
const SWEEP_EVERY: Duration = Duration::from_secs(3600);

/// Takes over what runs that ended while this one runs left (B5-3): their kept transfers (into
/// `resume`) and their ledgers, whose uploads and partial files are then cleaned up as at a
/// start. Also removes the folders of copies they left (`instance_dir::sweep_ended_runs`).
/// Blocking, apart from the clean-up it starts.
fn take_over_ended(app: &AppHandle) {
    crate::app::instance_dir::sweep_ended_runs();
    let Some(base) = RUN.get().and_then(|r| r.as_ref()).and_then(|r| r.parent().map(Path::to_path_buf)) else { return };
    let mut found = Ledger::default();
    crate::app::instance_dir::sweep_ended_adopting(&base, |_, gone| {
        if !crate::transfer::resume::take_in(app, gone) {
            return false;
        }
        let Some(mut l) = read_ledger(&gone.join(FILE)) else { return true };
        // what a kept transfer left is the resume store's (as in `start`)
        l.uploads.retain(|u| !crate::transfer::resume::keeps_upload(&u.upload_id));
        l.partials.retain(|p| !crate::transfer::resume::keeps_partial(p));
        merge(&mut LEDGER.lock().unwrap(), l.clone());
        // written into this run's ledger before their folder goes
        if save_now().is_err() {
            return false;
        }
        merge(&mut found, l);
        true
    });
    if found.uploads.is_empty() && found.partials.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for part in &found.partials {
            remove_partial(part);
        }
        for u in found.uploads {
            abort_left(&app, u).await;
        }
        save();
    });
}

fn read_ledger(path: &Path) -> Option<Ledger> {
    std::fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok())
}

fn write_ledger(path: &Path, l: &Ledger) -> std::io::Result<()> {
    crate::state::write_atomic(path, &serde_json::to_vec(l).map_err(std::io::Error::other)?)
}

fn merge(into: &mut Ledger, from: Ledger) {
    for u in from.uploads {
        if !into.uploads.iter().any(|x| x.upload_id == u.upload_id) {
            into.uploads.push(u);
        }
    }
    for p in from.partials {
        into.partials.insert(p);
    }
}

/// Claims this run's own ledger folder below `base` (see `instance_dir`) and takes over the
/// ledgers of runs that ended (crashed, killed, quit with something left), plus the one shared
/// file older versions kept (`legacy`). A ledger of a Kybl that is still running is never read:
/// its uploads and partial files are still in use. Returns this run's ledger file and what was
/// taken over, which is written into this run's file before the ended run's folder goes.
fn take_over(base: &Path, legacy: Option<&Path>) -> std::io::Result<(PathBuf, Ledger)> {
    let mut found = Ledger::default();
    let dir = crate::app::instance_dir::claim_adopting(base, |own, gone| {
        // its kept transfers come along: whoever takes over a run's ledger takes those too
        if crate::transfer::resume::adopt(own, gone).is_err() {
            return false;
        }
        let Some(l) = read_ledger(&gone.join(FILE)) else { return true };
        merge(&mut found, l);
        write_ledger(&own.join(FILE), &found).is_ok()
    })?;
    let file = dir.join(FILE);
    if let Some(legacy) = legacy
        && let Some(l) = read_ledger(legacy)
    {
        merge(&mut found, l);
        if write_ledger(&file, &found).is_ok() {
            let _ = std::fs::remove_file(legacy);
        }
    }
    Ok((file, found))
}

/// A multipart upload was created on the server.
pub fn upload_started(profile_id: &str, bucket: &str, key: &str, upload_id: &str) {
    let u = Upload { profile_id: profile_id.into(), bucket: bucket.into(), key: key.into(), upload_id: upload_id.into(), created: now() };
    change(|l| l.uploads.push(u));
}

/// The multipart upload was completed or aborted.
pub fn upload_ended(upload_id: &str) {
    change(|l| l.uploads.retain(|u| u.upload_id != upload_id));
}

/// A partial download file was created.
pub fn partial_started(part: &Path) {
    change(|l| {
        l.partials.insert(part.to_path_buf());
    });
}

/// The partial download file was renamed into place or removed.
pub fn partial_ended(part: &Path) {
    change(|l| {
        l.partials.remove(part);
    });
}

/// This run's own folder below the data folder (`<RUNS>/<run>/`), claimed on the first call
/// (`resume::start`, then [`start`]). It holds this run's ledger and its kept transfers; the
/// claim takes over both from the runs that ended in one go, so a run's kept transfers and its
/// ledger always go to the same start, and never to two.
pub fn run_dir(app: &AppHandle) -> Option<PathBuf> {
    RUN.get_or_init(|| {
        let dir = app.path().app_data_dir().ok()?;
        let (file, found) = take_over(&dir.join(RUNS), Some(&dir.join(FILE))).ok()?;
        let run = file.parent().map(Path::to_path_buf);
        *TAKEN.lock().unwrap() = Some((file, found));
        run
    })
    .clone()
}

/// At start-up, after `resume::start`: takes over what ended runs left and cleans it up in the
/// background. Also removes the copies of picked files that ended runs made for uploads
/// (`uploads/`, one folder per run: another Kybl still running keeps its own).
pub fn start(app: &AppHandle) {
    // before any upload of this run can copy a file there
    if let Ok(cache) = app.path().app_cache_dir()
        && let Ok(dir) = crate::app::instance_dir::claim(&cache.join("uploads"))
    {
        // copies of uploads of unknown size go there too (B3-4, round 5)
        crate::storage::extras::set_spool_dir(dir);
    }
    let _ = run_dir(app);
    // a run that ends while this one keeps going (in the tray for weeks) isn't left until the
    // next start
    let sweeper = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP_EVERY).await;
            let app = sweeper.clone();
            let _ = tokio::task::spawn_blocking(move || take_over_ended(&app)).await;
        }
    });
    let Some((path, mut earlier)) = TAKEN.lock().unwrap().take() else { return };
    // what a paused or interrupted transfer kept to carry on from is the resume store's (`resume`)
    earlier.uploads.retain(|u| !crate::transfer::resume::keeps_upload(&u.upload_id));
    earlier.partials.retain(|p| !crate::transfer::resume::keeps_partial(p));
    // kept until cleaned up, so a run that ends early again still knows about them
    {
        let mut l = LEDGER.lock().unwrap();
        l.uploads.extend(earlier.uploads.iter().cloned());
        l.partials.extend(earlier.partials.iter().cloned());
    }
    let _ = PATH.set(path);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for part in &earlier.partials {
            remove_partial(part);
        }
        for u in earlier.uploads {
            abort_left(&app, u).await;
        }
        save();
    });
}

/// Removes a partial download file an earlier run left, if it is one (a `.s3part` file) and no
/// download of this run uses that name.
fn remove_partial(part: &Path) {
    let Some(target) = target_of(part) else {
        partial_ended(part);
        return;
    };
    let gone = dest::unless_in_use(&target, || {
        if std::fs::symlink_metadata(part).is_ok_and(|m| m.is_file()) {
            dest::remove_part(part);
        }
    });
    if gone {
        partial_ended(part);
    }
}

/// The file a partial download was going to become; None for anything that isn't one.
fn target_of(part: &Path) -> Option<PathBuf> {
    let s = part.to_str()?;
    let target = s.strip_suffix(dest::PART_SUFFIX)?;
    (part.is_absolute() && !target.is_empty() && !target.ends_with(['/', '\\'])).then(|| PathBuf::from(target))
}

async fn abort_left(app: &AppHandle, u: Upload) {
    let state = app.state::<AppState>();
    let client = match crate::state::client_for(app, &state, &u.profile_id).await {
        Ok(c) => c,
        Err(e) => {
            // the connection (or its key) was removed: nothing can abort it any more
            if e.contains("not found") || e.contains("No secret key") || now().saturating_sub(u.created) > GIVE_UP_AFTER.as_secs() {
                upload_ended(&u.upload_id);
            }
            return;
        }
    };
    let r = client.abort_multipart_upload().bucket(&u.bucket).key(&u.key).upload_id(&u.upload_id).send().await;
    let gone = match r {
        Ok(_) => true,
        Err(e) => {
            let e = crate::state::sdk_err(e);
            e.contains("NoSuchUpload") || e.contains("NoSuchBucket") || now().saturating_sub(u.created) > GIVE_UP_AFTER.as_secs()
        }
    };
    if gone {
        upload_ended(&u.upload_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_partial_download_files_are_ever_removed() {
        assert_eq!(target_of(Path::new("/d/a.jpg.s3part")), Some(PathBuf::from("/d/a.jpg")));
        assert_eq!(target_of(Path::new("/d/a.jpg")), None);
        assert_eq!(target_of(Path::new("relative.s3part")), None);
        assert_eq!(target_of(Path::new("/d/.s3part")), None, "names nothing");

        let dir = std::env::temp_dir().join(format!("kybl-left-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let theirs = dir.join("notes.txt");
        let ours = dir.join("movie.mkv.s3part");
        let busy = dir.join("busy.bin.s3part");
        for f in [&theirs, &ours, &busy] {
            std::fs::write(f, b"x").unwrap();
        }
        let held = dest::reserve(&dir.join("busy.bin"), true).unwrap();
        for p in [&theirs, &ours, &busy] {
            remove_partial(p);
        }
        assert!(theirs.exists(), "not a partial download: never touched");
        assert!(!ours.exists());
        assert!(busy.exists(), "a download of this run writes there");
        dest::release(&held);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn ledger_of(id: &str) -> Ledger {
        Ledger {
            uploads: vec![Upload { profile_id: "p".into(), bucket: "b".into(), key: id.into(), upload_id: id.into(), created: 1 }],
            partials: BTreeSet::from([PathBuf::from(format!("/d/{id}.s3part"))]),
        }
    }

    #[test]
    fn a_start_takes_over_only_what_ended_runs_left() {
        use std::time::SystemTime;
        let data = std::env::temp_dir().join(format!("kybl-left-runs-{}", uuid::Uuid::new_v4().simple()));
        let base = data.join(RUNS);
        std::fs::create_dir_all(base.join("live")).unwrap();
        std::fs::create_dir_all(base.join("dead")).unwrap();
        // a Kybl still running: holds its lock; its uploads are in flight
        write_ledger(&base.join("live").join(FILE), &ledger_of("live")).unwrap();
        let live = std::fs::File::create(base.join("live.lock")).unwrap();
        live.try_lock().unwrap();
        // a run that crashed: its lock is free
        write_ledger(&base.join("dead").join(FILE), &ledger_of("dead")).unwrap();
        let dead = std::fs::File::create(base.join("dead.lock")).unwrap();
        dead.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        drop(dead);
        // kept transfers of both: the running one's stay where they are, the ended one's come along
        let kept = |id: &str| serde_json::to_vec(&serde_json::json!([{ "id": id, "kind": "download", "state": "paused" }])).unwrap();
        std::fs::write(base.join("live").join("transfers.json"), kept("live")).unwrap();
        std::fs::write(base.join("dead").join("transfers.json"), kept("dead")).unwrap();
        // the shared file of an older version
        let legacy = data.join(FILE);
        write_ledger(&legacy, &ledger_of("old")).unwrap();

        let (own, found) = take_over(&base, Some(&legacy)).unwrap();
        let ids: Vec<&str> = found.uploads.iter().map(|u| u.upload_id.as_str()).collect();
        assert_eq!(ids, ["dead", "old"], "the running instance's upload must never be aborted");
        assert_eq!(found.partials.len(), 2);
        assert_eq!(read_ledger(&base.join("live").join(FILE)), Some(ledger_of("live")), "a running instance's ledger is left alone");
        assert!(!base.join("dead").exists() && !legacy.exists(), "taken over, then removed");
        assert_eq!(read_ledger(&own), Some(found), "what was taken over is in this run's own ledger first");
        let ids = |p: &Path| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
            v.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(ids(&own.with_file_name("transfers.json")), ["dead"], "an ended run's kept transfers move with its ledger");
        assert_eq!(ids(&base.join("live").join("transfers.json")), ["live"], "a running instance's kept transfers are left alone");
        drop(live);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn the_ledger_reads_back_and_tolerates_older_files() {
        let l = Ledger {
            uploads: vec![Upload { profile_id: "p".into(), bucket: "b".into(), key: "k".into(), upload_id: "u".into(), created: 1 }],
            partials: BTreeSet::from([PathBuf::from("/d/a.s3part")]),
        };
        let back: Ledger = serde_json::from_slice(&serde_json::to_vec(&l).unwrap()).unwrap();
        assert_eq!(back, l);
        let empty: Ledger = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Ledger::default());
    }
}
