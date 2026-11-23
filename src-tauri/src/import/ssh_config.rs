//! OpenSSH's client settings (`~/.ssh/config`): every concrete `Host` alias becomes an SFTP
//! connection, with what `ssh <alias>` would use for it.
//!
//! The rules follow ssh_config(5): keywords are case-insensitive, `Key value` and `Key=value`
//! both work, values may be quoted, the first value found for a host wins (so `Host *` at the end
//! only fills gaps), lines before the first `Host` apply to every host, and `Include` reads more
//! files (globs, relative to `~/.ssh`) in place. Aliases with wildcards (`*`, `?`) or negations
//! are patterns, not hosts, and aren't listed. `Match` blocks are skipped: what they'd apply
//! depends on things only known when connecting.
//!
//! `LocalForward` lines become the connection's SSH tunnels (every one that applies, as ssh adds
//! them all up); `ProxyJump` and `ProxyCommand` aren't supported and are noted.
//!
//! Private keys are never read here: a host's `IdentityFile` is only noted, and the import reads
//! the key into the vault the way it does for FileZilla's key files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{home, site_id, ImportedSite, SiteAuth, Source};
use crate::state::{ConnKind, TlsMode};

pub struct SshConfig;

/// The sidebar group imported hosts land in.
const GROUP: &str = "SSH config";
/// OpenSSH's own limit on nested `Include`s (it stops loops too).
const MAX_DEPTH: usize = 16;

impl Source for SshConfig {
    fn id(&self) -> &'static str {
        "ssh-config"
    }
    fn name(&self) -> &'static str {
        "SSH config"
    }
    fn default_paths(&self) -> Vec<PathBuf> {
        home().map(|h| vec![h.join(".ssh").join("config")]).unwrap_or_default()
    }
    fn file_filter(&self) -> (&'static str, &'static [&'static str]) {
        // the file has no extension
        ("SSH config", &[])
    }
    fn parse(&self, path: &Path) -> Result<Vec<ImportedSite>, String> {
        self.parse_all(path).map(|(sites, _)| sites)
    }
    fn parse_all(&self, path: &Path) -> Result<(Vec<ImportedSite>, Vec<String>), String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("Couldn't read the file: {e}"))?;
        let ssh_dir = home().map(|h| h.join(".ssh")).unwrap_or_else(|| path.parent().map(Path::to_path_buf).unwrap_or_default());
        let env = Env { home: home(), local_user: local_user(), ssh_dir };
        Ok(parse_str(&text, &env, &|p| std::fs::read_to_string(p).ok()))
    }
}

/// What `~`, `%d`, `%u` and relative `Include`s stand for.
pub struct Env {
    pub home: Option<PathBuf>,
    pub local_user: String,
    /// where relative `Include` paths start (`~/.ssh`)
    pub ssh_dir: PathBuf,
}

fn local_user() -> String {
    std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default()
}

/// One `Host` section (or the lines before the first): its patterns and its settings in order.
#[derive(Debug, Default)]
struct Block {
    /// None: applies to every host (the lines before the first `Host`)
    patterns: Option<Vec<String>>,
    /// lowercase keyword → its arguments
    settings: Vec<(String, Vec<String>)>,
}

#[derive(Default)]
struct Reader {
    blocks: Vec<Block>,
    /// concrete aliases, in the order the file names them
    aliases: Vec<String>,
    saw_match: bool,
    /// inside a `Match`: its lines are skipped
    in_match: bool,
}

impl Reader {
    fn current(&mut self) -> &mut Block {
        if self.blocks.is_empty() {
            self.blocks.push(Block::default());
        }
        self.blocks.last_mut().unwrap()
    }

    fn read(&mut self, text: &str, env: &Env, load: &dyn Fn(&Path) -> Option<String>, depth: usize) {
        for line in text.lines() {
            let words = split_words(line);
            let Some((key, args)) = keyword(&words) else { continue };
            match key.as_str() {
                "host" => {
                    self.in_match = false;
                    for a in &args {
                        if is_concrete(a) && !self.aliases.contains(a) {
                            self.aliases.push(a.clone());
                        }
                    }
                    self.blocks.push(Block { patterns: Some(args), settings: vec![] });
                }
                "match" => {
                    self.saw_match = true;
                    self.in_match = true;
                }
                _ if self.in_match => {}
                "include" if depth < MAX_DEPTH => {
                    // the included lines belong to the section the Include is in; a Host or Match
                    // in there ends it only until the file is done (as ssh reads it)
                    let (outer, was_match) = (self.blocks.last().map(|b| b.patterns.clone()), self.in_match);
                    for pattern in &args {
                        for file in expand_include(pattern, env) {
                            if let Some(t) = load(&file) {
                                self.read(&t, env, load, depth + 1);
                            }
                        }
                    }
                    self.in_match = was_match;
                    if let Some(patterns) = outer
                        && self.blocks.last().map(|b| &b.patterns) != Some(&patterns)
                    {
                        self.blocks.push(Block { patterns, settings: vec![] });
                    }
                }
                _ => self.current().settings.push((key, args)),
            }
        }
    }
}

/// Reads a config's text (`load` reads included files). Returns the hosts and the remarks about
/// the whole file.
pub fn parse_str(text: &str, env: &Env, load: &dyn Fn(&Path) -> Option<String>) -> (Vec<ImportedSite>, Vec<String>) {
    let mut r = Reader::default();
    r.read(text, env, load, 0);
    let mut seen = HashMap::new();
    let sites = r.aliases.iter().map(|alias| site(alias, &r.blocks, env, &mut seen)).collect();
    let mut hints = vec![];
    if r.saw_match {
        hints.push("Match blocks aren't read: settings that only apply through Match don't carry over.".to_string());
    }
    (sites, hints)
}

/// What ssh would use for `alias`: the first value of each setting, from the sections that apply.
fn settings_for<'a>(alias: &str, blocks: &'a [Block]) -> HashMap<&'a str, &'a [String]> {
    let mut out: HashMap<&str, &[String]> = HashMap::new();
    for b in blocks.iter().filter(|b| b.patterns.as_deref().is_none_or(|p| host_matches(alias, p))) {
        for (k, v) in &b.settings {
            out.entry(k.as_str()).or_insert(v.as_slice());
        }
    }
    out
}

/// Every value of a setting that adds up rather than taking the first (`LocalForward`), in the
/// order the sections that apply give them.
fn all_for<'a>(alias: &str, blocks: &'a [Block], key: &str) -> Vec<&'a [String]> {
    blocks
        .iter()
        .filter(|b| b.patterns.as_deref().is_none_or(|p| host_matches(alias, p)))
        .flat_map(|b| b.settings.iter().filter(|(k, _)| k == key).map(|(_, v)| v.as_slice()))
        .collect()
}

/// A host's `LocalForward`s as tunnels (one per local port, the first one winning as in ssh),
/// with notes on what doesn't carry over.
fn forwards(alias: &str, blocks: &[Block], s: &mut ImportedSite) {
    for args in all_for(alias, blocks, "localforward") {
        match crate::tunnels::parse_local_forward(args) {
            Ok(f) if s.tunnels.iter().any(|t| t.local_port == f.def.local_port) => {
                s.notes.push(format!("LocalForward {} repeats local port {}: left out", args.join(" "), f.def.local_port));
            }
            Ok(mut f) => {
                f.def.id = format!("lf{}", f.def.local_port);
                s.tunnels.push(f.def);
                s.notes.extend(f.note);
            }
            Err(e) => s.notes.push(e),
        }
    }
    if !s.tunnels.is_empty() {
        let n = s.tunnels.len();
        s.notes.push(if n == 1 { "1 SSH tunnel (LocalForward)".into() } else { format!("{n} SSH tunnels (LocalForward)") });
    }
}

fn site(alias: &str, blocks: &[Block], env: &Env, seen: &mut HashMap<u64, u32>) -> ImportedSite {
    let set = settings_for(alias, blocks);
    let first = |k: &str| set.get(k).and_then(|v| v.first()).map(String::as_str);
    let host_name = first("hostname").map(|h| h.replace("%h", alias).replace("%%", "%")).unwrap_or_else(|| alias.to_string());
    let user = first("user").map(str::to_string).unwrap_or_else(|| env.local_user.clone());
    let port_text = first("port").unwrap_or("");
    let port: u16 = port_text.parse().unwrap_or(0);

    let mut s = ImportedSite::new(alias.to_string(), vec![GROUP.to_string()], "SFTP".into());
    s.id = site_id(&[alias, &host_name, &port.to_string(), &user], seen);
    s.kind = Some(ConnKind::Sftp);
    s.tls = TlsMode::None;
    s.host = host_name.clone();
    s.port = port;
    s.user = user.clone();
    if !port_text.is_empty() && port == 0 {
        s.notes.push(format!("Port “{port_text}” isn't a number: the usual port is used"));
    }
    let key = first("identityfile").filter(|k| !k.eq_ignore_ascii_case("none"));
    match key {
        Some(k) => {
            s.auth = SiteAuth::KeyFile;
            s.key_file = Some(expand_path(&tokens(k, alias, &host_name, &user, port, env), env));
        }
        // no key named: ssh would try the agent (and its default keys), so Kybl uses the agent
        None => s.auth = SiteAuth::Agent,
    }
    if let Some(j) = first("proxyjump").filter(|j| !j.eq_ignore_ascii_case("none")) {
        s.notes.push(format!("Goes through {j} (ProxyJump), which Kybl doesn't support: it connects directly"));
    }
    if set.get("proxycommand").is_some_and(|v| v.first().is_some_and(|c| !c.eq_ignore_ascii_case("none"))) {
        s.notes.push("Uses a ProxyCommand, which Kybl doesn't support: it connects directly".into());
    }
    forwards(alias, blocks, &mut s);
    s
}

/// `%h`, `%r`, `%u`, `%d`, `%p`, `%n` and `%%` in a path setting.
fn tokens(v: &str, alias: &str, host: &str, user: &str, port: u16, env: &Env) -> String {
    let mut out = String::new();
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('n') => out.push_str(alias),
            Some('r') => out.push_str(user),
            Some('u') => out.push_str(&env.local_user),
            Some('p') => out.push_str(&if port == 0 { 22 } else { port }.to_string()),
            Some('d') => out.push_str(&env.home.as_deref().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default()),
            Some('%') => out.push('%'),
            Some(o) => {
                out.push('%');
                out.push(o);
            }
            None => out.push('%'),
        }
    }
    out
}

/// `~/x` and `~` from the home folder; everything else as written.
fn expand_path(p: &str, env: &Env) -> PathBuf {
    match (p, &env.home) {
        ("~", Some(h)) => h.clone(),
        (_, Some(h)) if p.starts_with("~/") => h.join(&p[2..]),
        _ => PathBuf::from(p),
    }
}

/// The files an `Include` names, in name order (as glob(3) gives them to ssh).
fn expand_include(pattern: &str, env: &Env) -> Vec<PathBuf> {
    let p = expand_path(&tokens(pattern, "", "", "", 0, env), env);
    let p = if p.is_absolute() { p } else { env.ssh_dir.join(p) };
    glob(&p)
}

/// The paths matching `p`, whose parts may hold `*` and `?` (a plain path is just itself; a file
/// that isn't there is left out when it's read).
fn glob(p: &Path) -> Vec<PathBuf> {
    if !p.to_string_lossy().contains(['*', '?']) {
        return vec![p.to_path_buf()];
    }
    let mut found = vec![PathBuf::new()];
    for part in p.components() {
        let name = part.as_os_str().to_string_lossy();
        if !name.contains(['*', '?']) {
            for f in &mut found {
                f.push(part);
            }
            continue;
        }
        let mut next = vec![];
        for dir in &found {
            let Ok(rd) = std::fs::read_dir(dir) else { continue };
            let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            // like the shell: a leading dot is only matched by a pattern that starts with one
            next.extend(names.into_iter().filter(|n| (!n.starts_with('.') || name.starts_with('.')) && wildcard(&name, n)).map(|n| dir.join(n)));
        }
        found = next;
    }
    found.retain(|f| f.is_file());
    found
}

/// `*` (any run of characters) and `?` (one), as ssh matches host patterns and globs match names.
fn wildcard(pattern: &str, s: &str) -> bool {
    let (p, s): (Vec<char>, Vec<char>) = (pattern.chars().collect(), s.chars().collect());
    let (mut pi, mut si, mut star, mut mark) = (0, 0, None, 0);
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = si;
            pi += 1;
        } else if let Some(st) = star {
            pi = st + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// A `Host` line's patterns against an alias: one plain pattern must match and no `!pattern` may.
fn host_matches(alias: &str, patterns: &[String]) -> bool {
    let a = alias.to_lowercase();
    let mut hit = false;
    for p in patterns {
        let p = p.to_lowercase();
        if let Some(neg) = p.strip_prefix('!') {
            if wildcard(neg, &a) {
                return false;
            }
        } else if wildcard(&p, &a) {
            hit = true;
        }
    }
    hit
}

/// A host to list: a plain name, not a pattern.
fn is_concrete(alias: &str) -> bool {
    !alias.is_empty() && !alias.contains(['*', '?', '!'])
}

/// The keyword and its arguments: `Key value…`, `Key=value…` or `Key = value…`.
fn keyword(words: &[String]) -> Option<(String, Vec<String>)> {
    let (first, rest) = words.split_first()?;
    let (key, mut args) = match first.split_once('=') {
        Some((k, v)) => (k.to_string(), if v.is_empty() { vec![] } else { vec![v.to_string()] }),
        None => (first.clone(), vec![]),
    };
    let mut rest = rest.to_vec();
    if args.is_empty()
        && let Some(f) = rest.first_mut()
        && let Some(v) = f.strip_prefix('=')
    {
        *f = v.to_string();
        if f.is_empty() {
            rest.remove(0);
        }
    }
    args.extend(rest);
    (!key.is_empty()).then(|| (key.to_lowercase(), args))
}

/// A line's words: split at blanks, with "double" or 'single' quotes keeping blanks inside, a
/// backslash escaping the next character, and a word starting with `#` ending the line.
fn split_words(line: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (_, '\\') if chars.peek().is_some_and(|n| matches!(n, '"' | '\'' | '\\' | ' ' | '\t')) => {
                cur.push(chars.next().unwrap());
                in_word = true;
            }
            (None, ' ' | '\t') => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            (None, '#') if !in_word => break,
            (_, c) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic: every host, user and path here is made up.
    const MAIN: &str = r#"
# global settings
ServerAliveInterval 30

Include conf.d/*.conf

Host web web-alias   # two names for one server
    HostName files.example.com
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_web

Host "quoted box"
  HostName=box.example.net
  User = "ops team"
  IdentityFile "~/.ssh/keys/my key"

Host db
  HostName 10.0.0.5
  ProxyJump bastion.example.com

Host *.internal !skip.internal
  User internal-user

Match host db exec "true"
  User should-not-apply

Host pattern-only-*
  User nobody

Host app.internal
  IdentityFile none

Host *
  User fallback
  IdentityFile ~/.ssh/id_%h
"#;

    const INCLUDED: &str = "Host included\n  HostName inc.example.org\n  Port 22\n";

    fn env() -> Env {
        Env { home: Some(PathBuf::from("/home/me")), local_user: "me".into(), ssh_dir: PathBuf::from("/nonexistent/.ssh") }
    }

    fn run(text: &str, files: &[(&str, &str)]) -> (Vec<ImportedSite>, Vec<String>) {
        let files: HashMap<PathBuf, String> = files.iter().map(|(p, t)| (PathBuf::from(p), t.to_string())).collect();
        parse_str(text, &env(), &|p| files.get(p).cloned())
    }

    fn by_name<'a>(sites: &'a [ImportedSite], n: &str) -> &'a ImportedSite {
        sites.iter().find(|s| s.name == n).unwrap_or_else(|| panic!("no host {n}"))
    }

    #[test]
    fn hosts_aliases_quotes_and_defaults() {
        let (sites, hints) = run(MAIN, &[]);
        let names: Vec<&str> = sites.iter().map(|s| s.name.as_str()).collect();
        // patterns aren't hosts; the Include matched nothing here (no such folder)
        assert_eq!(names, ["web", "web-alias", "quoted box", "db", "app.internal"]);
        assert!(sites.iter().all(|s| s.folder == [GROUP] && s.kind == Some(ConnKind::Sftp) && s.protocol == "SFTP"));

        // two aliases on one line: two connections with the same settings
        for n in ["web", "web-alias"] {
            let w = by_name(&sites, n);
            assert_eq!((w.host.as_str(), w.port, w.user.as_str()), ("files.example.com", 2222, "deploy"));
            assert_eq!(w.auth, SiteAuth::KeyFile);
            assert_eq!(w.key_file.as_deref(), Some(Path::new("/home/me/.ssh/id_web")));
            assert!(w.notes.is_empty(), "{:?}", w.notes);
        }
        assert_ne!(by_name(&sites, "web").id, by_name(&sites, "web-alias").id);

        let q = by_name(&sites, "quoted box");
        assert_eq!((q.host.as_str(), q.user.as_str()), ("box.example.net", "ops team"));
        assert_eq!(q.key_file.as_deref(), Some(Path::new("/home/me/.ssh/keys/my key")));

        // Host * fills what db leaves out (first value wins); the Match block never applies
        let db = by_name(&sites, "db");
        assert_eq!((db.host.as_str(), db.port, db.user.as_str()), ("10.0.0.5", 0, "fallback"));
        assert_eq!(db.key_file.as_deref(), Some(Path::new("/home/me/.ssh/id_10.0.0.5")));
        assert!(db.notes.iter().any(|n| n.contains("bastion.example.com") && n.contains("ProxyJump")));

        // a wildcard section applies; "IdentityFile none" means no key, so the agent signs in
        let app = by_name(&sites, "app.internal");
        assert_eq!((app.host.as_str(), app.user.as_str()), ("app.internal", "internal-user"));
        assert_eq!(app.auth, SiteAuth::Agent);
        assert!(app.key_file.is_none());

        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("Match"));
    }

    #[test]
    fn includes_globs_and_their_sections() {
        let dir = std::env::temp_dir().join(format!("kybl-sshcfg-{}", std::process::id()));
        let conf = dir.join("conf.d");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join("b.conf"), "Host second\n  HostName two.example.org\n").unwrap();
        std::fs::write(conf.join("a.conf"), INCLUDED).unwrap();
        std::fs::write(conf.join("skip.txt"), "Host nope\n").unwrap();
        std::fs::write(conf.join(".hidden.conf"), "Host hidden\n").unwrap();
        let env = Env { ssh_dir: dir.clone(), ..env() };
        let text = "Host outer\n  Include conf.d/*.conf\n  User after-include\nHost *\n  User fallback\n";
        let (sites, _) = parse_str(text, &env, &|p| std::fs::read_to_string(p).ok());
        let names: Vec<&str> = sites.iter().map(|s| s.name.as_str()).collect();
        // sorted like glob(3); other extensions and dotfiles left out
        assert_eq!(names, ["outer", "included", "second"]);
        let inc = by_name(&sites, "included");
        assert_eq!((inc.host.as_str(), inc.port), ("inc.example.org", 22));
        // after the included file, its lines still belong to "Host outer"
        assert_eq!(by_name(&sites, "outer").user, "after-include");
        assert_eq!(by_name(&sites, "second").user, "fallback");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn includes_that_loop_stop() {
        let files = [("/nonexistent/.ssh/self", "Include self\nHost looped\n")];
        let (sites, _) = run("Include self\n", &files);
        // read MAX_DEPTH times, listed once
        assert_eq!(sites.len(), 1);
    }

    #[test]
    fn words_and_keywords() {
        assert_eq!(split_words("  Host a  b\t# c d"), ["Host", "a", "b"]);
        assert_eq!(split_words(r#"IdentityFile "~/my key" 'x y' z\ w"#), ["IdentityFile", "~/my key", "x y", "z w"]);
        assert_eq!(split_words("# just a comment"), Vec::<String>::new());
        assert_eq!(split_words(r#"User "a#b""#), ["User", "a#b"]);
        assert_eq!(keyword(&split_words("Port=22")), Some(("port".into(), vec!["22".into()])));
        assert_eq!(keyword(&split_words("Port = 22")), Some(("port".into(), vec!["22".into()])));
        assert_eq!(keyword(&split_words("Port =22")), Some(("port".into(), vec!["22".into()])));
        assert_eq!(keyword(&split_words("HOSTNAME x")), Some(("hostname".into(), vec!["x".into()])));
        assert_eq!(keyword(&[]), None);
    }

    #[test]
    fn patterns() {
        assert!(wildcard("*.example.com", "a.example.com"));
        assert!(!wildcard("*.example.com", "example.com"));
        assert!(wildcard("db?", "db1"));
        assert!(wildcard("*", ""));
        assert!(host_matches("A.internal", &["*.internal".into()]));
        assert!(!host_matches("skip.internal", &["*.internal".into(), "!skip.internal".into()]));
        assert!(!host_matches("x", &["!y".into()]));
        assert!(is_concrete("web") && !is_concrete("web*") && !is_concrete("!web"));
    }

    #[test]
    fn hosts_without_settings_and_odd_values() {
        let (sites, hints) = run("Host bare\nHost odd\n  Port twenty\n  HostName %h.example.com\n  ProxyCommand ssh -W %h:%p jump\n", &[]);
        let bare = by_name(&sites, "bare");
        assert_eq!((bare.host.as_str(), bare.port, bare.user.as_str(), bare.auth), ("bare", 0, "me", SiteAuth::Agent));
        let odd = by_name(&sites, "odd");
        assert_eq!((odd.host.as_str(), odd.port), ("odd.example.com", 0));
        assert!(odd.notes.iter().any(|n| n.contains("twenty")));
        assert!(odd.notes.iter().any(|n| n.contains("ProxyCommand")));
        assert!(hints.is_empty());
        // an empty file is fine
        assert!(run("", &[]).0.is_empty());
    }

    // Synthetic too: LocalForward in its forms, adding up across the sections that apply.
    const FORWARDS: &str = r#"
Host bastion
  HostName gw.example.com
  LocalForward 5433 db.internal:5432
  LocalForward 127.0.0.1:8080 localhost:80
  LocalForward 0.0.0.0:6380 [fd00::7]:6379
  LocalForward /tmp/pg.sock /var/run/postgresql/.s.PGSQL.5432
  LocalForward 5433 other.internal:5432
  LocalForward 9000 not-a-port
  ProxyJump jump.example.com

Host *.example.com bastion
  LocalForward 3000 app.internal:3000

Host plain
"#;

    #[test]
    fn local_forwards_become_tunnels() {
        let (sites, _) = run(FORWARDS, &[]);
        let b = by_name(&sites, "bastion");
        let routes: Vec<(u16, &str, u16)> = b.tunnels.iter().map(|t| (t.local_port, t.remote_host.as_str(), t.remote_port)).collect();
        assert_eq!(routes, [(5433, "db.internal", 5432), (8080, "localhost", 80), (6380, "fd00::7", 6379), (3000, "app.internal", 3000)]);
        assert!(b.tunnels.iter().all(|t| t.id == format!("lf{}", t.local_port) && !t.auto_start && t.name.is_empty()));
        let has = |part: &str| b.notes.iter().any(|n| n.contains(part));
        assert!(has("0.0.0.0:6380") && has("127.0.0.1 only"), "{:?}", b.notes);
        assert!(has("Unix socket"));
        assert!(has("repeats local port 5433"));
        assert!(has("9000 not-a-port"));
        assert!(has("4 SSH tunnels"));
        // tunnels don't make ProxyJump work: still noted
        assert!(has("ProxyJump"));
        assert!(by_name(&sites, "plain").tunnels.is_empty());

        // and they're saved with the connection
        let (mapped, _) = super::super::plan(&sites, std::slice::from_ref(&b.id), &[]);
        let net = mapped[0].profile.net.as_ref().unwrap();
        assert_eq!(net.tunnels, b.tunnels);
        let mut saved = net.tunnels.clone();
        crate::tunnels::tidy(&mut saved).unwrap();
        assert_eq!(saved, b.tunnels, "imported tunnels pass the form's checks as they are");
    }

    #[test]
    fn imports_like_any_other_site() {
        let (sites, _) = run(MAIN, &[]);
        let ids: Vec<String> = sites.iter().map(|s| s.id.clone()).collect();
        let (mapped, skipped) = super::super::plan(&sites, &ids, &[]);
        assert!(skipped.is_empty());
        let web = &mapped[0];
        assert_eq!(web.profile.group.as_deref(), Some(GROUP));
        let net = web.profile.net.as_ref().unwrap();
        assert_eq!((net.auth, net.port, net.host.as_str()), (crate::state::NetAuth::Key, 2222, "files.example.com"));
        // the key file isn't there: nothing is read, and the connection asks for the key
        assert!(web.secret.is_none() && web.needs_secret);
        let app = mapped.iter().find(|m| m.profile.name == "app.internal").unwrap();
        assert_eq!(app.profile.net.as_ref().unwrap().auth, crate::state::NetAuth::Agent);
    }
}
