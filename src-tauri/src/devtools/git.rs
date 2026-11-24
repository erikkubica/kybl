//! Git awareness for this computer's folders: the branch and each item's status, read from the
//! user's own `git` (`status --porcelain=v2`). Nothing happens when git isn't installed or the
//! folder isn't in a work tree.
//!
//! Big repositories: every run is time-boxed. When the whole repository's status doesn't come
//! back in time, the status of just the folder on screen is asked for (and the repository is
//! remembered as slow for a few minutes, then tried whole again); when even that is too slow,
//! only the branch shows. Answers are cached per repository for a moment, so several panes (and
//! quick refreshes) share one run.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;

use super::tools::{command, find_tool, run_capture, RunError};

/// How long one git run may take.
const TIME_BOX: Duration = Duration::from_millis(1500);
/// A repository whose whole status took too long is asked about whole again after this (the
/// first run after boot or wake is often slow only because nothing is cached yet).
const SLOW_RETRY: Duration = Duration::from_secs(300);
/// An answer this fresh is reused.
const FRESH: Duration = Duration::from_millis(1200);
/// More changed or ignored paths than this are left out (the marks then show what fits).
const MAX_CHANGES: usize = 20_000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Conflicted,
    Untracked,
    Ignored,
}

/// One path git reports, below the folder asked about (folders end with `/`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub kind: GitKind,
    /// the change is in the index (staged)
    pub staged: bool,
    /// the work tree differs from the index
    pub unstaged: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// the branch checked out; None when detached (then `commit` says where)
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// paths below the folder, relative to it
    pub changes: Vec<GitChange>,
    /// the folder itself sits in an ignored or untracked folder: everything in it is that
    pub inside: Option<GitKind>,
    /// the statuses are missing or cover only part of the repository (it is too big to check in time)
    pub partial: bool,
}

/// What `git status --porcelain=v2 -z --branch` says, paths relative to the repository's top.
#[derive(Debug, Default, Clone)]
pub struct Porcelain {
    pub head: Option<String>,
    pub oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<(String, GitKind, bool, bool)>,
}

pub fn parse_porcelain_v2(buf: &[u8]) -> Porcelain {
    let mut p = Porcelain::default();
    let mut recs = buf.split(|b| *b == 0).map(|r| String::from_utf8_lossy(r).into_owned());
    while let Some(rec) = recs.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.head" if v != "(detached)" => p.head = Some(v.to_string()),
                "branch.oid" if v != "(initial)" => p.oid = Some(v.to_string()),
                "branch.ab" => {
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            p.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            p.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let (tag, rest) = rec.split_at(1);
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        let entry = match tag {
            "1" => rest.splitn(8, ' ').collect::<Vec<_>>().split_last().and_then(|(path, f)| Some((f.first()?.to_string(), path.to_string()))).map(|(xy, path)| (path, ordinary(&xy), xy)),
            "2" => {
                // a rename or copy: its old path comes as the next record
                let _orig = recs.next();
                rest.splitn(9, ' ').collect::<Vec<_>>().split_last().and_then(|(path, f)| Some((f.first()?.to_string(), path.to_string()))).map(|(xy, path)| (path, GitKind::Renamed, xy))
            }
            "u" => rest.splitn(10, ' ').collect::<Vec<_>>().split_last().and_then(|(path, f)| Some((f.first()?.to_string(), path.to_string()))).map(|(xy, path)| (path, GitKind::Conflicted, xy)),
            "?" => Some((rest.to_string(), GitKind::Untracked, "..".into())),
            "!" => Some((rest.to_string(), GitKind::Ignored, "..".into())),
            _ => None,
        };
        if let Some((path, kind, xy)) = entry {
            if p.entries.len() >= MAX_CHANGES {
                continue;
            }
            let b = xy.as_bytes();
            let (staged, unstaged) = match kind {
                GitKind::Untracked | GitKind::Ignored => (false, false),
                GitKind::Conflicted => (true, true),
                _ => (b.first().is_some_and(|c| *c != b'.'), b.get(1).is_some_and(|c| *c != b'.')),
            };
            p.entries.push((path, kind, staged, unstaged));
        }
    }
    p
}

/// An ordinary changed entry's kind from its XY letters (index, then work tree).
fn ordinary(xy: &str) -> GitKind {
    let b = xy.as_bytes();
    let (x, y) = (b.first().copied().unwrap_or(b'.'), b.get(1).copied().unwrap_or(b'.'));
    if x == b'A' {
        GitKind::Added
    } else if x == b'D' || y == b'D' {
        GitKind::Deleted
    } else if x == b'R' || x == b'C' {
        GitKind::Renamed
    } else {
        GitKind::Modified
    }
}

/// The changes inside folder `dir` (relative to the top, "" or ending with `/`), relative to it.
pub fn scope(p: &Porcelain, dir: &str) -> (Vec<GitChange>, Option<GitKind>) {
    let mut out = Vec::new();
    let mut inside = None;
    for (path, kind, staged, unstaged) in &p.entries {
        if let Some(rel) = path.strip_prefix(dir).filter(|r| !r.is_empty()) {
            out.push(GitChange { path: rel.to_string(), kind: *kind, staged: *staged, unstaged: *unstaged });
            continue;
        }
        // a folder above (or the folder itself) that is ignored or untracked as a whole
        if path.ends_with('/') && dir.starts_with(path.as_str()) && matches!(kind, GitKind::Ignored | GitKind::Untracked) {
            inside = Some(*kind);
        }
    }
    (out, inside)
}

// ---------------------------------------------------------------- running git

struct Repo {
    top: PathBuf,
    /// the folder asked about, relative to `top` ("" or ending with `/`)
    prefix: String,
}

struct Cached {
    at: Instant,
    /// the folder (relative to the top) a scoped run covered; None: the whole repository
    scoped: Option<String>,
    status: Arc<Porcelain>,
}

#[derive(Default)]
struct Caches {
    /// folder → its repository (None: not in one), with when that was found
    repos: HashMap<PathBuf, (Instant, Option<(PathBuf, String)>)>,
    status: HashMap<PathBuf, Cached>,
    /// repositories whose whole status took too long, and when
    slow: HashMap<PathBuf, Instant>,
}

impl Caches {
    /// Whether to skip the whole-repository run for `top` now.
    fn is_slow(&self, top: &Path, now: Instant) -> bool {
        self.slow.get(top).is_some_and(|at| now.duration_since(*at) < SLOW_RETRY)
    }
}

fn caches() -> &'static Mutex<Caches> {
    static C: OnceLock<Mutex<Caches>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// A hooks folder that can't hold anything.
const NO_HOOKS: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

fn git(git: &Path) -> Command {
    let mut c = command(git);
    // reading the status never takes the index lock away from the user's own git, never asks for
    // anything, and never runs the fsmonitor or a hook a repository names (a folder on screen can
    // be one the user just downloaded: its `.git/config` is not to be trusted)
    // It never talks to a remote either: a partial clone fetches missing objects from its
    // "promisor" remote while reading the status, through the repository's own `core.sshCommand`,
    // credential helper or `ext::` command. No lazy fetch (git 2.44+), and no transport allowed at
    // all (the env list wins over every `protocol.*.allow` in the repository's config).
    c.env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "kybl-none")
        .arg("--no-optional-locks")
        .arg("--literal-pathspecs");
    for (k, v) in [("core.fsmonitor", "false"), ("core.hooksPath", NO_HOOKS), ("core.untrackedCache", "false"), ("credential.helper", "")] {
        c.arg("-c").arg(format!("{k}={v}"));
    }
    c
}

/// Settings in the repository's own config that the user's filter program of the same name
/// reads without running anything (git-lfs writes `lfs.repositoryformatversion` into every
/// repository it touches, and `lfs.<url>.access` after a sign-in).
const HARMLESS_FILTER_KEYS: [&str; 7] = ["repositoryformatversion", "access", "locksverify", "url", "pushurl", "fetchinclude", "fetchexclude"];

/// Whether `scope` is the repository's own config (or a file it includes): not to be trusted.
fn repo_scope(scope: &str) -> bool {
    matches!(scope, "local" | "worktree")
}

/// The `-c` settings that switch off every program the repository's own config (and the files it
/// includes) names for git to run: filter drivers (`clean`/`process` run while reading the status
/// for files whose timestamps changed), diff and merge drivers.
///
/// The user's own (global/system) filter drivers stay on, or every file in an LFS repository whose
/// timestamp changed would show as modified. A repository can't change what they run, but a
/// driver program can read the repository's config itself and run what it names there (git-lfs:
/// `lfs.extension.<name>.clean`). Such a program reads settings under its own name, so a user's
/// filter `X` is switched off as well when the repository's config sets anything under `X.` (or
/// under `filter.X.`) beyond [`HARMLESS_FILTER_KEYS`]. (git-lfs's in-tree `.lfsconfig` is limited
/// to URL and fetch settings by git-lfs itself.) None: a name that can't be overridden safely, so
/// git is not run there at all.
fn repo_overrides(names: &[(String, String)]) -> Option<Vec<String>> {
    // sections the repository's own config sets something risky in, lower case
    let repo_sections: HashSet<String> = names
        .iter()
        .filter(|(scope, _)| repo_scope(scope))
        .filter(|(_, name)| !name.rsplit('.').next().is_some_and(|k| HARMLESS_FILTER_KEYS.contains(&k.to_ascii_lowercase().as_str())))
        .filter_map(|(_, name)| name.split_once('.').map(|(s, _)| s.to_ascii_lowercase()))
        .collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (scope, name) in names {
        // git prints the section and key in lower case and the sub-section as written
        let Some((section, rest)) = name.split_once('.') else { continue };
        let Some((sub, _key)) = rest.rsplit_once('.') else { continue };
        let section = section.to_ascii_lowercase();
        // the user's own (global/system) drivers are trusted (status runs no diff or merge
        // driver), unless the repository configures the filter's own program
        if !repo_scope(scope) && (section != "filter" || !repo_sections.contains(&sub.to_ascii_lowercase())) {
            continue;
        }
        let keys: &[&str] = match section.as_str() {
            "filter" => &["clean", "smudge", "process"],
            "diff" => &["textconv", "command"],
            "merge" => &["driver"],
            _ => continue,
        };
        // `-c` splits at the first '=': a sub-section holding one (or a control character)
        // couldn't be addressed, so the repository is skipped instead
        if sub.is_empty() || sub.contains('=') || sub.chars().any(char::is_control) {
            return None;
        }
        if !seen.insert((section.clone(), sub.to_string())) {
            continue;
        }
        for k in keys {
            out.push(format!("{section}.{sub}.{k}="));
        }
        if section == "filter" {
            out.push(format!("filter.{sub}.required=false"));
        }
    }
    Some(out)
}

/// The repository's own config names as (scope, name), read without running anything; None when
/// git can't say (older than 2.26, no `--show-scope`), in which case the status isn't read.
fn repo_config_names(bin: &Path, top: &Path) -> Option<Vec<(String, String)>> {
    let mut c = git(bin);
    c.arg("-C").arg(top).args(["config", "--list", "--name-only", "-z", "--show-scope", "--includes"]);
    let (st, out) = run_capture(c, TIME_BOX).ok()?;
    if !st.success() {
        return None;
    }
    let parts: Vec<String> = out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
    if parts.len() % 2 != 0 {
        return None;
    }
    Some(parts.chunks(2).map(|p| (p[0].clone(), p[1].clone())).collect())
}

/// `git -C top` with every program the repository could name switched off; None when that can't
/// be made sure of (git then isn't run there).
fn git_in(bin: &Path, top: &Path) -> Option<Command> {
    let names = repo_config_names(bin, top)?;
    let mut c = git(bin);
    for o in repo_overrides(&names)? {
        c.arg("-c").arg(o);
    }
    c.arg("-C").arg(top);
    Some(c)
}

fn find_repo(bin: &Path, dir: &Path) -> Option<Repo> {
    {
        let c = caches().lock().unwrap();
        if let Some((at, r)) = c.repos.get(dir) {
            let ttl = if r.is_some() { Duration::from_secs(60) } else { Duration::from_secs(8) };
            if at.elapsed() < ttl {
                return r.clone().map(|(top, prefix)| Repo { top, prefix });
            }
        }
    }
    let mut c = git(bin);
    c.arg("-C").arg(dir).args(["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--show-prefix"]);
    let found = match run_capture(c, TIME_BOX) {
        Ok((st, out)) if st.success() => {
            let text = String::from_utf8_lossy(&out).into_owned();
            let mut lines = text.lines();
            match (lines.next(), lines.next()) {
                (Some("true"), Some(top)) if !top.is_empty() => Some((PathBuf::from(top), lines.next().unwrap_or("").to_string())),
                _ => None,
            }
        }
        _ => None,
    };
    caches().lock().unwrap().repos.insert(dir.to_path_buf(), (Instant::now(), found.clone()));
    found.map(|(top, prefix)| Repo { top, prefix })
}

fn run_status(bin: &Path, top: &Path, scoped: Option<&str>) -> Result<Porcelain, RunError> {
    // None: the repo's config names something that can't be safely turned off: no status
    let mut c = git_in(bin, top).ok_or(RunError::Failed)?;
    // submodules have config of their own, not read above: they're left alone
    c.args(["status", "--porcelain=v2", "-z", "--branch", "--ignored=matching", "--untracked-files=normal", "--ignore-submodules=all"]);
    if let Some(dir) = scoped {
        c.arg("--").arg(dir);
    }
    match run_capture(c, TIME_BOX)? {
        (st, out) if st.success() => Ok(parse_porcelain_v2(&out)),
        _ => Err(RunError::Failed),
    }
}

/// Just the branch, for a repository too big to read the status of in time.
fn branch_only(bin: &Path, top: &Path) -> Porcelain {
    let Some(mut c) = git_in(bin, top) else { return Porcelain::default() };
    c.args(["rev-parse", "--abbrev-ref", "HEAD"]);
    let head = run_capture(c, TIME_BOX).ok().filter(|(st, _)| st.success()).map(|(_, o)| String::from_utf8_lossy(&o).trim().to_string());
    Porcelain { head: head.filter(|h| !h.is_empty() && h != "HEAD"), ..Default::default() }
}

/// The git status of folder `dir` on this computer; None when git is missing or `dir` isn't in
/// a work tree. Blocks for up to a few seconds: call it off the async runtime.
pub fn status_of(dir: &Path, force: bool) -> Option<GitInfo> {
    let bin = find_tool("git")?;
    let repo = find_repo(&bin, dir)?;
    let now = Instant::now();
    let cached = {
        let c = caches().lock().unwrap();
        c.status
            .get(&repo.top)
            .filter(|x| !force || now.duration_since(x.at) < Duration::from_millis(250))
            .filter(|x| now.duration_since(x.at) < FRESH && x.scoped.as_deref().is_none_or(|s| repo.prefix.starts_with(s)))
            .map(|x| (x.status.clone(), x.scoped.is_some()))
    };
    let (status, partial) = match cached {
        Some(hit) => hit,
        None => {
            let slow = caches().lock().unwrap().is_slow(&repo.top, now);
            let whole = if slow {
                None
            } else {
                match run_status(&bin, &repo.top, None) {
                    Ok(st) => {
                        caches().lock().unwrap().slow.remove(&repo.top);
                        Some(st)
                    }
                    // only running out of time makes it slow; any other failure is this run's
                    Err(RunError::TimedOut) => {
                        caches().lock().unwrap().slow.insert(repo.top.clone(), Instant::now());
                        None
                    }
                    Err(_) => None,
                }
            };
            let (st, scoped) = match whole {
                Some(st) => (Some(st), None),
                None => {
                    if repo.prefix.is_empty() {
                        (None, None)
                    } else {
                        (run_status(&bin, &repo.top, Some(&repo.prefix)).ok(), Some(repo.prefix.clone()))
                    }
                }
            };
            match st {
                Some(st) => {
                    let st = Arc::new(st);
                    caches().lock().unwrap().status.insert(repo.top.clone(), Cached { at: Instant::now(), scoped: scoped.clone(), status: st.clone() });
                    (st, scoped.is_some())
                }
                None => (Arc::new(branch_only(&bin, &repo.top)), true),
            }
        }
    };
    let (changes, inside) = scope(&status, &repo.prefix);
    Some(GitInfo {
        branch: status.head.clone(),
        commit: status.oid.as_ref().map(|o| o.chars().take(7).collect()),
        ahead: status.ahead,
        behind: status.behind,
        changes,
        inside,
        partial,
    })
}

/// One commit, as the info panel lists it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// the abbreviated hash
    pub hash: String,
    /// when it was committed (Unix seconds)
    pub time: i64,
    pub author: String,
    pub subject: String,
}

/// What the info panel shows about a repository beyond the status: where it tracks and when it
/// was last fetched, where it lives, the recent commits, and the little facts (tag, stashes).
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// the tracking branch ("origin/main"); None without one
    pub upstream: Option<String>,
    /// when the repository last fetched (Unix seconds, from FETCH_HEAD's age); None if never
    pub fetched_at: Option<i64>,
    /// the remote's address with any credentials removed ("github.com/owner/repo")
    pub remote: Option<String>,
    /// the newest commits of HEAD, newest first
    pub commits: Vec<Commit>,
    /// the nearest tag behind HEAD
    pub tag: Option<String>,
    pub stashes: u32,
}

/// Fields of a commit line are split by the unit separator and lines by NUL (`log -z`), so
/// nothing a subject can say (quotes, tabs, newlines) shifts one record into the next. The
/// subject goes last: a stray separator in it can't move the others.
const COMMIT_FORMAT: &str = "--format=%h%x1f%ct%x1f%an%x1f%s";

fn parse_commits(buf: &[u8]) -> Vec<Commit> {
    buf.split(|b| *b == 0)
        .filter_map(|rec| {
            let text = String::from_utf8_lossy(rec);
            // `-z` leaves the newline between records out, but be forgiving of one
            let mut parts = text.trim_start_matches('\n').splitn(4, '\x1f');
            let (hash, time, author, subject) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
            let time = time.parse().ok()?;
            (!hash.is_empty()).then(|| Commit { hash: hash.to_string(), time, author: author.to_string(), subject: subject.trim_end().to_string() })
        })
        .collect()
}

/// A remote's address made safe to show: no `user:password@` or `user@`, no scheme, no `.git`,
/// no query. `git@host:owner/repo.git` and `https://token@host/owner/repo.git` both become
/// "host/owner/repo". The cleaning only ever removes text.
fn clean_remote(url: &str) -> String {
    let url = url.trim();
    let rest = if let Some((_, rest)) = url.split_once("://") {
        // The userinfo is cut off first, on the whole text: a password may hold an unencoded
        // `?`, `#` or `/`, and cutting at those first would leave part of it showing. It ends at
        // the last `@` of the authority (up to the first slash); when a slash inside the
        // password hides that `@`, the last `@` anywhere is used, which can only remove more.
        let authority = rest.split('/').next().unwrap_or(rest);
        let after = match authority.rfind('@') {
            Some(i) => &rest[i + 1..],
            None => rest.rfind('@').map_or(rest, |i| &rest[i + 1..]),
        };
        // a query or fragment could be a token and is never part of the address
        after.split(['?', '#']).next().unwrap_or("").to_string()
    } else if let Some((front, path)) = url.split_once(':').filter(|(front, _)| !front.contains('/') && !front.is_empty()) {
        // scp-like `[user@]host:path`
        let host = front.rsplit_once('@').map_or(front, |(_, h)| h);
        let path = path.split(['?', '#']).next().unwrap_or("");
        format!("{host}/{}", path.trim_start_matches('/'))
    } else {
        url.split(['?', '#']).next().unwrap_or("").to_string()
    };
    let rest = rest.trim_end_matches('/');
    rest.strip_suffix(".git").unwrap_or(rest).to_string()
}

/// A file path from the panel, relative to the folder, made safe to hand to git: not empty, not
/// absolute, never leaving the folder (`..`), no NUL, no drive letter.
fn safe_relative(file: &str) -> bool {
    !file.is_empty()
        && !file.contains('\0')
        && !file.starts_with('/')
        && !file.starts_with('\\')
        && !file.split(['/', '\\']).any(|c| c == "..")
        && file.as_bytes().get(1) != Some(&b':')
}

/// One hardened git run in the repository; its standard output when it succeeded.
fn run_in(bin: &Path, top: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut c = git_in(bin, top)?;
    c.args(args);
    let (st, out) = run_capture(c, TIME_BOX).ok()?;
    st.success().then_some(out)
}

fn text_of(out: Option<Vec<u8>>) -> Option<String> {
    let t = String::from_utf8_lossy(&out?).trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// When the repository last fetched: the age of its FETCH_HEAD (Unix seconds).
fn fetched_at(bin: &Path, top: &Path) -> Option<i64> {
    let dir = text_of(run_in(bin, top, &["rev-parse", "--git-dir"]))?;
    // the answer is relative to `top` unless it is absolute (join keeps an absolute one)
    let meta = std::fs::metadata(top.join(dir).join("FETCH_HEAD")).ok()?;
    i64::try_from(meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs()).ok()
}

/// The remote's cleaned address: origin's, else the first remote's.
fn remote_of(bin: &Path, top: &Path) -> Option<String> {
    let names = text_of(run_in(bin, top, &["remote"]))?;
    let name = names.lines().find(|n| *n == "origin").or_else(|| names.lines().next())?;
    let url = text_of(run_in(bin, top, &["remote", "get-url", "--", name]))?;
    let clean = clean_remote(&url);
    (!clean.is_empty()).then_some(clean)
}

/// The overview of the repository folder `dir` is in. None when git is missing or `dir` isn't in
/// a work tree. Every run is time-boxed and none talks to a remote. Blocks for a moment: call it
/// off the async runtime. The selected file's last commit is a separate, single run
/// (`file_commit_of`), so moving between files doesn't redo all of this.
pub fn overview_of(dir: &Path) -> Option<Overview> {
    let bin = find_tool("git")?;
    let repo = find_repo(&bin, dir)?;
    let top = repo.top.as_path();
    let run = |args: &[&str]| run_in(&bin, top, args);
    let commits = run(&["log", "-10", "--no-show-signature", "-z", COMMIT_FORMAT, "HEAD", "--"]).map(|o| parse_commits(&o)).unwrap_or_default();
    // `describe` walks the whole history when it finds no tag, which is slow on a big repository:
    // it is only asked when a tag exists at all, and looks at few candidates
    let has_tags = text_of(run(&["for-each-ref", "--count=1", "--format=x", "refs/tags"])).is_some();
    let tag = if has_tags { text_of(run(&["describe", "--tags", "--abbrev=0", "--candidates=10"])) } else { None };
    Some(Overview {
        upstream: text_of(run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])),
        fetched_at: fetched_at(&bin, top),
        remote: remote_of(&bin, top),
        commits,
        tag,
        stashes: text_of(run(&["rev-list", "--walk-reflogs", "--count", "refs/stash"])).and_then(|n| n.parse().ok()).unwrap_or(0),
    })
}

/// The last commit that touched `file` (a file of the folder `dir` is in, relative to it); one
/// git run. None when git is missing, `dir` isn't in a work tree, or git doesn't know the file.
pub fn file_commit_of(dir: &Path, file: &str) -> Option<Commit> {
    if !safe_relative(file) {
        return None;
    }
    let bin = find_tool("git")?;
    let repo = find_repo(&bin, dir)?;
    // literal, so a file named like a pathspec magic (":(top)x") is just a file
    let path = format!("{}{file}", repo.prefix);
    let out = run_in(&bin, repo.top.as_path(), &["--literal-pathspecs", "log", "-1", "--no-show-signature", "-z", COMMIT_FORMAT, "HEAD", "--", &path])?;
    parse_commits(&out).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_commit_records() {
        let c = parse_commits(b"abc1234\x1f1700000000\x1fAda L\x1fFix \"the\" thing\ttoo\0def5678\x1f1699999999\x1fBob\x1fa\x1fb\0");
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].hash.as_str(), c[0].time, c[0].author.as_str(), c[0].subject.as_str()), ("abc1234", 1_700_000_000, "Ada L", "Fix \"the\" thing\ttoo"));
        // a stray separator stays in the subject
        assert_eq!(c[1].subject, "a\x1fb");
        assert!(parse_commits(b"").is_empty());
        assert!(parse_commits(b"abc\x1fsoon\x1fx\x1fy\0").is_empty());
        assert!(parse_commits(b"garbage\0").is_empty());
    }

    #[test]
    fn remotes_show_no_credentials() {
        for (url, want) in [
            ("https://github.com/owner/repo.git", "github.com/owner/repo"),
            ("https://user:s3cret@github.com/owner/repo.git", "github.com/owner/repo"),
            ("https://ghp_token@github.com/owner/repo", "github.com/owner/repo"),
            ("http://u:p%40ss@host:8080/a/b.git/", "host:8080/a/b"),
            ("git@github.com:owner/repo.git", "github.com/owner/repo"),
            ("host.example:owner/repo", "host.example/owner/repo"),
            ("ssh://git@host.example:2222/owner/repo.git", "host.example:2222/owner/repo"),
            ("https://host/owner/repo.git?token=abc#frag", "host/owner/repo"),
            ("/srv/git/repo.git", "/srv/git/repo"),
            // unencoded `?`, `#` and `/` inside a password, encoded or not
            ("https://user:pa?ss@host/o/r.git", "host/o/r"),
            ("https://user:pa#ss@host/o/r.git", "host/o/r"),
            ("https://user:pa/ss@host/o/r.git", "host/o/r"),
            ("https://user:pa%2Fss%3F%23@host/o/r.git", "host/o/r"),
        ] {
            let got = clean_remote(url);
            assert_eq!(got, want, "{url}");
            assert!(!got.contains('@') && !got.contains("s3cret") && !got.contains("ghp_"), "{url}");
        }
    }

    #[test]
    fn files_stay_inside_the_folder() {
        assert!(safe_relative("a.txt") && safe_relative("sub/a b.txt") && safe_relative("..a/b"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a/..", "a\0b", "C:x", "\\srv\\x"] {
            assert!(!safe_relative(bad), "{bad:?}");
        }
    }

    const SAMPLE: &[u8] = b"# branch.oid 1234567890abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa aaa src/app.ts\0\
1 M. N... 100644 100644 100644 aaa bbb src/staged both.ts\0\
1 A. N... 000000 100644 100644 000 bbb src/new.ts\0\
1 D. N... 100644 000000 000000 aaa 000 old.txt\0\
2 R. N... 100644 100644 100644 aaa aaa R100 src/renamed.ts\0src/was.ts\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? notes/todo.md\0\
? scratch/\0\
! node_modules/\0\
! dist/\0";

    /// One slow run (a cold cache after boot) doesn't mark the repository slow for good.
    #[test]
    fn a_slow_repository_is_tried_whole_again_later() {
        let mut c = Caches::default();
        let top = Path::new("/repo");
        let now = Instant::now();
        assert!(!c.is_slow(top, now));
        c.slow.insert(top.to_path_buf(), now);
        assert!(c.is_slow(top, now + Duration::from_secs(10)));
        assert!(!c.is_slow(top, now + SLOW_RETRY + Duration::from_secs(1)));
        assert!(!c.is_slow(Path::new("/other"), now));
    }

    #[test]
    fn reads_porcelain_v2() {
        let p = parse_porcelain_v2(SAMPLE);
        assert_eq!(p.head.as_deref(), Some("main"));
        assert_eq!(p.oid.as_deref(), Some("1234567890abcdef"));
        assert_eq!((p.ahead, p.behind), (2, 1));
        let by: HashMap<_, _> = p.entries.iter().map(|(path, k, s, u)| (path.as_str(), (*k, *s, *u))).collect();
        assert_eq!(by["src/app.ts"], (GitKind::Modified, false, true));
        assert_eq!(by["src/staged both.ts"], (GitKind::Modified, true, false));
        assert_eq!(by["src/new.ts"], (GitKind::Added, true, false));
        assert_eq!(by["old.txt"], (GitKind::Deleted, true, false));
        assert_eq!(by["src/renamed.ts"].0, GitKind::Renamed);
        assert!(!by.contains_key("src/was.ts"));
        assert_eq!(by["conflict.txt"].0, GitKind::Conflicted);
        assert_eq!(by["notes/todo.md"].0, GitKind::Untracked);
        assert_eq!(by["scratch/"].0, GitKind::Untracked);
        assert_eq!(by["node_modules/"].0, GitKind::Ignored);
        assert_eq!(p.entries.len(), 10);
    }

    #[test]
    fn detached_and_fresh_repositories() {
        let p = parse_porcelain_v2(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!((p.head, p.oid), (None, None));
        assert!(p.entries.is_empty());
    }

    #[test]
    fn scoped_to_a_folder() {
        let p = parse_porcelain_v2(SAMPLE);
        let (c, inside) = scope(&p, "src/");
        assert_eq!(inside, None);
        let paths: Vec<_> = c.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, ["app.ts", "staged both.ts", "new.ts", "renamed.ts"]);
        // inside an ignored folder, everything is ignored
        let (c, inside) = scope(&p, "node_modules/react/");
        assert!(c.is_empty());
        assert_eq!(inside, Some(GitKind::Ignored));
        let (_, inside) = scope(&p, "scratch/");
        assert_eq!(inside, Some(GitKind::Untracked));
        let (c, _) = scope(&p, "");
        assert_eq!(c.len(), 10);
    }

    #[test]
    fn overrides_switch_off_repository_programs() {
        let n = |s: &str, k: &str| (s.to_string(), k.to_string());
        let o = repo_overrides(&[
            n("local", "filter.Pwn.clean"),
            n("local", "filter.Pwn.process"),
            n("worktree", "diff.x.y.textconv"),
            n("global", "filter.lfs.clean"),
            n("local", "core.fsmonitor"),
        ])
        .unwrap();
        assert!(o.contains(&"filter.Pwn.clean=".to_string()));
        assert!(o.contains(&"filter.Pwn.process=".to_string()));
        assert!(o.contains(&"filter.Pwn.required=false".to_string()));
        assert!(o.contains(&"diff.x.y.textconv=".to_string()));
        assert_eq!(o.iter().filter(|x| x.starts_with("filter.Pwn.clean")).count(), 1);
        // the user's own filters stay on (or LFS files would all show as modified)...
        assert!(!o.iter().any(|x| x.starts_with("filter.lfs.")));
        assert!(repo_overrides(&[n("global", "filter.lfs.process"), n("local", "lfs.repositoryformatversion"), n("local", "lfs.https://h/r.git/info/lfs.access")]).unwrap().is_empty());
        // ...unless the repository configures their program (git-lfs runs `lfs.extension.*`)
        for risky in ["lfs.extension.x.clean", "LFS.standalonetransferagent", "filter.lfs.clean"] {
            let o = repo_overrides(&[n("system", "filter.lfs.process"), n("local", risky)]).unwrap();
            assert!(o.contains(&"filter.lfs.process=".to_string()) && o.contains(&"filter.lfs.clean=".to_string()), "{risky}");
        }
        assert!(repo_overrides(&[n("global", "filter.lfs.process"), n("worktree", "lfs.extension.x.clean")]).unwrap().contains(&"filter.lfs.process=".to_string()));
        // the user's own diff drivers stay
        assert!(repo_overrides(&[n("global", "diff.mine.textconv")]).unwrap().is_empty());
        // a name `-c` can't address: not run at all
        assert!(repo_overrides(&[n("local", "filter.a=b.clean")]).is_none());
        assert!(repo_overrides(&[n("local", "filter.a\nb.clean")]).is_none());
    }

    /// A downloaded folder whose `.git/config` names programs (fsmonitor, a clean filter, both
    /// also through an include): looking at it must run none of them.
    #[test]
    fn a_repository_config_runs_nothing() {
        let Some(bin) = find_tool("git") else { return };
        let dir = std::env::temp_dir().join(format!("kybl-git-evil-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let mut c = git(&bin);
            c.arg("-C").arg(&dir).args(args).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t");
            assert!(c.status().unwrap().success(), "git {args:?}");
        };
        run(&["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join("f.txt"), "same").unwrap();
        std::fs::write(dir.join(".gitattributes"), "* filter=pwn\n*.txt filter=inc\n").unwrap();
        run(&["add", "."]);
        run(&["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "first"]);
        let flag = |n: &str| dir.join(format!("PWNED-{n}"));
        let touch = |n: &str| format!("touch '{}'", flag(n).display());
        let mut cfg = std::fs::read_to_string(dir.join(".git/config")).unwrap();
        cfg.push_str(&format!(
            "[core]\n\tfsmonitor = \"{}; echo\"\n[filter \"pwn\"]\n\tclean = \"{}; cat\"\n\tprocess = \"{}\"\n\trequired = true\n[include]\n\tpath = extra\n",
            touch("fsmonitor"),
            touch("clean"),
            touch("process")
        ));
        std::fs::write(dir.join(".git/config"), cfg).unwrap();
        std::fs::write(dir.join(".git/extra"), format!("[filter \"inc\"]\n\tclean = \"{}; cat\"\n", touch("include"))).unwrap();
        std::fs::write(dir.join(".git/hooks/post-index-change"), format!("#!/bin/sh\n{}\n", touch("hook"))).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join(".git/hooks/post-index-change"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // same bytes, newer timestamp: git has to look at the content, through the filter
        std::fs::write(dir.join("f.txt"), "same").unwrap();
        let later = std::time::SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options().write(true).open(dir.join("f.txt")).unwrap().set_modified(later).unwrap();

        let info = status_of(&dir, true).expect("a work tree");
        assert_eq!(info.branch.as_deref(), Some("trunk"));
        for n in ["fsmonitor", "clean", "process", "include", "hook"] {
            assert!(!flag(n).exists(), "git ran the repository's {n}");
        }
        // a sub-section `-c` can't address: no status at all, and still nothing ran
        let mut cfg = std::fs::read_to_string(dir.join(".git/config")).unwrap();
        cfg.push_str(&format!("[filter \"a=b\"]\n\tclean = \"{}; cat\"\n", touch("eq")));
        std::fs::write(dir.join(".git/config"), cfg).unwrap();
        std::fs::write(dir.join(".gitattributes"), "* filter=a=b\n").unwrap();
        caches().lock().unwrap().status.clear();
        let info = status_of(&dir, true).expect("a work tree");
        assert!(info.changes.is_empty());
        assert!(!flag("eq").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The user's own (global) clean filter keeps working: a re-saved file is not modified. Once
    /// the repository sets something under the filter program's name, it is switched off.
    #[cfg(unix)]
    #[test]
    fn the_users_own_filter_stays_on() {
        let Some(bin) = find_tool("git") else { return };
        let base = std::env::temp_dir().join(format!("kybl-git-filter-{}", uuid::Uuid::new_v4()));
        let dir = base.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        let global = base.join("gitconfig");
        let flag = base.join("RAN");
        // a filter that stores upper case, as LFS stores a pointer instead of the file
        std::fs::write(&global, format!("[filter \"up\"]\n\tclean = \"touch '{}'; tr a-z A-Z\"\n\tsmudge = cat\n", flag.display())).unwrap();
        let env = |c: &mut Command| {
            c.env("GIT_CONFIG_GLOBAL", &global).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t");
        };
        let run = |args: &[&str]| {
            let mut c = git(&bin);
            c.arg("-C").arg(&dir).args(args);
            env(&mut c);
            assert!(c.output().unwrap().status.success(), "git {args:?}");
        };
        run(&["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join(".gitattributes"), "*.txt filter=up\n").unwrap();
        std::fs::write(dir.join("f.txt"), "same").unwrap();
        run(&["add", "."]);
        run(&["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "first"]);
        let status = || {
            let mut c = git(&bin);
            c.arg("-C").arg(&dir).args(["config", "--list", "--name-only", "-z", "--show-scope", "--includes"]);
            env(&mut c);
            let out = c.output().unwrap().stdout;
            let parts: Vec<String> = out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
            let names: Vec<(String, String)> = parts.chunks(2).map(|p| (p[0].clone(), p[1].clone())).collect();
            let mut c = git(&bin);
            for o in repo_overrides(&names).unwrap() {
                c.arg("-c").arg(o);
            }
            c.arg("-C").arg(&dir).args(["status", "--porcelain=v2", "-z", "--untracked-files=no"]);
            env(&mut c);
            std::fs::remove_file(&flag).ok();
            // same bytes, newer timestamp: git has to look at the content, through the filter
            let later = std::time::SystemTime::now() + Duration::from_secs(5);
            std::fs::File::options().write(true).open(dir.join("f.txt")).unwrap().set_modified(later).unwrap();
            parse_porcelain_v2(&c.output().unwrap().stdout)
        };
        let p = status();
        assert!(p.entries.is_empty(), "{:?}", p.entries);
        assert!(flag.exists());
        // the repository names something for the filter's program: switched off, nothing runs
        run(&["config", "up.extension.x.clean", "evil"]);
        status();
        assert!(!flag.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A partial clone whose index needs a missing object (rename detection between a staged
    /// delete and add): git would fetch it from the promisor remote through the repository's own
    /// `core.sshCommand`. Reading the status must not.
    #[cfg(unix)]
    #[test]
    fn a_partial_clone_fetches_nothing() {
        let Some(bin) = find_tool("git") else { return };
        let base = std::env::temp_dir().join(format!("kybl-git-lazy-{}", uuid::Uuid::new_v4()));
        let origin = base.join("origin");
        let victim = base.join("victim");
        std::fs::create_dir_all(&origin).unwrap();
        // set up with a plain git: the app's own refuses every transport, file:// included
        let run = |dir: &Path, args: &[&str]| {
            Command::new(&bin)
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        assert!(run(&origin, &["init", "-q", "-b", "trunk"]));
        for i in 1..=3 {
            std::fs::write(origin.join(format!("f{i}.txt")), format!("content number {i} with some text in it\n")).unwrap();
        }
        assert!(run(&origin, &["add", "."]));
        assert!(run(&origin, &["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "one"]));
        assert!(run(&origin, &["config", "uploadpack.allowfilter", "true"]));
        let url = format!("file://{}", origin.display());
        if !run(&base, &["clone", "-q", "--no-checkout", "--filter=blob:none", &url, "victim"]) {
            // a git without partial clone: nothing to test
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        assert!(run(&victim, &["read-tree", "HEAD"]));
        assert!(run(&victim, &["rm", "-q", "--cached", "f1.txt"]));
        std::fs::write(victim.join("h.txt"), "content number 1 with some text in it, changed\n").unwrap();
        assert!(run(&victim, &["add", "h.txt"]));
        let flag = base.join("PWNED");
        assert!(run(&victim, &["config", "core.sshCommand", &format!("sh -c 'touch \"{}\"; exit 1' --", flag.display())]));
        assert!(run(&victim, &["config", "protocol.ssh.allow", "always"]));
        assert!(run(&victim, &["remote", "set-url", "origin", "ssh://example.invalid/repo"]));

        let info = status_of(&victim, true).expect("a work tree");
        assert_eq!(info.branch.as_deref(), Some("trunk"));
        assert!(!flag.exists(), "git ran the repository's core.sshCommand");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The real git, when there is one: a fresh repository with a change of each kind.
    #[test]
    fn reads_a_real_repository() {
        let Some(bin) = find_tool("git") else { return };
        let dir = std::env::temp_dir().join(format!("kybl-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let run = |args: &[&str]| {
            let mut c = git(&bin);
            c.arg("-C").arg(&dir).args(args).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t");
            assert!(c.status().unwrap().success(), "git {args:?}");
        };
        run(&["init", "-q", "-b", "trunk"]);
        std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
        std::fs::write(dir.join("src/a.txt"), "one").unwrap();
        run(&["add", "."]);
        run(&["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "first"]);
        std::fs::write(dir.join("src/a.txt"), "two").unwrap();
        std::fs::write(dir.join("src/b.txt"), "new").unwrap();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::write(dir.join("build/out"), "x").unwrap();

        let info = status_of(&dir.join("src"), true).expect("a work tree");
        assert_eq!(info.branch.as_deref(), Some("trunk"));
        let kinds: HashMap<_, _> = info.changes.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert_eq!(kinds.get("a.txt"), Some(&GitKind::Modified));
        assert_eq!(kinds.get("b.txt"), Some(&GitKind::Untracked));
        let ov = overview_of(&dir.join("src")).expect("a repository");
        assert_eq!(ov.commits.len(), 1);
        assert_eq!((ov.commits[0].subject.as_str(), ov.commits[0].author.as_str()), ("first", "t"));
        assert_eq!(file_commit_of(&dir.join("src"), "a.txt").map(|c| c.subject), Some("first".to_string()));
        // a file git doesn't know, and one that tries to leave the folder, have no last commit
        assert!(file_commit_of(&dir.join("src"), "b.txt").is_none());
        assert!(file_commit_of(&dir.join("src"), "../.gitignore").is_none());
        assert_eq!((ov.upstream, ov.fetched_at, ov.remote, ov.tag, ov.stashes), (None, None, None, None, 0));
        run(&["remote", "add", "origin", "https://me:pw@example.com/o/r.git"]);
        assert_eq!(overview_of(&dir).unwrap().remote.as_deref(), Some("example.com/o/r"));
        let top = status_of(&dir, true).unwrap();
        assert!(top.changes.iter().any(|c| c.path == "build/" && c.kind == GitKind::Ignored));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
