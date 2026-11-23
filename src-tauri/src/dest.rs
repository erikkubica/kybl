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
    // Windows: a part named like a device (NUL, CON, COM1, aux.txt …) or ending in a dot or space
    // is not a file there (the download would vanish into the device)
    if cfg!(windows) && dest.split(['/', '\\']).skip(1).any(|s| !s.is_empty() && windows_unfit(s)) {
        return Err(bad());
    }
    match p.file_name() {
        Some(n) if !n.is_empty() => Ok(p),
        _ => Err(bad()),
    }
}

/// Whether Windows reads `name` as something other than a plain file name: a device (CON, PRN,
/// AUX, NUL, COM1-9, LPT1-9, CONIN$, CONOUT$, with any extension) or a name ending in a dot or
/// space (which Windows trims, so it names another file).
pub fn windows_unfit(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    device || name.ends_with(['.', ' '])
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
/// Android's shared storage ignore case, so there "Report.pdf" and "report.pdf" are one file;
/// those of macOS and iOS also ignore Unicode normalization, so "résumé" written with a composed
/// "é" and with "e" plus a combining accent is one file too (compared composed, NFC).
fn name_key(p: &Path) -> PathBuf {
    use unicode_normalization::UnicodeNormalization;
    if cfg!(target_os = "linux") {
        p.to_path_buf()
    } else {
        PathBuf::from(p.to_string_lossy().nfc().collect::<String>().to_lowercase())
    }
}

/// Opens a new, empty partial file at `part`. Whatever is there already goes first: a partial
/// file of an earlier attempt, or a link someone planted in a shared folder (the link itself is
/// removed, never what it points at). The file is then created exclusively, so no link is
/// followed and a second writer fails instead of truncating the first one's file.
pub async fn create_part(part: &Path) -> std::io::Result<tokio::fs::File> {
    let part = part.to_path_buf();
    let f = tokio::task::spawn_blocking(move || create_part_blocking(&part)).await.map_err(std::io::Error::other)??;
    Ok(tokio::fs::File::from_std(f))
}

/// [`create_part`] for code already on a blocking thread (the copy out of the file cache).
pub fn create_part_blocking(part: &Path) -> std::io::Result<std::fs::File> {
    if let Ok(m) = std::fs::symlink_metadata(part)
        && !m.is_dir()
    {
        std::fs::remove_file(part)?;
    }
    std::fs::OpenOptions::new().write(true).create_new(true).open(part)
}

/// Puts a whole download in place: its partial file `part` becomes `dest`. With `replace`, a
/// file at `dest` is replaced (the user asked to overwrite, or sync updates its own copy).
/// Otherwise a file that turned up at `dest` while the download ran (the user saved one, another
/// app did) is kept: the download takes the next free name instead, which is held in place of
/// `dest` (see [`reserve`]). Answers where the file landed.
pub fn finish(part: &Path, dest: &Path, replace: bool) -> std::io::Result<PathBuf> {
    if replace {
        std::fs::rename(part, dest)?;
        return Ok(dest.to_path_buf());
    }
    let mut target = dest.to_path_buf();
    // a handful of names taken one after another in that very moment is already absurd
    for _ in 0..32 {
        match crate::storage::local::fsops::rename_noreplace(part, &target) {
            Ok(()) => {
                if target != dest {
                    release(dest);
                }
                return Ok(target);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if target != dest {
                    release(&target);
                }
                target = reserve(dest, false).map_err(std::io::Error::other)?;
            }
            Err(e) => {
                if target != dest {
                    release(&target);
                }
                return Err(e);
            }
        }
    }
    if target != dest {
        release(&target);
    }
    Err(std::io::ErrorKind::AlreadyExists.into())
}

/// Opens the partial file of an earlier attempt to add to its end, with its length. None unless
/// it is a plain file (a link there is never followed).
pub async fn open_part(part: &Path) -> Option<(tokio::fs::File, u64)> {
    let m = tokio::fs::symlink_metadata(part).await.ok()?;
    if !m.file_type().is_file() {
        return None;
    }
    let mut o = tokio::fs::OpenOptions::new();
    o.append(true);
    #[cfg(unix)]
    o.custom_flags(libc::O_NOFOLLOW);
    let f = o.open(part).await.ok()?;
    let len = f.metadata().await.ok()?.len();
    Some((f, len))
}

/// What a download that replaces a file hears while another download writes to that name.
pub const BUSY: &str = "Already downloading this file. Wait for that download to finish, or cancel it first.";

/// Picks the path a download writes to and holds it until [`release`] or [`park`]. With
/// `overwrite` it is `dest` itself (refused while another download writes there; a failed
/// download parked there loses its partial file to it); otherwise the first name that is neither
/// on disk nor in use by another download.
pub fn reserve(dest: &Path, overwrite: bool) -> Result<PathBuf, String> {
    names(|n| {
        // a partial file lives next to its download under `<name>.s3part`: a download called
        // that, or one whose partial file would be called like another download, shares a file
        let partner_busy = |n: &Names, p: &Path| {
            let in_use = |k: &PathBuf| n.held.contains(k) || n.parked.contains_key(k);
            let s = p.as_os_str().to_string_lossy();
            let stem = s.len().checked_sub(PART_SUFFIX.len()).and_then(|i| s.get(i..).filter(|t| t.eq_ignore_ascii_case(PART_SUFFIX)).and(s.get(..i)));
            in_use(&name_key(&part_path(p))) || stem.is_some_and(|s| in_use(&name_key(Path::new(s))))
        };
        let chosen = if overwrite {
            let key = name_key(dest);
            if n.held.contains(&key) || partner_busy(n, dest) {
                return Err(BUSY.to_string());
            }
            n.parked.remove(&key);
            dest.to_path_buf()
        } else {
            free_name(dest, |p| {
                let key = name_key(p);
                n.held.contains(&key) || n.parked.contains_key(&key) || partner_busy(n, p) || p.exists() || part_path(p).exists()
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
    fn windows_device_names_are_spotted() {
        for n in ["NUL", "nul.txt", "aux.tar.gz", "COM1", "lpt9.log", "con ", "CONIN$", "name.", "name "] {
            assert!(windows_unfit(n), "{n}");
        }
        for n in ["null", "auxiliary.txt", "COM", "COM10", "lpt.txt", "a.con", "name.txt", ".env"] {
            assert!(!windows_unfit(n), "{n}");
        }
    }

    /// `report` and `report.s3part` downloaded together must not share `report.s3part`.
    #[test]
    fn a_download_named_like_another_ones_partial_file_gets_its_own_name() {
        let dir = temp_dir();
        let a = reserve(&dir.join("report"), false).unwrap();
        assert_eq!(a, dir.join("report"));
        let b = reserve(&dir.join("report.s3part"), false).unwrap();
        assert_ne!(b, part_path(&a));
        assert!(reserve(&dir.join("report.S3PART"), true).is_err() || cfg!(target_os = "linux"));
        // the other order: a partial-file name taken first, then the download it would belong to
        let c = reserve(&dir.join("x.s3part"), false).unwrap();
        let d = reserve(&dir.join("x"), false).unwrap();
        assert_ne!(part_path(&d), c);
        assert_eq!(reserve(&dir.join("x"), true).unwrap_err(), BUSY);
        for p in [&a, &b, &c, &d] {
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

    /// "résumé.pdf" with a composed é and with e + combining accent is one file on macOS: two
    /// downloads of them at once must not share one name (and one `.s3part`).
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn names_differing_only_in_unicode_normalization_are_one_file() {
        let dir = temp_dir();
        let composed = dir.join("r\u{e9}sum\u{e9}.pdf");
        let decomposed = dir.join("re\u{301}sume\u{301}.pdf");
        let a = reserve(&composed, false).unwrap();
        let b = reserve(&decomposed, false).unwrap();
        assert_eq!(a, composed);
        assert_ne!(name_key(&b), name_key(&a));
        assert_eq!(b.file_name().unwrap().to_string_lossy(), "re\u{301}sume\u{301} (1).pdf");
        assert_eq!(reserve(&decomposed, true), Err(BUSY.to_string()));
        release(&a);
        release(&b);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A link planted at the partial file's name (in a folder others can write to) is never
    /// followed: the file it points at stays as it was.
    #[cfg(unix)]
    #[test]
    fn a_link_at_the_partial_files_name_is_not_followed() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            use tokio::io::AsyncWriteExt;
            let dir = temp_dir();
            let victim = dir.join("victim.txt");
            std::fs::write(&victim, b"precious").unwrap();
            let part = part_path(&dir.join("report.pdf"));
            std::os::unix::fs::symlink(&victim, &part).unwrap();
            assert!(open_part(&part).await.is_none(), "a link is no partial file to carry on");
            let mut f = create_part(&part).await.unwrap();
            f.write_all(b"downloaded").await.unwrap();
            drop(f);
            assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
            assert!(std::fs::symlink_metadata(&part).unwrap().file_type().is_file());
            assert_eq!(std::fs::read(&part).unwrap(), b"downloaded");
            // a dangling link too
            std::fs::remove_file(&part).unwrap();
            let nowhere = dir.join("not-yet");
            std::os::unix::fs::symlink(&nowhere, &part).unwrap();
            create_part(&part).await.unwrap();
            assert!(!nowhere.exists());
            // a plain partial file of an earlier attempt is carried on
            std::fs::write(&part, b"half").unwrap();
            assert_eq!(open_part(&part).await.map(|(_, n)| n), Some(4));
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /// A download that doesn't replace files never replaces one that turned up at its name while
    /// it ran: it lands under the next free name, which it holds instead.
    #[test]
    fn a_file_that_turned_up_while_downloading_is_never_replaced() {
        let dir = temp_dir();
        let want = dir.join("report.pdf");
        let chosen = reserve(&want, false).unwrap();
        assert_eq!(chosen, want);
        std::fs::write(part_path(&chosen), b"downloaded").unwrap();
        std::fs::write(&chosen, b"theirs").unwrap();
        let landed = finish(&part_path(&chosen), &chosen, false).unwrap();
        assert_eq!(landed, dir.join("report (1).pdf"));
        assert_eq!(std::fs::read(&chosen).unwrap(), b"theirs");
        assert_eq!(std::fs::read(&landed).unwrap(), b"downloaded");
        assert!(!part_path(&chosen).exists());
        assert!(unless_in_use(&chosen, || {}), "the first name is let go");
        assert!(!unless_in_use(&landed, || {}), "the new one is held until the download ends");
        release(&landed);
        // nothing in the way: the name it was given
        let next = reserve(&dir.join("other.txt"), false).unwrap();
        std::fs::write(part_path(&next), b"x").unwrap();
        assert_eq!(finish(&part_path(&next), &next, false).unwrap(), next);
        release(&next);
        // asked to replace: replaced
        std::fs::write(part_path(&want), b"new").unwrap();
        assert_eq!(finish(&part_path(&want), &want, true).unwrap(), want);
        assert_eq!(std::fs::read(&want).unwrap(), b"new");
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
