//! Opens a connection's backend by profile id and keeps it for the next command.
//!
//! New kinds add one arm to [`build`]. A saved or deleted connection must be [`forget`]-ten so
//! the next command opens it with its new settings.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};

use tauri::{AppHandle, Runtime};

use super::{dal, ftp::FtpBackend, local::LocalBackend, net, s3::S3Backend, sftp::SftpBackend, webdav::WebdavBackend, ConnKind, Storage};
use crate::state::{build_client, client_for, get_secret, load_profiles, secret_key, AppState, NetAuth, NetConfig, Profile};

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
        let s = build(app, state, &profile, None).await?;
        // its "Start when the connection opens" SSH tunnels
        #[cfg(desktop)]
        crate::tunnels::run::autostart(app, &profile);
        s
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
        ConnKind::Webdav | ConnKind::Ftp | ConnKind::Sftp => {
            let cfg = net::net_config(profile.net.as_ref())?;
            let secrets = net_secrets(state, profile, &cfg, secret).await?;
            Ok(match profile.kind {
                ConnKind::Webdav => Arc::new(WebdavBackend::new(&cfg, secrets.password)?) as Arc<dyn Storage>,
                ConnKind::Ftp => Arc::new(FtpBackend::new(&cfg, secrets.password)?),
                _ => Arc::new(SftpBackend::new(&cfg, secrets)?),
            })
        }
        ConnKind::Azblob | ConnKind::Gcs => {
            let blob = profile.blob.clone().unwrap_or_default();
            let secret = match secret.filter(|s| !s.is_empty()) {
                Some(s) => Some(s),
                None => get_secret(state, &profile.id).await?,
            };
            Ok(if profile.kind == ConnKind::Azblob { Arc::new(dal::azblob(&blob, secret)?) } else { Arc::new(dal::gcs(&blob, secret)?) })
        }
        ConnKind::Unknown => Err("This connection was made by a newer version of Kybl. Update Kybl to open it.".into()),
        // WP-A2: the sign-in kinds (tokens from the vault, `{id}#oauth`)
        ConnKind::Gdrive | ConnKind::Onedrive | ConnKind::Dropbox => crate::oauth::open(app, profile),
        // WP-A1 / WP-A2: one arm per kind above this line
        other => Err(format!("{} connections aren't supported by this version of Kybl yet.", other.label())),
    }
}

/// A fresh SFTP backend for connection `profile_id`, not kept: a terminal pane opens its shell
/// with it (`SftpBackend::open_shell`), signed in with the connection's saved credentials.
#[cfg(desktop)]
pub async fn sftp_for<R: Runtime>(app: &AppHandle<R>, state: &AppState, profile_id: &str) -> Result<SftpBackend, String> {
    let profile = load_profiles(app)?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    if profile.kind != ConnKind::Sftp {
        return Err("Terminals open on This Mac and on SFTP connections.".into());
    }
    let cfg = net::net_config(profile.net.as_ref())?;
    let secrets = net_secrets(state, &profile, &cfg, None).await?;
    Ok(SftpBackend::new(&cfg, secrets)?)
}

/// What a server connection signs in with. `secret`, when given (testing unsaved settings), is
/// the password, or for SFTP key sign-in the key (as stored under `{id}#ssh`, see BACKENDS.md).
/// Saved connections read `{id}` (password) and `{id}#ssh` (key); a key saved as the main
/// secret works too.
async fn net_secrets(state: &AppState, profile: &Profile, cfg: &NetConfig, secret: Option<String>) -> Result<net::Secrets, String> {
    let given = secret.filter(|s| !s.is_empty());
    if profile.kind == ConnKind::Sftp && cfg.auth == NetAuth::Key {
        let raw = match given {
            Some(s) => Some(s),
            None => match get_secret(state, &secret_key(&profile.id, "ssh")).await? {
                Some(s) => Some(s),
                None => get_secret(state, &profile.id).await?,
            },
        };
        return Ok(net::Secrets { password: None, ssh: raw.as_deref().and_then(net::SshKey::parse) });
    }
    if profile.kind == ConnKind::Sftp && cfg.auth == NetAuth::Agent {
        return Ok(net::Secrets::default());
    }
    let password = match given {
        Some(s) => Some(s),
        None => get_secret(state, &profile.id).await?,
    };
    Ok(net::Secrets { password, ssh: None })
}

/// An SFTP connection of its own (not the shared one that lists and transfers), for running
/// commands over SSH: custom actions "On the server". The caller disconnects it when done.
pub async fn open_sftp<R: Runtime>(app: &AppHandle<R>, state: &AppState, profile_id: &str) -> Result<SftpBackend, String> {
    let profile = load_profiles(app)?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    if profile.kind != ConnKind::Sftp {
        return Err("Commands run on the server only over SFTP (SSH) connections.".into());
    }
    let cfg = net::net_config(profile.net.as_ref())?;
    let secrets = net_secrets(state, &profile, &cfg, None).await?;
    Ok(SftpBackend::new(&cfg, secrets)?)
}

/// Drops the open backend of a connection (saved with new settings, or deleted).
pub fn forget(profile_id: &str) {
    OPEN.lock().unwrap().remove(profile_id);
}
