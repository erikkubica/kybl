//! The synced folders the user set up (`sync.json` in the app's config folder).

use std::path::{Path, PathBuf};

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
    config_path(app).ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// Written through a temporary file of its own and a rename (`state::write_atomic`): a crash,
/// or a second Kybl saving at the same moment, never leaves half a file that would read as no
/// sync folders at all.
pub fn save_config<R: Runtime>(app: &AppHandle<R>, cfg: &SyncConfig) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(cfg).map_err(err)?;
    crate::state::write_atomic(&config_path(app)?, &raw).map_err(err)
}

pub fn norm_prefix(p: &str) -> String {
    let t = p.trim().trim_matches('/');
    if t.is_empty() { String::new() } else { format!("{t}/") }
}

pub fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (Path::new(a), Path::new(b));
    a.starts_with(b) || b.starts_with(a)
}

#[cfg(test)]
mod tests {
    use super::*;

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
