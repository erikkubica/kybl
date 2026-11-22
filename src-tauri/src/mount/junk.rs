//! The clutter file managers leave on every drive they touch: macOS writes `._name` (AppleDouble:
//! extended attributes and resource forks) next to each file it copies, `.DS_Store` in every
//! folder it opens, and probes for Spotlight and Trash folders; Windows writes `Thumbs.db` and
//! `desktop.ini`.
//!
//! None of it should reach the user's storage, and asking the server for it costs a request per
//! file. So clutter never goes to the server: lookups answer "not there" at once, files Finder
//! insists on writing stay in memory for this session (Finder treats a refused `._` write as a
//! failed copy), and system folders can't be created. The same names already on the server are
//! hidden from listings.

use std::{collections::BTreeMap, sync::Mutex, time::SystemTime};

/// Files that never go to the server.
pub fn is_junk_file(name: &str) -> bool {
    name.starts_with("._")
        || matches!(
            name,
            ".DS_Store"
                | ".localized"
                | ".apdisk"
                | ".VolumeIcon.icns"
                | ".metadata_never_index"
                | ".metadata_never_index_unless_rootfs"
                | ".metadata_direct_scope_only"
                | ".com.apple.timemachine.donotpresent"
                | ".ql_disablethumbnails"
                | ".ql_disablecache"
                | "Icon\r"
                | "Thumbs.db"
                | "desktop.ini"
        )
}

/// System folders (Spotlight's index, the Trash, event logs) that can't be made on the drive.
pub fn is_junk_dir(name: &str) -> bool {
    matches!(
        name,
        ".Spotlight-V100"
            | ".Trashes"
            | ".Trash"
            | ".fseventsd"
            | ".TemporaryItems"
            | ".DocumentRevisions-V100"
            | ".PKInstallSandboxManager"
            | ".PKInstallSandboxManager-SystemSoftware"
            | "$RECYCLE.BIN"
            | "System Volume Information"
    )
}

/// Any part of `rel` (a path inside the drive) is clutter: hidden from the server either way.
pub fn is_junk_path(rel: &str) -> bool {
    let mut parts = rel.split('/').filter(|p| !p.is_empty()).peekable();
    while let Some(p) = parts.next() {
        if is_junk_dir(p) || (parts.peek().is_none() && is_junk_file(p)) {
            return true;
        }
    }
    false
}

/// The most clutter kept in memory per drive; past it, writes are accepted and dropped.
const LIMIT: usize = 16 * 1024 * 1024;

pub struct JunkFile {
    pub data: Vec<u8>,
    pub modified: SystemTime,
}

/// This session's clutter files, by path inside the drive.
#[derive(Default)]
pub struct JunkStore {
    files: Mutex<BTreeMap<String, JunkFile>>,
}

impl JunkStore {
    pub fn get(&self, rel: &str) -> Option<(u64, SystemTime)> {
        self.files.lock().unwrap().get(rel).map(|f| (f.data.len() as u64, f.modified))
    }

    pub fn read(&self, rel: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(rel).map(|f| f.data.clone())
    }

    pub fn put(&self, rel: &str, data: Vec<u8>) {
        let mut files = self.files.lock().unwrap();
        let used: usize = files.iter().filter(|(k, _)| k.as_str() != rel).map(|(_, f)| f.data.len()).sum();
        let data = if used + data.len() > LIMIT { Vec::new() } else { data };
        files.insert(rel.to_string(), JunkFile { data, modified: SystemTime::now() });
    }

    pub fn remove(&self, rel: &str) -> bool {
        self.files.lock().unwrap().remove(rel).is_some()
    }

    pub fn rename(&self, from: &str, to: &str) -> bool {
        let mut files = self.files.lock().unwrap();
        match files.remove(from) {
            Some(f) => {
                files.insert(to.to_string(), f);
                true
            }
            None => false,
        }
    }

    /// Names of the clutter files directly inside the folder `dir` ("" for the top).
    pub fn in_dir(&self, dir: &str) -> Vec<(String, u64, SystemTime)> {
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        self.files
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(k, f)| {
                let rest = k.strip_prefix(&prefix)?;
                (!rest.is_empty() && !rest.contains('/')).then(|| (rest.to_string(), f.data.len() as u64, f.modified))
            })
            .collect()
    }

    /// The folder `dir` and everything in it went away.
    pub fn remove_under(&self, dir: &str) {
        let prefix = format!("{dir}/");
        self.files.lock().unwrap().retain(|k, _| !k.starts_with(&prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finder_and_windows_clutter_is_recognised() {
        for p in ["._photo.jpg", ".DS_Store", "a/b/._x", "a/.DS_Store", ".Spotlight-V100", ".Trashes/501", "x/.fseventsd/y", "Thumbs.db"] {
            assert!(is_junk_path(p), "{p}");
        }
        for p in ["photo.jpg", ".env", ".gitignore", "a/b/c.txt", "_draft.md", "notes/.hidden-but-real"] {
            assert!(!is_junk_path(p), "{p}");
        }
        // a clutter *file* name is only clutter as the last part
        assert!(!is_junk_path(".DS_Store/inside.txt"));
    }

    #[test]
    fn the_store_lists_by_folder_and_caps_its_size() {
        let s = JunkStore::default();
        s.put("._a", vec![1; 10]);
        s.put("d/._b", vec![2; 5]);
        s.put("d/e/._c", vec![3; 5]);
        assert_eq!(s.in_dir("").iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["._a"]);
        assert_eq!(s.in_dir("d").iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["._b"]);
        assert!(s.rename("d/._b", "d/._z"));
        assert_eq!(s.read("d/._z").unwrap(), vec![2; 5]);
        s.remove_under("d");
        assert!(s.get("d/e/._c").is_none());
        s.put("big", vec![0; LIMIT + 1]);
        assert_eq!(s.get("big").unwrap().0, 0, "past the cap the data is dropped");
    }
}
