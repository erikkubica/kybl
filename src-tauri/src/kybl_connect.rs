//! "Connect Kybl Storage": signs the app in to Kybl Cloud without anyone copying keys.
//!
//! The user approves this device in the browser and the account API hands the app its own access
//! key ("Kybl on <device>"), which the user can revoke on the web Access keys page. Two flows, both
//! ending at `POST /v1/connect/token`:
//!
//! * **Browser** (default): authorization code with PKCE (S256). On a computer the app listens on
//!   a loopback `http://127.0.0.1:<random port>/callback` (RFC 8252), opens `<app url>/connect?…`
//!   in the system browser and waits for the redirect carrying `code` and `state`. On a phone the
//!   page opens in a Custom Tab (Android) or a sign-in sheet (iOS) and comes back to
//!   `kybl://connect?…`, which `KyblConnectPlugin` (.kt / .swift) catches and hands over.
//! * **Device code** (RFC 8628): for when the browser is elsewhere. The app shows a short code and
//!   a QR of the approval link, then polls every `interval` seconds.
//!
//! The secret goes straight into the vault (the keychain, or the app's private storage on Android);
//! the connection is saved like any other.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::{Duration, Instant},
};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Notify;
// the loopback page helpers also serve the cloud sign-in on phones (see oauth/mod.rs)
#[cfg(any(desktop, test))]
use tokio::net::TcpListener;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

#[cfg(mobile)]
use tauri::Manager;

use crate::state::{err, load_profiles, lock_profiles, save_profiles, set_secret, AppState, Profile};

/// Production account site. Debug builds talk to a local kybl-cloud instead.
const PRODUCTION_APP_URL: &str = "https://app.kybl.app";
const DEV_APP_URL: &str = "http://127.0.0.1:8080";

/// How long the browser flow waits for the user to approve before giving up.
const BROWSER_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub const PROVIDER: &str = "kybl";

/// The account site the app signs in with when the user has not set one: `KYBL_APP_URL` if set,
/// else the local dev server in debug builds and production otherwise.
#[tauri::command]
pub fn kybl_default_app_url() -> String {
    if let Ok(u) = std::env::var("KYBL_APP_URL") {
        let u = u.trim().trim_end_matches('/');
        if !u.is_empty() {
            return u.to_string();
        }
    }
    if cfg!(debug_assertions) { DEV_APP_URL } else { PRODUCTION_APP_URL }.to_string()
}

fn base_url(app_url: Option<String>) -> Result<String, String> {
    let u = app_url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty());
    let u = u.unwrap_or_else(kybl_default_app_url);
    // plain http only to this computer (a test server): the secret key comes back over it
    if !(u.starts_with("https://") || u.strip_prefix("http://").is_some_and(is_loopback)) {
        return Err("The Kybl Storage address must start with https://".into());
    }
    Ok(u)
}

/// An answer that says "not now" rather than "no": a proxy's 5xx or a 429.
fn transient(status: u16) -> bool {
    status >= 500 || status == 429
}

/// "127.0.0.1:8080/x", "localhost", "[::1]:80": an address part that names this computer.
fn is_loopback(rest: &str) -> bool {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    };
    matches!(host.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "::1")
}

// ---------------------------------------------------------------- cancelling

fn flows() -> &'static StdMutex<HashMap<String, Arc<Notify>>> {
    static FLOWS: OnceLock<StdMutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    FLOWS.get_or_init(Default::default)
}

/// Registers a flow so [`kybl_connect_cancel`] can stop it; unregisters when dropped.
pub(crate) struct Flow {
    id: String,
    pub(crate) cancel: Arc<Notify>,
}

impl Flow {
    pub(crate) fn new(id: &str) -> Self {
        let cancel = Arc::new(Notify::new());
        flows().lock().unwrap().insert(id.to_string(), cancel.clone());
        Self { id: id.to_string(), cancel }
    }
}

impl Drop for Flow {
    fn drop(&mut self) {
        flows().lock().unwrap().remove(&self.id);
    }
}

const CANCELLED: &str = "Cancelled";

#[tauri::command]
pub fn kybl_connect_cancel(flow_id: String) {
    if let Some(n) = flows().lock().unwrap().get(&flow_id) {
        // notify_one keeps a permit, so a cancel that lands before the wait still counts
        n.notify_one();
    }
}

// ---------------------------------------------------------------- PKCE

pub(crate) fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

pub(crate) fn random_token() -> String {
    let mut buf = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut buf).expect("system randomness");
    b64url(&buf)
}

pub(crate) fn pkce_challenge(verifier: &str) -> String {
    b64url(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref())
}

pub(crate) fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

// ---------------------------------------------------------------- device name

/// What the user calls this device ("Sam's MacBook Air", "Pixel 9"); the key is named after it.
#[cfg(mobile)]
async fn device_name(app: &AppHandle) -> String {
    #[derive(Deserialize)]
    struct Name {
        name: String,
    }
    let name = match app.try_state::<native::Native>() {
        Some(n) => n.0.run_mobile_plugin_async::<Name>("deviceName", ()).await.map(|n| n.name).unwrap_or_default(),
        None => String::new(),
    };
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    if name.trim().is_empty() { native::FALLBACK_NAME.into() } else { name }
}

#[cfg(desktop)]
async fn device_name(_app: &AppHandle) -> String {
    let run = |cmd: &str, args: &[&str]| {
        std::process::Command::new(cmd)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let name = if cfg!(target_os = "macos") { run("scutil", &["--get", "ComputerName"]) } else { None }
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .or_else(|| run("hostname", &[]))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "this computer".into());
    name.chars().filter(|c| !c.is_control()).take(60).collect()
}

// ---------------------------------------------------------------- account API

pub(crate) type HttpsClient = hyper_util::client::legacy::Client<
    hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
    Full<Bytes>,
>;

pub(crate) fn http() -> Result<&'static HttpsClient, String> {
    static C: OnceLock<HttpsClient> = OnceLock::new();
    if let Some(c) = C.get() {
        return Ok(c);
    }
    #[cfg(desktop)]
    let connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_native_roots()
        .map_err(|e| format!("Couldn't load the system's trusted certificates: {e}"))?;
    // phones keep their roots where rustls can't read them: trust Mozilla's set, like the S3 client
    #[cfg(mobile)]
    let connector = {
        let mut roots = rustls::RootCertStore::empty();
        roots.add_parsable_certificates(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().cloned());
        let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("Couldn't set up TLS: {e}"))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        hyper_rustls::HttpsConnectorBuilder::new().with_tls_config(tls)
    };
    let connector = connector
        .https_or_http()
        .enable_http1()
        .build();
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new()).build(connector);
    Ok(C.get_or_init(|| client))
}

/// POSTs JSON; returns the status and the JSON body (`{}` when it isn't JSON).
async fn post_json(url: &str, body: &Value) -> Result<(u16, Value), String> {
    let req = hyper::Request::post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .header("user-agent", concat!("Kybl/", env!("CARGO_PKG_VERSION")))
        .body(Full::new(Bytes::from(serde_json::to_vec(body).map_err(err)?)))
        .map_err(err)?;
    let unreachable = |e: String| format!("Can't reach Kybl Storage. Check your internet connection and try again.\n\n{url}: {e}");
    let res = tokio::time::timeout(Duration::from_secs(30), http()?.request(req))
        .await
        .map_err(|_| unreachable("timed out".into()))?
        .map_err(|e| unreachable(format!("{e:?}")))?;
    let status = res.status().as_u16();
    let bytes = tokio::time::timeout(Duration::from_secs(30), res.into_body().collect())
        .await
        .map_err(|_| unreachable("timed out".into()))?
        .map_err(|e| unreachable(e.to_string()))?
        .to_bytes();
    Ok((status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))))
}

fn api_error(status: u16, body: &Value) -> String {
    let code = body.get("error").and_then(Value::as_str).unwrap_or("");
    let say = match code {
        "invalid_grant" => "The sign-in link expired or was already used. Try connecting again.",
        "access_denied" => "The connection was declined in the browser.",
        "expired_token" => "The code expired before it was approved. Start again to get a new one.",
        "" if status >= 500 => "Kybl Storage ran into a problem. Try again in a moment.",
        "" => "Kybl Storage didn't accept the request.",
        other => other,
    };
    format!("{say}\n\nHTTP {status}: {body}")
}

#[derive(Deserialize)]
struct TokenResponse {
    access_key_id: String,
    secret_access_key: String,
    endpoint: String,
    region: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    account_name: String,
}

/// Saves the new key as a connection. Connecting the same account again (or "Connect again" on a
/// revoked one) updates that connection in place, so it keeps its place and open folders.
async fn finish(app: &AppHandle, state: &AppState, tok: TokenResponse, replace_id: Option<String>) -> Result<Profile, String> {
    let who = if !tok.email.is_empty() { tok.email.clone() } else { tok.account_name.clone() };
    let label = if who.is_empty() { "Kybl Storage".to_string() } else { format!("Kybl Storage ({who})") };
    let held = lock_profiles().await;
    let mut profiles = load_profiles(app)?;
    let existing = profiles
        .iter()
        .position(|p| Some(&p.id) == replace_id.as_ref())
        .or_else(|| profiles.iter().position(|p| p.provider == PROVIDER && p.name == label && p.endpoint == tok.endpoint));
    let profile = Profile {
        id: existing.map(|i| profiles[i].id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        // a name the user chose survives connecting again; the automatic one carries the account's
        // email, so it follows the account signed in now (it may not be the old one)
        name: existing.map(|i| profiles[i].name.clone()).filter(|n| n != "Kybl Storage" && !n.starts_with("Kybl Storage (")).unwrap_or(label),
        provider: PROVIDER.into(),
        endpoint: tok.endpoint,
        region: tok.region,
        access_key_id: tok.access_key_id,
        bucket: None,
        path_style: true,
        // connecting again keeps its place in the sidebar
        group: existing.and_then(|i| profiles[i].group.clone()),
        ..Default::default()
    };
    // what the vault held before, to put back if the list can't be saved (None: unreadable)
    let replaced = match existing {
        Some(_) => crate::state::get_secret(state, &profile.id).await.ok(),
        None => Some(None),
    };
    set_secret(state, &profile.id, &tok.secret_access_key).await?;
    match existing {
        Some(i) => profiles[i] = profile.clone(),
        None => profiles.push(profile.clone()),
    }
    if let Err(e) = save_profiles(app, &profiles, &held) {
        // still under the list lock, so "before" is what this save replaced
        let e = match replaced {
            // a new connection: none of its secrets may stay unseen
            Some(None) if existing.is_none() => crate::commands::forget_unsaved(state, &profile.id, true, e).await,
            Some(prev) => {
                crate::state::undo_secret(state, &profile.id, Some(&tok.secret_access_key), prev).await;
                e
            }
            None => e,
        };
        drop(held);
        return Err(e);
    }
    drop(held);
    state.clients.lock().await.remove(&profile.id);
    crate::storage::registry::forget(&profile.id);
    // a reconnect may be another account: its files are not this one's
    crate::filecache::forget_profile(app, &profile.id).await;
    Ok(profile)
}

// ---------------------------------------------------------------- browser + loopback

#[cfg(any(desktop, test))]
const PAGE_OK: &str = "You're connected. You can close this tab and go back to Kybl.";
#[cfg(any(desktop, test))]
const PAGE_DENIED: &str = "The connection was cancelled. You can close this tab.";

pub(crate) fn page(msg: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Kybl</title>\
         <body style=\"font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#f6f6f4\">\
         <div style=\"text-align:center;max-width:28em;padding:2em\"><h1 style=\"font-size:22px;margin:0 0 .5em\">Kybl</h1><p>{msg}</p></div>"
    )
}

pub(crate) async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let res = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(res.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Reads the request head and returns the target ("/callback?code=…").
pub(crate) async fn read_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next()?.split(' ');
    (parts.next()? == "GET").then_some(())?;
    parts.next().map(str::to_string)
}

pub(crate) fn query(target: &str) -> HashMap<String, String> {
    let q = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    q.split('&')
        .filter_map(|kv| kv.split_once('=').or(Some((kv, ""))))
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, v)| {
            let dec = |s: &str| percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().into_owned();
            (dec(k), dec(v))
        })
        .collect()
}

#[cfg(any(desktop, test))]
/// Waits for the browser to come back with a code for our `state`. Stray requests (a favicon, a
/// wrong or replayed state) get an error page and the wait goes on.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(err)?;
        let Some(target) = read_target(&mut stream).await else { continue };
        if target.split('?').next() != Some("/callback") {
            respond(&mut stream, "404 Not Found", "").await;
            continue;
        }
        let q = query(&target);
        if q.get("state").map(String::as_str) != Some(state) {
            respond(&mut stream, "400 Bad Request", &page("This sign-in link doesn't belong to the Kybl window that's waiting. Start again from the app.")).await;
            continue;
        }
        let r = code_from_redirect(&q, state);
        respond(&mut stream, "200 OK", &page(if r.is_ok() { PAGE_OK } else { PAGE_DENIED })).await;
        return r;
    }
}

/// What came back from the browser: the code for our `state`, or why there is none.
pub(crate) fn code_from_redirect(q: &HashMap<String, String>, state: &str) -> Result<String, String> {
    if q.get("state").map(String::as_str) != Some(state) {
        return Err("This sign-in link doesn't belong to the Kybl window that's waiting. Start again from the app.".into());
    }
    if let Some(code) = q.get("code").filter(|c| !c.is_empty()) {
        return Ok(code.clone());
    }
    let e = q.get("error").cloned().unwrap_or_default();
    Err(if e == "access_denied" || e.is_empty() {
        "The connection was cancelled in the browser.".into()
    } else {
        format!("The browser returned an error: {e}")
    })
}

fn connect_url(base: &str, verifier: &str, redirect: &str, device: &str, state: &str) -> String {
    format!(
        "{base}/connect?code_challenge={}&code_challenge_method=S256&redirect_uri={}&device_name={}&state={}",
        pkce_challenge(verifier),
        enc(redirect),
        enc(device),
        state
    )
}

const NOTHING_BACK: &str = "Nothing came back from the browser. Try again, or use a code instead.";

/// Desktop: loopback listener + the default browser.
#[cfg(desktop)]
async fn browser_code(app: &AppHandle, flow: &Flow, base: &str, verifier: &str, state: &str) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Couldn't start the sign-in listener: {e}"))?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(err)?.port());
    let url = connect_url(base, verifier, &redirect, &device_name(app).await, state);
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("Couldn't open the browser: {e}. Use a code instead."))?;
    let code = tokio::select! {
        r = wait_for_code(&listener, state) => r?,
        _ = flow.cancel.notified() => return Err(CANCELLED.into()),
        _ = tokio::time::sleep(BROWSER_TIMEOUT) => return Err(NOTHING_BACK.into()),
    };
    crate::tray::show_main(app);
    Ok(code)
}

/// Phones: the native side opens the page (a Custom Tab on Android, KyblConnectPlugin.kt; an
/// ASWebAuthenticationSession sheet on iOS, KyblConnectPlugin.swift) and hands back the
/// `kybl://connect?…` redirect.
#[cfg(mobile)]
async fn browser_code(app: &AppHandle, flow: &Flow, base: &str, verifier: &str, state: &str) -> Result<String, String> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Back {
        url: Option<String>,
        cancelled: bool,
    }
    let native = app.try_state::<native::Native>().ok_or("The sign-in isn't available in this build.")?;
    let url = connect_url(base, verifier, native::REDIRECT, &device_name(app).await, state);
    let back = tokio::select! {
        r = native.0.run_mobile_plugin_async::<Back>("signIn", json!({ "url": url })) => r.map_err(|e| format!("Couldn't open the browser: {e}. Use a code instead."))?,
        _ = flow.cancel.notified() => {
            let _ = native.0.run_mobile_plugin_async::<Value>("cancel", ()).await;
            return Err(CANCELLED.into());
        }
        _ = tokio::time::sleep(BROWSER_TIMEOUT) => {
            let _ = native.0.run_mobile_plugin_async::<Value>("cancel", ()).await;
            return Err(NOTHING_BACK.into());
        }
    };
    match back.url {
        Some(u) if !back.cancelled => code_from_redirect(&query(&u), state),
        _ => Err(CANCELLED.into()),
    }
}

/// The whole browser flow: open the browser, wait for approval, exchange the code, save the
/// connection. Resolves with the new (or updated) connection.
#[tauri::command]
pub async fn kybl_connect_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    flow_id: String,
    app_url: Option<String>,
    replace_id: Option<String>,
) -> Result<Profile, String> {
    let base = base_url(app_url)?;
    let flow = Flow::new(&flow_id);
    let verifier = random_token();
    let csrf = random_token();
    let code = browser_code(&app, &flow, &base, &verifier, &csrf).await?;

    let (status, body) = post_json(&format!("{base}/v1/connect/token"), &json!({ "code": code, "code_verifier": verifier })).await?;
    if status != 200 {
        return Err(api_error(status, &body));
    }
    let tok: TokenResponse = serde_json::from_value(body).map_err(|e| format!("Kybl Storage sent an unexpected answer.\n\n{e}"))?;
    finish(&app, &state, tok, replace_id).await
}

// ---------------------------------------------------------------- device code

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: u64,
    interval: u64,
    /// QR code of `verification_uri_complete`, as an SVG document.
    qr_svg: String,
}

fn qr_svg(data: &str) -> String {
    match qrcode::QrCode::new(data.as_bytes()) {
        Ok(code) => code
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(168, 168)
            .dark_color(qrcode::render::svg::Color("#111111"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

#[tauri::command]
pub async fn kybl_device_start(app: AppHandle, app_url: Option<String>) -> Result<DeviceStart, String> {
    let base = base_url(app_url)?;
    let (status, body) = post_json(&format!("{base}/v1/connect/device"), &json!({ "device_name": device_name(&app).await })).await?;
    if status != 200 {
        return Err(api_error(status, &body));
    }
    let s = |k: &str| body.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let n = |k: &str, d: u64| body.get(k).and_then(Value::as_u64).unwrap_or(d);
    let complete = s("verification_uri_complete");
    Ok(DeviceStart {
        device_code: s("device_code"),
        user_code: s("user_code"),
        verification_uri: s("verification_uri"),
        qr_svg: qr_svg(&complete),
        verification_uri_complete: complete,
        expires_in: n("expires_in", 600),
        interval: n("interval", 5).max(1),
    })
}

/// Polls `/v1/connect/token` every `interval` seconds until the code is approved, declined or
/// expired, then saves the connection.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn kybl_device_wait(
    app: AppHandle,
    state: State<'_, AppState>,
    flow_id: String,
    app_url: Option<String>,
    device_code: String,
    interval: u64,
    expires_in: u64,
    replace_id: Option<String>,
) -> Result<Profile, String> {
    let base = base_url(app_url)?;
    let flow = Flow::new(&flow_id);
    let mut interval = Duration::from_secs(interval.max(1));
    let deadline = Instant::now() + Duration::from_secs(expires_in.max(30));
    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = flow.cancel.notified() => return Err(CANCELLED.into()),
        }
        let (status, body) = match post_json(&format!("{base}/v1/connect/token"), &json!({ "device_code": device_code })).await {
            Ok(r) => r,
            // a dropped request is not the end of the flow; try again next round
            Err(_) if Instant::now() < deadline => continue,
            Err(e) => return Err(e),
        };
        if status == 200 {
            let tok: TokenResponse = serde_json::from_value(body).map_err(|e| format!("Kybl Storage sent an unexpected answer.\n\n{e}"))?;
            #[cfg(desktop)]
            crate::tray::show_main(&app);
            return finish(&app, &state, tok, replace_id).await;
        }
        match body.get("error").and_then(Value::as_str) {
            // a proxy's brief outage or "too many requests" (no JSON error): keep polling
            None if transient(status) && Instant::now() < deadline => {
                if status == 429 {
                    interval += Duration::from_secs(5);
                }
            }
            Some("authorization_pending") if Instant::now() < deadline => {}
            Some("authorization_pending") => return Err(api_error(400, &json!({ "error": "expired_token" }))),
            Some("slow_down") => interval += Duration::from_secs(5),
            _ => return Err(api_error(status, &body)),
        }
    }
}

// ---------------------------------------------------------------- phone glue

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_kyblconnect);

/// Registers the native side: `KyblConnectPlugin` in the Android project, or the Swift package in
/// `gen/apple/KyblConnect` (linked by build.rs). Browser page, the `kybl://` redirect and the
/// phone's name. Nothing to do on a computer.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("kyblconnect")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _app.manage(native::Native(_api.register_android_plugin("app.kybl.mobile", "KyblConnectPlugin")?));
            #[cfg(target_os = "ios")]
            _app.manage(native::Native(_api.register_ios_plugin(init_plugin_kyblconnect)?));
            Ok(())
        })
        .build()
}

#[cfg(mobile)]
pub(crate) mod native {
    /// Where the account site sends the browser back to (allowed by the server: `kybl://…`).
    pub const REDIRECT: &str = "kybl://connect";
    pub const FALLBACK_NAME: &str = if cfg!(target_os = "ios") { "iPhone" } else { "Android" };
    pub struct Native(pub tauri::plugin::PluginHandle<tauri::Wry>);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_only_to_this_computer() {
        let ok = |u: &str| base_url(Some(u.into()));
        assert_eq!(ok("https://kybl.example/").unwrap(), "https://kybl.example");
        assert!(ok("http://127.0.0.1:8080").is_ok());
        assert!(ok("http://localhost/x").is_ok());
        assert!(ok("http://[::1]:9000").is_ok());
        assert!(ok("http://kybl.example").is_err());
        assert!(ok("http://127.0.0.1.evil.example").is_err());
        assert!(ok("http://127.0.0.1@evil.example").is_err());
        assert!(ok("ftp://x").is_err());
        assert!(transient(502) && transient(429) && !transient(400) && !transient(403));
    }

    #[test]
    fn pkce_matches_python() {
        // base64.urlsafe_b64encode(hashlib.sha256(v).digest()).rstrip(b"=")
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFXjrlNXk"), "Q5xyY1T_gOwG3oE4VitohDTkqvGRVUOM8U1l7zcsG_k");
    }

    #[test]
    fn base64url_without_padding() {
        assert_eq!(b64url(b""), "");
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"fo"), "Zm8");
        assert_eq!(b64url(b"foo"), "Zm9v");
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        let t = random_token();
        assert_eq!(t.len(), 43);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn callback_query_is_decoded() {
        let q = query("/callback?code=a%2Bb&state=x+y&error=");
        assert_eq!(q["code"], "a+b");
        assert_eq!(q["state"], "x y");
        assert_eq!(q["error"], "");
    }

    #[test]
    fn app_scheme_redirect_gives_the_code() {
        let back = |u: &str| code_from_redirect(&query(u), "s1");
        assert_eq!(back("kybl://connect?code=abc&state=s1").unwrap(), "abc");
        assert!(back("kybl://connect?code=abc&state=other").unwrap_err().contains("doesn't belong"));
        assert!(back("kybl://connect?error=access_denied&state=s1").unwrap_err().contains("cancelled"));
    }

    #[tokio::test]
    async fn loopback_ignores_strays_and_returns_the_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let send = move |path: &'static str| async move {
            let mut s = TcpStream::connect(addr).await.unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nhost: x\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        };
        let client = tokio::spawn(async move {
            assert!(send("/favicon.ico").await.starts_with("HTTP/1.1 404"));
            assert!(send("/callback?code=c&state=wrong").await.starts_with("HTTP/1.1 400"));
            assert!(send("/callback?code=the-code&state=good").await.contains("You're connected"));
        });
        assert_eq!(wait_for_code(&listener, "good").await.unwrap(), "the-code");
        client.await.unwrap();
    }
}
