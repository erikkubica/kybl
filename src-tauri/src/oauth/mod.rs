//! Signing in to Google Drive, OneDrive and Dropbox (OAuth 2 authorization code with PKCE), and
//! opening those connections. See README.md next to this file for the flow per platform.
//!
//! * Computers: the system browser, back to a loopback address (`http://127.0.0.1:<port>/callback`
//!   or `http://localhost:<port>/callback`, RFC 8252) that Kybl listens on.
//! * Phones: a Custom Tab (Android) or an ASWebAuthenticationSession sheet (iOS) through
//!   `KyblConnectPlugin`. Google's iOS client comes back to its reversed-client-id scheme and
//!   Microsoft to `kybl://oauth/onedrive`. Google on Android and Dropbox everywhere use the
//!   loopback address on the phone itself; Kybl's answer there sends the tab on to
//!   `kybl://oauth/done`, which closes it and brings the app back.
//!
//! The refresh token goes into the vault (`{id}#oauth`); the connection is saved like any other
//! with `kind` and `cloud` (account email and id) filled in. Tokens: [`token`].

pub mod http;
mod loopback;
#[cfg(test)]
pub mod mock;
pub mod token;

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;
use self::loopback::{listen, Reply};
use self::token::{Stored, TokenSource, TokenStore};
use crate::{
    kybl_connect::{self as kc, Flow},
    state::{get_secret, load_profiles, save_profiles, secret_key, set_secret, AppState, CloudConfig, Profile},
    storage::{ConnKind, SResult, Storage, StorageError, CANCELLED},
};

/// The event the UI listens to: a connection's sign-in expired or was revoked, show Reconnect.
pub const AUTH_EVENT: &str = "connection-auth";

/// How long a sign-in waits for the browser before giving up.
const TIMEOUT: Duration = Duration::from_secs(15 * 60);

// ---------------------------------------------------------------- providers

pub struct Provider {
    pub kind: ConnKind,
    /// `{tenant}` is replaced (Microsoft)
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub scopes: &'static [&'static str],
    pub extra: &'static [(&'static str, &'static str)],
}

pub const GOOGLE: Provider = Provider {
    kind: ConnKind::Gdrive,
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    // the full Drive scope: Kybl is a file manager for everything in the drive (restricted scope,
    // see README: verification)
    scopes: &["https://www.googleapis.com/auth/drive"],
    // offline: a refresh token; consent: one every time, also when reconnecting
    extra: &[("access_type", "offline"), ("prompt", "consent")],
};

pub const MICROSOFT: Provider = Provider {
    kind: ConnKind::Onedrive,
    auth_url: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    scopes: &["offline_access", "Files.ReadWrite.All", "User.Read"],
    extra: &[("prompt", "select_account")],
};

pub const DROPBOX: Provider = Provider {
    kind: ConnKind::Dropbox,
    auth_url: "https://www.dropbox.com/oauth2/authorize",
    token_url: "https://api.dropboxapi.com/oauth2/token",
    scopes: &[
        "account_info.read",
        "files.metadata.read",
        "files.metadata.write",
        "files.content.read",
        "files.content.write",
        "sharing.read",
        "sharing.write",
    ],
    extra: &[("token_access_type", "offline")],
};

pub fn provider(kind: ConnKind) -> Option<&'static Provider> {
    match kind {
        ConnKind::Gdrive => Some(&GOOGLE),
        ConnKind::Onedrive => Some(&MICROSOFT),
        ConnKind::Dropbox => Some(&DROPBOX),
        _ => None,
    }
}

/// Dropbox only takes redirect addresses registered with their port: these two, in this order.
pub const DROPBOX_PORTS: &[u16] = &[53682, 53683];

// ---------------------------------------------------------------- built-in clients

fn set(v: Option<&'static str>) -> Option<&'static str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

// Set from GitHub secrets at build time (release.yml); unset in local builds.
fn google_id() -> Option<&'static str> {
    set(option_env!("KYBL_GOOGLE_CLIENT_ID"))
}
fn google_secret() -> Option<&'static str> {
    set(option_env!("KYBL_GOOGLE_CLIENT_SECRET"))
}
fn google_ios_id() -> Option<&'static str> {
    set(option_env!("KYBL_GOOGLE_IOS_CLIENT_ID"))
}
fn ms_id() -> Option<&'static str> {
    set(option_env!("KYBL_MS_CLIENT_ID"))
}
fn dropbox_key() -> Option<&'static str> {
    set(option_env!("KYBL_DROPBOX_APP_KEY"))
}

/// The client this build signs in with when the user brings none: (id, secret).
fn builtin_client(kind: ConnKind) -> Option<(String, Option<String>)> {
    let own = |id: Option<&str>, secret: Option<&str>| id.map(|i| (i.to_string(), secret.map(str::to_string)));
    match kind {
        // iPhone: Google's iOS client (comes back to its own scheme, no secret)
        ConnKind::Gdrive if cfg!(target_os = "ios") && google_ios_id().is_some() => own(google_ios_id(), None),
        ConnKind::Gdrive => own(google_id(), google_secret()),
        ConnKind::Onedrive => own(ms_id(), None),
        ConnKind::Dropbox => own(dropbox_key(), None),
        _ => None,
    }
}

/// The compiled-in secret of a built-in client (Google's "desktop" clients have one that isn't
/// really secret; the others are public clients).
pub fn builtin_secret(kind: ConnKind, client_id: &str) -> Option<String> {
    (kind == ConnKind::Gdrive && google_id() == Some(client_id)).then(|| google_secret().map(str::to_string)).flatten()
}

/// Which kinds this build can sign in to without the user's own client ID.
#[tauri::command]
pub fn oauth_builtin_clients() -> BTreeMap<String, bool> {
    [ConnKind::Gdrive, ConnKind::Onedrive, ConnKind::Dropbox]
        .into_iter()
        .map(|k| (serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(), builtin_client(k).is_some()))
        .collect()
}

/// "Use your own OAuth app".
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientOverride {
    pub client_id: String,
    pub client_secret: Option<String>,
    /// Microsoft: a tenant id or domain, for apps limited to one organization
    pub tenant: Option<String>,
}

// ---------------------------------------------------------------- redirects

#[derive(Clone, Debug, PartialEq, Eq)]
enum Redirect {
    /// Kybl listens on this host (any free port when `ports` is empty)
    Loopback { host: &'static str, ports: &'static [u16] },
    /// the browser comes back to an app scheme (phones)
    Scheme { uri: String, scheme: String },
}

/// "1234-abc.apps.googleusercontent.com" → "com.googleusercontent.apps.1234-abc"
fn reversed_client_id(id: &str) -> Option<String> {
    let head = id.strip_suffix(".apps.googleusercontent.com")?;
    Some(format!("com.googleusercontent.apps.{head}"))
}

fn redirect_for(kind: ConnKind, client_id: &str, own_client: bool, ios: bool, phone: bool) -> Redirect {
    match kind {
        ConnKind::Gdrive => match reversed_client_id(client_id) {
            // only the built-in iOS client is registered for its scheme; the user's own client
            // is a "desktop" one and uses the loopback address
            Some(scheme) if ios && !own_client && google_ios_id() == Some(client_id) => {
                Redirect::Scheme { uri: format!("{scheme}:/oauth2redirect"), scheme }
            }
            _ => Redirect::Loopback { host: "127.0.0.1", ports: &[] },
        },
        ConnKind::Onedrive if phone => Redirect::Scheme { uri: "kybl://oauth/onedrive".into(), scheme: "kybl".into() },
        // Microsoft ignores the port of http://localhost redirects
        ConnKind::Onedrive => Redirect::Loopback { host: "localhost", ports: &[] },
        _ => Redirect::Loopback { host: "localhost", ports: DROPBOX_PORTS },
    }
}

#[allow(clippy::too_many_arguments)]
fn authorize_url(p: &Provider, tenant: &str, client_id: &str, redirect_uri: &str, state: &str, verifier: &str, login_hint: Option<&str>) -> String {
    let mut q = vec![
        ("response_type", "code".to_string()),
        ("client_id", client_id.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("scope", p.scopes.join(" ")),
        ("state", state.to_string()),
        ("code_challenge", kc::pkce_challenge(verifier)),
        ("code_challenge_method", "S256".to_string()),
    ];
    q.extend(p.extra.iter().map(|(k, v)| (*k, v.to_string())));
    if let Some(h) = login_hint.filter(|h| !h.is_empty() && p.kind != ConnKind::Dropbox) {
        q.push(("login_hint", h.to_string()));
    }
    let qs: Vec<String> = q.iter().map(|(k, v)| format!("{k}={}", kc::enc(v))).collect();
    format!("{}?{}", p.auth_url.replace("{tenant}", tenant), qs.join("&"))
}

// ---------------------------------------------------------------- the browser part

const NOTHING_BACK: &str = "Nothing came back from the browser. Try again.";

/// Opens the sign-in page and waits for the code. Returns (code, redirect uri used).
#[cfg(desktop)]
async fn browser_code(app: &AppHandle, flow: &Flow, redirect: &Redirect, label: &str, url_for: &(dyn Fn(&str) -> String + Sync), state: &str) -> Result<(String, String), String> {
    let Redirect::Loopback { host, ports } = redirect else {
        return Err("This sign-in isn't available on a computer.".into());
    };
    let listener = listen(ports).await?;
    let port = listener.port().map_err(|e| e.to_string())?;
    let uri = format!("http://{host}:{port}/callback");
    app.opener().open_url(url_for(&uri), None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
    let ok = format!("You're signed in to {label}. You can close this tab and go back to Kybl.");
    let code = tokio::select! {
        r = loopback::wait(&listener, state, Reply::Page(&ok)) => r?,
        _ = flow.cancel.notified() => return Err(CANCELLED.into()),
        _ = tokio::time::sleep(TIMEOUT) => return Err(NOTHING_BACK.into()),
    };
    crate::tray::show_main(app);
    Ok((code, uri))
}

/// Where the loopback sign-ins on a phone send the tab once the code arrived: back into the app.
#[cfg(any(mobile, test))]
const LOOPBACK_DONE: &str = "kybl://oauth/done";

/// The `signIn` call of `KyblConnectPlugin`: the page, the scheme that ends the sign-in, and the
/// one address under that scheme this sign-in comes back to. Android only accepts that address
/// (`SignInCallback.kt`): another `kybl://` link opened meanwhile must not end the sign-in.
#[cfg(any(mobile, test))]
fn sign_in_args(url: &str, scheme: &str, callback: &str) -> Value {
    json!({ "url": url, "callbackScheme": scheme, "callbackUrl": callback })
}

/// Phones: `KyblConnectPlugin` opens the page in a Custom Tab / sign-in sheet that closes when
/// the browser reaches `callbackScheme`.
#[cfg(mobile)]
async fn browser_code(app: &AppHandle, flow: &Flow, redirect: &Redirect, _label: &str, url_for: &(dyn Fn(&str) -> String + Sync), state: &str) -> Result<(String, String), String> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Back {
        url: Option<String>,
        cancelled: bool,
    }
    let native = app.try_state::<kc::native::Native>().ok_or("The sign-in isn't available in this build.")?;
    let cancel_native = || async {
        let _ = native.0.run_mobile_plugin_async::<Value>("cancel", ()).await;
    };
    match redirect {
        Redirect::Scheme { uri, scheme } => {
            let url = url_for(uri);
            let back = tokio::select! {
                r = native.0.run_mobile_plugin_async::<Back>("signIn", sign_in_args(&url, scheme, uri)) => r.map_err(|e| format!("Couldn't open the browser: {}", e.to_string().replace(" Use a code instead.", "")))?,
                _ = flow.cancel.notified() => { cancel_native().await; return Err(CANCELLED.into()) }
                _ = tokio::time::sleep(TIMEOUT) => { cancel_native().await; return Err(NOTHING_BACK.into()) }
            };
            match back.url {
                Some(u) if !back.cancelled => Ok((kc::code_from_redirect(&kc::query(&u), state)?, uri.clone())),
                _ => Err(CANCELLED.into()),
            }
        }
        Redirect::Loopback { host, ports } => {
            let listener = listen(ports).await?;
            let port = listener.port().map_err(|e| e.to_string())?;
            let uri = format!("http://{host}:{port}/callback");
            let url = url_for(&uri);
            let tab = native.0.run_mobile_plugin_async::<Back>("signIn", sign_in_args(&url, "kybl", LOOPBACK_DONE));
            tokio::pin!(tab);
            let code = tokio::select! {
                r = loopback::wait(&listener, state, Reply::Redirect(LOOPBACK_DONE)) => r,
                // closed without signing in (the redirect back only comes after the code)
                r = &mut tab => match r {
                    Ok(b) if b.cancelled || b.url.is_none() => Err(CANCELLED.to_string()),
                    Ok(_) => Err(NOTHING_BACK.to_string()),
                    Err(e) => Err(format!("Couldn't open the browser: {}", e.to_string().replace(" Use a code instead.", ""))),
                },
                _ = flow.cancel.notified() => Err(CANCELLED.into()),
                _ = tokio::time::sleep(TIMEOUT) => Err(NOTHING_BACK.into()),
            };
            // close the tab if the redirect back didn't (and settle the pending call)
            cancel_native().await;
            Ok((code?, uri))
        }
    }
}

// ---------------------------------------------------------------- tokens and account

#[derive(Deserialize)]
struct CodeAnswer {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

async fn exchange(kind: ConnKind, token_url: &str, pairs: &[(&str, &str)]) -> Result<CodeAnswer, String> {
    let res = http::client()
        .post(token_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .body(http::form(pairs))
        .send()
        .await
        .map_err(|e| String::from(http::net_error(kind, &e)))?;
    let status = res.status().as_u16();
    let body = res.bytes().await.unwrap_or_default();
    if status != 200 {
        let (code, msg) = http::provider_error(&body);
        let say = match code.as_str() {
            "invalid_grant" => "The sign-in expired before it finished. Try again.".to_string(),
            "invalid_client" | "unauthorized_client" => format!("{} didn't accept Kybl's client ID. Check the client ID and secret.", kind.label()),
            _ => format!("{} didn't finish the sign-in.", kind.label()),
        };
        return Err(format!("{say}\n\nHTTP {status}: {code}: {msg}"));
    }
    serde_json::from_slice(&body).map_err(|e| String::from(http::unexpected(kind, e)))
}

/// The signed-in account: (email, stable id).
async fn account(kind: ConnKind, access: &str) -> Result<(String, String), String> {
    let c = http::client();
    let req = match kind {
        ConnKind::Gdrive => c.get("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,permissionId)"),
        ConnKind::Onedrive => c.get("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName"),
        _ => c.post("https://api.dropboxapi.com/2/users/get_current_account").header("content-type", "application/json").body("null"),
    };
    let res = req.bearer_auth(access).send().await.map_err(|e| String::from(http::net_error(kind, &e)))?;
    let res = http::check(kind, res).await?;
    let v: Value = http::read_json(kind, res).await?;
    let s = |v: &Value| v.as_str().unwrap_or_default().to_string();
    Ok(match kind {
        ConnKind::Gdrive => (s(&v["user"]["emailAddress"]), s(&v["user"]["permissionId"])),
        ConnKind::Onedrive => {
            let mail = s(&v["mail"]);
            (if mail.is_empty() { s(&v["userPrincipalName"]) } else { mail }, s(&v["id"]))
        }
        _ => (s(&v["email"]), s(&v["account_id"])),
    })
}

// ---------------------------------------------------------------- commands

/// Signs in to a cloud drive in the browser and saves the connection (new, or `replace_id`
/// updated in place: Reconnect keeps the id, so open tabs, sync folders and jobs stay). Signing
/// in to an account that already has a connection updates that one instead of adding another.
#[tauri::command]
pub async fn oauth_start(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: ConnKind,
    flow_id: String,
    client: Option<ClientOverride>,
    replace_id: Option<String>,
) -> Result<Profile, String> {
    let p = provider(kind).ok_or_else(|| format!("{} doesn't use a browser sign-in.", kind.label()))?;
    let profiles = load_profiles(&app)?;
    let replacing = replace_id.as_ref().and_then(|id| profiles.iter().find(|x| &x.id == id)).cloned();
    if replace_id.is_some() && replacing.is_none() {
        return Err("Connection not found".into());
    }
    // the user's own client: given now, or kept from the connection being reconnected
    let own = match client.filter(|c| !c.client_id.trim().is_empty()) {
        Some(c) => Some(c),
        None => match replacing.as_ref().and_then(|r| r.cloud.as_ref()).and_then(|c| c.client_id.clone()).filter(|s| !s.is_empty()) {
            Some(id) => {
                let old = get_secret(&state, &secret_key(&replacing.as_ref().unwrap().id, "oauth")).await?.and_then(|s| token::parse_stored(&s));
                let tenant = replacing.as_ref().and_then(|r| r.cloud.as_ref()).and_then(|c| c.tenant.clone());
                Some(ClientOverride { client_id: id, client_secret: old.and_then(|o| o.client_secret), tenant })
            }
            None => None,
        },
    };
    let (client_id, secret) = match &own {
        Some(c) => (c.client_id.trim().to_string(), c.client_secret.clone().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())),
        None => builtin_client(kind).ok_or_else(|| {
            format!("This version of Kybl has no built-in {} sign-in. Add your own OAuth client ID under Advanced.", kind.label())
        })?,
    };
    let tenant = own.as_ref().and_then(|c| c.tenant.clone()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let tenant_or_common = tenant.clone().unwrap_or_else(|| "common".into());

    let flow = Flow::new(&flow_id);
    let verifier = kc::random_token();
    let csrf = kc::random_token();
    let redirect = redirect_for(kind, &client_id, own.is_some(), cfg!(target_os = "ios"), cfg!(mobile));
    let hint = replacing.as_ref().and_then(|r| r.cloud.as_ref()).map(|c| c.account_email.clone());
    let url_for = |uri: &str| authorize_url(p, &tenant_or_common, &client_id, uri, &csrf, &verifier, hint.as_deref());
    let (code, redirect_uri) = browser_code(&app, &flow, &redirect, kind.label(), &url_for, &csrf).await?;

    let token_url = p.token_url.replace("{tenant}", &tenant_or_common);
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    if let Some(s) = secret.as_deref() {
        pairs.push(("client_secret", s));
    }
    let tok = exchange(kind, &token_url, &pairs).await?;
    let refresh = tok.refresh_token.filter(|r| !r.is_empty()).ok_or_else(|| {
        format!("{} signed Kybl in only for a moment. Remove Kybl from your account's connected apps and try again.", kind.label())
    })?;
    let (email, account_id) = account(kind, &tok.access_token).await?;

    if let Some(old) = replacing.as_ref().and_then(|r| r.cloud.as_ref())
        && !old.account_id.is_empty()
        && !account_id.is_empty()
        && old.account_id != account_id
    {
        return Err(format!(
            "You signed in as {email}, but this connection belongs to {}. Sign in with that account, or add a new connection.",
            old.account_email
        ));
    }

    let mut profiles = load_profiles(&app)?;
    let existing = profiles.iter().position(|x| Some(&x.id) == replace_id.as_ref()).or_else(|| {
        profiles.iter().position(|x| x.kind == kind && x.cloud.as_ref().is_some_and(|c| !account_id.is_empty() && c.account_id == account_id))
    });
    let name = match existing {
        Some(i) => profiles[i].name.clone(),
        None if email.is_empty() => kind.label().to_string(),
        None => format!("{} ({email})", kind.label()),
    };
    let id = existing.map(|i| profiles[i].id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let provider_id = serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    let profile = Profile {
        id: id.clone(),
        name,
        kind,
        provider: provider_id,
        cloud: Some(CloudConfig {
            account_email: email,
            account_id,
            client_id: own.as_ref().map(|_| client_id.clone()),
            tenant: if kind == ConnKind::Onedrive { tenant } else { None },
            scopes: p.scopes.iter().map(|s| s.to_string()).collect(),
        }),
        ..Default::default()
    };
    let stored = Stored { refresh_token: refresh, client_id: client_id.clone(), client_secret: own.as_ref().and(secret) };
    set_secret(&state, &secret_key(&id, "oauth"), &serde_json::to_string(&stored).map_err(|e| e.to_string())?).await?;
    match existing {
        Some(i) => profiles[i] = profile.clone(),
        None => profiles.push(profile.clone()),
    }
    save_profiles(&app, &profiles)?;
    crate::storage::registry::forget(&id);
    // a reconnect may be another account: its files are not this one's
    crate::filecache::forget_profile(&app, &id).await;
    Ok(profile)
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
pub fn oauth_cancel(flow_id: String) {
    kc::kybl_connect_cancel(flow_id);
}

// ---------------------------------------------------------------- opening connections

/// The refresh token in the vault under `{id}#oauth`.
struct VaultStore<R: Runtime> {
    app: AppHandle<R>,
    key: String,
}

#[async_trait::async_trait]
impl<R: Runtime> TokenStore for VaultStore<R> {
    async fn load(&self) -> SResult<Option<Stored>> {
        let state = self.app.state::<AppState>();
        let raw = get_secret(&state, &self.key).await.map_err(StorageError::other)?;
        Ok(raw.and_then(|r| token::parse_stored(&r)))
    }
    async fn save(&self, s: &Stored) -> SResult<()> {
        let state = self.app.state::<AppState>();
        let raw = serde_json::to_string(s).map_err(|e| StorageError::other(e.to_string()))?;
        set_secret(&state, &self.key, &raw).await.map_err(StorageError::other)
    }
}

/// The token source of a saved sign-in connection.
pub fn tokens_for<R: Runtime>(app: &AppHandle<R>, profile: &Profile) -> Result<Arc<TokenSource>, String> {
    let p = provider(profile.kind).ok_or("Not a sign-in connection")?;
    let tenant = profile.cloud.as_ref().and_then(|c| c.tenant.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| "common".into());
    let store = Arc::new(VaultStore { app: app.clone(), key: secret_key(&profile.id, "oauth") });
    let events = app.clone();
    let notify = Box::new(move |id: &str| {
        let _ = events.emit(AUTH_EVENT, json!({ "profileId": id }));
    });
    Ok(Arc::new(TokenSource::new(&profile.id, profile.kind, p.token_url.replace("{tenant}", &tenant), builtin_secret, store, notify)))
}

/// Opens a Google Drive, OneDrive or Dropbox connection (`registry::build`).
pub fn open<R: Runtime>(app: &AppHandle<R>, profile: &Profile) -> Result<Arc<dyn Storage>, String> {
    let tokens = tokens_for(app, profile)?;
    let api = http::Api::new(profile.kind, tokens);
    Ok(match profile.kind {
        ConnKind::Gdrive => Arc::new(crate::storage::gdrive::GDrive::new(api)),
        ConnKind::Onedrive => Arc::new(crate::storage::onedrive::OneDrive::new(api)),
        ConnKind::Dropbox => Arc::new(crate::storage::dropbox::Dropbox::new(api)),
        other => return Err(format!("{} doesn't use a browser sign-in.", other.label())),
    })
}

// WP-C: phone backup opens connections from a background worker with no app running

/// The refresh token in the vault of a state that outlives the app (background backup).
struct StateStore {
    state: &'static AppState,
    key: String,
}

#[async_trait::async_trait]
impl TokenStore for StateStore {
    async fn load(&self) -> SResult<Option<Stored>> {
        let raw = get_secret(self.state, &self.key).await.map_err(StorageError::other)?;
        Ok(raw.and_then(|r| token::parse_stored(&r)))
    }
    async fn save(&self, s: &Stored) -> SResult<()> {
        // the app may have changed the vault since this state read it: read it again first, so
        // writing the new token back never drops a secret saved meanwhile
        *self.state.secrets.lock().await = None;
        let raw = serde_json::to_string(s).map_err(|e| StorageError::other(e.to_string()))?;
        set_secret(self.state, &self.key, &raw).await.map_err(StorageError::other)
    }
}

/// [`open`] without an `AppHandle`: tokens from `state`'s vault, no Reconnect event (the backup
/// shows "needs sign-in" itself).
pub fn open_without_app(state: &'static AppState, profile: &Profile) -> Result<Arc<dyn Storage>, String> {
    let p = provider(profile.kind).ok_or("Not a sign-in connection")?;
    let tenant = profile.cloud.as_ref().and_then(|c| c.tenant.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| "common".into());
    let store = Arc::new(StateStore { state, key: secret_key(&profile.id, "oauth") });
    let tokens = Arc::new(TokenSource::new(&profile.id, profile.kind, p.token_url.replace("{tenant}", &tenant), builtin_secret, store, Box::new(|_: &str| {})));
    let api = http::Api::new(profile.kind, tokens);
    Ok(match profile.kind {
        ConnKind::Gdrive => Arc::new(crate::storage::gdrive::GDrive::new(api)),
        ConnKind::Onedrive => Arc::new(crate::storage::onedrive::OneDrive::new(api)),
        ConnKind::Dropbox => Arc::new(crate::storage::dropbox::Dropbox::new(api)),
        other => return Err(format!("{} doesn't use a browser sign-in.", other.label())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query_of(url: &str) -> std::collections::HashMap<String, String> {
        kc::query(url)
    }

    #[test]
    fn authorize_urls_carry_pkce_and_offline_access() {
        let u = authorize_url(&GOOGLE, "common", "id.apps.googleusercontent.com", "http://127.0.0.1:5000/callback", "st", "verifier", Some("me@example.com"));
        assert!(u.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        let q = query_of(&u);
        assert_eq!(q["code_challenge"], kc::pkce_challenge("verifier"));
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000/callback");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["scope"], "https://www.googleapis.com/auth/drive");
        assert_eq!(q["login_hint"], "me@example.com");

        let u = authorize_url(&MICROSOFT, "contoso.com", "cid", "kybl://oauth/onedrive", "st", "v", None);
        assert!(u.starts_with("https://login.microsoftonline.com/contoso.com/oauth2/v2.0/authorize?"));
        assert_eq!(query_of(&u)["scope"], "offline_access Files.ReadWrite.All User.Read");

        let u = authorize_url(&DROPBOX, "common", "key", "http://localhost:53682/callback", "st", "v", Some("x@y"));
        let q = query_of(&u);
        assert_eq!(q["token_access_type"], "offline");
        assert!(!q.contains_key("login_hint"), "Dropbox has no login hint");
    }

    #[test]
    fn redirects_per_platform() {
        let lo = |host| Redirect::Loopback { host, ports: &[] };
        assert_eq!(redirect_for(ConnKind::Gdrive, "x.apps.googleusercontent.com", false, false, false), lo("127.0.0.1"));
        // Android: Google's loopback, in a Custom Tab
        assert_eq!(redirect_for(ConnKind::Gdrive, "x.apps.googleusercontent.com", false, false, true), lo("127.0.0.1"));
        // the user's own (desktop) client on an iPhone: loopback too
        assert_eq!(redirect_for(ConnKind::Gdrive, "x.apps.googleusercontent.com", true, true, true), lo("127.0.0.1"));
        assert_eq!(redirect_for(ConnKind::Onedrive, "cid", false, false, false), lo("localhost"));
        assert_eq!(
            redirect_for(ConnKind::Onedrive, "cid", false, true, true),
            Redirect::Scheme { uri: "kybl://oauth/onedrive".into(), scheme: "kybl".into() }
        );
        assert_eq!(redirect_for(ConnKind::Dropbox, "key", false, false, true), Redirect::Loopback { host: "localhost", ports: DROPBOX_PORTS });
        assert_eq!(reversed_client_id("123-abc.apps.googleusercontent.com").unwrap(), "com.googleusercontent.apps.123-abc");
        assert_eq!(reversed_client_id("nope"), None);
    }

    #[test]
    fn builtin_clients_are_listed_per_kind() {
        let m = oauth_builtin_clients();
        assert_eq!(m.keys().cloned().collect::<Vec<_>>(), vec!["dropbox", "gdrive", "onedrive"]);
        // local builds have no ids compiled in
        if option_env!("KYBL_GOOGLE_CLIENT_ID").is_none() {
            assert!(!m["gdrive"]);
            assert_eq!(builtin_secret(ConnKind::Gdrive, "anything"), None);
        }
    }

    #[test]
    fn phones_are_told_which_address_ends_the_sign_in() {
        let a = sign_in_args("https://login.example/authorize", "kybl", "kybl://oauth/onedrive");
        assert_eq!(a["callbackScheme"], "kybl");
        assert_eq!(a["callbackUrl"], "kybl://oauth/onedrive");
        assert_eq!(sign_in_args("u", "kybl", LOOPBACK_DONE)["callbackUrl"], "kybl://oauth/done");
    }
}

