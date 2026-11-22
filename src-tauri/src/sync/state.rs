//! sync.db: what each mapping knows between runs.
//!
//! * `base`: both sides of every path as they were when it was last in sync (see plan.rs).
//! * `tombstones`: deletions Kybl made, kept 30 days.
//! * `cursors`: the remote change cursor, when the last full scan and the last sync were, and
//!   whether the user confirmed the held deletions.
//! * `pending`: deletions the mass-delete guard is holding for the user.
//! * `conflicts`: conflict copies made, until the user settles them.
//!
//! One-way sync kept a JSON file per mapping (`sync/<id>.json`). The first open of a mapping
//! imports it in one transaction and only then renames it to `<id>.json.bak`, so a failed import
//! loses nothing and is tried again next start.
//!
//! The base is written after every finished file, so a run that ends half-way (quit, crash,
//! network) loses nothing it did.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
    time::Duration,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::plan::{nfc, BaseEntry, Side, Tombstone, TOMBSTONE_KEEP_MS};

/// The schema, one migration per release that changes it (append only; see `open`).
const MIGRATIONS: &[&str] = &["
CREATE TABLE base(
    mapping_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file',
    l_size INTEGER NOT NULL, l_mtime INTEGER NOT NULL, l_fileid TEXT,
    r_etag TEXT NOT NULL DEFAULT '', r_size INTEGER NOT NULL, r_mtime INTEGER NOT NULL DEFAULT 0, r_id TEXT,
    hash TEXT, pinned INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(mapping_id, path)
) WITHOUT ROWID;
CREATE TABLE tombstones(
    mapping_id TEXT NOT NULL, path TEXT NOT NULL, side TEXT NOT NULL, deleted_at INTEGER NOT NULL, base_json TEXT NOT NULL,
    PRIMARY KEY(mapping_id, path, side)
) WITHOUT ROWID;
CREATE TABLE cursors(
    mapping_id TEXT PRIMARY KEY NOT NULL, remote_cursor TEXT, last_full_scan INTEGER, last_sync INTEGER,
    confirm_deletes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pending(
    mapping_id TEXT NOT NULL, path TEXT NOT NULL, side TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(mapping_id, path, side)
) WITHOUT ROWID;
CREATE TABLE conflicts(
    mapping_id TEXT NOT NULL, copy TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(mapping_id, copy)
) WITHOUT ROWID;
"];

/// Opens a database and brings its schema up to date: migration `n` runs once, when `PRAGMA
/// user_version` is below `n`, in a transaction that also bumps the version. A file from a newer
/// Kybl is refused rather than written with an older schema.
///
/// The same helper as the job engine's `db::open` (WP-B1); once both have landed this can call
/// that one instead.
fn open_with(conn: &mut Connection, migrations: &[&str]) -> Result<(), String> {
    let e = |e: rusqlite::Error| format!("Couldn't open the sync database: {e}");
    conn.busy_timeout(Duration::from_secs(5)).map_err(e)?;
    // answers the new mode ("memory" for in-memory databases), so read it as a row
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(())).map_err(e)?;
    conn.execute_batch("PRAGMA synchronous = NORMAL;").map_err(e)?;
    let have: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(e)?;
    if have > migrations.len() as i64 {
        return Err("The sync database was made by a newer version of Kybl. Update Kybl to sync these folders.".into());
    }
    for (i, sql) in migrations.iter().enumerate().skip(have as usize) {
        let tx = conn.transaction().map_err(e)?;
        tx.execute_batch(sql).map_err(|err| format!("Sync database upgrade {} failed: {err}", i + 1))?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).map_err(e)?;
        tx.commit().map_err(e)?;
    }
    Ok(())
}

fn db_err(e: rusqlite::Error) -> String {
    format!("The sync database failed: {e}")
}

/// A deletion held by the mass-delete guard.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingDelete {
    pub path: String,
    /// where it would be deleted
    pub side: Side,
    pub size: u64,
}

/// A conflict copy waiting for the user.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRow {
    /// the file that kept its name (the other side's version)
    pub path: String,
    /// this computer's version, renamed
    pub copy: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cursor {
    pub remote_cursor: Option<String>,
    pub last_full_scan: Option<i64>,
    pub last_sync: Option<i64>,
    pub confirm_deletes: bool,
}

/// One-way sync's per-mapping JSON (`sync/<id>.json`).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LegacyDb {
    #[serde(default)]
    last_sync: Option<i64>,
    #[serde(default)]
    files: HashMap<String, LegacyTracked>,
}

#[derive(Deserialize, Default)]
struct LegacyTracked {
    size: u64,
    mtime: i64,
    #[serde(default)]
    etag: String,
}

pub struct SyncDb {
    conn: Mutex<Connection>,
}

impl SyncDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the folder for the sync database: {e}"))?;
        }
        let mut conn = Connection::open(path).map_err(db_err)?;
        open_with(&mut conn, MIGRATIONS)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        let mut conn = Connection::open_in_memory().unwrap();
        open_with(&mut conn, MIGRATIONS).unwrap();
        Self { conn: Mutex::new(conn) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut c = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut c).map_err(db_err)
    }

    /// Imports one-way sync's `json` for `id` if it is there, then keeps it as `.bak`. True when
    /// something was imported.
    pub fn import_legacy(&self, id: &str, json: &Path) -> Result<bool, String> {
        let Ok(raw) = std::fs::read(json) else { return Ok(false) };
        let legacy: LegacyDb = serde_json::from_slice(&raw).map_err(|e| format!("Couldn't read {}: {e}", json.display()))?;
        let imported = self.with(|c| {
            // already imported (the rename failed last time): don't overwrite newer state
            let have: i64 = c.query_row("SELECT COUNT(*) FROM base WHERE mapping_id = ?1", [id], |r| r.get(0))?;
            let known: Option<i64> = c.query_row("SELECT 1 FROM cursors WHERE mapping_id = ?1", [id], |r| r.get(0)).optional()?;
            if have > 0 || known.is_some() {
                return Ok(false);
            }
            let tx = c.transaction()?;
            {
                let mut ins = tx.prepare(
                    "INSERT OR REPLACE INTO base(mapping_id, path, l_size, l_mtime, r_etag, r_size, r_mtime, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
                )?;
                for (path, t) in &legacy.files {
                    ins.execute(params![id, nfc(path), t.size as i64, t.mtime, t.etag, t.size as i64, legacy.last_sync.unwrap_or(0)])?;
                }
            }
            tx.execute("INSERT OR REPLACE INTO cursors(mapping_id, last_sync) VALUES (?1, ?2)", params![id, legacy.last_sync])?;
            tx.commit()?;
            Ok(true)
        })?;
        let mut bak = json.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::rename(json, &bak).map_err(|e| format!("Couldn't keep {} as a backup: {e}", json.display()))?;
        Ok(imported)
    }

    // ---------------------------------------------------------------- base

    pub fn load_base(&self, id: &str) -> Result<HashMap<String, BaseEntry>, String> {
        self.with(|c| {
            let mut q = c.prepare("SELECT path, l_size, l_mtime, l_fileid, r_etag, r_size, r_mtime, r_id FROM base WHERE mapping_id = ?1")?;
            let rows = q.query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    BaseEntry {
                        l_size: r.get::<_, i64>(1)?.max(0) as u64,
                        l_mtime: r.get(2)?,
                        l_fileid: r.get(3)?,
                        r_etag: r.get(4)?,
                        r_size: r.get::<_, i64>(5)?.max(0) as u64,
                        r_mtime: r.get(6)?,
                        r_id: r.get(7)?,
                    },
                ))
            })?;
            rows.collect()
        })
    }

    pub fn base_count(&self, id: &str) -> Result<usize, String> {
        self.with(|c| c.query_row("SELECT COUNT(*) FROM base WHERE mapping_id = ?1", [id], |r| r.get::<_, i64>(0)).map(|n| n as usize))
    }

    pub fn put_base(&self, id: &str, path: &str, b: &BaseEntry, now: i64) -> Result<(), String> {
        self.put_base_many(id, &[(path.to_string(), b.clone())], now)
    }

    pub fn put_base_many(&self, id: &str, items: &[(String, BaseEntry)], now: i64) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        self.with(|c| {
            let tx = c.transaction()?;
            {
                let mut ins = tx.prepare(
                    "INSERT OR REPLACE INTO base(mapping_id, path, l_size, l_mtime, l_fileid, r_etag, r_size, r_mtime, r_id, synced_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )?;
                for (p, b) in items {
                    ins.execute(params![id, p, b.l_size as i64, b.l_mtime, b.l_fileid, b.r_etag, b.r_size as i64, b.r_mtime, b.r_id, now])?;
                }
            }
            tx.commit()
        })
    }

    pub fn drop_base_many(&self, id: &str, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        self.with(|c| {
            let tx = c.transaction()?;
            {
                let mut del = tx.prepare("DELETE FROM base WHERE mapping_id = ?1 AND path = ?2")?;
                for p in paths {
                    del.execute(params![id, p])?;
                }
            }
            tx.commit()
        })
    }

    /// Moves a path's base to a new name (a rename carried out on the other side).
    pub fn move_base(&self, id: &str, from: &str, to: &str, b: &BaseEntry, now: i64) -> Result<(), String> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM base WHERE mapping_id = ?1 AND path = ?2", params![id, from])?;
            tx.execute(
                "INSERT OR REPLACE INTO base(mapping_id, path, l_size, l_mtime, l_fileid, r_etag, r_size, r_mtime, r_id, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![id, to, b.l_size as i64, b.l_mtime, b.l_fileid, b.r_etag, b.r_size as i64, b.r_mtime, b.r_id, now],
            )?;
            tx.commit()
        })
    }

    // ---------------------------------------------------------------- tombstones

    pub fn tombstones(&self, id: &str) -> Result<Vec<Tombstone>, String> {
        let rows: Vec<(String, String, i64, String)> = self.with(|c| {
            let mut q = c.prepare("SELECT path, side, deleted_at, base_json FROM tombstones WHERE mapping_id = ?1")?;
            let rows = q.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect()
        })?;
        Ok(rows
            .into_iter()
            .filter_map(|(path, side, deleted_at, json)| {
                Some(Tombstone { path, side: Side::parse(&side)?, base: serde_json::from_str(&json).ok()?, deleted_at })
            })
            .collect())
    }

    pub fn put_tombstone(&self, id: &str, path: &str, side: Side, base: &BaseEntry, now: i64) -> Result<(), String> {
        let json = serde_json::to_string(base).map_err(|e| e.to_string())?;
        self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO tombstones(mapping_id, path, side, deleted_at, base_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, path, side.as_str(), now, json],
            )
            .map(|_| ())
        })
    }

    pub fn clear_tombstones(&self, id: &str, items: &[(String, Side)]) -> Result<(), String> {
        self.with(|c| {
            let tx = c.transaction()?;
            {
                let mut del = tx.prepare("DELETE FROM tombstones WHERE mapping_id = ?1 AND path = ?2 AND side = ?3")?;
                for (p, side) in items {
                    del.execute(params![id, p, side.as_str()])?;
                }
            }
            tx.commit()
        })
    }

    /// Forgets tombstones older than 30 days.
    pub fn purge_tombstones(&self, now: i64) -> Result<(), String> {
        self.with(|c| c.execute("DELETE FROM tombstones WHERE deleted_at < ?1", [now - TOMBSTONE_KEEP_MS]).map(|_| ()))
    }

    // ---------------------------------------------------------------- cursors

    pub fn cursor(&self, id: &str) -> Result<Cursor, String> {
        self.with(|c| {
            c.query_row(
                "SELECT remote_cursor, last_full_scan, last_sync, confirm_deletes FROM cursors WHERE mapping_id = ?1",
                [id],
                |r| Ok(Cursor { remote_cursor: r.get(0)?, last_full_scan: r.get(1)?, last_sync: r.get(2)?, confirm_deletes: r.get::<_, i64>(3)? != 0 }),
            )
            .optional()
            .map(Option::unwrap_or_default)
        })
    }

    fn set_cursor_col(&self, id: &str, col: &str, v: &dyn rusqlite::ToSql) -> Result<(), String> {
        // `col` is one of ours, never input
        let sql = format!("INSERT INTO cursors(mapping_id, {col}) VALUES (?1, ?2) ON CONFLICT(mapping_id) DO UPDATE SET {col} = excluded.{col}");
        self.with(|c| c.execute(&sql, params![id, v]).map(|_| ()))
    }

    pub fn set_last_sync(&self, id: &str, at: i64) -> Result<(), String> {
        self.set_cursor_col(id, "last_sync", &at)
    }

    pub fn set_full_scan(&self, id: &str, at: i64, remote_cursor: Option<&str>) -> Result<(), String> {
        self.set_cursor_col(id, "last_full_scan", &at)?;
        self.set_remote_cursor(id, remote_cursor)
    }

    pub fn set_remote_cursor(&self, id: &str, remote_cursor: Option<&str>) -> Result<(), String> {
        self.set_cursor_col(id, "remote_cursor", &remote_cursor)
    }

    // ---------------------------------------------------------------- held deletions

    pub fn pending(&self, id: &str) -> Result<Vec<PendingDelete>, String> {
        let rows: Vec<(String, String, i64)> = self.with(|c| {
            let mut q = c.prepare("SELECT path, side, size FROM pending WHERE mapping_id = ?1 ORDER BY path")?;
            let rows = q.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect()
        })?;
        Ok(rows.into_iter().filter_map(|(path, side, size)| Some(PendingDelete { path, side: Side::parse(&side)?, size: size.max(0) as u64 })).collect())
    }

    /// Replaces the held deletions (a run found these; none clears them).
    pub fn set_pending(&self, id: &str, items: &[PendingDelete]) -> Result<(), String> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM pending WHERE mapping_id = ?1", [id])?;
            {
                let mut ins = tx.prepare("INSERT OR REPLACE INTO pending(mapping_id, path, side, size) VALUES (?1, ?2, ?3, ?4)")?;
                for p in items {
                    ins.execute(params![id, p.path, p.side.as_str(), p.size as i64])?;
                }
            }
            tx.commit()
        })
    }

    /// The deletions the user confirmed (the held ones, once "Confirm deletions" was pressed).
    pub fn confirmed(&self, id: &str) -> Result<HashSet<(String, Side)>, String> {
        if !self.cursor(id)?.confirm_deletes {
            return Ok(HashSet::new());
        }
        Ok(self.pending(id)?.into_iter().map(|p| (p.path, p.side)).collect())
    }

    pub fn set_confirm(&self, id: &str, on: bool) -> Result<(), String> {
        self.set_cursor_col(id, "confirm_deletes", &(on as i64))
    }

    /// "Keep the files": forgets the base of every held deletion (so the next run copies them
    /// back where they were deleted) and their tombstones.
    pub fn restore_pending(&self, id: &str) -> Result<usize, String> {
        let items = self.pending(id)?;
        let paths: Vec<String> = items.iter().map(|p| p.path.clone()).collect();
        self.drop_base_many(id, &paths)?;
        self.clear_tombstones(id, &[paths.iter().map(|p| (p.clone(), Side::Local)).collect::<Vec<_>>(), paths.iter().map(|p| (p.clone(), Side::Remote)).collect()].concat())?;
        self.set_pending(id, &[])?;
        self.set_confirm(id, false)?;
        Ok(items.len())
    }

    // ---------------------------------------------------------------- conflicts

    pub fn conflicts(&self, id: &str) -> Result<Vec<ConflictRow>, String> {
        self.with(|c| {
            let mut q = c.prepare("SELECT path, copy, created_at FROM conflicts WHERE mapping_id = ?1 ORDER BY created_at DESC, path")?;
            let rows = q.query_map([id], |r| Ok(ConflictRow { path: r.get(0)?, copy: r.get(1)?, created_at: r.get(2)? }))?;
            rows.collect()
        })
    }

    pub fn add_conflict(&self, id: &str, path: &str, copy: &str, now: i64) -> Result<(), String> {
        self.with(|c| {
            c.execute("INSERT OR REPLACE INTO conflicts(mapping_id, copy, path, created_at) VALUES (?1, ?2, ?3, ?4)", params![id, copy, path, now]).map(|_| ())
        })
    }

    pub fn remove_conflict(&self, id: &str, copy: &str) -> Result<(), String> {
        self.with(|c| c.execute("DELETE FROM conflicts WHERE mapping_id = ?1 AND copy = ?2", params![id, copy]).map(|_| ()))
    }

    // ---------------------------------------------------------------- whole mappings

    /// Everything known about a mapping (it was removed, or now points somewhere else).
    pub fn forget(&self, id: &str) -> Result<(), String> {
        self.with(|c| {
            let tx = c.transaction()?;
            for t in ["base", "tombstones", "cursors", "pending", "conflicts"] {
                tx.execute(&format!("DELETE FROM {t} WHERE mapping_id = ?1"), [id])?;
            }
            tx.commit()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(n: u64) -> BaseEntry {
        BaseEntry { l_size: n, l_mtime: 5, r_etag: format!("e{n}"), r_size: n, r_mtime: 7, ..Default::default() }
    }

    #[test]
    fn base_rows_round_trip() {
        let db = SyncDb::in_memory();
        db.put_base_many("m", &[("a".into(), b(1)), ("dir/b".into(), b(2))], 9).unwrap();
        db.put_base("other", "a", &b(3), 9).unwrap();
        let base = db.load_base("m").unwrap();
        assert_eq!(base.len(), 2);
        assert_eq!(base["dir/b"], b(2));
        db.move_base("m", "a", "c", &b(4), 9).unwrap();
        let base = db.load_base("m").unwrap();
        assert!(!base.contains_key("a"));
        assert_eq!(base["c"], b(4));
        db.drop_base_many("m", &["c".into()]).unwrap();
        assert_eq!(db.base_count("m").unwrap(), 1);
        db.forget("m").unwrap();
        assert_eq!(db.base_count("m").unwrap(), 0);
        assert_eq!(db.base_count("other").unwrap(), 1);
    }

    #[test]
    fn one_way_json_is_imported_once_and_kept_as_a_backup() {
        let dir = std::env::temp_dir().join(format!("kybl-syncdb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let json = dir.join("m1.json");
        std::fs::write(&json, r#"{"lastSync":1234,"files":{"a.txt":{"size":3,"mtime":10,"etag":"x"},"café.txt":{"size":1,"mtime":2}}}"#).unwrap();
        let db = SyncDb::open(&dir.join("sync.db")).unwrap();
        assert!(db.import_legacy("m1", &json).unwrap());
        assert!(!json.exists());
        assert!(dir.join("m1.json.bak").exists());
        let base = db.load_base("m1").unwrap();
        assert_eq!(base["a.txt"], BaseEntry { l_size: 3, l_mtime: 10, r_etag: "x".into(), r_size: 3, ..Default::default() });
        assert!(base.contains_key("caf\u{e9}.txt"), "names are stored NFC");
        assert_eq!(db.cursor("m1").unwrap().last_sync, Some(1234));
        // nothing to import the second time; a stray json never overwrites newer state
        assert!(!db.import_legacy("m1", &json).unwrap());
        std::fs::write(&json, r#"{"files":{}}"#).unwrap();
        assert!(!db.import_legacy("m1", &json).unwrap());
        assert_eq!(db.base_count("m1").unwrap(), 2);
        // reopening keeps everything (WAL)
        drop(db);
        let db = SyncDb::open(&dir.join("sync.db")).unwrap();
        assert_eq!(db.base_count("m1").unwrap(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_json_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("kybl-syncdb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let json = dir.join("m.json");
        std::fs::write(&json, "{nope").unwrap();
        let db = SyncDb::in_memory();
        assert!(db.import_legacy("m", &json).is_err());
        assert!(json.exists(), "kept for the next try");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn held_deletions_confirm_and_restore() {
        let db = SyncDb::in_memory();
        db.put_base_many("m", &[("a".into(), b(1)), ("b".into(), b(2))], 1).unwrap();
        let items = vec![PendingDelete { path: "a".into(), side: Side::Remote, size: 1 }];
        db.set_pending("m", &items).unwrap();
        assert!(db.confirmed("m").unwrap().is_empty(), "nothing confirmed yet");
        db.set_confirm("m", true).unwrap();
        assert_eq!(db.confirmed("m").unwrap(), HashSet::from([("a".to_string(), Side::Remote)]));
        db.put_tombstone("m", "a", Side::Remote, &b(1), 5).unwrap();
        assert_eq!(db.restore_pending("m").unwrap(), 1);
        assert!(db.pending("m").unwrap().is_empty());
        assert!(!db.load_base("m").unwrap().contains_key("a"), "forgotten, so it is copied back");
        assert!(db.tombstones("m").unwrap().is_empty());
        assert!(!db.cursor("m").unwrap().confirm_deletes);
    }

    #[test]
    fn tombstones_and_conflicts() {
        let db = SyncDb::in_memory();
        db.put_tombstone("m", "a", Side::Local, &b(1), 100).unwrap();
        db.put_tombstone("m", "old", Side::Remote, &b(2), 0).unwrap();
        assert_eq!(db.tombstones("m").unwrap().len(), 2);
        db.purge_tombstones(TOMBSTONE_KEEP_MS + 50).unwrap();
        let t = db.tombstones("m").unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].path.as_str(), t[0].side, t[0].base.clone()), ("a", Side::Local, b(1)));
        db.add_conflict("m", "x.txt", "x (conflict Mac 2026-11-22).txt", 3).unwrap();
        assert_eq!(db.conflicts("m").unwrap()[0].path, "x.txt");
        db.remove_conflict("m", "x (conflict Mac 2026-11-22).txt").unwrap();
        assert!(db.conflicts("m").unwrap().is_empty());
        db.set_full_scan("m", 42, Some("c1")).unwrap();
        db.set_last_sync("m", 43).unwrap();
        assert_eq!(db.cursor("m").unwrap(), Cursor { remote_cursor: Some("c1".into()), last_full_scan: Some(42), last_sync: Some(43), confirm_deletes: false });
    }
}
