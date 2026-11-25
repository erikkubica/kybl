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
/// local backend is still writing, an FTP upload's visible temporary name (`name.kybl-<12 hex>.ext`,
/// `kybl-<12 hex>.name`) and the remote trash folder.
pub const ALWAYS_IGNORED: [&str; 6] = ["*.s3part", ".s3sync-*", ".*.kybl-*", "*.kybl-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*", "kybl-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*", "/.kybl-trash/"];

/// The folder deleted files are moved to on stores without a trash of their own.
pub const REMOTE_TRASH: &str = ".kybl-trash";

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// (in dest.rs, which the phone build has too)
pub use crate::dest::mtime_ms;

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
    safe_rel_on(rel, cfg!(windows))
}

/// [`safe_rel`] for Windows or elsewhere. On Windows a name with `:` is a drive (`C:` replaces the
/// folder it is joined to) or an alternate stream, and a device name (`NUL`, `COM1.txt`) isn't a
/// file, and a name ending in a dot or space is trimmed to another file's name (`a.txt.` would
/// land on `a.txt`): none of them may come from a remote key (see [`crate::dest::windows_unfit`]).
fn safe_rel_on(rel: &str, windows: bool) -> bool {
    !rel.is_empty()
        && !rel.contains('\0')
        && !rel.contains('\\')
        && rel.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !(windows && (p.contains(':') || crate::dest::windows_unfit(p))))
}

/// `a` and `b` name one file only by letter case: the same file on a disk that ignores case (so
/// renaming one to the other just changes its capitals). Two names of one file that differ by
/// more (hard links) don't count.
pub fn same_entry(a: &Path, b: &Path) -> bool {
    if a.to_string_lossy().to_lowercase() != b.to_string_lossy().to_lowercase() {
        return false;
    }
    match (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                x.dev() == y.dev() && x.ino() == y.ino()
            }
            #[cfg(not(unix))]
            {
                let _ = (x, y);
                matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(p), Ok(q)) if p == q)
            }
        }
        _ => false,
    }
}

fn rel_key(p: &Path) -> String {
    p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

/// A link (or, on Windows, a junction) between `root` and `path`: a
/// folder of the path, below the root, that leads somewhere else. Writing, renaming or deleting
/// through it would act outside the synced folder, so sync refuses. A path outside the root
/// counts as one. Folders that aren't there yet are fine (they are made as plain folders).
pub fn link_on_the_way(root: &Path, path: &Path) -> Option<PathBuf> {
    // the file itself is replaced by a rename, never written through
    crate::local_links::link_between(root, path, false)
}

/// [`link_on_the_way`] as an error to show for that file.
pub fn no_link_on_the_way(root: &Path, path: &Path) -> Result<(), String> {
    match link_on_the_way(root, path) {
        None => Ok(()),
        Some(link) => Err(format!(
            "{} is a link to another place, and Kybl doesn't sync through links, so this file was left alone.",
            link.strip_prefix(root).map(|r| r.display().to_string()).unwrap_or_else(|_| link.display().to_string())
        )),
    }
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
    /// NFC keys that more than one name on disk normalises to (only possible on Linux): all of
    /// them are left out, and the run leaves the path alone on both sides
    pub dupes: Vec<String>,
    /// paths (NFC, relative; "" for the folder itself) that couldn't be read: whatever is below
    /// them is unknown, not deleted
    pub unreadable: Vec<String>,
    /// links (and, on Windows, junctions) in the folder (NFC, relative): never followed, and
    /// left alone, so a synced folder replaced by a link isn't taken for deleted
    pub links: Vec<String>,
    /// a quick look ([`rescan_dirty`]): only the watched changes were looked at, so `links` holds
    /// those, plus the links found above the base's paths; paths only the other side knows are
    /// checked by the run ([`links_above`])
    pub partial: bool,
}

impl LocalSnapshot {
    /// The file on disk behind a key.
    pub fn path(&self, root: &Path, key: &str) -> PathBuf {
        local_path_of(root, self.raw.get(key).map(String::as_str).unwrap_or(key))
    }

    fn insert(&mut self, rel: String, meta: LocalMeta) {
        let key = nfc(&rel);
        if self.dupes.contains(&key) {
            return;
        }
        if self.files.contains_key(&key) {
            self.files.remove(&key);
            self.raw.remove(&key);
            self.dupes.push(key);
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
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            // a folder that can't be listed (or a file that can't be looked at): what is below
            // it is unknown, never gone
            Err(e) => {
                let rel = e.path().and_then(|p| p.strip_prefix(root).ok()).map(rel_key).unwrap_or_default();
                out.unreadable.push(nfc(&rel));
                continue;
            }
        };
        if entry.path_is_symlink() && entry.path() != root {
            if let Ok(rel) = entry.path().strip_prefix(root) {
                out.links.push(nfc(&rel_key(rel)));
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let rel = rel_key(rel);
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(e) if e.io_error().is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) => continue,
            Err(_) => {
                out.unreadable.push(nfc(&rel));
                continue;
            }
        };
        if safe_rel(&rel) {
            out.insert(rel, local_meta(&meta));
        }
    }
}

/// A quick look at only what the watcher saw change: the base's view of the folder, with each
/// changed path (and everything under a changed folder) looked at again.
pub fn rescan_dirty(root: &Path, gi: &Gitignore, base: &dyn BaseState, dirty: &HashSet<PathBuf>) -> LocalSnapshot {
    let mut out = LocalSnapshot { partial: true, ..Default::default() };
    for p in base.paths() {
        if let Some(b) = base.entry(p) {
            out.files.insert(p.to_string(), LocalMeta { size: b.l_size, mtime: b.l_mtime, file_id: b.l_fileid.clone(), md5: None });
        }
    }
    // a link that replaced a synced folder (or file) earlier isn't among the watched changes:
    // found here, it is left alone as a full scan leaves it (B4-1), instead of the other side's
    // changes under it failing the run. Folders only: a file replaced by a link is a watched
    // change (looked at below), and an `lstat` per synced file would make every quick run walk
    // the whole folder (B4-2, round 5)
    out.links = links_above(root, out.files.keys().map(String::as_str), false, &mut HashMap::new());
    for d in dirty {
        // a change reported somewhere else than expected (the folder reached another way): a
        // full look, never a change silently dropped (B4-4, round 5)
        let Ok(rel) = d.strip_prefix(root) else { return scan_local(root, gi) };
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
            Ok(m) if m.file_type().is_symlink() => out.links.push(rel),
            Ok(m) if m.is_dir() => scan_into(root, d, gi, &mut out),
            Ok(m) if m.is_file() && safe_rel(&rel) => out.insert(rel_key(d.strip_prefix(root).unwrap_or(d)), local_meta(&m)),
            Ok(_) => {}
            // only "not there" means gone; anything else (no permission, an I/O error) leaves
            // the path alone this run
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => out.unreadable.push(rel),
        }
    }
    out
}

/// The links on the way to `rels` (relative keys under `root`; with `last`, the path itself
/// included), each reported once as the link's own key; what is below a link isn't looked at.
/// `seen` remembers the folders already looked at (one `lstat` per folder, however many files
/// share it).
pub fn links_above<'a>(root: &Path, rels: impl IntoIterator<Item = &'a str>, last: bool, seen: &mut HashMap<String, bool>) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    for rel in rels {
        let mut end = 0;
        while end < rel.len() {
            end = rel[end..].find('/').map_or(rel.len(), |i| end + i);
            if !last && end >= rel.len() {
                break;
            }
            let part = &rel[..end];
            end += 1;
            let link = match seen.get(part) {
                Some(&l) => l,
                None => {
                    let l = std::fs::symlink_metadata(local_path_of(root, part)).is_ok_and(|m| m.file_type().is_symlink());
                    seen.insert(part.to_string(), l);
                    l
                }
            };
            if link {
                out.insert(part.to_string());
                break;
            }
        }
    }
    out.into_iter().collect()
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

/// The synced folder as the runs and the watcher use it. On macOS the watcher reports real paths
/// (links in the folder's own path resolved: `~/Dropbox -> ~/Library/CloudStorage/…`, `/tmp`), so
/// the runs work from the same real path, or no change it reports would be under the folder
/// (B4-4, round 5). Windows keeps the path as picked: its real form (`\\?\C:\…`) is not what
/// the watcher reports.
pub fn sync_root(path: &str) -> PathBuf {
    #[cfg(not(windows))]
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    PathBuf::from(path)
}

/// Watches `path`; each settled burst of changes is added to `dirty` and announced on `tx`.
pub fn make_watcher(path: &Path, tx: mpsc::Sender<bool>, dirty: Arc<Mutex<Dirty>>) -> Option<Watcher> {
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
    d.watch(path, RecursiveMode::Recursive).ok()?;
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::plan::BaseEntry;

    #[test]
    fn remote_keys_that_would_leave_the_folder_on_windows_are_refused() {
        for bad in ["C:/Users/x/evil.txt", "a/C:", "a/b:c.txt", "NUL", "dir/com1.txt", "Lpt9", "aux.tar.gz", "CON ", "budget.xlsx.", "budget.xlsx ", "dir./a.txt", "dir /a.txt"] {
            assert!(!safe_rel_on(bad, true), "{bad:?}");
        }
        for ok in ["a/b.txt", "console.txt", "com.txt", "COM10", "nul-ish/x", "LPTX"] {
            assert!(safe_rel_on(ok, true), "{ok:?}");
        }
        // elsewhere a colon is an ordinary character
        assert!(safe_rel_on("12:30 notes.txt", false) && safe_rel_on("NUL", false) && safe_rel_on("a.txt.", false));
        assert!(safe_rel_on(".env", true) && safe_rel_on("a..b/.git/x", true));
        for bad in ["", "../x", "a//b", "a\\b", "./a"] {
            assert!(!safe_rel_on(bad, false) && !safe_rel_on(bad, true), "{bad:?}");
        }
    }

    /// B4-1 (round 4): a quick look finds a link that replaced a synced folder earlier (not among
    /// the watched changes), and paths only the other side knows are checked the same way.
    /// Temporary names of uploads in progress (hidden, and FTP's visible ones) are never synced;
    /// a user's own file that merely has "kybl" in its name is.
    #[test]
    fn upload_temporary_names_are_ignored() {
        let gi = build_ignore(Path::new("/r"), &[]);
        for t in ["a/.report.pdf.kybl-0123", "a/report.kybl-0123456789ab.pdf", "notes.kybl-0123456789ab", "a/kybl-0123456789ab.env", "x.s3part"] {
            assert!(is_ignored(&gi, t), "{t}");
        }
        for t in ["report.kybl-draft.pdf", "kybl-notes.txt", "kybl.txt"] {
            assert!(!is_ignored(&gi, t), "{t}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn quick_looks_find_links_that_were_already_there() {
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("kybl-links-{}", uuid::Uuid::new_v4()));
        let away = root.with_extension("away");
        std::fs::create_dir_all(away.join("docs")).unwrap();
        std::fs::create_dir_all(root.join("plain")).unwrap();
        std::fs::write(root.join("top.txt"), "t").unwrap();
        std::os::unix::fs::symlink(away.join("docs"), root.join("docs")).unwrap();
        let gi = build_ignore(&root, &[]);
        let base: HashMap<String, BaseEntry> = ["docs/a.txt", "docs/sub/b.txt", "top.txt", "plain/c.txt"].iter().map(|k| (k.to_string(), BaseEntry::default())).collect();
        let quick = rescan_dirty(&root, &gi, &base, &HashSet::from([root.join("top.txt")]));
        assert!(quick.partial);
        assert_eq!(quick.links, vec!["docs".to_string()]);
        let mut seen = HashMap::new();
        assert_eq!(links_above(&root, ["docs/new.txt", "plain/new.txt", "new/x.txt"], true, &mut seen), vec!["docs".to_string()]);
        // B4-2 (round 5): folders only, when asked: files are never looked at one by one
        std::os::unix::fs::symlink(root.join("top.txt"), root.join("plain/l.txt")).unwrap();
        let mut seen = HashMap::new();
        assert!(links_above(&root, ["plain/l.txt", "top.txt"], false, &mut seen).is_empty());
        assert_eq!(seen.keys().map(String::as_str).collect::<Vec<_>>(), vec!["plain"], "one lstat, for the folder");
        assert_eq!(links_above(&root, ["plain/l.txt"], true, &mut HashMap::new()), vec!["plain/l.txt".to_string()]);
        // B4-4 (round 5): the folder reached through a link in its own path; a change reported
        // under the real path is still seen, and a change elsewhere means a full look
        let via = root.with_extension("via");
        std::os::unix::fs::symlink(&root, &via).unwrap();
        assert_eq!(sync_root(&via.to_string_lossy()), root);
        std::fs::write(root.join("plain/new.txt"), "n").unwrap();
        let quick = rescan_dirty(&via, &gi, &base, &HashSet::from([root.join("plain/new.txt")]));
        assert!(quick.files.contains_key("plain/new.txt") && !quick.partial, "a full look, not a change dropped");
        let _ = std::fs::remove_file(&via);
        assert!(!scan_local(&root, &gi).partial);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&away);
    }

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

    #[cfg(unix)]
    #[test]
    fn what_cant_be_read_is_reported_not_taken_for_gone() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("kybl-unread-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("locked")).unwrap();
        std::fs::write(root.join("locked/a.txt"), "a").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        let gi = build_ignore(&root, &[]);
        let base: HashMap<String, BaseEntry> = scan_local(&root, &gi).files.iter().map(|(k, l)| (k.clone(), BaseEntry { l_size: l.size, l_mtime: l.mtime, ..Default::default() })).collect();
        let mode = |m: u32| std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(m)).unwrap();
        mode(0o000);
        let full = scan_local(&root, &gi);
        let quick = rescan_dirty(&root, &gi, &base, &HashSet::from([root.join("locked/a.txt"), root.join("gone.txt")]));
        mode(0o755);
        assert_eq!(full.unreadable, vec!["locked".to_string()]);
        assert!(full.files.contains_key("b.txt"));
        assert_eq!(quick.unreadable, vec!["locked/a.txt".to_string()]);
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
