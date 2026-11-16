//! Keeps transfers going while the app is in the background, and shows them in the system
//! notifications.
//!
//! On Android a backgrounded app is frozen within seconds, which cuts its connections (the
//! "stream error" a download used to end in). While any upload or download is queued or running,
//! the Kotlin `TransferService` runs as a foreground service: Android leaves the process alone,
//! and its notification shows the combined progress. It goes away when the last transfer ends,
//! with a short "done" notification if the app is not on screen.
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

#[cfg(target_os = "android")]
mod android {
    use super::Dir;
    use serde::Serialize;
    use std::{
        collections::HashMap,
        sync::{Arc, Condvar, Mutex},
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
    }

    impl Notice {
        /// One worker thread talks to Kotlin, at most a couple of times a second and always with
        /// the latest state, so a burst of progress events never queues up behind a slow call.
        pub fn start(handle: PluginHandle<Wry>) -> Self {
            let batch: Arc<(Mutex<Batch>, Condvar)> = Arc::default();
            let shared = batch.clone();
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
                    if snap != last {
                        let cmd = if snap.active == 0 { "stop" } else { "update" };
                        if let Err(e) = handle.run_mobile_plugin::<serde_json::Value>(cmd, snap.clone()) {
                            eprintln!("transfer notification: {e}");
                        }
                        last = if snap.active == 0 { Snapshot::default() } else { snap };
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });
            Notice { batch }
        }

        fn change(&self, f: impl FnOnce(&mut Batch)) {
            let (lock, cv) = &*self.batch;
            let mut b = lock.lock().unwrap();
            f(&mut b);
            b.dirty = true;
            cv.notify_one();
        }

        pub fn queued(&self, id: &str, dir: Dir, name: &str) {
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
