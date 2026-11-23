//! Searching inside files: on this computer with ripgrep, else grep, else a walker of our own;
//! on an SFTP server with ripgrep or grep run there. One result per file (its first matching line
//! and how many lines match), streamed as found, stoppable.

use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use serde::Serialize;

use super::{
    hits::{parse_grep_line, Collector, Hit, Lines, Matcher},
    tools::{command, find_tool, run_streaming, shell_quote, StreamEnd},
};
use crate::storage::{sftp::SftpBackend, Storage};

/// At most this many files are listed.
pub const MAX_FILES: usize = 500;
/// Output read before stopping (a search matching nearly every line of a big tree).
const MAX_OUTPUT: usize = 32 << 20;
const LOCAL_TIME: Duration = Duration::from_secs(120);
const REMOTE_TIME: Duration = Duration::from_secs(30);
/// Bigger files are skipped.
const MAX_FILE_BYTES: u64 = 8 << 20;
/// Found files are handed on at least this often.
const EMIT_EVERY: Duration = Duration::from_millis(150);

pub struct Query {
    pub text: String,
    pub case_sensitive: bool,
    pub regex: bool,
    /// search dotfiles and dot-folders too (the pane shows hidden files)
    pub hidden: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentResult {
    pub hits: Vec<Hit>,
    pub files: usize,
    pub matches: u64,
    /// stopped before the end (enough files, stopped by the user, out of time)
    pub truncated: bool,
    /// what searched: "ripgrep", "grep" or "built-in"
    pub engine: String,
    /// why this place can't be searched by content (shown instead of results)
    pub unavailable: Option<String>,
}

/// ripgrep's arguments, searching the current folder.
pub fn rg_args(q: &Query) -> Vec<String> {
    let mut a: Vec<String> = ["--no-config", "--line-number", "--null", "--no-heading", "--color", "never", "--no-messages", "--max-filesize", "8M", "--max-columns", "4000", "--max-columns-preview", "--glob", "!.git"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push(if q.case_sensitive { "--case-sensitive" } else { "--ignore-case" }.into());
    if q.hidden {
        a.push("--hidden".into());
    }
    if !q.regex {
        a.push("--fixed-strings".into());
    }
    a.extend(["-e".into(), q.text.clone(), "--".into(), ".".into()]);
    a
}

/// grep's (GNU and BSD): binary files skipped, .git left out. Dotfiles are left out afterwards.
pub fn grep_args(q: &Query) -> Vec<String> {
    let mut a: Vec<String> = ["-r", "-I", "-n", "--null", "--exclude-dir=.git"].iter().map(|s| s.to_string()).collect();
    if !q.case_sensitive {
        a.push("-i".into());
    }
    a.push(if q.regex { "-E" } else { "-F" }.into());
    a.extend(["-e".into(), q.text.clone(), "--".into(), ".".into()]);
    a
}

/// A path (below the searched folder) with a dot-named file or folder in it.
fn dotted(path: &str) -> bool {
    path.split('/').any(|p| p.starts_with('.'))
}

/// Hands what was found on every so often (and at the end).
struct Batcher<'a, F: FnMut(Vec<Hit>, usize, u64)> {
    emit: F,
    last: Instant,
    all: Vec<Hit>,
    stat: &'a dyn Fn(&mut Hit),
}

impl<F: FnMut(Vec<Hit>, usize, u64)> Batcher<'_, F> {
    fn tick(&mut self, col: &mut Collector, force: bool) {
        if !force && self.last.elapsed() < EMIT_EVERY {
            return;
        }
        self.last = Instant::now();
        let mut done = if force { col.finish() } else { col.take_done() };
        if done.is_empty() {
            return;
        }
        done.iter_mut().for_each(|h| (self.stat)(h));
        (self.emit)(done.clone(), col.files, col.matches);
        self.all.extend(done);
    }
}

fn millis(t: std::time::SystemTime) -> Option<i64> {
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// Searches the files below `dir` (this computer's folder shown as `prefix`). Blocking: run it
/// off the async runtime. `emit` gets each batch of files found, with the totals so far.
pub fn search_local(dir: &Path, prefix: &str, q: &Query, cancel: &AtomicBool, emit: impl FnMut(Vec<Hit>, usize, u64)) -> Result<ContentResult, String> {
    let m = Matcher::new(&q.text, q.case_sensitive, q.regex)?;
    let stat = |h: &mut Hit| {
        if let Ok(md) = std::fs::metadata(dir.join(&h.key[prefix.len()..])) {
            h.size = md.len() as i64;
            h.modified = md.modified().ok().and_then(millis);
        }
    };
    let mut out = Batcher { emit, last: Instant::now(), all: Vec::new(), stat: &stat };
    let mut col = Collector::new(prefix, &m, MAX_FILES);
    let tool = find_tool("rg").map(|p| (p, "ripgrep", rg_args(q))).or_else(|| if cfg!(windows) { None } else { find_tool("grep").map(|p| (p, "grep", grep_args(q))) });
    let (engine, truncated) = match tool {
        Some((bin, engine, args)) => {
            let mut cmd = command(&bin);
            cmd.args(&args).current_dir(dir);
            let mut lines = Lines::default();
            let mut bytes = 0usize;
            let skip_dots = engine == "grep" && !q.hidden;
            let on_line = |l: &[u8], col: &mut Collector| match parse_grep_line(l) {
                Some((p, n, t)) if !(skip_dots && dotted(&p)) => col.push(&p, n, &t),
                _ => true,
            };
            let (end, err) = run_streaming(cmd, cancel, Instant::now() + LOCAL_TIME, |chunk| {
                bytes += chunk.len();
                let go = lines.push(chunk, |l| on_line(l, &mut col));
                out.tick(&mut col, false);
                go && bytes < MAX_OUTPUT
            })
            .map_err(|e| format!("Couldn't run {engine}. {e}"))?;
            if let StreamEnd::Exited(code) = end {
                lines.finish(|l| on_line(l, &mut col));
                // 1: nothing found; 2: an error, which matters only when nothing came back at all
                if code.unwrap_or(2) >= 2 && col.files == 0 && !err.is_empty() {
                    return Err(format!("The search didn't work.\n\n{err}"));
                }
            }
            (engine, !matches!(end, StreamEnd::Exited(_)))
        }
        None => ("built-in", walk_local(dir, q, &m, cancel, &mut col, &mut out)),
    };
    out.tick(&mut col, true);
    Ok(ContentResult { truncated: truncated || col.full, files: col.files, matches: col.matches, hits: out.all, engine: engine.into(), unavailable: None })
}

/// The built-in search, where neither ripgrep nor grep is installed. True when it stopped early.
fn walk_local<F: FnMut(Vec<Hit>, usize, u64)>(dir: &Path, q: &Query, m: &Matcher, cancel: &AtomicBool, col: &mut Collector, out: &mut Batcher<F>) -> bool {
    let deadline = Instant::now() + LOCAL_TIME;
    let mut each = |abs: &Path| -> bool {
        if cancel.load(Ordering::Relaxed) || Instant::now() > deadline {
            return false;
        }
        let Ok(rel) = abs.strip_prefix(dir) else { return true };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if std::fs::metadata(abs).map(|md| !md.is_file() || md.len() > MAX_FILE_BYTES).unwrap_or(true) {
            return true;
        }
        let Ok(bytes) = std::fs::read(abs) else { return true };
        if bytes[..bytes.len().min(8000)].contains(&0) {
            return true;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.split('\n').enumerate() {
            if m.is_match(line) && !col.push(&rel, i as u64 + 1, line) {
                return false;
            }
        }
        out.tick(col, false);
        true
    };
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // .gitignore is respected here as ripgrep does (the crate is in for folder sync already)
        let walk = ignore::WalkBuilder::new(dir)
            .hidden(!q.hidden)
            .git_global(false)
            .ignore(false)
            .follow_links(false)
            .filter_entry(|e| e.file_name() != ".git")
            .build();
        for e in walk.flatten() {
            if e.file_type().is_some_and(|t| t.is_file()) && !each(e.path()) {
                return true;
            }
        }
        false
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let walk = walkdir::WalkDir::new(dir).follow_links(false).into_iter().filter_entry(|e| e.depth() == 0 || (q.hidden || !e.file_name().to_string_lossy().starts_with('.')));
        for e in walk.flatten() {
            if e.file_type().is_file() && !each(e.path()) {
                return true;
            }
        }
        false
    }
}

// ---------------------------------------------------------------- SFTP

/// What runs on the server: in the folder, ripgrep where installed, else grep; the first line
/// out says which (or that neither is there, or the folder isn't).
pub fn remote_script(dir: &str, q: &Query) -> String {
    let words = |tool: &str, args: Vec<String>| std::iter::once(tool.to_string()).chain(args).map(|a| shell_quote(&a)).collect::<Vec<_>>().join(" ");
    let script = format!(
        "cd {} 2>/dev/null || {{ echo kybl:nodir; exit 0; }}; if command -v rg >/dev/null 2>&1; then echo kybl:rg; exec {}; elif command -v grep >/dev/null 2>&1; then echo kybl:grep; exec {}; else echo kybl:none; fi",
        shell_quote(dir),
        words("rg", rg_args(q)),
        words("grep", grep_args(q)),
    );
    // the login shell may not be a POSIX one (fish, csh): sh runs the script
    format!("sh -c {}", shell_quote(&script))
}

const NO_COMMANDS: &str = "This server doesn't let Kybl run commands (an SFTP-only account), so its files can't be searched by content.";

/// Searches the files below `prefix` on an SFTP server, over an SSH exec channel
/// ([`SftpBackend::exec`], shared with custom actions).
pub async fn search_sftp(s: &SftpBackend, prefix: &str, q: &Query, cancel: &AtomicBool, mut emit: impl FnMut(Vec<Hit>, usize, u64)) -> Result<ContentResult, String> {
    let m = Matcher::new(&q.text, q.case_sensitive, q.regex)?;
    let dir = s.remote_path(prefix).await?;
    let script = remote_script(&dir, q);
    // set when the user stops, time runs out or enough was found: the command is stopped
    let halt = AtomicBool::new(false);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(bool, Vec<u8>)>();
    let run = s.exec(&script, &halt, move |stderr, d| {
        let _ = tx.send((stderr, d.to_vec()));
    });

    let mut col = Collector::new(prefix, &m, MAX_FILES);
    let mut lines = Lines::default();
    let mut engine: Option<String> = None;
    let mut err_tail: Vec<u8> = Vec::new();
    let (mut bytes, mut stopped) = (0usize, false);
    let mut all: Vec<Hit> = Vec::new();
    let deadline = Instant::now() + REMOTE_TIME;
    let on_line = |l: &[u8], col: &mut Collector, engine: &mut Option<String>| -> bool {
        if engine.is_none() {
            *engine = Some(String::from_utf8_lossy(l).trim().trim_start_matches("kybl:").to_string());
            return true;
        }
        match parse_grep_line(l) {
            Some((p, n, t)) if !(engine.as_deref() == Some("grep") && !q.hidden && dotted(&p)) => col.push(&p, n, &t),
            _ => true,
        }
    };
    let read = async {
        let mut last = Instant::now();
        loop {
            let next = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;
            if !stopped && (cancel.load(Ordering::Relaxed) || Instant::now() >= deadline) {
                stopped = true;
                halt.store(true, Ordering::Relaxed);
            }
            match next {
                Ok(None) => break,
                Ok(Some((true, d))) => {
                    err_tail.extend_from_slice(&d);
                    let cut = err_tail.len().saturating_sub(2000);
                    err_tail.drain(..cut);
                }
                // what comes after stopping is left
                Ok(Some((false, d))) if !stopped => {
                    bytes += d.len();
                    if !lines.push(&d, |l| on_line(l, &mut col, &mut engine)) || bytes >= MAX_OUTPUT {
                        stopped = true;
                        halt.store(true, Ordering::Relaxed);
                    }
                }
                _ => {}
            }
            if last.elapsed() >= EMIT_EVERY {
                last = Instant::now();
                let batch = stat_remote(s, col.take_done()).await;
                if !batch.is_empty() {
                    emit(batch.clone(), col.files, col.matches);
                    all.extend(batch);
                }
            }
        }
    };
    let (end, ()) = tokio::join!(run, read);
    let end = match end {
        Ok(end) => end,
        // an SFTP-only account, or a server that runs no commands
        Err(e) if e.kind != crate::storage::ErrKind::Network => return Ok(ContentResult { unavailable: Some(NO_COMMANDS.into()), ..Default::default() }),
        Err(e) => return Err(e.to_string()),
    };
    if !stopped {
        lines.finish(|l| on_line(l, &mut col, &mut engine));
    }
    let say = |u: &str| Ok(ContentResult { unavailable: Some(u.into()), ..Default::default() });
    match engine.as_deref() {
        None if stopped => {}
        None => return say(NO_COMMANDS),
        Some("none") => return say("Neither ripgrep nor grep is installed on this server, so its files can't be searched by content."),
        Some("nodir") => return Err("This folder isn't on the server any more.".into()),
        Some(_) => {}
    }
    if end.code.unwrap_or(0) >= 2 && col.files == 0 && !err_tail.is_empty() {
        return Err(format!("The search on the server didn't work.\n\n{}", String::from_utf8_lossy(&err_tail).trim()));
    }
    let rest = stat_remote(s, col.finish()).await;
    if !rest.is_empty() {
        emit(rest.clone(), col.files, col.matches);
        all.extend(rest);
    }
    let engine = match engine.as_deref() {
        Some("rg") => "ripgrep",
        Some("grep") => "grep",
        _ => "",
    };
    Ok(ContentResult { hits: all, files: col.files, matches: col.matches, truncated: stopped || col.full, engine: engine.into(), unavailable: None })
}

/// Sizes and dates of the files found (a few at a time; a file that went away keeps none).
async fn stat_remote(s: &SftpBackend, hits: Vec<Hit>) -> Vec<Hit> {
    futures_util::stream::iter(hits)
        .map(|mut h| async move {
            if let Ok(Some(e)) = s.stat("", &h.key).await {
                h.size = e.size;
                h.modified = e.modified;
            }
            h
        })
        .buffered(8)
        .collect()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(text: &str) -> Query {
        Query { text: text.into(), case_sensitive: false, regex: false, hidden: false }
    }

    #[test]
    fn the_query_is_one_argument_after_the_options() {
        let a = rg_args(&q("-rf --pre=evil"));
        let e = a.iter().position(|x| x == "-e").unwrap();
        assert_eq!(&a[e + 1..], ["-rf --pre=evil", "--", "."]);
        assert!(a.contains(&"--fixed-strings".to_string()) && a.contains(&"--ignore-case".to_string()));
        let g = grep_args(&Query { case_sensitive: true, regex: true, ..q("a|b") });
        assert!(g.contains(&"-E".to_string()) && !g.contains(&"-i".to_string()));
        assert_eq!(&g[g.len() - 4..], ["-e", "a|b", "--", "."]);
    }

    /// The server's script, run by a local sh: the query and the folder come through as typed.
    #[cfg(unix)]
    #[test]
    fn the_remote_script_quotes_what_the_user_typed() {
        let dir = std::env::temp_dir().join(format!("kybl it's $(x) {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/a.txt"), "nothing\nsay 'it's $(here)`\n").unwrap();
        std::fs::write(dir.join(".hidden.txt"), "it's $(here)`").unwrap();
        let script = remote_script(&dir.to_string_lossy(), &q("it's $(here)`"));
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(&script).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let mut lines = text.split('\n');
        let engine = lines.next().unwrap();
        assert!(engine == "kybl:rg" || engine == "kybl:grep", "{text}");
        let found: Vec<_> = lines.filter_map(|l| parse_grep_line(l.as_bytes())).filter(|(p, ..)| !dotted(p)).collect();
        assert_eq!(found, vec![("sub/a.txt".to_string(), 2, "say 'it's $(here)`".to_string())]);
        // a folder that isn't there
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(remote_script("/nonexistent/kybl", &q("x"))).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "kybl:nodir");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn searches_this_computer() {
        let dir = std::env::temp_dir().join(format!("kybl-cs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.rs"), "fn main() {}\n// TODO: one\nlet todo = 2;\n").unwrap();
        std::fs::write(dir.join("b.txt"), "no match here\n").unwrap();
        std::fs::write(dir.join("bin.dat"), b"TODO\0\x01\x02").unwrap();
        let cancel = AtomicBool::new(false);
        let mut streamed = 0;
        let r = search_local(&dir, "proj/", &q("todo"), &cancel, |h, _, _| streamed += h.len()).unwrap();
        assert_eq!(r.files, 1, "{:?}", r.hits);
        assert_eq!(streamed, 1);
        let h = &r.hits[0];
        assert_eq!((h.key.as_str(), h.line, h.count, h.text.as_str()), ("proj/src/a.rs", 2, 2, "// TODO: one"));
        assert_eq!(h.ranges, vec![[3, 7]]);
        assert!(h.size > 0 && h.modified.is_some());
        let r = search_local(&dir, "", &Query { case_sensitive: true, ..q("TODO") }, &cancel, |_, _, _| {}).unwrap();
        assert_eq!(r.matches, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_built_in_walker_finds_the_same() {
        let dir = std::env::temp_dir().join(format!("kybl-cw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join(".cache")).unwrap();
        std::fs::write(dir.join("src/a.rs"), "x\nNeedle\nneedle\n").unwrap();
        std::fs::write(dir.join(".cache/c"), "needle").unwrap();
        std::fs::write(dir.join("bin"), b"needle\0").unwrap();
        let m = Matcher::new("needle", false, false).unwrap();
        let mut col = Collector::new("", &m, 10);
        let stat = |_: &mut Hit| {};
        let mut out = Batcher { emit: |_, _, _| {}, last: Instant::now(), all: Vec::new(), stat: &stat };
        assert!(!walk_local(&dir, &q("needle"), &m, &AtomicBool::new(false), &mut col, &mut out));
        out.tick(&mut col, true);
        let keys: Vec<_> = out.all.iter().map(|h| (h.key.as_str(), h.line, h.count)).collect();
        assert_eq!(keys, vec![("src/a.rs", 2, 2)]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, unix))]
mod sftp_tests {
    use std::collections::HashMap;

    use std::{sync::Arc, time::Duration};

    use russh::{server::Msg, Channel, ChannelId};
    use russh_sftp::protocol::{Attrs, FileAttributes, StatusCode};

    use super::*;
    use crate::{state::NetConfig, storage::net::Secrets};

    /// The SFTP side: the start folder is a folder, and so is everything asked about.
    struct Files;

    impl russh_sftp::server::Handler for Files {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn stat(&mut self, id: u32, _path: russh_sftp::protocol::SftpString) -> Result<Attrs, Self::Error> {
            Ok(Attrs { id, attrs: FileAttributes::dummy() })
        }
    }

    /// An SSH server that signs anyone in, serves [`Files`] and runs commands with this
    /// computer's sh, as an OpenSSH server runs them with the user's shell.
    #[derive(Default)]
    struct Server {
        channels: HashMap<ChannelId, Channel<Msg>>,
    }

    impl russh::server::Handler for Server {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(&mut self, channel: Channel<Msg>, reply: russh::server::ChannelOpenHandle, _session: &mut russh::server::Session) -> Result<(), Self::Error> {
            self.channels.insert(channel.id(), channel);
            reply.accept().await;
            Ok(())
        }

        async fn subsystem_request(&mut self, id: ChannelId, name: &str, session: &mut russh::server::Session) -> Result<(), Self::Error> {
            if let (Some(ch), "sftp") = (self.channels.remove(&id), name) {
                session.channel_success(id)?;
                tokio::spawn(russh_sftp::server::run(ch.into_stream(), Files));
            } else {
                session.channel_failure(id)?;
            }
            Ok(())
        }

        async fn exec_request(&mut self, id: ChannelId, data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(id)?;
            let (cmd, handle) = (String::from_utf8_lossy(data).into_owned(), session.handle());
            tokio::spawn(async move {
                let out = tokio::task::spawn_blocking(move || std::process::Command::new("/bin/sh").arg("-c").arg(cmd).output().unwrap()).await.unwrap();
                let _ = handle.data(id, out.stdout).await;
                let _ = handle.exit_status_request(id, out.status.code().unwrap_or(255) as u32).await;
                let _ = handle.eof(id).await;
                let _ = handle.close(id).await;
            });
            Ok(())
        }
    }

    /// Content search on a server, start to end: the command crosses an SSH exec channel and a
    /// shell, and what the user typed (quotes, `$( )`) arrives as typed.
    #[test]
    fn searches_inside_files_on_the_server() {
        use russh::keys::{ssh_key::private::Ed25519Keypair, HashAlg, PrivateKey};
        let dir = std::env::temp_dir().join(format!("kybl-sftp-cs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub dir")).unwrap();
        std::fs::write(dir.join("a.txt"), "say it's $(here)\nnothing\nIT'S $(HERE) again\n").unwrap();
        std::fs::write(dir.join("sub dir/b'q.txt"), "x it's $(here)").unwrap();
        std::fs::write(dir.join(".hidden"), "it's $(here)").unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let key = PrivateKey::from(Ed25519Keypair::from_seed(&[9; 32]));
            let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
            let config = Arc::new(russh::server::Config { keys: vec![key], auth_rejection_time: Duration::from_millis(10), ..Default::default() });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    let config = config.clone();
                    tokio::spawn(async move {
                        if let Ok(s) = russh::server::run_stream(config, tcp, Server::default()).await {
                            let _ = s.await;
                        }
                    });
                }
            });
            let cfg = NetConfig { host: "127.0.0.1".into(), port, user: "me".into(), host_key: Some(fp), base_path: dir.to_string_lossy().into_owned(), ..Default::default() };
            let b = SftpBackend::new(&cfg, Secrets { password: Some("pw".into()), ssh: None }).unwrap();
            let q = Query { text: "it's $(here)".into(), case_sensitive: false, regex: false, hidden: false };
            let cancel = AtomicBool::new(false);
            let mut streamed = 0;
            let r = tokio::time::timeout(Duration::from_secs(20), search_sftp(&b, "", &q, &cancel, |h, _, _| streamed += h.len())).await.unwrap().unwrap();
            assert!(r.unavailable.is_none(), "{:?}", r.unavailable);
            assert!(r.engine == "ripgrep" || r.engine == "grep", "{}", r.engine);
            let mut found: Vec<_> = r.hits.iter().map(|h| (h.key.as_str(), h.line, h.count)).collect();
            found.sort();
            assert_eq!(found, vec![("a.txt", 1, 2), ("sub dir/b'q.txt", 1, 1)]);
            assert_eq!((r.files, r.matches, streamed), (2, 3, 2));
            let a = r.hits.iter().find(|h| h.key == "a.txt").unwrap();
            assert_eq!((a.text.as_str(), a.ranges.clone()), ("say it's $(here)", vec![[4, 16]]));

            // below a folder: keys keep the folder's prefix
            let r = search_sftp(&b, "sub dir/", &q, &cancel, |_, _, _| {}).await.unwrap();
            assert_eq!(r.hits.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(), ["sub dir/b'q.txt"]);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
