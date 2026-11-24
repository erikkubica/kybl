//! The synced folders the user set up (`sync.json` in the app's config folder).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::state::err;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// back the local folder up
    Upload,
    /// keep a local mirror of the remote folder
    Download,
    /// changes on either side go to the other
    Twoway,
}

fn default_interval() -> u32 {
    5
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncMapping {
    #[serde(default)]
    pub id: String,
    pub profile_id: String,
    /// the bucket, or the root of other connections ("" for single-root ones like SFTP)
    #[serde(default)]
    pub bucket: String,
    /// remote folder: "" for the bucket root, otherwise ends with "/"
    #[serde(default)]
    pub prefix: String,
    pub local_path: String,
    pub direction: Direction,
    /// gitignore-style patterns
    #[serde(default)]
    pub ignore: Vec<String>,
    /// one-way: propagate deletions (upload: delete remotely; download: move local files to the
    /// Trash). Two-way always propagates them, behind the guard.
    #[serde(default)]
    pub mirror_deletes: bool,
    /// minutes between full comparisons with the other side
    #[serde(default = "default_interval")]
    pub interval_mins: u32,
    #[serde(default)]
    pub paused: bool,
    /// remote deletions go to `<prefix>.kybl-trash/<date>/` on stores without a trash of their
    /// own. Unset: on for two-way, off for one-way (as it always was).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_trash: Option<bool>,
    /// stop and ask before deleting more than max(50, 20%) of the files at once
    #[serde(default = "yes")]
    pub delete_guard: bool,
}

impl SyncMapping {
    pub fn remote_trash(&self) -> bool {
        self.remote_trash.unwrap_or(self.direction == Direction::Twoway)
    }

    /// Two mappings with the same answer sync the same two places, so what one learned about the
    /// files is valid for the other.
    pub fn places(&self) -> (&str, &str, &str, &str) {
        (&self.local_path, &self.profile_id, &self.bucket, &self.prefix)
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    #[serde(default)]
    pub paused_all: bool,
    #[serde(default)]
    pub mappings: Vec<SyncMapping>,
}

pub fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("sync.json"))
}

pub fn load_config<R: Runtime>(app: &AppHandle<R>) -> SyncConfig {
    let v = config_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok());
    config_from(v.as_ref())
}

/// The sync folders in `sync.json`, one by one: one this version can't read (a newer Kybl's
/// setting) is left out here and kept by the next save, not the whole list (B5-4).
fn config_from(v: Option<&serde_json::Value>) -> SyncConfig {
    SyncConfig {
        paused_all: v.and_then(|v| v.get("pausedAll")).and_then(|p| p.as_bool()).unwrap_or(false),
        mappings: crate::state::parse_list(v.and_then(|v| v.get("mappings"))),
    }
}

/// What `sync.json` becomes: `cfg`, plus the sync folders of `old` this version can't read.
fn config_to_save(old: Option<&serde_json::Value>, cfg: &SyncConfig) -> Result<serde_json::Value, String> {
    let mut v = serde_json::to_value(cfg).map_err(err)?;
    let mine = v.get("mappings").and_then(|m| m.as_array()).cloned().unwrap_or_default();
    v["mappings"] = serde_json::Value::Array(crate::state::keep_unreadable::<SyncMapping>(old.and_then(|o| o.get("mappings")), mine));
    Ok(v)
}

/// Written through a temporary file of its own and a rename (`state::write_atomic`): a crash,
/// or a second Kybl saving at the same moment, never leaves half a file that would read as no
/// sync folders at all.
pub fn save_config<R: Runtime>(app: &AppHandle<R>, cfg: &SyncConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let old = crate::state::json_before_save(&path)?;
    let raw = serde_json::to_vec_pretty(&config_to_save(old.as_ref(), cfg)?).map_err(err)?;
    crate::state::write_atomic(&path, &raw).map_err(err)
}

pub fn norm_prefix(p: &str) -> String {
    let t = p.trim().trim_matches('/');
    if t.is_empty() { String::new() } else { format!("{t}/") }
}

/// True when one folder is the other or inside it. Both are compared as the runs will see them
/// (`sync_root`: links resolved), because two paths that look unrelated can be the same tree
/// through a link (`~/Dropbox` and `~/Library/CloudStorage/Dropbox/Docs`). A folder that doesn't
/// exist yet can't be resolved, so it is compared as typed.
pub fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (super::local::sync_root(a), super::local::sync_root(b));
    // Windows paths differ only in case at times (`C:\Docs` and `c:\docs\Sub`): the same tree
    #[cfg(windows)]
    let (a, b) = (std::path::PathBuf::from(a.to_string_lossy().to_lowercase()), std::path::PathBuf::from(b.to_string_lossy().to_lowercase()));
    a.starts_with(&b) || b.starts_with(&a)
}

/// The other saved folder that `m` newly overlaps. An edit that leaves the folder as it was
/// (a new interval, ignore list or direction) is never refused for an overlap that was already
/// there: the user picked no folder, and both pairs keep running as before.
pub fn new_overlap<'a>(mappings: &'a [SyncMapping], m: &SyncMapping) -> Option<&'a SyncMapping> {
    if !m.id.is_empty() && mappings.iter().any(|o| o.id == m.id && o.local_path == m.local_path) {
        return None;
    }
    mappings.iter().find(|o| o.id != m.id && overlaps(&o.local_path, &m.local_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two folders that are nested only through a link still overlap (B4-4).
    #[cfg(unix)]
    #[test]
    fn folders_nested_through_a_link_overlap() {
        let dir = std::env::temp_dir().join(format!("kybl-overlap-{}", uuid::Uuid::new_v4()));
        let real = dir.join("real");
        std::fs::create_dir_all(real.join("docs")).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (a, b) = (link.to_string_lossy().to_string(), real.join("docs").to_string_lossy().to_string());
        assert!(overlaps(&a, &b));
        assert!(overlaps(&b, &a));
        assert!(!overlaps(&dir.join("other").to_string_lossy(), &a), "a folder that doesn't exist yet");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sync folder this version can't read (a direction a newer Kybl added) doesn't empty the
    /// list, and the next save keeps it (B5-4).
    #[test]
    fn sync_folders_a_newer_kybl_wrote_survive_a_save() {
        let file = serde_json::json!({"pausedAll": true, "mappings": [
            {"id":"a","profileId":"p","bucket":"b","prefix":"","localPath":"/x","direction":"upload"},
            {"id":"n","profileId":"p","bucket":"b","prefix":"","localPath":"/y","direction":"mirror-later"}
        ]});
        let cfg = config_from(Some(&file));
        assert!(cfg.paused_all);
        assert_eq!(cfg.mappings.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a"]);
        let saved = config_to_save(Some(&file), &SyncConfig { paused_all: false, mappings: vec![] }).unwrap();
        let ids: Vec<&str> = saved["mappings"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["n"], "the removed one goes, the unreadable one stays");
        // damaged on disk: set aside before it is replaced, never read as empty and overwritten
        let dir = std::env::temp_dir().join(format!("kybl-sync-bad-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("sync.json");
        std::fs::write(&p, b"{\"mappings\": [").unwrap();
        assert_eq!(crate::state::json_before_save(&p).unwrap(), None);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "a copy is kept");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn old_mappings_load_with_the_new_defaults() {
        let m: SyncMapping = serde_json::from_str(r#"{"id":"a","profileId":"p","bucket":"b","prefix":"","localPath":"/x","direction":"upload"}"#).unwrap();
        assert!(!m.remote_trash(), "one-way keeps deleting as it always did");
        assert!(m.delete_guard);
        assert_eq!(m.interval_mins, 5);
        let t: SyncMapping = serde_json::from_str(r#"{"profileId":"p","localPath":"/x","direction":"twoway"}"#).unwrap();
        assert_eq!(t.direction, Direction::Twoway);
        assert!(t.remote_trash(), "on by default for two-way");
        assert_eq!(t.bucket, "");
        let v = serde_json::to_value(&t).unwrap();
        assert!(v.get("remoteTrash").is_none());
        assert_eq!(v["deleteGuard"], true);
    }
}
