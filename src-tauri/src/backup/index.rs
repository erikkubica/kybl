//! backup.db: the sets, what each has backed up (`backup_items`), what waits to go up
//! (`pending`, with the failures among them) and how the last run went.
//!
//! `backup_items` is the dedupe index: an item is uploaded again only when its version key
//! (modified + size, or what the phone knows better) changes. Deleting something on the phone
//! never touches it, and nothing here ever deletes on the destination.

use rusqlite::{params, Connection, OptionalExtension};

use super::types::{BackupSet, Failure, Item, ItemKind, Offer};

pub const MIGRATIONS: &[&str] = &["
CREATE TABLE sets(
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    created INTEGER NOT NULL
);
CREATE TABLE backup_items(
    set_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    version_key TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT,
    uploaded_at INTEGER NOT NULL,
    PRIMARY KEY(set_id, source_id)
);
CREATE INDEX backup_items_path ON backup_items(set_id, remote_path);
CREATE TABLE pending(
    set_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    version_key TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    offered_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    failed_at INTEGER,
    PRIMARY KEY(set_id, source_id)
);
CREATE TABLE runs(
    set_id TEXT PRIMARY KEY,
    last_start INTEGER,
    last_end INTEGER,
    last_error TEXT
);
"];

/// Automatic runs try a failing item this many times; then it waits for "Try again".
pub const MAX_ATTEMPTS: i64 = 3;

fn e(e: rusqlite::Error) -> String {
    format!("Backup database: {e}")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---------------------------------------------------------------- sets

pub fn sets(c: &Connection) -> Result<Vec<BackupSet>, String> {
    let mut st = c.prepare("SELECT json FROM sets ORDER BY created, id").map_err(e)?;
    let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
    let mut out = Vec::new();
    for json in rows {
        // a set written by a newer Kybl that this one can't read is left alone, not dropped
        if let Ok(s) = serde_json::from_str::<BackupSet>(&json.map_err(e)?) {
            out.push(s);
        }
    }
    Ok(out)
}

pub fn set(c: &Connection, id: &str) -> Result<Option<BackupSet>, String> {
    let json: Option<String> = c.query_row("SELECT json FROM sets WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(e)?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

pub fn save_set(c: &Connection, s: &BackupSet) -> Result<(), String> {
    let json = serde_json::to_string(s).map_err(|x| x.to_string())?;
    c.execute(
        "INSERT INTO sets(id, json, created) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![s.id, json, s.created],
    )
    .map_err(e)?;
    Ok(())
}

/// Removes a set and what it knows. The files already backed up stay where they are.
pub fn delete_set(c: &Connection, id: &str) -> Result<(), String> {
    for t in ["sets WHERE id", "backup_items WHERE set_id", "pending WHERE set_id", "runs WHERE set_id"] {
        c.execute(&format!("DELETE FROM {t} = ?1"), [id]).map_err(e)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- the index

/// What the index knows of one item: (version key, remote path).
pub fn backed_up(c: &Connection, set_id: &str, source_id: &str) -> Result<Option<(String, String)>, String> {
    c.query_row(
        "SELECT version_key, remote_path FROM backup_items WHERE set_id = ?1 AND source_id = ?2",
        params![set_id, source_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(e)
}

/// Another item of the set already went to `remote_path`.
pub fn path_claimed(c: &Connection, set_id: &str, remote_path: &str, by_other_than: &str) -> Result<bool, String> {
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM backup_items WHERE set_id = ?1 AND remote_path = ?2 AND source_id != ?3",
            params![set_id, remote_path, by_other_than],
            |r| r.get(0),
        )
        .map_err(e)?;
    Ok(n > 0)
}

pub fn record(c: &Connection, set_id: &str, source_id: &str, version_key: &str, remote_path: &str, size: i64) -> Result<(), String> {
    c.execute(
        "INSERT INTO backup_items(set_id, source_id, version_key, remote_path, size, uploaded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(set_id, source_id) DO UPDATE SET version_key = excluded.version_key, remote_path = excluded.remote_path,
           size = excluded.size, uploaded_at = excluded.uploaded_at",
        params![set_id, source_id, version_key, remote_path, size, now_ms()],
    )
    .map_err(e)?;
    c.execute("DELETE FROM pending WHERE set_id = ?1 AND source_id = ?2", params![set_id, source_id]).map_err(e)?;
    Ok(())
}

// ---------------------------------------------------------------- pending

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRow {
    pub source_id: String,
    pub version_key: String,
    pub remote_path: String,
    pub name: String,
    pub kind: ItemKind,
    pub size: i64,
    pub attempts: i64,
    pub error: Option<String>,
}

fn kind_str(k: ItemKind) -> String {
    serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "file".into())
}

fn kind_of(s: &str) -> ItemKind {
    serde_json::from_value(serde_json::Value::String(s.into())).unwrap_or(ItemKind::File)
}

pub fn pending_row(c: &Connection, set_id: &str, source_id: &str) -> Result<Option<PendingRow>, String> {
    c.query_row(
        "SELECT source_id, version_key, remote_path, name, kind, size, attempts, error FROM pending WHERE set_id = ?1 AND source_id = ?2",
        params![set_id, source_id],
        row,
    )
    .optional()
    .map_err(e)
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<PendingRow> {
    Ok(PendingRow {
        source_id: r.get(0)?,
        version_key: r.get(1)?,
        remote_path: r.get(2)?,
        name: r.get(3)?,
        kind: kind_of(&r.get::<_, String>(4)?),
        size: r.get(5)?,
        attempts: r.get(6)?,
        error: r.get(7)?,
    })
}

/// Queues an item (or updates the queued one to its newer version, which forgets its failures).
pub fn queue(c: &Connection, set_id: &str, item: &Item, version_key: &str, remote_path: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO pending(set_id, source_id, version_key, remote_path, name, kind, size, offered_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(set_id, source_id) DO UPDATE SET
           remote_path = excluded.remote_path, name = excluded.name, kind = excluded.kind, size = excluded.size,
           attempts = CASE WHEN pending.version_key = excluded.version_key THEN pending.attempts ELSE 0 END,
           error = CASE WHEN pending.version_key = excluded.version_key THEN pending.error ELSE NULL END,
           failed_at = CASE WHEN pending.version_key = excluded.version_key THEN pending.failed_at ELSE NULL END,
           version_key = excluded.version_key",
        params![set_id, item.source_id, version_key, remote_path, item.name, kind_str(item.kind), item.size, now_ms()],
    )
    .map_err(e)?;
    Ok(())
}

/// What a run should upload, oldest first: items not given up on (fewer than `MAX_ATTEMPTS`
/// failures).
pub fn to_upload(c: &Connection, set_id: &str, limit: usize) -> Result<Vec<Offer>, String> {
    let mut st = c
        .prepare(
            "SELECT source_id, version_key, remote_path, name, kind, size, attempts, error FROM pending
             WHERE set_id = ?1 AND attempts < ?2 ORDER BY offered_at, rowid LIMIT ?3",
        )
        .map_err(e)?;
    let rows = st.query_map(params![set_id, MAX_ATTEMPTS, limit as i64], row).map_err(e)?;
    let mut out = Vec::new();
    for r in rows {
        let r = r.map_err(e)?;
        out.push(Offer { source_id: r.source_id, remote_path: r.remote_path, name: r.name, kind: r.kind, size: r.size });
    }
    Ok(out)
}

pub fn fail(c: &Connection, set_id: &str, source_id: &str, error: &str) -> Result<(), String> {
    c.execute(
        "UPDATE pending SET attempts = attempts + 1, error = ?3, failed_at = ?4 WHERE set_id = ?1 AND source_id = ?2",
        params![set_id, source_id, error, now_ms()],
    )
    .map_err(e)?;
    Ok(())
}

/// The item isn't on the phone any more: nothing to back up.
pub fn forget(c: &Connection, set_id: &str, source_id: &str) -> Result<(), String> {
    c.execute("DELETE FROM pending WHERE set_id = ?1 AND source_id = ?2", params![set_id, source_id]).map_err(e)?;
    Ok(())
}

pub fn failures(c: &Connection, set_id: &str, limit: usize) -> Result<Vec<Failure>, String> {
    let mut st = c
        .prepare(
            "SELECT source_id, name, error, failed_at, attempts FROM pending
             WHERE set_id = ?1 AND error IS NOT NULL ORDER BY failed_at DESC LIMIT ?2",
        )
        .map_err(e)?;
    let rows = st
        .query_map(params![set_id, limit as i64], |r| {
            Ok(Failure { source_id: r.get(0)?, name: r.get(1)?, error: r.get(2)?, at: r.get::<_, Option<i64>>(3)?.unwrap_or(0), attempts: r.get(4)? })
        })
        .map_err(e)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(e)
}

/// "Try again": failed items go back in the queue with a clean slate.
pub fn retry_failed(c: &Connection, set_id: &str) -> Result<usize, String> {
    c.execute("UPDATE pending SET attempts = 0, error = NULL, failed_at = NULL WHERE set_id = ?1 AND error IS NOT NULL", [set_id]).map_err(e)
}

/// (backed up, waiting, failed) for a set. "Failed" counts items with an error, "waiting" the rest.
pub fn counts(c: &Connection, set_id: &str) -> Result<(u64, u64, u64), String> {
    let one = |sql: &str| -> Result<u64, String> { c.query_row(sql, [set_id], |r| r.get::<_, i64>(0)).map(|n| n as u64).map_err(e) };
    Ok((
        one("SELECT COUNT(*) FROM backup_items WHERE set_id = ?1")?,
        one("SELECT COUNT(*) FROM pending WHERE set_id = ?1 AND error IS NULL")?,
        one("SELECT COUNT(*) FROM pending WHERE set_id = ?1 AND error IS NOT NULL")?,
    ))
}

// ---------------------------------------------------------------- runs

pub fn run_started(c: &Connection, set_id: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO runs(set_id, last_start) VALUES (?1, ?2) ON CONFLICT(set_id) DO UPDATE SET last_start = excluded.last_start",
        params![set_id, now_ms()],
    )
    .map_err(e)?;
    Ok(())
}

pub fn run_ended(c: &Connection, set_id: &str, error: Option<&str>) -> Result<(), String> {
    c.execute(
        "INSERT INTO runs(set_id, last_end, last_error) VALUES (?1, ?2, ?3)
         ON CONFLICT(set_id) DO UPDATE SET last_end = excluded.last_end, last_error = excluded.last_error",
        params![set_id, now_ms(), error],
    )
    .map_err(e)?;
    Ok(())
}

/// (last end, last error)
pub fn last_run(c: &Connection, set_id: &str) -> Result<(Option<i64>, Option<String>), String> {
    Ok(c
        .query_row("SELECT last_end, last_error FROM runs WHERE set_id = ?1", [set_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(e)?
        .unwrap_or((None, None)))
}
