//! What the engine needs from the app (opening connections, events, the phone notification,
//! "Wi-Fi only"), so tests can run it without Tauri.

use std::sync::{atomic::AtomicBool, Arc};

use async_trait::async_trait;
use tauri::{AppHandle, Manager};

use super::types::JobProgress;
use crate::storage::{SResult, Storage, StorageError};

#[async_trait]
pub trait Host: Send + Sync + 'static {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>>;
    fn emit(&self, _p: &JobProgress) {}
    /// a job began working (`stop` pauses it)
    fn started(&self, _id: &str, _title: &str, _stop: &Arc<AtomicBool>) {}
    fn tick(&self, _id: &str, _done: u64, _total: u64) {}
    /// Some(true) done, Some(false) done with failures or failed, None paused or stopped
    fn ended(&self, _id: &str, _ok: Option<bool>) {}
    /// transfers must wait (on mobile data with "Wi-Fi only" on)
    fn network_blocked(&self) -> bool {
        false
    }
}

pub(super) struct TauriHost {
    pub(super) app: AppHandle,
}

#[async_trait]
impl Host for TauriHost {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>> {
        let state = self.app.state::<crate::state::AppState>();
        crate::storage::registry::open(&self.app, &state, profile_id).await.map_err(StorageError::from)
    }

    fn emit(&self, p: &JobProgress) {
        use tauri::Emitter;
        let _ = self.app.emit("job-progress", p);
    }

    fn started(&self, id: &str, title: &str, _stop: &Arc<AtomicBool>) {
        crate::transfer::notice::queued(&self.app, id, crate::transfer::notice::Dir::Upload, title);
        // Android: the notification's Cancel pauses the job (it stops whatever is in `cancels`).
        // Not on computers: quitting stops those, and a job interrupted by quitting must stay
        // "running" so the next start resumes it.
        #[cfg(target_os = "android")]
        {
            let (app, id, stop) = (self.app.clone(), id.to_string(), _stop.clone());
            tauri::async_runtime::spawn(async move {
                app.state::<crate::state::AppState>().cancels.lock().await.insert(id, stop);
            });
        }
    }

    fn tick(&self, id: &str, done: u64, total: u64) {
        crate::transfer::notice::progress(&self.app, id, done, total);
    }

    fn ended(&self, id: &str, ok: Option<bool>) {
        crate::transfer::notice::finished(&self.app, id, ok);
        #[cfg(target_os = "android")]
        {
            let (app, id) = (self.app.clone(), id.to_string());
            tauri::async_runtime::spawn(async move {
                app.state::<crate::state::AppState>().cancels.lock().await.remove(&id);
            });
        }
    }

    fn network_blocked(&self) -> bool {
        crate::transfer::tuning::wifi_only() && crate::platform::on_metered_network()
    }
}
