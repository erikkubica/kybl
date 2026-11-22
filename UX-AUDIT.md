# Kybl UX audit (2026-11-22)

Code-read only. Spot-checked: desktop #1, #2, #3, #6 and mobile #1, #5 confirmed.

## Desktop

# Kybl desktop UI audit

I read the code only: nothing was edited or run. Paths are relative to `/Users/erikkubica/Development/Personal/s3-browser/.claude/worktrees/app-ux-functional-improvements-bf3e78`. Effort: S = hours, M = about a day, L = several days.

## 1. Bugs and breakages

1. **Folder sizes are advertised but can't be reached anywhere on desktop (M)**
   - The README and the website list them. `useFolderSizes` is set up at `src/App.tsx:198`, but only `.clear()` is ever called (`:701`, `:810`). Nothing uses `get` or `calc`.
   - FileTable shows "—" for folders (`FileTable.tsx:234`). The folder details pane has no size (`PreviewPane.tsx:339-344`).
   - The backend `folder_size` command and its progress events work. Git history shows the UI was never wired up, not even in the first commit.

2. **Switching bucket leaves the old bucket's files on screen, and you can act on them (S)**
   - `openBucket` (`App.tsx:307-318`) doesn't clear `listing`, unlike `connect` (`:359`).
   - Until the new list arrives, old rows stay clickable while `bucket` already points at the new bucket. Delete, rename or move then send old keys to the new bucket. With look-alike buckets (prod and staging), that can hit the wrong object.
   - Grid cards also request thumbnails for old keys from the new bucket.

3. **Opening a folder shows the previous folder's contents with "Loading more…" (S)**
   - `navigate` (`App.tsx:293-305`) keeps `listing`. FileTable and GridView then show the old rows plus the "Loading more…" row (`FileTable.tsx:247-251`, `GridView.tsx:230-234`), under a breadcrumb that already shows the new path.
   - On slow providers like Hetzner, people act on the wrong list.

4. **Rename and New folder silently overwrite or merge (S)**
   - `askRename` (`App.tsx:731-770`) goes straight to `moveMany`, and `copy_many` (`commands.rs:841-936`) never checks the destination. Renaming `a.jpg` to an existing `b.jpg` destroys `b.jpg`.
   - Renaming a folder to an existing folder's name merges the two.
   - `relocate` does check for clashes, but only for 200 files or fewer and never for folders (`App.tsx:815-829`).

5. **Uploads overwrite existing objects without asking (M)**
   - `uploadPaths` (`App.tsx:605-631`) queues everything blindly. There is no overwrite / skip / rename / keep-both choice.
   - This doesn't match move and copy, which do ask.

6. **Folder download can write outside the chosen folder (S)**
   - `rel = rf.key.slice(base.length)` is joined onto the chosen folder unchecked (`App.tsx:658-661`). `download_file` then creates whatever parent folders the path needs (`transfers.rs:306-310`).
   - A key like `x/../../.zshrc` escapes the download folder.
   - Folder sync already guards against this (`sync.rs:257`). Folder download doesn't.

7. **Downloading several search results flattens them into one folder, so same-named files overwrite each other (S)**
   - `joinPath(dir, e.name)` (`App.tsx:654`) drops the path. Two `report.pdf` from different folders land on the same local file.
   - More generally, `rename(part, dest)` (`transfers.rs:368`) replaces existing local files with no prompt.

8. **Search can show results for the wrong folder, and can't be stopped (S)**
   - `doSearch` (`App.tsx:567-579`) has no request-id guard. If you move to another folder or start a second search, a late result replaces the view, and the banner shows the new path.
   - The backend supports streaming results and cancelling through an `opId` (`api.ts:45-47`, `commands.rs:390-420`). Desktop never passes one, so a 300k-key scan gives only a spinner in the status bar.

9. **Keyboard shortcuts act on the file list while a dialog is open (S)**
   - The guard at `App.tsx:963` leaves out `kyblDialog` and `menu`.
   - While the Kybl sign-in dialog waits (no text field focused), Backspace goes up a folder behind it, Delete opens a delete confirm over it, and ⌘A selects everything.
   - The ⌘F handler in `Toolbar.tsx:78-87` also fires under any open dialog.

10. **Quitting during transfers gives no warning and leaves junk behind (M)**
    - Tray Quit calls `app.exit(0)` (`tray.rs:100`). On desktop, ⌘Q and window close have no check for running transfers (`lib.rs:44-52`, `:145-176`).
    - Multipart uploads in progress are never aborted, so their parts keep costing storage. Partial `.s3part` files stay on disk.

11. **In folders over 1,000 items, later pages insert items above where you're scrolled (M)**
    - S3 returns keys in byte order, but the app sorts with a case-insensitive numeric collator, and folders first by default (`App.tsx:483-486`).
    - Each new page can therefore put entries (often folders) near the top, out of view. Folders on page 2 and later effectively disappear for anyone scrolling down.

12. **Moving or renaming files of 4 GiB or more loses Content-Type and metadata (S)**
    - The multipart copy path (`commands.rs:736-742`) calls `create_multipart_upload` without the source's content type or metadata.

13. **⌘R in search mode reloads the folder, not the search (S)**
    - `refresh` (`App.tsx:272-274`) ignores `search`, so the results stay stale. `reloadIfShowing` does handle search (`:285-291`).
    - New folder in search mode also looks like it did nothing.

14. **Deleting a connection can fail silently (S)**
    - `ConnectionDialog.tsx:189` has no try/catch, so an error becomes an unhandled rejection and the dialog just stays open.

## 2. High-impact UX fixes

15. **No context menu on empty space (S)**
    - Only rows and tiles have one (`FileTable.tsx:222`, `GridView.tsx:72`). Right-clicking empty list space, the sidebar or the toolbar shows WebKit's own menu, including Reload, which reloads the whole app.
    - It should offer New folder, Upload, Refresh, Select all and Paste.

16. **Arrow keys only work once the list has focus; dialogs don't hand focus back (S)**
    - Arrow handling lives on the list itself (`FileTable.tsx:190-198`, `GridView.tsx:183-190`).
    - After a sidebar click, a dialog closing (`Modal` never restores focus, `Dialogs.tsx:5-65`) or moving to a folder, arrows do nothing until you click the list.
    - `Modal` also doesn't focus its first field.

17. **No Back/Forward history (S-M)**
    - There is only Up (`Toolbar.tsx:94`). Add ⌘[ / ⌘] plus toolbar buttons. This matters most after jumping from a search result or a finished job.

18. **No way to type or paste a path (S)**
    - The breadcrumbs (`Breadcrumbs.tsx`) are click-only. Add Go to folder (⌘L or ⌘⇧G) that accepts `bucket/prefix` or `s3://` URIs, which pairs with the existing "Copy S3 URI".

19. **Search waits for Enter and only does a deep scan (M)**
    - Typing should filter the loaded rows instantly, with Enter running the recursive search (`Toolbar.tsx:112-119`).
    - Search results also never include folders.

20. **Clicking outside a dialog throws away what you typed (S)**
    - `onMouseDown={onClose}` on the backdrop (`Dialogs.tsx:43`) loses half-filled connection and sync forms.
    - Escape listens on the whole window (`:35-41`), so two stacked dialogs both close.

21. **Opening a file does nothing (M)**
    - Double-click or Enter on a file only opens the details panel (`App.tsx:557-564`).
    - Add Space for a large preview overlay with arrow-key paging, and ⌘O / double-click to download to a temp folder and open in the default app.

22. **The context menu can't be used from the keyboard (S)**
    - It has no first focus, no arrow keys, no type-ahead, and can't be opened with the context-menu key (`Dialogs.tsx:175-241`).

23. **Failures give no way forward (S)**
    - The "N uploads failed" toast (`App.tsx:433`) has no "Show" or "Retry all" action, and the Activity panel only retries one row at a time (`TransferPanel.tsx:279-283`).
    - Retry starts over from 0 bytes (`useTransfers.ts:190-200`).

## 3. Features worth adding

24. **Undo for move, rename and copy (M)**
    - Moves and renames can be reversed by moving back. Show a toast with Undo (the `Toast` type at `Dialogs.tsx:243` needs an action field).
    - Drag-to-move has no confirm (`useItemDrag.ts:94`), which makes undo more important.

25. **Copy and move between buckets and connections (M-L)**
    - The Move dialog and drag targets only cover the current bucket (`MoveDialog.tsx`, `App.tsx:773`). Make sidebar buckets drop targets, use server-side copy on the same endpoint, and stream otherwise.

26. **Edit object properties (M)**
    - The details panel shows content type and metadata read-only (`PreviewPane.tsx:351-372`). Add editing of Content-Type, Cache-Control, Content-Disposition, user metadata and storage class (copy-in-place with REPLACE), plus tags.

27. **Favorites in the sidebar (M)**
    - Pin a bucket and folder, alongside the existing hide/show of buckets (`Sidebar.tsx`).

28. **Faster, tunable transfers (M)**
    - Three transfers per connection is hard-coded (`state.rs:60`), and multipart parts upload one at a time (`transfers.rs:211-244`).
    - Add parallel parts, a concurrency setting, an optional bandwidth limit, and retry of a single failed part instead of aborting the whole upload.

29. **Resumable desktop uploads (L)**
    - Keep the multipart upload id and finished parts so a failed or cancelled big upload continues instead of restarting.

30. **Drag out to Finder, and ⌘C / ⌘V (L / M)**
    - Paste Finder files to upload. Copy/paste items within the bucket as copy or move.

31. **Column chooser and saved sort (S-M)**
    - Only Size, Modified and Kind exist (`FileTable.tsx:13-17`). Add Storage class, ETag and full path, and allow hiding columns.
    - Sort resets every launch (`App.tsx:118`).

32. **"Sync this folder…" from the file browser (S)**
    - Open the sync dialog prefilled with the current connection, bucket and prefix. Today it starts empty and only from Settings.

33. **Default download folder (S)**
    - Optionally save to Downloads without asking. `api.downloadFolder` already exists (`api.ts:111-112`).

34. **Share links for several files at once, and marquee selection in the grid (S / M).**

## 4. Polish

35. **Edit-connection and hide-bucket buttons can't be reached by keyboard (S)**
    - `display:none` until hover (`styles.css:269-291`), so they can never get focus.

36. **The file list is invisible to screen readers (M)**
    - Rows and tiles are plain divs with no list/row roles or selected state (`FileTable.tsx:214-226`, `GridView.tsx:64-77`).
    - The Activity header toggles on click only (`TransferPanel.tsx:127`).
    - Toasts use `role=status` even for errors, auto-hide after 7 seconds, and the error details are only in a hover tooltip (`Dialogs.tsx:245-255`).

37. **Missing list keys (S):** Home, End, PageUp, PageDown and type-to-select.

38. **README is wrong about a slider, and big tiles are missing (S)**
    - The README promises a "thumbnail size slider" (`README.md:11`), but tiles are fixed at 128 or 192 px (`App.tsx:1254`). Add the slider or fix the README.

39. **Details-panel errors are swallowed (S)**
    - `headObject` failures are ignored (`PreviewPane.tsx:159-162`), so an object deleted elsewhere still shows old details. A failed `loadMore` leaves the list stuck until a full Retry.

40. **App actions aren't in the macOS menu bar (M)**
    - No custom app menu is set up, so New Folder, Upload, Go Up, Refresh and Search aren't listed there with their shortcuts.

**Top 5 to fix first:**
- #2 and #3: stale list after switching bucket or folder.
- #4 and #5: silent overwrites on rename and upload.
- #6: the download path escape.
- #1: folder sizes are a dead feature.
- #9: shortcuts acting behind open dialogs.

---

## Mobile

I found 40 items. Everything below is checked in the code, except a few on-device behaviours marked "likely". I didn't edit, build or launch anything. Paths are relative to the worktree root (`/Users/erikkubica/Development/Personal/s3-browser/.claude/worktrees/app-ux-functional-improvements-bf3e78`).

## 1. Bugs / breakages

1. **Android back exits the app while the "Connect Kybl Storage" dialog is open.** `kyblDialog` is missing from both `back()` and the `depth` count. On the home screen depth is 0, so back during first-run sign-in quits the app; inside a bucket it pops a folder under the dialog. Evidence: `src/mobile/MobileApp.tsx:380-403` (the dialog itself is at :1278). **S**
2. **Any refresh drops a long folder back to its first 1,000 items.** Delete, rename, upload and move all reload through `reloadIfShowing`, which fetches page 1 again and replaces the list. If you had scrolled to item 4,000, the scroll position jumps and the viewer's index ends up on the wrong photo or gets clamped. Evidence: `MobileApp.tsx:229-233`, `:249-255`, `:369-373`. **M**
3. **Move/copy silently overwrites files on the phone.** Desktop warns about name clashes (`src/App.tsx:840`); the mobile `relocate` has no such check (`MobileApp.tsx:699-718`). **S-M**
4. **Downloads silently overwrite local files with the same name.** The local path is `dir/e.name` (`MobileApp.tsx:559`), and `transfers.rs:368` renames the `.s3part` over whatever is already there. Two `IMG_0001.jpg` from different folders overwrite each other. **S**
5. **The whole file list re-renders every 120 ms while any transfer or job runs.** `useActiveCount` subscribes to the full transfer and job lists with no selector (`TransfersScreen.tsx:10-17`), and it's called at the top of `MobileApp` (:174). The rows aren't memoized, so thousands of rows re-render about 8 times a second. `store.ts` supports a selector; desktop keeps this subscription inside `TransferPanel` instead. **S**
6. **On Android 7–10 downloads go somewhere the user can't find.** The minimum Android version is 7 (minSdk 24), and on 7–10 writing to `/storage/emulated/0/Download/Kybl` needs `WRITE_EXTERNAL_STORAGE`, which isn't declared. The app then falls back to its private folder, but the UI (`MobileApp.tsx:52`) and the notification (`TransferService.kt:187`) still say "Download/Kybl". The hardcoded `/storage/emulated/0` also breaks work profiles. Evidence: `src-tauri/src/mobile.rs:97-103`. **S-M**
7. **Search results don't update after delete, rename or move.** While searching, the list comes from `search.results` (`MobileApp.tsx:344-346`), but the actions only reload the folder listing (:598, :694, :717). Deleted files stay in the results. **S**
8. **Video controls in the viewer are likely unusable.** The stage captures every touch (`Viewer.tsx:100`) and has `touch-action: none` (`mobile.css:1382`). Dragging the scrub bar will likely page the viewer, and taps toggle the controls instead. Verify on a device. **S-M**
9. **Viewer video problems:**
   - The neighbouring slide stays mounted and is never paused, so a video you swipe away keeps playing off screen (`Viewer.tsx:234-235`, `:257-259`).
   - mkv, avi and wmv count as "media" (`format.ts:80` → `isMedia` at `MobileApp.tsx:82`), and with no `onError` they show a dead player.
   
   **S**
10. **Big phones switch to the tablet layout when rotated.** `useWide` only checks width ≥ 900 px (`ui.tsx:24`); Pro Max/Plus iPhones are about 930 pt wide in landscape. The sidebar appears and photos stop opening in the swipe viewer (`MobileApp.tsx:501`). Also require a minimum height. **S**
11. **"Download folder" gives no feedback while it lists the folder.** `listAllUnder` runs before any toast (`MobileApp.tsx:561-566`). A big folder looks like nothing happened, so people tap again and get duplicate downloads. **S**
12. **If loading connections fails, the onboarding screen appears.** The error path sets the connection list to empty (`MobileApp.tsx:312-315`), so the user sees "Your buckets, in your pocket" (:1557) and may add duplicate connections. **S**

## 2. High-impact UX fixes

13. **No swipe-back on iOS.** The history trick only helps Android; WKWebView's back gesture isn't enabled and there's no edge-swipe code (`MobileApp.tsx:405-440`). Add a JS edge swipe that calls `back()`. **M**
14. **Going up a folder loses the list and the scroll position.** `go()` clears the listing and fetches it again, and the scroller is keyed by location (`MobileApp.tsx:257-275`, `:917`). Cache recent listings and their scroll positions. **M**
15. **No pull-to-refresh.** Refresh is hidden in the More menu (:907) and shows nothing visible when the list already has items (:992). **S-M**
16. **Nothing refreshes when the app comes back to the foreground or the network returns.** There are no visibility or online/offline listeners anywhere in `src`. **S**
17. **Lists and grids aren't virtualized.** Every loaded entry is rendered (`MobileApp.tsx:1015-1054`), and each thumbnail has its own IntersectionObserver (`rows.tsx:60`). `useWindowed.ts` already exists for desktop. **M**
18. **Photo folders show generic icons by default.** `listThumbs` is off by default (`settings.ts:56`), yet photo folders switch to grid view automatically (`MobileApp.tsx:366`). The viewer then has no placeholder image either (`Viewer.tsx:222`). Default it on for Wi-Fi, or ask once in a photo folder. **S**
19. **The viewer downloads full originals for the current photo and both neighbours** (`Viewer.tsx:40-49`). That's 10–25 MB per photo on mobile data, plus memory pressure. Show a screen-sized thumbnail first and load the original on zoom. **M**
20. **"Newest" and "Largest" only sort the pages already loaded** (S3 returns 1,000 per page) (`MobileApp.tsx:352-360`). In camera folders that's misleading; load everything with progress, or say so. **S-M**
21. **Long-press does different things:** select in the list, action sheet in the grid (`MobileApp.tsx:1050` vs `:1026`). Make it select everywhere, ideally with drag-to-extend. **S**
22. **Files with no preview are a dead end.** The detail screen says "No preview for this file type" and only offers Download (`PreviewPane.tsx:284-286`). Add "Open in…"; Android already declares a FileProvider that nothing uses (`AndroidManifest.xml:51-59`). **M**
23. **"Share" in the viewer only copies a link** (`Viewer.tsx:275` → `copyLink`). Offer the system share sheet for both the link and the file. **M**
24. **Transfers die when the iPhone app goes to the background.**
   - There's no iOS background task; the transfer-keepalive code is Android-only (`transfer_notice.rs:43-95`).
   - An upload has no per-part resume: one failed part aborts the whole multipart upload and Retry starts from 0 (`transfers.rs:229-266`).
   - A download gives up after 8 resume attempts, about 2.5 minutes (`transfers.rs:279-283`).
   
   **M** for a background task, **L** for full background transfers.
25. **Toasts can't be tapped to act.** One says "Open Transfers to retry" (`MobileApp.tsx:336`), but tapping a toast only dismisses it (`Dialogs.tsx:249`). Give it an Open/Retry action. **S**
26. **No filter-as-you-type.** Search needs Enter and always scans every subfolder (`MobileApp.tsx:741-759`). Filter the current folder as you type, and keep the deep search as an explicit action. **S**

## 3. Features worth adding

27. **Share files into Kybl from other apps.** There's no Android share target (`AndroidManifest.xml:30-43`) and no iOS Share Extension. **M** Android / **L** iOS
28. **Save to Photos on iOS.** Downloads only go to the Files app's Documents folder (`mobile.rs:94-95`). **M**
29. **"Take photo/video" in the add sheet** (`MobileApp.tsx:791-798`). **S-M**
30. **Camera roll auto-backup to a bucket** — the main reason people want a storage app on their phone. **L**
31. **App lock with Face ID / fingerprint, plus blur in the app switcher.** Separately, Android stores secret keys as a plain JSON file (`state.rs:238`); wrap them with Android Keystore. **M**
32. **Open finished downloads from Transfers.** Rows aren't tappable (`TransfersScreen.tsx:105-135`). **S-M**
33. **HEIC support.** It's left out of web images (`format.ts:160`) and thumbnails (`thumbs.ts:6`), so iPhone photos get no thumbnail, no viewer and "No preview". iOS WebKit can render HEIC itself. **M**
34. **Folder size on the phone.** Desktop has it (`useFolderSizes`, `App.tsx:198`); add an "Info" action on folders. **S**
35. **Wi-Fi-only setting for transfers and thumbnails.** **S-M**
36. **Notification actions.** Add Cancel to the progress notification; tapping should open Transfers, not just the app (`TransferService.kt:148-172`). **S**

## 4. Polish

37. **Tap targets under 44 pt:** list/grid toggle 36×28 (`mobile.css:474`), sort pill 32 high (:445), search clear 20×20 (:2184). **S**
38. **No haptics on iOS.** The only haptic call (`rows.tsx:25`) is a web API that iOS WebViews ignore. Use a haptics plugin for select, delete and refresh. **S**
39. **Text size doesn't follow the system setting.** Font sizes are fixed px, and the existing text-size setting isn't in the mobile Settings screen (`SettingsScreen.tsx:51-69`). **S-M**
40. **Small selection and list gaps:**
    - Deselecting the last item leaves selection mode (`MobileApp.tsx:805`).
    - Hiding a bucket by long-press is only hinted at once something is already hidden (:1493).
    - Recent places can't be removed.
    
    **S**

**Suggested first batch, all small or medium:** items 1, 2, 5, 3/4, 13, 14, 15, 18.