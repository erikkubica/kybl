//! Dragging items out of Kybl into another app: Finder, Mail, a chat, an editor.
//!
//! Drags inside the window are the page's own (plain mouse events, see `useItemDrag.ts`), so the
//! system never knows a file is being dragged. When such a drag leaves the window the page calls
//! [`start_drag_out`], which starts the system's own drag with the same items from where the
//! pointer is, and the app under it sees files:
//!
//! - Files and folders on this computer (this computer's folders, a copy kept by sync, a copy the
//!   page fetched while the drag was under way) go as plain file URLs, which every app takes.
//! - On macOS anything else goes as a file promise: when it is dropped the receiving app (Finder,
//!   Mail…) names the file it wants written, the page downloads the item there
//!   (`drag-out-promise`, answered with [`drag_out_done`]) and the app gets it when that finished.
//!   Apps that only take ready files (most chat apps) ignore promises, which is why the page
//!   fetches small files before handing over.
//! - Windows and Linux drag ready files only, through the `drag` crate.

use std::{
    path::PathBuf,
    sync::{mpsc, Mutex},
};

use serde::Deserialize;

/// What the page asks to drag, one per selected item.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutItem {
    /// where the item is on this computer, if anywhere (it is checked: a synced copy may not be on
    /// disk yet)
    path: Option<String>,
    /// the name it gets in the receiving app when it has to be promised
    name: String,
    #[serde(default)]
    folder: bool,
}

/// One item of the system drag.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(desktop), allow(dead_code))]
enum Planned {
    /// a real file or folder
    File { path: PathBuf, dir: bool },
    /// a promise of item `index` of the request (macOS)
    Promise { index: usize, name: String, folder: bool },
}

#[cfg_attr(not(desktop), allow(dead_code))]
const NOTHING: &str = "Nothing here can be dragged to another app yet";

/// What goes on the drag: ready items as files, the rest as promises where the system has them
/// (`promises`), else left out.
#[cfg_attr(not(desktop), allow(dead_code))]
fn plan(items: &[DragOutItem], promises: bool) -> Vec<Planned> {
    let mut out = Vec::with_capacity(items.len());
    for (index, it) in items.iter().enumerate() {
        if let Some(p) = it.path.as_deref().filter(|p| !p.is_empty()) {
            let path = PathBuf::from(p);
            // only absolute paths (a relative one would be read against the app's working folder),
            // and none with ".." parts (built from a remote name, it could point anywhere)
            if super::plain_path(p)
                && let Ok(meta) = std::fs::metadata(&path)
            {
                out.push(Planned::File { path, dir: meta.is_dir() });
                continue;
            }
        }
        if promises && let Some(name) = promise_name(&it.name) {
            out.push(Planned::Promise { index, name, folder: it.folder });
        }
    }
    out
}

/// The name a promised item is written under: only the last part of what the page sent (the
/// receiving app joins it to its own folder), never "." or "..".
#[cfg_attr(not(desktop), allow(dead_code))]
fn promise_name(sent: &str) -> Option<String> {
    let name = sent.rsplit(['/', '\\']).find(|n| !n.is_empty())?;
    if name == "." || name == ".." || name.contains('\0') {
        return None;
    }
    Some(name.to_string())
}

/// The drag picture the page drew (a PNG, as a data URL or bare base64).
#[cfg_attr(not(desktop), allow(dead_code))]
fn decode_image(sent: Option<String>) -> Option<Vec<u8>> {
    use base64::Engine;
    let s = sent?;
    let b64 = s.split_once("base64,").map_or(s.as_str(), |(_, b)| b);
    base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok().filter(|b| b.starts_with(b"\x89PNG"))
}

// ---------------------------------------------------------------- promises waiting for the page

type Answer = Result<(), String>;
type Waiter = ((String, usize), mpsc::Sender<Answer>);

/// Promised items being downloaded by the page, by (drag, item index).
static WAITING: Mutex<Vec<Waiter>> = Mutex::new(Vec::new());

/// Waits for the page's answer about item `index` of drag `token` (see [`drag_out_done`]).
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
fn waiter(token: &str, index: usize) -> mpsc::Receiver<Answer> {
    let (tx, rx) = mpsc::channel();
    let mut w = WAITING.lock().unwrap_or_else(|e| e.into_inner());
    w.retain(|(k, _)| !(k.0 == token && k.1 == index));
    w.push(((token.to_string(), index), tx));
    rx
}

fn answer(token: &str, index: usize, result: Answer) -> bool {
    let tx = {
        let mut w = WAITING.lock().unwrap_or_else(|e| e.into_inner());
        let Some(at) = w.iter().position(|(k, _)| k.0 == token && k.1 == index) else {
            return false;
        };
        w.swap_remove(at).1
    };
    tx.send(result).is_ok()
}

// ---------------------------------------------------------------- commands

/// Starts the system drag of `items` from where the pointer is now. The page calls it while its
/// own drag is under way and the pointer has just left the window, with the mouse button still
/// down; when the button is already up there is nothing to drag and it says so. `token` names
/// this drag in the `drag-out-promise` and `drag-out-ended` events.
#[tauri::command]
pub async fn start_drag_out(window: tauri::WebviewWindow, token: String, items: Vec<DragOutItem>, image: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let planned = plan(&items, true);
        if planned.is_empty() {
            return Err(NOTHING.into());
        }
        let image = decode_image(image);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let w = window.clone();
        // AppKit starts drags on the main thread only
        window
            .run_on_main_thread(move || {
                let _ = tx.send(mac::start(&w, token, planned, image));
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "Couldn't start the drag".to_string())?
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let paths: Vec<PathBuf> = plan(&items, false)
            .into_iter()
            .filter_map(|p| match p {
                Planned::File { path, .. } => Some(path),
                Planned::Promise { .. } => None,
            })
            .collect();
        if paths.is_empty() {
            return Err(NOTHING.into());
        }
        let image = decode_image(image).unwrap_or_else(plain::blank_png);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let w = window.clone();
        // OLE and GTK drags start on the UI thread; on Windows this returns when the drop is done
        window
            .run_on_main_thread(move || {
                let _ = tx.send(plain::start(&w, token, paths, image));
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "Couldn't start the drag".to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (window, token, items, image);
        Err("Dragging to other apps works on computers only".into())
    }
}

/// The page finished (or failed) writing promised item `index` of drag `token` where the
/// receiving app asked; that app is told now.
#[tauri::command]
pub fn drag_out_done(token: String, index: usize, error: Option<String>) {
    answer(&token, index, error.map_or(Ok(()), Err));
}

// ---------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
mod mac {
    use std::{path::PathBuf, sync::Mutex, time::Duration};

    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject},
        AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSFilePromiseProvider, NSFilePromiseProviderDelegate, NSImage, NSPasteboardWriting,
        NSWindow, NSWorkspace,
    };
    use objc2_foundation::{
        NSData, NSDictionary, NSError, NSMutableArray, NSNumber, NSOperationQueue, NSPoint, NSProcessInfo, NSRect, NSSize, NSString, NSURL,
    };
    use tauri::{AppHandle, Emitter, Manager};

    use super::Planned;

    /// How long a promised item may take to download before the receiving app is told it failed.
    const PROMISE_WAIT: Duration = Duration::from_secs(24 * 3600);
    /// Drags whose objects are kept alive (see [`KEPT`]).
    const KEEP_DRAGS: usize = 32;

    pub struct SourceIvars {
        token: String,
        app: AppHandle,
        window: Retained<NSWindow>,
    }

    define_class!(
        /// The drag's source: what the drag may do where, and its end.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "KyblDragOutSource"]
        #[ivars = SourceIvars]
        pub struct Source;

        unsafe impl NSObjectProtocol for Source {}

        unsafe impl NSDraggingSource for Source {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn operation_mask(&self, _session: &NSDraggingSession, context: NSDraggingContext) -> NSDragOperation {
                // Back over Kybl the web view would take the files as an upload into the folder
                // they came from: drags inside the window are the page's own. Elsewhere: a copy,
                // never a move, so nothing ever disappears from where it is.
                if context == NSDraggingContext::WithinApplication {
                    NSDragOperation::None
                } else {
                    NSDragOperation::Copy
                }
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &NSDraggingSession, _at: NSPoint, operation: NSDragOperation) {
                let iv = self.ivars();
                let dropped = operation != NSDragOperation::None;
                let _ = iv.app.emit("drag-out-ended", serde_json::json!({ "token": iv.token, "dropped": dropped }));
                release_mouse(&iv.window);
                forget_source(&iv.token, dropped);
            }
        }
    );

    impl Source {
        fn new(mtm: MainThreadMarker, token: String, app: AppHandle, window: Retained<NSWindow>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(SourceIvars { token, app, window });
            unsafe { msg_send![super(this), init] }
        }
    }

    pub struct PromiseIvars {
        token: String,
        /// promised names by request index
        names: Vec<(usize, String, bool)>,
        app: AppHandle,
        /// where the promises are written: not the main thread, which they wait on the page from
        queue: Retained<NSOperationQueue>,
    }

    define_class!(
        /// Writes promised items when the receiving app asks, through the page.
        #[unsafe(super(NSObject))]
        #[name = "KyblDragOutPromises"]
        #[ivars = PromiseIvars]
        pub struct Promises;

        unsafe impl NSObjectProtocol for Promises {}

        unsafe impl NSFilePromiseProviderDelegate for Promises {
            #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
            fn file_name(&self, provider: &NSFilePromiseProvider, _file_type: &NSString) -> Retained<NSString> {
                let name = self.entry(provider).map_or("Untitled", |(_, n, _)| n.as_str());
                NSString::from_str(name)
            }

            #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
            fn write(&self, provider: &NSFilePromiseProvider, url: &NSURL, done: &block2::DynBlock<dyn Fn(*mut NSError)>) {
                let result = match (self.entry(provider), url.path()) {
                    (Some((index, _, folder)), Some(path)) => self.fulfil(*index, PathBuf::from(path.to_string()), *folder),
                    _ => Err("Kybl lost track of that item".to_string()),
                };
                match result {
                    Ok(()) => done.call((std::ptr::null_mut(),)),
                    Err(msg) => {
                        let err = error(&msg);
                        done.call((Retained::as_ptr(&err).cast_mut(),));
                    }
                }
            }

            #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
            fn queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
                self.ivars().queue.clone()
            }
        }
    );

    impl Promises {
        fn new(token: String, names: Vec<(usize, String, bool)>, app: AppHandle) -> Retained<Self> {
            let queue = NSOperationQueue::new();
            let this = Self::alloc().set_ivars(PromiseIvars { token, names, app, queue });
            unsafe { msg_send![super(this), init] }
        }

        /// The promised item behind a provider (its request index rides along as user info).
        fn entry(&self, provider: &NSFilePromiseProvider) -> Option<&(usize, String, bool)> {
            let info = provider.userInfo()?;
            let n = info.downcast::<NSNumber>().ok()?;
            let index = n.unsignedIntegerValue();
            self.ivars().names.iter().find(|(i, _, _)| *i == index)
        }

        /// Asks the page to put the item at `path` and waits for it. Runs on `queue`.
        fn fulfil(&self, index: usize, path: PathBuf, folder: bool) -> Result<(), String> {
            let iv = self.ivars();
            if folder {
                // an empty folder arrives too
                std::fs::create_dir_all(&path).map_err(|e| format!("Couldn't create the folder: {e}"))?;
            }
            let rx = super::waiter(&iv.token, index);
            iv.app
                .emit("drag-out-promise", serde_json::json!({ "token": iv.token, "index": index, "path": path.to_string_lossy() }))
                .map_err(|e| e.to_string())?;
            rx.recv_timeout(PROMISE_WAIT).unwrap_or_else(|_| Err("Kybl stopped waiting for the download".into()))
        }
    }

    fn error(msg: &str) -> Retained<NSError> {
        // the message is what the receiving app may show
        let domain = NSString::from_str("Kybl");
        let key = NSString::from_str("NSLocalizedDescription");
        let value = NSString::from_str(msg);
        let value: &AnyObject = &value;
        let info = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[value]);
        // SAFETY: a dictionary of string keys, as user info should be
        unsafe { NSError::errorWithDomain_code_userInfo(&domain, 1, Some(&info)) }
    }

    /// The objects of recent drags. The drag holds its source only while it runs, and a promise
    /// provider holds its delegate weakly, yet the receiving app asks for promised files after the
    /// drag ended. Touched on the main thread only.
    struct Kept {
        token: String,
        source: Option<Retained<Source>>,
        /// only held, so promise providers still find their delegate
        #[allow(dead_code)]
        promises: Option<Retained<Promises>>,
    }
    // SAFETY: only ever used on the main thread (start and the drag's end run there)
    unsafe impl Send for Kept {}
    static KEPT: Mutex<Vec<Kept>> = Mutex::new(Vec::new());

    fn forget_source(token: &str, dropped: bool) {
        let mut k = KEPT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = k.iter().position(|x| x.token == token) {
            k[at].source = None;
            // nothing landed anywhere: no app will ask for the promises
            if !dropped {
                k.remove(at);
            }
        }
    }

    /// The web view never sees the button go up once the system drag took over, and would act as if
    /// it were still held; give it the release.
    fn release_mouse(window: &NSWindow) {
        let at = window.mouseLocationOutsideOfEventStream();
        let now = NSProcessInfo::processInfo().systemUptime();
        let up = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseUp,
            at,
            NSEventModifierFlags::empty(),
            now,
            window.windowNumber(),
            None,
            0,
            1,
            0.0,
        );
        if let Some(up) = up {
            window.postEvent_atStart(&up, false);
        }
    }

    /// The system icon for an item, at drag size.
    #[allow(deprecated)]
    fn icon(p: &Planned) -> Retained<NSImage> {
        let ws = NSWorkspace::sharedWorkspace();
        let img = match p {
            Planned::File { path, .. } => ws.iconForFile(&NSString::from_str(&path.to_string_lossy())),
            Planned::Promise { folder: true, .. } => ws.iconForFileType(&NSString::from_str("public.folder")),
            Planned::Promise { name, .. } => {
                let ext = name.rsplit_once('.').map_or("", |(_, e)| e);
                ws.iconForFileType(&NSString::from_str(ext))
            }
        };
        img.setSize(NSSize::new(64.0, 64.0));
        img
    }

    /// The page's picture: drawn at twice the size it shows at, for Retina screens.
    fn picture(png: &[u8]) -> Option<Retained<NSImage>> {
        let img = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))?;
        let s = img.size();
        if s.width < 1.0 || s.height < 1.0 {
            return None;
        }
        img.setSize(NSSize::new(s.width / 2.0, s.height / 2.0));
        Some(img)
    }

    pub fn start(window: &tauri::WebviewWindow, token: String, planned: Vec<Planned>, image: Option<Vec<u8>>) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("Not on the main thread")?;
        // the page asked a moment ago: if the button went up since, the drag is over
        if NSEvent::pressedMouseButtons() & 1 == 0 {
            return Err("The mouse button was released".into());
        }
        let raw = window.ns_window().map_err(|e| e.to_string())?;
        // SAFETY: Tauri hands out its live NSWindow; retaining it keeps it valid while we hold it
        let ns_window: Retained<NSWindow> = unsafe { Retained::retain(raw.cast::<NSWindow>()) }.ok_or("The window is gone")?;
        let view = ns_window.contentView().ok_or("The window is gone")?;
        let in_window = ns_window.mouseLocationOutsideOfEventStream();
        let at = view.convertPoint_fromView(in_window, None);
        let app = window.app_handle().clone();

        let names: Vec<(usize, String, bool)> = planned
            .iter()
            .filter_map(|p| match p {
                Planned::Promise { index, name, folder } => Some((*index, name.clone(), *folder)),
                Planned::File { .. } => None,
            })
            .collect();
        let promises = (!names.is_empty()).then(|| Promises::new(token.clone(), names, app.clone()));

        // The page's picture (thumbnail or icon, with the count) on the first item; the others go
        // without one so it reads as one stack. Without a picture each item shows its icon.
        let pic = image.as_deref().and_then(picture);
        let items = NSMutableArray::<NSDraggingItem>::new();
        for (n, p) in planned.iter().enumerate() {
            let writer: Retained<ProtocolObject<dyn NSPasteboardWriting>> = match p {
                Planned::File { path, dir } => {
                    ProtocolObject::from_retained(NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&path.to_string_lossy()), *dir))
                }
                Planned::Promise { index, folder, .. } => {
                    let kind = NSString::from_str(if *folder { "public.folder" } else { "public.data" });
                    let delegate = promises.as_deref().expect("promises exist when an item is promised");
                    let provider = NSFilePromiseProvider::initWithFileType_delegate(NSFilePromiseProvider::alloc(), &kind, ProtocolObject::from_ref(delegate));
                    let idx = NSNumber::numberWithUnsignedInteger(*index);
                    // SAFETY: an NSNumber is a valid user info object
                    unsafe { provider.setUserInfo(Some(&idx)) };
                    ProtocolObject::from_retained(provider)
                }
            };
            let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &writer);
            let img = match &pic {
                Some(pic) if n == 0 => Some(pic.clone()),
                Some(_) => None,
                None => Some(icon(p)),
            };
            let size = img.as_ref().map_or(NSSize::new(64.0, 64.0), |i| i.size());
            let shift = if pic.is_none() { (n.min(4) * 4) as f64 } else { 0.0 };
            let frame = NSRect::new(NSPoint::new(at.x - size.width / 2.0 + shift, at.y - size.height / 2.0 - shift), size);
            // SAFETY: the contents are an NSImage (or none)
            unsafe { item.setDraggingFrame_contents(frame, img.as_deref().map(|i| i.as_ref())) };
            items.addObject(&item);
        }

        // The page's mouse event is long gone by now: a drag event at the pointer stands in for it
        // (AppKit only needs where and when the drag starts).
        let timestamp = NSApplication::sharedApplication(mtm).currentEvent().map_or_else(|| NSProcessInfo::processInfo().systemUptime(), |e| e.timestamp());
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            in_window,
            NSEventModifierFlags::empty(),
            timestamp,
            ns_window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
        .ok_or("Couldn't start the drag")?;

        let source = Source::new(mtm, token.clone(), app, ns_window.clone());
        let session = view.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
        session.setAnimatesToStartingPositionsOnCancelOrFail(true);

        let mut k = KEPT.lock().unwrap_or_else(|e| e.into_inner());
        k.push(Kept { token, source: Some(source), promises });
        if k.len() > KEEP_DRAGS {
            let extra = k.len() - KEEP_DRAGS;
            k.drain(..extra);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- Windows, Linux

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod plain {
    use std::path::PathBuf;

    use tauri::{Emitter, Manager};

    /// A transparent pixel, for when the page sent no picture (the crate wants one).
    pub fn blank_png() -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        let _ = image::RgbaImage::new(1, 1).write_to(&mut out, image::ImageFormat::Png);
        out.into_inner()
    }

    pub fn start(window: &tauri::WebviewWindow, token: String, paths: Vec<PathBuf>, image: Vec<u8>) -> Result<(), String> {
        let app = window.app_handle().clone();
        let ended = move |r: drag::DragResult, _: drag::CursorPosition| {
            let dropped = matches!(r, drag::DragResult::Dropped);
            let _ = app.emit("drag-out-ended", serde_json::json!({ "token": &token, "dropped": dropped }));
        };
        #[cfg(target_os = "windows")]
        let r = drag::start_drag(window, drag::DragItem::Files(paths), drag::Image::Raw(image), ended, drag::Options::default());
        #[cfg(target_os = "linux")]
        let r = {
            let gtk = window.gtk_window().map_err(|e| e.to_string())?;
            drag::start_drag(&gtk, drag::DragItem::Files(paths), drag::Image::Raw(image), ended, drag::Options::default())
        };
        r.map_err(|e| format!("Couldn't start the drag: {e}"))
    }
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

    fn item(path: Option<&str>, name: &str, folder: bool) -> DragOutItem {
        DragOutItem { path: path.map(str::to_string), name: name.into(), folder }
    }

    #[test]
    fn ready_items_go_as_files_and_the_rest_as_promises() {
        let tmp = Tmp(std::env::temp_dir().join(format!("kybl-dragout-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(tmp.0.join("dir")).unwrap();
        std::fs::write(tmp.0.join("a.txt"), b"a").unwrap();
        let file = tmp.0.join("a.txt").to_string_lossy().into_owned();
        let dir = tmp.0.join("dir").to_string_lossy().into_owned();
        let gone = tmp.0.join("not-synced-yet.txt").to_string_lossy().into_owned();
        let items = vec![
            item(Some(&file), "a.txt", false),
            item(Some(&dir), "dir", true),
            item(Some(&gone), "not-synced-yet.txt", false),
            item(None, "photos/", true),
            item(None, "..", false),
            item(Some("relative.txt"), "relative.txt", false),
        ];
        assert_eq!(
            plan(&items, true),
            vec![
                Planned::File { path: file.clone().into(), dir: false },
                Planned::File { path: dir.clone().into(), dir: true },
                Planned::Promise { index: 2, name: "not-synced-yet.txt".into(), folder: false },
                Planned::Promise { index: 3, name: "photos".into(), folder: true },
                Planned::Promise { index: 5, name: "relative.txt".into(), folder: false },
            ]
        );
        // without promises (Windows, Linux) only what is on disk goes
        assert_eq!(
            plan(&items, false),
            vec![Planned::File { path: file.into(), dir: false }, Planned::File { path: dir.into(), dir: true }]
        );
    }

    #[test]
    fn promised_names_are_one_plain_name() {
        assert_eq!(promise_name("report.pdf").as_deref(), Some("report.pdf"));
        assert_eq!(promise_name("a/b/report.pdf").as_deref(), Some("report.pdf"));
        assert_eq!(promise_name("folder/").as_deref(), Some("folder"));
        assert_eq!(promise_name("..\\x.txt").as_deref(), Some("x.txt"));
        assert_eq!(promise_name(".."), None);
        assert_eq!(promise_name(""), None);
        assert_eq!(promise_name("a\0b"), None);
    }

    #[test]
    fn the_picture_must_be_a_png() {
        use base64::Engine;
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        assert_eq!(decode_image(Some(format!("data:image/png;base64,{b64}"))), Some(png.clone()));
        assert_eq!(decode_image(Some(b64)), Some(png));
        assert_eq!(decode_image(Some("data:image/png;base64,bm90IGEgcG5n".into())), None);
        assert_eq!(decode_image(Some("!!".into())), None);
        assert_eq!(decode_image(None), None);
    }

    #[test]
    fn the_page_answers_a_waiting_promise() {
        let rx = waiter("t1", 3);
        assert!(!answer("t1", 2, Ok(())), "nobody waits for item 2");
        drag_out_done("t1".into(), 3, None);
        assert_eq!(rx.recv().unwrap(), Ok(()));
        let rx = waiter("t1", 4);
        drag_out_done("t1".into(), 4, Some("no space left".into()));
        assert_eq!(rx.recv().unwrap(), Err("no space left".into()));
        // answered once only
        assert!(!answer("t1", 4, Ok(())));
    }
}
