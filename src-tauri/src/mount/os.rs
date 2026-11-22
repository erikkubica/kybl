//! Asking the operating system to mount a drive's WebDAV address, and to let go of it.
//!
//! - **macOS**: `mount_webdav -S` into `app_data_dir/Mounts/<name>`, a folder the user owns, so
//!   no administrator rights and no dialogs (`-S` also unmounts on its own if Kybl stops
//!   answering, instead of the "server connection interrupted" dialog). The volume shows in
//!   Finder's sidebar under Locations with the drive's name (`-v`). Chosen over
//!   `osascript -e 'mount volume …'`, which mounts under `/Volumes` through Finder's own
//!   connection flow and may show a dialog or a Finder window on its own.
//! - **Linux**: `gio mount dav://…` (GVFS, what Files/Nautilus, Nemo and Thunar use); the drive
//!   appears in the file manager's sidebar. Without `gio` the user gets the address to add by hand.
//! - **Windows**: not offered (see `NATIVE.md`, stage E2: Windows' own Cloud Files API). Windows'
//!   WebDAV client (WebClient) is often switched off, caps files at 50 MB, and refuses plain-HTTP
//!   sign-in by default. Set `KYBL_EXPERIMENTAL_WEBDAV_DRIVE=1` to try it anyway with `net use`.

use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use std::process::Command;

/// Where a drive ended up: a folder (macOS, Linux) or drive letter (Windows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mounted {
    pub point: String,
}

/// A name that works as a folder name everywhere.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() { "Kybl".into() } else { cleaned.chars().take(80).collect() }
}

/// Whether mounting is available here; the reason when it isn't.
pub fn unsupported_reason() -> Option<&'static str> {
    if cfg!(target_os = "windows") && std::env::var("KYBL_EXPERIMENTAL_WEBDAV_DRIVE").as_deref() != Ok("1") {
        return Some("Drives aren't available on Windows yet. They're coming with Windows' own cloud files support, which shows files in File Explorer and downloads them when opened.");
    }
    None
}

// ---------------------------------------------------------------- macOS

/// The mount table's line for `point`: `<url> on <point> (webdav, …)`.
#[cfg(any(target_os = "macos", test))]
fn mounted_url(table: &str, point: &Path) -> Option<String> {
    let needle = format!(" on {} (", point.display());
    table.lines().find_map(|l| l.find(&needle).map(|i| l[..i].to_string()))
}

#[cfg(target_os = "macos")]
fn mount_table() -> String {
    Command::new("/sbin/mount").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

#[cfg(target_os = "macos")]
pub fn mount(url: &str, base: &Path, name: &str, read_only: bool) -> Result<Mounted, String> {
    let point = base.join(safe_name(name));
    match mounted_url(&mount_table(), &point) {
        // still mounted from before (Kybl restarted on the same port): nothing to do
        Some(u) if u == url => return Ok(Mounted { point: point.display().to_string() }),
        Some(_) => force_unmount(&point),
        None => {}
    }
    std::fs::create_dir_all(&point).map_err(|e| format!("Couldn't make the folder for the drive.\n\n{e}"))?;
    let mut cmd = Command::new("/sbin/mount_webdav");
    cmd.arg("-S").arg("-v").arg(name);
    if read_only {
        cmd.arg("-o").arg("rdonly");
    }
    let out = cmd.arg(url).arg(&point).output().map_err(|e| format!("Couldn't start mount_webdav.\n\n{e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_dir(&point);
        let code = out.status.code().unwrap_or(-1);
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("macOS didn't mount the drive (error {code}).\n\n{detail}"));
    }
    Ok(Mounted { point: point.display().to_string() })
}

#[cfg(target_os = "macos")]
fn force_unmount(point: &Path) {
    let ok = Command::new("/sbin/umount").arg(point).status().is_ok_and(|s| s.success());
    if !ok {
        let _ = Command::new("/sbin/umount").arg("-f").arg(point).status();
    }
}

#[cfg(target_os = "macos")]
pub fn unmount(m: &Mounted, _url: &str) -> Result<(), String> {
    let point = Path::new(&m.point);
    if mounted_url(&mount_table(), point).is_some() {
        let out = Command::new("/sbin/umount").arg(point).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            // something has a file open on the drive: let go anyway, Kybl is about to stop serving it
            let _ = Command::new("/sbin/umount").arg("-f").arg(point).status();
        }
    }
    if mounted_url(&mount_table(), point).is_some() {
        return Err("The drive is still in use. Close the files open on it and try again.".into());
    }
    let _ = std::fs::remove_dir(point);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn is_mounted(m: &Mounted) -> bool {
    mounted_url(&mount_table(), Path::new(&m.point)).is_some()
}

// ---------------------------------------------------------------- Linux

#[cfg(target_os = "linux")]
fn dav_url(url: &str) -> String {
    url.replacen("http://", "dav://", 1)
}

#[cfg(target_os = "linux")]
pub fn mount(url: &str, _base: &Path, _name: &str, _read_only: bool) -> Result<Mounted, String> {
    let dav = dav_url(url);
    let out = Command::new("gio").arg("mount").arg(&dav).output().map_err(|_| {
        format!("Kybl uses GVFS (the gio command) to show drives in your file manager, and it isn't installed. Install your desktop's gvfs package, or open {dav} in your file manager.")
    })?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // already mounted counts as done
        if !detail.contains("already mounted") {
            return Err(format!("Your desktop didn't mount the drive.\n\n{detail}"));
        }
    }
    Ok(Mounted { point: gvfs_point(url).map(|p| p.display().to_string()).unwrap_or(dav) })
}

/// GVFS's own folder for the mount (`$XDG_RUNTIME_DIR/gvfs/dav:host=…`), when it shows one.
#[cfg(target_os = "linux")]
fn gvfs_point(url: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?).join("gvfs");
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let (port, path) = rest.split_once('/')?;
    let token = path.trim_end_matches('/');
    std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        n.starts_with("dav:") && n.contains("host=127.0.0.1") && n.contains(&format!("port={port}")) && n.contains(token)
    })
}

#[cfg(target_os = "linux")]
pub fn unmount(_m: &Mounted, url: &str) -> Result<(), String> {
    let _ = Command::new("gio").arg("mount").arg("-u").arg(dav_url(url)).status();
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn is_mounted(m: &Mounted) -> bool {
    Path::new(&m.point).is_dir()
}

// ---------------------------------------------------------------- Windows (experimental)

#[cfg(target_os = "windows")]
pub fn mount(url: &str, _base: &Path, _name: &str, _read_only: bool) -> Result<Mounted, String> {
    if let Some(why) = unsupported_reason() {
        return Err(why.into());
    }
    let out = Command::new("net").args(["use", "*", url, "/persistent:no"]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("Windows didn't connect the drive. Check that the WebClient service is running.\n\n{detail}"));
    }
    // "Drive Z: is now connected to …"
    let letter = text.split_whitespace().find(|w| w.len() == 2 && w.ends_with(':')).unwrap_or("").to_string();
    Ok(Mounted { point: letter })
}

#[cfg(target_os = "windows")]
pub fn unmount(m: &Mounted, _url: &str) -> Result<(), String> {
    if !m.point.is_empty() {
        let _ = Command::new("net").args(["use", m.point.as_str(), "/delete", "/y"]).status();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn is_mounted(m: &Mounted) -> bool {
    !m.point.is_empty() && Path::new(&format!("{}\\", m.point)).exists()
}

// ---------------------------------------------------------------- showing it

/// Opens the drive in Finder / the file manager / Explorer.
pub fn reveal(m: &Mounted) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let r = Command::new("/usr/bin/open").arg(&m.point).status();
    #[cfg(target_os = "linux")]
    let r = Command::new("xdg-open").arg(&m.point).status();
    #[cfg(target_os = "windows")]
    let r = Command::new("explorer").arg(format!("{}\\", m.point)).status();
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let r: std::io::Result<std::process::ExitStatus> = Err(std::io::Error::other("unsupported"));
    r.map(|_| ()).map_err(|e| format!("Couldn't open the drive.\n\n{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_folder_names() {
        assert_eq!(safe_name("media-prod / photos"), "media-prod - photos");
        assert_eq!(safe_name("a:b*c?"), "a-b-c-");
        assert_eq!(safe_name("  ..  "), "Kybl");
        assert_eq!(safe_name("Fotky 2026"), "Fotky 2026");
    }

    #[test]
    fn the_mount_table_finds_our_line() {
        let table = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n\
            http://127.0.0.1:50123/abc/ on /Users/me/Library/Application Support/app.kybl.desktop/Mounts/My photos (webdav, nodev, noexec, nosuid, mounted by me)\n";
        let p = Path::new("/Users/me/Library/Application Support/app.kybl.desktop/Mounts/My photos");
        assert_eq!(mounted_url(table, p).as_deref(), Some("http://127.0.0.1:50123/abc/"));
        assert_eq!(mounted_url(table, Path::new("/Users/me/Library/Application Support/app.kybl.desktop/Mounts/My")), None);
    }
}
