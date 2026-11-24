| id | verdict | what changed or why |
|---|---|---|
| F-2 | fixed | transferLog `noteAdded`: a shared top folder now wins first; the "came right after" time rule is only used second and skips a batch of another folder still being listed |
| F-3 | fixed | new `holdBatch(pid, bucket, dir)` in transferLog: a batch is not finished while a listing feeds it; used by `downloadEntries` and `downloadInto`, released in `finally` |
| F-4 | fixed | a file of 64 MB or more on a copy-delete connection is `slow` like a folder: runs as a job, dialog returns at once, Activity opens, note explains |
| F-5 | fixed | LocationPicker: `pressed` is cleared on pointerup/pointercancel, so it only explains the blur its own press caused |
| F-6 | fixed | PaneEmpty: a "denied" error is not `failed` any more: no alert, no Try again, "Open bucket by name" is the main button, note text kept |
| F-8 | fixed | NetForm `portNum` prefers a port carried by the Server text, same as the blur result |
| F-9 | fixed | "Copy log" copies the whole log, not just the filtered lines |
| F-10 | fixed | `Batch.errors` / `BatchEnd.errors` keep `{ name, message }` apart; joined only for Details; test added |
| M-1 | fixed | PromptDialog gets `onBusy`; the phone's `closeLayer.prompt` is a no-op while busy; `onLostError` toast wired as a backstop |
| M-2 | fixed | shared `afterSignIn(p)` (forget caps, clear needsAuth, run stopped backups) used by both dialogs; Kybl sign-in also reloads the open listing |
| M-3 | fixed | DestinationScreen skips listing a folder just made here (shows it empty) |
| M-4 | fixed | `forget_stale` at mount time wrapped in a 5 s timeout, like `unmount_one` |
