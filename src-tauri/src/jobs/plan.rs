//! Planning: walks what was selected, a page at a time, recording every file and folder in
//! jobs.db with where it goes. Each page is saved together with where listing goes on from, so
//! a job interrupted while planning carries on from that page (re-listing at most one page,
//! which `INSERT OR IGNORE` absorbs).
//!
//! S3 is listed flat (every key under a prefix, 1,000 a page); stores with real folders are
//! walked folder by folder, and a folder left out by the ignore list isn't opened at all.

use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};

use super::{
    copy::numbered,
    db::{self, NewItem},
    hash::md5_of,
    ignore::Ignore,
    types::JobSpec,
    Db,
};
use crate::storage::{fold_path, ConnKind, Entry, ErrKind, SResult, Storage, StorageError};

/// Where planning stopped.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    /// index of the selected item being listed
    pub sel: usize,
    /// folders still to list (the last one next); empty when listing flat
    pub dirs: Vec<String>,
    /// the folder being listed and the page token to go on with
    pub current: Option<(String, Option<String>)>,
    /// listing of the selected folder has begun (its own entry is recorded)
    pub started: bool,
}

/// "a/b/photos/" → "photos"; "a/b/c.jpg" → "c.jpg".
pub fn base_name(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

fn join(dir: &str, rel: &str) -> String {
    if dir.is_empty() || dir.ends_with('/') { format!("{dir}{rel}") } else { format!("{dir}/{rel}") }
}

/// Where the selected item `sel_path` lands inside the destination folder: a folder's contents
/// go into a folder of the same name ("" means the root: straight into `dst_dir`).
pub fn dst_base(sel_path: &str, is_dir: bool, dst_dir: &str) -> String {
    if sel_path.is_empty() {
        return dst_dir.to_string();
    }
    let name = base_name(sel_path);
    if is_dir { join(dst_dir, &format!("{name}/")) } else { join(dst_dir, name) }
}

fn file_item(src: &dyn Storage, e: &Entry, dst: String) -> NewItem {
    NewItem {
        src_path: e.key.clone(),
        dst_path: dst,
        size: e.size.max(0),
        etag: e.etag.clone(),
        mtime: e.modified,
        md5: md5_of(e, src.caps()),
        is_dir: false,
        dst_fold: String::new(),
        not_copied: None,
    }
}

/// A link to a folder met inside a selected folder: listed in the job's failures with why, so it
/// isn't missed, and never copied (nor retried).
fn link_item(key: &str, target: &str, dst: String) -> NewItem {
    NewItem {
        src_path: key.trim_end_matches('/').to_string(),
        dst_path: dst.trim_end_matches('/').to_string(),
        not_copied: Some(format!("Not copied: this is a link to the folder “{target}”, and Kybl doesn't follow links inside a folder.")),
        ..Default::default()
    }
}

/// Plans the job. Ok(true) when everything is recorded; Ok(false) when `stop` was set (the cursor
/// is saved). `on_page(files, bytes)` hears what each page added. `dst_kind` says how the
/// destination tells names apart.
pub async fn plan(
    src: &dyn Storage,
    dst_kind: ConnKind,
    spec: &JobSpec,
    db: &Db,
    job_id: &str,
    stop: &AtomicBool,
    on_page: &(dyn Fn(u64, u64) + Send + Sync),
) -> SResult<bool> {
    let save = |items: &mut [NewItem], cur: &Cursor| save(db, job_id, dst_kind, items, cur, on_page);
    let ignore = Ignore::new(&spec.ignore);
    let saved = db::job(&db.lock().unwrap(), job_id).map_err(StorageError::other)?.and_then(|j| j.cursor_json);
    let mut cur: Cursor = saved.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let root = spec.src.root.as_str();
    let dst_dir = normalize_dir(&spec.dst.dir);

    while let Some(sel) = spec.src.items.get(cur.sel) {
        if stop.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let base_dst = dst_base(&sel.path, sel.is_dir, &dst_dir);
        if !sel.is_dir {
            let item = match src.stat(root, &sel.path).await? {
                Some(e) => file_item(src, &e, base_dst),
                // gone since it was picked: recorded anyway, and the copy reports it
                None => NewItem { src_path: sel.path.clone(), dst_path: base_dst, ..Default::default() },
            };
            let next = Cursor { sel: cur.sel + 1, ..Default::default() };
            save(&mut [item], &next)?;
            cur = next;
            continue;
        }
        let base = normalize_dir(&sel.path);
        if !cur.started {
            let mut first = Vec::new();
            if !base.is_empty() {
                first.push(NewItem { src_path: base.clone(), dst_path: base_dst.clone(), is_dir: true, ..Default::default() });
            }
            cur = Cursor {
                sel: cur.sel,
                dirs: if src.as_s3().is_some() { vec![] } else { vec![base.clone()] },
                current: src.as_s3().map(|_| (base.clone(), None)),
                started: true,
            };
            save(&mut first, &cur)?;
        }
        loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let (dir, token) = match cur.current.take() {
                Some(c) => c,
                None => match cur.dirs.pop() {
                    Some(d) => (d, None),
                    None => break,
                },
            };
            let mut items = Vec::new();
            let next_token = if let Some(s3) = src.as_s3() {
                // flat: every key under the selected folder
                let out = match crate::commands::list_page(s3.client(), root, &dir, token.as_deref(), Some(stop)).await {
                    Ok(out) => out,
                    // a page token from before a restart may have expired: list again from the
                    // start (what was recorded is ignored the second time)
                    Err(_) if token.is_some() => crate::commands::list_page(s3.client(), root, &dir, None, Some(stop)).await?,
                    Err(e) => return Err(e.into()),
                };
                for o in out.contents() {
                    let e = crate::commands::obj_info(o);
                    let Some(rel) = e.key.strip_prefix(&base) else { continue };
                    if rel.is_empty() || ignore.matches(rel, e.is_dir()) {
                        continue;
                    }
                    let dst = join(&base_dst, rel);
                    if e.is_dir() {
                        items.push(NewItem { src_path: e.key.clone(), dst_path: dst, is_dir: true, ..Default::default() });
                    } else {
                        items.push(file_item(src, &e, dst));
                    }
                }
                if out.is_truncated().unwrap_or(false) { out.next_continuation_token().map(str::to_string) } else { None }
            } else {
                let page = match src.list(root, &dir, token.clone()).await {
                    Ok(p) => p,
                    // a page token that no longer works (expired, or the folder changed under
                    // it): list the folder again from the start rather than missing the rest
                    // (what was recorded is ignored the second time)
                    Err(e) if token.is_some() && !matches!(e.kind, ErrKind::Network | ErrKind::NeedsAuth | ErrKind::Cancelled) => {
                        src.list(root, &dir, None).await?
                    }
                    Err(e) => return Err(e),
                };
                for f in &page.folders {
                    let Some(rel) = f.strip_prefix(&base) else { continue };
                    if rel.is_empty() || ignore.matches(rel, true) {
                        continue;
                    }
                    if let Some(target) = page.folder_link(f) {
                        items.push(link_item(f, target, join(&base_dst, rel)));
                        continue;
                    }
                    items.push(NewItem { src_path: f.clone(), dst_path: join(&base_dst, rel), is_dir: true, ..Default::default() });
                }
                // depth first, in name order; links to folders aren't gone into (one pointing
                // back up would never end)
                cur.dirs.extend(
                    page.folders
                        .iter()
                        .rev()
                        .filter(|f| page.folder_link(f).is_none())
                        .filter(|f| f.strip_prefix(&base).is_some_and(|rel| !rel.is_empty() && !ignore.matches(rel, true)))
                        .cloned(),
                );
                for e in &page.objects {
                    let Some(rel) = e.key.strip_prefix(&base) else { continue };
                    // Google Docs and the like have no bytes to copy
                    if rel.is_empty() || e.native.is_some() || ignore.matches(rel, false) {
                        continue;
                    }
                    items.push(file_item(src, e, join(&base_dst, rel)));
                }
                page.next_token
            };
            if let Some(t) = next_token {
                cur.current = Some((dir, Some(t)));
            }
            save(&mut items, &cur)?;
        }
        cur = Cursor { sel: cur.sel + 1, ..Default::default() };
        save(&mut [], &cur)?;
    }
    db::set_planned(&db.lock().unwrap(), job_id).map_err(StorageError::other)?;
    Ok(true)
}

/// "" stays "", anything else ends with one `/`.
pub fn normalize_dir(d: &str) -> String {
    let d = d.trim_start_matches('/');
    if d.is_empty() || d.ends_with('/') { d.to_string() } else { format!("{d}/") }
}

/// Gives every file a destination no other file of the job lands on. Where the destination
/// doesn't tell letter case apart ("Photo.JPG" and "photo.jpg"), the later one gets a numbered
/// name instead of replacing the first (and a move then deleting both originals).
pub fn unique_destinations(c: &rusqlite::Connection, job_id: &str, dst_kind: ConnKind, items: &mut [NewItem]) -> SResult<()> {
    // folded destination → source, for this page
    let mut page: HashMap<String, String> = HashMap::new();
    for it in items.iter_mut() {
        it.dst_fold = fold_path(dst_kind, &it.dst_path);
        if it.is_dir {
            continue;
        }
        let src = it.src_path.clone();
        let taken = |fold: &str, page: &HashMap<String, String>| -> SResult<bool> {
            if page.get(fold).is_some_and(|s| *s != src) {
                return Ok(true);
            }
            db::dst_taken(c, job_id, fold, &src).map_err(StorageError::other)
        };
        if taken(&it.dst_fold, &page)? {
            let mut n = 1;
            loop {
                let p = numbered(&it.dst_path, n);
                let f = fold_path(dst_kind, &p);
                if !taken(&f, &page)? {
                    (it.dst_path, it.dst_fold) = (p, f);
                    break;
                }
                n += 1;
                if n > 10_000 {
                    return Err(StorageError::exists());
                }
            }
        }
        page.insert(it.dst_fold.clone(), src);
    }
    Ok(())
}

fn save(db: &Db, job_id: &str, dst_kind: ConnKind, items: &mut [NewItem], cur: &Cursor, on_page: &(dyn Fn(u64, u64) + Send + Sync)) -> SResult<()> {
    let json = serde_json::to_string(cur).map_err(|e| StorageError::other(e.to_string()))?;
    let mut c = db.lock().unwrap();
    unique_destinations(&c, job_id, dst_kind, items)?;
    db::save_page(&mut c, job_id, items, Some(&json)).map_err(StorageError::other)?;
    drop(c);
    let files = items.iter().filter(|i| !i.is_dir).count() as u64;
    on_page(files, items.iter().filter(|i| !i.is_dir).map(|i| i.size as u64).sum());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations_keep_the_selected_name() {
        assert_eq!(dst_base("a/b/photos/", true, "backup/"), "backup/photos/");
        assert_eq!(dst_base("a/b/c.jpg", false, "backup/"), "backup/c.jpg");
        assert_eq!(dst_base("c.jpg", false, ""), "c.jpg");
        assert_eq!(dst_base("", true, "all/"), "all/");
        assert_eq!(dst_base("", true, ""), "");
        assert_eq!(normalize_dir("x"), "x/");
        assert_eq!(normalize_dir("/x/"), "x/");
        assert_eq!(normalize_dir(""), "");
    }
}
