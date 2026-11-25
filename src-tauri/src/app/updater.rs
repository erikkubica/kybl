//! Updates straight from GitHub Releases, with no update server of our own.
//!
//! The app asks the GitHub API for the latest published release (drafts and pre-releases are never
//! returned), compares its tag with its own version and picks the file built for this device:
//!
//! * **macOS**: `Kybl_<arch>.app.tar.gz` is unpacked next to the running app, checked with
//!   `codesign` against the running app's own signature, swapped in place and relaunched.
//! * **Windows**: the NSIS `-setup.exe` (the `.msi` for an MSI install) runs in passive mode and
//!   starts the app again when it is done.
//! * **Linux AppImage**: the new AppImage replaces the running one.
//! * **.deb / .rpm, Android, iOS**: the download (or the release page) opens in the browser and
//!   the package manager, Android's installer or AltStore installs it.
//!
//! Every download is checked against the SHA-256 GitHub records for the asset (an asset without
//! one is not installed), downloaded into a folder only this account can open, and checked again
//! right before it is installed or run. No second HTTP
//! stack: this is the same client the Kybl Storage sign-in uses.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

use crate::{kybl_connect::http, state::err};

const REPO: &str = "erikkubica/kybl";
const USER_AGENT: &str = concat!("Kybl/", env!("CARGO_PKG_VERSION"));
/// The first automatic check waits until the app has settled.
const FIRST_CHECK: Duration = Duration::from_secs(10);
/// A computer can stay open for weeks (in the menu bar): look again now and then.
#[cfg(desktop)]
const RECHECK: Duration = Duration::from_secs(6 * 3600);
const TIMEOUT: Duration = Duration::from_secs(30);
/// What `update_restart` answers while edits aren't saved or uploaded yet.
#[cfg(desktop)]
const UNSAVED: &str = "Save or close the files you're editing first (and let edits made in other apps finish uploading), then restart.";

// ---------------------------------------------------------------- state

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    version: String,
    /// the release page on GitHub
    page: String,
    notes: String,
    published: String,
    /// "install": the app downloads and installs it; "open": the download opens in the browser
    how: &'static str,
    asset: Option<Asset>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Asset {
    name: String,
    url: String,
    size: u64,
    sha256: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current: String,
    /// check on its own, at start and every few hours
    auto: bool,
    /// a version the user chose to skip: no prompt for it (still listed in settings)
    skipped: Option<String>,
    checking: bool,
    /// unix milliseconds of the last successful check
    last_checked: Option<u64>,
    error: Option<String>,
    available: Option<Release>,
    /// "" | "downloading" | "installing" | "ready" (installed, waiting for the restart)
    phase: &'static str,
    received: u64,
    total: u64,
}

pub struct Updater {
    st: Mutex<UpdateStatus>,
    /// Windows: the downloaded installer and its SHA-256, run on restart (checked again first)
    #[cfg_attr(not(windows), allow(dead_code))]
    file: Mutex<Option<(PathBuf, String)>>,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    #[serde(default = "yes")]
    auto: bool,
    #[serde(default)]
    skipped: Option<String>,
}

fn yes() -> bool {
    true
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("updates.json"))
}

fn save(app: &AppHandle, st: &UpdateStatus) -> Result<(), String> {
    let p = prefs_path(app).ok_or("No config folder")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let s = Stored { auto: st.auto, skipped: st.skipped.clone() };
    crate::state::write_atomic(&p, &serde_json::to_vec(&s).map_err(err)?).map_err(err)
}

/// Changes the status and tells the window (and the menu bar) about it.
fn update(app: &AppHandle, f: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
    let up = app.state::<Updater>();
    let snap = {
        let mut st = up.st.lock().unwrap();
        f(&mut st);
        st.clone()
    };
    let _ = app.emit("update-status", &snap);
    #[cfg(desktop)]
    crate::app::tray::set_update(app, snap.available.as_ref().map(|r| r.version.as_str()));
    snap
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Loads the settings and starts the automatic checks.
pub fn start(app: &AppHandle) {
    let stored: Stored = prefs_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or(Stored { auto: true, skipped: None });
    app.manage(Updater {
        st: Mutex::new(UpdateStatus {
            current: app.package_info().version.to_string(),
            auto: stored.auto,
            skipped: stored.skipped,
            ..Default::default()
        }),
        file: Mutex::new(None),
    });
    // debug builds have nothing to update; KYBL_UPDATE_CHECK=1 checks anyway (to try the flow)
    if cfg!(debug_assertions) && std::env::var_os("KYBL_UPDATE_CHECK").is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if app.state::<Updater>().st.lock().unwrap().auto {
                let _ = check(&app).await;
            }
            // a phone app is reopened often enough: once per launch
            #[cfg(mobile)]
            break;
            #[cfg(desktop)]
            tokio::time::sleep(RECHECK).await;
        }
    });
}

// ---------------------------------------------------------------- GitHub

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    /// "sha256:<hex>", recorded by GitHub on upload
    #[serde(default)]
    digest: Option<String>,
}

/// GET that follows redirects (release downloads go through GitHub's CDN), HTTPS only.
async fn get(url: &str, accept: &str) -> Result<hyper::Response<hyper::body::Incoming>, String> {
    let mut url = url.to_string();
    for _ in 0..8 {
        if !url.starts_with("https://") {
            return Err(format!("Refusing a non-HTTPS address: {url}"));
        }
        let req = hyper::Request::get(&url)
            .header("user-agent", USER_AGENT)
            .header("accept", accept)
            .body(Full::new(Bytes::new()))
            .map_err(err)?;
        let res = tokio::time::timeout(TIMEOUT, http()?.request(req))
            .await
            .map_err(|_| "Can't reach GitHub: the request timed out.".to_string())?
            .map_err(|e| format!("Can't reach GitHub. Check your internet connection.\n\n{e:?}"))?;
        if res.status().is_redirection()
            && let Some(next) = res.headers().get("location").and_then(|v| v.to_str().ok())
        {
            url = next.to_string();
            continue;
        }
        return Ok(res);
    }
    Err("GitHub redirected too many times.".into())
}

async fn latest_release() -> Result<GhRelease, String> {
    let res = get(&format!("https://api.github.com/repos/{REPO}/releases/latest"), "application/vnd.github+json").await?;
    let status = res.status().as_u16();
    let body = tokio::time::timeout(TIMEOUT, res.into_body().collect())
        .await
        .map_err(|_| "GitHub took too long to answer.".to_string())?
        .map_err(err)?
        .to_bytes();
    match status {
        200 => serde_json::from_slice(&body).map_err(|e| format!("GitHub sent a release Kybl can't read: {e}")),
        404 => Err("No release has been published yet.".into()),
        403 | 429 => Err("GitHub is limiting update checks from this network for now. Try again in an hour.".into()),
        s => Err(format!("GitHub answered HTTP {s}. Try again later.")),
    }
}

/// `v1.2.3` (or `1.2.3-beta`) as numbers, padded to three parts.
fn parse_version(v: &str) -> Option<Vec<u64>> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    parts.resize(parts.len().max(3), 0);
    Some(parts)
}

fn is_newer(remote: &str, current: &str) -> bool {
    matches!((parse_version(remote), parse_version(current)), (Some(r), Some(c)) if r > c)
}

#[cfg_attr(target_os = "ios", allow(dead_code))]
fn find(rel: &GhRelease, f: impl Fn(&str) -> bool) -> Option<&GhAsset> {
    rel.assets.iter().find(|a| f(&a.name))
}

#[cfg(target_os = "macos")]
fn pick(rel: &GhRelease) -> (&'static str, Option<&GhAsset>) {
    let name = format!("Kybl_{}.app.tar.gz", if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" });
    match find(rel, |n| n == name) {
        Some(a) if running_bundle().is_some() => ("install", Some(a)),
        _ => ("open", find(rel, |n| n.ends_with(if cfg!(target_arch = "aarch64") { "_aarch64.dmg" } else { "_x64.dmg" }))),
    }
}

#[cfg(windows)]
fn nsis_install() -> bool {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("uninstall.exe").exists())).unwrap_or(false)
}

#[cfg(windows)]
fn pick(rel: &GhRelease) -> (&'static str, Option<&GhAsset>) {
    let asset = if nsis_install() { find(rel, |n| n.ends_with("-setup.exe")) } else { find(rel, |n| n.ends_with(".msi")) };
    match asset {
        Some(a) => ("install", Some(a)),
        None => ("open", None),
    }
}

#[cfg(target_os = "linux")]
fn appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file())
}

#[cfg(target_os = "linux")]
fn pick(rel: &GhRelease) -> (&'static str, Option<&GhAsset>) {
    // only x86_64 is built for Linux
    if !cfg!(target_arch = "x86_64") {
        return ("open", None);
    }
    if appimage().is_some() {
        if let Some(a) = find(rel, |n| n.ends_with("_amd64.AppImage")) {
            return ("install", Some(a));
        }
    }
    // installed from a package: the package manager installs the download (it needs root)
    let pkg = if Path::new("/etc/debian_version").exists() {
        find(rel, |n| n.ends_with("_amd64.deb"))
    } else if Path::new("/etc/redhat-release").exists() || Path::new("/etc/fedora-release").exists() || Path::new("/etc/SuSE-release").exists() {
        find(rel, |n| n.ends_with(".x86_64.rpm"))
    } else {
        None
    };
    ("open", pkg)
}

#[cfg(target_os = "android")]
fn pick(rel: &GhRelease) -> (&'static str, Option<&GhAsset>) {
    ("open", find(rel, |n| n == "Kybl.apk"))
}

/// Sideloaded: AltStore / SideStore install updates from the source the release carries.
#[cfg(target_os = "ios")]
fn pick(_rel: &GhRelease) -> (&'static str, Option<&GhAsset>) {
    ("open", None)
}

fn to_release(rel: &GhRelease) -> Release {
    let (how, asset) = pick(rel);
    Release {
        version: rel.tag_name.trim_start_matches('v').to_string(),
        page: rel.html_url.clone(),
        notes: rel.body.clone().unwrap_or_default(),
        published: rel.published_at.clone().unwrap_or_default(),
        how,
        asset: asset.map(|a| Asset {
            name: a.name.clone(),
            url: a.browser_download_url.clone(),
            size: a.size,
            sha256: a.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")).map(str::to_ascii_lowercase),
        }),
    }
}

async fn check(app: &AppHandle) -> Result<(), String> {
    {
        let up = app.state::<Updater>();
        let mut st = up.st.lock().unwrap();
        // an update being installed keeps what it found
        if st.checking || !st.phase.is_empty() {
            return Ok(());
        }
        st.checking = true;
    }
    update(app, |st| st.error = None);
    let res = latest_release().await;
    let current = app.package_info().version.to_string();
    update(app, |st| {
        st.checking = false;
        match &res {
            Ok(rel) => {
                st.last_checked = Some(now_ms());
                st.available = is_newer(&rel.tag_name, &current).then(|| to_release(rel));
            }
            Err(e) => st.error = Some(e.clone()),
        }
    });
    res.map(|_| ())
}

// ---------------------------------------------------------------- download and install

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The SHA-256 GitHub lists for the asset, which every update must have.
fn wanted_sha(a: &Asset) -> Result<&str, String> {
    a.sha256
        .as_deref()
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| "GitHub lists no checksum for this update, so it can't be checked and wasn't installed. Download it from the release page instead.".into())
}

/// The SHA-256 of a file on disk (lower-case hex).
fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(err)?;
    let mut sha = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    Ok(hex(sha.finish().as_ref()))
}

/// Whether the file at `path` is still the one GitHub lists (checked again right before it is
/// installed or run, so what runs is what was checked).
fn still_matches(path: &Path, want: &str) -> Result<(), String> {
    if sha256_file(path)? == want {
        Ok(())
    } else {
        Err("The update file changed after it was checked, so it wasn't installed. Try again.".into())
    }
}

/// Downloads into `dir`, emptied and made private to this account first (the app's cache
/// folder, never a shared temp folder another account could plant files in);
/// `progress(received, total)` is called now and then. The file is checked against the
/// SHA-256 GitHub lists, read back from disk.
async fn download(a: &Asset, dir: &Path, progress: impl Fn(u64, u64)) -> Result<PathBuf, String> {
    let want = wanted_sha(a)?.to_ascii_lowercase();
    let _ = tokio::fs::remove_dir_all(dir).await;
    crate::files::filecache::private_dir(dir).map_err(err)?;
    let name = Path::new(&a.name).file_name().ok_or("The update file has no name")?;
    let path = dir.join(name);

    let res = get(&a.url, "application/octet-stream").await?;
    if !res.status().is_success() {
        return Err(format!("The download failed: GitHub answered HTTP {}.", res.status().as_u16()));
    }
    let total = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok()?.parse().ok())
        .unwrap_or(a.size);
    progress(0, total);
    let mut opts = tokio::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut file = opts.open(&path).await.map_err(err)?;
    let mut sha = ring::digest::Context::new(&ring::digest::SHA256);
    let mut body = res.into_body();
    let mut got = 0u64;
    let mut shown = Instant::now();
    while let Some(frame) = tokio::time::timeout(Duration::from_secs(60), body.frame())
        .await
        .map_err(|_| "The download stalled. Try again.".to_string())?
    {
        let Ok(data) = frame.map_err(|e| format!("The download was interrupted: {e}"))?.into_data() else { continue };
        sha.update(&data);
        file.write_all(&data).await.map_err(err)?;
        got += data.len() as u64;
        if shown.elapsed() > Duration::from_millis(150) {
            shown = Instant::now();
            progress(got, total);
        }
    }
    file.flush().await.map_err(err)?;
    drop(file);
    progress(got, total);

    if a.size > 0 && got != a.size {
        return Err(format!("The download is incomplete ({got} of {} bytes). Try again.", a.size));
    }
    // the bytes received, and the file they were written to
    let on_disk = {
        let p = path.clone();
        tokio::task::spawn_blocking(move || sha256_file(&p)).await.map_err(err)??
    };
    if hex(sha.finish().as_ref()) != want || on_disk != want {
        let _ = tokio::fs::remove_file(&path).await;
        return Err("The download doesn't match the checksum GitHub lists for it, so it wasn't installed.".into());
    }
    Ok(path)
}

/// `/Applications/Kybl.app` when running from an app bundle.
#[cfg(target_os = "macos")]
fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn codesign(args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let out = std::process::Command::new("/usr/bin/codesign").args(args).output().map_err(err)?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

/// The new app must be intact and signed with the same certificate as this copy (every release
/// is signed with one). A copy without a certificate (ad-hoc signed: a local build, or a release
/// built without one) has nothing to compare against, so it doesn't update itself: any validly
/// signed app would pass.
#[cfg(target_os = "macos")]
fn verify_signature(current: &Path, new: &Path) -> Result<(), String> {
    use std::ffi::OsStr;
    codesign(&[OsStr::new("--verify"), OsStr::new("--strict"), OsStr::new("--deep"), new.as_os_str()])
        .map_err(|e| format!("The update's signature is broken, so it wasn't installed.\n\n{e}"))?;
    let designated = codesign(&[OsStr::new("-d"), OsStr::new("-r-"), current.as_os_str()])
        .map_err(|e| format!("Couldn't read this copy's signature, so the update can't be checked and wasn't installed.\n\n{e}"))?
        .lines()
        .find_map(|l| l.strip_prefix("designated => ").map(str::to_string));
    let req = designated.filter(|r| r.contains("certificate")).ok_or(
        "This copy of Kybl isn't signed with a certificate, so an update can't be checked against it and wasn't installed. Download it from the release page instead.",
    )?;
    let req = format!("={req}");
    codesign(&[OsStr::new("--verify"), OsStr::new("-R"), OsStr::new(&req), new.as_os_str()])
        .map_err(|e| format!("The update isn't signed like this copy of Kybl, so it wasn't installed.\n\n{e}"))?;
    Ok(())
}

/// Unpacks the new app next to the running one (same disk, so the swap is two renames) and
/// swaps it in. The running app keeps working from the old files until it restarts.
#[cfg(target_os = "macos")]
fn install(_app: &AppHandle, file: &Path, sha: &str) -> Result<(), String> {
    let bundle = running_bundle().ok_or("This copy of Kybl isn't an installed app, so it can't update itself.")?;
    still_matches(file, sha)?;
    install_into(&bundle, file)
}

#[cfg(target_os = "macos")]
fn install_into(bundle: &Path, file: &Path) -> Result<(), String> {
    let bundle = bundle.to_path_buf();
    let parent = bundle.parent().ok_or("No folder around the app")?;
    let stage = parent.join(".kybl-update");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir(&stage).map_err(|e| {
        format!("Kybl can't write to {} to replace itself ({e}). Download the update from the release page instead.", parent.display())
    })?;
    let result = (|| {
        let out = std::process::Command::new("/usr/bin/tar").arg("-xzf").arg(file).arg("-C").arg(&stage).output().map_err(err)?;
        if !out.status.success() {
            return Err(format!("Couldn't unpack the update: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let new = std::fs::read_dir(&stage)
            .map_err(err)?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or("The update has no app in it.")?;
        verify_signature(&bundle, &new)?;
        let old = stage.join("previous.app");
        std::fs::rename(&bundle, &old).map_err(|e| format!("Couldn't move the old app aside: {e}"))?;
        if let Err(e) = std::fs::rename(&new, &bundle) {
            let _ = std::fs::rename(&old, &bundle);
            return Err(format!("Couldn't put the new app in place: {e}"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

/// Nothing to do yet: the installer runs on restart, once the app is out of its way.
#[cfg(windows)]
fn install(app: &AppHandle, file: &Path, sha: &str) -> Result<(), String> {
    *app.state::<Updater>().file.lock().unwrap() = Some((file.to_path_buf(), sha.to_string()));
    Ok(())
}

/// Writes the new AppImage beside the running one, then renames it over it.
#[cfg(target_os = "linux")]
fn install(_app: &AppHandle, file: &Path, sha: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let target = appimage().ok_or("Not running from an AppImage")?;
    let tmp = target.with_file_name(".Kybl.AppImage.new");
    std::fs::copy(file, &tmp).map_err(|e| format!("Kybl can't write next to {} ({e}). Download the update from the release page instead.", target.display()))?;
    // the copy is the file that will run: it is the one checked
    if let Err(e) = still_matches(&tmp, sha) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let done = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).and_then(|_| std::fs::rename(&tmp, &target));
    if let Err(e) = done {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't replace the AppImage: {e}"));
    }
    Ok(())
}

#[cfg(mobile)]
fn install(_app: &AppHandle, _file: &Path, _sha: &str) -> Result<(), String> {
    Err("Updates install from the browser on this device.".into())
}

fn fail(app: &AppHandle, e: String) -> String {
    update(app, |st| {
        st.phase = "";
        st.error = Some(e.clone());
    });
    e
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn update_status(up: State<'_, Updater>) -> UpdateStatus {
    up.st.lock().unwrap().clone()
}

/// Checks now, whatever the automatic setting.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    check(&app).await?;
    Ok(app.state::<Updater>().st.lock().unwrap().clone())
}

/// `auto`: check on its own. `skip`: a version not to prompt for ("" clears it).
#[tauri::command]
pub fn update_settings(app: AppHandle, auto: Option<bool>, skip: Option<String>) -> Result<UpdateStatus, String> {
    let change = |st: &mut UpdateStatus| {
        if let Some(a) = auto {
            st.auto = a;
        }
        if let Some(s) = &skip {
            st.skipped = (!s.is_empty()).then(|| s.clone());
        }
    };
    // saved first, live once saved: a failed save changes nothing
    let mut next = app.state::<Updater>().st.lock().unwrap().clone();
    change(&mut next);
    save(&app, &next)?;
    let st = update(&app, change);
    let turned_on = auto == Some(true) && st.last_checked.is_none() && !st.checking;
    if turned_on {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = check(&app).await;
        });
    }
    Ok(st)
}

/// Downloads and installs the update found by the last check, or opens it in the browser where
/// the system installs it. Installed updates take effect with [`update_restart`].
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<UpdateStatus, String> {
    let rel = {
        let up = app.state::<Updater>();
        let mut st = up.st.lock().unwrap();
        let rel = st.available.clone().ok_or("There is no update to install. Check for updates first.")?;
        if rel.how == "install" {
            if !st.phase.is_empty() {
                return Ok(st.clone());
            }
            st.phase = "downloading";
        }
        rel
    };
    if rel.how != "install" {
        let url = rel.asset.as_ref().map_or(rel.page.as_str(), |a| a.url.as_str());
        app.opener().open_url(url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
        return Ok(app.state::<Updater>().st.lock().unwrap().clone());
    }
    update(&app, |st| st.error = None);
    let asset = rel.asset.clone().ok_or_else(|| fail(&app, "The release has no file for this device.".into()))?;
    let dir = app.path().app_cache_dir().map_err(|e| fail(&app, e.to_string()))?.join("update");
    let file = download(&asset, &dir, |received, total| {
        update(&app, |st| {
            st.received = received;
            st.total = total;
        });
    })
    .await
    .map_err(|e| fail(&app, e))?;
    update(&app, |st| st.phase = "installing");
    let app2 = app.clone();
    let sha = asset.sha256.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || install(&app2, &file, &sha))
        .await
        .map_err(|e| fail(&app, e.to_string()))?
        .map_err(|e| fail(&app, e))?;
    Ok(update(&app, |st| st.phase = "ready"))
}

/// Starts the new version: relaunches the swapped-in app, or hands over to the installer.
/// Unless `force`, answers `"busy"` while transfers or bucket operations run (`"busy:terminal"` for terminal programs), so the
/// window can offer to restart when they are done instead of cutting them off.
#[tauri::command]
pub async fn update_restart(app: AppHandle, force: Option<bool>) -> Result<(), String> {
    if app.state::<Updater>().st.lock().unwrap().phase != "ready" {
        return Err("The update isn't installed yet.".into());
    }
    if !force.unwrap_or(false) && !app.state::<crate::state::AppState>().cancels.lock().await.is_empty() {
        return Err("busy".into());
    }
    // a program running in a terminal ends with the restart: ask first, like for transfers
    #[cfg(desktop)]
    if !force.unwrap_or(false) && crate::terminal::busy_sessions().await > 0 {
        // told apart so the window doesn't say transfers are running when it's a terminal
        return Err("busy:terminal".into());
    }
    // unsaved edits (in the editor, or saved in another app but not uploaded yet) would be lost:
    // the clean-up below deletes the edit copies. Quit asks about them; a restart waits for them,
    // even when forced (forcing stops transfers, which can be done again; edits can't)
    #[cfg(desktop)]
    if crate::app::quit::unsaved() > 0 {
        return Err(UNSAVED.into());
    }
    // Stop transfers and abort their uploads first, the way quitting does: the exit the restart
    // makes then neither asks "Quit anyway?" again nor races the installer with the cleanup.
    #[cfg(desktop)]
    {
        can_restart(&app)?;
        crate::app::quit::clean_up(&app).await;
    }
    let r = restart(&app);
    #[cfg(desktop)]
    if r.is_err() {
        crate::app::quit::stay(&app);
    }
    r
}

/// What [`restart`] needs is there, checked before transfers are stopped for it.
#[cfg(desktop)]
fn can_restart(_app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    appimage().ok_or("Not running from an AppImage")?;
    #[cfg(windows)]
    {
        // the installer is checked here too (and again in `restart`): a file gone or changed
        // in the cache fails before anything was stopped, and the update can be downloaded
        // again instead of staying "ready" with a file that will never run
        let file = _app.state::<Updater>().file.lock().unwrap().clone();
        let checked = match &file {
            Some((f, sha)) if f.is_file() => still_matches(f, sha),
            _ => Err("The installer is missing. Try again.".into()),
        };
        if let Err(e) = checked {
            forget_download(_app);
            return Err(e);
        }
    }
    Ok(())
}

/// Back to "nothing downloaded": the next install downloads (and checks) the file again.
#[cfg(windows)]
fn forget_download(app: &AppHandle) {
    app.state::<Updater>().file.lock().unwrap().take();
    update(app, |st| {
        st.phase = "";
        st.received = 0;
    });
}

#[cfg(target_os = "macos")]
fn restart(app: &AppHandle) -> Result<(), String> {
    app.restart()
}

#[cfg(target_os = "linux")]
fn restart(app: &AppHandle) -> Result<(), String> {
    let target = appimage().ok_or("Not running from an AppImage")?;
    std::process::Command::new(target).spawn().map_err(|e| format!("Couldn't start the new version: {e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
fn restart(app: &AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let (file, sha) = app.state::<Updater>().file.lock().unwrap().clone().ok_or("The installer is missing. Try again.")?;
    // it waited in the cache since it was checked: what runs is what was checked
    if let Err(e) = still_matches(&file, &sha) {
        forget_download(app);
        return Err(e);
    }
    let started = if file.extension().is_some_and(|e| e.eq_ignore_ascii_case("msi")) {
        // msiexec cannot start the app afterwards: chain it
        let exe = std::env::current_exe().map_err(err)?;
        std::process::Command::new("cmd")
            .raw_arg(format!("/C msiexec /i \"{}\" /passive /norestart && start \"\" \"{}\"", file.display(), exe.display()))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    } else {
        // passive install, then the installer starts the app again (/R)
        std::process::Command::new(&file).args(["/P", "/R", "/UPDATE"]).spawn()
    };
    started.map_err(|e| format!("Couldn't start the installer: {e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(mobile)]
fn restart(_app: &AppHandle) -> Result<(), String> {
    Err("Updates install from the browser on this device.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number() {
        assert!(is_newer("v0.3.10", "0.3.2"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(is_newer("0.4", "0.3.9"));
        assert!(!is_newer("v0.3.2", "0.3.2"));
        assert!(!is_newer("v0.3.1", "0.3.2"));
        assert!(!is_newer("v0.3.3-beta", "0.3.3"));
        assert!(!is_newer("nightly", "0.3.2"));
    }

    #[test]
    fn digest_is_read_from_github() {
        let rel: GhRelease = serde_json::from_str(
            r#"{"tag_name":"v9.9.9","html_url":"https://github.com/x/y/releases/tag/v9.9.9","assets":[
                {"name":"Kybl_aarch64.app.tar.gz","browser_download_url":"https://x/a","size":1,"digest":"sha256:ABCD"},
                {"name":"Kybl_x64.app.tar.gz","browser_download_url":"https://x/b","size":1,"digest":"sha256:ABCD"},
                {"name":"Kybl_9.9.9_x64-setup.exe","browser_download_url":"https://x/c","size":1,"digest":"sha256:ABCD"},
                {"name":"Kybl_9.9.9_amd64.deb","browser_download_url":"https://x/d","size":1},
                {"name":"Kybl.apk","browser_download_url":"https://x/e","size":1}
            ]}"#,
        )
        .unwrap();
        let r = to_release(&rel);
        assert_eq!(r.version, "9.9.9");
        if let Some(a) = r.asset {
            assert!(a.sha256.is_none() || a.sha256.as_deref() == Some("abcd"));
        }
    }

    /// No checksum from GitHub: nothing is downloaded, let alone installed.
    #[tokio::test]
    async fn an_update_without_a_checksum_is_refused() {
        let dir = std::env::temp_dir().join(format!("kybl-upd-{}", uuid::Uuid::new_v4()));
        let a = |sha: Option<&str>| Asset { name: "Kybl.AppImage".into(), url: "https://example.invalid/x".into(), size: 1, sha256: sha.map(str::to_string) };
        for sha in [None, Some(""), Some("abcd"), Some(&*"z".repeat(64))] {
            let e = download(&a(sha), &dir, |_, _| {}).await.unwrap_err();
            assert!(e.contains("no checksum"), "{e}");
        }
        assert!(!dir.exists(), "nothing was written");
    }

    #[test]
    fn the_file_is_checked_again_before_it_runs() {
        let dir = std::env::temp_dir().join(format!("kybl-upd-{}", uuid::Uuid::new_v4()));
        crate::files::filecache::private_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let f = dir.join("setup.exe");
        std::fs::write(&f, b"hello").unwrap();
        let want = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(sha256_file(&f).unwrap(), want);
        assert!(still_matches(&f, want).is_ok());
        std::fs::write(&f, b"hellO").unwrap();
        assert!(still_matches(&f, want).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole macOS path against the real latest release: GitHub API, the CDN redirect, the
    /// checksum, unpacking, the signature check against a copy of the installed app (signed
    /// with the release certificate) and the swap. Run with:
    /// `cargo test --lib updater::tests::mac_end_to_end -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "downloads the latest release from GitHub; needs /Applications/Kybl.app"]
    async fn mac_end_to_end() {
        let rel = latest_release().await.expect("latest release");
        let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
        let gh = find(&rel, |n| n == format!("Kybl_{arch}.app.tar.gz")).expect("mac asset");
        let asset = Asset {
            name: gh.name.clone(),
            url: gh.browser_download_url.clone(),
            size: gh.size,
            sha256: gh.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")).map(str::to_ascii_lowercase),
        };
        assert!(asset.sha256.is_some(), "GitHub lists a digest");
        let file = download(&asset, &std::env::temp_dir().join(format!("kybl-e2e-dl-{}", std::process::id())), |got, total| eprint!("\r{got} / {total}")).await.expect("download");
        eprintln!();

        let dir = std::env::temp_dir().join(format!("kybl-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bundle = dir.join("Kybl.app");
        assert!(std::process::Command::new("/usr/bin/ditto").arg("/Applications/Kybl.app").arg(&bundle).status().unwrap().success());
        // mark the copy so the swap is visible
        std::fs::write(bundle.join("Contents/old-marker"), b"x").unwrap();

        match install_into(&bundle, &file) {
            Ok(()) => {}
            // the release is signed differently (ad-hoc while CI has no certificate): refused,
            // and the old app is untouched
            Err(e) if e.contains("isn't signed like") => {
                eprintln!("refused as expected: {e}");
                assert!(bundle.join("Contents/old-marker").exists(), "a refused update leaves the app alone");
                std::fs::remove_dir_all(&dir).unwrap();
                return;
            }
            Err(e) => panic!("install: {e}"),
        }
        // an ad-hoc signed copy has nothing to check an update against: refused
        assert!(std::process::Command::new("/usr/bin/codesign").args(["--force", "--deep", "-s", "-"]).arg(&bundle).status().unwrap().success());
        assert!(install_into(&bundle, &file).unwrap_err().contains("isn't signed with a certificate"));
        assert!(!bundle.join("Contents/old-marker").exists(), "the new app replaced the old one");
        let plist = std::fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap();
        assert!(plist.contains(&rel.tag_name.trim_start_matches('v').to_string()), "new version in place");
        assert!(!dir.join(".kybl-update").exists(), "staging cleaned up");

        // a corrupted archive is refused before anything is touched
        let bad = dir.join("bad.tar.gz");
        std::fs::write(&bad, b"not a tarball").unwrap();
        assert!(install_into(&bundle, &bad).is_err());
        assert!(bundle.join("Contents/Info.plist").exists(), "the app is still there");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
