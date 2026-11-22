//! Disk steps the local backend needs beyond what `std` offers: a rename that never replaces
//! what is already there, and a tree copy that copies links as links and leaves pipes and
//! devices alone (opening a pipe waits forever for someone to write to it).

use std::{
    io,
    path::{Path, PathBuf},
};

/// Renames `from` to `to` only when nothing is at `to` (AlreadyExists otherwise). One atomic
/// step where the system has one (Linux and Android `renameat2`, macOS and iOS `renamex_np`);
/// elsewhere a hard link, which refuses an existing name just the same, then dropping `from`.
/// Disks with neither (FAT, some phone storage) get a look first, the best that is left.
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

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios")))]
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
pub fn copy_tree(from: &Path, to: &Path, follow_top: bool, out: &mut Copied) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    let ft = meta.file_type();
    if ft.is_symlink() && follow_top && std::fs::metadata(from).is_ok_and(|m| m.is_file()) {
        std::fs::copy(from, to)?;
        out.files.push(from.to_path_buf());
    } else if ft.is_dir() {
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
        std::fs::copy(from, to)?;
        out.files.push(from.to_path_buf());
    } else {
        out.skipped.push(from.to_path_buf());
    }
    Ok(())
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> io::Result<bool> {
    std::os::unix::fs::symlink(std::fs::read_link(from)?, to)?;
    Ok(true)
}

/// Making links needs extra rights on Windows: a link to a file comes along as that file,
/// anything else stays behind.
#[cfg(not(unix))]
fn copy_link(from: &Path, to: &Path) -> io::Result<bool> {
    if std::fs::metadata(from).is_ok_and(|m| m.is_file()) {
        std::fs::copy(from, to)?;
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
