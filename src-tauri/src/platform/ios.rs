//! iOS: the `KyblPlatform` Swift package (gen/apple/KyblPlatform, linked by build.rs). Commands
//! that show something (share sheet, preview, Face ID) go through the Tauri plugin; the quick
//! synchronous bits are plain C functions exported from Swift with `@_cdecl`.

use std::ffi::CString;

use tauri::{AppHandle, Manager, Url};

use crate::mobile::PickedFile;

unsafe extern "C" {
    fn kybl_background_begin();
    fn kybl_background_end();
    fn kybl_network_expensive() -> bool;
    fn kybl_copy_opened(url: *const std::ffi::c_char, dest: *const std::ffi::c_char) -> bool;
}

/// Transfers started while none ran: ask iOS for time to finish them if the app is left.
pub fn background_begin() {
    unsafe { kybl_background_begin() }
}

/// The last transfer ended: give that time back (iOS ends apps that keep it too long).
pub fn background_end() {
    unsafe { kybl_background_end() }
}

/// Mobile data, a personal hotspot, or Low Data Mode.
pub fn metered() -> bool {
    unsafe { kybl_network_expensive() }
}

/// Files opened "in Kybl" from Files or another app: copied into the cache (they may only be
/// lent to the app for a moment) and queued like files shared on Android. Off the main thread:
/// a file still in iCloud downloads first.
pub fn opened(app: &AppHandle, urls: &[Url]) {
    let Ok(cache) = app.path().app_cache_dir() else { return };
    let urls = urls.to_vec();
    std::thread::spawn(move || take(cache, urls));
}

fn take(cache: std::path::PathBuf, urls: Vec<Url>) {
    let mut files = Vec::new();
    for url in urls.iter().filter(|u| u.scheme() == "file") {
        let Ok(src) = url.to_file_path() else { continue };
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let dir = cache.join("shared").join(uuid::Uuid::new_v4().to_string());
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let dest = dir.join(&name);
        let (Ok(u), Ok(d)) = (CString::new(url.as_str()), CString::new(dest.to_string_lossy().as_bytes())) else {
            continue;
        };
        // Swift: opens the security scope a file lent from another app needs, and moves files
        // iOS copied into Documents/Inbox instead of leaving them in the Files app
        if !unsafe { kybl_copy_opened(u.as_ptr(), d.as_ptr()) } {
            eprintln!("couldn't take {name} from {url}");
            continue;
        }
        let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        files.push(PickedFile { path: dest.to_string_lossy().into_owned(), name, size });
    }
    super::shared_arrived(files);
}
