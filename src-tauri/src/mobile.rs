//! What a phone needs that a desktop does not: a place to save downloads the person can find,
//! and the names and sizes of files picked from the system picker (on Android those come as
//! `content://` URIs that say neither).

use serde::{Deserialize, Serialize};
use tauri::{plugin::TauriPlugin, AppHandle, Manager, Runtime};

use crate::state::err;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    /// what the transfer reads: a path, or the URI as the picker gave it
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[cfg(target_os = "android")]
struct DocInfo<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Registers the Kotlin side (`DocInfoPlugin` in the Android project) that reads a picked
/// document's display name and size through the ContentResolver.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("docinfo")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let h = _api.register_android_plugin("app.kybl.mobile", "DocInfoPlugin")?;
                _app.manage(DocInfo(h));
            }
            Ok(())
        })
        .build()
}

fn from_path(path: &str) -> Result<PickedFile, String> {
    let p = std::path::Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("{path}: {e}"))?;
    Ok(PickedFile {
        path: path.to_string(),
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
        size: meta.len(),
    })
}

#[tauri::command]
pub async fn picked_files<R: Runtime>(_app: AppHandle<R>, uris: Vec<String>) -> Result<Vec<PickedFile>, String> {
    let mut out = Vec::with_capacity(uris.len());
    for u in uris {
        if let Some(rest) = u.strip_prefix("file://") {
            let path = percent_encoding::percent_decode_str(rest).decode_utf8_lossy().into_owned();
            out.push(PickedFile { path: u.clone(), ..from_path(&path)? });
            continue;
        }
        if !u.contains("://") {
            out.push(from_path(&u)?);
            continue;
        }
        #[cfg(target_os = "android")]
        {
            #[derive(Serialize)]
            struct Args<'a> {
                uri: &'a str,
            }
            #[derive(Deserialize)]
            struct Info {
                name: Option<String>,
                size: Option<u64>,
            }
            let info: Info = _app
                .state::<DocInfo<R>>()
                .0
                .run_mobile_plugin("query", Args { uri: &u })
                .map_err(err)?;
            out.push(PickedFile {
                name: info.name.unwrap_or_else(|| "file".into()),
                size: info.size.unwrap_or(0),
                path: u,
            });
        }
        #[cfg(not(target_os = "android"))]
        return Err(format!("Can't read {u}"));
    }
    Ok(out)
}

/// Where downloads are saved. iOS: the app's Documents folder, which the Files app shows under
/// "On My iPhone › Kybl". Android: `Download/Kybl` in shared storage (apps may create files there
/// without a permission since Android 11), else the app's own downloads folder. Desktop: Downloads.
#[tauri::command]
pub fn download_folder<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let paths = app.path();
    #[cfg(target_os = "ios")]
    let dir = paths.document_dir().map_err(err)?;
    #[cfg(target_os = "android")]
    let dir = {
        let shared = std::path::PathBuf::from("/storage/emulated/0/Download/Kybl");
        let probe = shared.join(".kybl-write-test");
        let ok = std::fs::create_dir_all(&shared).is_ok() && std::fs::write(&probe, b"").is_ok();
        let _ = std::fs::remove_file(&probe);
        if ok { shared } else { paths.download_dir().map_err(err)? }
    };
    #[cfg(desktop)]
    let dir = paths.download_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// WKWebView shrinks its scroll view by the safe areas on its own, which leaves the page short of
/// the screen (a blank band at the bottom) and offsets touches. The page lays itself out around the
/// notch and home bar with `env(safe-area-inset-*)`, so turn that off, along with the rubber band.
#[cfg(target_os = "ios")]
pub fn edge_to_edge<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|pw| unsafe {
        use objc2::{msg_send, runtime::AnyObject};
        let wk = pw.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        let scroll: *mut AnyObject = msg_send![wk, scrollView];
        if scroll.is_null() {
            return;
        }
        // UIScrollViewContentInsetAdjustmentNever
        let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: 2isize];
        let _: () = msg_send![scroll, setBounces: false];
        // Until the page paints, WKWebView shows white. Use the launch screen's colour (light and
        // dark variants in Assets.xcassets) so launch goes straight from the splash to the app.
        let name: *mut AnyObject = msg_send![objc2::class!(NSString), stringWithUTF8String: c"LaunchBackground".as_ptr()];
        let color: *mut AnyObject = msg_send![objc2::class!(UIColor), colorNamed: name];
        if !color.is_null() {
            let _: () = msg_send![wk, setOpaque: false];
            let _: () = msg_send![wk, setBackgroundColor: color];
            let _: () = msg_send![scroll, setBackgroundColor: color];
        }
    });
}

/// Light or dark system chrome (status bar, keyboard, pickers) to match the theme picked in
/// Settings; `None` follows the system. Android does this in MainActivity.kt.
#[tauri::command]
pub fn native_theme<R: Runtime>(window: tauri::WebviewWindow<R>, dark: Option<bool>) {
    #[cfg(target_os = "ios")]
    let _ = window.with_webview(move |pw| unsafe {
        use objc2::{msg_send, runtime::AnyObject};
        let wk = pw.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        let win: *mut AnyObject = msg_send![wk, window];
        if win.is_null() {
            return;
        }
        // UIUserInterfaceStyle: 0 unspecified, 1 light, 2 dark
        let style: isize = match dark {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        };
        let _: () = msg_send![win, setOverrideUserInterfaceStyle: style];
    });
    #[cfg(not(target_os = "ios"))]
    let _ = (window, dark);
}
