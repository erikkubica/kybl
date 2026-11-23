//! Files that only exist as a web page (Google Docs, Sheets, Slides, Forms, ...) on a mounted
//! drive.
//!
//! They have no bytes of their own, so listed as they are they show as empty files with no
//! extension that nothing on the computer can open. The drive shows each one as a small HTML
//! page instead, `Name.gdoc.html`, that sends the browser to the real document. That is what
//! Google's own Drive for desktop does (its `.gdoc` files), and the only way the document stays
//! live and editable. HTML because every system opens it in the default browser with a double
//! click and no trust prompt (a Linux `.desktop` file asks first; a macOS `.webloc` only works on
//! a Mac). Finder hides the `.html`, so on a Mac it reads `Name.gdoc`, like Drive for desktop.
//!
//! Any store can have these: an entry whose `native` info carries a `web_url` becomes one.

use crate::storage::Entry;

/// The page a file opens in the browser, when it is one of these.
pub fn web_url(e: &Entry) -> Option<&str> {
    e.native.as_ref()?.web_url.as_deref().filter(|u| !u.is_empty())
}

/// The short kind in the shortcut's name: Drive for desktop's own names for Google files, so
/// people who know those recognise them; "link" for anything else.
pub fn tag(e: &Entry) -> &'static str {
    let kind = e.mime.as_deref().and_then(|m| m.strip_prefix("application/vnd.google-apps.")).unwrap_or("");
    match kind {
        "document" => "gdoc",
        "spreadsheet" => "gsheet",
        "presentation" => "gslides",
        "drawing" => "gdraw",
        "form" => "gform",
        "site" => "gsite",
        "map" => "gmap",
        "script" => "gscript",
        "jam" => "gjam",
        "fusiontable" => "gtable",
        "" => "link",
        _ => "glink",
    }
}

/// The shortcut's file name for a file called `name`: `Name.gdoc.html`. `n` > 1 numbers it, for
/// when that name is already taken in the folder.
pub fn name(name: &str, tag: &str, n: usize) -> String {
    if n > 1 { format!("{name} ({n}).{tag}.html") } else { format!("{name}.{tag}.html") }
}

/// The real file's name for a shortcut renamed to `new`: the shortcut's ending comes off, so
/// "Plan.gdoc.html" renames the document to "Plan". A name that no longer ends in `.html`
/// isn't a shortcut any more, and is refused (None): the document would vanish from where the
/// client expects it.
pub fn target_name<'a>(new: &'a str, tag: &str) -> Option<&'a str> {
    let base = new.strip_suffix(&format!(".{tag}.html")).or_else(|| new.strip_suffix(".html"))?;
    (!base.is_empty()).then_some(base)
}

/// The shortcut's bytes: a page that goes straight on to `url`, with a link for when it
/// doesn't (a browser that blocks the redirect from a local file).
pub fn page(title: &str, url: &str) -> Vec<u8> {
    let (t, u) = (escape(title), escape(url));
    format!(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta http-equiv=\"refresh\" content=\"0; url={u}\">\n<title>{t}</title>\n</head>\n<body>\n<p>Opening <a href=\"{u}\">{t}</a>...</p>\n</body>\n</html>\n"
    )
    .into_bytes()
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_odd_names_are_refused() {
        assert_eq!(name("Plan", "gdoc", 1), "Plan.gdoc.html");
        assert_eq!(name("Plan", "gdoc", 2), "Plan (2).gdoc.html");
        assert_eq!(target_name("Q3 plan.gdoc.html", "gdoc"), Some("Q3 plan"));
        assert_eq!(target_name("Q3 plan.html", "gdoc"), Some("Q3 plan"));
        assert_eq!(target_name("Q3 plan", "gdoc"), None);
        assert_eq!(target_name(".gdoc.html", "gdoc"), None);
    }

    #[test]
    fn the_page_escapes_what_it_shows() {
        let p = String::from_utf8(page("a <b> & \"c\"", "https://x.test/?a=1&b=2")).unwrap();
        assert!(p.contains("url=https://x.test/?a=1&amp;b=2\""), "{p}");
        assert!(p.contains("<title>a &lt;b&gt; &amp; &quot;c&quot;</title>"), "{p}");
    }
}
