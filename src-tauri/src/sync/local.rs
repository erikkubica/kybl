//! The local side of a sync: scanning the folder (with file ids, so renames can be told from a
//! delete plus a create), the watcher, the Trash, and the names of conflict copies.

use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use md5::{Digest, Md5};
use notify::RecommendedWatcher;
use notify_debouncer_full::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer, RecommendedCache};
use tokio::sync::mpsc;

use super::plan::{nfc, BaseState, LocalMeta};

/// Patterns that are always ignored: partial downloads, one-way sync's scratch files, files the
/// local backend is still writing, and the remote trash folder.
pub const ALWAYS_IGNORED: [&str; 4] = ["*.s3part", ".s3sync-*", ".*.kybl-*", "/.kybl-trash/"];

/// The folder deleted files are moved to on stores without a trash of their own.
pub const REMOTE_TRASH: &str = ".kybl-trash";

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The file's identity on its disk: device and inode on macOS and Linux. Windows has no stable
/// id through std, so renames there are matched by size and time.
pub fn file_id(meta: &std::fs::Metadata) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!("{}:{}", meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

pub fn local_meta(meta: &std::fs::Metadata) -> LocalMeta {
    LocalMeta { size: meta.len(), mtime: mtime_ms(meta), file_id: file_id(meta), md5: None }
}

pub fn build_ignore(root: &Path, lines: &[String]) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    for l in lines {
        let l = l.trim();
        if !l.is_empty() && !l.starts_with('#') {
            let _ = b.add_line(None, l);
        }
    }
    for l in ALWAYS_IGNORED {
        let _ = b.add_line(None, l);
    }
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

pub fn is_ignored(gi: &Gitignore, rel: &str) -> bool {
    gi.matched_path_or_any_parents(Path::new(rel), false).is_ignore()
}

/// Rejects keys that would escape the local folder or can't be a file name.
pub fn safe_rel(rel: &str) -> bool {
    !rel.is_empty() && !rel.contains('\0') && !rel.contains('\\') && rel.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

fn rel_key(p: &Path) -> String {
    p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

pub fn local_path_of(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// The local folder: files keyed by NFC path, plus the real names that differ from those keys.
#[derive(Default, Debug)]
pub struct LocalSnapshot {
    pub files: HashMap<String, LocalMeta>,
    /// NFC key -> the name on disk, where they differ (macOS decomposed names)
    pub raw: HashMap<String, String>,
    /// names that collide once normalised (only possible on Linux); left out
    pub dupes: Vec<String>,
}

impl LocalSnapshot {
    /// The file on disk behind a key.
    pub fn path(&self, root: &Path, key: &str) -> PathBuf {
        local_path_of(root, self.raw.get(key).map(String::as_str).unwrap_or(key))
    }

    fn insert(&mut self, rel: String, meta: LocalMeta) {
        let key = nfc(&rel);
        if self.files.contains_key(&key) {
            self.files.remove(&key);
            self.dupes.push(rel);
            return;
        }
        if key != rel {
            self.raw.insert(key.clone(), rel);
        }
        self.files.insert(key, meta);
    }
}

/// Every file below `root` that isn't ignored.
pub fn scan_local(root: &Path, gi: &Gitignore) -> LocalSnapshot {
    let mut out = LocalSnapshot::default();
    scan_into(root, root, gi, &mut out);
    out
}

/// Adds the files below `start` (inside `root`) to `out`, keyed relative to `root`.
fn scan_into(root: &Path, start: &Path, gi: &Gitignore, out: &mut LocalSnapshot) {
    let walker = walkdir::WalkDir::new(start).follow_links(false).into_iter().filter_entry(|e| {
        if e.path() == root {
            return true;
        }
        match e.path().strip_prefix(root) {
            Ok(rel) => !gi.matched_path_or_any_parents(rel, e.file_type().is_dir()).is_ignore(),
            Err(_) => false,
        }
    });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let rel = rel_key(rel);
        if safe_rel(&rel) {
            out.insert(rel, local_meta(&meta));
        }
    }
}

/// A quick look at only what the watcher saw change: the base's view of the folder, with each
/// changed path (and everything under a changed folder) looked at again.
pub fn rescan_dirty(root: &Path, gi: &Gitignore, base: &dyn BaseState, dirty: &HashSet<PathBuf>) -> LocalSnapshot {
    let mut out = LocalSnapshot::default();
    for p in base.paths() {
        if let Some(b) = base.entry(p) {
            out.files.insert(p.to_string(), LocalMeta { size: b.l_size, mtime: b.l_mtime, file_id: b.l_fileid.clone(), md5: None });
        }
    }
    for d in dirty {
        let Ok(rel) = d.strip_prefix(root) else { continue };
        let rel = nfc(&rel_key(rel));
        if rel.is_empty() {
            // the folder itself changed: no shortcut
            return scan_local(root, gi);
        }
        // whatever was there before is looked at again
        let below = format!("{rel}/");
        out.files.retain(|k, _| *k != rel && !k.starts_with(&below));
        if is_ignored(gi, &rel) {
            continue;
        }
        match std::fs::symlink_metadata(d) {
            Ok(m) if m.is_dir() => scan_into(root, d, gi, &mut out),
            Ok(m) if m.is_file() && safe_rel(&rel) => out.insert(rel_key(d.strip_prefix(root).unwrap_or(d)), local_meta(&m)),
            _ => {}
        }
    }
    out
}

/// The MD5 of a file, hex.
pub fn md5_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Md5::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Sets a file's modification time (after a download: the remote file's time).
pub fn set_mtime(path: &Path, ms: i64) {
    if ms > 0 {
        let t = filetime::FileTime::from_unix_time(ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32);
        let _ = filetime::set_file_mtime(path, t);
    }
}

/// True when the disk under `root` treats names that differ only in capitals as one.
pub fn case_insensitive(root: &Path) -> bool {
    let probe = root.join(format!(".kybl-case-{}", uuid::Uuid::new_v4().simple()));
    if std::fs::write(&probe, b"").is_err() {
        return cfg!(any(target_os = "macos", windows));
    }
    let upper = root.join(probe.file_name().unwrap().to_string_lossy().to_uppercase());
    let insensitive = upper.exists();
    let _ = std::fs::remove_file(&probe);
    insensitive
}

/// Moves local files to the system Trash (or deletes them, `trash` false: tests).
pub fn remove_local(paths: &[PathBuf], trash: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    if trash {
        return trash::delete_all(paths).map_err(|e| format!("Could not move removed files to the Trash: {e}"));
    }
    for p in paths {
        match std::fs::remove_file(p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

/// Removes folders left empty by deletions, from `dir` up to (not including) `root`.
pub fn prune_empty(root: &Path, mut dir: PathBuf) {
    while dir != root && dir.starts_with(root) {
        let Ok(mut rd) = std::fs::read_dir(&dir) else { return };
        // a folder with only Finder's clutter in it counts as empty
        let only_clutter = rd.all(|e| e.is_ok_and(|e| e.file_name() == ".DS_Store"));
        if !only_clutter {
            return;
        }
        let _ = std::fs::remove_file(dir.join(".DS_Store"));
        if std::fs::remove_dir(&dir).is_err() {
            return;
        }
        if !dir.pop() {
            return;
        }
    }
}

/// One-way download's conflict copy: "photo.jpg" -> "photo (local copy).jpg", numbered if taken.
pub fn local_copy_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    (1..)
        .map(|n| {
            let label = if n == 1 { "local copy".to_string() } else { format!("local copy {n}") };
            dir.join(format!("{stem} ({label}){ext}"))
        })
        .find(|c| !c.exists())
        .expect("some number is free")
}

/// This computer's name as people know it, for conflict copies ("MacBook Pro").
pub fn device_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(target_os = "macos")]
        let raw = std::process::Command::new("scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        #[cfg(windows)]
        let raw = std::env::var("COMPUTERNAME").unwrap_or_default();
        #[cfg(not(any(target_os = "macos", windows)))]
        let raw = std::fs::read_to_string("/etc/hostname").map(|s| s.trim().to_string()).unwrap_or_default();
        // nothing a file name can't hold
        let clean: String = raw.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()).collect();
        let clean = clean.trim().trim_end_matches(".local").to_string();
        clean.chars().take(40).collect()
    })
    .clone()
}

/// A date as YYYY-MM-DD (UTC), for conflict copies and the remote trash.
pub fn ymd(ms: i64) -> String {
    // days since 1970-01-01 to a civil date (Howard Hinnant's algorithm)
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

// ---------------------------------------------------------------- watcher

/// What the watcher saw since the last run: changed paths, or "too much, look at everything".
#[derive(Default)]
pub struct Dirty {
    pub paths: HashSet<PathBuf>,
    pub overflow: bool,
}

/// More changed paths than this and a run just scans the whole folder.
const DIRTY_MAX: usize = 2000;

impl Dirty {
    /// Takes what was collected: Some(paths) for a quick rescan, None for a full scan.
    pub fn take(&mut self) -> Option<HashSet<PathBuf>> {
        let paths = std::mem::take(&mut self.paths);
        let overflow = std::mem::replace(&mut self.overflow, false);
        (!overflow && !paths.is_empty()).then_some(paths)
    }
}

pub type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Watches `path`; each settled burst of changes is added to `dirty` and announced on `tx`.
pub fn make_watcher(path: &str, tx: mpsc::Sender<bool>, dirty: Arc<Mutex<Dirty>>) -> Option<Watcher> {
    let mut d = new_debouncer(Duration::from_secs(2), None, move |res: DebounceEventResult| {
        let Ok(events) = res else {
            dirty.lock().unwrap().overflow = true;
            let _ = tx.try_send(false);
            return;
        };
        let mut relevant = false;
        {
            let mut dt = dirty.lock().unwrap();
            for e in events.iter().filter(|e| !e.kind.is_access()) {
                if e.need_rescan() || e.paths.is_empty() {
                    dt.overflow = true;
                    relevant = true;
                }
                for p in &e.paths {
                    let name = p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
                    if name.ends_with(".s3part") || name == ".DS_Store" || name.starts_with(".kybl-case-") {
                        continue;
                    }
                    relevant = true;
                    if dt.paths.len() < DIRTY_MAX {
                        dt.paths.insert(p.clone());
                    } else {
                        dt.overflow = true;
                    }
                }
            }
        }
        if relevant {
            let _ = tx.try_send(false);
        }
    })
    .ok()?;
    d.watch(Path::new(path), RecursiveMode::Recursive).ok()?;
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::plan::BaseEntry;

    #[test]
    fn dates_and_names() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_795_305_600_000), "2026-11-22");
        assert_eq!(ymd(951_782_400_000), "2000-02-29");
        assert!(!device_name().contains('/'));
    }

    #[test]
    fn scans_with_ids_and_rescans_only_what_changed() {
        let root = std::env::temp_dir().join(format!("kybl-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("sub/cafe\u{301}.txt"), "b").unwrap();
        std::fs::write(root.join("x.s3part"), "partial").unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let gi = build_ignore(&root, &[]);
        let snap = scan_local(&root, &gi);
        assert_eq!(snap.files.len(), 2);
        let key = "sub/caf\u{e9}.txt";
        assert!(snap.files.contains_key(key));
        assert!(snap.path(&root, key).exists(), "the real (decomposed) name is kept for I/O");
        #[cfg(unix)]
        assert!(snap.files["a.txt"].file_id.is_some());

        let base: HashMap<String, BaseEntry> = snap.files.iter().map(|(k, l)| (k.clone(), BaseEntry { l_size: l.size, l_mtime: l.mtime, l_fileid: l.file_id.clone(), ..Default::default() })).collect();
        std::fs::write(root.join("sub/new.txt"), "new").unwrap();
        std::fs::remove_file(root.join("a.txt")).unwrap();
        let dirty = HashSet::from([root.join("sub/new.txt"), root.join("a.txt")]);
        let quick = rescan_dirty(&root, &gi, &base, &dirty);
        let mut keys: Vec<_> = quick.files.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec![key.to_string(), "sub/new.txt".to_string()]);
        // a changed folder is looked at whole
        let quick = rescan_dirty(&root, &gi, &base, &HashSet::from([root.join("sub")]));
        assert_eq!(quick.files.len(), 3, "a.txt wasn't seen changing: it stays as the base knows it");
        assert!(quick.files.contains_key("sub/new.txt"));

        std::fs::create_dir_all(root.join("e1/e2")).unwrap();
        prune_empty(&root, root.join("e1/e2"));
        assert!(!root.join("e1").exists());
        assert!(root.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn md5_and_times() {
        let p = std::env::temp_dir().join(format!("kybl-md5-{}", uuid::Uuid::new_v4()));
        std::fs::write(&p, "hello").unwrap();
        assert_eq!(md5_file(&p).unwrap(), "5d41402abc4b2a76b9719d911017c592");
        set_mtime(&p, 1_700_000_000_123);
        assert_eq!(mtime_ms(&std::fs::metadata(&p).unwrap()), 1_700_000_000_123);
        let _ = std::fs::remove_file(&p);
    }
}
