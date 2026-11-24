| id | verdict | what changed or why |
|---|---|---|
| U-1 | fixed | A listing takes the busy line once when it starts and repaints batches only while it still owns it. `setBusy` (usePane) takes an optional owner; any call without one clears ownership, so archive "Opening…" and the other writers are never wiped by a finishing listing. |
| U-2 | fixed | Stop on one folder now adds "N more folders weren't listed." to the toast (desktop downloads). Cross-pane copy left silent: its Stop can't tell Stop from Cancel all, so the line would be noise there. |
| U-3 | fixed | New src/viewers/refused.ts. Docx/Pptx keep the thrown "refused" marker, the Xlsx worker sends `refused: true`; each viewer shows "too big, or built in a way the preview can't safely open. Use Open in another app" instead of damaged / password-protected. zipCheck.ts untouched. |
| U-4 | fixed | Phone `runMove` takes an optional `failed` label; the background rename passes "Couldn’t rename “name”", so the error toast names the rename when nothing moved. |
| B-1 | fixed | `send_sequential`'s single PUT for an unknown-length stream now races `wait_cancel` and returns `Sent::Cancelled`, like the part sends. |
| B-2 | skipped | Needs a registration helper across about eight commands; a Stop landing inside the connect window is rare and low severity. |
| B-3 | fixed | Real: ftp.rs mapped 530 to NeedsAuth and 450/550 to NotFound, which the resume loop gives up on. Now a 530/430 about too many clients (also on the login path) maps to RateLimited and a 450/550 saying busy / in use / locked / another process maps to Other, so both keep retrying. Test added. |
| B-4 | skipped | Needs the old account's email stored on the profile; renaming to "Kybl Storage (x)" is rare and low confidence. |
