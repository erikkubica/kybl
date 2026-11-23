//! Content search results: reading ripgrep's and grep's output lines, and gathering them into one
//! hit per file (its first matching line, trimmed around the match, and how many lines matched).

use regex::{Regex, RegexBuilder};
use serde::Serialize;

/// Longest snippet shown for a line, in characters.
const SNIPPET_CHARS: usize = 240;
/// Characters kept before the match when a long line is cut.
const LEAD_CHARS: usize = 50;

/// What is searched for: the text as typed, or a regular expression; case-insensitive unless asked.
pub struct Matcher(Regex);

impl Matcher {
    pub fn new(query: &str, case_sensitive: bool, regex: bool) -> Result<Self, String> {
        if query.is_empty() {
            return Err("Type something to search for.".into());
        }
        let pattern = if regex { query.to_string() } else { regex::escape(query) };
        RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .size_limit(1 << 22)
            .build()
            .map(Matcher)
            .map_err(|e| format!("That isn't a regular expression Kybl can use.\n\n{e}"))
    }

    pub fn is_match(&self, s: &str) -> bool {
        self.0.is_match(s)
    }

    fn find(&self, s: &str) -> Option<(usize, usize)> {
        self.0.find(s).map(|m| (m.start(), m.end()))
    }
}

/// One file's result.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// the file's key (the searched folder's prefix + its path below it)
    pub key: String,
    pub size: i64,
    pub modified: Option<i64>,
    /// first matching line, 1-based
    pub line: u64,
    /// that line, trimmed around the match
    pub text: String,
    /// where the match is in `text`, in UTF-16 code units (as JavaScript counts), start..end
    pub ranges: Vec<[u32; 2]>,
    /// how many lines of the file match
    pub count: u64,
}

/// One output line of `rg -n --null` / `grep -rn --null`: `path\0line:text`. Without the NUL
/// (a grep that lacks --null) it reads `path:line:text`, taking the first `:digits:`.
pub fn parse_grep_line(raw: &[u8]) -> Option<(String, u64, String)> {
    let raw = raw.strip_suffix(b"\n").unwrap_or(raw);
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    let (path, rest) = match raw.iter().position(|b| *b == 0) {
        Some(i) => (&raw[..i], &raw[i + 1..]),
        None => {
            let mut at = None;
            for (i, b) in raw.iter().enumerate() {
                if *b != b':' {
                    continue;
                }
                let digits = raw[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                if digits > 0 && raw.get(i + 1 + digits) == Some(&b':') {
                    at = Some(i);
                    break;
                }
            }
            let i = at?;
            (&raw[..i], &raw[i + 1..])
        }
    };
    let colon = rest.iter().position(|b| *b == b':')?;
    let line: u64 = std::str::from_utf8(&rest[..colon]).ok()?.parse().ok()?;
    let mut path = String::from_utf8_lossy(path).into_owned();
    while let Some(p) = path.strip_prefix("./") {
        path = p.to_string();
    }
    if path.is_empty() {
        return None;
    }
    Some((path.replace('\\', "/"), line, String::from_utf8_lossy(&rest[colon + 1..]).into_owned()))
}

/// Splits a byte stream into lines (the last, unfinished one waits for the next chunk).
#[derive(Default)]
pub struct Lines {
    pending: Vec<u8>,
}

impl Lines {
    pub fn push(&mut self, chunk: &[u8], mut each: impl FnMut(&[u8]) -> bool) -> bool {
        self.pending.extend_from_slice(chunk);
        let mut start = 0;
        let mut go = true;
        while let Some(i) = self.pending[start..].iter().position(|b| *b == b'\n') {
            let end = start + i;
            if go {
                go = each(&self.pending[start..end]);
            }
            start = end + 1;
        }
        self.pending.drain(..start);
        go
    }

    /// What is left after the stream ended (a last line without a newline).
    pub fn finish(&mut self, each: impl FnMut(&[u8]) -> bool) {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            let mut each = each;
            each(&rest);
        }
    }
}

/// The line as shown: leading blanks dropped, cut around the first match when long, and where
/// the matches are in it.
pub fn snippet(text: &str, m: &Matcher) -> (String, Vec<[u32; 2]>) {
    let text = text.trim_end_matches(['\r', '\n']).trim_start();
    let chars = text.chars().count();
    let shown = if chars <= SNIPPET_CHARS {
        text.to_string()
    } else {
        let at = m.find(text).map(|(s, _)| text[..s].chars().count()).unwrap_or(0);
        let from = at.saturating_sub(LEAD_CHARS).min(chars - SNIPPET_CHARS);
        let body: String = text.chars().skip(from).take(SNIPPET_CHARS).collect();
        format!("{}{}{}", if from > 0 { "…" } else { "" }, body, if from + SNIPPET_CHARS < chars { "…" } else { "" })
    };
    let utf16 = |byte: usize| shown[..byte].encode_utf16().count() as u32;
    let ranges = m.0.find_iter(&shown).filter(|x| x.end() > x.start()).take(20).map(|x| [utf16(x.start()), utf16(x.end())]).collect();
    (shown, ranges)
}

/// Gathers matching lines into one [`Hit`] per file. Lines of one file come together (as rg and
/// grep print them), so a file's hit is complete once the next file starts.
pub struct Collector<'a> {
    prefix: String,
    matcher: &'a Matcher,
    max_files: usize,
    current: Option<Hit>,
    done: Vec<Hit>,
    pub files: usize,
    pub matches: u64,
    /// stopped at `max_files`
    pub full: bool,
}

impl<'a> Collector<'a> {
    pub fn new(prefix: &str, matcher: &'a Matcher, max_files: usize) -> Self {
        Self { prefix: prefix.to_string(), matcher, max_files, current: None, done: Vec::new(), files: 0, matches: 0, full: false }
    }

    /// A matching line of the file at `path` (below the searched folder). False once enough
    /// files were found: the search should stop.
    pub fn push(&mut self, path: &str, line: u64, text: &str) -> bool {
        let key = format!("{}{}", self.prefix, path);
        if let Some(c) = self.current.as_mut().filter(|c| c.key == key) {
            c.count += 1;
            self.matches += 1;
            return true;
        }
        if self.files >= self.max_files {
            self.full = true;
            return false;
        }
        if let Some(c) = self.current.take() {
            self.done.push(c);
        }
        let (text, ranges) = snippet(text, self.matcher);
        self.current = Some(Hit { key, size: 0, modified: None, line, text, ranges, count: 1 });
        self.files += 1;
        self.matches += 1;
        true
    }

    /// The files whose every line is in.
    pub fn take_done(&mut self) -> Vec<Hit> {
        std::mem::take(&mut self.done)
    }

    /// Everything not taken yet, the last file included.
    pub fn finish(&mut self) -> Vec<Hit> {
        let mut out = self.take_done();
        out.extend(self.current.take());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rg_and_grep_lines() {
        assert_eq!(parse_grep_line(b"src/main.rs\x0012:fn main() {\n"), Some(("src/main.rs".into(), 12, "fn main() {".into())));
        // grep from a folder given as "."
        assert_eq!(parse_grep_line(b"./a b/c:d.txt\x003:x:y"), Some(("a b/c:d.txt".into(), 3, "x:y".into())));
        // a grep without --null: the first ":digits:" splits
        assert_eq!(parse_grep_line(b"./notes/todo.md:7:call: 10:30"), Some(("notes/todo.md".into(), 7, "call: 10:30".into())));
        assert_eq!(parse_grep_line(b"weird:name.txt:42:hit"), Some(("weird:name.txt".into(), 42, "hit".into())));
        assert_eq!(parse_grep_line(b"Binary file x matches"), None);
        assert_eq!(parse_grep_line(b""), None);
        assert_eq!(parse_grep_line(b"win\\path.txt\x001:a\r\n"), Some(("win/path.txt".into(), 1, "a".into())));
    }

    #[test]
    fn lines_split_across_chunks() {
        let mut l = Lines::default();
        let mut got = Vec::new();
        l.push(b"one\ntw", |x| {
            got.push(x.to_vec());
            true
        });
        l.push(b"o\nthree", |x| {
            got.push(x.to_vec());
            true
        });
        l.finish(|x| {
            got.push(x.to_vec());
            true
        });
        assert_eq!(got, vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]);
    }

    #[test]
    fn snippets_are_trimmed_around_the_match() {
        let m = Matcher::new("needle", false, false).unwrap();
        let (s, r) = snippet("    let x = Needle;", &m);
        assert_eq!(s, "let x = Needle;");
        assert_eq!(r, vec![[8, 14]]);

        let long = format!("{}needle{}", "a".repeat(1000), "b".repeat(1000));
        let (s, r) = snippet(&long, &m);
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert_eq!(s.chars().count(), SNIPPET_CHARS + 2);
        assert_eq!(r, vec![[1 + LEAD_CHARS as u32, 1 + LEAD_CHARS as u32 + 6]]);

        // UTF-16 offsets, as the page counts them
        let (_, r) = snippet("é😀 needle", &m);
        assert_eq!(r, vec![[4, 10]]);
    }

    #[test]
    fn case_and_regex_options() {
        assert!(Matcher::new("Foo", false, false).unwrap().is_match("a foo b"));
        assert!(!Matcher::new("Foo", true, false).unwrap().is_match("a foo b"));
        assert!(Matcher::new("a.c", false, false).unwrap().is_match("xa.c"));
        assert!(!Matcher::new("a.c", false, false).unwrap().is_match("abc"));
        assert!(Matcher::new("a.c", false, true).unwrap().is_match("abc"));
        assert!(Matcher::new("(", false, true).is_err());
        assert!(Matcher::new("", false, false).is_err());
    }

    #[test]
    fn one_hit_per_file_with_its_count() {
        let m = Matcher::new("x", false, false).unwrap();
        let mut c = Collector::new("dir/", &m, 2);
        assert!(c.push("a.txt", 3, "x one"));
        assert!(c.push("a.txt", 9, "x two"));
        assert!(c.take_done().is_empty());
        assert!(c.push("b.txt", 1, "x"));
        let done = c.take_done();
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].key.as_str(), done[0].line, done[0].count, done[0].text.as_str()), ("dir/a.txt", 3, 2, "x one"));
        // a third file is past the limit
        assert!(!c.push("c.txt", 1, "x"));
        assert!(c.full);
        let rest = c.finish();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].key, "dir/b.txt");
        assert_eq!((c.files, c.matches), (2, 3));
    }
}
