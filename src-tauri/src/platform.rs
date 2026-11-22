//! The operating system around the files: open them in another app, share them, save them to
//! Photos, a tap of haptic feedback, files shared into Kybl from other apps, unlocking with Face
//! ID / fingerprint, and telling the page when the app comes back to the foreground.
//!
//! Every command exists on every platform, so the page never meets "command not found": what a
//! platform can't do either does nothing (haptics, reveal on phones) or says so plainly.
//!
//! The native halves: `PlatformPlugin.kt` and friends in the Android project, and the
//! `KyblPlatform` Swift package (gen/apple/KyblPlatform, linked by build.rs) on iOS.

#[cfg(target_os = "android")]
pub(crate) mod android;
#[cfg(target_os = "ios")]
pub(crate) mod ios;
/// The Android secret-key file, sealed with a Keystore key (generic, so it is tested here).
#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
pub mod vault;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use tauri::{plugin::TauriPlugin, AppHandle, Emitter, RunEvent, Wry};

use crate::mobile::PickedFile;

/// The app, for events that start on the native side (a share arriving, a notification tapped).
static APP: OnceLock<AppHandle> = OnceLock::new();

/// The page has loaded and can hear events. Until then they wait (see `page_loaded`).
static PAGE_READY: AtomicBool = AtomicBool::new(false);
/// A transfer notification was tapped before the page could hear about it.
static OPEN_TRANSFERS: AtomicBool = AtomicBool::new(false);
/// Files shared into Kybl, waiting for the page to take them.
static SHARED: Mutex<Vec<PickedFile>> = Mutex::new(Vec::new());

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_kyblplatform);

#[cfg(mobile)]
struct Native(tauri::plugin::PluginHandle<Wry>);

pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("kyblplatform")
        .setup(|app, _api| {
            let _ = APP.set(app.clone());
            #[cfg(mobile)]
            {
                use tauri::Manager;
                if let Ok(cache) = app.path().app_cache_dir() {
                    std::thread::spawn(move || prune_shared(&cache.join("shared")));
                }
            }
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(Native(_api.register_android_plugin("app.kybl.mobile", "PlatformPlugin")?));
            }
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                app.manage(Native(_api.register_ios_plugin(init_plugin_kyblplatform)?));
            }
            Ok(())
        })
        .on_page_load(|_webview, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started => PAGE_READY.store(false, Ordering::SeqCst),
            tauri::webview::PageLoadEvent::Finished => page_loaded(),
        })
        .on_event(on_event)
        .build()
}

/// The app, once set up.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Shared files are copied into `cache/shared/<id>/` (Android: ShareIntake.kt, iOS: `ios::opened`).
/// Uploads read them from there; after two days they have long been uploaded or forgotten.
#[cfg(mobile)]
fn prune_shared(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(2 * 24 * 3600));
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// The page's listeners attach in React effects, a moment after the load event: give them that
/// moment before handing over what happened while the page was starting.
fn page_loaded() {
    PAGE_READY.store(true, Ordering::SeqCst);
    let open = OPEN_TRANSFERS.swap(false, Ordering::SeqCst);
    let shared = !SHARED.lock().unwrap().is_empty();
    if !open && !shared {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let Some(app) = APP.get() else { return };
        if open {
            let _ = app.emit("open-transfers", ());
        }
        let waiting = SHARED.lock().unwrap().clone();
        if !waiting.is_empty() {
            let _ = app.emit("shared-files", waiting);
        }
    });
}

/// A transfer notification was tapped: the page shows Transfers.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn open_transfers() {
    match APP.get() {
        Some(app) if PAGE_READY.load(Ordering::SeqCst) => {
            let _ = app.emit("open-transfers", ());
        }
        _ => OPEN_TRANSFERS.store(true, Ordering::SeqCst),
    }
}

/// Files another app shared into Kybl (already copied into the app's cache): queued for
/// `take_shared_files`, and announced to the page if it is listening.
#[cfg_attr(not(mobile), allow(dead_code))]
pub(crate) fn shared_arrived(files: Vec<PickedFile>) {
    if files.is_empty() {
        return;
    }
    SHARED.lock().unwrap().extend(files.iter().cloned());
    if let Some(app) = APP.get() {
        if PAGE_READY.load(Ordering::SeqCst) {
            let _ = app.emit("shared-files", files);
        }
    }
}

/// The files shared into Kybl that are waiting for a destination. Taking them clears the queue.
#[tauri::command]
pub fn take_shared_files() -> Vec<PickedFile> {
    std::mem::take(&mut *SHARED.lock().unwrap())
}

/// Desktop: how long the window must have been in the background for coming back to count as
/// a return (a quick alt-tab to copy something is not).
#[cfg(desktop)]
const AWAY_FOR: Duration = Duration::from_secs(30);

static LAST: Mutex<Option<Instant>> = Mutex::new(None);

fn on_event(app: &AppHandle, event: &RunEvent) {
    match event {
        // Android: the screen was swiped away while transfers run; until a new page loads,
        // events wait (see `page_loaded`)
        RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. } => PAGE_READY.store(false, Ordering::SeqCst),
        #[cfg(desktop)]
        RunEvent::WindowEvent { label, event: tauri::WindowEvent::Focused(focused), .. } if label == "main" => {
            // LAST holds when the window lost focus
            let mut last = LAST.lock().unwrap();
            if !focused {
                *last = Some(Instant::now());
            } else if let Some(since) = last.take() {
                if since.elapsed() >= AWAY_FOR {
                    let _ = app.emit("app-resumed", ());
                }
            }
        }
        #[cfg(mobile)]
        RunEvent::WindowEvent { event: tauri::WindowEvent::Resumed, .. } => {
            // iOS can report the return twice (scene and app delegate): once is enough. LAST
            // holds when it was last reported.
            let mut last = LAST.lock().unwrap();
            if last.is_none_or(|t| t.elapsed() > Duration::from_secs(1)) {
                *last = Some(Instant::now());
                let _ = app.emit("app-resumed", ());
            }
        }
        // iOS: a file opened "in Kybl" from Files or another app's share sheet
        #[cfg(target_os = "ios")]
        RunEvent::Opened { urls } => ios::opened(app, urls),
        _ => {
            let _ = app;
        }
    }
}

/// The phone is on a metered connection (mobile data, a hotspot, Low Data Mode). For the
/// "Wi-Fi only" transfer setting; always false on computers.
#[allow(dead_code)]
pub fn on_metered_network() -> bool {
    #[cfg(target_os = "android")]
    return android::metered();
    #[cfg(target_os = "ios")]
    return ios::metered();
    #[cfg(desktop)]
    false
}

/// What iOS and Android call the file type, for the share sheet and "Open with".
#[cfg_attr(desktop, allow(dead_code))]
fn mime(path: &str) -> String {
    mime_guess::from_path(path).first_or_octet_stream().essence_str().to_string()
}

/// The file's name for messages ("photo.jpg"), else the path.
fn name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn must_exist(path: &str) -> Result<(), String> {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(format!("{} isn't a file.", name(path))),
        Err(_) => Err(format!("{} isn't on this device any more.", name(path))),
    }
}

/// Runs a command of the native plugin without holding up the async runtime while, say, the
/// share sheet or the Face ID prompt is up.
#[cfg(mobile)]
async fn native<T: serde::de::DeserializeOwned>(app: &AppHandle, cmd: &str, args: serde_json::Value) -> Result<T, String> {
    use tauri::Manager;
    let Some(n) = app.try_state::<Native>() else {
        return Err("Kybl isn't ready yet. Try again in a moment.".into());
    };
    n.0.run_mobile_plugin_async(cmd, args).await.map_err(|e| match e {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => {
            r.message.unwrap_or_else(|| "Something went wrong.".into())
        }
        e => e.to_string(),
    })
}

/// Opens a local file in its default app (computers), or with an "Open with" choice (Android) /
/// a preview with "Open in…" (iOS).
#[tauri::command]
pub async fn open_local(app: AppHandle, path: String) -> Result<(), String> {
    must_exist(&path)?;
    #[cfg(desktop)]
    {
        let _ = app;
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| format!("Couldn't open {}: {e}", name(&path)))
    }
    #[cfg(mobile)]
    {
        let mime = mime(&path);
        native(&app, "openFile", serde_json::json!({ "path": path, "mime": mime })).await
    }
}

/// Puts a local file on the clipboard as a file (not its path as text), so it pastes into a chat,
/// a mail or a Finder window like a file copied in Finder. macOS for now; elsewhere it says so.
#[tauri::command]
pub async fn copy_file_to_clipboard(app: AppHandle, path: String) -> Result<(), String> {
    must_exist(&path)?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        // AppKit wants the pasteboard on the main thread
        app.run_on_main_thread(move || {
            let _ = tx.send(pasteboard_file(&path));
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "Couldn't reach the clipboard".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Copying files to the clipboard works on macOS for now. Download the file instead.".into())
    }
}

#[cfg(target_os = "macos")]
fn pasteboard_file(path: &str) -> Result<(), String> {
    use objc2::{class, msg_send, runtime::AnyObject, runtime::Bool};
    let c = std::ffi::CString::new(path).map_err(|_| "That file name can't go on the clipboard".to_string())?;
    unsafe {
        let s: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: s];
        if url.is_null() {
            return Err("Couldn't copy the file".into());
        }
        let items: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: url];
        let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![pb, clearContents];
        let ok: Bool = msg_send![pb, writeObjects: items];
        if ok.as_bool() {
            Ok(())
        } else {
            Err("Couldn't copy the file to the clipboard".into())
        }
    }
}

/// Shows the file in Finder / Explorer / the file manager. Phones have no such place to show:
/// nothing happens.
/// Saves bytes the web view holds (a photo or video just taken with the camera picker) as a new
/// file in the temporary folder, for an upload. Raw body; name in the `x-file-name` header.
///
/// Big captures (minutes of 4K video) come in chunks, so the page never holds the whole file:
/// the first call creates the file and each next one names it in `x-append-to` (the path the first
/// call returned, URI-encoded) to add its bytes to the end. That path comes from the page, so only
/// an existing file inside the temporary folder can be appended to.
#[tauri::command]
pub async fn write_temp_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes".into());
    };
    let temp = std::path::PathBuf::from(temp_folder(app).await?);
    if let Some(target) = request.headers().get("x-append-to").and_then(|v| v.to_str().ok()) {
        let path = std::path::PathBuf::from(percent_decode(target));
        // links and ".." resolved before comparing
        let real = tokio::fs::canonicalize(&path).await.map_err(|_| "That temporary file is gone".to_string())?;
        let root = tokio::fs::canonicalize(&temp).await.map_err(|e| format!("Couldn't save the file: {e}"))?;
        if !real.starts_with(&root) || !real.is_file() {
            return Err("Can only add to Kybl's own temporary files".into());
        }
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&real)
            .await
            .map_err(|e| format!("Couldn't save the file: {e}"))?;
        f.write_all(bytes).await.map_err(|e| format!("Couldn't save the file: {e}"))?;
        f.flush().await.map_err(|e| format!("Couldn't save the file: {e}"))?;
        return Ok(path.to_string_lossy().into_owned());
    }
    let raw = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("photo.jpg");
    let name = temp_file_name(&percent_decode(raw), cfg!(windows));
    let dir = temp.join(format!(
        "{:x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Couldn't save the file: {e}"))?;
    let path = dir.join(name);
    tokio::fs::write(&path, bytes).await.map_err(|e| format!("Couldn't save the file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// A safe file name for [`write_temp_file`] from the name the page sent: only its last path part,
/// never "." or "..". On Windows also nothing it can't hold or that means something else there:
/// `:` (an alternate data stream), `<>"|?*`, control characters, a trailing dot or space, or a
/// device name such as CON or NUL (with any extension). Anything like that gets a plain name.
fn temp_file_name(sent: &str, windows: bool) -> String {
    const FALLBACK: &str = "photo.jpg";
    let Some(name) = sent.rsplit(['/', '\\']).find(|n| !n.is_empty() && *n != "." && *n != "..") else {
        return FALLBACK.into();
    };
    if name.contains('\0') {
        return FALLBACK.into();
    }
    if windows {
        let bad_char = name.chars().any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'));
        let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
        if bad_char || device || name.ends_with(['.', ' ']) {
            // keep the type, which the upload's content type comes from
            return match name.rsplit_once('.').map(|(_, ext)| ext) {
                Some(ext) if !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()) => format!("photo.{ext}"),
                _ => FALLBACK.into(),
            };
        }
    }
    name.to_string()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A per-app scratch folder for files opened in another app ("Open" on desktop, "Open in…" on
/// phones). Emptied at startup, so it never grows without bound.
#[tauri::command]
pub async fn temp_folder(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("open");
    static CLEANED: std::sync::Once = std::sync::Once::new();
    let fresh = !CLEANED.is_completed();
    CLEANED.call_once(|| {});
    if fresh {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Couldn't create a temporary folder: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn reveal_local(path: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        must_exist(&path)?;
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("Couldn't show {}: {e}", name(&path)))
    }
    #[cfg(mobile)]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(desktop)]
const NO_SHARING: &str = "Sharing isn't available on this computer.";

/// The system share sheet with local files.
#[tauri::command]
pub async fn share_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in &paths {
        must_exist(p)?;
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Err(NO_SHARING.into())
    }
    #[cfg(mobile)]
    {
        let mimes: Vec<String> = paths.iter().map(|p| mime(p)).collect();
        native(&app, "share", serde_json::json!({ "paths": paths, "mimes": mimes })).await
    }
}

/// The system share sheet with text, such as a share link.
#[tauri::command]
pub async fn share_text(app: AppHandle, text: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let _ = (app, text);
        Err(NO_SHARING.into())
    }
    #[cfg(mobile)]
    native(&app, "share", serde_json::json!({ "text": text })).await
}

/// iOS: adds a photo or video to the photo library. Android: copies it into Pictures/Kybl or
/// Movies/Kybl, where the Gallery and Google Photos find it.
#[tauri::command]
pub async fn save_to_photos(app: AppHandle, path: String) -> Result<(), String> {
    must_exist(&path)?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    if !matches!(mime.type_().as_str(), "image" | "video") {
        return Err(format!("{} isn't a photo or video.", name(&path)));
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Err("Saving to Photos is only on phones.".into())
    }
    #[cfg(mobile)]
    native(&app, "saveToPhotos", serde_json::json!({ "path": path, "mime": mime.essence_str() })).await
}

/// A tap of haptic feedback: "selection" | "light" | "medium" | "success" | "warning" | "error".
/// Nothing on computers, and never an error: a missed buzz isn't worth a message.
#[tauri::command]
pub async fn haptic(app: AppHandle, kind: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _: Result<serde_json::Value, String> = native(&app, "haptic", serde_json::json!({ "kind": kind })).await;
    }
    #[cfg(desktop)]
    let _ = (app, kind);
    Ok(())
}

/// App lock: asks for Face ID / Touch ID / fingerprint (or the device passcode). True when the
/// person unlocked, false when they cancelled; an error when the phone has no lock set up.
#[tauri::command]
pub async fn biometric_unlock(app: AppHandle, reason: String) -> Result<bool, String> {
    #[cfg(mobile)]
    {
        #[derive(serde::Deserialize)]
        struct Unlocked {
            ok: bool,
        }
        let r: Unlocked = native(&app, "biometric", serde_json::json!({ "reason": reason })).await?;
        Ok(r.ok)
    }
    #[cfg(desktop)]
    {
        let _ = (app, reason);
        Err("Unlocking with Touch ID or a fingerprint is only on phones.".into())
    }
}

/// App lock on: hide the app's content in the app switcher and from screenshots (Android), or
/// cover it with a blur while the app isn't active (iOS). Nothing on computers.
#[tauri::command]
pub async fn set_privacy_screen(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(mobile)]
    return native(&app, "privacyScreen", serde_json::json!({ "enabled": enabled })).await;
    #[cfg(desktop)]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

/// Android: asks once per run for the storage permission Android 7–10 need for writing to the
/// shared Download folder. True when it is granted.
#[cfg(target_os = "android")]
pub(crate) async fn ask_storage(app: &AppHandle) -> bool {
    static ASKED: AtomicBool = AtomicBool::new(false);
    if ASKED.swap(true, Ordering::SeqCst) {
        return false;
    }
    #[derive(serde::Deserialize)]
    struct Granted {
        granted: bool,
    }
    native::<Granted>(app, "askStorage", serde_json::json!({})).await.map(|g| g.granted).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_files_get_names_the_system_can_hold() {
        for w in [false, true] {
            assert_eq!(temp_file_name("IMG_0001.HEIC", w), "IMG_0001.HEIC");
            assert_eq!(temp_file_name("../../x/clip.mov", w), "clip.mov");
            assert_eq!(temp_file_name("..", w), "photo.jpg");
            assert_eq!(temp_file_name("", w), "photo.jpg");
        }
        // only Windows minds these
        assert_eq!(temp_file_name("a:b.jpg", false), "a:b.jpg");
        assert_eq!(temp_file_name("a:b.jpg", true), "photo.jpg");
        assert_eq!(temp_file_name("shot:stream.png", true), "photo.png");
        assert_eq!(temp_file_name("what?.mp4", true), "photo.mp4");
        assert_eq!(temp_file_name("CON.jpg", true), "photo.jpg");
        assert_eq!(temp_file_name("nul", true), "photo.jpg");
        assert_eq!(temp_file_name("com1.txt", true), "photo.txt");
        assert_eq!(temp_file_name("lpt9", true), "photo.jpg");
        assert_eq!(temp_file_name("dot.", true), "photo.jpg");
        assert_eq!(temp_file_name("COMé.jpg", true), "COMé.jpg");
        assert_eq!(temp_file_name("console.jpg", true), "console.jpg");
    }

    #[test]
    fn shared_files_are_handed_over_once() {
        let f = |n: &str| PickedFile { path: format!("/cache/{n}"), name: n.into(), size: 1 };
        shared_arrived(vec![f("a.jpg"), f("b.pdf")]);
        shared_arrived(vec![]);
        let got: Vec<String> = take_shared_files().into_iter().map(|p| p.name).collect();
        assert_eq!(got, ["a.jpg", "b.pdf"]);
        assert!(take_shared_files().is_empty(), "taking them clears the queue");
    }

    #[test]
    fn only_photos_and_videos_go_to_photos() {
        assert_eq!(mime("IMG_0001.HEIC"), "image/heic");
        assert_eq!(mime("clip.mov"), "video/quicktime");
        assert_eq!(mime("notes"), "application/octet-stream");
    }
}
