//! Drive addresses files by id and lets a folder hold several files with the same name; Kybl
//! addresses them by path. Two pieces bridge that:
//!
//! * [`PathCache`]: path → id for a minute, so walking "a/b/c.txt" doesn't cost three lookups per
//!   request. Writes, renames and deletes drop the paths they touch (and everything below).
//! * Duplicate names: in a listing the first file called "report.pdf" keeps its name, the next
//!   ones (oldest first) become "report (2).pdf", "report (3).pdf". The same rule maps such a
//!   name back to the right file ([`parse_dup`]). Folders and files are numbered separately,
//!   since "a/" and "a" never clash.
//!
//! A "/" inside a Drive name (allowed there) shows as "／" (fullwidth solidus), like rclone does.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

/// How long a path → id answer is trusted (changes made elsewhere show up after this).
pub const TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    /// what to read and list: the file, or a shortcut's target
    pub id: String,
    /// what to rename, move and delete: the file, or the shortcut itself
    pub own_id: String,
    pub folder: bool,
    pub mime: String,
}

#[derive(Default)]
pub struct PathCache {
    map: Mutex<HashMap<(String, String), (Node, Instant)>>,
}

impl PathCache {
    pub fn get(&self, root: &str, key: &str) -> Option<Node> {
        self.get_at(root, key, Instant::now())
    }

    pub fn get_at(&self, root: &str, key: &str, now: Instant) -> Option<Node> {
        let mut m = self.map.lock().unwrap();
        let k = (root.to_string(), key.to_string());
        match m.get(&k) {
            Some((n, at)) if now.duration_since(*at) < TTL => Some(n.clone()),
            Some(_) => {
                m.remove(&k);
                None
            }
            None => None,
        }
    }

    /// `key` ends with "/" for folders.
    pub fn put(&self, root: &str, key: &str, node: Node) {
        self.put_at(root, key, node, Instant::now());
    }

    pub fn put_at(&self, root: &str, key: &str, node: Node, now: Instant) {
        let mut m = self.map.lock().unwrap();
        // the occasional sweep keeps a long session's cache from growing without end
        if m.len() > 20_000 {
            m.retain(|_, (_, at)| now.duration_since(*at) < TTL);
        }
        m.insert((root.to_string(), key.to_string()), (node, now));
    }

    /// Forgets `key` and, for a folder (or a name that may be one), everything inside it.
    pub fn forget(&self, root: &str, key: &str) {
        let base = key.trim_end_matches('/');
        let dir = format!("{base}/");
        self.map.lock().unwrap().retain(|(r, k), _| r != root || !(k == base || k == &dir || k.starts_with(&dir)));
    }

    /// Forgets everything in a root (a rename of a folder that isn't in the cache, say).
    pub fn forget_root(&self, root: &str) {
        self.map.lock().unwrap().retain(|(r, _), _| r != root);
    }
}

/// "a/b" → "a／b": Drive names may contain "/", paths can't.
pub fn display_name(drive_name: &str) -> String {
    drive_name.replace('/', "／")
}

/// Back from a path component to the Drive name.
pub fn drive_name(display: &str) -> String {
    display.replace('／', "/")
}

/// The `n`th file of that name (n ≥ 2): "report.pdf" → "report (2).pdf", folder "Photos" →
/// "Photos (2)".
pub fn with_number(name: &str, n: u32, folder: bool) -> String {
    if folder {
        return format!("{name} ({n})");
    }
    let (stem, ext) = super::super::extras::split_ext(name);
    format!("{stem} ({n}){ext}")
}

/// "report (2).pdf" → ("report.pdf", 2); None when the name has no " (n)" (n ≥ 2) before its
/// extension. `folder` decides whether a dot starts an extension.
pub fn parse_dup(name: &str, folder: bool) -> Option<(String, u32)> {
    let (stem, ext) = if folder { (name, "") } else { super::super::extras::split_ext(name) };
    let open = stem.strip_suffix(')')?.rfind(" (")?;
    let n: u32 = stem[open + 2..stem.len() - 1].parse().ok()?;
    if n < 2 || stem[open + 2..stem.len() - 1].starts_with('0') {
        return None;
    }
    Some((format!("{}{ext}", &stem[..open]), n))
}

/// The last number given to each of the names the page ended on, so a run of equal names split
/// over two pages keeps counting. Serialized into the page token.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
pub struct Carry {
    /// (folder, name) → the last number used (1: the plain name)
    #[serde(default)]
    pub seen: Vec<(bool, String, u32)>,
}

/// The next free number after `last` for a duplicate of `name`: one whose numbered name isn't a
/// real name in the folder (`taken(folder, drive name)`), so a duplicate never shows under the
/// name of another file (which would hide one of them, and a move could delete the wrong one).
fn next_number(name: &str, folder: bool, last: u32, taken: &dyn Fn(bool, &str) -> bool) -> u32 {
    let mut n = last + 1;
    while n < u32::MAX && taken(folder, &with_number(name, n, folder)) {
        n += 1;
    }
    n
}

/// Names for one page of a listing ordered by name, then age: duplicates numbered as above.
/// `items` are (Drive name, is folder). Returns the display names and the carry for the next
/// page. Numbering doesn't skip real names here; Drive listings use [`number_page_with`].
pub fn number_page(items: &[(String, bool)], carry: &Carry) -> (Vec<String>, Carry) {
    number_page_with(items, carry, &|_, _| false)
}

/// [`number_page`], skipping numbered names that `taken(folder, drive name)` says are real names
/// in the folder.
pub fn number_page_with(items: &[(String, bool)], carry: &Carry, taken: &dyn Fn(bool, &str) -> bool) -> (Vec<String>, Carry) {
    let mut seen: HashMap<(bool, String), u32> = carry.seen.iter().map(|(f, n, c)| ((*f, n.clone()), *c)).collect();
    let mut out = Vec::with_capacity(items.len());
    for (name, folder) in items {
        let last = seen.entry((*folder, name.clone())).or_insert(0);
        if *last == 0 {
            *last = 1;
            out.push(display_name(name));
        } else {
            *last = next_number(name, *folder, *last, taken);
            out.push(display_name(&with_number(name, *last, *folder)));
        }
    }
    // Drive may order names regardless of case, so a run of one name can be interleaved with the
    // same name in other cases: carry every name equal (ignoring case) to the last one
    let next = match items.last() {
        Some((last, _)) => {
            let low = last.to_lowercase();
            let mut keep: Vec<(bool, String, u32)> = seen.into_iter().filter(|((_, n), _)| n.to_lowercase() == low).map(|((f, n), c)| (f, n, c)).collect();
            keep.sort();
            Carry { seen: keep }
        }
        None => carry.clone(),
    };
    (out, next)
}

/// Which of the files named `base` (oldest first, 0-based) shows as number `n`, with the same
/// skipping as [`number_page_with`]; None when `n` is never given out (it is a real name) or
/// would belong to a file past `max_index` (there are only `max_index + 1` files named `base`).
pub fn dup_index(base: &str, folder: bool, n: u32, max_index: usize, taken: &dyn Fn(bool, &str) -> bool) -> Option<usize> {
    let (mut last, mut index) = (1u32, 0usize);
    while last < n {
        if index >= max_index {
            return None;
        }
        last = next_number(base, folder, last, taken);
        index += 1;
    }
    (last == n).then_some(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str) -> Node {
        Node { id: id.into(), own_id: id.into(), folder: false, mime: "text/plain".into() }
    }

    #[test]
    fn cache_expires_and_forgets_subtrees() {
        let c = PathCache::default();
        let t0 = Instant::now();
        c.put_at("root", "a/", node("A"), t0);
        c.put_at("root", "a/b.txt", node("B"), t0);
        c.put_at("root", "a/c/d.txt", node("D"), t0);
        c.put_at("root", "ab.txt", node("AB"), t0);
        c.put_at("drive2", "a/", node("X"), t0);
        assert_eq!(c.get_at("root", "a/b.txt", t0 + Duration::from_secs(5)).unwrap().id, "B");
        assert_eq!(c.get_at("root", "a/b.txt", t0 + TTL + Duration::from_secs(1)), None, "expired");

        c.put_at("root", "a/b.txt", node("B"), t0);
        c.forget("root", "a/");
        assert_eq!(c.get_at("root", "a/", t0), None);
        assert_eq!(c.get_at("root", "a/b.txt", t0), None);
        assert_eq!(c.get_at("root", "a/c/d.txt", t0), None);
        assert_eq!(c.get_at("root", "ab.txt", t0).unwrap().id, "AB", "a sibling sharing the prefix stays");
        assert_eq!(c.get_at("drive2", "a/", t0).unwrap().id, "X", "other roots stay");

        c.forget("root", "ab.txt");
        assert_eq!(c.get_at("root", "ab.txt", t0), None);
        c.forget_root("drive2");
        assert_eq!(c.get_at("drive2", "a/", t0), None);
    }

    #[test]
    fn duplicates_are_numbered_and_map_back() {
        let items: Vec<(String, bool)> = [("a.txt", false), ("a.txt", false), ("a.txt", true), ("a.txt", false), ("b", true), ("b", true), ("x/y", false)]
            .iter()
            .map(|(n, f)| (n.to_string(), *f))
            .collect();
        let (names, _) = number_page(&items, &Carry::default());
        assert_eq!(names, vec!["a.txt", "a (2).txt", "a.txt", "a (3).txt", "b", "b (2)", "x／y"]);
        assert_eq!(parse_dup("a (2).txt", false), Some(("a.txt".into(), 2)));
        assert_eq!(parse_dup("a (3).txt", false), Some(("a.txt".into(), 3)));
        assert_eq!(parse_dup("b (2)", true), Some(("b".into(), 2)));
        assert_eq!(parse_dup("v1.2 (2)", true), Some(("v1.2".into(), 2)), "folders have no extension");
        assert_eq!(parse_dup("a (1).txt", false), None, "the first one has no number");
        assert_eq!(parse_dup("a (02).txt", false), None);
        assert_eq!(parse_dup("a (x).txt", false), None);
        assert_eq!(parse_dup("plain.txt", false), None);
        assert_eq!(drive_name("x／y"), "x/y");
    }

    #[test]
    fn numbering_carries_over_page_breaks() {
        let page1: Vec<(String, bool)> = vec![("a".into(), false), ("Same".into(), false), ("same".into(), false)];
        let page2: Vec<(String, bool)> = vec![("Same".into(), false), ("same".into(), false), ("z".into(), false)];
        let (n1, carry) = number_page(&page1, &Carry::default());
        assert_eq!(n1, vec!["a", "Same", "same"]);
        assert_eq!(carry.seen.len(), 2, "both cases of the last name carry on");
        let token = serde_json::to_string(&carry).unwrap();
        let (n2, carry2) = number_page(&page2, &serde_json::from_str(&token).unwrap());
        assert_eq!(n2, vec!["Same (2)", "same (2)", "z"]);
        assert_eq!(carry2.seen, vec![(false, "z".to_string(), 1)]);
        // the same files listed in one page get the same names
        let all: Vec<(String, bool)> = page1.iter().chain(&page2).cloned().collect();
        assert_eq!(number_page(&all, &Carry::default()).0, [n1, n2].concat());
    }

    #[test]
    fn duplicate_numbers_skip_real_names() {
        // the folder also holds a real "a (2).txt" (and "a (4).txt"): the copies of "a.txt" must
        // not show under those names
        let real = ["a (2).txt", "a (4).txt", "a.txt"];
        let taken = |folder: bool, n: &str| !folder && real.contains(&n);
        let items: Vec<(String, bool)> = [("a (2).txt", false), ("a (4).txt", false), ("a.txt", false), ("a.txt", false), ("a.txt", false), ("a.txt", true), ("a.txt", true)]
            .iter()
            .map(|(n, f)| (n.to_string(), *f))
            .collect();
        let (names, _) = number_page_with(&items, &Carry::default(), &taken);
        assert_eq!(names, vec!["a (2).txt", "a (4).txt", "a.txt", "a (3).txt", "a (5).txt", "a.txt", "a.txt (2)"], "folders are numbered on their own");
        let mut unique = names[..5].to_vec();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 5, "no two files share a name");
        // and the names map back to the same files
        assert_eq!(dup_index("a.txt", false, 3, 9, &taken), Some(1));
        assert_eq!(dup_index("a.txt", false, 5, 9, &taken), Some(2));
        assert_eq!(dup_index("a.txt", false, 2, 9, &taken), None, "a real name, never a number");
        assert_eq!(dup_index("a.txt", false, 4, 9, &taken), None);
        assert_eq!(dup_index("a.txt", true, 2, 9, &taken), Some(1));
        // only as many numbers as there are duplicates: two files named a.txt give out (3) only
        assert_eq!(dup_index("a.txt", false, 5, 1, &taken), None);
        assert_eq!(dup_index("a.txt", false, 3, 1, &taken), Some(1));
        // a huge number asks about at most `max_index` names, not billions
        let asked = std::cell::Cell::new(0u32);
        let count = |_: bool, _: &str| {
            asked.set(asked.get() + 1);
            false
        };
        assert_eq!(dup_index("x.txt", false, 4_000_000_000, 3, &count), None);
        assert!(asked.get() <= 3, "asked {} names", asked.get());

        // a run split over two pages keeps skipping
        let (n1, carry) = number_page_with(&items[..4], &Carry::default(), &taken);
        let (n2, _) = number_page_with(&items[4..5], &carry, &taken);
        assert_eq!([n1, n2].concat(), names[..5].to_vec());
    }
}
