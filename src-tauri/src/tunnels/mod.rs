//! SSH tunnels (local port forwards) of SFTP connections: "127.0.0.1:5433 → db.internal:5432
//! through my server", to reach a database or an admin panel only the server can see.
//!
//! The definitions are saved with the connection (`NetConfig::tunnels`); this module tidies and
//! checks them, and reads OpenSSH's `LocalForward` for the SSH config import. Running them is
//! [`run`]'s (computers only): each tunnel listens on 127.0.0.1 and carries every accepted TCP
//! connection over a `direct-tcpip` channel of an SSH connection of its own.

#[cfg(desktop)]
pub mod run;

use serde::{Deserialize, Serialize};

/// One local port forward of a connection.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TunnelDef {
    /// stable within the connection (the running tunnel and the ⌘K commands go by it)
    pub id: String,
    /// optional; [`TunnelDef::label`] stands in when empty
    pub name: String,
    /// the port on 127.0.0.1 that apps connect to
    pub local_port: u16,
    /// where the server connects to, as the server sees it ("db.internal", "localhost")
    pub remote_host: String,
    pub remote_port: u16,
    /// started when Kybl first opens the connection in a run
    pub auto_start: bool,
}

impl TunnelDef {
    /// The name, or the place it reaches ("db.internal:5432").
    pub fn label(&self) -> String {
        let n = self.name.trim();
        if n.is_empty() { host_port(&self.remote_host, self.remote_port) } else { n.to_string() }
    }

    /// Goes to the same place from the same port (a rename doesn't change what runs).
    pub fn same_route(&self, o: &TunnelDef) -> bool {
        self.local_port == o.local_port && self.remote_port == o.remote_port && self.remote_host.eq_ignore_ascii_case(&o.remote_host)
    }
}

/// "host:port", with an IPv6 address in brackets.
pub fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// A connection's tunnels as they are saved: trimmed, each with an id, checked. The first problem
/// found is the error, in words for the connection's form.
pub fn tidy(defs: &mut [TunnelDef]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    let mut ports = std::collections::HashSet::new();
    for d in defs.iter_mut() {
        d.name = d.name.trim().to_string();
        d.remote_host = d.remote_host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
        d.id = d.id.trim().to_string();
        if d.id.is_empty() || ids.contains(&d.id) {
            d.id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        }
        ids.insert(d.id.clone());
        check(d)?;
        if !ports.insert(d.local_port) {
            return Err(format!("Two tunnels use local port {}. Give each its own.", d.local_port));
        }
    }
    Ok(())
}

/// One tunnel's own problems.
pub fn check(d: &TunnelDef) -> Result<(), String> {
    let what = if d.name.is_empty() { "A tunnel".to_string() } else { format!("Tunnel “{}”", d.name) };
    if d.local_port == 0 {
        return Err(format!("{what} needs a local port (1 to 65535)."));
    }
    if d.remote_host.is_empty() {
        return Err(format!("{what} needs the host to reach, as the server sees it (such as localhost)."));
    }
    if d.remote_host.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/') {
        return Err(format!("{what}: “{}” isn't a host name or address.", d.remote_host));
    }
    if d.remote_port == 0 {
        return Err(format!("{what} needs the remote port (1 to 65535)."));
    }
    Ok(())
}

/// What a `LocalForward` line made: the tunnel, and a remark when not all of it carries over.
#[derive(Debug, PartialEq, Eq)]
pub struct Forward {
    pub def: TunnelDef,
    pub note: Option<String>,
}

/// OpenSSH's `LocalForward [bind_address:]port host:hostport` (IPv6 addresses in brackets). Unix
/// socket forwards and anything unreadable are an error saying so; a bind address other than
/// this computer's loopback is a note, as Kybl only listens on 127.0.0.1.
pub fn parse_local_forward(args: &[String]) -> Result<Forward, String> {
    let raw = args.join(" ");
    let unsupported = || format!("LocalForward {raw} isn't a port forward Kybl can make");
    // `LocalForward 5433:db:5432` (one word, as `ssh -L` takes it) is read too
    let (local, target) = match args {
        [l, t] => (l.clone(), t.clone()),
        [one] => {
            let (l, t) = split_last_two(one).ok_or_else(unsupported)?;
            (l.to_string(), t.to_string())
        }
        _ => return Err(unsupported()),
    };
    if local.contains('/') || target.contains('/') {
        return Err(format!("LocalForward {raw} uses a Unix socket, which Kybl doesn't forward"));
    }
    let (bind, lport) = split_host_port(&local).ok_or_else(unsupported)?;
    let (host, rport) = split_host_port(&target).ok_or_else(unsupported)?;
    let host = host.ok_or_else(unsupported)?;
    let local_port: u16 = lport.parse().ok().filter(|p| *p > 0).ok_or_else(unsupported)?;
    let remote_port: u16 = rport.parse().ok().filter(|p| *p > 0).ok_or_else(unsupported)?;
    let def = TunnelDef { local_port, remote_host: host.to_string(), remote_port, ..Default::default() };
    check(&def).map_err(|_| unsupported())?;
    let note = bind
        .filter(|b| !matches!(b.to_ascii_lowercase().as_str(), "" | "localhost" | "127.0.0.1" | "::1"))
        .map(|b| format!("LocalForward on {b}:{local_port} listens on 127.0.0.1 only in Kybl"));
    Ok(Forward { def, note })
}

/// `[host:]port` → (host, port), with `[v6]` brackets taken off.
fn split_host_port(s: &str) -> Option<(Option<&str>, &str)> {
    if let Some(rest) = s.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = after.strip_prefix(':')?;
        return Some((Some(host), port));
    }
    match s.rsplit_once(':') {
        // a bare IPv6 address without brackets can't be told from its port
        Some((h, _)) if h.contains(':') => None,
        Some((h, p)) => Some((Some(h), p)),
        None => Some((None, s)),
    }
}

/// "5433:db:5432" / "127.0.0.1:5433:db:5432" → (local part, target part).
fn split_last_two(s: &str) -> Option<(&str, &str)> {
    // the target is the last host:port (a bracketed v6 host keeps its colons)
    let bytes = s.as_bytes();
    let (mut depth, mut colons) = (0, vec![]);
    for (i, b) in bytes.iter().enumerate() {
        match b {
            b'[' => depth += 1,
            b']' => depth -= 1,
            b':' if depth == 0 => colons.push(i),
            _ => {}
        }
    }
    let cut = *colons.iter().rev().nth(1)?;
    Some((&s[..cut], &s[cut + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(local: u16, host: &str, remote: u16) -> TunnelDef {
        TunnelDef { local_port: local, remote_host: host.into(), remote_port: remote, ..Default::default() }
    }

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn tidy_trims_gives_ids_and_checks() {
        let mut d = vec![
            TunnelDef { name: "  DB ".into(), remote_host: " db.internal ".into(), ..def(5433, "", 5432) },
            TunnelDef { id: "keep".into(), ..def(8080, "[::1]", 80) },
        ];
        tidy(&mut d).unwrap();
        assert_eq!((d[0].name.as_str(), d[0].remote_host.as_str()), ("DB", "db.internal"));
        assert_eq!(d[0].id.len(), 12);
        assert_eq!((d[1].id.as_str(), d[1].remote_host.as_str()), ("keep", "::1"));
        assert_eq!(d[1].label(), "[::1]:80");
        assert_eq!(d[0].label(), "DB");

        // the same id twice: the second gets a new one
        let mut d = vec![TunnelDef { id: "x".into(), ..def(1, "a", 1) }, TunnelDef { id: "x".into(), ..def(2, "a", 1) }];
        tidy(&mut d).unwrap();
        assert_ne!(d[0].id, d[1].id);
    }

    #[test]
    fn tidy_refuses_bad_tunnels() {
        let bad = |d: TunnelDef| tidy(&mut [d]).unwrap_err();
        assert!(bad(def(0, "db", 5432)).contains("local port"));
        assert!(bad(def(5433, " ", 5432)).contains("host to reach"));
        assert!(bad(def(5433, "db", 0)).contains("remote port"));
        assert!(bad(def(5433, "db host", 1)).contains("isn't a host"));
        assert!(bad(TunnelDef { name: "Admin".into(), ..def(0, "x", 1) }).starts_with("Tunnel “Admin”"));
        let err = tidy(&mut [def(5433, "a", 1), def(5433, "b", 2)]).unwrap_err();
        assert!(err.contains("5433"), "{err}");
    }

    #[test]
    fn routes_and_labels() {
        let a = TunnelDef { name: "one".into(), ..def(5433, "DB", 5432) };
        assert!(a.same_route(&TunnelDef { name: "two".into(), ..def(5433, "db", 5432) }));
        assert!(!a.same_route(&def(5434, "db", 5432)));
        assert_eq!(def(1, "db", 5432).label(), "db:5432");
    }

    #[test]
    fn local_forward_forms() {
        let f = parse_local_forward(&words("5433 db.internal:5432")).unwrap();
        assert_eq!(f.def, def(5433, "db.internal", 5432));
        assert_eq!(f.note, None);

        for loopback in ["localhost:8080", "127.0.0.1:8080", "[::1]:8080"] {
            let f = parse_local_forward(&words(&format!("{loopback} localhost:80"))).unwrap();
            assert_eq!((f.def.local_port, f.def.remote_host.as_str(), f.note), (8080, "localhost", None));
        }
        let f = parse_local_forward(&words("0.0.0.0:3000 app:3000")).unwrap();
        assert!(f.note.unwrap().contains("0.0.0.0:3000"));
        let f = parse_local_forward(&words("*:3000 app:3000")).unwrap();
        assert!(f.note.is_some());

        let f = parse_local_forward(&words("6000 [fd00::5]:6379")).unwrap();
        assert_eq!(f.def, def(6000, "fd00::5", 6379));
        // one word, like ssh -L
        assert_eq!(parse_local_forward(&words("5433:db:5432")).unwrap().def, def(5433, "db", 5432));
        assert_eq!(parse_local_forward(&words("127.0.0.1:5433:[fd00::1]:5432")).unwrap().def, def(5433, "fd00::1", 5432));
    }

    #[test]
    fn local_forward_refusals() {
        for bad in ["", "5433", "5433 db", "x db:5432", "5433 db:http", "0 db:1", "5433 db:0", "5433 db:70000", "a b c", "5433 fd00::1:5432"] {
            assert!(parse_local_forward(&words(bad)).is_err(), "{bad}");
        }
        let e = parse_local_forward(&words("/tmp/s.sock /var/run/db.sock")).unwrap_err();
        assert!(e.contains("Unix socket"));
        let e = parse_local_forward(&words("5433 /var/run/postgresql/.s.PGSQL.5432")).unwrap_err();
        assert!(e.contains("Unix socket"));
    }
}
