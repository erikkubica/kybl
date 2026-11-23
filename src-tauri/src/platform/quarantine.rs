//! Marks files downloaded from a connection the way browsers mark theirs, so the system checks
//! them before they run: macOS's quarantine flag (Gatekeeper asks before a downloaded app, script
//! or installer opens) and Windows' Mark of the Web (`Zone.Identifier`, Internet zone: SmartScreen
//! and Office's Protected View). Other systems have no such mark; nothing happens there.
//! Best effort: a disk that can't hold the mark (FAT, some network shares) gets none.

use std::path::Path;

use crate::storage::Storage;

/// Marks `path` as downloaded from the internet.
pub fn mark(path: &Path) {
    imp(path);
}

/// Marks the file at `key` of `dst` when it is on this computer and came from somewhere else
/// (`from_elsewhere`): a copy job, a sync download, an unpacked archive. Nothing otherwise.
pub fn mark_arrival(from_elsewhere: bool, dst: &dyn Storage, root: &str, key: &str) {
    if from_elsewhere && let Some(p) = dst.local_path(root, key) {
        mark(&p);
    }
}

/// Whether `path` carries the mark (an archive a browser downloaded, say): what is unpacked from
/// it gets the mark too, as the system's own unarchivers do.
pub fn is_marked(path: &Path) -> bool {
    marked(path)
}

#[cfg(target_os = "macos")]
fn imp(path: &Path) {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let Ok(p) = CString::new(path.as_os_str().as_bytes()) else { return };
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // flags;time (hex);agent;event id: 0081 = downloaded, not yet approved by the user
    let value = format!("0081;{secs:08x};Kybl;{}", uuid::Uuid::new_v4().to_string().to_uppercase());
    let name = c"com.apple.quarantine";
    // SAFETY: plain syscall with valid, NUL-terminated strings and a buffer of the given length
    unsafe { libc::setxattr(p.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
}

#[cfg(windows)]
fn imp(path: &Path) {
    let mut ads = path.as_os_str().to_owned();
    ads.push(":Zone.Identifier");
    let _ = std::fs::write(ads, "[ZoneTransfer]\r\nZoneId=3\r\n");
}

#[cfg(not(any(target_os = "macos", windows)))]
fn imp(_path: &Path) {}

#[cfg(target_os = "macos")]
fn marked(path: &Path) -> bool {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let Ok(p) = CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: a size query (null buffer, length 0) with valid, NUL-terminated strings
    unsafe { libc::getxattr(p.as_ptr(), c"com.apple.quarantine".as_ptr(), std::ptr::null_mut(), 0, 0, 0) >= 0 }
}

#[cfg(windows)]
fn marked(path: &Path) -> bool {
    let mut ads = path.as_os_str().to_owned();
    ads.push(":Zone.Identifier");
    // Internet (3) or Restricted (4) zone
    std::fs::read_to_string(ads).is_ok_and(|s| s.lines().any(|l| l.trim().strip_prefix("ZoneId=").and_then(|z| z.trim().parse::<u8>().ok()).is_some_and(|z| z >= 3)))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn marked(_path: &Path) -> bool {
    false
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn a_marked_file_is_quarantined() {
        let dir = std::env::temp_dir().join(format!("kybl-qtn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("Invoice.pdf.app");
        std::fs::write(&f, b"x").unwrap();
        super::mark(&f);
        let out = std::process::Command::new("/usr/bin/xattr").arg("-p").arg("com.apple.quarantine").arg(&f).output().unwrap();
        let v = String::from_utf8_lossy(&out.stdout);
        assert!(v.starts_with("0081;") && v.contains(";Kybl;"), "{v}");
        assert!(super::is_marked(&f));
        let plain = dir.join("plain.txt");
        std::fs::write(&plain, b"x").unwrap();
        assert!(!super::is_marked(&plain));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
