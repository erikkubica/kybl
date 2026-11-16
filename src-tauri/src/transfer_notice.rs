//! Keeps transfers going while the app is in the background, and shows them in the system
//! notifications.
//!
//! On Android a backgrounded app is frozen within seconds, which cuts its connections (the
//! "stream error" a download used to end in). While any upload or download is queued or running,
//! the Kotlin `TransferService` runs as a foreground service: Android leaves the process alone,
//! and its notification shows the combined progress. It goes away when the last transfer ends,
//! with a short "done" notification if the app is not on screen.
//!
//! Swiping the app away in the app switcher destroys its screen, and Tauri would end the process
//! with it. While transfers run the process stays instead (`keep_alive_without_window`), the
//! service is driven over JNI rather than through the screen-bound plugin bridge, the process
//! exits once the last transfer ends, and opening Kybl meanwhile makes the window again
//! (`screen_back_without_window`).
//!
//! Elsewhere this is a no-op; `download_file` resuming after a dropped connection covers iOS,
//! which suspends the app and lets the download carry on when it comes back.

use tauri::{plugin::TauriPlugin, AppHandle, Wry};

/// What a transfer is doing, for the notification.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Upload,
    Download,
}

pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("transfernotice")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let h = _api.register_android_plugin("app.kybl.mobile", "TransferPlugin")?;
                _app.manage(android::Notice::start(h));
            }
            Ok(())
        })
        .build()
}

/// A transfer was queued: the service starts (if it isn't running) before the app can be left.
pub fn queued(_app: &AppHandle, _id: &str, _dir: Dir, _name: &str) {
    #[cfg(target_os = "android")]
    android::with(_app, |n| n.queued(_id, _dir, _name));
}

pub fn progress(_app: &AppHandle, _id: &str, _done: u64, _total: u64) {
    #[cfg(target_os = "android")]
    android::with(_app, |n| n.progress(_id, _done, _total));
}

/// A transfer ended: `Some(true)` done, `Some(false)` failed, `None` cancelled.
pub fn finished(_app: &AppHandle, _id: &str, _ok: Option<bool>) {
    #[cfg(target_os = "android")]
    android::with(_app, |n| n.finished(_id, _ok));
}

/// The app's screen went away (swiped off in the app switcher, or left with Back). Tauri ends
/// the process when its last window closes, which on Android would kill running transfers with
/// it. Returns true while transfers run: the process stays (the foreground service keeps it
/// alive, like any upload app) and exits on its own once the last one ends.
#[cfg(mobile)]
pub fn keep_alive_without_window(_app: &AppHandle) -> bool {
    #[cfg(target_os = "android")]
    {
        let mut keep = false;
        android::with(_app, |n| keep = n.keep_alive_without_window());
        keep
    }
    #[cfg(not(target_os = "android"))]
    false
}

/// Android: the process outlived the app's screen for its transfers, and Kybl was opened
/// again. Returns true once (the caller makes the window again); false otherwise.
#[cfg(mobile)]
pub fn screen_back_without_window(_app: &AppHandle) -> bool {
    #[cfg(target_os = "android")]
    {
        let mut back = false;
        android::with(_app, |n| back = n.screen_back_without_window());
        back
    }
    #[cfg(not(target_os = "android"))]
    false
}

/// The window could not be made yet (the new screen is not ready): try again on the next pass.
#[cfg(mobile)]
pub fn window_not_back(_app: &AppHandle) {
    #[cfg(target_os = "android")]
    android::with(_app, |n| n.window_not_back());
}

#[cfg(target_os = "android")]
mod android {
    use super::Dir;
    use serde::Serialize;
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Condvar, Mutex,
        },
        time::Duration,
    };
    use tauri::{plugin::PluginHandle, AppHandle, Manager, Wry};

    pub fn with(app: &AppHandle, f: impl FnOnce(&Notice)) {
        if let Some(n) = app.try_state::<Notice>() {
            f(&n);
        }
    }

    struct Item {
        dir: Dir,
        name: String,
        done: u64,
        total: u64,
    }

    #[derive(Default)]
    struct Batch {
        active: HashMap<String, Item>,
        /// finished since the service started, for the summary
        ok: u32,
        failed: u32,
        uploads: bool,
        downloads: bool,
        /// something changed since the worker last told Kotlin
        dirty: bool,
    }

    /// What Kotlin shows. `active == 0` stops the service.
    #[derive(Serialize, PartialEq, Clone, Default)]
    #[serde(rename_all = "camelCase")]
    struct Snapshot {
        active: u32,
        title: String,
        text: String,
        done: u64,
        total: u64,
        ok: u32,
        failed: u32,
        /// "upload" | "download" | "both", for the summary wording
        kind: &'static str,
    }

    pub struct Notice {
        batch: Arc<(Mutex<Batch>, Condvar)>,
        /// only to ask for the notification permission, while the app is on screen
        plugin: PluginHandle<Wry>,
        asked: AtomicBool,
        /// the window is gone and the process only lives on for the transfers
        windowless: Arc<AtomicBool>,
    }

    impl Notice {
        /// One worker thread talks to Kotlin, at most a couple of times a second and always with
        /// the latest state, so a burst of progress events never queues up behind a slow call.
        pub fn start(handle: PluginHandle<Wry>) -> Self {
            let batch: Arc<(Mutex<Batch>, Condvar)> = Arc::default();
            let shared = batch.clone();
            let windowless = Arc::new(AtomicBool::new(false));
            let gone = windowless.clone();
            std::thread::spawn(move || {
                let mut last = Snapshot::default();
                loop {
                    let snap = {
                        let (lock, cv) = &*shared;
                        let mut b = cv.wait_while(lock.lock().unwrap(), |b| !b.dirty).unwrap();
                        b.dirty = false;
                        let s = snapshot(&b);
                        if s.active == 0 {
                            // the summary is shown once; the next batch counts from zero
                            *b = Batch::default();
                        }
                        s
                    };
                    let idle = snap.active == 0;
                    if snap != last {
                        let cmd = if snap.active == 0 { "stop" } else { "update" };
                        if let Err(e) = tell_service(&snap) {
                            eprintln!("transfer notification ({cmd}): {e}");
                        }
                        last = if snap.active == 0 { Snapshot::default() } else { snap };
                    }
                    if idle && gone.load(Ordering::SeqCst) {
                        // nothing left to do and nothing on screen: end the process as Tauri
                        // would have when the window closed (the summary notification stays)
                        std::thread::sleep(Duration::from_millis(500));
                        std::process::exit(0);
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });
            Notice { batch, windowless, plugin: handle, asked: AtomicBool::new(false) }
        }

        fn change(&self, f: impl FnOnce(&mut Batch)) {
            let (lock, cv) = &*self.batch;
            let mut b = lock.lock().unwrap();
            f(&mut b);
            b.dirty = true;
            cv.notify_one();
        }

        pub fn keep_alive_without_window(&self) -> bool {
            let b = self.batch.0.lock().unwrap();
            let keep = !b.active.is_empty();
            // set under the lock: a transfer ending now still sees it and ends the process
            self.windowless.store(keep, Ordering::SeqCst);
            keep
        }

        pub fn screen_back_without_window(&self) -> bool {
            if !self.windowless.load(Ordering::SeqCst) {
                return false;
            }
            let open = match screens() {
                Ok(n) => n > 0,
                Err(e) => {
                    eprintln!("screens: {e}");
                    false
                }
            };
            // under the lock, like keep_alive_without_window: the last transfer ending now
            // must not end the process the screen is coming back to
            let _b = self.batch.0.lock().unwrap();
            open && self.windowless.swap(false, Ordering::SeqCst)
        }

        pub fn window_not_back(&self) {
            self.windowless.store(true, Ordering::SeqCst);
        }

        pub fn queued(&self, id: &str, dir: Dir, name: &str) {
            // queued from the app's screen, so the plugin (which needs it) can ask once
            if !self.asked.swap(true, Ordering::SeqCst) {
                if let Err(e) = self.plugin.run_mobile_plugin::<serde_json::Value>("askNotifications", ()) {
                    eprintln!("notification permission: {e}");
                }
            }
            self.change(|b| {
                match dir {
                    Dir::Upload => b.uploads = true,
                    Dir::Download => b.downloads = true,
                }
                b.active.insert(id.to_string(), Item { dir, name: name.to_string(), done: 0, total: 0 });
            });
        }

        pub fn progress(&self, id: &str, done: u64, total: u64) {
            self.change(|b| {
                if let Some(it) = b.active.get_mut(id) {
                    it.done = done;
                    it.total = total;
                }
            });
        }

        pub fn finished(&self, id: &str, ok: Option<bool>) {
            self.change(|b| {
                if b.active.remove(id).is_some() {
                    match ok {
                        Some(true) => b.ok += 1,
                        Some(false) => b.failed += 1,
                        None => {}
                    }
                }
            });
        }
    }

    /// Hands the state to `TransferService.fromRust`. Not through the Tauri plugin: that goes via
    /// the app's screen, and the point is to keep going after it has been swiped away.
    fn tell_service(snap: &Snapshot) -> Result<(), String> {
        let json = serde_json::to_string(snap).map_err(|e| e.to_string())?;
        with_class("app.kybl.mobile.TransferService", |env, context, class| {
            let json = env.new_string(&json)?;
            env.call_static_method(
                class,
                "fromRust",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[context.into(), (&json).into()],
            )?;
            Ok(())
        })
    }

    /// How many Kybl screens (activities) exist: `MainActivity.screens()`.
    fn screens() -> Result<i32, String> {
        with_class("app.kybl.mobile.MainActivity", |env, _, class| {
            env.call_static_method(class, "screens", "()I", &[])?.i()
        })
    }

    /// Runs `f` with one of the app's classes over JNI, loaded through the application context
    /// (registered by tao at start-up), which lives as long as the process: it works with or
    /// without the app's screen.
    fn with_class<T>(
        name: &str,
        f: impl FnOnce(&mut jni::JNIEnv, &jni::objects::JObject, &jni::objects::JClass) -> jni::errors::Result<T>,
    ) -> Result<T, String> {
        use jni::{
            objects::{JClass, JObject},
            JavaVM,
        };
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread_permanently().map_err(|e| e.to_string())?;
        let result = (|| {
            let context = unsafe { JObject::from_raw(ctx.context().cast()) };
            let loader = env.call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
            let name = env.new_string(name)?;
            let class: JClass = env
                .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[(&name).into()])?
                .l()?
                .into();
            f(&mut env, &context, &class)
        })();
        if result.is_err() && env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
        result.map_err(|e| e.to_string())
    }

    fn snapshot(b: &Batch) -> Snapshot {
        let n = b.active.len();
        let done: u64 = b.active.values().map(|i| i.done).sum();
        let total: u64 = b.active.values().map(|i| i.total).sum();
        let ups = b.active.values().filter(|i| i.dir == Dir::Upload).count();
        let verb = match (ups, n - ups) {
            (0, _) => "Downloading",
            (_, 0) => "Uploading",
            _ => "Transferring",
        };
        let title = match n {
            0 => String::new(),
            1 => format!("{verb} {}", b.active.values().next().map(|i| i.name.as_str()).unwrap_or("")),
            n => format!("{verb} {n} files"),
        };
        let text = if total > 0 {
            format!("{} of {}", size(done), size(total))
        } else {
            "Starting…".into()
        };
        Snapshot {
            active: n as u32,
            title,
            text,
            done,
            total,
            ok: b.ok,
            failed: b.failed,
            kind: match (b.uploads, b.downloads) {
                (true, true) => "both",
                (true, false) => "upload",
                _ => "download",
            },
        }
    }

    fn size(b: u64) -> String {
        const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
        let mut v = b as f64;
        let mut i = 0;
        while v >= 1024.0 && i < U.len() - 1 {
            v /= 1024.0;
            i += 1;
        }
        if i == 0 {
            format!("{b} B")
        } else if v >= 100.0 {
            format!("{v:.0} {}", U[i])
        } else {
            format!("{v:.1} {}", U[i])
        }
    }
}
