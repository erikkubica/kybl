//! Links (symbolic links, Windows junctions) on this computer met by work that goes through a
//! folder: the one rule every such path follows, so a copy, mirror, compress, extract, download
//! and sync all treat them alike.
//!
//! - **Reading a folder** (copy / mirror / compress from this computer): a link met inside the
//!   picked folder is left out and listed, never followed. A link to `~/.aws/credentials` in a
//!   downloaded project must not be uploaded or zipped under the link's name. What the user picked
//!   directly (a link itself) is still followed: that's their choice.
//! - **Writing into a folder** with names that came from elsewhere (a server, a bucket, an
//!   archive): no part of the path below the folder the user picked may be a link, the file
//!   itself included. `Documents -> ~/Documents` or `notes.txt -> ~/.zshrc` in the destination
//!   would otherwise have a remote name write into, or over, something outside it.

use std::path::{Path, PathBuf};

use crate::storage::{Capabilities, Entry};

/// The first link on the way from `base` (not checked: the user picked it) down to `path`: a part
/// of the path below `base` that is a link (on Windows, `is_symlink` covers junctions too). With
/// `last`, `path` itself counts; without, only its folders (a file replaced by a rename is never
/// written through). Parts that aren't there yet end the walk: they are made as plain folders. A
/// path that isn't under `base` counts as a link (it is somewhere else).
pub fn link_between(base: &Path, path: &Path, last: bool) -> Option<PathBuf> {
    let Ok(rel) = path.strip_prefix(base) else { return Some(path.to_path_buf()) };
    let mut at = base.to_path_buf();
    let mut parts = rel.components().peekable();
    while let Some(part) = parts.next() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Some(path.to_path_buf());
        }
        if !last && parts.peek().is_none() {
            break;
        }
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => return Some(at),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    None
}

fn shown(base: &Path, link: &Path) -> String {
    link.strip_prefix(base).map(|r| r.display().to_string()).unwrap_or_else(|_| link.display().to_string())
}

/// A file or folder from elsewhere is about to be written at `path` inside the picked folder
/// `base`: refused when a link is on the way (the file itself included).
pub fn safe_write_target(base: &Path, path: &Path) -> Result<(), String> {
    match link_between(base, path, true) {
        None => Ok(()),
        Some(link) => Err(format!(
            "“{}” is a link to another place, and Kybl doesn't write files from elsewhere through links, so this was left alone.",
            shown(base, link.as_path())
        )),
    }
}

/// A file inside the picked folder `base` is about to be read to send elsewhere: refused when it,
/// or a folder between it and `base`, is a link.
pub fn safe_source(base: &Path, path: &Path) -> Result<(), String> {
    match link_between(base, path, true) {
        None => Ok(()),
        Some(link) => Err(format!("Not copied: “{}” is a link, and Kybl doesn't follow links inside a folder.", shown(base, link.as_path()))),
    }
}

/// A listed entry of a store on this computer that is a link: left out when a folder is gone
/// through (see the module docs). Links on servers (SFTP) are the server's own business.
pub fn skip_listed_link(caps: &Capabilities, e: &Entry) -> bool {
    caps.local_paths && e.link.is_some()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn links_on_the_way_are_found() {
        let d = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("kybl-links-{}", uuid::Uuid::new_v4()));
        let base = d.join("dst");
        let away = d.join("away");
        std::fs::create_dir_all(base.join("plain")).unwrap();
        std::fs::create_dir_all(&away).unwrap();
        std::fs::write(away.join("secret"), b"x").unwrap();
        std::os::unix::fs::symlink(&away, base.join("Documents")).unwrap();
        std::os::unix::fs::symlink(away.join("secret"), base.join("notes.txt")).unwrap();

        assert!(safe_write_target(&base, &base.join("plain/a.txt")).is_ok());
        assert!(safe_write_target(&base, &base.join("new/dir/a.txt")).is_ok(), "folders not made yet");
        assert!(safe_write_target(&base, &base.join("Documents/report.docx")).is_err(), "a linked folder");
        assert!(safe_write_target(&base, &base.join("notes.txt")).is_err(), "a link to a file is never written through");
        assert!(safe_write_target(&base, &d.join("elsewhere")).is_err(), "outside the folder");
        assert!(safe_write_target(&base, &base.join("../away/x")).is_err(), "no `..`");
        assert!(safe_source(&base, &base.join("notes.txt")).is_err());
        assert!(safe_source(&base, &base.join("Documents/secret")).is_err());
        assert!(safe_source(&base, &base.join("plain")).is_ok());
        // the picked folder itself may be a link
        assert!(safe_write_target(&base.join("Documents"), &base.join("Documents/a")).is_ok());
        // without `last`: only the folders on the way
        assert!(link_between(&base, &base.join("notes.txt"), false).is_none());
        assert!(link_between(&base, &base.join("Documents/x"), false).is_some());
        let _ = std::fs::remove_dir_all(&d);
    }
}
