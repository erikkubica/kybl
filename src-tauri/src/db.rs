//! Opening an engine's SQLite database (jobs.db, and later sync.db and backup.db).
//!
//! Each subsystem keeps its own file, so their schemas move on independently and deleting one file
//! resets just that subsystem. A schema is a list of migrations: migration `n` (1-based) runs once,
//! when `PRAGMA user_version` is below `n`, inside a transaction that also bumps the version. So a
//! new release only ever appends to the list; it never edits a migration that already shipped.

use std::{path::Path, time::Duration};

use rusqlite::Connection;

/// Opens (creating it if needed) the database at `path` and brings its schema up to date.
///
/// WAL lets readers run while a writer works, and with `synchronous = NORMAL` a commit doesn't
/// wait for the disk; a crash can lose the last commits but never corrupts the file, and the
/// engines are written to redo work that wasn't recorded.
pub fn open(path: &Path, migrations: &[&str]) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the folder for {}: {e}", path.display()))?;
    }
    let mut conn = Connection::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    setup(&mut conn, migrations)?;
    Ok(conn)
}

/// An in-memory database with the same schema (tests).
#[allow(dead_code)]
pub fn open_in_memory(migrations: &[&str]) -> Result<Connection, String> {
    let mut conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    setup(&mut conn, migrations)?;
    Ok(conn)
}

fn setup(conn: &mut Connection, migrations: &[&str]) -> Result<(), String> {
    let e = |e: rusqlite::Error| format!("Database setup failed: {e}");
    // another connection (or a crashed process's leftover lock) may hold the file briefly
    conn.busy_timeout(Duration::from_secs(5)).map_err(e)?;
    // answers the new mode ("memory" for in-memory databases), so read it as a row
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(())).map_err(e)?;
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;").map_err(e)?;
    migrate(conn, migrations)
}

/// Runs the migrations the file hasn't seen yet. A file from a newer Kybl (a higher version than
/// this build knows) is refused rather than written with an older schema.
fn migrate(conn: &mut Connection, migrations: &[&str]) -> Result<(), String> {
    let have: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let want = migrations.len() as i64;
    if have > want {
        return Err("This database was made by a newer version of Kybl. Update Kybl to use it.".into());
    }
    for (i, sql) in migrations.iter().enumerate().skip(have as usize) {
        // the write lock is taken first and the version read again under it: another process
        // opening the same file may have run this step since `have` was read
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let now: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if now > i as i64 {
            continue;
        }
        tx.execute_batch(sql).map_err(|e| format!("Database upgrade {} failed: {e}", i + 1))?;
        // PRAGMA takes no parameters; the number is ours, not input
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1)).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_run_once_and_in_order() {
        let path = std::env::temp_dir().join(format!("kybl-db-{}/t.db", uuid::Uuid::new_v4()));
        let one = ["CREATE TABLE a(x INTEGER); INSERT INTO a VALUES (1);"];
        let conn = open(&path, &one).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        drop(conn);
        // reopened with one more migration: only the new one runs
        let two = [one[0], "ALTER TABLE a ADD COLUMN y TEXT; UPDATE a SET y = 'b';"];
        let conn = open(&path, &two).unwrap();
        let (n, y): (i64, String) = conn.query_row("SELECT COUNT(*), MAX(y) FROM a", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((n, y.as_str()), (1, "b"));
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
        drop(conn);
        // an older build refuses the newer file
        assert!(open(&path, &one).unwrap_err().contains("newer version"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn processes_opening_at_once_run_each_step_once() {
        let path = std::env::temp_dir().join(format!("kybl-db-{}/t.db", uuid::Uuid::new_v4()));
        let steps = ["CREATE TABLE a(x INTEGER)", "ALTER TABLE a ADD COLUMN y TEXT", "ALTER TABLE a ADD COLUMN z TEXT"];
        let opens: Vec<_> = (0..8)
            .map(|_| {
                let p = path.clone();
                std::thread::spawn(move || open(&p, &steps).map(|_| ()))
            })
            .collect();
        for o in opens {
            o.join().unwrap().unwrap();
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_failed_migration_leaves_the_version_alone() {
        let mut conn = open_in_memory(&["CREATE TABLE a(x)"]).unwrap();
        assert!(migrate(&mut conn, &["CREATE TABLE a(x)", "this is not sql"]).is_err());
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
    }
}
