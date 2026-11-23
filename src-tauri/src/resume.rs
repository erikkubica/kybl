//! Transfers kept across a restart: paused ones, failed ones, and every transfer still queued or
//! running when the app quits (or crashes: a running transfer's record is written as it starts
//! and as its parts land). They come back as paused (or failed) on the next start, and carry on
//! from what they kept where the backend allows: the partial download file and the version it
//! came from, the parts of an S3 multipart upload, the session of a cloud drive upload, or the
//! temporary file on an SFTP / FTP server.
//!
//! Kept in `transfers.json` in the app's data folder. What a kept transfer left behind (partial
//! files, open uploads) is the store's to clean up, not `leftovers`': that one skips anything
//! named here (see [`keeps_upload`], [`keeps_partial`]). Records older than [`KEEP_FOR`] are
//! given up and handed to `leftovers` for cleaning.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::storage::ResumeState;

const FILE: &str = "transfers.json";
/// A paused transfer nobody came back to in this long is given up (servers drop unfinished
/// uploads after about a week too).
const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 3600);

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    pub id: String,
    /// upload | download
    pub kind: String,
    pub name: String,
    pub profile_id: String,
    pub bucket: String,
    pub key: String,
    /// an upload's local file; the file a download writes (its free name)
    pub local: String,
    /// a download: the path the page asked for (a retry asks for it again)
    pub requested: String,
    /// a download replaces a file of the same name
    pub overwrite: bool,
    pub bytes: u64,
    pub total: u64,
    /// running | paused | error (a running one read back after a restart is paused)
    pub state: String,
    pub error: Option<String>,
    /// a download: the version being fetched (its ETag), so the rest comes from the same one
    pub version: Option<String>,
    /// an upload: the local file as it was when its first parts were sent (size, mtime in ms)
    pub stamp: Option<(u64, Option<i64>)>,
    /// an upload: what was sent so far (S3 multipart upload id and parts, a cloud drive's upload
    /// session, or an SFTP / FTP server's temporary file)
    pub upload: Option<ResumeState>,
    /// what `upload` is: `s3` (a multipart upload), `drive` (a cloud drive's upload session) or
    /// `server` (a temporary file on an SFTP / FTP server, `upload_id` being its key)
    pub via: String,
    /// seconds since 1970
    pub saved: u64,
}

impl Saved {
    pub fn is_download(&self) -> bool {
        self.kind == "download"
    }
}

static PATH: OnceLock<PathBuf> = OnceLock::new();
static RECORDS: Mutex<Option<HashMap<String, Saved>>> = Mutex::new(None);
static SAVING: AtomicBool = AtomicBool::new(false);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn with<T>(f: impl FnOnce(&mut HashMap<String, Saved>) -> T) -> T {
    f(RECORDS.lock().unwrap().get_or_insert_with(HashMap::new))
}

fn changed() {
    if PATH.get().is_none() || SAVING.swap(true, Ordering::SeqCst) {
        return;
    }
    // parts of many uploads land in quick succession: save at most once a second
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        SAVING.store(false, Ordering::SeqCst);
        save();
    });
}

/// Writes the file now (aside, then renamed over it, so a crash never leaves half of it).
pub fn save() {
    let Some(path) = PATH.get() else { return };
    let json = with(|r| {
        let mut list: Vec<&Saved> = r.values().collect();
        list.sort_by(|a, b| a.saved.cmp(&b.saved).then(a.id.cmp(&b.id)));
        serde_json::to_vec(&list)
    });
    let Ok(json) = json else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Records (or replaces) a transfer.
pub fn put(mut s: Saved) {
    s.saved = now();
    with(|r| r.insert(s.id.clone(), s));
    changed();
}

/// Changes a kept transfer; nothing when there is none.
pub fn update(id: &str, f: impl FnOnce(&mut Saved)) {
    let hit = with(|r| match r.get_mut(id) {
        Some(s) => {
            f(s);
            s.saved = now();
            true
        }
        None => false,
    });
    if hit {
        changed();
    }
}

/// Changes a kept transfer, keeping `fresh` first when there is none yet.
pub fn update_or_put(id: &str, fresh: Saved, f: impl FnOnce(&mut Saved)) {
    with(|r| {
        let s = r.entry(id.to_string()).or_insert(fresh);
        f(s);
        s.saved = now();
    });
    changed();
}

pub fn get(id: &str) -> Option<Saved> {
    with(|r| r.get(id).cloned())
}

/// Forgets a transfer (it finished, or the user gave up on it).
pub fn remove(id: &str) -> Option<Saved> {
    let s = with(|r| r.remove(id));
    if s.is_some() {
        changed();
    }
    s
}

/// Every kept transfer that isn't running in this run, oldest first.
pub fn list() -> Vec<Saved> {
    let mut v: Vec<Saved> = with(|r| r.values().filter(|s| s.state != "running").cloned().collect());
    v.sort_by(|a, b| a.saved.cmp(&b.saved).then(a.id.cmp(&b.id)));
    v
}

/// Whether a multipart upload or session belongs to a kept transfer (so nobody aborts it).
pub fn keeps_upload(upload_id: &str) -> bool {
    with(|r| r.values().any(|s| s.upload.as_ref().is_some_and(|u| u.upload_id == upload_id)))
}

/// Whether a partial download file belongs to a kept transfer.
pub fn keeps_partial(part: &Path) -> bool {
    with(|r| r.values().any(|s| s.is_download() && crate::dest::part_path(Path::new(&s.local)) == part))
}

/// What a file read back holds: running ones are paused now, stale ones are split off.
fn read_back(list: Vec<Saved>, at: u64) -> (HashMap<String, Saved>, Vec<Saved>) {
    let mut keep = HashMap::new();
    let mut stale = Vec::new();
    for mut s in list {
        if s.id.is_empty() || (s.kind != "upload" && s.kind != "download") {
            continue;
        }
        if at.saturating_sub(s.saved) > KEEP_FOR.as_secs() {
            stale.push(s);
            continue;
        }
        if s.state != "error" {
            s.state = "paused".into();
        }
        keep.insert(s.id.clone(), s);
    }
    (keep, stale)
}

/// At start-up, before `leftovers::start`: reads what an earlier run kept. Kept downloads get
/// their names back (see `transfers::adopt`); stale ones are handed to `leftovers` to clean up.
pub fn start(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(FILE);
    let list: Vec<Saved> = std::fs::read(&path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default();
    let (keep, stale) = read_back(list, now());
    let kept: Vec<Saved> = keep.values().cloned().collect();
    *RECORDS.lock().unwrap() = Some(keep);
    let _ = PATH.set(path);
    for s in &kept {
        crate::transfers::adopt(s);
    }
    for s in stale {
        give_up(app, &s);
    }
    save();
}

/// Cleans up what a kept transfer left behind: its partial download file, its multipart upload
/// on the server (through `leftovers`, which aborts it), or its temporary file on a server.
pub fn give_up(app: &AppHandle, s: &Saved) {
    if s.is_download() {
        let part = crate::dest::part_path(Path::new(&s.local));
        if crate::dest::unpark(Path::new(&s.local), &s.id) {
            let _ = std::fs::remove_file(part);
        }
        return;
    }
    let Some(u) = s.upload.clone() else { return };
    let (app, s) = (app.clone(), s.clone());
    match s.via.as_str() {
        // a server's temporary file (SFTP, FTP), named by the upload id
        "server" => {
            tauri::async_runtime::spawn(async move {
                let state = app.state::<crate::state::AppState>();
                if let Ok(st) = crate::storage::registry::open(&app, &state, &s.profile_id).await {
                    let never = AtomicBool::new(false);
                    let _ = st.delete(&s.bucket, &[u.upload_id], &[], &never, &|_, _| {}).await;
                }
            });
        }
        // an S3 multipart upload: aborted now, or by the next start if the server can't be reached
        "s3" => {
            crate::leftovers::upload_started(&s.profile_id, &s.bucket, &s.key, &u.upload_id);
            tauri::async_runtime::spawn(async move {
                let state = app.state::<crate::state::AppState>();
                let Ok(client) = crate::state::client_for(&app, &state, &s.profile_id).await else { return };
                let r = client.abort_multipart_upload().bucket(&s.bucket).key(&s.key).upload_id(&u.upload_id).send().await;
                if r.is_ok() || r.is_err_and(|e| crate::state::sdk_err(e).contains("NoSuchUpload")) {
                    crate::leftovers::upload_ended(&u.upload_id);
                }
            });
        }
        // a cloud drive's upload session expires on its own
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(id: &str, state: &str, at: u64) -> Saved {
        Saved { id: id.into(), kind: "download".into(), state: state.into(), saved: at, local: format!("/d/{id}.bin"), ..Default::default() }
    }

    #[test]
    fn a_restart_pauses_what_ran_and_gives_up_stale_ones() {
        let at = 10 * KEEP_FOR.as_secs();
        let list = vec![
            saved("run", "running", at - 60),
            saved("fail", "error", at - 60),
            saved("old", "paused", at - KEEP_FOR.as_secs() - 1),
            Saved { id: "odd".into(), kind: "sync".into(), saved: at, ..Default::default() },
        ];
        let (keep, stale) = read_back(list, at);
        assert_eq!(keep["run"].state, "paused", "running when the app ended: paused now");
        assert_eq!(keep["fail"].state, "error", "failed stays failed (Retry carries on)");
        assert!(!keep.contains_key("odd"));
        assert_eq!(stale.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["old"]);
    }

    #[test]
    fn records_read_back_and_name_what_they_keep() {
        let up = Saved {
            id: "u".into(),
            kind: "upload".into(),
            stamp: Some((100, Some(5))),
            upload: Some(ResumeState { upload_id: "abc".into(), part_size: 16, parts: vec![] }),
            ..Default::default()
        };
        let back: Vec<Saved> = serde_json::from_slice(&serde_json::to_vec(&vec![up.clone()]).unwrap()).unwrap();
        assert_eq!(back, vec![up.clone()]);
        // older or partial files still read
        let partial: Saved = serde_json::from_str(r#"{"id":"x","kind":"upload"}"#).unwrap();
        assert_eq!(partial.state, "");
        with(|r| {
            r.insert("u".into(), up);
            r.insert("d".into(), saved("d", "paused", 1));
        });
        assert!(keeps_upload("abc") && !keeps_upload("other"));
        assert!(keeps_partial(Path::new("/d/d.bin.s3part")));
        assert!(!keeps_partial(Path::new("/d/e.bin.s3part")));
        with(|r| {
            r.remove("u");
            r.remove("d");
        });
    }
}
