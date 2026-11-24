| id | verdict | what changed or why |
|---|---|---|
| U-2 | fixed | `BIG_RENAME` moved to `src/format.ts` (shared); phone `askRename` now uses `slow = (isFolder or size >= BIG_RENAME) && copy-delete`, with the "It carries on in Transfers" note, so the sheet is no longer locked. |
| U-3 | fixed | LocationPicker no longer clears `pressed` at pointerup; it clears 400 ms after pointerup/cancel (timer cancelled by the next pointerdown and on cleanup), so touch's late blur still sees what was tapped, and a later Tab is still not read as a click. |
| U-4 | fixed | `denied` only when the store has a by-name way in (S3-like), is not a reconnect, and the error is the real "access denied / not allowed". Drive, OneDrive, Kybl and plain 403/Forbidden keep "Couldn't list" with Try again (and New bucket / by-name where offered); the Kybl wording mismatch goes away. |
| U-6 | fixed | `setBusy(false)` in the made-folder branch of DestinationScreen's effect. |
| U-7 | fixed | Busy line owned by the latest listing (WeakMap keyed by the pane's `setBusy`); an earlier download finishing no longer clears a later one's text and Stop. |
| U-8 | skipped | Needs a busy line plumbed into crossPane's context across panes; the toast Stop is a limit and Activity's Cancel covers started transfers. Not a small change. |
| U-9 | skipped | Only delays an Activity log end line until the unrelated listing finishes; keying the hold by top folder touches batching logic that single-action grouping relies on, with real risk for a log-only effect. |
| U-10 | fixed | A big-file rename job that renamed nothing toasts "Couldn't rename “name”: reason" instead of "stopped after 0 of 1 object". |
