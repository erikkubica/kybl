//! Where a download lands: refusing paths that climb out of their folder, and picking a free
//! Finder-style name ("photo (1).jpg") instead of replacing a file that is already there.

use std::{
    collections::HashSet,
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

/// Paths handed to downloads that have not finished, so two downloads started together with the
/// same name (two `report.pdf` from different folders) get different names, not the same file.
static RESERVED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Picks the path a download writes to and holds it until [`release`]. With `overwrite` it is
/// `dest` itself; otherwise the first name that is neither on disk nor held by another download.
pub fn reserve(dest: &Path, overwrite: bool) -> PathBuf {
    let mut guard = RESERVED.lock().unwrap();
    let held = guard.get_or_insert_with(HashSet::new);
    let chosen = if overwrite {
        dest.to_path_buf()
    } else {
        free_name(dest, |p| held.contains(p) || p.exists() || part_path(p).exists())
    };
    held.insert(chosen.clone());
    chosen
}

/// Holds `path` again for a retried download that keeps the name it was given first; false if
/// another download holds it now.
pub fn try_hold(path: &Path) -> bool {
    RESERVED.lock().unwrap().get_or_insert_with(HashSet::new).insert(path.to_path_buf())
}

pub fn release(path: &Path) {
    if let Some(held) = RESERVED.lock().unwrap().as_mut() {
        held.remove(path);
    }
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

    #[test]
    fn two_downloads_with_one_name_get_two_files() {
        let dir = std::env::temp_dir().join(format!("kybl-dest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let want = dir.join("report.pdf");
        std::fs::write(&want, b"mine").unwrap();
        let a = reserve(&want, false);
        let b = reserve(&want, false);
        assert_eq!(a, dir.join("report (1).pdf"));
        assert_eq!(b, dir.join("report (2).pdf"));
        // overwrite takes the name as given, even though it exists
        assert_eq!(reserve(&want, true), want);
        release(&a);
        assert!(!try_hold(&b), "held by the other download");
        assert_eq!(reserve(&want, false), a, "a released name is free again");
        for p in [&a, &b, &want] {
            release(p);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
