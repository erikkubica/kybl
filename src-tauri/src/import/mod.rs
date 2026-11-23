//! "Import connections": bring saved sites over from other file transfer apps.
//!
//! Each app is a [`Source`] that only reads its own file format into one neutral shape,
//! [`ImportedSite`]. Everything after that is shared by every source: the preview the page shows
//! (never with a password in it), spotting sites that are already in Kybl, and turning a site into
//! a profile plus its vault secret exactly the way the connection dialog's Save does.
//!
//! Passwords never travel through the webview: the preview leaves them out, and applying reads
//! the file again here and stores the chosen sites' secrets straight into the vault.

mod filezilla;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::state::{load_profiles, save_profiles, set_secret, AppState, ConnKind, NetAuth, NetConfig, Profile, TlsMode};

/// How a site signs in, as far as the other app told us.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SiteAuth {
    /// a password is saved and readable
    Password,
    /// anonymous FTP: no user name, no password
    Anonymous,
    /// nothing saved (the app asks each time, or it was never stored)
    Missing,
    /// a private key file on this computer
    KeyFile,
    /// the SSH agent (FileZilla has no such setting; apps like WinSCP and Cyberduck do)
    #[allow(dead_code)]
    Agent,
    /// saved, but encrypted with a key Kybl doesn't have (a master password)
    Encrypted,
}

/// One saved site from another app, in a shape every source shares.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSite {
    /// stable across reads of the same file, so the page can name its picks
    pub id: String,
    pub name: String,
    /// the folders the other app filed it under, outermost first
    pub folder: Vec<String>,
    /// what Kybl makes of it; `None` when Kybl can't open this kind (then `skip` says why)
    pub kind: Option<ConnKind>,
    /// the other app's name for the protocol ("FTP over TLS", "SFTP"), for the badge
    pub protocol: String,
    pub host: String,
    /// 0: the usual port
    pub port: u16,
    pub user: String,
    /// the folder to start in ("" for the server's own start)
    pub start_dir: String,
    pub tls: TlsMode,
    pub auth: SiteAuth,
    /// things the source noticed that don't carry over ("Active mode isn't available")
    pub notes: Vec<String>,
    /// why this site can't be imported at all
    pub skip: Option<String>,
    /// the password (or S3 secret key); never sent to the page
    #[serde(skip)]
    pub secret: Option<String>,
    /// SFTP: the private key file the other app signs in with; read only when importing
    #[serde(skip)]
    pub key_file: Option<PathBuf>,
}

impl ImportedSite {
    /// A blank site, for sources to fill in.
    pub fn new(name: String, folder: Vec<String>, protocol: String) -> Self {
        Self {
            id: String::new(),
            name,
            folder,
            kind: None,
            protocol,
            host: String::new(),
            port: 0,
            user: String::new(),
            start_dir: String::new(),
            tls: TlsMode::None,
            auth: SiteAuth::Missing,
            notes: vec![],
            skip: None,
            secret: None,
            key_file: None,
        }
    }
}

/// An app Kybl can import from.
pub trait Source: Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// Where the app keeps its sites on this computer, most likely first.
    fn default_paths(&self) -> Vec<PathBuf>;
    /// What "Choose file…" offers: a label and the file extensions.
    fn file_filter(&self) -> (&'static str, &'static [&'static str]);
    /// Reads every site in `path`.
    fn parse(&self, path: &Path) -> Result<Vec<ImportedSite>, String>;
    /// One-line remarks about the whole import ("FileZilla's TLS-if-available becomes TLS").
    fn hints(&self, _sites: &[ImportedSite]) -> Vec<String> {
        vec![]
    }
    /// The app's file on this computer, if it's there.
    fn detect(&self) -> Option<PathBuf> {
        self.default_paths().into_iter().find(|p| p.is_file())
    }
}

/// Every app Kybl imports from. A new importer is one more file and one more line here.
static SOURCES: &[&dyn Source] = &[&filezilla::FileZilla];

fn source(id: &str) -> Result<&'static dyn Source, String> {
    SOURCES.iter().copied().find(|s| s.id() == id).ok_or_else(|| format!("Kybl can't import from “{id}”."))
}

/// A home-relative folder, from the environment (the import commands never need more than this).
pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|v| !v.is_empty()).map(PathBuf::from)
}

// ---------------------------------------------------------------- what the page sees

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// the app's file was found on this computer
    pub detected: bool,
    /// where it was found, or where it would usually be
    pub path: Option<String>,
    pub filter_name: &'static str,
    pub extensions: &'static [&'static str],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePreview {
    #[serde(flatten)]
    pub site: ImportedSite,
    pub has_password: bool,
    /// it imports, but can't sign in until someone adds a password or key
    pub needs_secret: bool,
    /// the existing connection this site matches (same kind, server, port and user)
    pub duplicate_of: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub source: &'static str,
    pub path: String,
    pub sites: Vec<SitePreview>,
    pub hints: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: Vec<Profile>,
    pub skipped: Vec<Skipped>,
    /// imported, but can't sign in until a password or key is added
    pub needs_secret: Vec<String>,
}

fn resolve_path(src: &dyn Source, path: Option<String>) -> Result<PathBuf, String> {
    match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => Ok(PathBuf::from(p)),
        None => src.detect().ok_or_else(|| format!("{}'s site list isn't on this computer. Choose the file instead.", src.name())),
    }
}

#[tauri::command]
pub fn import_sources() -> Vec<SourceInfo> {
    SOURCES
        .iter()
        .map(|s| {
            let found = s.detect();
            let (filter_name, extensions) = s.file_filter();
            SourceInfo {
                id: s.id(),
                name: s.name(),
                detected: found.is_some(),
                path: found.or_else(|| s.default_paths().into_iter().next()).map(|p| p.to_string_lossy().into_owned()),
                filter_name,
                extensions,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn import_preview(app: AppHandle, source: String, path: Option<String>) -> Result<ImportPreview, String> {
    let src = self::source(&source)?;
    let path = resolve_path(src, path)?;
    let sites = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || src.parse(&path)).await.map_err(|e| e.to_string())??
    };
    let existing = load_profiles(&app)?;
    Ok(preview(src, &path, sites, &existing))
}

fn preview(src: &dyn Source, path: &Path, sites: Vec<ImportedSite>, existing: &[Profile]) -> ImportPreview {
    let hints = src.hints(&sites);
    let sites = sites
        .into_iter()
        .map(|mut site| {
            // the same mapping importing does, so the list never promises what importing refuses
            let needs_secret = match to_profile(&site, String::new()) {
                Ok(m) => m.needs_secret,
                Err(why) => {
                    site.skip.get_or_insert(why);
                    false
                }
            };
            add_auth_notes(&mut site);
            let duplicate_of = existing.iter().find(|p| same_place(&site, p)).map(|p| p.name.clone());
            let has_password = site.secret.as_deref().is_some_and(|s| !s.is_empty());
            SitePreview { site, has_password, needs_secret, duplicate_of }
        })
        .collect();
    ImportPreview { source: src.id(), path: path.to_string_lossy().into_owned(), sites, hints }
}

/// The sign-in remarks every source shares, in the words the dialog shows.
fn add_auth_notes(site: &mut ImportedSite) {
    if site.skip.is_some() {
        return;
    }
    let note = match site.auth {
        SiteAuth::Missing => Some("No password saved: add it after import".to_string()),
        SiteAuth::Encrypted => Some("Encrypted with a master password: enter the password after import".to_string()),
        SiteAuth::Anonymous => Some("Anonymous sign-in".to_string()),
        SiteAuth::Agent => Some("Signs in with the SSH agent".to_string()),
        SiteAuth::KeyFile => Some(match &site.key_file {
            Some(k) if k.is_file() => format!("Key file {}", k.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
            _ => "Key file not found: choose the key after import".to_string(),
        }),
        SiteAuth::Password => None,
    };
    if let Some(n) = note {
        site.notes.insert(0, n);
    }
}

// ---------------------------------------------------------------- matching existing connections

/// The port a connection really uses when it says 0.
fn effective_port(kind: ConnKind, tls: TlsMode, port: u16) -> u16 {
    if port != 0 {
        return port;
    }
    match (kind, tls) {
        (ConnKind::Sftp, _) => 22,
        (ConnKind::Ftp, TlsMode::Implicit) => 990,
        (ConnKind::Ftp, _) => 21,
        (_, TlsMode::None) => 80,
        _ => 443,
    }
}

/// The same server and account as an existing connection: kind, host, port and user name (for
/// S3 the endpoint and access key).
fn same_place(site: &ImportedSite, p: &Profile) -> bool {
    let Some(kind) = site.kind else { return false };
    if kind != p.kind {
        return false;
    }
    let host = site.host.trim().to_ascii_lowercase();
    if kind == ConnKind::S3 {
        let ep = p.endpoint.trim().trim_end_matches('/').to_ascii_lowercase();
        return ep.split("://").last() == Some(host_port(&host, site.port).as_str()) && p.access_key_id == site.user;
    }
    let Some(n) = &p.net else { return false };
    if kind == ConnKind::Webdav {
        let url = n.url.as_deref().unwrap_or("").to_ascii_lowercase();
        return url.contains(&host) && n.user == site.user;
    }
    n.host.trim().to_ascii_lowercase() == host
        && effective_port(kind, n.tls, n.port) == effective_port(kind, site.tls, site.port)
        && n.user == site.user
}

fn host_port(host: &str, port: u16) -> String {
    if port == 0 { host.to_string() } else { format!("{host}:{port}") }
}

// ---------------------------------------------------------------- neutral site -> Kybl

/// A site as Kybl saves it: the profile and the secret for the vault (under the profile's id,
/// as the connection dialog stores a password, an S3 secret key or a pasted private key).
#[derive(Debug)]
pub struct Mapped {
    pub profile: Profile,
    pub secret: Option<String>,
    /// can't sign in until someone adds a password or key
    pub needs_secret: bool,
}

/// Private keys are a few KB; anything bigger is the wrong file.
const MAX_KEY_FILE: u64 = 64 * 1024;

fn looks_like_key(t: &str) -> bool {
    (t.contains("-----BEGIN") && t.contains("PRIVATE KEY-----")) || t.starts_with("PuTTY-User-Key-File-")
}

fn read_key_file(p: &Path) -> Option<String> {
    if std::fs::metadata(p).ok()?.len() > MAX_KEY_FILE {
        return None;
    }
    let t = std::fs::read_to_string(p).ok()?;
    let t = t.trim();
    looks_like_key(t).then(|| t.to_string())
}

/// What a connection is called: the site's name, after its innermost folder when it has one
/// ("Acme / Production"), since many lists reuse names like "Live" under each client.
fn base_name(site: &ImportedSite) -> String {
    let name = site.name.trim();
    let name = if name.is_empty() {
        if site.user.is_empty() { site.host.clone() } else { format!("{}@{}", site.user, site.host) }
    } else {
        name.to_string()
    };
    match site.folder.last().map(|f| f.trim()).filter(|f| !f.is_empty()) {
        Some(f) => format!("{f} / {name}"),
        None => name,
    }
}

/// `name`, or "name (2)", "name (3)"… so no two connections share a name.
fn unique_name(base: String, taken: &mut HashSet<String>) -> String {
    let mut name = base.clone();
    let mut n = 2;
    while taken.contains(&name.to_lowercase()) {
        name = format!("{base} ({n})");
        n += 1;
    }
    taken.insert(name.to_lowercase());
    name
}

/// Turns one site into a Kybl profile, or says why it can't be.
pub fn to_profile(site: &ImportedSite, name: String) -> Result<Mapped, String> {
    if let Some(why) = &site.skip {
        return Err(why.clone());
    }
    let kind = site.kind.ok_or("Kybl can't open this kind of site.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let password = site.secret.clone().filter(|s| !s.is_empty());
    let base = |kind: ConnKind| Profile { id: id.clone(), name: name.clone(), kind, provider: kind_name(kind).to_string(), ..Default::default() };
    let port = if site.port == effective_port(kind, site.tls, 0) { 0 } else { site.port };
    let mut net = NetConfig {
        host: site.host.trim().to_string(),
        port,
        user: site.user.trim().to_string(),
        base_path: site.start_dir.clone(),
        tls: site.tls,
        auth: NetAuth::Password,
        host_key: None,
        url: None,
    };
    match kind {
        ConnKind::Ftp => {
            let needs = password.is_none() && site.auth != SiteAuth::Anonymous;
            Ok(Mapped { profile: Profile { net: Some(net), ..base(kind) }, secret: password, needs_secret: needs })
        }
        ConnKind::Sftp => {
            let (secret, needs) = match site.auth {
                SiteAuth::KeyFile => {
                    net.auth = NetAuth::Key;
                    let key = site.key_file.as_deref().and_then(read_key_file);
                    let needs = key.is_none();
                    (key, needs)
                }
                SiteAuth::Agent => {
                    net.auth = NetAuth::Agent;
                    (None, false)
                }
                _ => {
                    let needs = password.is_none();
                    (password, needs)
                }
            };
            Ok(Mapped { profile: Profile { net: Some(net), ..base(kind) }, secret, needs_secret: needs })
        }
        ConnKind::Webdav => {
            let scheme = if site.tls == TlsMode::None { "http" } else { "https" };
            net.url = Some(format!("{scheme}://{}/", host_port(&net.host, port)));
            net.host = String::new();
            net.port = 0;
            net.tls = if site.tls == TlsMode::None { TlsMode::None } else { TlsMode::Implicit };
            let needs = password.is_none();
            Ok(Mapped { profile: Profile { net: Some(net), ..base(kind) }, secret: password, needs_secret: needs })
        }
        ConnKind::S3 => {
            // an S3 connection can't be saved without its secret key (the dialog insists too)
            let secret = password.ok_or("No secret key saved")?;
            let host = site.host.trim().to_ascii_lowercase();
            let aws = host.ends_with(".amazonaws.com") || host == "amazonaws.com";
            let region = if aws { aws_region(&host).unwrap_or("us-east-1") } else { "us-east-1" };
            Ok(Mapped {
                profile: Profile {
                    provider: if aws { "aws" } else { "custom" }.into(),
                    endpoint: format!("https://{}", host_port(&host, site.port)),
                    region: region.into(),
                    access_key_id: site.user.trim().to_string(),
                    // other S3 services (MinIO and friends) often only answer path-style requests
                    path_style: !aws,
                    ..base(kind)
                },
                secret: Some(secret),
                needs_secret: false,
            })
        }
        other => Err(format!("{} sites can't be imported yet.", other.label())),
    }
}

fn kind_name(k: ConnKind) -> &'static str {
    match k {
        ConnKind::Ftp => "ftp",
        ConnKind::Sftp => "sftp",
        ConnKind::Webdav => "webdav",
        _ => "s3",
    }
}

/// "s3.eu-central-1.amazonaws.com" → "eu-central-1".
fn aws_region(host: &str) -> Option<&str> {
    let rest = host.strip_suffix(".amazonaws.com")?;
    let r = rest.rsplit('.').next()?;
    let r = r.strip_prefix("s3-").unwrap_or(r);
    (r != "s3" && r.contains('-')).then_some(r)
}

/// Maps the chosen sites to profiles: names made unique against `existing` and each other.
pub fn plan(sites: &[ImportedSite], ids: &[String], existing: &[Profile]) -> (Vec<Mapped>, Vec<Skipped>) {
    let mut taken: HashSet<String> = existing.iter().map(|p| p.name.to_lowercase()).collect();
    let mut mapped = Vec::new();
    let mut skipped = Vec::new();
    for id in ids {
        let Some(site) = sites.iter().find(|s| &s.id == id) else {
            skipped.push(Skipped { name: id.clone(), reason: "No longer in the file".into() });
            continue;
        };
        if let Some(why) = &site.skip {
            skipped.push(Skipped { name: site.name.clone(), reason: why.clone() });
            continue;
        }
        // name it only once it can really be imported, so a skipped site doesn't take a name
        match to_profile(site, String::new()) {
            Ok(mut m) => {
                m.profile.name = unique_name(base_name(site), &mut taken);
                mapped.push(m);
            }
            Err(reason) => skipped.push(Skipped { name: site.name.clone(), reason }),
        }
    }
    (mapped, skipped)
}

#[tauri::command]
pub async fn import_apply(app: AppHandle, state: State<'_, AppState>, source: String, path: Option<String>, ids: Vec<String>) -> Result<ImportOutcome, String> {
    let src = self::source(&source)?;
    let path = resolve_path(src, path)?;
    // read again here, so the passwords come from the file and never from the page
    let sites = tauri::async_runtime::spawn_blocking(move || src.parse(&path)).await.map_err(|e| e.to_string())??;
    let mut profiles = load_profiles(&app)?;
    let (mapped, mut skipped) = plan(&sites, &ids, &profiles);
    let mut imported = Vec::new();
    let mut needs_secret = Vec::new();
    for m in mapped {
        // the secret goes into the vault first: a profile is only listed once it can sign in as
        // well as it could in the other app
        if let Some(s) = &m.secret
            && let Err(e) = set_secret(&state, &m.profile.id, s).await
        {
            skipped.push(Skipped { name: m.profile.name.clone(), reason: format!("Couldn't store the password: {e}") });
            continue;
        }
        if m.needs_secret {
            needs_secret.push(m.profile.name.clone());
        }
        profiles.push(m.profile.clone());
        imported.push(m.profile);
    }
    if !imported.is_empty() {
        save_profiles(&app, &profiles)?;
    }
    Ok(ImportOutcome { imported, skipped, needs_secret })
}

/// A short stable id for a site: a hash of what identifies it, and its place among sites that
/// look the same (FNV-1a; it only has to match between two reads of one file).
pub fn site_id(parts: &[&str], seen: &mut std::collections::HashMap<u64, u32>) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.bytes().chain(std::iter::once(0)) {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    let n = seen.entry(h).or_insert(0);
    *n += 1;
    format!("{h:016x}-{n}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(kind: ConnKind, host: &str, port: u16, user: &str) -> ImportedSite {
        let mut s = ImportedSite::new("Live".into(), vec!["Clients".into(), "Acme".into()], "x".into());
        s.id = format!("{host}{port}{user}");
        s.kind = Some(kind);
        s.host = host.into();
        s.port = port;
        s.user = user.into();
        s.auth = SiteAuth::Password;
        s.secret = Some("pw".into());
        s
    }

    fn net_profile(kind: ConnKind, name: &str, host: &str, port: u16, user: &str, tls: TlsMode) -> Profile {
        Profile { id: name.into(), name: name.into(), kind, net: Some(NetConfig { host: host.into(), port, user: user.into(), tls, ..Default::default() }), ..Default::default() }
    }

    #[test]
    fn duplicates_match_kind_host_port_and_user() {
        let existing = net_profile(ConnKind::Sftp, "Web", "Files.Example.com", 0, "deploy", TlsMode::None);
        assert!(same_place(&site(ConnKind::Sftp, "files.example.com", 22, "deploy"), &existing));
        assert!(!same_place(&site(ConnKind::Sftp, "files.example.com", 2222, "deploy"), &existing));
        assert!(!same_place(&site(ConnKind::Sftp, "files.example.com", 22, "other"), &existing));
        assert!(!same_place(&site(ConnKind::Ftp, "files.example.com", 22, "deploy"), &existing));
        let ftps = net_profile(ConnKind::Ftp, "F", "ftp.example.com", 0, "u", TlsMode::Implicit);
        let mut s = site(ConnKind::Ftp, "ftp.example.com", 990, "u");
        s.tls = TlsMode::Implicit;
        assert!(same_place(&s, &ftps));
    }

    #[test]
    fn names_carry_the_folder_and_stay_unique() {
        let existing = vec![net_profile(ConnKind::Ftp, "Acme / Live", "a", 0, "", TlsMode::None)];
        let a = site(ConnKind::Ftp, "a.example.com", 21, "u");
        let mut b = site(ConnKind::Ftp, "b.example.com", 21, "u");
        b.id = "b".into();
        let mut top = site(ConnKind::Ftp, "c.example.com", 21, "u");
        top.id = "c".into();
        top.folder.clear();
        let sites = vec![a.clone(), b, top];
        let ids: Vec<String> = sites.iter().map(|s| s.id.clone()).collect();
        let (mapped, skipped) = plan(&sites, &ids, &existing);
        assert!(skipped.is_empty());
        let names: Vec<&str> = mapped.iter().map(|m| m.profile.name.as_str()).collect();
        assert_eq!(names, ["Acme / Live (2)", "Acme / Live (3)", "Live"]);
        // the usual port is stored as 0, like a hand-made connection with an empty port field
        assert_eq!(mapped[0].profile.net.as_ref().unwrap().port, 0);
        assert_eq!(mapped[0].secret.as_deref(), Some("pw"));
    }

    #[test]
    fn mapping_per_kind() {
        let mut s = site(ConnKind::Sftp, "h", 2222, "u");
        s.auth = SiteAuth::KeyFile;
        s.secret = None;
        s.key_file = Some(PathBuf::from("/nonexistent/key.ppk"));
        let m = to_profile(&s, "n".into()).unwrap();
        let net = m.profile.net.unwrap();
        assert_eq!((net.auth, net.port), (NetAuth::Key, 2222));
        assert!(m.needs_secret && m.secret.is_none());

        let dir = std::env::temp_dir().join(format!("kybl-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("id_test");
        std::fs::write(&key, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
        s.key_file = Some(key);
        let m = to_profile(&s, "n".into()).unwrap();
        assert!(!m.needs_secret && m.secret.unwrap().starts_with("-----BEGIN OPENSSH"));
        std::fs::remove_dir_all(dir).ok();

        let mut d = site(ConnKind::Webdav, "dav.example.com", 8443, "u");
        d.tls = TlsMode::Implicit;
        let m = to_profile(&d, "n".into()).unwrap();
        let net = m.profile.net.unwrap();
        assert_eq!(net.url.as_deref(), Some("https://dav.example.com:8443/"));
        assert_eq!((net.host.as_str(), net.port), ("", 0));

        let mut s3 = site(ConnKind::S3, "s3.eu-west-2.amazonaws.com", 0, "AKIA");
        let m = to_profile(&s3, "n".into()).unwrap();
        assert_eq!((m.profile.provider.as_str(), m.profile.region.as_str(), m.profile.path_style), ("aws", "eu-west-2", false));
        s3.secret = None;
        assert_eq!(to_profile(&s3, "n".into()).unwrap_err(), "No secret key saved");

        let mut anon = site(ConnKind::Ftp, "h", 0, "");
        anon.auth = SiteAuth::Anonymous;
        anon.secret = None;
        assert!(!to_profile(&anon, "n".into()).unwrap().needs_secret);
    }

    #[test]
    fn skipped_sites_say_why_and_take_no_name() {
        let mut s = site(ConnKind::Ftp, "h", 0, "u");
        s.kind = None;
        s.skip = Some("Not supported: Storj".into());
        let ok = { let mut o = site(ConnKind::Ftp, "h2", 0, "u"); o.id = "ok".into(); o };
        let (mapped, skipped) = plan(&[s.clone(), ok], &[s.id.clone(), "ok".into(), "gone".into()], &[]);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].profile.name, "Acme / Live");
        assert_eq!(skipped.len(), 2);
        assert_eq!(skipped[0].reason, "Not supported: Storj");
        assert_eq!(skipped[1].reason, "No longer in the file");
    }

    #[test]
    fn preview_never_carries_a_secret() {
        let s = site(ConnKind::Ftp, "h", 0, "u");
        let mut s3 = site(ConnKind::S3, "s3.example.com", 0, "AK");
        s3.secret = None;
        let mut ask = site(ConnKind::Sftp, "h", 0, "u");
        ask.auth = SiteAuth::Missing;
        ask.secret = None;
        let p = preview(&filezilla::FileZilla, Path::new("x.xml"), vec![s, s3, ask], &[]);
        let json = serde_json::to_string(&p).unwrap();
        assert!(!json.contains("\"pw\""), "{json}");
        assert!(json.contains("\"hasPassword\":true"));
        // what importing would refuse is marked in the preview already
        assert_eq!(p.sites[1].site.skip.as_deref(), Some("No secret key saved"));
        assert!(!p.sites[0].needs_secret && p.sites[2].needs_secret);
        assert!(p.sites[2].site.notes[0].starts_with("No password saved"));
    }
}
