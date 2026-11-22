//! Opens a connection's backend by profile id and keeps it for the next command.
//!
//! New kinds add one arm to [`build`]. A saved or deleted connection must be [`forget`]-ten so
//! the next command opens it with its new settings.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};

use tauri::{AppHandle, Runtime};

use super::{local::LocalBackend, s3::S3Backend, ConnKind, Storage};
use crate::state::{build_client, client_for, load_profiles, AppState, Profile};

/// The reserved connection id of this computer or phone. It is never in `profiles.json`.
pub const LOCAL_ID: &str = "local";

static OPEN: LazyLock<Mutex<HashMap<String, Arc<dyn Storage>>>> = LazyLock::new(Default::default);

/// The backend of a connection, opened once and then reused.
pub async fn open<R: Runtime>(app: &AppHandle<R>, state: &AppState, profile_id: &str) -> Result<Arc<dyn Storage>, String> {
    if let Some(s) = OPEN.lock().unwrap().get(profile_id) {
        return Ok(s.clone());
    }
    let s: Arc<dyn Storage> = if profile_id == LOCAL_ID {
        Arc::new(LocalBackend::system(app).await?)
    } else {
        let profile = load_profiles(app)?
            .into_iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| "Connection not found".to_string())?;
        build(app, state, &profile, None).await?
    };
    OPEN.lock().unwrap().insert(profile_id.to_string(), s.clone());
    Ok(s)
}

/// Opens a backend for `profile` without keeping it. `secret`, when given, is used instead of
/// the stored one (testing a connection before it is saved). Secrets beyond the main one (an
/// OAuth refresh token, an SSH key) are read from the vault under `{id}#oauth` / `{id}#ssh`
/// (see `state::secret_key`).
pub async fn build<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    profile: &Profile,
    secret: Option<String>,
) -> Result<Arc<dyn Storage>, String> {
    match profile.kind {
        ConnKind::S3 => {
            let client = match secret.filter(|s| !s.is_empty()) {
                Some(s) => build_client(profile, &s),
                None => client_for(app, state, &profile.id).await?,
            };
            Ok(Arc::new(S3Backend::new(client, profile)))
        }
        ConnKind::Local => Ok(Arc::new(LocalBackend::system(app).await?)),
        ConnKind::Unknown => Err("This connection was made by a newer version of Kybl. Update Kybl to open it.".into()),
        // WP-A1 / WP-A2: one arm per kind above this line
        other => Err(format!("{} connections aren't supported by this version of Kybl yet.", other.label())),
    }
}

/// Drops the open backend of a connection (saved with new settings, or deleted).
pub fn forget(profile_id: &str) {
    OPEN.lock().unwrap().remove(profile_id);
}
