// The Rust backup engine's C entry points (src/backup/headless.rs). Every answer is a JSON
// string owned by Rust: hand it back with kybl_string_free. All of them block until done, so
// call them off the main thread.
#pragma once

#include <stdint.h>

/// One engine call ("sets", "runStart", "offer", "pending", "fail", "gone", "wait", "runEnd",
/// "cancel", "status", "device"): {"ok": …} or {"error": "…"}.
char *kybl_backup_call(const char *method, const char *args_json);

/// Items for a set (a JSON array): what to upload, or {"error"}.
char *kybl_backup_offer(const char *set_id, const char *items_json);

/// Uploads the exported file at file_path: {status, remotePath?, error?}.
char *kybl_backup_upload(const char *set_id, const char *source_id, const char *remote_path, const char *file_path, int64_t mtime_ms);

/// Stops every run: the upload in flight answers "cancelled".
void kybl_backup_cancel(void);

void kybl_string_free(char *s);
