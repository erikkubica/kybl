//! Disk steps the local backend needs beyond what `std` offers: a rename that never replaces
//! what is already there, and a tree copy that copies links as links and leaves pipes and
//! devices alone (opening a pipe waits forever for someone to write to it).

use std::{
    io,
    path::{Path, PathBuf},
};

/// Renames `from` to `to` only when nothing is at `to` (AlreadyExists otherwise). One atomic
/// step where the system has one (Linux and Android `renameat2`, macOS and iOS `renamex_np`,
/// Windows `MoveFileExW` without its replace flag); elsewhere a hard link, which refuses an
/// existing name just the same, then dropping `from`. Unix disks with neither (FAT, exFAT, some
/// SMB shares and phone storage) get a look first, the best that is left there: a name another
/// app creates in the instant between the look and the rename is replaced.
pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    match native_noreplace(from, to) {
        Ok(()) => return Ok(()),
        Err(e) if !unsupported(&e) => return Err(e),
        Err(_) => {}
    }
    match std::fs::hard_link(from, to) {
        Ok(()) => {
            // the file is in place under its real name; a leftover temporary name is only clutter
            let _ = std::fs::remove_file(from);
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(_) => {
            if std::fs::symlink_metadata(to).is_ok() {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            std::fs::rename(from, to)
        }
    }
}

/// The system or this disk can't do an exclusive rename (so try the next way).
fn unsupported(e: &io::Error) -> bool {
    if e.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    if let Some(code) = e.raw_os_error() {
        return [libc::EINVAL, libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP, libc::EPERM].contains(&code);
    }
    false
}

#[cfg(unix)]
fn c_path(p: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into())
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn native_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    // not every libc names the flag; the kernel's value
    const RENAME_NOREPLACE: libc::c_uint = 1;
    let (f, t) = (c_path(from)?, c_path(to)?);
    // SAFETY: both are valid NUL-terminated paths that outlive the call
    let r = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, f.as_ptr(), libc::AT_FDCWD, t.as_ptr(), RENAME_NOREPLACE) };
    if r == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn native_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let (f, t) = (c_path(from)?, c_path(to)?);
    // SAFETY: both are valid NUL-terminated paths that outlive the call
    let r = unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) };
    if r == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` fails when anything is at `to`, in one
/// step (std's `rename` passes that flag, so it replaces). kernel32 is linked by std already.
#[cfg(windows)]
fn native_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    // long paths need the `\\?\` form, as std adds it for its own calls (no long-path manifest)
    let wide = |p: &Path| {
        let text: Vec<u16> = p.as_os_str().encode_wide().collect();
        let mut w: Vec<u16> = String::from_utf16(&text).map_or(text, |t| verbatim(&t).encode_utf16().collect());
        w.push(0);
        w
    };
    let (f, t) = (wide(from), wide(to));
    // SAFETY: both are valid NUL-terminated UTF-16 paths that outlive the call
    let ok = unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), 0) };
    if ok != 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// A Windows path as Win32 takes it past 260 characters: `C:\x` → `\\?\C:\x`, `\\srv\share\x` →
/// `\\?\UNC\srv\share\x` (with `/` as `\`, which the verbatim form doesn't translate). Short
/// paths, relative ones, ones already verbatim and ones with `.` or `..` parts stay as they are.
#[cfg_attr(not(windows), allow(dead_code))]
fn verbatim(p: &str) -> String {
    if p.len() < 248 || p.starts_with(r"\\?\") || p.starts_with(r"\\.\") {
        return p.to_string();
    }
    let p = p.replace('/', r"\");
    if p.split('\\').skip(1).any(|s| s == "." || s == "..") {
        return p;
    }
    let b = p.as_bytes();
    if b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
        format!(r"\\?\{p}")
    } else if let Some(unc) = p.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{unc}")
    } else {
        p
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios", windows)))]
fn native_noreplace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

/// What a tree copy did, by source path, so a move removes only what reached the destination.
#[derive(Default, Debug)]
pub struct Copied {
    /// files and links copied
    pub files: Vec<PathBuf>,
    /// folders made at the destination, parents first
    pub dirs: Vec<PathBuf>,
    /// left where they are: pipes, sockets, devices (and links where links can't be made)
    pub skipped: Vec<PathBuf>,
}

/// Copies a file or a folder with everything in it (across disks, where a rename can't).
/// Links inside are copied as links and never followed, so the copy can't reach outside the
/// folder or loop. `follow_top`: a link given as `from` itself is copied as the file it points
/// to (a copy of what a read would answer); otherwise as a link (a move of the link).
///
/// The destination side is as careful: a file (or link) is written under a temporary name next
/// to its place and renamed over, so a failure midway (a full disk, an unreadable source) never
/// leaves a file that was there destroyed or half-written, and a link already at a destination
/// name is replaced, never written through. A folder is never made through a link either.
pub fn copy_tree(from: &Path, to: &Path, follow_top: bool, out: &mut Copied) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    let ft = meta.file_type();
    if ft.is_symlink() && follow_top && std::fs::metadata(from).is_ok_and(|m| m.is_file()) {
        copy_file_over(from, to)?;
        out.files.push(from.to_path_buf());
    } else if ft.is_dir() {
        // a link at the folder's place would take the copy wherever it points
        if std::fs::symlink_metadata(to).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} is a link; a folder isn't copied through it.", to.display())));
        }
        std::fs::create_dir_all(to)?;
        out.dirs.push(from.to_path_buf());
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()), false, out)?;
        }
    } else if ft.is_symlink() {
        if copy_link(from, to)? {
            out.files.push(from.to_path_buf());
        } else {
            out.skipped.push(from.to_path_buf());
        }
    } else if ft.is_file() {
        copy_file_over(from, to)?;
        out.files.push(from.to_path_buf());
    } else {
        out.skipped.push(from.to_path_buf());
    }
    Ok(())
}

/// A free temporary name next to `to`, like the local writer's (hidden, `.kybl-` and an id, the
/// name cut short to leave room for them).
fn temp_beside(to: &Path) -> io::Result<PathBuf> {
    let parent = to.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let name = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(parent.join(format!(".{}.kybl-{}", crate::storage::net::fit_name(&name, 43), uuid::Uuid::new_v4())))
}

/// Puts what `make` creates at a temporary name in place of `to` with one rename (which
/// replaces a file or a link there, never writing through it); the temporary goes on failure.
fn create_over(to: &Path, make: impl FnOnce(&Path) -> io::Result<()>) -> io::Result<()> {
    let tmp = temp_beside(to)?;
    let r = make(&tmp).and_then(|()| std::fs::rename(&tmp, to));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

/// `std::fs::copy` (contents and permissions) without its truncate-in-place: see [`copy_tree`].
fn copy_file_over(from: &Path, to: &Path) -> io::Result<()> {
    create_over(to, |tmp| std::fs::copy(from, tmp).map(|_| ()))
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> io::Result<bool> {
    let target = std::fs::read_link(from)?;
    create_over(to, |tmp| std::os::unix::fs::symlink(&target, tmp))?;
    Ok(true)
}

/// Making links needs extra rights on Windows: a link to a file comes along as that file,
/// anything else stays behind.
#[cfg(not(unix))]
fn copy_link(from: &Path, to: &Path) -> io::Result<bool> {
    if std::fs::metadata(from).is_ok_and(|m| m.is_file()) {
        copy_file_over(from, to)?;
        return Ok(true);
    }
    Ok(false)
}

/// Removes the originals of what [`copy_tree`] copied: files and links one by one, then the
/// folders deepest first, and only those that ended up empty. Whatever wasn't copied (or
/// appeared meanwhile) stays, and so do the folders holding it.
pub fn remove_copied(c: &Copied) -> io::Result<()> {
    for f in &c.files {
        match std::fs::remove_file(f) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    for d in c.dirs.iter().rev() {
        let _ = std::fs::remove_dir(d);
    }
    Ok(())
}

/// `p` with every link resolved, for the parts that exist; the rest appended as they are.
pub fn canon_lossy(p: &Path) -> PathBuf {
    let mut tail = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(mut c) = std::fs::canonicalize(&cur) {
            c.extend(tail.iter().rev());
            return c;
        }
        match (cur.file_name().map(|n| n.to_os_string()), cur.parent()) {
            (Some(n), Some(parent)) => {
                tail.push(n);
                cur = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
}

/// Refuses moving or copying a real folder into itself, judged on the real paths, so a way in
/// through a link counts too.
pub fn check_not_into_itself(src: &Path, dst: &Path) -> io::Result<bool> {
    let meta = std::fs::symlink_metadata(src)?;
    if !meta.is_dir() {
        return Ok(false);
    }
    let s = std::fs::canonicalize(src)?;
    Ok(canon_lossy(dst).starts_with(&s))
}

/// Whether some folder between `root` and `p` (not `p` itself) is a link. Deleting or moving
/// through one would act on whatever the link points to, outside what was picked.
pub fn through_link(root: &Path, p: &Path) -> bool {
    let Ok(rel) = p.strip_prefix(root) else { return true };
    let mut cur = root.to_path_buf();
    let mut comps: Vec<_> = rel.components().collect();
    comps.pop();
    for c in comps {
        cur.push(c);
        if std::fs::symlink_metadata(&cur).is_ok_and(|m| m.file_type().is_symlink()) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows' exclusive rename gets long paths in the `\\?\` form, as std's own calls do.
    #[test]
    fn long_windows_paths_go_verbatim() {
        let deep = format!(r"C:\Users\me\Downloads\{}\big.iso", "a\\".repeat(130));
        assert_eq!(verbatim(&deep), format!(r"\\?\{deep}"));
        assert_eq!(verbatim(&deep.replace('\\', "/")), format!(r"\\?\{deep}"));
        let unc = format!(r"\\nas\share\{}x.bin", "b\\".repeat(130));
        assert_eq!(verbatim(&unc), format!(r"\\?\UNC\{}", &unc[2..]));
        assert_eq!(verbatim(r"C:\short\a.txt"), r"C:\short\a.txt");
        let already = format!(r"\\?\{deep}");
        assert_eq!(verbatim(&already), already);
        let dotted = format!(r"C:\x\..\{}", "c".repeat(260));
        assert!(!verbatim(&dotted).starts_with(r"\\?\"));
    }

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp() -> Tmp {
        let p = std::env::temp_dir().join(format!("kybl-fsops-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }

    #[test]
    fn exclusive_rename_never_replaces() {
        let t = tmp();
        let (a, b) = (t.0.join("a"), t.0.join("b"));
        std::fs::write(&a, b"new").unwrap();
        std::fs::write(&b, b"theirs").unwrap();
        let e = rename_noreplace(&a, &b).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&b).unwrap(), b"theirs");
        assert!(a.exists(), "the temporary file stays for the caller to drop");
        std::fs::remove_file(&b).unwrap();
        rename_noreplace(&a, &b).unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), b"new");
        assert!(!a.exists());
    }

    /// A copy over a file goes through a temporary name: a copy that fails midway leaves the old
    /// file whole, and a link at the destination is replaced, never written through.
    #[cfg(unix)]
    #[test]
    fn copies_never_truncate_or_write_through_the_destination() {
        use std::os::unix::fs::PermissionsExt;
        let t = tmp();
        let (src, dst) = (t.0.join("src.txt"), t.0.join("dst.txt"));
        std::fs::write(&src, b"new").unwrap();
        std::fs::write(&dst, b"old and precious").unwrap();
        copy_tree(&src, &dst, true, &mut Copied::default()).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"new");
        // an unreadable source fails before anything at the destination changes
        let locked = t.0.join("locked.txt");
        std::fs::write(&locked, b"secret").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&locked).is_err() {
            assert!(copy_tree(&locked, &dst, true, &mut Copied::default()).is_err());
            assert_eq!(std::fs::read(&dst).unwrap(), b"new", "the old file is untouched");
        }
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600)).unwrap();
        // a link at the destination name: replaced by the copy, what it points at untouched
        let outside = t.0.join("outside.txt");
        std::fs::write(&outside, b"not yours").unwrap();
        let via = t.0.join("via.txt");
        std::os::unix::fs::symlink(&outside, &via).unwrap();
        copy_tree(&src, &via, false, &mut Copied::default()).unwrap();
        assert!(!std::fs::symlink_metadata(&via).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&via).unwrap(), b"new");
        assert_eq!(std::fs::read(&outside).unwrap(), b"not yours");
        // a folder is never made through a link
        std::fs::create_dir_all(t.0.join("tree/sub")).unwrap();
        std::fs::write(t.0.join("tree/sub/a"), b"a").unwrap();
        std::fs::create_dir_all(t.0.join("elsewhere")).unwrap();
        std::fs::create_dir_all(t.0.join("into")).unwrap();
        std::os::unix::fs::symlink(t.0.join("elsewhere"), t.0.join("into/sub")).unwrap();
        assert!(copy_tree(&t.0.join("tree"), &t.0.join("into"), false, &mut Copied::default()).is_err());
        assert!(std::fs::read_dir(t.0.join("elsewhere")).unwrap().next().is_none(), "nothing written through the link");
        let left: Vec<_> = walk_names(&t.0).into_iter().filter(|n| n.contains(".kybl-")).collect();
        assert!(left.is_empty(), "no temporary file left: {left:?}");
    }

    fn walk_names(p: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(p).unwrap().flatten() {
            out.push(e.file_name().to_string_lossy().into_owned());
            if e.file_type().unwrap().is_dir() {
                out.extend(walk_names(&e.path()));
            }
        }
        out
    }

    #[test]
    fn real_paths_judge_into_itself() {
        let t = tmp();
        std::fs::create_dir_all(t.0.join("d/sub")).unwrap();
        assert!(check_not_into_itself(&t.0.join("d"), &t.0.join("d/sub/new")).unwrap());
        assert!(!check_not_into_itself(&t.0.join("d"), &t.0.join("e")).unwrap());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(t.0.join("d"), t.0.join("via")).unwrap();
            assert!(check_not_into_itself(&t.0.join("via/sub"), &t.0.join("d/sub/x")).unwrap(), "a way in through a link");
            assert!(check_not_into_itself(&t.0.join("d"), &t.0.join("via/sub/x")).unwrap());
        }
    }
}
