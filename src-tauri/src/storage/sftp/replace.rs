//! Putting a finished file in place of another on servers whose rename may refuse to replace
//! (FTP and SFTP both use this).
//!
//! The rule: the file that was there is only ever deleted once the new one sits at its name. When
//! the server won't rename over a file, the old one is first renamed aside to a backup name, the
//! new one renamed in, and only then the backup deleted. If the second rename fails, the backup
//! goes back. The new file (an upload's temporary file, or a moved file) stays where it was on
//! any failure, so nothing is lost either way.

use async_trait::async_trait;

use crate::storage::{SResult, StorageError};

/// The three things the dance needs, on keys within the connection.
#[async_trait]
pub trait Renames: Send + Sync {
    /// Renames `from` to `to`; may fail when a file is at `to`.
    async fn rename_file(&self, from: &str, to: &str) -> SResult<()>;
    /// Whether a file is at `key` right now (asked of the server, not a cache).
    async fn file_exists(&self, key: &str) -> SResult<bool>;
    async fn remove_file(&self, key: &str) -> SResult<()>;
}

/// Why a file couldn't be put in place. Nothing was lost: `from` is still where it was, and the
/// file that was at the target is at the target again, or (when even putting it back failed) at
/// `original_at`.
#[derive(Debug)]
pub struct NotReplaced {
    pub error: StorageError,
    pub original_at: Option<String>,
}

impl NotReplaced {
    fn kept(error: StorageError) -> Self {
        Self { error, original_at: None }
    }

    /// The error, saying where things are now. `from_name` names the new file for the user (an
    /// upload's temporary file); None when it is the user's own file that simply didn't move.
    pub fn explain(self, from_name: Option<&str>) -> StorageError {
        let mut e = self.error;
        if let Some(n) = from_name {
            e.message = format!("{} The new copy was kept as {n}.", e.message);
        }
        if let Some(o) = self.original_at {
            e.message = format!("{} The file that was there is kept as {}.", e.message, crate::storage::net::file_name(&o));
        }
        e
    }
}

/// Puts `from` at `to`, replacing a file there without ever deleting it first. `backup` is a
/// free name next to `to` for the old file while the new one moves in.
pub async fn put_in_place<R: Renames + ?Sized>(r: &R, from: &str, to: &str, backup: &str) -> Result<(), NotReplaced> {
    let first = match r.rename_file(from, to).await {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    // the rename may have happened after all (the answer got lost with a dropped connection)
    match (r.file_exists(from).await, r.file_exists(to).await) {
        (Ok(false), Ok(true)) => return Ok(()),
        // nothing in the way: the refusal was about something else
        (_, Ok(false)) => return Err(NotReplaced::kept(first)),
        (Ok(true), Ok(true)) => {}
        (Err(e), _) | (_, Err(e)) => return Err(NotReplaced::kept(e)),
    }
    if let Err(e) = r.rename_file(to, backup).await {
        return Err(NotReplaced::kept(e));
    }
    match r.rename_file(from, to).await {
        Ok(()) => {
            // a leftover backup is clutter, not a loss
            let _ = r.remove_file(backup).await;
            Ok(())
        }
        Err(e) => match r.rename_file(backup, to).await {
            Ok(()) => Err(NotReplaced::kept(e)),
            Err(_) => Err(NotReplaced { error: e, original_at: Some(backup.to_string()) }),
        },
    }
}

#[cfg(test)]
pub mod fake {
    //! A server in memory whose renames can be made to fail.
    use std::{collections::HashMap, sync::Mutex};

    use super::*;
    use crate::storage::ErrKind;

    #[derive(Default)]
    pub struct Server {
        pub files: Mutex<HashMap<String, &'static str>>,
        /// renames refuse to replace a file (many FTP servers, old SFTP ones)
        pub no_replace: bool,
        /// renames with this source fail, counted down per failure (None: never)
        pub fail_from: Mutex<Vec<(String, u32)>>,
    }

    impl Server {
        pub fn with(files: &[(&str, &'static str)]) -> Self {
            Self { files: Mutex::new(files.iter().map(|(k, v)| (k.to_string(), *v)).collect()), ..Default::default() }
        }
        pub fn get(&self, k: &str) -> Option<&'static str> {
            self.files.lock().unwrap().get(k).copied()
        }
        pub fn fail_renames_from(&self, from: &str, times: u32) {
            self.fail_from.lock().unwrap().push((from.to_string(), times));
        }
    }

    #[async_trait]
    impl Renames for Server {
        async fn rename_file(&self, from: &str, to: &str) -> SResult<()> {
            for (f, n) in self.fail_from.lock().unwrap().iter_mut() {
                if f == from && *n > 0 {
                    *n -= 1;
                    return Err(StorageError::new(ErrKind::PermissionDenied, "The server didn't allow that."));
                }
            }
            let mut files = self.files.lock().unwrap();
            if self.no_replace && files.contains_key(to) {
                return Err(StorageError::other("The FTP server refused that."));
            }
            let v = files.remove(from).ok_or_else(StorageError::not_found)?;
            files.insert(to.to_string(), v);
            Ok(())
        }
        async fn file_exists(&self, key: &str) -> SResult<bool> {
            Ok(self.files.lock().unwrap().contains_key(key))
        }
        async fn remove_file(&self, key: &str) -> SResult<()> {
            self.files.lock().unwrap().remove(key).map(|_| ()).ok_or_else(StorageError::not_found)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fake::Server, *};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    fn replaces_through_a_backup_when_rename_wont_overwrite() {
        let s = Server { no_replace: true, ..Server::with(&[("d/.a.kybl-1", "new"), ("d/a", "old")]) };
        rt().block_on(put_in_place(&s, "d/.a.kybl-1", "d/a", "d/.a.kybl-2")).unwrap();
        assert_eq!(s.get("d/a"), Some("new"));
        assert_eq!(s.files.lock().unwrap().len(), 1, "no temporary or backup file left");
    }

    #[test]
    fn a_failed_second_rename_puts_the_original_back_and_keeps_the_new_file() {
        let s = Server { no_replace: true, ..Server::with(&[("d/.a.kybl-1", "new"), ("d/a", "old")]) };
        // the first try is refused for the file in the way; the try after moving it aside fails
        s.fail_renames_from("d/.a.kybl-1", 2);
        let e = rt().block_on(put_in_place(&s, "d/.a.kybl-1", "d/a", "d/.a.kybl-2")).unwrap_err();
        assert_eq!(e.original_at, None);
        assert_eq!(s.get("d/a"), Some("old"), "the original is back in place");
        assert_eq!(s.get("d/.a.kybl-1"), Some("new"), "the new copy is kept");
        assert!(e.explain(Some(".a.kybl-1")).message.contains("kept as .a.kybl-1"));
    }

    #[test]
    fn when_even_restoring_fails_the_original_is_kept_under_its_backup_name() {
        let s = Server { no_replace: true, ..Server::with(&[("d/.a.kybl-1", "new"), ("d/a", "old")]) };
        s.fail_renames_from("d/.a.kybl-1", 2);
        s.fail_renames_from("d/.a.kybl-2", 1);
        let e = rt().block_on(put_in_place(&s, "d/.a.kybl-1", "d/a", "d/.a.kybl-2")).unwrap_err();
        assert_eq!(e.original_at.as_deref(), Some("d/.a.kybl-2"));
        assert_eq!(s.get("d/.a.kybl-2"), Some("old"));
        assert_eq!(s.get("d/.a.kybl-1"), Some("new"));
        assert!(e.explain(None).message.contains("kept as .a.kybl-2"));
    }

    #[test]
    fn a_refused_rename_with_nothing_in_the_way_touches_nothing() {
        let s = Server::with(&[("d/.a.kybl-1", "new")]);
        s.fail_renames_from("d/.a.kybl-1", 5);
        rt().block_on(put_in_place(&s, "d/.a.kybl-1", "d/a", "d/.a.kybl-2")).unwrap_err();
        assert_eq!(s.get("d/.a.kybl-1"), Some("new"));
        assert_eq!(s.get("d/a"), None);
    }

    #[test]
    fn a_rename_refused_when_moving_aside_leaves_both_files() {
        let s = Server { no_replace: true, ..Server::with(&[("d/.a.kybl-1", "new"), ("d/a", "old")]) };
        s.fail_renames_from("d/a", 1);
        rt().block_on(put_in_place(&s, "d/.a.kybl-1", "d/a", "d/.a.kybl-2")).unwrap_err();
        assert_eq!(s.get("d/a"), Some("old"));
        assert_eq!(s.get("d/.a.kybl-1"), Some("new"));
    }

    #[test]
    fn a_rename_that_happened_despite_the_error_counts() {
        struct Lost(Server);
        #[async_trait]
        impl Renames for Lost {
            async fn rename_file(&self, from: &str, to: &str) -> SResult<()> {
                self.0.rename_file(from, to).await?;
                Err(StorageError::new(crate::storage::ErrKind::Network, "dropped"))
            }
            async fn file_exists(&self, key: &str) -> SResult<bool> {
                self.0.file_exists(key).await
            }
            async fn remove_file(&self, key: &str) -> SResult<()> {
                self.0.remove_file(key).await
            }
        }
        let s = Lost(Server::with(&[("d/.a.kybl-1", "new"), ("d/a", "old")]));
        rt().block_on(put_in_place(&s, "d/.a.kybl-1", "d/a", "d/.a.kybl-2")).unwrap();
        assert_eq!(s.0.get("d/a"), Some("new"));
        assert_eq!(s.0.files.lock().unwrap().len(), 1);
    }
}
