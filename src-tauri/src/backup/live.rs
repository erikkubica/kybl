//! The engine's host in the app: connections, events and "on mobile data?".
//!
//! Backups run in the native worker, which may wake the process with no app (Android
//! WorkManager starts the process without an Activity, so there is no Tauri app). When the app
//! is up, connections come from its registry and status goes to the page as `backup-status`
//! events. When it isn't, connections are opened here from `profiles.json` and the vault, with a
//! state of our own (the app reads the same files when it starts).

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use async_trait::async_trait;

use super::{engine::Host, types::SetStatus};
use crate::{
    state::{build_client, get_secret, load_profiles_from, secret_key, AppState, NetAuth, Profile},
    storage::{dal, ftp::FtpBackend, net, s3::S3Backend, sftp::SftpBackend, webdav::WebdavBackend, ConnKind, SResult, Storage, StorageError},
};

pub const STATUS_EVENT: &str = "backup-status";

/// Where the app keeps its files (Tauri's app config and data folders).
#[derive(Clone, Debug)]
pub struct Paths {
    pub config: PathBuf,
    pub data: PathBuf,
}

pub struct LiveHost {
    paths: Paths,
    opened: Mutex<HashMap<String, Arc<dyn Storage>>>,
}

/// The state background runs use when the app isn't up: the vault (read from the same file the
/// app uses) and its cache.
fn headless_state(data: &PathBuf) -> &'static AppState {
    static STATE: OnceLock<AppState> = OnceLock::new();
    STATE.get_or_init(|| {
        let s = AppState::default();
        let _ = s.vault_dir.set(data.clone());
        s
    })
}

impl LiveHost {
    pub fn new(paths: Paths) -> Self {
        Self { paths, opened: Default::default() }
    }

    /// The app, once it is set up far enough to open connections.
    fn app() -> Option<&'static tauri::AppHandle> {
        use tauri::Manager;
        crate::platform::app().filter(|a| a.try_state::<AppState>().is_some_and(|s| s.vault_dir.get().is_some()))
    }

    async fn open_headless(&self, profile_id: &str) -> SResult<Arc<dyn Storage>> {
        if let Some(s) = self.opened.lock().unwrap().get(profile_id) {
            return Ok(s.clone());
        }
        let state = headless_state(&self.paths.data);
        let profile = load_profiles_from(&self.paths.config.join("profiles.json"))
            .map_err(StorageError::other)?
            .into_iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| StorageError::other("The connection this backup goes to isn't there any more. Choose another destination."))?;
        let s = build(state, &profile).await.map_err(StorageError::from)?;
        self.opened.lock().unwrap().insert(profile_id.to_string(), s.clone());
        Ok(s)
    }
}

/// `storage::registry::build` without an `AppHandle`.
async fn build(state: &'static AppState, profile: &Profile) -> Result<Arc<dyn Storage>, String> {
    match profile.kind {
        ConnKind::S3 => {
            let secret = get_secret(state, &profile.id)
                .await?
                .ok_or("No secret key is stored for this connection. Edit it and enter the key again.")?;
            Ok(Arc::new(S3Backend::new(build_client(profile, &secret), profile)))
        }
        ConnKind::Webdav | ConnKind::Ftp | ConnKind::Sftp => {
            let cfg = net::net_config(profile.net.as_ref())?;
            let mut secrets = net::Secrets::default();
            if profile.kind == ConnKind::Sftp && cfg.auth == NetAuth::Key {
                let raw = match get_secret(state, &secret_key(&profile.id, "ssh")).await? {
                    Some(s) => Some(s),
                    None => get_secret(state, &profile.id).await?,
                };
                secrets.ssh = raw.as_deref().and_then(net::SshKey::parse);
            } else if !(profile.kind == ConnKind::Sftp && cfg.auth == NetAuth::Agent) {
                secrets.password = get_secret(state, &profile.id).await?;
            }
            Ok(match profile.kind {
                ConnKind::Webdav => Arc::new(WebdavBackend::new(&cfg, secrets.password)?) as Arc<dyn Storage>,
                ConnKind::Ftp => Arc::new(FtpBackend::new(&cfg, secrets.password)?),
                _ => Arc::new(SftpBackend::new(&cfg, secrets)?),
            })
        }
        ConnKind::Azblob | ConnKind::Gcs => {
            let blob = profile.blob.clone().unwrap_or_default();
            let secret = get_secret(state, &profile.id).await?;
            Ok(if profile.kind == ConnKind::Azblob { Arc::new(dal::azblob(&blob, secret)?) } else { Arc::new(dal::gcs(&blob, secret)?) })
        }
        ConnKind::Gdrive | ConnKind::Onedrive | ConnKind::Dropbox => crate::oauth::open_without_app(state, profile),
        ConnKind::Local => Err("Backing up to this phone itself needs Kybl to be open.".into()),
        other => Err(format!("{} connections aren't supported by this version of Kybl yet.", other.label())),
    }
}

#[async_trait]
impl Host for LiveHost {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>> {
        if let Some(app) = Self::app() {
            use tauri::Manager;
            let state = app.state::<AppState>();
            return crate::storage::registry::open(app, &state, profile_id).await.map_err(StorageError::from);
        }
        self.open_headless(profile_id).await
    }

    fn emit(&self, s: &SetStatus) {
        if let Some(app) = crate::platform::app() {
            use tauri::Emitter;
            let _ = app.emit(STATUS_EVENT, s);
        }
    }

    fn metered(&self) -> bool {
        crate::platform::on_metered_network()
    }
}
