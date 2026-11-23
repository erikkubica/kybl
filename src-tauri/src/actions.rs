//! Custom actions (Settings → Actions): a shell command line with placeholders, run on the
//! selected files and folders, on this computer (`$SHELL -l -c`) or on an SFTP server over SSH.
//!
//! Templates are shell commands on purpose, but every placeholder value is shell-quoted (single
//! quotes), so a file name can never become part of the command. Output streams to the page as
//! `custom-action-output` events, at most [`OUTPUT_LIMIT`] per run; nothing of it is logged.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::state::AppState;

/// Output passed on per run; the rest is dropped (the process keeps running).
pub const OUTPUT_LIMIT: usize = 1024 * 1024;

/// Placeholders that make the command run once per item.
const PER_ITEM: [&str; 4] = ["path", "name", "ext", "stem"];

/// One selected item: an absolute path (on this computer, or on the server).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    #[serde(default)]
    pub is_dir: bool,
}

// ---------------------------------------------------------------- template expansion

/// `s` as one shell word: single quotes, with each quote and backslash written outside them,
/// escaped (`'\''`, `'\\'`). Nothing between the quotes is then special to any shell: POSIX
/// shells, fish (where `\'` and `\\` are escapes even inside single quotes) and csh all read it
/// back as `s`.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\'' => out.push_str(r"'\''"),
            '\\' => out.push_str(r"'\\'"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// A command for an SSH exec channel: `script` (POSIX sh) run by `sh`, whatever the account's
/// login shell is (fish and csh read the quoting the same way, see [`quote`]).
pub fn sh_c(script: &str) -> String {
    format!("sh -c {}", quote(script))
}

/// A path or name as one word that can't be read as an option: one starting with "-" gets "./".
fn arg(s: &str) -> String {
    if s.starts_with('-') {
        quote(&format!("./{s}"))
    } else {
        quote(s)
    }
}

/// The last part of a path, without a trailing slash.
fn name_of(path: &str) -> &str {
    let p = path.trim_end_matches(['/', '\\']);
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

/// (stem, extension) of a name: "photo.jpg" → ("photo", "jpg"); ".bashrc" and folders have none.
fn split_ext(name: &str, is_dir: bool) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if !is_dir && i > 0 && i + 1 < name.len() => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// Replaces `{word}` where `value(word)` has something. `${word}` is left to the shell.
fn substitute(template: &str, value: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let word_len = after.find(|c: char| !c.is_ascii_alphanumeric() && c != '_').unwrap_or(after.len());
        let closed = after[word_len..].starts_with('}');
        let shell_var = rest[..open].ends_with('$');
        match (closed && !shell_var).then(|| value(&after[..word_len])).flatten() {
            Some(v) => {
                out.push_str(&rest[..open]);
                out.push_str(&v);
                rest = &after[word_len + 1..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Whether the template names `{word}` as a placeholder (not `${word}`).
fn uses(template: &str, word: &str) -> bool {
    let needle = format!("{{{word}}}");
    template.match_indices(&needle).any(|(i, _)| !template[..i].ends_with('$'))
}

/// Every placeholder the template can hold.
const PLACEHOLDERS: [&str; 6] = ["path", "name", "ext", "stem", "paths", "dir"];

/// Refuses a template that puts a placeholder inside quotes of its own (`"{path}"`, `'{name}'`)
/// or backticks: the value is quoted already, and inside other quotes that quoting doesn't hold
/// (`"'$(cmd)'"` runs `cmd`). Read the way sh reads it; `$(…)` starts a fresh, unquoted context
/// even inside double quotes. The error names the placeholder.
pub fn check_template(template: &str) -> Result<(), String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Ctx {
        Plain,
        Single,
        Double,
        Backtick,
        /// `$( … )`, with how many plain `(` are open inside it
        Subst(u32),
    }
    let mut stack = vec![Ctx::Plain];
    let b = template.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let ctx = *stack.last().unwrap();
        let c = b[i];
        // a placeholder here (`${word}` is the shell's)
        if c == b'{' && !(i > 0 && b[i - 1] == b'$') {
            let rest = &template[i + 1..];
            if let Some(w) = PLACEHOLDERS.iter().find(|w| rest.starts_with(&format!("{w}}}"))) {
                if matches!(ctx, Ctx::Single | Ctx::Double) {
                    return Err(format!("{{{w}}} is inside quotes. Take the quotes away around it: Kybl quotes every placeholder itself, and inside other quotes a file name could run as a command."));
                }
                if stack.contains(&Ctx::Backtick) {
                    return Err(format!("{{{w}}} is inside backticks. Use $( … ) instead: inside backticks a file name could run as a command."));
                }
            }
        }
        match ctx {
            Ctx::Single => {
                if c == b'\'' {
                    stack.pop();
                }
            }
            Ctx::Double => match c {
                b'\\' => i += 1,
                b'"' => {
                    stack.pop();
                }
                b'`' => stack.push(Ctx::Backtick),
                b'$' if b.get(i + 1) == Some(&b'(') => {
                    stack.push(Ctx::Subst(0));
                    i += 1;
                }
                _ => {}
            },
            Ctx::Backtick => match c {
                b'\\' => i += 1,
                b'`' => {
                    stack.pop();
                }
                _ => {}
            },
            Ctx::Plain | Ctx::Subst(_) => match c {
                b'\\' => i += 1,
                b'\'' => stack.push(Ctx::Single),
                b'"' => stack.push(Ctx::Double),
                b'`' => stack.push(Ctx::Backtick),
                b'$' if b.get(i + 1) == Some(&b'(') => {
                    stack.push(Ctx::Subst(0));
                    i += 1;
                }
                b'(' => {
                    if let Some(Ctx::Subst(n)) = stack.last_mut() {
                        *n += 1;
                    }
                }
                b')' => match stack.last_mut() {
                    Some(Ctx::Subst(0)) => {
                        stack.pop();
                    }
                    Some(Ctx::Subst(n)) => *n -= 1,
                    _ => {}
                },
                _ => {}
            },
        }
        i += 1;
    }
    Ok(())
}

/// The command lines to run: one per item when the template uses `{path}`, `{name}`, `{ext}` or
/// `{stem}`, else one for all of them. `{paths}` is every item, `{dir}` the folder.
pub fn expand(template: &str, items: &[Item], dir: &str) -> Vec<String> {
    let paths = items.iter().map(|i| arg(&i.path)).collect::<Vec<_>>().join(" ");
    let common = |w: &str| match w {
        "paths" => Some(paths.clone()),
        "dir" => Some(arg(dir)),
        _ => None,
    };
    if !PER_ITEM.iter().any(|w| uses(template, w)) {
        return vec![substitute(template, common)];
    }
    items
        .iter()
        .map(|it| {
            let name = name_of(&it.path);
            let (stem, ext) = split_ext(name, it.is_dir);
            substitute(template, |w| match w {
                "path" => Some(arg(&it.path)),
                "name" => Some(arg(name)),
                "stem" => Some(arg(stem)),
                "ext" => Some(quote(ext)),
                _ => common(w),
            })
        })
        .collect()
}

// ---------------------------------------------------------------- output

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output<'a> {
    run_id: &'a str,
    /// "out", "err", or "note" (the app's own lines: truncation, the next command)
    stream: &'a str,
    text: &'a str,
}

/// Passes output on as events, whole UTF-8 characters only, up to [`OUTPUT_LIMIT`].
struct Sink<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    run_id: &'a str,
    sent: usize,
    truncated: bool,
    /// an unfinished UTF-8 character at the end of the last chunk, per stream
    carry: [Vec<u8>; 2],
}

impl<'a, R: Runtime> Sink<'a, R> {
    fn new(app: &'a AppHandle<R>, run_id: &'a str) -> Self {
        Self { app, run_id, sent: 0, truncated: false, carry: [Vec::new(), Vec::new()] }
    }

    fn note(&self, text: &str) {
        let _ = self.app.emit("custom-action-output", Output { run_id: self.run_id, stream: "note", text });
    }

    fn push(&mut self, stderr: bool, bytes: &[u8]) {
        if self.truncated {
            return;
        }
        let carry = &mut self.carry[stderr as usize];
        carry.extend_from_slice(bytes);
        let (text, keep) = utf8_prefix(carry);
        let mut text = text;
        if self.sent + text.len() > OUTPUT_LIMIT {
            let mut cut = OUTPUT_LIMIT.saturating_sub(self.sent);
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            self.truncated = true;
        }
        self.sent += text.len();
        if !text.is_empty() {
            let _ = self.app.emit("custom-action-output", Output { run_id: self.run_id, stream: if stderr { "err" } else { "out" }, text: &text });
        }
        *carry = keep;
        if self.truncated {
            self.note("\n[Output stopped at 1 MB. The command keeps running.]\n");
        }
    }
}

/// The text of the complete characters in `bytes`, and the bytes of an unfinished last one.
fn utf8_prefix(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) if e.error_len().is_none() && bytes.len() - e.valid_up_to() < 4 => {
            let (done, rest) = bytes.split_at(e.valid_up_to());
            (String::from_utf8_lossy(done).into_owned(), rest.to_vec())
        }
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), Vec::new()),
    }
}

// ---------------------------------------------------------------- running

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    /// also the key of its Stop flag (Activity's Stop button sends the same id)
    pub run_id: String,
    pub template: String,
    /// over SSH on the connection's server; else on this computer
    pub on_server: bool,
    pub profile_id: String,
    /// server runs: keys of the connection (made absolute here); local runs: absolute paths
    pub items: Vec<Item>,
    pub dir: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunEnd {
    /// the last failing command's exit status, else 0; None when it was stopped or killed
    pub code: Option<i32>,
    pub stopped: bool,
    pub truncated: bool,
    /// how many command lines ran (one per item, or one)
    pub commands: usize,
}

#[tauri::command]
pub async fn custom_action_run(app: AppHandle, state: State<'_, AppState>, spec: RunSpec) -> Result<RunEnd, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().await.insert(spec.run_id.clone(), cancel.clone());
    let r = run(&app, &state, &spec, &cancel).await;
    state.cancels.lock().await.remove(&spec.run_id);
    r
}

#[tauri::command]
pub async fn custom_action_stop(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().await.get(&run_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// What the template turns into for these items (the editor's preview).
#[tauri::command]
pub fn custom_action_preview(template: String, items: Vec<Item>, dir: String) -> Result<Vec<String>, String> {
    check_template(&template)?;
    Ok(expand(&template, &items, &dir))
}

async fn run<R: Runtime>(app: &AppHandle<R>, state: &AppState, spec: &RunSpec, cancel: &AtomicBool) -> Result<RunEnd, String> {
    let mut sink = Sink::new(app, &spec.run_id);
    check_template(&spec.template)?;
    let mut end = RunEnd { code: Some(0), ..Default::default() };
    if spec.on_server {
        let sftp = crate::storage::registry::open_sftp(app, state, &spec.profile_id).await?;
        let r = async {
            let mut items = Vec::with_capacity(spec.items.len());
            for it in &spec.items {
                items.push(Item { path: sftp.remote_path(&it.path).await?, is_dir: it.is_dir });
            }
            let dir = sftp.remote_path(&spec.dir).await?;
            let lines = expand(&spec.template, &items, &dir);
            for (i, line) in lines.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    end.stopped = true;
                    break;
                }
                if lines.len() > 1 {
                    sink.note(&format!("[{} of {}]\n", i + 1, lines.len()));
                }
                // in the folder on screen; nothing runs if it isn't there
                let r = sftp.exec(&format!("cd {} && {line}", quote(&dir)), cancel, |err, b| sink.push(err, b)).await?;
                end.commands += 1;
                if r.stopped {
                    end.stopped = true;
                    break;
                }
                match r.code {
                    Some(0) => {}
                    c => end.code = c.map(|c| c as i32),
                }
            }
            Ok::<_, crate::storage::StorageError>(())
        }
        .await;
        sftp.disconnect().await;
        r?;
    } else {
        let lines = expand(&spec.template, &spec.items, &spec.dir);
        for (i, line) in lines.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                end.stopped = true;
                break;
            }
            if lines.len() > 1 {
                sink.note(&format!("[{} of {}]\n", i + 1, lines.len()));
            }
            let (code, stopped) = local::run(line, &spec.dir, cancel, |err, b| sink.push(err, b)).await?;
            end.commands += 1;
            if stopped {
                end.stopped = true;
                break;
            }
            if code != Some(0) {
                end.code = code;
            }
        }
    }
    if end.stopped {
        end.code = None;
    }
    end.truncated = sink.truncated;
    Ok(end)
}

#[cfg(desktop)]
mod local {
    use std::{
        path::Path,
        process::Stdio,
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    use tokio::{io::AsyncReadExt, process::Command};

    /// The user's shell as a login shell (so PATH has Homebrew and the like, as in Terminal).
    #[cfg(unix)]
    fn shell(line: &str) -> Command {
        let sh = std::env::var("SHELL").ok().filter(|s| s.starts_with('/') && Path::new(s).exists()).unwrap_or_else(|| "/bin/sh".into());
        let mut c = Command::new(sh);
        c.args(["-l", "-c", line]);
        // its own process group, so Stop ends what it started too
        c.process_group(0);
        c
    }

    /// Windows: the sh that Git for Windows installs (the quoting is POSIX).
    #[cfg(windows)]
    fn shell(line: &str) -> Command {
        let mut c = Command::new("sh");
        c.args(["-c", line]);
        c
    }

    #[cfg(unix)]
    fn signal(child: &tokio::process::Child, sig: i32) {
        if let Some(pid) = child.id() {
            // SAFETY: plain syscall on the group the shell leads
            unsafe { libc::killpg(pid as i32, sig) };
        }
    }

    fn terminate(child: &mut tokio::process::Child, hard: bool) {
        #[cfg(unix)]
        signal(child, if hard { libc::SIGKILL } else { libc::SIGTERM });
        #[cfg(not(unix))]
        let _ = hard;
        if hard || cfg!(not(unix)) {
            let _ = child.start_kill();
        }
    }

    /// Stop asked: SIGTERM to the group, SIGKILL two seconds later.
    fn check(child: &mut tokio::process::Child, cancel: &AtomicBool, stopped_at: &mut Option<tokio::time::Instant>) {
        if !cancel.load(Ordering::Relaxed) {
            return;
        }
        match *stopped_at {
            None => {
                *stopped_at = Some(tokio::time::Instant::now());
                terminate(child, false);
            }
            Some(t) if t.elapsed() > Duration::from_secs(2) => terminate(child, true),
            Some(_) => {}
        }
    }

    /// Runs one command line in `dir`: (exit code, stopped).
    pub async fn run(line: &str, dir: &str, cancel: &AtomicBool, mut on_data: impl FnMut(bool, &[u8])) -> Result<(Option<i32>, bool), String> {
        let mut cmd = shell(line);
        if !dir.is_empty() && Path::new(dir).is_dir() {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the shell. {e}"))?;
        let mut out = child.stdout.take().expect("piped");
        let mut err = child.stderr.take().expect("piped");
        let (mut ob, mut eb) = (vec![0u8; 16 * 1024], vec![0u8; 16 * 1024]);
        let (mut out_open, mut err_open) = (true, true);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        let mut stopped_at: Option<tokio::time::Instant> = None;
        while out_open || err_open {
            tokio::select! {
                r = out.read(&mut ob), if out_open => match r {
                    Ok(0) | Err(_) => out_open = false,
                    Ok(n) => on_data(false, &ob[..n]),
                },
                r = err.read(&mut eb), if err_open => match r {
                    Ok(0) | Err(_) => err_open = false,
                    Ok(n) => on_data(true, &eb[..n]),
                },
                _ = tick.tick() => {
                    check(&mut child, cancel, &mut stopped_at);
                    // stopped and the pipes still open after a while (something kept them): leave
                    if stopped_at.is_some_and(|t| t.elapsed() > Duration::from_secs(4)) {
                        break;
                    }
                }
            }
        }
        let status = loop {
            tokio::select! {
                s = child.wait() => break s.map_err(|e| e.to_string())?,
                _ = tick.tick() => check(&mut child, cancel, &mut stopped_at),
            }
        };
        Ok((status.code(), stopped_at.is_some()))
    }
}

#[cfg(not(desktop))]
mod local {
    use std::sync::atomic::AtomicBool;

    pub async fn run(_line: &str, _dir: &str, _cancel: &AtomicBool, _on_data: impl FnMut(bool, &[u8])) -> Result<(Option<i32>, bool), String> {
        Err("Actions run on a computer.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(p: &str) -> Item {
        Item { path: p.into(), is_dir: p.ends_with('/') }
    }

    /// What `sh` makes of a command line: its words, one per line (needs /bin/sh).
    #[cfg(unix)]
    fn words(line: &str) -> Vec<String> {
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(format!("for w in {line}; do printf '%s\\0' \"$w\"; done")).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().split_terminator('\0').map(String::from).collect()
    }

    const NASTY: [&str; 9] = [
        "/tmp/a b.jpg",
        "/tmp/it's.jpg",
        "/tmp/$(touch pwned).jpg",
        "/tmp/`id`.jpg",
        "/tmp/new\nline.jpg",
        "/tmp/semi;colon&amp|pipe>out.jpg",
        "/tmp/'\"'\"mixed\\back.jpg",
        "/tmp/${HOME}*?[x].jpg",
        "/tmp/é ü 漢字.jpg",
    ];

    #[test]
    fn quote_wraps_in_single_quotes() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote(""), "''");
        // a backslash never sits inside the quotes (fish reads `\'` there as a quote)
        assert_eq!(quote(r"a\b"), r"'a'\\'b'");
        assert_eq!(quote(r"\'; touch x; echo \"), r"''\\''\''; touch x; echo '\\''");
    }

    /// Between the single quotes there is never a quote or a backslash, so fish, csh and POSIX
    /// shells all end the word where it ends.
    #[test]
    fn quoted_text_holds_nothing_any_shell_reads() {
        for p in NASTY.iter().copied().chain([r"\'; cd; touch pwned; echo \", r"x\\'\"]) {
            let q = quote(p);
            let mut inside = false;
            let mut chars = q.chars();
            while let Some(c) = chars.next() {
                match (inside, c) {
                    (false, '\'') | (true, '\'') => inside = !inside,
                    (false, '\\') => assert!(matches!(chars.next(), Some('\\' | '\'')), "{q}"),
                    (true, '\\') => panic!("backslash inside quotes: {q}"),
                    (false, c) => panic!("{c:?} outside quotes: {q}"),
                    _ => {}
                }
            }
            assert!(!inside, "{q}");
        }
    }

    /// The real fish, when installed: what it reads back is the name.
    #[cfg(unix)]
    #[test]
    fn fish_reads_the_quoting_back() {
        let Some(fish) = ["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"].into_iter().find(|p| std::path::Path::new(p).exists()) else { return };
        for p in NASTY.iter().copied().chain([r"\'; touch /tmp/kybl-fish-pwned; echo \"]) {
            let out = std::process::Command::new(fish).arg("-c").arg(format!("printf %s {}", quote(p))).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), p);
        }
        assert!(!std::path::Path::new("/tmp/kybl-fish-pwned").exists());
    }

    #[test]
    fn placeholders_inside_quotes_are_refused() {
        for bad in [r#"convert "{path}" out.png"#, "echo '{name}'", r#"echo "a {paths} b""#, "echo `basename {path}`", r#"x "$(echo `y {dir}`)""#, r#"echo "it's {stem}""#] {
            assert!(check_template(bad).is_err(), "{bad}");
        }
        for ok in [
            "convert {path} out.png",
            r#"echo "$(basename {path})""#,
            "awk '{print $1}' {path}",
            r#"echo "${path}" {name}"#,
            r#"echo "a" {path} 'b'"#,
            r#"echo \"{path}\""#,
            "echo $( (cd {dir}) ) {path}",
            r#"echo "{unknown}" {ext}"#,
        ] {
            assert!(check_template(ok).is_ok(), "{ok}");
        }
        assert!(check_template(r#"x "{path}""#).unwrap_err().starts_with("{path} is inside quotes"));
    }

    #[cfg(unix)]
    #[test]
    fn nasty_names_stay_one_word_each() {
        for p in NASTY {
            assert_eq!(words(&quote(p)), vec![p.to_string()], "{p:?}");
        }
        // all of them at once, as {paths}
        let items: Vec<Item> = NASTY.iter().map(|p| item(p)).collect();
        let line = expand("{paths}", &items, "/tmp");
        assert_eq!(words(&line[0]), NASTY.to_vec());
    }

    #[cfg(unix)]
    #[test]
    fn nothing_in_a_name_runs() {
        let dir = std::env::temp_dir().join(format!("kybl-actions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("pwned");
        let evil = format!("{}/$(touch {})`touch {}`;touch {}.jpg", dir.display(), marker.display(), marker.display(), marker.display());
        for line in expand("printf '%s' {path} {name} {stem} {ext} {dir} {paths} >/dev/null", &[item(&evil)], &evil) {
            let st = std::process::Command::new("/bin/sh").arg("-c").arg(&line).status().unwrap();
            assert!(st.success());
        }
        assert!(!marker.exists(), "a file name ran as a command");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn leading_dashes_get_dot_slash() {
        let it = [item("-rf"), item("/abs/-x.txt")];
        assert_eq!(expand("rm {path}", &it, "/d"), vec!["rm './-rf'", "rm '/abs/-x.txt'"]);
        assert_eq!(expand("echo {name}", &it, "/d"), vec!["echo './-rf'", "echo './-x.txt'"]);
        assert_eq!(expand("echo {stem}", &[item("/a/--help.md")], "/d"), vec!["echo './--help'"]);
        assert_eq!(expand("cd {dir}", &[], "-dir"), vec!["cd './-dir'"]);
    }

    #[test]
    fn per_item_placeholders_run_once_per_item() {
        let it = [item("/p/photo.final.JPG"), item("/p/sub/"), item("/p/.bashrc")];
        assert_eq!(
            expand("x {name} {stem} {ext}", &it, "/p"),
            vec!["x 'photo.final.JPG' 'photo.final' 'JPG'", "x 'sub' 'sub' ''", "x '.bashrc' '.bashrc' ''"]
        );
        assert_eq!(expand("sips -Z 2048 {path}", &it[..1], "/p"), vec!["sips -Z 2048 '/p/photo.final.JPG'"]);
    }

    #[test]
    fn all_items_placeholders_run_once() {
        let it = [item("/p/a.txt"), item("/p/b c.txt")];
        assert_eq!(expand("shasum -a 256 {paths}", &it, "/p"), vec!["shasum -a 256 '/p/a.txt' '/p/b c.txt'"]);
        assert_eq!(expand("ls {dir}", &it, "/p q"), vec!["ls '/p q'"]);
        assert_eq!(expand("date", &it, "/p"), vec!["date"]);
        // {paths} next to a per-item one: every item each time
        assert_eq!(expand("cmp {path} {paths}", &it, "/p").len(), 2);
    }

    #[test]
    fn shell_braces_and_unknown_words_are_left_alone() {
        let it = [item("/p/a.txt")];
        assert_eq!(expand("echo ${path} {unknown} {} {path", &it, "/p"), vec!["echo ${path} {unknown} {} {path"]);
        assert_eq!(expand("awk '{print $1}' {path}", &it, "/p"), vec!["awk '{print $1}' '/p/a.txt'"]);
        assert_eq!(expand("echo {{path}}", &it, "/p"), vec!["echo {'/p/a.txt'}"]);
    }

    #[test]
    fn windows_paths_name_too() {
        assert_eq!(name_of(r"C:\Users\me\file.txt"), "file.txt");
        assert_eq!(name_of("/a/b/"), "b");
    }

    #[test]
    fn utf8_split_across_chunks_waits_for_the_rest() {
        let s = "ž".as_bytes();
        let (t, keep) = utf8_prefix(&[b'a', s[0]]);
        assert_eq!((t.as_str(), keep.as_slice()), ("a", &s[..1]));
        let (t, keep) = utf8_prefix(&[s[0], s[1]]);
        assert_eq!((t.as_str(), keep.len()), ("ž", 0));
        // invalid bytes don't hold anything back
        let (t, keep) = utf8_prefix(&[0xff, b'x']);
        assert_eq!((t.as_str(), keep.len()), ("\u{fffd}x", 0));
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn local_runs_stream_and_stop() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let cancel = AtomicBool::new(false);
            let mut out = Vec::new();
            let (code, stopped) = local::run("printf hi; printf oops >&2; exit 3", "/", &cancel, |e, b| out.push((e, b.to_vec()))).await.unwrap();
            assert_eq!((code, stopped), (Some(3), false));
            assert!(out.contains(&(false, b"hi".to_vec())) && out.contains(&(true, b"oops".to_vec())));

            let cancel = Arc::new(AtomicBool::new(false));
            let c2 = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                c2.store(true, Ordering::Relaxed);
            });
            let t = std::time::Instant::now();
            let (code, stopped) = local::run("sleep 30; echo late", "/", &cancel, |_, _| {}).await.unwrap();
            assert!(stopped && code.is_none() && t.elapsed() < std::time::Duration::from_secs(5));
        });
    }
}
