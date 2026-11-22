//! Names and paths a job leaves out (".DS_Store", "node_modules/", "*.tmp", "photos/**/raw").
//!
//! A pattern without a `/` matches a name at any depth; one with a `/` inside matches the path
//! from the top of what is being copied (a leading `/` is allowed and means the same). A trailing
//! `/` matches folders only, and everything inside them. `*` matches within one name, `**` across
//! folders, `?` one character.

pub struct Ignore {
    pats: Vec<Pat>,
}

struct Pat {
    glob: Vec<char>,
    dir_only: bool,
    anchored: bool,
}

impl Ignore {
    pub fn new(list: &[String]) -> Self {
        let pats = list
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty() && !p.starts_with('#'))
            .map(|p| {
                let dir_only = p.ends_with('/');
                let p = p.trim_end_matches('/');
                let anchored = p.contains('/');
                Pat { glob: p.trim_start_matches('/').chars().collect(), dir_only, anchored }
            })
            .filter(|p| !p.glob.is_empty())
            .collect();
        Self { pats }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.pats.is_empty()
    }

    /// Whether `rel` (a path under what is being copied, without a trailing `/`) is left out,
    /// itself or because a folder it is in is.
    pub fn matches(&self, rel: &str, is_dir: bool) -> bool {
        if self.pats.is_empty() {
            return false;
        }
        let rel = rel.trim_matches('/');
        let comps: Vec<&str> = rel.split('/').collect();
        let mut path = String::new();
        for (i, name) in comps.iter().enumerate() {
            if i > 0 {
                path.push('/');
            }
            path.push_str(name);
            let comp_is_dir = i + 1 < comps.len() || is_dir;
            for p in &self.pats {
                if p.dir_only && !comp_is_dir {
                    continue;
                }
                let target: Vec<char> = if p.anchored { path.chars().collect() } else { name.chars().collect() };
                if glob(&p.glob, &target) {
                    return true;
                }
            }
        }
        false
    }
}

/// `*` (not across `/`), `**` (across `/`), `?` (one character but `/`); everything else literal.
fn glob(p: &[char], s: &[char]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some('*') if p.get(1) == Some(&'*') => {
            // "**/" also matches no folders at all
            let rest = &p[2..];
            if rest.first() == Some(&'/') && glob(&rest[1..], s) {
                return true;
            }
            (0..=s.len()).any(|i| glob(rest, &s[i..]))
        }
        Some('*') => {
            let rest = &p[1..];
            for i in 0..=s.len() {
                if glob(rest, &s[i..]) {
                    return true;
                }
                if i < s.len() && s[i] == '/' {
                    break;
                }
            }
            false
        }
        Some('?') => !s.is_empty() && s[0] != '/' && glob(&p[1..], &s[1..]),
        Some(c) => s.first() == Some(c) && glob(&p[1..], &s[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ig(p: &[&str]) -> Ignore {
        Ignore::new(&p.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn names_match_at_any_depth() {
        let i = ig(&[".DS_Store", "*.tmp", "Thumbs.db"]);
        assert!(i.matches(".DS_Store", false));
        assert!(i.matches("a/b/.DS_Store", false));
        assert!(i.matches("x/report.tmp", false));
        assert!(!i.matches("x/report.tmpl", false));
        assert!(!i.matches("x/tmp", false));
        // a folder that happens to match a name pattern: everything inside is left out too
        assert!(i.matches("cache.tmp/inside.txt", false));
    }

    #[test]
    fn folder_patterns_only_match_folders() {
        let i = ig(&["node_modules/", "build/"]);
        assert!(i.matches("app/node_modules", true));
        assert!(i.matches("app/node_modules/x/index.js", false));
        assert!(!i.matches("app/build", false), "a file called build stays");
        assert!(i.matches("build/out.bin", false));
    }

    #[test]
    fn paths_with_slashes_are_anchored() {
        let i = ig(&["photos/raw", "/docs/*.bak", "**/secret/**"]);
        assert!(i.matches("photos/raw", true));
        assert!(i.matches("photos/raw/a.cr2", false));
        assert!(!i.matches("old/photos/raw", true));
        assert!(i.matches("docs/a.bak", false));
        assert!(!i.matches("docs/sub/a.bak", false));
        assert!(i.matches("a/b/secret/c.txt", false));
        assert!(i.matches("secret/c.txt", false));
    }

    #[test]
    fn globs() {
        let g = |p: &str, s: &str| glob(&p.chars().collect::<Vec<_>>(), &s.chars().collect::<Vec<_>>());
        assert!(g("a?c", "abc"));
        assert!(!g("a?c", "a/c"));
        assert!(g("*", "anything"));
        assert!(!g("*", "a/b"));
        assert!(g("**", "a/b"));
        assert!(g("a/**/z", "a/z"));
        assert!(g("a/**/z", "a/b/c/z"));
        assert!(g("ünï*", "ünïcode"));
        assert!(ig(&["", "  ", "# comment"]).is_empty());
    }
}
