| id | verdict | what changed or why |
|---|---|---|
| B3-1 | fixed (partly) | A 503 no longer marks a retry as "repeated" (only 502/504), so a 503 followed by a conflict is no longer read as "our first try landed". Hash compares not added (need source hashing; skeptic downgraded). |
| B3-2 | fixed | save_profile writes a whole new SFTP key to `{id}#ssh` when that legacy entry exists, so it is the one read; passphrase-only edits unchanged; undo uses the same name. |
| B3-3 | fixed | TokenSource keeps `in_vault` (the token the vault still holds after a failed save) and names it as `prev` on the next save, so later renewals are written. |
| B3-4 | skipped | Needs a post-cancel lookup/delete per provider; low severity, larger design. |
| B3-5 | fixed | Reconnecting Kybl Storage keeps the existing connection's name. |
| B3-6 | skipped | Arguably by design; the form's own comparison would need to change in step. |
| B4-4 | fixed | `overlaps` compares `sync_root` (canonical) paths, falling back to typed when the folder doesn't exist; test with a symlink. |
| B4-5 | fixed | Mirror treats a folder as empty only when its listing has no next page. |
| B4-6 | skipped | Conditional writes per store (Hetzner quirks) is a wider change; low severity. |
| B4-7 | fixed | `SyncDb::forget` also clears the in-memory blocked map for the mapping. |
