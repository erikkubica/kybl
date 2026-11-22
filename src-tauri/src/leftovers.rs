//! What transfers leave behind until they end: multipart uploads on the server (their parts cost
//! storage until the upload is completed or aborted) and partial downloads (`.s3part` files).
//!
//! Quitting cleans those up (quit.rs), but the app can also end without that: killed, crashed,
//! the computer shut down, a phone ending the process. So they are written down in a small file
//! in the app's data folder, and the next start aborts the uploads and removes the partial files
//! an earlier run left behind. Transfer ids don't survive a restart, so none of those can be
//! retried any more anyway. Only files written down here are ever removed, never anything Kybl
//! didn't create.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{dest, state::AppState};

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

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
struct Ledger {
    #[serde(default)]
    uploads: Vec<Upload>,
    /// `.s3part` files
    #[serde(default)]
    partials: Vec<PathBuf>,
}

static PATH: OnceLock<PathBuf> = OnceLock::new();
static LEDGER: Mutex<Ledger> = Mutex::new(Ledger { uploads: Vec::new(), partials: Vec::new() });
/// A save is already on its way.
static SAVING: AtomicBool = AtomicBool::new(false);

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

/// Writes the ledger now (next to the file, then renamed over it, so a crash never leaves half
/// of it). Partial files that are gone meanwhile are dropped from it first.
pub fn save() {
    let Some(path) = PATH.get() else { return };
    let json = {
        let mut l = LEDGER.lock().unwrap();
        l.partials.retain(|p| p.exists());
        serde_json::to_vec(&*l)
    };
    let Ok(json) = json else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
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
        if !l.partials.iter().any(|p| p == part) {
            l.partials.push(part.to_path_buf());
        }
    });
}

/// The partial download file was renamed into place or removed.
pub fn partial_ended(part: &Path) {
    change(|l| l.partials.retain(|p| p != part));
}

/// At start-up: reads what an earlier run left and cleans it up in the background. Also empties
/// the cache of picked files copied for uploads (`uploads/`), which only a running upload needs.
pub fn start(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(FILE);
    let earlier: Ledger = std::fs::read(&path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default();
    // kept until cleaned up, so a run that ends early again still knows about them
    {
        let mut l = LEDGER.lock().unwrap();
        l.uploads.extend(earlier.uploads.iter().cloned());
        l.partials.extend(earlier.partials.iter().cloned());
    }
    let _ = PATH.set(path);
    // before any upload of this run can copy a file there
    if let Ok(cache) = app.path().app_cache_dir() {
        let _ = std::fs::remove_dir_all(cache.join("uploads"));
    }
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
            let _ = std::fs::remove_file(part);
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
            // the connection was removed: nothing can abort it any more
            if e.contains("not found") || now().saturating_sub(u.created) > GIVE_UP_AFTER.as_secs() {
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

    #[test]
    fn the_ledger_reads_back_and_tolerates_older_files() {
        let l = Ledger {
            uploads: vec![Upload { profile_id: "p".into(), bucket: "b".into(), key: "k".into(), upload_id: "u".into(), created: 1 }],
            partials: vec![PathBuf::from("/d/a.s3part")],
        };
        let back: Ledger = serde_json::from_slice(&serde_json::to_vec(&l).unwrap()).unwrap();
        assert_eq!(back, l);
        let empty: Ledger = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Ledger::default());
    }
}
