//! Git awareness for this computer's folders: the branch and each item's status, read from the
//! user's own `git` (`status --porcelain=v2`). Nothing happens when git isn't installed or the
//! folder isn't in a work tree.
//!
//! Big repositories: every run is time-boxed. When the whole repository's status doesn't come
//! back in time, the status of just the folder on screen is asked for (and the repository is
//! remembered as slow); when even that is too slow, only the branch shows. Answers are cached
//! per repository for a moment, so several panes (and quick refreshes) share one run.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;

use super::tools::{command, find_tool, run_capture};

/// How long one git run may take.
const TIME_BOX: Duration = Duration::from_millis(1500);
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
    /// repositories whose whole status took too long
    slow: HashSet<PathBuf>,
}

fn caches() -> &'static Mutex<Caches> {
    static C: OnceLock<Mutex<Caches>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn git(git: &Path) -> Command {
    let mut c = command(git);
    // reading the status never takes the index lock away from the user's own git
    c.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").arg("--no-optional-locks").arg("--literal-pathspecs");
    c
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

fn run_status(bin: &Path, top: &Path, scoped: Option<&str>) -> Option<Porcelain> {
    let mut c = git(bin);
    c.arg("-C").arg(top).args(["status", "--porcelain=v2", "-z", "--branch", "--ignored=matching", "--untracked-files=normal"]);
    if let Some(dir) = scoped {
        c.arg("--").arg(dir);
    }
    match run_capture(c, TIME_BOX) {
        Ok((st, out)) if st.success() => Some(parse_porcelain_v2(&out)),
        _ => None,
    }
}

/// Just the branch, for a repository too big to read the status of in time.
fn branch_only(bin: &Path, top: &Path) -> Porcelain {
    let mut c = git(bin);
    c.arg("-C").arg(top).args(["rev-parse", "--abbrev-ref", "HEAD"]);
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
            let slow = caches().lock().unwrap().slow.contains(&repo.top);
            let whole = if slow { None } else { run_status(&bin, &repo.top, None) };
            let (st, scoped) = match whole {
                Some(st) => (Some(st), None),
                None => {
                    if !slow {
                        caches().lock().unwrap().slow.insert(repo.top.clone());
                    }
                    if repo.prefix.is_empty() {
                        (None, None)
                    } else {
                        (run_status(&bin, &repo.top, Some(&repo.prefix)), Some(repo.prefix.clone()))
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let top = status_of(&dir, true).unwrap();
        assert!(top.changes.iter().any(|c| c.path == "build/" && c.kind == GitKind::Ignored));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
