//! How a search by name matches (search_objects, for S3 and every other connection): part of the
//! path below the searched folder, ignoring case unless asked; or, with `regex`, a regular
//! expression tested on the item's own name, so `^IMG_\d+\.jpe?g$` means what it says.

use regex::{Regex, RegexBuilder};

pub enum NameMatch {
    /// `needle` already lowercased when `case` is off
    Text { needle: String, case: bool },
    Re(Regex),
}

impl NameMatch {
    pub fn new(query: &str, case_sensitive: bool, regex: bool) -> Result<Self, String> {
        if !regex {
            let needle = if case_sensitive { query.to_string() } else { query.to_lowercase() };
            return Ok(NameMatch::Text { needle, case: case_sensitive });
        }
        RegexBuilder::new(query)
            .case_insensitive(!case_sensitive)
            // a pattern typed in a search field: big enough for anything sensible, never for a runaway
            .size_limit(1 << 20)
            .build()
            .map(NameMatch::Re)
            .map_err(|e| format!("Regular expression: {}", e.to_string().lines().last().unwrap_or_default().trim_start_matches("error: ")))
    }

    /// `rest`: the item's path below the searched folder ("2026/IMG_0001.jpg").
    pub fn hit(&self, rest: &str) -> bool {
        match self {
            NameMatch::Text { needle, case: true } => rest.contains(needle.as_str()),
            NameMatch::Text { needle, case: false } => rest.to_lowercase().contains(needle.as_str()),
            NameMatch::Re(re) => re.is_match(rest.trim_end_matches('/').rsplit('/').next().unwrap_or(rest)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_ignores_case_unless_asked() {
        let m = NameMatch::new("REPORT", false, false).unwrap();
        assert!(m.hit("2026/q1-report.pdf"));
        let m = NameMatch::new("REPORT", true, false).unwrap();
        assert!(!m.hit("2026/q1-report.pdf"));
        assert!(m.hit("2026/Q1-REPORT.pdf"));
    }

    #[test]
    fn regex_tests_the_name_itself() {
        let m = NameMatch::new(r"^IMG_\d+\.jpe?g$", false, true).unwrap();
        assert!(m.hit("trips/2026/img_0042.JPG"));
        assert!(!m.hit("trips/IMG_0042.jpg.bak"));
        // the folders above don't count: "^2026" is about the name
        assert!(!NameMatch::new("^2026", false, true).unwrap().hit("2026/notes.txt"));
        let m = NameMatch::new("^img", true, true).unwrap();
        assert!(!m.hit("IMG_1.jpg"));
    }

    #[test]
    fn a_broken_pattern_says_why() {
        let e = NameMatch::new("(unclosed", false, true).err().unwrap();
        assert!(e.starts_with("Regular expression:"), "{e}");
    }
}
