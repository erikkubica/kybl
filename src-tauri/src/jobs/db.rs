//! jobs.db: every job and every file it copies, so a job carries on after a crash or a restart.
//!
//! Item states: `pending` → `running` → `done` (or `copied` first for a move, until the original
//! is deleted), `skipped` or `failed`. `skip = 1` marks a file that was already at the
//! destination (it counts as skipped even when a move then deletes its original).
//!
//! A mirror's deletions are rows too (`del = 1`, see `mirror.rs`): the copying passes them by,
//! and they are deleted at the destination once every copy is done.
//!
//! A `failed` row with `skip = 1` was never copyable (a link to a folder): retrying leaves it be.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::types::{Failure, JobState};

pub const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE jobs(
    id TEXT PRIMARY KEY,
    spec_json TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    -- where planning stopped (see plan::Cursor); NULL once planned
    list_cursor_json TEXT,
    planned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE items(
    job_id TEXT NOT NULL,
    src_path TEXT NOT NULL,
    dst_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    src_etag TEXT,
    src_mtime INTEGER,
    src_md5 TEXT,
    is_dir INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    skip INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    dst_etag TEXT,
    sha256 TEXT,
    -- an unfinished multipart upload to carry on with (S3 targets)
    upload_id TEXT,
    parts_json TEXT,
    PRIMARY KEY(job_id, src_path)
);
-- also gives take_pending its order without sorting a million rows
CREATE INDEX items_pending ON items(job_id, state, is_dir DESC, src_path);
"#, r#"
-- the copy as it was written (a move checks it is still that before deleting the original)
ALTER TABLE items ADD COLUMN dst_size INTEGER;
ALTER TABLE items ADD COLUMN dst_mtime INTEGER;
-- dst_path as the destination tells files apart (lowercased where case doesn't count), so two
-- files that would land on one can't both be copied there
ALTER TABLE items ADD COLUMN dst_fold TEXT;
CREATE INDEX items_dst ON items(job_id, dst_fold);
"#, r#"
-- a mirror's file or folder to delete at the destination (dst_path), not a copy
ALTER TABLE items ADD COLUMN del INTEGER NOT NULL DEFAULT 0;
"#];

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn e(err: rusqlite::Error) -> String {
    format!("The job list couldn't be updated: {err}")
}

pub type DbResult<T> = Result<T, String>;

/// A file or folder found while planning.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewItem {
    pub src_path: String,
    pub dst_path: String,
    pub size: i64,
    pub etag: Option<String>,
    pub mtime: Option<i64>,
    pub md5: Option<String>,
    pub is_dir: bool,
    /// `dst_path` folded (see `storage::fold_path`); empty: the same as `dst_path`
    pub dst_fold: String,
    /// a mirror's deletion of `dst_path` at the destination
    pub del: bool,
    /// why it isn't copied (a link to a folder): recorded as failed with this, never tried
    pub not_copied: Option<String>,
}

/// One row of `items`, as the copier needs it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Item {
    pub src_path: String,
    pub dst_path: String,
    pub size: i64,
    pub etag: Option<String>,
    pub mtime: Option<i64>,
    pub md5: Option<String>,
    pub is_dir: bool,
    pub attempts: i64,
    pub upload_id: Option<String>,
    pub parts_json: Option<String>,
}

fn item_of(r: &Row) -> rusqlite::Result<Item> {
    Ok(Item {
        src_path: r.get(0)?,
        dst_path: r.get(1)?,
        size: r.get(2)?,
        etag: r.get(3)?,
        mtime: r.get(4)?,
        md5: r.get(5)?,
        is_dir: r.get::<_, i64>(6)? != 0,
        attempts: r.get(7)?,
        upload_id: r.get(8)?,
        parts_json: r.get(9)?,
    })
}

const ITEM_COLS: &str = "src_path, dst_path, size, src_etag, src_mtime, src_md5, is_dir, attempts, upload_id, parts_json";

pub struct JobRow {
    pub id: String,
    pub spec_json: String,
    pub state: JobState,
    pub error: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub cursor_json: Option<String>,
    pub planned: bool,
}

fn job_of(r: &Row) -> rusqlite::Result<JobRow> {
    Ok(JobRow {
        id: r.get(0)?,
        spec_json: r.get(1)?,
        state: JobState::parse(&r.get::<_, String>(2)?),
        error: r.get(3)?,
        created: r.get(4)?,
        updated: r.get(5)?,
        cursor_json: r.get(6)?,
        planned: r.get::<_, i64>(7)? != 0,
    })
}

const JOB_COLS: &str = "id, spec_json, state, error, created, updated, list_cursor_json, planned";

pub fn insert_job(c: &Connection, id: &str, spec_json: &str, state: JobState) -> DbResult<()> {
    let now = now_ms();
    c.execute(
        "INSERT INTO jobs(id, spec_json, state, created, updated) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, spec_json, state.as_str(), now],
    )
    .map_err(e)?;
    Ok(())
}

pub fn job(c: &Connection, id: &str) -> DbResult<Option<JobRow>> {
    c.query_row(&format!("SELECT {JOB_COLS} FROM jobs WHERE id = ?1"), [id], job_of).optional().map_err(e)
}

/// Newest first.
pub fn jobs(c: &Connection) -> DbResult<Vec<JobRow>> {
    let mut st = c.prepare(&format!("SELECT {JOB_COLS} FROM jobs ORDER BY created DESC")).map_err(e)?;
    let rows = st.query_map([], job_of).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
    Ok(rows)
}

pub fn set_state(c: &Connection, id: &str, state: JobState, error: Option<&str>) -> DbResult<()> {
    c.execute("UPDATE jobs SET state = ?2, error = ?3, updated = ?4 WHERE id = ?1", params![id, state.as_str(), error, now_ms()])
        .map_err(e)?;
    Ok(())
}

pub fn delete_job(c: &mut Connection, id: &str) -> DbResult<()> {
    let tx = c.transaction().map_err(e)?;
    tx.execute("DELETE FROM items WHERE job_id = ?1", [id]).map_err(e)?;
    tx.execute("DELETE FROM jobs WHERE id = ?1", [id]).map_err(e)?;
    tx.commit().map_err(e)
}

/// Records one listed page and where listing goes on from, together: a crash between pages
/// re-lists at most one page, and `INSERT OR IGNORE` drops what was already recorded.
pub fn save_page(c: &mut Connection, job_id: &str, items: &[NewItem], cursor_json: Option<&str>) -> DbResult<()> {
    let tx = c.transaction().map_err(e)?;
    insert_items(&tx, job_id, items)?;
    tx.execute("UPDATE jobs SET list_cursor_json = ?2, updated = ?3 WHERE id = ?1", params![job_id, cursor_json, now_ms()]).map_err(e)?;
    tx.commit().map_err(e)
}

fn insert_items(tx: &rusqlite::Transaction, job_id: &str, items: &[NewItem]) -> DbResult<()> {
    let mut ins = tx
        .prepare_cached(
            "INSERT OR IGNORE INTO items(job_id, src_path, dst_path, size, src_etag, src_mtime, src_md5, is_dir, dst_fold, del, state, skip, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CASE WHEN ?11 IS NULL THEN 'pending' ELSE 'failed' END, ?11 IS NOT NULL, ?11)",
        )
        .map_err(e)?;
    for it in items {
        let fold = if it.dst_fold.is_empty() { &it.dst_path } else { &it.dst_fold };
        ins.execute(params![job_id, it.src_path, it.dst_path, it.size, it.etag, it.mtime, it.md5, it.is_dir as i64, fold, it.del as i64, it.not_copied]).map_err(e)?;
    }
    Ok(())
}

/// A job whose items are known up front (a mirror), recorded already planned and all at once:
/// it never starts walking its source the way a copy does.
pub fn insert_planned_job(c: &mut Connection, id: &str, spec_json: &str, items: &[NewItem]) -> DbResult<()> {
    let tx = c.transaction().map_err(e)?;
    let now = now_ms();
    tx.execute(
        "INSERT INTO jobs(id, spec_json, state, created, updated, planned) VALUES (?1, ?2, ?3, ?4, ?4, 1)",
        params![id, spec_json, JobState::Running.as_str(), now],
    )
    .map_err(e)?;
    insert_items(&tx, id, items)?;
    tx.commit().map_err(e)
}

pub fn set_planned(c: &Connection, job_id: &str) -> DbResult<()> {
    c.execute("UPDATE jobs SET planned = 1, list_cursor_json = NULL, updated = ?2 WHERE id = ?1", params![job_id, now_ms()]).map_err(e)?;
    Ok(())
}

/// Items left `running` by a crash or a quit go back in line (their upload ids are kept).
pub fn reset_running(c: &Connection, job_id: Option<&str>) -> DbResult<()> {
    match job_id {
        Some(id) => c.execute("UPDATE items SET state = 'pending' WHERE job_id = ?1 AND state = 'running'", [id]),
        None => c.execute("UPDATE items SET state = 'pending' WHERE state = 'running'", []),
    }
    .map_err(e)?;
    Ok(())
}

/// Takes up to `limit` pending items to copy (folders first, then in path order) and marks them
/// running. A mirror's deletions wait for [`take_deletes`].
pub fn take_pending(c: &mut Connection, job_id: &str, limit: usize) -> DbResult<Vec<Item>> {
    take(c, job_id, limit, "del = 0 ORDER BY is_dir DESC, src_path")
}

/// Takes up to `limit` pending deletions of a mirror (files first, then folders deepest first)
/// and marks them running.
pub fn take_deletes(c: &mut Connection, job_id: &str, limit: usize) -> DbResult<Vec<Item>> {
    take(c, job_id, limit, "del = 1 ORDER BY is_dir, length(dst_path) DESC, dst_path")
}

fn take(c: &mut Connection, job_id: &str, limit: usize, filter_order: &str) -> DbResult<Vec<Item>> {
    let tx = c.transaction().map_err(e)?;
    let items = {
        let mut st = tx
            .prepare_cached(&format!("SELECT {ITEM_COLS} FROM items WHERE job_id = ?1 AND state = 'pending' AND {filter_order} LIMIT ?2"))
            .map_err(e)?;
        st.query_map(params![job_id, limit as i64], item_of).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?
    };
    {
        let mut up = tx.prepare_cached("UPDATE items SET state = 'running' WHERE job_id = ?1 AND src_path = ?2").map_err(e)?;
        for it in &items {
            up.execute(params![job_id, it.src_path]).map_err(e)?;
        }
    }
    tx.commit().map_err(e)?;
    Ok(items)
}

/// How an item ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    /// copied (moves: and the original deleted)
    Done,
    /// copied; for a move the original is still to be deleted
    Copied,
    /// already there: left alone (a move keeps its original)
    Skipped,
    /// already there, and a move still deletes the original
    SkippedCopied,
    /// a file of the same size is there but it couldn't be proven the same: a move keeps the
    /// original
    SkippedUnsure,
    /// the destination is the source itself: nothing to copy, nothing to delete
    InPlace,
}

impl End {
    /// What the item's row says about how it ended, besides its state.
    pub fn note(self) -> Option<&'static str> {
        match self {
            End::SkippedUnsure => {
                Some("Kept the original: a file of the same size is already there, but Kybl couldn't confirm it's identical.")
            }
            End::InPlace => Some("Already in place: this is the same file."),
            _ => None,
        }
    }
}

pub fn finish(c: &Connection, job_id: &str, src: &str, end: End, dst_etag: Option<&str>) -> DbResult<()> {
    let (state, skip) = match end {
        End::Done => ("done", 0),
        End::Copied => ("copied", 0),
        End::Skipped | End::SkippedUnsure => ("skipped", 1),
        End::SkippedCopied => ("copied", 1),
        End::InPlace => ("done", 1),
    };
    c.execute(
        "UPDATE items SET state = ?3, skip = ?4, error = ?6, dst_etag = COALESCE(?5, dst_etag), upload_id = NULL, parts_json = NULL
         WHERE job_id = ?1 AND src_path = ?2",
        params![job_id, src, state, skip, dst_etag, end.note()],
    )
    .map_err(e)?;
    Ok(())
}

/// The copy as it was written (or found, for a move's skipped file), so the original is only
/// deleted while the copy is still exactly that.
pub fn record_dst(c: &Connection, job_id: &str, src: &str, etag: Option<&str>, size: i64, mtime: Option<i64>) -> DbResult<()> {
    c.execute(
        "UPDATE items SET dst_etag = ?3, dst_size = ?4, dst_mtime = ?5 WHERE job_id = ?1 AND src_path = ?2",
        params![job_id, src, etag, size, mtime],
    )
    .map_err(e)?;
    Ok(())
}

/// Another file of the job lands on `fold` (a folded destination path).
pub fn dst_taken(c: &Connection, job_id: &str, fold: &str, except_src: &str) -> DbResult<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM items WHERE job_id = ?1 AND dst_fold = ?2 AND src_path != ?3)",
        params![job_id, fold, except_src],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .map_err(e)
}

/// Originals of a move deleted: their items are done.
pub fn deleted(c: &mut Connection, job_id: &str, srcs: &[String]) -> DbResult<()> {
    let tx = c.transaction().map_err(e)?;
    {
        let mut up = tx.prepare_cached("UPDATE items SET state = 'done' WHERE job_id = ?1 AND src_path = ?2 AND state = 'copied'").map_err(e)?;
        for s in srcs {
            up.execute(params![job_id, s]).map_err(e)?;
        }
    }
    tx.commit().map_err(e)
}

pub fn fail(c: &Connection, job_id: &str, src: &str, error: &str) -> DbResult<()> {
    c.execute(
        "UPDATE items SET state = 'failed', skip = 0, error = ?3, attempts = attempts + 1 WHERE job_id = ?1 AND src_path = ?2",
        params![job_id, src, error],
    )
    .map_err(e)?;
    Ok(())
}

/// Back in line; `tried` counts the attempt (network drops and pauses don't).
pub fn requeue(c: &Connection, job_id: &str, src: &str, tried: bool, error: Option<&str>) -> DbResult<()> {
    c.execute(
        "UPDATE items SET state = 'pending', attempts = attempts + ?3, error = ?4 WHERE job_id = ?1 AND src_path = ?2",
        params![job_id, src, tried as i64, error],
    )
    .map_err(e)?;
    Ok(())
}

/// The source changed since planning: copy what is there now.
pub fn update_src(c: &Connection, job_id: &str, src: &str, size: i64, etag: Option<&str>, mtime: Option<i64>, md5: Option<&str>) -> DbResult<()> {
    c.execute(
        "UPDATE items SET size = ?3, src_etag = ?4, src_mtime = ?5, src_md5 = ?6, upload_id = NULL, parts_json = NULL
         WHERE job_id = ?1 AND src_path = ?2",
        params![job_id, src, size, etag, mtime, md5],
    )
    .map_err(e)?;
    Ok(())
}

pub fn set_dst_path(c: &Connection, job_id: &str, src: &str, dst: &str, fold: &str) -> DbResult<()> {
    c.execute("UPDATE items SET dst_path = ?3, dst_fold = ?4 WHERE job_id = ?1 AND src_path = ?2", params![job_id, src, dst, fold]).map_err(e)?;
    Ok(())
}

/// The multipart upload of an item, saved as it goes so a restart can carry on with it.
pub fn set_upload(c: &Connection, job_id: &str, src: &str, upload_id: Option<&str>, parts_json: Option<&str>) -> DbResult<()> {
    c.execute(
        "UPDATE items SET upload_id = ?3, parts_json = ?4 WHERE job_id = ?1 AND src_path = ?2",
        params![job_id, src, upload_id, parts_json],
    )
    .map_err(e)?;
    Ok(())
}

/// Unfinished uploads of a job: (destination path, upload id), to abort on cancel.
pub fn open_uploads(c: &Connection, job_id: &str) -> DbResult<Vec<(String, String)>> {
    let mut st = c.prepare("SELECT dst_path, upload_id FROM items WHERE job_id = ?1 AND upload_id IS NOT NULL").map_err(e)?;
    let rows = st.query_map([job_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
    Ok(rows)
}

pub fn clear_uploads(c: &Connection, job_id: &str) -> DbResult<()> {
    c.execute("UPDATE items SET upload_id = NULL, parts_json = NULL WHERE job_id = ?1", [job_id]).map_err(e)?;
    Ok(())
}

/// A copied file of a move whose original is still to be deleted, with what both sides were.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CopiedFile {
    pub src_path: String,
    pub dst_path: String,
    pub size: i64,
    pub src_etag: Option<String>,
    pub src_mtime: Option<i64>,
    pub dst_etag: Option<String>,
    /// None for rows written before this was recorded
    pub dst_size: Option<i64>,
}

/// Copied files of a move whose originals are still to be deleted.
pub fn copied(c: &Connection, job_id: &str, limit: usize) -> DbResult<Vec<CopiedFile>> {
    let mut st = c
        .prepare_cached(
            "SELECT src_path, dst_path, size, src_etag, src_mtime, dst_etag, dst_size FROM items
             WHERE job_id = ?1 AND state = 'copied' AND is_dir = 0 ORDER BY src_path LIMIT ?2",
        )
        .map_err(e)?;
    let rows = st
        .query_map(params![job_id, limit as i64], |r| {
            Ok(CopiedFile {
                src_path: r.get(0)?,
                dst_path: r.get(1)?,
                size: r.get(2)?,
                src_etag: r.get(3)?,
                src_mtime: r.get(4)?,
                dst_etag: r.get(5)?,
                dst_size: r.get(6)?,
            })
        })
        .map_err(e)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e)?;
    Ok(rows)
}

/// Folders of a move, deepest first (emptied ones are removed at the end).
pub fn moved_dirs(c: &Connection, job_id: &str) -> DbResult<Vec<String>> {
    let mut st = c
        .prepare("SELECT src_path FROM items WHERE job_id = ?1 AND is_dir = 1 AND state IN ('done', 'copied') ORDER BY length(src_path) DESC, src_path")
        .map_err(e)?;
    let rows = st.query_map([job_id], |r| r.get(0)).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
    Ok(rows)
}

/// Whether any file or folder of the job lies inside the folder `dir` (ends with `/`).
pub fn has_children(c: &Connection, job_id: &str, dir: &str) -> DbResult<bool> {
    // the range of keys starting with `dir`: `dir` itself sorts first, and nothing that starts
    // with `dir` sorts at or after `dir` + U+10FFFF
    let hi = format!("{dir}\u{10FFFF}");
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM items WHERE job_id = ?1 AND src_path > ?2 AND src_path < ?3)",
        params![job_id, dir, hi],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .map_err(e)
}

pub fn failures(c: &Connection, job_id: &str, offset: u64, limit: u64) -> DbResult<Vec<Failure>> {
    let mut st = c
        .prepare("SELECT CASE del WHEN 1 THEN dst_path ELSE src_path END, COALESCE(error, '') FROM items WHERE job_id = ?1 AND state = 'failed' ORDER BY src_path LIMIT ?2 OFFSET ?3")
        .map_err(e)?;
    let rows = st
        .query_map(params![job_id, limit as i64, offset as i64], |r| Ok(Failure { path: r.get(0)?, error: r.get(1)? }))
        .map_err(e)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(e)?;
    Ok(rows)
}

pub fn retry_failed(c: &Connection, job_id: &str) -> DbResult<usize> {
    c.execute("UPDATE items SET state = 'pending', attempts = 0, error = NULL WHERE job_id = ?1 AND state = 'failed' AND skip = 0", [job_id]).map_err(e)
}

/// Totals of a job's files (folders aren't counted).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub files_total: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub bytes_done: u64,
    pub files_skipped: u64,
    pub bytes_skipped: u64,
    pub files_failed: u64,
    pub bytes_failed: u64,
    /// files still to copy (pending or running)
    pub files_left: u64,
    /// copied files of a move whose originals aren't deleted yet
    pub files_copied: u64,
}

pub fn counts(c: &Connection, job_id: &str) -> DbResult<Counts> {
    let mut st = c
        .prepare_cached("SELECT state, skip, COUNT(*), COALESCE(SUM(size), 0) FROM items WHERE job_id = ?1 AND is_dir = 0 GROUP BY state, skip")
        .map_err(e)?;
    let mut n = Counts::default();
    let rows = st
        .query_map([job_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)?.max(0) as u64)))
        .map_err(e)?;
    for row in rows {
        let (state, skip, files, bytes) = row.map_err(e)?;
        n.files_total += files;
        n.bytes_total += bytes;
        if state == "copied" {
            n.files_copied += files;
        }
        match (state.as_str(), skip != 0) {
            ("done" | "copied" | "skipped", true) | ("skipped", false) => {
                n.files_skipped += files;
                n.bytes_skipped += bytes;
            }
            ("done" | "copied", false) => {
                n.files_done += files;
                n.bytes_done += bytes;
            }
            ("failed", _) => {
                n.files_failed += files;
                n.bytes_failed += bytes;
            }
            _ => n.files_left += files,
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        crate::db::open_in_memory(MIGRATIONS).unwrap()
    }

    fn file(p: &str, size: i64) -> NewItem {
        NewItem { src_path: p.into(), dst_path: format!("d/{p}"), size, ..Default::default() }
    }

    #[test]
    fn pages_are_recorded_once_and_counted() {
        let mut c = conn();
        insert_job(&c, "j", "{}", JobState::Planning).unwrap();
        let page = [file("a", 10), file("b", 20), NewItem { src_path: "x/".into(), dst_path: "d/x/".into(), is_dir: true, ..Default::default() }];
        save_page(&mut c, "j", &page, Some("{\"c\":1}")).unwrap();
        // the same page again after a crash: nothing doubles
        save_page(&mut c, "j", &page, Some("{\"c\":2}")).unwrap();
        assert_eq!(job(&c, "j").unwrap().unwrap().cursor_json.as_deref(), Some("{\"c\":2}"));
        let n = counts(&c, "j").unwrap();
        assert_eq!((n.files_total, n.bytes_total, n.files_left), (2, 30, 2));
        assert!(has_children(&c, "j", "").unwrap());
        assert!(!has_children(&c, "j", "x/").unwrap());

        let got = take_pending(&mut c, "j", 10).unwrap();
        assert_eq!(got.iter().map(|i| i.src_path.as_str()).collect::<Vec<_>>(), ["x/", "a", "b"], "folders first");
        assert!(take_pending(&mut c, "j", 10).unwrap().is_empty(), "taken items are running");
        finish(&c, "j", "a", End::Copied, Some("e")).unwrap();
        finish(&c, "j", "b", End::SkippedCopied, None).unwrap();
        let n = counts(&c, "j").unwrap();
        assert_eq!((n.files_done, n.files_skipped, n.files_copied, n.files_left), (1, 1, 2, 0));
        let left = copied(&c, "j", 10).unwrap();
        assert_eq!(left.iter().map(|f| f.src_path.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!((left[0].dst_etag.as_deref(), left[0].dst_path.as_str(), left[0].dst_size), (Some("e"), "d/a", None));
        record_dst(&c, "j", "a", Some("e2"), 10, Some(5)).unwrap();
        assert_eq!(copied(&c, "j", 10).unwrap()[0].dst_size, Some(10));
        deleted(&mut c, "j", &["a".into(), "b".into()]).unwrap();
        let n = counts(&c, "j").unwrap();
        assert_eq!((n.files_done, n.files_skipped, n.files_copied), (1, 1, 0));
    }

    #[test]
    fn running_items_go_back_in_line_and_failures_retry() {
        let mut c = conn();
        insert_job(&c, "j", "{}", JobState::Running).unwrap();
        save_page(&mut c, "j", &[file("a", 1), file("b", 2)], None).unwrap();
        let _ = take_pending(&mut c, "j", 10).unwrap();
        set_upload(&c, "j", "a", Some("up-1"), Some("[]")).unwrap();
        reset_running(&c, None).unwrap();
        let again = take_pending(&mut c, "j", 10).unwrap();
        assert_eq!(again.len(), 2);
        assert_eq!(again[0].upload_id.as_deref(), Some("up-1"), "the upload id survives");
        assert_eq!(open_uploads(&c, "j").unwrap(), [("d/a".to_string(), "up-1".to_string())]);
        fail(&c, "j", "b", "nope").unwrap();
        assert_eq!(failures(&c, "j", 0, 10).unwrap(), [Failure { path: "b".into(), error: "nope".into() }]);
        assert_eq!(counts(&c, "j").unwrap().files_failed, 1);
        assert_eq!(retry_failed(&c, "j").unwrap(), 1);
        assert_eq!(counts(&c, "j").unwrap().files_failed, 0);
        delete_job(&mut c, "j").unwrap();
        assert!(job(&c, "j").unwrap().is_none());
    }
}
