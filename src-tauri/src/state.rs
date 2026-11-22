use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, OnceLock},
};

use aws_sdk_s3::{
    config::{
        BehaviorVersion, Credentials, Region, RequestChecksumCalculation,
        ResponseChecksumValidation, StalledStreamProtectionConfig,
    },
    error::DisplayErrorContext,
    Client,
};
use aws_smithy_http_client::{
    tls::{rustls_provider::CryptoMode, Provider},
    Builder as HttpBuilder,
};
use aws_sdk_s3::config::SharedHttpClient;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::{Mutex, Semaphore};

#[cfg_attr(target_os = "android", allow(dead_code))]
pub const KEYRING_SERVICE: &str = "app.kybl.desktop";

/// Account name of the single keychain item that holds every connection's secret key
/// (a JSON map of profile id -> secret). One item means one keychain prompt, not one per connection.
#[cfg_attr(target_os = "android", allow(dead_code))]
const VAULT_ACCOUNT: &str = "connection-secrets";

/// A saved connection. The secret key never lives in this struct on disk:
/// it is kept in the OS keychain (see [`get_secret`]).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    pub bucket: Option<String>,
    pub path_style: bool,
}

pub struct AppState {
    pub clients: Mutex<HashMap<String, Client>>,
    /// Secrets read from the keychain vault item; `None` until first use.
    pub secrets: Mutex<Option<HashMap<String, String>>>,
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Three transfers at a time per connection, so a long upload queue in one connection never
    /// holds up a download in another.
    transfer_slots: Mutex<HashMap<String, Arc<Semaphore>>>,
    pub thumb_slots: Arc<Semaphore>,
    /// Where the Android vault file lives (the app's private data folder); set at startup.
    pub vault_dir: OnceLock<PathBuf>,
}

const TRANSFERS_PER_CONNECTION: usize = 3;

impl AppState {
    pub async fn transfer_slots(&self, profile_id: &str) -> Arc<Semaphore> {
        self.transfer_slots
            .lock()
            .await
            .entry(profile_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(TRANSFERS_PER_CONNECTION)))
            .clone()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            secrets: Mutex::new(None),
            cancels: Mutex::new(HashMap::new()),
            transfer_slots: Mutex::new(HashMap::new()),
            thumb_slots: Arc::new(Semaphore::new(4)),
            vault_dir: OnceLock::new(),
        }
    }
}

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// A storage error as shown to people: a plain sentence saying what went wrong and what to do,
/// then a blank line and the full technical error (the UI keeps that part behind "Details").
/// Errors with no known reading come through as the technical text alone.
pub fn sdk_err<E: std::error::Error + 'static>(e: E) -> String {
    let raw = DisplayErrorContext(&e).to_string();
    match friendly(&e, &raw) {
        Some(say) => format!("{say}\n\n{raw}"),
        None => raw,
    }
}

/// Just the plain sentence when there is one, for short lists such as sync problems.
#[cfg_attr(mobile, allow(dead_code))]
pub fn sdk_err_brief<E: std::error::Error + 'static>(e: E) -> String {
    let raw = DisplayErrorContext(&e).to_string();
    friendly(&e, &raw).map(str::to_string).unwrap_or(raw)
}

const REFUSED: &str = "Can't reach the storage server. Nothing is answering at that address: check the connection's endpoint, or that the server is running.";
const TIMED_OUT: &str = "The storage server didn't answer in time. Check your internet connection and the connection's endpoint.";
const DROPPED: &str = "The connection to the storage server dropped. Try again.";

/// Reads what went wrong from the error chain (network failures) and the S3 error code.
fn friendly(e: &(dyn std::error::Error + 'static), raw: &str) -> Option<&'static str> {
    use std::io::ErrorKind;
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(c) = cur {
        if let Some(io) = c.downcast_ref::<std::io::Error>() {
            match io.kind() {
                ErrorKind::ConnectionRefused => return Some(REFUSED),
                ErrorKind::TimedOut => return Some(TIMED_OUT),
                ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::BrokenPipe => return Some(DROPPED),
                _ => {}
            }
        }
        cur = c.source();
    }
    let has = |needles: &[&str]| needles.iter().any(|n| raw.contains(n));
    let lower = raw.to_ascii_lowercase();
    let says = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    Some(if has(&["InvalidAccessKeyId"]) {
        "This server doesn't recognise the access key. Edit the connection and check the access key."
    } else if has(&["SignatureDoesNotMatch"]) {
        "The secret key doesn't match the access key. Edit the connection and enter the secret key again."
    } else if has(&["ExpiredToken", "TokenRefreshRequired"]) {
        "The connection's credentials have expired. Edit the connection and enter fresh keys."
    } else if has(&["RequestTimeTooSkewed"]) {
        "Your computer's clock is off, so the server refuses requests. Set the clock automatically and try again."
    } else if has(&["NoSuchBucket"]) {
        "This bucket doesn't exist on the server, or it was deleted."
    } else if has(&["NoSuchKey"]) {
        "This file isn't there any more. It may have been moved or deleted."
    } else if has(&["PermanentRedirect", "AuthorizationHeaderMalformed", "IncorrectEndpoint"]) {
        "This bucket lives in another region. Edit the connection and set its region."
    } else if has(&["AccessDenied", "AllAccessDisabled"]) || says(&["status: 403", "forbidden"]) {
        "Access denied. This key isn't allowed to do that. If the key is brand new, give it a few minutes: some providers take a while to activate new keys."
    } else if has(&["SlowDown", "TooManyRequests"]) || says(&["status: 429", "status: 503"]) {
        "The server is busy and asked to slow down. Try again in a moment."
    } else if has(&["NotImplemented"]) {
        "This storage server doesn't support that operation."
    } else if has(&["EntityTooLarge"]) {
        "The file is too large for this server."
    } else if has(&["QuotaExceeded", "XMinioStorageFull"]) {
        "The storage is full, or over its quota."
    } else if has(&["InternalError"]) || says(&["status: 500", "status: 502"]) {
        "The storage server ran into a problem of its own. Try again later."
    } else if says(&["connection refused"]) {
        REFUSED
    } else if says(&["dns error", "failed to lookup address", "nodename nor servname", "name or service not known"]) {
        "Can't find the storage server. Check the connection's endpoint address and your internet connection."
    } else if says(&["certificate", "handshake"]) {
        "Couldn't open a secure connection to the server: its certificate isn't trusted. Check the endpoint address."
    } else if says(&["timeouterror", "timed out", "operation timeout"]) {
        TIMED_OUT
    } else if says(&["connection reset", "broken pipe", "connection closed"]) {
        DROPPED
    } else if says(&["dispatchfailure"]) {
        "Can't reach the storage server. Check your internet connection and the connection's endpoint."
    } else {
        return None;
    })
}

fn profiles_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("profiles.json"))
}

pub fn load_profiles<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Profile>, String> {
    let path = profiles_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(path).map_err(err)?;
    serde_json::from_str(&raw).map_err(err)
}

pub fn save_profiles<R: Runtime>(app: &AppHandle<R>, profiles: &[Profile]) -> Result<(), String> {
    let path = profiles_path(app)?;
    let raw = serde_json::to_string_pretty(profiles).map_err(err)?;
    std::fs::write(path, raw).map_err(err)
}

#[cfg(not(target_os = "android"))]
mod vault {
    use std::collections::HashMap;

    use super::{err, KEYRING_SERVICE, VAULT_ACCOUNT};

    /// Legacy storage: one keychain item per connection. Only read to migrate into the vault.
    pub struct Legacy(keyring::Entry);

    impl Legacy {
        pub fn get(&self) -> Option<String> {
            self.0.get_password().ok()
        }
        pub fn delete(&self) {
            let _ = self.0.delete_credential();
        }
    }

    pub fn legacy(profile_id: &str) -> Option<Legacy> {
        keyring::Entry::new(KEYRING_SERVICE, profile_id).ok().map(Legacy)
    }

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, VAULT_ACCOUNT).map_err(err)
    }

    pub fn read(_dir: Option<&std::path::Path>) -> Result<HashMap<String, String>, String> {
        match entry()?.get_password() {
            Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
            Err(keyring::Error::NoEntry) => Ok(HashMap::new()),
            Err(e) => Err(format!("Could not read the secret keys from the keychain: {e}")),
        }
    }

    pub fn write(_dir: Option<&std::path::Path>, map: &HashMap<String, String>) -> Result<(), String> {
        let raw = serde_json::to_string(map).map_err(err)?;
        entry()?
            .set_password(&raw)
            .map_err(|e| format!("Could not save the secret key to the keychain: {e}"))
    }
}

/// Android has no keychain the `keyring` crate can reach, so the vault is a file in the app's
/// private storage: other apps cannot read it, and the manifest keeps it out of cloud backups.
#[cfg(target_os = "android")]
mod vault {
    use std::collections::HashMap;
    use std::path::Path;

    pub struct Legacy;

    impl Legacy {
        pub fn get(&self) -> Option<String> {
            None
        }
        pub fn delete(&self) {}
    }

    pub fn legacy(_profile_id: &str) -> Option<Legacy> {
        None
    }

    // Sealed with an Android Keystore key; the plain `secrets.json` of earlier versions is
    // moved into the sealed file without ever losing a key (see `platform::vault`).
    pub fn read(dir: Option<&Path>) -> Result<HashMap<String, String>, String> {
        crate::platform::vault::read(dir.ok_or("No private storage folder")?, &crate::platform::android::Keystore)
    }

    pub fn write(dir: Option<&Path>, map: &HashMap<String, String>) -> Result<(), String> {
        crate::platform::vault::write(dir.ok_or("No private storage folder")?, map, &crate::platform::android::Keystore)
    }
}

/// The secret key for a connection, if one is stored. The vault is read from the keychain once
/// per launch and cached. A secret still stored the old way (one item per connection) is moved
/// into the vault the first time it is needed.
pub async fn get_secret(state: &AppState, profile_id: &str) -> Result<Option<String>, String> {
    let dir = state.vault_dir.get().map(PathBuf::as_path);
    let mut guard = state.secrets.lock().await;
    if guard.is_none() {
        *guard = Some(vault::read(dir)?);
    }
    let map = guard.as_mut().expect("vault loaded above");
    if let Some(s) = map.get(profile_id) {
        return Ok(Some(s.clone()));
    }
    let Some(legacy) = vault::legacy(profile_id) else { return Ok(None) };
    match legacy.get() {
        Some(secret) => {
            map.insert(profile_id.to_string(), secret.clone());
            // only drop the old item once the vault really holds the secret
            if vault::write(dir, map).is_ok() {
                legacy.delete();
            }
            Ok(Some(secret))
        }
        None => Ok(None),
    }
}

pub async fn set_secret(state: &AppState, profile_id: &str, secret: &str) -> Result<(), String> {
    let dir = state.vault_dir.get().map(PathBuf::as_path);
    let mut guard = state.secrets.lock().await;
    if guard.is_none() {
        *guard = Some(vault::read(dir)?);
    }
    let map = guard.as_mut().expect("vault loaded above");
    map.insert(profile_id.to_string(), secret.to_string());
    vault::write(dir, map)?;
    if let Some(legacy) = vault::legacy(profile_id) {
        legacy.delete();
    }
    Ok(())
}

pub async fn delete_secret(state: &AppState, profile_id: &str) -> Result<(), String> {
    let dir = state.vault_dir.get().map(PathBuf::as_path);
    let mut guard = state.secrets.lock().await;
    if guard.is_none() {
        *guard = Some(vault::read(dir)?);
    }
    let map = guard.as_mut().expect("vault loaded above");
    if map.remove(profile_id).is_some() {
        vault::write(dir, map)?;
    }
    if let Some(legacy) = vault::legacy(profile_id) {
        legacy.delete();
    }
    Ok(())
}

/// One HTTPS client (and so one connection pool and TLS setup) shared by every connection.
fn http_client() -> SharedHttpClient {
    static HTTP: OnceLock<SharedHttpClient> = OnceLock::new();
    HTTP.get_or_init(|| {
        let b = HttpBuilder::new().tls_provider(Provider::Rustls(CryptoMode::Ring));
        #[cfg(mobile)]
        let b = b.tls_context(mobile_tls());
        b.build_https()
    })
    .clone()
}

/// iOS and Android keep their trusted roots where rustls can't read them (the native-roots lookup
/// finds nothing, and debug builds panic on it), so phones trust Mozilla's root set, bundled in.
#[cfg(mobile)]
fn mobile_tls() -> aws_smithy_http_client::tls::TlsContext {
    use aws_smithy_http_client::tls::{TlsContext, TrustStore};
    use base64::Engine;
    let mut store = TrustStore::empty().with_native_roots(false);
    for der in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
        let b64 = base64::engine::general_purpose::STANDARD.encode(der.as_ref());
        let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
        for line in b64.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(line).unwrap_or_default());
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
        store.add_pem_certificate(pem.into_bytes());
    }
    TlsContext::builder().with_trust_store(store).build().expect("bundled root certificates")
}

pub fn build_client(p: &Profile, secret: &str) -> Client {
    let creds = Credentials::new(p.access_key_id.clone(), secret.to_string(), None, None, "kybl");
    let region = if p.region.trim().is_empty() { "us-east-1" } else { p.region.trim() };
    let mut b = aws_sdk_s3::config::Builder::new()
        .behavior_version(BehaviorVersion::latest())
        .http_client(http_client())
        .credentials_provider(creds)
        .region(Region::new(region.to_string()))
        .force_path_style(p.path_style)
        // Many S3-compatible services (Ceph, MinIO, R2 ...) reject the newer
        // default integrity checksums, so only send them when an operation requires it.
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .stalled_stream_protection(StalledStreamProtectionConfig::disabled());
    if !p.endpoint.trim().is_empty() {
        b = b.endpoint_url(p.endpoint.trim().to_string());
    }
    Client::from_conf(b.build())
}

pub async fn client_for<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    profile_id: &str,
) -> Result<Client, String> {
    if let Some(c) = state.clients.lock().await.get(profile_id) {
        return Ok(c.clone());
    }
    let profile = load_profiles(app)?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "Connection not found".to_string())?;
    let secret = get_secret(state, profile_id)
        .await?
        .ok_or_else(|| "No secret key is stored for this connection. Edit it and enter the key again.".to_string())?;
    let client = build_client(&profile, &secret);
    state.clients.lock().await.insert(profile_id.to_string(), client.clone());
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreachable_server_reads_plainly_and_keeps_the_details() {
        // nothing listens on port 1
        let p = Profile {
            id: "t".into(),
            name: "t".into(),
            provider: "custom".into(),
            endpoint: "http://127.0.0.1:1".into(),
            region: "us-east-1".into(),
            access_key_id: "k".into(),
            bucket: None,
            path_style: true,
        };
        let client = build_client(&p, "s");
        let e = tauri::async_runtime::block_on(client.list_buckets().send()).unwrap_err();
        let msg = sdk_err(e);
        let (say, details) = msg.split_once("\n\n").expect("a plain sentence, then the details");
        assert_eq!(say, REFUSED);
        assert!(details.contains("Connection refused"), "{details}");
    }

    #[test]
    fn s3_codes_read_plainly() {
        let e = std::io::Error::other("x");
        assert_eq!(friendly(&e, "ServiceError { code: Some(\"AccessDenied\") }"), Some("Access denied. This key isn't allowed to do that. If the key is brand new, give it a few minutes: some providers take a while to activate new keys."));
        assert!(friendly(&e, "NoSuchBucket: gone").unwrap().contains("doesn't exist"));
        assert_eq!(friendly(&e, "something nobody has seen"), None);
    }
}
