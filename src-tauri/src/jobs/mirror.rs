//! "Mirror" (deploy a folder to another place, or pull one down): the page lists both folders,
//! decides what is new, changed and gone, and shows that as a dry run (`src/mirror`). The job it
//! then starts carries out exactly that list: the files to copy (each still checked against what
//! is at the destination by the copier, so a file already identical is skipped) and, last, the
//! files and folders to delete there. Nothing that wasn't in the preview is touched.
//!
//! Deletions are items with `del = 1` whose `src_path` is the destination path behind
//! [`DEL_MARK`] (so they can't collide with a copy's source path).

use tauri::{AppHandle, State};

use super::{
    db::{self, NewItem},
    hash, plan,
    types::{JobSpec, Mirror},
    JobManager,
};
use crate::{state::AppState, storage::{registry, Storage}};

/// Starts the `src_path` of a deletion row.
pub const DEL_MARK: char = '\u{1}';

/// One path of a mirror's lists, relative to its folder: no `..`, `.` or empty parts, and not the
/// folder itself (deleting "" would be everything).
fn check_rel(rel: &str) -> Result<(), String> {
    let body = rel.strip_suffix('/').unwrap_or(rel);
    let bad = body.is_empty() || rel.starts_with('/') || rel.contains(['\0', '\\', DEL_MARK]) || body.split('/').any(|p| p.is_empty() || p == "." || p == "..");
    if bad {
        return Err(format!("This mirror has a path Kybl won't use: “{rel}”."));
    }
    Ok(())
}

/// The job's rows: copies (folders end with `/`) from `src_dir` to `dst_dir`, then deletions in
/// `dst_dir`.
pub fn mirror_items(src_dir: &str, dst_dir: &str, m: &Mirror) -> Result<Vec<NewItem>, String> {
    let mut out = Vec::with_capacity(m.copy.len() + m.delete.len());
    for f in &m.copy {
        check_rel(&f.rel)?;
        let is_dir = f.rel.ends_with('/');
        out.push(NewItem {
            src_path: format!("{src_dir}{}", f.rel),
            dst_path: format!("{dst_dir}{}", f.rel),
            size: if is_dir { 0 } else { f.size.max(0) },
            etag: f.etag.clone(),
            mtime: f.mtime,
            md5: f.md5.as_deref().filter(|m| hash::is_md5_hex(m)).map(str::to_ascii_lowercase),
            is_dir,
            ..Default::default()
        });
    }
    for rel in &m.delete {
        check_rel(rel)?;
        let dst = format!("{dst_dir}{rel}");
        out.push(NewItem { src_path: format!("{DEL_MARK}{dst}"), dst_path: dst, is_dir: rel.ends_with('/'), del: true, ..Default::default() });
    }
    Ok(out)
}

/// The two folders are one inside the other (or the same): mirroring would copy into itself, and
/// its deletions could reach the source. This device's roots are folders on one disk, so there
/// the full paths count, whichever roots they are under.
pub fn overlaps(spec: &JobSpec, src_dir: &str) -> bool {
    overlaps_in(spec, src_dir, false)
}

/// `overlaps`, where `one_place`: two saved connections reach the same store (the same S3
/// endpoint), so their folders overlap as if they were one connection's.
fn overlaps_in(spec: &JobSpec, src_dir: &str, one_place: bool) -> bool {
    if spec.src.profile_id != spec.dst.profile_id && !one_place {
        return false;
    }
    let inside = |a: &str, b: &str| a.starts_with(b) || b.starts_with(a);
    if spec.src.profile_id == registry::LOCAL_ID {
        let fold = crate::storage::case_insensitive(crate::storage::ConnKind::Local) || windows_style(&spec.src.root) || windows_style(&spec.dst.root);
        return inside(&local_folder(&spec.src.root, src_dir, fold), &local_folder(&spec.dst.root, &spec.dst.dir, fold));
    }
    spec.src.root == spec.dst.root && inside(src_dir, &spec.dst.dir)
}

/// A job whose two connections are saved separately but reach one store, and whose folders
/// overlap: a copy would go into itself, a mirror's deletions could reach its source. Known only
/// once both are open (`Storage::place_id`).
pub fn overlaps_in_one_place(spec: &JobSpec, src: &dyn Storage, dst: &dyn Storage) -> bool {
    let one_place = src.kind() == dst.kind() && src.place_id().is_some() && src.place_id() == dst.place_id();
    if spec.src.profile_id == spec.dst.profile_id || !one_place {
        return false;
    }
    if spec.mirror.is_some() {
        return spec.src.items.first().is_some_and(|i| overlaps_in(spec, &plan::normalize_dir(&i.path), true));
    }
    let dst_dir = plan::normalize_dir(&spec.dst.dir);
    spec.src.root == spec.dst.root && spec.src.items.iter().filter(|i| i.is_dir).any(|i| dst_dir.starts_with(&plan::normalize_dir(&i.path)))
}

/// A root that is a Windows path (`C:\…`, `\\server\share`): its disk ignores letter case.
fn windows_style(root: &str) -> bool {
    root.contains('\\') || root.as_bytes().get(1) == Some(&b':')
}

/// A folder on this device as one comparable string: `/` as the only separator (Windows roots
/// come with `\`, the folder below them with `/`), no doubled separators, always ending in `/` so
/// `a/b/` isn't taken as inside `a/bc/`, and lowercased where the disk ignores letter case.
fn local_folder(root: &str, dir: &str, fold_case: bool) -> String {
    let joined = format!("{root}/{dir}").replace('\\', "/");
    let mut out = String::from(if joined.starts_with('/') { "/" } else { "" });
    for part in joined.split('/').filter(|p| !p.is_empty()) {
        out.push_str(part);
        out.push('/');
    }
    if fold_case {
        out = out.to_lowercase();
    }
    out
}

impl JobManager {
    /// A mirror job: its rows recorded with the job, already planned (see the module docs).
    pub(super) fn create_mirror(&self, mut spec: JobSpec) -> Result<String, String> {
        let m = spec.mirror.take().unwrap_or_default();
        if spec.src.profile_id.is_empty() || spec.dst.profile_id.is_empty() {
            return Err("Pick where to mirror to first.".into());
        }
        let src_dir = match spec.src.items.as_slice() {
            [one] if one.is_dir => plan::normalize_dir(&one.path),
            _ => return Err("A mirror copies one folder.".into()),
        };
        spec.src.items[0].path = src_dir.clone();
        spec.dst.dir = plan::normalize_dir(&spec.dst.dir);
        if overlaps(&spec, &src_dir) {
            return Err("One of these folders is inside the other. Pick two separate folders to mirror.".into());
        }
        let items = mirror_items(&src_dir, &spec.dst.dir, &m)?;
        if items.is_empty() {
            return Err("Nothing to do: the destination already matches.".into());
        }
        spec.mirror = Some(Mirror { copies: m.copy.iter().filter(|f| !f.rel.ends_with('/')).count() as u64, deletes: m.delete.len() as u64, ..Default::default() });
        if spec.id.is_empty() {
            spec.id = uuid::Uuid::new_v4().to_string();
        }
        if spec.title.trim().is_empty() {
            let name = plan::base_name(&src_dir);
            spec.title = if name.is_empty() { "Mirror".into() } else { format!("Mirror {name}") };
        }
        let json = serde_json::to_string(&spec).map_err(|e| e.to_string())?;
        db::insert_planned_job(&mut self.inner.db.lock().unwrap(), &spec.id, &json, &items)?;
        self.start(&spec.id);
        Ok(spec.id)
    }
}

/// The MD5 of a file, for a mirror that compares checksums: what the store reports (S3 ETags of
/// single uploads, Drive), or read and hashed where the file is on this device. None where
/// neither works (FTP, SFTP, WebDAV; multipart S3 uploads).
#[tauri::command]
pub async fn mirror_md5(app: AppHandle, state: State<'_, AppState>, profile_id: String, bucket: String, key: String) -> Result<Option<String>, String> {
    let s = registry::open(&app, &state, &profile_id).await?;
    let Some(e) = s.stat(&bucket, &key).await? else { return Err("This file isn't there any more.".into()) };
    if let Some(m) = hash::md5_of(&e, s.caps()) {
        return Ok(Some(m));
    }
    if !s.caps().local_paths {
        return Ok(None);
    }
    let r = s.read(&bucket, &key, None, None).await?;
    Ok(Some(hash::md5_stream(r.body).await.map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::types::{Dest, MirrorFile, SelItem, Source};

    fn file(rel: &str, size: i64) -> MirrorFile {
        MirrorFile { rel: rel.into(), size, ..Default::default() }
    }

    #[test]
    fn rows_land_under_both_folders_and_deletions_are_marked() {
        let m = Mirror {
            copy: vec![file("css/", 0), MirrorFile { md5: Some("ABCDEF0123456789ABCDEF0123456789".into()), ..file("css/site.css", 10) }, file("index.html", 5)],
            delete: vec!["old.html".into(), "img/".into()],
            ..Default::default()
        };
        let rows = mirror_items("site/", "public_html/", &m).unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!((rows[0].src_path.as_str(), rows[0].dst_path.as_str(), rows[0].is_dir), ("site/css/", "public_html/css/", true));
        assert_eq!(rows[1].md5.as_deref(), Some("abcdef0123456789abcdef0123456789"));
        assert_eq!(rows[2].size, 5);
        let del: Vec<_> = rows.iter().filter(|r| r.del).map(|r| (r.src_path.as_str(), r.dst_path.as_str(), r.is_dir)).collect();
        assert_eq!(del, [("\u{1}public_html/old.html", "public_html/old.html", false), ("\u{1}public_html/img/", "public_html/img/", true)]);
    }

    #[test]
    fn paths_that_could_escape_the_folder_are_refused() {
        for bad in ["", "/", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a\\b", "\u{1}x"] {
            let m = Mirror { delete: vec![bad.into()], ..Default::default() };
            assert!(mirror_items("", "", &m).is_err(), "{bad:?}");
            let m = Mirror { copy: vec![file(bad, 1)], ..Default::default() };
            assert!(mirror_items("", "", &m).is_err(), "{bad:?}");
        }
        assert!(mirror_items("", "", &Mirror { delete: vec!["a/b/".into(), ".htaccess".into(), "a..b".into()], ..Default::default() }).is_ok());
    }

    #[test]
    fn overlapping_folders_are_caught() {
        let sp = |sp: &str, sr: &str, dp: &str, dr: &str, dir: &str| JobSpec {
            id: String::new(),
            mode: Default::default(),
            src: Source { profile_id: sp.into(), root: sr.into(), items: vec![SelItem { path: String::new(), is_dir: true }] },
            dst: Dest { profile_id: dp.into(), root: dr.into(), dir: dir.into() },
            conflict: Default::default(),
            verify: Default::default(),
            preserve_mtime: true,
            ignore: vec![],
            title: String::new(),
            mirror: None,
        };
        assert!(overlaps(&sp("a", "r", "a", "r", "out/"), "site/") == false);
        assert!(overlaps(&sp("a", "r", "a", "r", "site/out/"), "site/"));
        assert!(overlaps(&sp("a", "r", "a", "r", ""), "site/"), "the destination holds the source");
        assert!(!overlaps(&sp("a", "r", "a", "q", ""), "site/"), "another bucket");
        assert!(!overlaps(&sp("a", "r", "b", "r", ""), "site/"), "another connection");
        // this device: roots are folders, so Home/Sites/acme and the Sites root are one place
        assert!(overlaps(&sp("local", "/home/me", "local", "/home/me/Sites", "acme/"), "Sites/"));
        assert!(!overlaps(&sp("local", "/home/me", "local", "/home/me/Sites", "acme-live/"), "Sites/acme/"));
        assert!(!overlaps(&sp("local", "/home/me/Sites", "local", "/home/me/Sites2", ""), ""));
        // Windows roots come with backslashes, the folders below them with slashes (B4-1)
        assert!(overlaps(&sp("local", r"C:\Users\me", "local", r"C:\Users\me\Sites", "out/"), "Sites/"));
        assert!(overlaps(&sp("local", r"C:\Users\me\Sites", "local", r"C:\Users\me", "Sites/out/"), ""));
        assert!(overlaps(&sp("local", r"C:\Users\me", "local", r"c:\users\ME\sites", ""), "Sites/"), "letter case doesn't count");
        assert!(overlaps(&sp("local", r"\\nas\share", "local", r"\\nas\share\a", ""), "a/"));
        assert!(overlaps(&sp("local", r"C:\", "local", r"C:\Data", ""), ""), "a drive root");
        assert!(!overlaps(&sp("local", r"C:\Users\me", "local", r"C:\Users\me\Sites2", ""), "Sites/"));
        assert!(!overlaps(&sp("local", r"C:\Users\me", "local", r"D:\Users\me", ""), ""));
    }
}
