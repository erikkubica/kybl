//! Where a download lands: refusing paths that climb out of their folder, and picking a free
//! Finder-style name ("photo (1).jpg") instead of replacing a file that is already there.

use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

/// Suffix of a download still in progress, next to where the file will go.
pub const PART_SUFFIX: &str = ".s3part";

pub fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/// Checks a local download path. The page joins the folder the user chose with a path taken
/// from object keys, and a key like `x/../../.zshrc` must not reach outside that folder, so any
/// `..` (or `.`) part is refused outright, as is a path that is not absolute or names no file.
pub fn validate(dest: &str) -> Result<PathBuf, String> {
    let bad = || format!("Can't save to \"{dest}\": that isn't a safe place for a downloaded file.");
    if dest.is_empty() || dest.contains('\0') {
        return Err(bad());
    }
    let p = PathBuf::from(dest);
    if !p.is_absolute() {
        return Err(bad());
    }
    // `components()` folds away inner "." parts; look at the raw text for them too
    let raw_dot = dest.split(['/', '\\']).any(|s| s == "." || s == "..");
    if raw_dot || p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err(bad());
    }
    match p.file_name() {
        Some(n) if !n.is_empty() => Ok(p),
        _ => Err(bad()),
    }
}

/// "name.ext" → "name (n).ext"; a name without an extension (or a dotfile) gets " (n)" at the end.
fn numbered(path: &Path, n: u32) -> PathBuf {
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    path.with_file_name(format!("{stem} ({n}){ext}"))
}

/// The first of `path`, "name (1).ext", "name (2).ext" … that `taken` says is free.
pub fn free_name(path: &Path, taken: impl Fn(&Path) -> bool) -> PathBuf {
    if !taken(path) {
        return path.to_path_buf();
    }
    (1..)
        .map(|n| numbered(path, n))
        .find(|p| !taken(p))
        .expect("some number is free")
}

/// Names downloads are using, so two downloads started together with the same name (two
/// `report.pdf` from different folders) get different names, and two downloads never share one
/// `.s3part` file. `held`: written to right now. `parked`: a failed download (by transfer id)
/// keeps its partial file there for Retry.
#[derive(Default)]
struct Names {
    held: HashSet<PathBuf>,
    parked: HashMap<PathBuf, String>,
}

static NAMES: Mutex<Option<Names>> = Mutex::new(None);

fn names<T>(f: impl FnOnce(&mut Names) -> T) -> T {
    f(NAMES.lock().unwrap().get_or_insert_with(Names::default))
}

/// How a path is compared with the names in use. The file systems of macOS, Windows, iOS and
/// Android's shared storage ignore case, so there "Report.pdf" and "report.pdf" are one file.
fn name_key(p: &Path) -> PathBuf {
    if cfg!(target_os = "linux") {
        p.to_path_buf()
    } else {
        PathBuf::from(p.to_string_lossy().to_lowercase())
    }
}

/// What a download that replaces a file hears while another download writes to that name.
pub const BUSY: &str = "Already downloading this file. Wait for that download to finish, or cancel it first.";

/// Picks the path a download writes to and holds it until [`release`] or [`park`]. With
/// `overwrite` it is `dest` itself (refused while another download writes there; a failed
/// download parked there loses its partial file to it); otherwise the first name that is neither
/// on disk nor in use by another download.
pub fn reserve(dest: &Path, overwrite: bool) -> Result<PathBuf, String> {
    names(|n| {
        let chosen = if overwrite {
            let key = name_key(dest);
            if n.held.contains(&key) {
                return Err(BUSY.to_string());
            }
            n.parked.remove(&key);
            dest.to_path_buf()
        } else {
            free_name(dest, |p| {
                let key = name_key(p);
                n.held.contains(&key) || n.parked.contains_key(&key) || p.exists() || part_path(p).exists()
            })
        };
        n.held.insert(name_key(&chosen));
        Ok(chosen)
    })
}

/// The download writing to `path` ended.
pub fn release(path: &Path) {
    names(|n| n.held.remove(&name_key(path)));
}

/// The download writing to `path` (transfer `id`) failed: its partial file stays for Retry.
pub fn park(path: &Path, id: &str) {
    names(|n| {
        let key = name_key(path);
        n.held.remove(&key);
        n.parked.insert(key, id.to_string());
    });
}

/// Retry of the failed download `id`: holds its name again. False when the partial file there is
/// not its own any more (a download that replaces the file took the name meanwhile).
pub fn resume(path: &Path, id: &str) -> bool {
    names(|n| {
        let key = name_key(path);
        if n.parked.get(&key).map(String::as_str) != Some(id) || n.held.contains(&key) {
            return false;
        }
        n.parked.remove(&key);
        n.held.insert(key);
        true
    })
}

/// The failed download `id` is forgotten. True when the partial file at `path` was still its
/// own, so the caller may remove it.
pub fn unpark(path: &Path, id: &str) -> bool {
    names(|n| {
        let key = name_key(path);
        if n.parked.get(&key).map(String::as_str) != Some(id) {
            return false;
        }
        n.parked.remove(&key);
        !n.held.contains(&key)
    })
}

/// Retry of a failed download that holds its first name again (see [`resume`]). A file that
/// turned up under that name since is kept, unless `overwrite`: the download then carries on
/// under a free name for `wanted`, its partial file moved along. Answers the name and whether
/// the partial file is still there to continue.
pub fn recheck_retry(chosen: PathBuf, wanted: &Path, overwrite: bool) -> (PathBuf, bool) {
    if overwrite || !chosen.exists() {
        return (chosen, true);
    }
    let next = reserve(wanted, false).expect("only a download that replaces a file is ever refused");
    let moved = std::fs::rename(part_path(&chosen), part_path(&next)).is_ok();
    if moved {
        crate::leftovers::partial_started(&part_path(&next));
    } else {
        let _ = std::fs::remove_file(part_path(&chosen));
    }
    release(&chosen);
    (next, moved)
}

/// Runs `f` unless a download writes to, or keeps a partial file for, `path`; nothing can take
/// the name while `f` runs. False when it was in use.
pub fn unless_in_use(path: &Path, f: impl FnOnce()) -> bool {
    names(|n| {
        let key = name_key(path);
        if n.held.contains(&key) || n.parked.contains_key(&key) {
            return false;
        }
        f();
        true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn climbing_out_of_the_folder_is_refused() {
        assert!(validate("/Users/me/Downloads/photos/a.jpg").is_ok());
        assert!(validate("/Users/me/Downloads/x/../../.zshrc").is_err());
        assert!(validate("/Users/me/Downloads/./a.jpg").is_err());
        assert!(validate("/Users/me/Downloads/..").is_err());
        assert!(validate("relative/a.jpg").is_err());
        assert!(validate("").is_err());
        assert!(validate("/").is_err());
        assert!(validate("/tmp/a\0b").is_err());
        // dots inside a name are fine
        assert!(validate("/tmp/..hidden..file").is_ok());
        assert!(validate("/tmp/a..b/c.txt").is_ok());
    }

    #[test]
    fn free_names_count_up_like_finder() {
        let taken = |set: &'static [&'static str]| move |p: &Path| set.iter().any(|s| Path::new(s) == p);
        assert_eq!(free_name(Path::new("/d/photo.jpg"), taken(&[])), Path::new("/d/photo.jpg"));
        assert_eq!(free_name(Path::new("/d/photo.jpg"), taken(&["/d/photo.jpg"])), Path::new("/d/photo (1).jpg"));
        assert_eq!(
            free_name(Path::new("/d/photo.jpg"), taken(&["/d/photo.jpg", "/d/photo (1).jpg"])),
            Path::new("/d/photo (2).jpg")
        );
        assert_eq!(free_name(Path::new("/d/README"), taken(&["/d/README"])), Path::new("/d/README (1)"));
        assert_eq!(free_name(Path::new("/d/.env"), taken(&["/d/.env"])), Path::new("/d/.env (1)"));
        assert_eq!(free_name(Path::new("/d/a.tar.gz"), taken(&["/d/a.tar.gz"])), Path::new("/d/a.tar (1).gz"));
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kybl-dest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn two_downloads_with_one_name_get_two_files() {
        let dir = temp_dir();
        let want = dir.join("report.pdf");
        std::fs::write(&want, b"mine").unwrap();
        let a = reserve(&want, false).unwrap();
        let b = reserve(&want, false).unwrap();
        assert_eq!(a, dir.join("report (1).pdf"));
        assert_eq!(b, dir.join("report (2).pdf"));
        // overwrite takes the name as given, even though it exists
        assert_eq!(reserve(&want, true).unwrap(), want);
        release(&a);
        assert_eq!(reserve(&want, false).unwrap(), a, "a released name is free again");
        for p in [&a, &b, &want] {
            release(p);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn replacing_a_file_another_download_writes_to_is_refused() {
        let dir = temp_dir();
        let want = dir.join("movie.mkv");
        let a = reserve(&want, false).unwrap();
        assert_eq!(a, want);
        assert_eq!(reserve(&want, true), Err(BUSY.to_string()), "never two writers on one .s3part");
        release(&a);
        assert_eq!(reserve(&want, true).unwrap(), want, "free once the first one ended");
        release(&want);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn names_differing_only_in_case_are_one_file() {
        let dir = temp_dir();
        let a = reserve(&dir.join("Report.PDF"), false).unwrap();
        let b = reserve(&dir.join("report.pdf"), false).unwrap();
        assert_eq!(b, dir.join("report (1).pdf"));
        assert_eq!(reserve(&dir.join("REPORT.pdf"), true), Err(BUSY.to_string()));
        release(&a);
        release(&b);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_download_keeps_its_name_for_retry() {
        let dir = temp_dir();
        let want = dir.join("big.iso");
        let a = reserve(&want, false).unwrap();
        park(&a, "t1");
        let other = reserve(&want, false).unwrap();
        assert_eq!(other, dir.join("big (1).iso"), "parked names aren't handed out");
        release(&other);
        assert!(!resume(&a, "other"), "only by its own transfer");
        assert!(resume(&a, "t1"));
        assert!(!unless_in_use(&a, || {}));
        park(&a, "t1");
        // a download that replaces the file takes the name: the partial isn't t1's any more
        assert_eq!(reserve(&want, true).unwrap(), want);
        assert!(!resume(&a, "t1"));
        assert!(!unpark(&a, "t1"), "forgetting t1 must not remove the other one's partial");
        park(&want, "t2");
        assert!(unpark(&want, "t2"));
        assert!(unless_in_use(&want, || {}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_retry_never_replaces_a_file_that_turned_up_meanwhile() {
        let dir = temp_dir();
        let want = dir.join("notes.txt");
        let a = reserve(&want, false).unwrap();
        std::fs::write(part_path(&a), b"half").unwrap();
        park(&a, "t1");
        // nothing there yet: same name, partial kept
        assert!(resume(&a, "t1"));
        assert_eq!(recheck_retry(a.clone(), &want, false), (a.clone(), true));
        park(&a, "t1");
        // the user saved a file of that name meanwhile
        std::fs::write(&a, b"theirs").unwrap();
        assert!(resume(&a, "t1"));
        let (next, kept) = recheck_retry(a.clone(), &want, false);
        assert_eq!(next, dir.join("notes (1).txt"));
        assert!(kept);
        assert_eq!(std::fs::read(part_path(&next)).unwrap(), b"half", "the partial moved along");
        assert_eq!(std::fs::read(&a).unwrap(), b"theirs", "their file is untouched");
        assert!(unless_in_use(&a, || {}), "the old name is let go");
        release(&next);
        // unless the download replaces files anyway
        assert!(reserve(&a, true).is_ok());
        park(&a, "t2");
        assert!(resume(&a, "t2"));
        assert_eq!(recheck_retry(a.clone(), &want, true), (a.clone(), true));
        release(&a);
        let _ = std::fs::remove_dir_all(dir);
    }
}
