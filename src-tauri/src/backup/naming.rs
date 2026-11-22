//! Where a backed-up file goes: the set's naming template filled in for one item, and the
//! "IMG_0001 (2).HEIC" name when something different already has the name.
//!
//! Tokens: `{yyyy}` `{yy}` `{MM}` `{dd}` (when it was taken, in the phone's time zone then),
//! `{name}` (the whole file name), `{stem}` and `{ext}` (its two halves), `{device}`, `{album}`,
//! `{type}` ("Photos", "Videos", "Files") and `{path}` (folder sets: the path inside the picked
//! folder). A template without a file name token gets `/{name}` added, so every item has one.

use super::types::Item;

pub const DEFAULT_TEMPLATE: &str = "{yyyy}/{MM}/{name}";

/// What the template needs besides the item.
#[derive(Clone, Debug, Default)]
pub struct Context<'a> {
    pub device: &'a str,
}

/// Year, month and day of `ms` since the epoch, shifted by `offset_min` minutes.
pub fn civil(ms: i64, offset_min: i32) -> (i64, u32, u32) {
    let secs = ms.div_euclid(1000) + offset_min as i64 * 60;
    let days = secs.div_euclid(86_400);
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// One path component made safe for every backend: no separators, no characters Windows-style
/// stores (OneDrive, SMB behind WebDAV) refuse, no control characters, never "." or "..".
pub fn clean(part: &str) -> String {
    let s: String = part
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let s = s.trim().trim_end_matches('.').to_string();
    match s.as_str() {
        "" => "_".into(),
        "." | ".." => "_".into(),
        _ => s,
    }
}

/// A relative path ("Sent/IMG-1.jpg") with every component cleaned and empty ones dropped.
fn clean_path(p: &str) -> String {
    p.split(['/', '\\']).filter(|c| !c.trim().is_empty()).map(clean).collect::<Vec<_>>().join("/")
}

pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// The path of `item` inside the set's destination folder.
pub fn render(template: &str, item: &Item, ctx: &Context) -> String {
    let template = if template.trim().is_empty() { DEFAULT_TEMPLATE } else { template };
    let named = ["{name}", "{stem}", "{path}"].iter().any(|t| template.contains(t));
    let template = if named { template.to_string() } else { format!("{}/{{name}}", template.trim_end_matches('/')) };

    let name = if item.name.trim().is_empty() { item.source_id.clone() } else { item.name.clone() };
    let name = clean(&name);
    let (stem, ext) = split_ext(&name);
    let when = item.created.or(item.modified).filter(|&t| t > 0);
    let (y, m, d) = match when {
        Some(t) => {
            let (y, m, d) = civil(t, item.tz_offset.unwrap_or(0));
            (format!("{y:04}"), format!("{m:02}"), format!("{d:02}"))
        }
        None => ("Undated".into(), String::new(), String::new()),
    };
    let yy = if y.len() == 4 && y.chars().all(|c| c.is_ascii_digit()) { y[2..].to_string() } else { y.clone() };
    let album = item.album.as_deref().filter(|a| !a.trim().is_empty()).unwrap_or("Camera Roll");
    let device = if ctx.device.trim().is_empty() { "Phone" } else { ctx.device };
    let rel = item.rel_path.as_deref().filter(|p| !p.trim().is_empty()).map(clean_path).unwrap_or_else(|| name.clone());

    // tokens are filled one component at a time, so a value never adds a folder level of its own
    // (except {path}, which is a path)
    let mut out: Vec<String> = Vec::new();
    for part in template.split('/') {
        if part == "{path}" {
            out.push(rel.clone());
            continue;
        }
        let filled = part
            .replace("{yyyy}", &y)
            .replace("{yy}", &yy)
            .replace("{MM}", &m)
            .replace("{dd}", &d)
            .replace("{name}", &name)
            .replace("{stem}", stem)
            .replace("{ext}", ext)
            .replace("{device}", device)
            .replace("{album}", album)
            .replace("{type}", item.kind.folder_name())
            .replace("{path}", &rel);
        if !filled.trim().is_empty() {
            out.push(clean(&filled));
        }
    }
    let joined = out.join("/");
    if joined.is_empty() { name } else { joined }
}

/// `prefix` ("" or ending with "/") joined with a rendered path.
pub fn join(prefix: &str, rel: &str) -> String {
    let p = prefix.trim_start_matches('/');
    if p.is_empty() {
        rel.to_string()
    } else if p.ends_with('/') {
        format!("{p}{rel}")
    } else {
        format!("{p}/{rel}")
    }
}

/// The `n`th name for a file whose name is taken by something else: "a/IMG_0001 (2).HEIC" for
/// n = 2. n = 1 is the name itself.
pub fn numbered(path: &str, n: u32) -> String {
    if n <= 1 {
        return path.to_string();
    }
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let (stem, ext) = split_ext(file);
    if ext.is_empty() { format!("{dir}{stem} ({n})") } else { format!("{dir}{stem} ({n}).{ext}") }
}

/// The folder part of a path ("" or ending with "/").
pub fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..=i],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::types::ItemKind;

    fn item(name: &str, created: Option<i64>) -> Item {
        Item { source_id: "id1".into(), name: name.into(), created, size: 10, ..Default::default() }
    }

    // 2026-03-01T00:30:00Z
    const T: i64 = 1_772_325_000_000;

    #[test]
    fn civil_dates() {
        assert_eq!(civil(0, 0), (1970, 1, 1));
        assert_eq!(civil(T, 0), (2026, 3, 1));
        // half past midnight UTC is still February the day before in New York
        assert_eq!(civil(T, -5 * 60), (2026, 2, 28));
        // leap day
        assert_eq!(civil(951_782_400_000, 0), (2000, 2, 29));
        // before the epoch
        assert_eq!(civil(-86_400_000, 0), (1969, 12, 31));
    }

    #[test]
    fn templates_fill_every_token() {
        let mut it = item("IMG_0001.HEIC", Some(T));
        it.album = Some("Trips".into());
        it.kind = ItemKind::Photo;
        let ctx = Context { device: "Pixel 9" };
        assert_eq!(render(DEFAULT_TEMPLATE, &it, &ctx), "2026/03/IMG_0001.HEIC");
        assert_eq!(render("{yyyy}/{MM}/{dd}/{name}", &it, &ctx), "2026/03/01/IMG_0001.HEIC");
        assert_eq!(render("{device}/{type}/{album}/{yy}-{MM} {stem}.{ext}", &it, &ctx), "Pixel 9/Photos/Trips/26-03 IMG_0001.HEIC");
        // no file name token: the name goes at the end
        assert_eq!(render("{yyyy}", &it, &ctx), "2026/IMG_0001.HEIC");
        assert_eq!(render("", &it, &ctx), "2026/03/IMG_0001.HEIC");
        // the phone's time zone decides the day
        it.tz_offset = Some(-300);
        assert_eq!(render("{yyyy}/{MM}/{dd}/{name}", &it, &ctx), "2026/02/28/IMG_0001.HEIC");
    }

    #[test]
    fn values_never_add_folders_or_bad_characters() {
        let mut it = item("a/b:c?.jpg", Some(T));
        it.album = Some("../Secret".into());
        let ctx = Context::default();
        assert_eq!(render("{album}/{name}", &it, &ctx), ".._Secret/a_b_c_.jpg");
        assert_eq!(render("{device}/{name}", &it, &ctx), "Phone/a_b_c_.jpg");
        assert_eq!(clean(".."), "_");
        assert_eq!(clean("  "), "_");
        assert_eq!(clean("name."), "name");
    }

    #[test]
    fn undated_and_folder_paths() {
        let it = item("doc.pdf", None);
        assert_eq!(render(DEFAULT_TEMPLATE, &it, &Context::default()), "Undated/doc.pdf");
        let mut f = item("IMG-1.jpg", Some(T));
        f.rel_path = Some("WhatsApp Images/Sent//IMG-1.jpg".into());
        f.kind = ItemKind::File;
        assert_eq!(render("{path}", &f, &Context::default()), "WhatsApp Images/Sent/IMG-1.jpg");
        assert_eq!(render("{type}/{path}", &f, &Context::default()), "Files/WhatsApp Images/Sent/IMG-1.jpg");
        // a folder item without a relative path keeps its name
        f.rel_path = None;
        assert_eq!(render("{path}", &f, &Context::default()), "IMG-1.jpg");
    }

    #[test]
    fn collision_names() {
        assert_eq!(numbered("2026/03/IMG_0001.HEIC", 1), "2026/03/IMG_0001.HEIC");
        assert_eq!(numbered("2026/03/IMG_0001.HEIC", 2), "2026/03/IMG_0001 (2).HEIC");
        assert_eq!(numbered("IMG_0001.HEIC", 3), "IMG_0001 (3).HEIC");
        assert_eq!(numbered("dir/README", 2), "dir/README (2)");
        assert_eq!(numbered(".hidden", 2), ".hidden (2)");
        assert_eq!(join("Camera/", "2026/a.jpg"), "Camera/2026/a.jpg");
        assert_eq!(join("Camera", "a.jpg"), "Camera/a.jpg");
        assert_eq!(join("", "a.jpg"), "a.jpg");
        assert_eq!(parent("a/b/c.jpg"), "a/b/");
        assert_eq!(parent("c.jpg"), "");
    }
}
