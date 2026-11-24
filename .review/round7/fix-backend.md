| id | verdict | what changed or why |
|----|---------|---------------------|
| T-2 | fixed | `Limiter::throttle_unless` added; `Meter::sent`, `extras::Source` reads and `jobs::copy::throttled` (now takes the job's stop flag) end their cap wait on cancel. S3 part sends (multipart.rs `send_part`, s3_stream.rs `put_part`) race the request against the flag, so the body's per-frame wait is dropped on cancel. Plain `throttle` wrappers removed (unused). |
| T-3 | fixed | The finish path removes the record and the `ACTIVE` entry under one `ACTIVE` lock hold, so `shutdown`'s check is exact. |
| T-4 | fixed | Generic resume loop returns at once on NotFound, PermissionDenied and NeedsAuth, as it did for Conflict. |
| T-5 | fixed | `stream_files` races `walk.next()` against the cancel flag (drops the walk). `cancel_transfer` notes an unregistered id for 10 s (under the `cancels` lock); `stream_files_under` checks it right after registering. |
| C-2 | fixed | Reconnect keeps the old name only if it is not an automatic `Kybl Storage` / `Kybl Storage (email)` label; otherwise the new account's label is used. |
| C-3 | fixed | New `new_overlap` skips the check when the mapping already exists with the same local path (pre-existing overlap), still refuses a new or moved folder; test added. Windows: `overlaps` folds case (not compiled here). |
