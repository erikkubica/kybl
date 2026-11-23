//! FileZilla's Site Manager (`sitemanager.xml`, and the files its "Export…" writes, which have
//! the same format): `<FileZilla3><Servers>` holding `<Server>`s and `<Folder>`s, folders named
//! by their own text and nesting more of both.
//!
//! The numbers below are FileZilla's own (`ServerProtocol`, `LogonType` and `ServerType` in its
//! `server.h`); they never change, since saved sites depend on them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use quick_xml::{events::Event, Reader};

use super::{home, site_id, ImportedSite, SiteAuth, Source};
use crate::state::{ConnKind, TlsMode};

pub struct FileZilla;

impl Source for FileZilla {
    fn id(&self) -> &'static str {
        "filezilla"
    }
    fn name(&self) -> &'static str {
        "FileZilla"
    }
    fn default_paths(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if cfg!(windows) {
            if let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
                out.push(PathBuf::from(appdata).join("FileZilla").join("sitemanager.xml"));
            }
        } else {
            if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
                out.push(PathBuf::from(xdg).join("filezilla").join("sitemanager.xml"));
            }
            if let Some(h) = home() {
                out.push(h.join(".config").join("filezilla").join("sitemanager.xml"));
                // FileZilla before 3.x moved to XDG folders kept it here
                out.push(h.join(".filezilla").join("sitemanager.xml"));
            }
        }
        out.dedup();
        out
    }
    fn file_filter(&self) -> (&'static str, &'static [&'static str]) {
        ("FileZilla site list", &["xml"])
    }
    fn parse(&self, path: &Path) -> Result<Vec<ImportedSite>, String> {
        let raw = std::fs::read(path).map_err(|e| format!("Couldn't read the file: {e}"))?;
        let text = String::from_utf8_lossy(&raw);
        parse_str(&text)
    }
    fn hints(&self, sites: &[ImportedSite]) -> Vec<String> {
        let mut out = vec![];
        if sites.iter().any(|s| s.protocol == FTP_IF_AVAILABLE) {
            out.push("FileZilla's “FTP over TLS if available” sites keep that setting: encrypted when the server supports it, plain FTP when it doesn't (Kybl asks you once per server before anything is sent unencrypted). Turn the fallback off in a site's settings once you know its server supports FTPS.".into());
        }
        out
    }
}

const FTP_IF_AVAILABLE: &str = "FTP (TLS if available)";

/// What Kybl makes of a FileZilla protocol number: the kind, its encryption and the badge text,
/// or the protocol's name and why it can't be imported.
fn protocol(n: i64) -> Result<(ConnKind, TlsMode, &'static str), (String, String)> {
    Ok(match n {
        // FileZilla tries AUTH TLS and falls back to plain, as FTPS with Kybl's fallback does
        0 => (ConnKind::Ftp, TlsMode::Auto, FTP_IF_AVAILABLE),
        1 => (ConnKind::Sftp, TlsMode::None, "SFTP"),
        3 => (ConnKind::Ftp, TlsMode::Implicit, "FTPS (implicit TLS)"),
        4 => (ConnKind::Ftp, TlsMode::Explicit, "FTPES (explicit TLS)"),
        6 => (ConnKind::Ftp, TlsMode::None, "FTP (plain)"),
        // FileZilla Pro
        7 => (ConnKind::S3, TlsMode::Implicit, "S3"),
        9 => (ConnKind::Webdav, TlsMode::Implicit, "WebDAV"),
        19 => (ConnKind::Webdav, TlsMode::None, "WebDAV (plain HTTP)"),
        _ => {
            let name = match n {
                2 => "HTTP",
                5 => "HTTPS",
                8 | 21 => "Storj",
                10 => "Azure File Storage",
                11 => "Azure Blob Storage",
                12 => "OpenStack Swift",
                13 => "Google Cloud Storage",
                14 => "Google Drive",
                15 => "Dropbox",
                16 => "OneDrive",
                17 => "Backblaze B2",
                18 => "Box",
                20 => "Rackspace Cloud",
                _ => return Err(("Other".into(), format!("Not supported: unknown protocol {n}"))),
            };
            return Err((name.into(), match n {
                11 | 13 => format!("Not supported from FileZilla: {name}. Add it in Kybl with its access key instead"),
                14..=16 => format!("Not supported from FileZilla: {name}. Add it in Kybl and sign in instead"),
                _ => format!("Not supported: {name}"),
            }));
        }
    })
}

/// FileZilla's saved folder (`RemoteDir`): "<type> <prefix length> [<prefix>]" and then
/// " <length> <segment>" per folder, lengths counted in characters. "1 0 4 home 4 user" is
/// /home/user on a Unix server. Only Unix-style paths carry over: Kybl starts in "/a/b" folders.
pub fn decode_remote_dir(s: &str) -> Option<String> {
    let chars: Vec<char> = s.trim().chars().collect();
    if chars.is_empty() {
        return None;
    }
    let mut i = 0;
    let number = |i: &mut usize| -> Option<usize> {
        let start = *i;
        while *i < chars.len() && chars[*i].is_ascii_digit() {
            *i += 1;
        }
        if *i == start {
            return None;
        }
        chars[start..*i].iter().collect::<String>().parse().ok()
    };
    let ty = number(&mut i)?;
    if chars.get(i) != Some(&' ') {
        return None;
    }
    i += 1;
    let prefix_len = number(&mut i)?;
    if prefix_len > 0 {
        // VMS and mainframe paths have a prefix ("DISK$USER:"); Kybl has no place for those
        return None;
    }
    let mut segments = Vec::new();
    while i < chars.len() {
        if chars[i] != ' ' {
            return None;
        }
        i += 1;
        let len = number(&mut i)?;
        if len == 0 || chars.get(i) != Some(&' ') || i + 1 + len > chars.len() {
            return None;
        }
        i += 1;
        segments.push(chars[i..i + len].iter().collect::<String>());
        i += len;
    }
    // DEFAULT, UNIX, DOS_VIRTUAL and CYGWIN read as "/a/b"; DOS ("C:\a") and the rest don't
    if !matches!(ty, 0 | 1 | 8 | 9) {
        return None;
    }
    Some(format!("/{}", segments.join("/")))
}

/// One `<Server>`'s fields as read: element name → (text, `encoding` attribute).
type Fields = HashMap<String, (String, Option<String>)>;

/// Reads a FileZilla site list. Malformed XML is an error; a site with odd values is still
/// listed, with a reason when it can't be imported.
pub fn parse_str(xml: &str) -> Result<Vec<ImportedSite>, String> {
    let mut r = Reader::from_str(xml);
    let bad = |e: quick_xml::Error| format!("This file couldn't be read as a FileZilla site list: {e}");
    // the open elements, outermost first
    let mut path: Vec<String> = Vec::new();
    let mut folders: Vec<String> = Vec::new();
    let mut server: Option<Fields> = None;
    // how deep the open <Server> is (its fields are one deeper)
    let mut server_at = 0usize;
    // text right inside <Server> (FileZilla repeats the name there) and inside the current field
    let mut server_text = String::new();
    let mut field: Option<(String, Option<String>)> = None;
    let mut text = String::new();
    let mut saw_root = false;
    let mut sites = Vec::new();
    let mut seen = HashMap::new();

    loop {
        let ev = r.read_event().map_err(bad)?;
        // what text in this event belongs to: a field, the server itself, or a folder's name
        let mut push_text = |s: &str, path: &[String], server: &Option<Fields>, folders: &mut Vec<String>| {
            if field.is_some() {
                text.push_str(s);
            } else if server.is_some() {
                server_text.push_str(s);
            } else if path.last().map(String::as_str) == Some("Folder")
                && let Some(f) = folders.last_mut()
            {
                f.push_str(s);
            }
        };
        match ev {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_string();
                if name == "FileZilla3" {
                    saw_root = true;
                }
                if server.is_some() {
                    // only the server's own fields: what is inside them (a <Bookmark>'s own
                    // Name and RemoteDir) is not the site's
                    if path.len() == server_at + 1 {
                        let enc = e.try_get_attribute("encoding").ok().flatten().map(|a| a.value.into_owned());
                        field = Some((name.clone(), enc));
                        text.clear();
                    }
                } else if name == "Server" {
                    server = Some(Fields::new());
                    server_at = path.len();
                    server_text.clear();
                } else if name == "Folder" {
                    folders.push(String::new());
                }
                path.push(name);
            }
            Event::Empty(e) => {
                let name = e.local_name().as_ref().to_string();
                if let Some(s) = server.as_mut().filter(|_| path.len() == server_at + 1) {
                    let enc = e.try_get_attribute("encoding").ok().flatten().map(|a| a.value.into_owned());
                    s.insert(name, (String::new(), enc));
                }
            }
            Event::Text(t) => push_text(&t.xml10_content(), &path, &server, &mut folders),
            Event::CData(c) => push_text(&c.into_inner(), &path, &server, &mut folders),
            Event::GeneralRef(g) => {
                let s = format!("&{};", &*g);
                let v = quick_xml::escape::unescape(&s).map(|c| c.into_owned()).unwrap_or(s);
                push_text(&v, &path, &server, &mut folders);
            }
            Event::End(_) => {
                let name = path.pop().unwrap_or_default();
                if server.is_some() && path.len() > server_at {
                    // a server field ends (something deeper inside one changes nothing)
                    if path.len() == server_at + 1
                        && let Some((fname, enc)) = field.take()
                        && let Some(s) = server.as_mut()
                    {
                        s.insert(fname, (std::mem::take(&mut text), enc));
                    }
                } else if name == "Server" {
                    if let Some(fields) = server.take() {
                        let names: Vec<String> = folders.iter().map(|f| f.trim().to_string()).collect();
                        sites.push(site(&fields, server_text.trim(), names, &mut seen));
                    }
                } else if name == "Folder" {
                    folders.pop();
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !saw_root {
        return Err("This isn't a FileZilla site list.".into());
    }
    Ok(sites)
}

fn site(f: &Fields, own_text: &str, folder: Vec<String>, seen: &mut HashMap<u64, u32>) -> ImportedSite {
    let get = |k: &str| f.get(k).map(|(v, _)| v.trim()).unwrap_or("");
    let name = Some(get("Name")).filter(|n| !n.is_empty()).unwrap_or(own_text).to_string();
    let proto_n: i64 = get("Protocol").parse().unwrap_or(0);
    let logon: i64 = get("Logontype").parse().unwrap_or(1);
    let host = get("Host").to_string();
    let port: u16 = get("Port").parse().unwrap_or(0);
    let user = get("User").to_string();

    let mut s = ImportedSite::new(name.clone(), folder.clone(), String::new());
    s.id = site_id(&[&folder.join("/"), &name, &host, &port.to_string(), &user, &proto_n.to_string()], seen);
    s.host = host;
    s.port = port;
    s.user = user;
    match protocol(proto_n) {
        Ok((kind, tls, label)) => {
            s.kind = Some(kind);
            s.tls = tls;
            s.protocol = label.to_string();
        }
        Err((label, why)) => {
            s.protocol = label;
            s.skip = Some(why);
        }
    }
    if s.host.is_empty() && s.skip.is_none() {
        s.skip = Some("No server address".into());
    }

    // the password: base64 (FileZilla 3.26+), plain text (older versions), or "crypt" when a
    // master password protects it, which only FileZilla itself can open
    let mut encrypted = false;
    if let Some((raw, enc)) = f.get("Pass") {
        match enc.as_deref() {
            Some("base64") => match base64::engine::general_purpose::STANDARD.decode(raw.trim()).ok().and_then(|b| String::from_utf8(b).ok()) {
                Some(p) => s.secret = Some(p),
                None => s.notes.push("The saved password couldn't be read".into()),
            },
            Some("crypt") => encrypted = true,
            None | Some("") => s.secret = Some(raw.clone()),
            Some(other) => s.notes.push(format!("Password in an unknown format ({other})")),
        }
    }
    s.secret = s.secret.take().filter(|p| !p.is_empty());

    s.auth = match logon {
        0 => {
            s.user.clear();
            s.secret = None;
            SiteAuth::Anonymous
        }
        5 if s.kind == Some(ConnKind::Sftp) => {
            // still a key sign-in when the file isn't named: the key is chosen after import
            s.key_file = Some(get("Keyfile")).filter(|k| !k.is_empty()).map(expand_home);
            SiteAuth::KeyFile
        }
        _ if s.secret.is_some() => SiteAuth::Password,
        _ if encrypted => SiteAuth::Encrypted,
        _ => SiteAuth::Missing,
    };
    if logon == 4 && !get("Account").is_empty() {
        s.notes.push("The FTP account (ACCT) isn't imported".into());
    }
    if s.kind == Some(ConnKind::Ftp) && get("PasvMode") == "MODE_ACTIVE" {
        s.notes.push("Active mode isn't available: Kybl uses passive mode".into());
    }
    if let Some(dir) = Some(get("RemoteDir")).filter(|d| !d.is_empty()) {
        match decode_remote_dir(dir) {
            Some(p) => s.start_dir = p,
            None => s.notes.push("The start folder isn't imported".into()),
        }
    }
    s
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), home()) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => PathBuf::from(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic: every name, host and password here is made up.
    const FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<FileZilla3 version="3.66.0" platform="mac">
  <Servers>
    <Server>
      <Host>ftp.example.com</Host>
      <Port>21</Port>
      <Protocol>0</Protocol>
      <Type>0</Type>
      <User>alice</User>
      <Pass encoding="base64">czNjcmV0IQ==</Pass>
      <Logontype>1</Logontype>
      <PasvMode>MODE_DEFAULT</PasvMode>
      <EncodingType>Auto</EncodingType>
      <BypassProxy>0</BypassProxy>
      <Name>Top &amp; level</Name>
      <Comments />
      <RemoteDir>1 0 4 home 5 alice</RemoteDir>
      <SyncBrowsing>0</SyncBrowsing>
      <DirectoryComparison>0</DirectoryComparison>Top &amp; level
    </Server>
    <Folder expanded="1">Clients
      <Folder expanded="0">Acme
        <Server>
          <Host>sftp.acme.example</Host>
          <Port>2222</Port>
          <Protocol>1</Protocol>
          <User>deploy</User>
          <Keyfile>/nonexistent/acme.ppk</Keyfile>
          <Logontype>5</Logontype>
          <Name>Live</Name>
          <RemoteDir>1 0 3 var 3 www 8 site one</RemoteDir>
        </Server>
        <Server>
          <Host>ftps.acme.example</Host>
          <Port>990</Port>
          <Protocol>3</Protocol>
          <User>acme</User>
          <Pass encoding="crypt" pubkey="abc">ZW5jcnlwdGVk</Pass>
          <Logontype>1</Logontype>
          <Name>Archive</Name>
        </Server>
      </Folder>
      <Server>
        <Host>plain.example.org</Host>
        <Port>21</Port>
        <Protocol>6</Protocol>
        <User>bob</User>
        <Logontype>2</Logontype>
        <PasvMode>MODE_ACTIVE</PasvMode>
        <Name>Ask me</Name>
      </Server>
      <Server>
        <Host>explicit.example.org</Host>
        <Protocol>4</Protocol>
        <User>carol</User>
        <Pass>plain-old</Pass>
        <Logontype>4</Logontype>
        <Account>acct1</Account>
        <Name>Old style</Name>
      </Server>
    </Folder>
    <Server>
      <Host>pub.example.net</Host>
      <Protocol>0</Protocol>
      <Logontype>0</Logontype>
      <User>anonymous</User>
      <Pass encoding="base64">YW5vbkBleGFtcGxlLmNvbQ==</Pass>
      <Name>Mirror</Name>
    </Server>
    <Server>
      <Host>drive.example</Host>
      <Protocol>14</Protocol>
      <Name>Drive</Name>
    </Server>
    <Server>
      <Host>dav.example.com</Host>
      <Port>443</Port>
      <Protocol>9</Protocol>
      <User>dave</User>
      <Pass encoding="base64">ZGF2</Pass>
      <Logontype>1</Logontype>
      <Name>Cloud</Name>
      <RemoteDir>3 0 2 C: 5 Users</RemoteDir>
    </Server>
  </Servers>
</FileZilla3>
"#;

    fn by_name<'a>(sites: &'a [ImportedSite], n: &str) -> &'a ImportedSite {
        sites.iter().find(|s| s.name == n).unwrap_or_else(|| panic!("no site {n}"))
    }

    #[test]
    fn reads_sites_folders_and_passwords() {
        let sites = parse_str(FIXTURE).unwrap();
        assert_eq!(sites.len(), 8);

        let top = by_name(&sites, "Top & level");
        assert!(top.folder.is_empty());
        assert_eq!((top.kind, top.tls, top.port), (Some(ConnKind::Ftp), TlsMode::Auto, 21));
        assert_eq!(top.secret.as_deref(), Some("s3cret!"));
        assert_eq!(top.auth, SiteAuth::Password);
        assert_eq!(top.start_dir, "/home/alice");
        assert!(top.notes.is_empty());

        let live = by_name(&sites, "Live");
        assert_eq!(live.folder, ["Clients", "Acme"]);
        assert_eq!((live.kind, live.port), (Some(ConnKind::Sftp), 2222));
        assert_eq!(live.auth, SiteAuth::KeyFile);
        assert_eq!(live.key_file.as_deref(), Some(Path::new("/nonexistent/acme.ppk")));
        // segment lengths count characters, so a name with a space reads whole
        assert_eq!(live.start_dir, "/var/www/site one");

        let archive = by_name(&sites, "Archive");
        assert_eq!((archive.tls, archive.auth), (TlsMode::Implicit, SiteAuth::Encrypted));
        assert!(archive.secret.is_none());

        let ask = by_name(&sites, "Ask me");
        assert_eq!(ask.folder, ["Clients"]);
        assert_eq!((ask.tls, ask.auth), (TlsMode::None, SiteAuth::Missing));
        assert!(ask.notes.iter().any(|n| n.contains("passive")));

        let old = by_name(&sites, "Old style");
        assert_eq!(old.secret.as_deref(), Some("plain-old"));
        assert_eq!(old.tls, TlsMode::Explicit);
        assert!(old.notes.iter().any(|n| n.contains("ACCT")));

        let mirror = by_name(&sites, "Mirror");
        assert_eq!(mirror.auth, SiteAuth::Anonymous);
        assert!(mirror.user.is_empty() && mirror.secret.is_none());

        let drive = by_name(&sites, "Drive");
        assert!(drive.kind.is_none());
        assert!(drive.skip.as_deref().unwrap().contains("Google Drive"));
        assert_eq!(drive.protocol, "Google Drive");

        let dav = by_name(&sites, "Cloud");
        assert_eq!((dav.kind, dav.tls), (Some(ConnKind::Webdav), TlsMode::Implicit));
        // a DOS path has no Kybl equivalent: the start folder is dropped, and it says so
        assert_eq!(dav.start_dir, "");
        assert!(dav.notes.iter().any(|n| n.contains("start folder")));
    }

    #[test]
    fn ids_are_stable_and_distinct() {
        let a = parse_str(FIXTURE).unwrap();
        let b = parse_str(FIXTURE).unwrap();
        let ids: Vec<&str> = a.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, b.iter().map(|s| s.id.as_str()).collect::<Vec<_>>());
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), ids.len());
        // two identical sites still get their own ids
        let twice = FIXTURE.replace("<Name>Mirror</Name>", "<Name>Top &amp; level</Name>");
        let s = parse_str(&twice).unwrap();
        assert_eq!(s.iter().map(|x| &x.id).collect::<std::collections::HashSet<_>>().len(), s.len());
    }

    /// A site's bookmarks (`<Bookmark>` inside `<Server>`) don't replace its own name and folder.
    #[test]
    fn bookmarks_leave_the_site_alone() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3><Servers><Server>
  <Host>files.example.com</Host><Port>22</Port><Protocol>1</Protocol><Type>0</Type>
  <User>alice</User><Logontype>2</Logontype>
  <Name>My site</Name>
  <RemoteDir>1 0 4 home 5 alice</RemoteDir>
  <Bookmark><Name>logs</Name><LocalDir /><RemoteDir>1 0 3 var 3 log</RemoteDir></Bookmark>
  <Bookmark><Name>empty</Name><RemoteDir /></Bookmark>
  My site
</Server></Servers></FileZilla3>"#;
        let sites = parse_str(xml).unwrap();
        assert_eq!(sites.len(), 1);
        assert_eq!(sites[0].name, "My site");
        assert_eq!(sites[0].start_dir, "/home/alice");
        assert_eq!(sites[0].host, "files.example.com");
    }

    #[test]
    fn remote_dirs() {
        assert_eq!(decode_remote_dir("1 0 4 home 4 user").as_deref(), Some("/home/user"));
        assert_eq!(decode_remote_dir("1 0").as_deref(), Some("/"));
        assert_eq!(decode_remote_dir("0 0 6 public").as_deref(), Some("/public"));
        assert_eq!(decode_remote_dir("1 0 5 héllo").as_deref(), Some("/héllo"));
        assert_eq!(decode_remote_dir(""), None);
        // a VMS prefix, a DOS path, and broken lengths
        assert_eq!(decode_remote_dir("2 5 DISK: 3 abc"), None);
        assert_eq!(decode_remote_dir("3 0 2 C: 3 foo"), None);
        assert_eq!(decode_remote_dir("1 0 9 short"), None);
        assert_eq!(decode_remote_dir("1 0 x home"), None);
    }

    #[test]
    fn protocols_and_skips() {
        assert_eq!(protocol(0).unwrap(), (ConnKind::Ftp, TlsMode::Auto, FTP_IF_AVAILABLE));
        assert_eq!(serde_json::to_string(&TlsMode::Auto).unwrap(), "\"auto\"");
        assert_eq!(protocol(1).unwrap().0, ConnKind::Sftp);
        assert_eq!(protocol(3).unwrap().1, TlsMode::Implicit);
        assert_eq!(protocol(4).unwrap().1, TlsMode::Explicit);
        assert_eq!(protocol(6).unwrap().1, TlsMode::None);
        assert_eq!(protocol(7).unwrap().0, ConnKind::S3);
        assert_eq!(protocol(19).unwrap(), (ConnKind::Webdav, TlsMode::None, "WebDAV (plain HTTP)"));
        assert_eq!(protocol(8).unwrap_err().0, "Storj");
        assert!(protocol(99).unwrap_err().1.contains("unknown"));
    }

    #[test]
    fn malformed_files_are_refused() {
        assert!(parse_str("<FileZilla3><Servers><Server><Host>x</Servers>").is_err());
        assert_eq!(parse_str("<html><body/></html>").unwrap_err(), "This isn't a FileZilla site list.");
        assert!(parse_str("").is_err());
        // an empty list is fine
        assert!(parse_str("<FileZilla3><Servers/></FileZilla3>").unwrap().is_empty());
    }

    /// Reads the FileZilla list on this computer, if there is one, and prints counts only (never
    /// names, hosts, users or passwords). `cargo test --lib real_filezilla_counts -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_filezilla_counts() {
        let Some(path) = FileZilla.detect() else {
            println!("no FileZilla site list here");
            return;
        };
        let sites = FileZilla.parse(&path).unwrap();
        let mut by_proto: std::collections::BTreeMap<String, usize> = Default::default();
        let mut by_auth: std::collections::BTreeMap<String, usize> = Default::default();
        let mut skipped: std::collections::BTreeMap<String, usize> = Default::default();
        let mut notes: std::collections::BTreeMap<String, usize> = Default::default();
        let (mut starts, mut folders) = (0, std::collections::HashSet::new());
        for s in &sites {
            *by_proto.entry(s.protocol.clone()).or_default() += 1;
            *by_auth.entry(format!("{:?}", s.auth)).or_default() += 1;
            if let Some(w) = &s.skip {
                *skipped.entry(w.clone()).or_default() += 1;
            }
            for n in &s.notes {
                *notes.entry(n.clone()).or_default() += 1;
            }
            starts += !s.start_dir.is_empty() as usize;
            folders.insert(s.folder.len());
        }
        let (mapped, sk) = super::super::plan(&sites, &sites.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), &[]);
        let names: std::collections::HashSet<_> = mapped.iter().map(|m| m.profile.name.to_lowercase()).collect();
        println!("total {}", sites.len());
        println!("by protocol {by_proto:?}");
        println!("by auth {by_auth:?}");
        println!("skipped {skipped:?}");
        println!("notes {notes:?}");
        println!("with start folder {starts}; folder depths {folders:?}");
        println!("importable {} (needing a secret {}), not importable {}; unique names {}", mapped.len(), mapped.iter().filter(|m| m.needs_secret).count(), sk.len(), names.len());
    }
}
