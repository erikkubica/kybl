//! "Open with": the apps this computer has for a type of file (or for folders), and opening a
//! file or folder with one of them.
//!
//! The list is asked by type, not by path: a file on S3 has no local copy yet when its menu
//! opens, and the page keeps one list per type for the session so the submenu opens at once.
//!
//! macOS asks Launch Services (every app that says it opens the type, with its icon). Windows and
//! Linux name just the default app; Windows adds the system's own "Choose another app" window.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    /// What `open_with` takes: the app bundle on macOS; "" for "the default app" elsewhere.
    pub path: String,
    pub is_default: bool,
    /// A small PNG as a data URL (macOS), for the menu.
    pub icon: Option<String>,
}

/// The apps that open a file called `name` (only its extension counts) or, with `folder`, a
/// folder. The default one first, then the rest by name. Empty when nothing is known.
#[tauri::command]
pub async fn apps_for(name: String, folder: bool) -> Result<Vec<AppInfo>, String> {
    let ext = if folder { None } else { extension(&name) };
    // Launch Services can take a moment the first time (and making icons is real work)
    tokio::task::spawn_blocking(move || arrange(list(ext.as_deref(), folder)))
        .await
        .map_err(|e| e.to_string())
}

/// Opens a local file or folder with the app `app` (a path from `apps_for`, or one the person
/// picked; "" is the default app).
#[tauri::command]
pub async fn open_with(path: String, app: String) -> Result<(), String> {
    super::must_exist_or_dir(&path)?;
    crate::files::open_copies::handed_out(&path);
    tokio::task::spawn_blocking(move || launch(&path, &app))
        .await
        .map_err(|e| e.to_string())?
}

/// Windows: the system's "How do you want to open this file?" window. Elsewhere the page picks an
/// app itself (macOS) or doesn't offer it.
#[tauri::command]
pub async fn open_with_chooser(path: String) -> Result<(), String> {
    super::must_exist(&path)?;
    crate::files::open_copies::handed_out(&path);
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32")
            .arg("shell32.dll,OpenAs_RunDLL")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't show the list of apps: {e}"))
    }
    #[cfg(not(windows))]
    Err("Choose the app from the list instead.".into())
}

/// "Report.PDF" → "pdf". None for no extension (or a name that only starts with a dot).
fn extension(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 && i + 1 < base.len() => Some(base[i + 1..].to_lowercase()),
        _ => None,
    }
}

/// One entry per app (the same app can be registered twice, say in /Applications and inside
/// another app's bundle): by path, then by name, keeping the default. Default first, then A–Z.
fn arrange(apps: Vec<AppInfo>) -> Vec<AppInfo> {
    let mut out: Vec<AppInfo> = Vec::new();
    for a in apps {
        if let Some(have) = out.iter_mut().find(|o| o.path == a.path || o.name.eq_ignore_ascii_case(&a.name)) {
            if a.is_default && !have.is_default {
                *have = a;
            }
            continue;
        }
        out.push(a);
    }
    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

// ---------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
mod mac {
    use super::AppInfo;
    use objc2::encode::{Encode, Encoding, RefEncode};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::collections::HashMap;
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::sync::Mutex;

    // UTType lives in this framework, which nothing else links
    #[link(name = "UniformTypeIdentifiers", kind = "framework")]
    unsafe extern "C" {}

    /// Folders: terminals open a window there, though they don't say they open folders.
    const FOLDER_EXTRAS: &[&str] = &["com.apple.Terminal", "com.googlecode.iterm2"];

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding = Encoding::Struct(
            "CGRect",
            &[
                Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
                Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }
    unsafe impl RefEncode for CGRect {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }
    #[repr(C)]
    struct CGImage {
        _p: [u8; 0],
    }
    unsafe impl RefEncode for CGImage {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGImage", &[]));
    }

    /// Icons by app path: making one is the slow part, and apps don't change their icon often.
    static ICONS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

    unsafe fn ns_string(s: &str) -> *mut AnyObject {
        let c = CString::new(s).unwrap_or_default();
        unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] }
    }

    unsafe fn rust_string(s: *mut AnyObject) -> Option<String> {
        if s.is_null() {
            return None;
        }
        let p: *const c_char = unsafe { msg_send![s, UTF8String] };
        (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
    }

    unsafe fn url_path(url: *mut AnyObject) -> Option<String> {
        if url.is_null() {
            return None;
        }
        unsafe { rust_string(msg_send![url, path]) }
    }

    pub fn list(ext: Option<&str>, folder: bool) -> Vec<AppInfo> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let ut: *mut AnyObject = match (folder, ext) {
                (true, _) => msg_send![class!(UTType), typeWithIdentifier: ns_string("public.folder")],
                (false, Some(e)) => msg_send![class!(UTType), typeWithFilenameExtension: ns_string(e)],
                (false, None) => msg_send![class!(UTType), typeWithIdentifier: ns_string("public.data")],
            };
            if ws.is_null() || ut.is_null() {
                return Vec::new();
            }
            let default: *mut AnyObject = msg_send![ws, URLForApplicationToOpenContentType: ut];
            let default = url_path(default);
            let urls: *mut AnyObject = msg_send![ws, URLsForApplicationsToOpenContentType: ut];
            let mut paths: Vec<String> = Vec::new();
            if !urls.is_null() {
                let n: usize = msg_send![urls, count];
                for i in 0..n {
                    let u: *mut AnyObject = msg_send![urls, objectAtIndex: i];
                    paths.extend(url_path(u));
                }
            }
            if folder {
                for id in FOLDER_EXTRAS {
                    let u: *mut AnyObject = msg_send![ws, URLForApplicationWithBundleIdentifier: ns_string(id)];
                    paths.extend(url_path(u));
                }
            }
            if let Some(d) = &default
                && !paths.contains(d)
            {
                paths.insert(0, d.clone());
            }
            paths
                .into_iter()
                // not what anyone means: apps inside other apps' bundles (helpers, Xcode's tools),
                // browsers test tools keep in caches, and system helpers such as Archive Utility
                // that claim folders (Finder stays, as the default)
                .filter(|p| {
                    !p.contains(".app/")
                        && !p.contains("/Library/Caches/")
                        && (!p.starts_with("/System/Library/CoreServices/") || Some(p) == default.as_ref())
                })
                .map(|p| AppInfo { name: display_name(&p), icon: icon(&p), is_default: Some(&p) == default.as_ref(), path: p })
                .collect()
        })
    }

    /// The name Finder shows ("Visual Studio Code"), without ".app".
    unsafe fn display_name(path: &str) -> String {
        let fm: *mut AnyObject = unsafe { msg_send![class!(NSFileManager), defaultManager] };
        let name = unsafe { rust_string(msg_send![fm, displayNameAtPath: ns_string(path)]) };
        let name = name.unwrap_or_else(|| super::super::name(path));
        name.strip_suffix(".app").map(str::to_string).unwrap_or(name)
    }

    fn icon(path: &str) -> Option<String> {
        let mut cache = ICONS.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);
        if let Some(i) = cache.get(path) {
            return i.clone();
        }
        let made = unsafe { make_icon(path) };
        cache.insert(path.to_string(), made.clone());
        made
    }

    /// The app's icon at 32×32 pixels (16 points on a Retina screen) as a PNG data URL.
    unsafe fn make_icon(path: &str) -> Option<String> {
        use base64::Engine;
        unsafe {
            let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let img: *mut AnyObject = msg_send![ws, iconForFile: ns_string(path)];
            if img.is_null() {
                return None;
            }
            let mut rect = CGRect { x: 0.0, y: 0.0, w: 32.0, h: 32.0 };
            let nil: *mut AnyObject = std::ptr::null_mut();
            let cg: *mut CGImage = msg_send![img, CGImageForProposedRect: &mut rect as *mut CGRect, context: nil, hints: nil];
            if cg.is_null() {
                return None;
            }
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: *mut AnyObject = msg_send![rep, initWithCGImage: cg];
            if rep.is_null() {
                return None;
            }
            let rep: *mut AnyObject = msg_send![rep, autorelease];
            let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            // NSBitmapImageFileTypePNG
            let data: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: props];
            if data.is_null() {
                return None;
            }
            let bytes: *const c_void = msg_send![data, bytes];
            let len: usize = msg_send![data, length];
            if bytes.is_null() || len == 0 {
                return None;
            }
            let png = std::slice::from_raw_parts(bytes as *const u8, len);
            Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
        }
    }
}

#[cfg(target_os = "macos")]
fn list(ext: Option<&str>, folder: bool) -> Vec<AppInfo> {
    mac::list(ext, folder)
}

#[cfg(target_os = "macos")]
fn launch(path: &str, app: &str) -> Result<(), String> {
    if !app.is_empty() && !std::path::Path::new(app).exists() {
        return Err(format!("{} isn't on this Mac any more.", super::name(app)));
    }
    let mut cmd = std::process::Command::new("/usr/bin/open");
    if !app.is_empty() {
        cmd.arg("-a").arg(app);
    }
    // "--": a file called "-e" stays a file
    let out = cmd.arg("--").arg(path).output().map_err(|e| format!("Couldn't open {}: {e}", super::name(path)))?;
    if out.status.success() {
        Ok(())
    } else {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!("Couldn't open {}. {why}", super::name(path)).trim().to_string())
    }
}

// ---------------------------------------------------------------- Windows

#[cfg(windows)]
#[link(name = "shlwapi")]
unsafe extern "system" {
    fn AssocQueryStringW(flags: u32, what: u32, assoc: *const u16, extra: *const u16, out: *mut u16, len: *mut u32) -> i32;
}

/// What Explorer knows about a type (".pdf", or "Folder"); `what` is an ASSOCSTR value.
#[cfg(windows)]
fn assoc(what: u32, assoc: &str) -> Option<String> {
    // ASSOCF_INIT_IGNOREUNKNOWN: an unknown type has no app (not "Open With")
    const FLAGS: u32 = 0x400;
    let a: Vec<u16> = assoc.encode_utf16().chain(Some(0)).collect();
    let mut len: u32 = 0;
    // the first call only says how long the answer is (S_FALSE)
    let hr = unsafe { AssocQueryStringW(FLAGS, what, a.as_ptr(), std::ptr::null(), std::ptr::null_mut(), &mut len) };
    if (hr != 0 && hr != 1) || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    let hr = unsafe { AssocQueryStringW(FLAGS, what, a.as_ptr(), std::ptr::null(), buf.as_mut_ptr(), &mut len) };
    if hr != 0 {
        return None;
    }
    let s = String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]);
    (!s.trim().is_empty()).then_some(s)
}

#[cfg(windows)]
fn list(ext: Option<&str>, folder: bool) -> Vec<AppInfo> {
    // ASSOCSTR_FRIENDLYAPPNAME
    let key = if folder { "Folder".to_string() } else { format!(".{}", ext.unwrap_or_default()) };
    if !folder && ext.is_none() {
        return Vec::new();
    }
    assoc(4, &key)
        .map(|name| vec![AppInfo { name, path: String::new(), is_default: true, icon: None }])
        .unwrap_or_default()
}

// ---------------------------------------------------------------- Linux

/// The default app from xdg-mime, named as its .desktop file names it.
#[cfg(target_os = "linux")]
fn list(ext: Option<&str>, folder: bool) -> Vec<AppInfo> {
    let mime = if folder {
        "inode/directory".to_string()
    } else {
        ext.and_then(|e| mime_guess::from_ext(e).first()).map(|m| m.essence_str().to_string()).unwrap_or_else(|| "application/octet-stream".into())
    };
    let Ok(out) = std::process::Command::new("xdg-mime").args(["query", "default", &mime]).output() else {
        return Vec::new();
    };
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if id.is_empty() {
        return Vec::new();
    }
    let home = std::env::var("XDG_DATA_HOME")
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.local/share")));
    let dirs = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    let name = home
        .into_iter()
        .chain(dirs.split(':').map(str::to_string))
        .find_map(|d| std::fs::read_to_string(format!("{d}/applications/{id}")).ok())
        .and_then(|f| f.lines().find_map(|l| l.strip_prefix("Name=").map(str::to_string)))
        .unwrap_or_else(|| id.trim_end_matches(".desktop").to_string());
    vec![AppInfo { name, path: String::new(), is_default: true, icon: None }]
}

#[cfg(any(windows, target_os = "linux"))]
fn launch(path: &str, app: &str) -> Result<(), String> {
    if app.is_empty() {
        return tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| format!("Couldn't open {}: {e}", super::name(path)));
    }
    if !std::path::Path::new(app).exists() {
        return Err(format!("{} isn't on this computer any more.", super::name(app)));
    }
    std::process::Command::new(app)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open {}: {e}", super::name(path)))
}

// ---------------------------------------------------------------- phones

#[cfg(mobile)]
fn list(_ext: Option<&str>, _folder: bool) -> Vec<AppInfo> {
    Vec::new()
}

#[cfg(mobile)]
fn launch(_path: &str, _app: &str) -> Result<(), String> {
    Err("Opening with another app works through Open on phones.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, path: &str, is_default: bool) -> AppInfo {
        AppInfo { name: name.into(), path: path.into(), is_default, icon: None }
    }

    #[test]
    fn extensions_come_from_the_last_part_of_the_name() {
        assert_eq!(extension("Report.PDF").as_deref(), Some("pdf"));
        assert_eq!(extension("archive.tar.gz").as_deref(), Some("gz"));
        assert_eq!(extension("docs/v1.2/README"), None);
        assert_eq!(extension(".zshrc"), None);
        assert_eq!(extension("trailing."), None);
    }

    #[test]
    fn the_default_comes_first_then_the_rest_by_name_once_each() {
        let got = arrange(vec![
            app("Zed", "/Applications/Zed.app", false),
            app("TextEdit", "/System/Applications/TextEdit.app", true),
            app("cursor", "/Applications/Cursor.app", false),
            app("Zed", "/Users/x/Applications/Zed.app", false),
            app("Zed", "/Applications/Zed.app", false),
        ]);
        let names: Vec<&str> = got.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["TextEdit", "cursor", "Zed"]);
        assert!(got[0].is_default);
        // a second copy that is the default wins over the first one listed
        let got = arrange(vec![app("Preview", "/a/Preview.app", false), app("Preview", "/b/Preview.app", true)]);
        assert_eq!(got, [app("Preview", "/b/Preview.app", true)]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_services_lists_apps_for_folders_and_files() {
        let folders = arrange(list(None, true));
        assert!(folders.first().is_some_and(|a| a.is_default), "Finder opens folders: {folders:?}");
        let text = arrange(list(Some("txt"), false));
        assert!(text.iter().any(|a| a.name == "TextEdit"), "{text:?}");
        assert!(text.iter().all(|a| a.icon.as_deref().is_none_or(|i| i.starts_with("data:image/png;base64,"))));
    }
}
