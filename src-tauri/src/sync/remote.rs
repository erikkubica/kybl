//! The other side of a sync, on any connection: a snapshot of the synced folder from a full
//! listing (`walk`), or from the base plus the provider's change feed where it has one.

use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};

use futures_util::StreamExt;
use ignore::gitignore::Gitignore;

use super::{
    local::{is_ignored, safe_rel, REMOTE_TRASH},
    plan::{nfc, BaseEntry, RemoteMeta},
};
use crate::storage::{Change, Entry, HashKind, SResult, Storage, StorageError};

/// The synced folder on the other side: files keyed by NFC path, plus the real keys that differ.
#[derive(Default, Debug)]
pub struct RemoteSnapshot {
    pub files: HashMap<String, RemoteMeta>,
    /// NFC key -> the key as stored, where they differ
    pub raw: HashMap<String, String>,
    /// NFC keys that more than one stored key normalises to: all of them are left out, and the
    /// run leaves the path alone on both sides
    pub dupes: Vec<String>,
}

impl RemoteSnapshot {
    /// The full key (with the prefix) of a path.
    pub fn key(&self, prefix: &str, rel: &str) -> String {
        format!("{prefix}{}", self.raw.get(rel).map(String::as_str).unwrap_or(rel))
    }

    fn insert(&mut self, rel: &str, meta: RemoteMeta) {
        let key = nfc(rel);
        if self.dupes.contains(&key) {
            return;
        }
        if self.files.contains_key(&key) && self.raw.get(&key).map(String::as_str).unwrap_or(&key) != rel {
            self.files.remove(&key);
            self.raw.remove(&key);
            self.dupes.push(key);
            return;
        }
        if key != rel {
            self.raw.insert(key.clone(), rel.to_string());
        }
        self.files.insert(key, meta);
    }
}

/// What a listed file tells the planner. An ETag is the content's MD5 where the store says so
/// (S3 single-part uploads; not multipart ones, whose ETags end in "-N").
/// The ETag is kept as the store gives it: it goes back to the store in preconditions.
pub fn remote_meta(e: &Entry, etag_is_md5: bool) -> RemoteMeta {
    let etag = e.etag.clone().unwrap_or_default();
    let bare = etag.trim_matches('"');
    let md5 = e.hashes.md5.clone().or_else(|| (etag_is_md5 && bare.len() == 32 && bare.bytes().all(|b| b.is_ascii_hexdigit())).then(|| bare.to_lowercase()));
    RemoteMeta { size: e.size.max(0) as u64, etag, modified: e.modified.unwrap_or(0), id: e.id.clone(), md5 }
}

pub fn etag_is_md5(s: &dyn Storage) -> bool {
    s.caps().hashes.contains(&HashKind::Md5)
}

/// The path of a key below the synced folder, if it is a file Kybl syncs.
fn rel_of<'a>(key: &'a str, prefix: &str, gi: &Gitignore) -> Option<&'a str> {
    if key.ends_with('/') {
        return None;
    }
    let rel = key.strip_prefix(prefix)?;
    if !safe_rel(rel) || rel == REMOTE_TRASH || rel.starts_with(&format!("{REMOTE_TRASH}/")) || is_ignored(gi, rel) {
        return None;
    }
    Some(rel)
}

/// Everything below `prefix`, listed in full.
pub async fn scan_remote(s: &dyn Storage, root: &str, prefix: &str, gi: &Gitignore, cancel: &AtomicBool) -> SResult<RemoteSnapshot> {
    let md5 = etag_is_md5(s);
    let mut out = RemoteSnapshot::default();
    let mut walk = s.walk(root, prefix);
    while let Some(batch) = walk.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err(StorageError::cancelled());
        }
        for e in batch? {
            if let Some(rel) = rel_of(&e.key, prefix, gi) {
                out.insert(rel, remote_meta(&e, md5));
            }
        }
    }
    Ok(out)
}

/// The snapshot from the base (what was there at the last sync) with the changes since `cursor`
/// applied. Answers the new cursor. Errors (an expired cursor) mean: list in full instead.
pub async fn scan_changes(
    s: &dyn Storage,
    root: &str,
    prefix: &str,
    gi: &Gitignore,
    base: &HashMap<String, BaseEntry>,
    cursor: String,
    cancel: &AtomicBool,
) -> SResult<(RemoteSnapshot, String)> {
    let mut changes = Vec::new();
    let mut cursor = cursor;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(StorageError::cancelled());
        }
        let batch = s.changes(root, Some(cursor)).await?;
        changes.extend(batch.changes);
        cursor = batch.cursor;
        if !batch.has_more {
            break;
        }
    }
    Ok((apply_changes(base, &changes, prefix, gi, etag_is_md5(s)), cursor))
}

/// The base's remote view with a change feed applied on top.
pub fn apply_changes(base: &HashMap<String, BaseEntry>, changes: &[Change], prefix: &str, gi: &Gitignore, md5: bool) -> RemoteSnapshot {
    let mut out = RemoteSnapshot::default();
    for (k, v) in super::plan::remote_from_base(base) {
        out.files.insert(k, v);
    }
    for c in changes {
        let Some(rel) = rel_of(&c.key, prefix, gi) else { continue };
        match &c.entry {
            Some(e) => {
                out.files.remove(&nfc(rel));
                out.insert(rel, remote_meta(e, md5));
            }
            None => {
                out.files.remove(&nfc(rel));
            }
        }
    }
    out
}

/// A cursor for the change feed as of now, on stores that have one (asked right after a full
/// listing, so the next run only fetches what changed since).
pub async fn fresh_cursor(s: &dyn Storage, root: &str) -> Option<String> {
    if !s.caps().changes {
        return None;
    }
    let mut cursor: Option<String> = None;
    // a store answers its current position for "no cursor"; follow it to the end
    for _ in 0..1000 {
        let batch = s.changes(root, cursor.clone()).await.ok()?;
        cursor = Some(batch.cursor);
        if !batch.has_more {
            return cursor;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Hashes;

    fn gi() -> Gitignore {
        super::super::local::build_ignore(std::path::Path::new("/r"), &["*.tmp".into()])
    }

    #[test]
    fn only_files_kybl_syncs_are_listed() {
        assert_eq!(rel_of("p/a.txt", "p/", &gi()), Some("a.txt"));
        assert_eq!(rel_of("p/dir/", "p/", &gi()), None);
        assert_eq!(rel_of("p/x.tmp", "p/", &gi()), None);
        assert_eq!(rel_of("p/.kybl-trash/2026-11-22/a.txt", "p/", &gi()), None);
        assert_eq!(rel_of("p/../etc", "p/", &gi()), None);
        assert_eq!(rel_of("other/a", "p/", &gi()), None);
    }

    #[test]
    fn md5_etags_are_recognised() {
        let e = Entry { key: "a".into(), size: 3, etag: Some("\"5D41402ABC4B2A76B9719D911017C592\"".into()), ..Default::default() };
        assert_eq!(remote_meta(&e, true).md5.as_deref(), Some("5d41402abc4b2a76b9719d911017c592"));
        assert_eq!(remote_meta(&e, false).md5, None);
        let multipart = Entry { etag: Some("abc-3".into()), ..e.clone() };
        assert_eq!(remote_meta(&multipart, true).md5, None);
        let hashed = Entry { hashes: Hashes { md5: Some("m".into()), ..Default::default() }, ..e };
        assert_eq!(remote_meta(&hashed, false).md5.as_deref(), Some("m"));
    }

    #[test]
    fn a_change_feed_updates_the_base_view() {
        let base = HashMap::from([
            ("a".to_string(), BaseEntry { r_etag: "1".into(), r_size: 1, ..Default::default() }),
            ("b".to_string(), BaseEntry { r_etag: "2".into(), r_size: 2, ..Default::default() }),
        ]);
        let changes = vec![
            Change { key: "p/a".into(), entry: None, id: None },
            Change { key: "p/c".into(), entry: Some(Entry { key: "p/c".into(), size: 3, etag: Some("3".into()), ..Default::default() }), id: None },
            Change { key: "elsewhere".into(), entry: None, id: None },
        ];
        let snap = apply_changes(&base, &changes, "p/", &gi(), false);
        let mut keys: Vec<_> = snap.files.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["b", "c"]);
        assert_eq!(snap.files["c"].etag, "3");
    }

    #[test]
    fn decomposed_keys_keep_their_stored_form() {
        let mut s = RemoteSnapshot::default();
        s.insert("cafe\u{301}.txt", RemoteMeta::new(1, "e", 0));
        assert_eq!(s.key("p/", "caf\u{e9}.txt"), "p/cafe\u{301}.txt");
        // the composed spelling of the same name as well: they can't both be synced
        s.insert("caf\u{e9}.txt", RemoteMeta::new(1, "f", 0));
        assert!(s.files.is_empty());
        assert_eq!(s.dupes, vec!["caf\u{e9}.txt".to_string()]);
        // a third spelling doesn't sneak back in
        s.insert("cafe\u{301}.txt", RemoteMeta::new(1, "g", 0));
        assert!(s.files.is_empty() && s.raw.is_empty());
    }
}
