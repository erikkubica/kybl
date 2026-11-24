# Kybl: every feature

A complete catalog of what Kybl does, written from the code (November 2026). It covers the desktop app (macOS, Windows, Linux) and the phone app (Android, iOS).

On macOS, shortcuts use ⌘ ⌥ ⇧ ⌃. On Windows and Linux, ⌘ becomes Ctrl and ⌥ becomes Alt. "This computer" is the built-in local-disk connection: "This Mac" or "This PC".

## Contents

1. [Platforms, window and layout](#platforms-window-and-layout)
2. [File browser](#file-browser)
3. [Connections, transfers and jobs](#connections-transfers-and-jobs)
4. [Settings, updates, account and more](#settings-updates-account-and-more)
5. [Phone and tablet app](#phone-and-tablet-app)
6. [Appendix: where the README is out of date](#appendix-where-the-readme-is-out-of-date)

## Platforms, window and layout

### Platforms

| Platform | Shipped as | Notes (from code and `.github/workflows/release.yml`) |
|---|---|---|
| macOS (Apple Silicon and Intel) | Two builds, `Kybl_<arch>.app.tar.gz` and a .dmg/app | Native menu bar, menu-bar (tray) icon, Dock hide when running in the tray, overlay title bar with traffic lights. Signing is ad hoc (`signingIdentity: "-"`), so the updater checks the new app's code signature against the running one. |
| Windows | NSIS `-setup.exe` (or `.msi`) | No menu bar. The page's own shortcuts cover the keys. System tray icon. Update runs the installer in passive mode and relaunches. |
| Linux | AppImage, `.deb`, `.rpm` | No menu bar. Tray icon. AppImage updates itself in place; `.deb` and `.rpm` just open the download. |
| Android | `Kybl.apk` (universal, arm64 + armv7) | Min SDK 24, target 36. Bundle id `app.kybl.mobile`. System back button wired to the app. Share target ("Kybl" in other apps' share sheets). `kybl://` deep links for sign-in. Foreground service keeps transfers alive. |
| iPhone and iPad | Unsigned `Kybl.ipa` for sideloading (AltStore, SideStore, Sideloadly) | iOS 15 minimum. An AltStore source JSON is published with each release. Face ID, Photos access, background task for transfers, Files app sharing (`UIFileSharingEnabled`). Not on the App Store. |

- The website and `llms.txt` agree: macOS, Windows, Linux, Android, and iPhone "by sideloading".
- The desktop window is created at runtime (config has `create: false`), so Kybl can start hidden at login and only build a window when opened.
- Desktop only: tray icon, launch at login, folder sync, drives (mount as a drive), terminal panes, in-app editor sessions.
- Phones get the same Rust backend with a separate touch UI. The UI is picked automatically on iOS and Android, and a tablet-sized window gets a wide layout.

### Desktop window layout

#### 2.1 Window itself
- Default size 1320 x 820, minimum 960 x 560.
- Overlay title bar with a hidden title. Traffic lights sit at x15, y27. Empty stretches of the workspace bar and the sidebar top act as the drag region.
- Drag and drop from other apps is enabled (`dragDropEnabled`). Files dropped from Finder or Explorer upload into the pane under the pointer.
- The native title bar and menus follow the chosen theme (System follows the OS).
- **Window state persistence:**
  - **No window-state plugin is installed.** The window position and size are not remembered between launches (it always opens at 1320 x 820 from the config).
  - What is remembered is the content: last location of each pane, layout of panes, workspaces, sidebar folded or not, sort, tile size, Quick Look info column, and so on. These live in `localStorage` (keys starting `s3b.`).
- **Closing the window:**
  - By default the window hides and Kybl keeps running in the menu bar or tray (setting "Keep running in the menu bar").
  - After 60 seconds hidden with nothing running, the window (and its web view) is destroyed to free memory. It is rebuilt when opened again.
  - With "keep running" off, closing the window quits. If transfers or bucket operations are running, or the in-app editor has unsaved documents, a native prompt asks first.
  - Quit (the menu item, Cmd+Q, or the tray) runs the same check. On confirmed quit it stops transfers, aborts open multipart uploads, and removes partial downloads.
- **Started at login:** launches with `--hidden`, so only the tray icon shows (on macOS the Dock icon is hidden until the window is opened).
- Clicking the Dock icon while the window is hidden brings it back.

#### 2.2 Sidebar
Top to bottom (in the full sidebar):
1. **Fold button** next to the window controls. Shortcut Alt+Cmd+S (or Show or Hide Sidebar in the View menu).
2. **Find connection** field. Only shown automatically when there are more than 8 connections; Alt+Cmd+F shows it for a short list too. It searches names, servers, user names, kinds and groups, highlights hits, and arrow keys plus Enter open the result. Esc clears, then leaves.
3. **Favorites** list (pinned folders or roots). Each row opens the place; hover shows an x to remove. A favorite whose connection was deleted is greyed with an explanation.
4. **Recent** list. Only appears when there are more than 10 connections; shows the 5 most recently opened (not the one on screen).
5. **Connections** list (count shown when many):
   - Connections with buckets or roots fold open to show them: S3 buckets, drive volumes, or This Mac's folders (Home, Documents and so on).
   - A connection with a single root (FTP, SFTP, WebDAV and similar) is one row that opens directly.
   - **Kind sections:** once there are 3 or more connections of one server kind, they go into a folding section called FTP, SFTP or WebDAV.
   - **Groups:** connections can be filed into nested groups (slash paths such as `Clients/Acme`). Groups fold open like folders. Groups are listed before connections.
   - Per-bucket actions: hide or show a bucket in the sidebar (eye icon), "show hidden" reveal, New bucket (Kybl Storage), Open bucket by name (S3).
   - Badges: a provider monogram per connection (Kybl uses its own mark, This Mac a device icon). A "Kybl's access to this account ended. Sign in again" badge on cloud-drive or Kybl connections whose access was revoked. A tunnel badge. A drive badge on mounted connections or buckets (opens a drive menu).
6. **Footer:** "New connection", a folder-sync indicator (idle, scanning, syncing, error or paused; clicking opens Settings, Folder sync), and Settings (Cmd+,).

**Context menus in the sidebar**
- Connection: Sign in again (if needed), Open or Expand or Collapse, Copy everything to…, Move to group (list of groups, New group…, No group), Edit connection…. Also drive items and share-placeholders items.
- Bucket: Open, Copy everything to…, hide or show in the sidebar, New bucket and similar.
- Group: Rename group…, Ungroup, Collapse all, New connection in the group.
- Kind section: Expand or Collapse, Collapse all, "New FTP connection…" and so on.

**Folded sidebar (icon rail)**
- Folding the sidebar leaves a narrow rail (like a code editor's activity bar): favorites as starred icons, then each connection as an icon, then a kind section icon with a count.
- Clicking a connection icon opens a menu of its buckets next to it. Right-click gives the connection menu.
- Resting the pointer on an icon for about 0.3 s slides the full sidebar in over the panes ("peek"). It goes away when the pointer leaves, a menu closes, and focus leaves it. Opening a place from it puts it away again.
- With more than 10 connections the rail keeps only the one on screen plus recent ones, and adds an "All connections" button (Alt+Cmd+F) that brings up the full sidebar with the find field ready.
- The rail has the same footer buttons (New connection, sync indicator, Settings).
- Hidden or shown is remembered (`sidebarHidden` setting).

#### 2.3 Panes
- **Count and layout:** up to **6 panes**, arranged as a tree of splits (like editor groups in a code editor). Each split is a row (side by side) or a column (stacked). Same-direction splits are kept flat.
- Each pane is either a **file pane** (a connection, a root and a folder) or a **terminal pane** (see 2.5).
- **Minimum sizes:** a pane needs at least 340 px wide and 220 px high. If the window is too small to show all panes, only the active pane is drawn and the workspace bar shows a small numbered **pane switcher** (with the active pane's folder name). Making the window bigger brings the full layout back. Saved sizes are never changed by shrinking.
- **Splitting:** Split Right (Cmd+\), Split Down (Shift+Cmd+\), or from the pane button's menu: Split Right, Down, Left or Up. The new pane starts in the same place.
- **Resizing:** drag a divider. Double-click shares that split's room evenly. The divider is keyboard focusable (arrow keys nudge it), with `aria-valuenow` and a "Resize the panes" label. "Make panes the same size" is in the panes menu.
- **Moving panes:**
  - Drag a pane by the empty part of its header. A ghost follows the pointer. Over another pane an overlay shows where it would land: an edge half docks it there (that pane splits that way), the middle swaps the two. Zones that would leave too little room show as refused. Escape cancels.
  - Keyboard: "Move pane" submenu (Left, Right, Up, Down) swaps with the neighbour or steps out of a stack.
  - Swap Panes (Shift+Cmd+S).
  - Dropping a dragged pane on a **workspace tab** moves it into that workspace. Resting on a tab for 0.5 s opens that workspace so it can be dropped into the layout.
- **Focus:** click a pane, Tab (with two or more file panes), or Alt+Cmd+Arrow to focus the pane in that direction (in a cramped window, previous or next). The active pane is marked. Menu items such as Switch Pane and Same Folder in Other Pane act on it.
- **Closing:** Close Pane (Cmd+W while several panes are open), or "Close other panes". Closing one of several asks first when a terminal has a busy shell.
- **Synchronized browsing:** each divider carries a small round link button for every pair of panes that face each other across it. Switching one on makes the two panes follow each other into subfolders and back up. A lit button or divider shows which are linked. Links can chain (1-2 and 2-3 moves all three). Also in the pane's "..." menu and the command palette ("Synchronize Browsing with ...").
- **Two-pane (commander) tools:** need a second file pane.
  - Copy to Other Pane (F5), Move to Other Pane (F6), Quick Look (F3), New Folder (F7), Delete (F8).
  - Same Folder in Other Pane, Compare Folders, mirror to pane, Swap Panes.
  - Dragging across panes: drop copies, hold Cmd to move (as listed in Keyboard shortcuts).

**What each pane shows**
- **Header toolbar** (also the drag handle for moving the pane):
  - Connection badge button (opens a menu to switch the pane's connection or bucket; label depends on kind).
  - Connection name (clicking goes to the top).
  - Enclosing-folder button (Cmd+Up) and an editable path title or breadcrumbs. Typing a path acts as Go to folder.
  - Star to add or remove the folder from favorites.
  - A git branch chip after the path when the folder is in a git repo.
  - "..." more actions (also holds items the narrow pane folded away).
  - Upload or create menu (Upload files Cmd+U, Upload folder Shift+Cmd+U, New folder Shift+Cmd+N). Read-only for archives.
  - View options menu: As list or grid, Compact layout, Bigger or Smaller icons (grid), Sort by Name, Date modified, Size, Kind, Ascending or Descending, Show hidden files (this-computer panes).
  - Search or filter field (Cmd+F). Type to filter; Return searches subfolders. Names or Contents mode extras. Stop and Clear buttons.
  - Panes button (menu: split four ways, make same size, move pane, mirror, close, close others).
- **Status bar per pane** (not one for the whole window), shown under the list:
  - Item count and total size ("+" when the server has more).
  - Selection count and size, with a clear button.
  - "Whole folder: X in N objects" (folder size, computed in the background), or "Adding up the folder..." or a failure note.
  - Right side: "Loading the rest of the folder... N so far" with spinner, "Sorted the first N items only", "In order: the first N items. More load as you scroll", and a busy line with a Stop button (long operations).
- **Banners** under the header for search results, "Search inside files", and listing errors with "Try again".
- **Empty states** (see section 7).

**Sort, view and hidden files are per pane**, saved with the pane (a list/grid choice, sort, hidden-files toggle, compact flag, tile size).

#### 2.4 Workspaces
Workspaces are named pane layouts the window switches between, shown as **tabs** in the **workspace bar** along the top, right of the sidebar. They work like browser tabs.

- **Create:** the "+" button or Cmd+T. The "+" opens a menu of saved workspace recipes (see below) plus a blank one. A new workspace opens where the active pane is, named "Workspace 2", "Workspace 3"... (lowest free number).
- **Switch:** click a tab; Ctrl+Tab and Ctrl+Shift+Tab; Shift+Cmd+] and Shift+Cmd+[; Alt+Cmd+1 to 8 for the first eight, Alt+Cmd+9 for the last. Also via the command palette ("Switch to Workspace ...").
- **Rename:** double-click the tab, press F2 on a focused tab, or Window > Rename Workspace. Return keeps, Escape cancels. Names up to 80 characters.
- **Reorder:** drag a tab sideways (live reflow, animated drop), or Alt+Shift+Left or Right with a tab focused. Window menu: Move Workspace Left or Right (Alt+Shift+Cmd+[ or ]).
- **Tab extras:**
  - Colour dot (9 colours: red, orange, yellow, green, teal, blue, purple, pink, gray).
  - A cog (shows on hover) for workspace settings.
  - Tooltip shows the pane count when over 1.
  - A long strip scrolls (mouse wheel works sideways) and fades at hidden edges. The active tab is always scrolled into view.
  - Tabs are a proper tab list (arrow keys, Home, End, Enter or Space, F2, context-menu key).
- **Tab context menu:** Rename (F2), Settings..., Duplicate, Close workspace, Close other workspaces.
- **Closing:** Close Workspace (menu or tab menu); there is always at least one. A toast says "Closed 'Name'" (adding "; its terminal ended" when shells were running) with an **Undo** button that restores the workspace in its old position (terminals come back fresh).
- **Workspace settings popover** (cog): Name, Color, **Recipe**, Duplicate, Close workspace.
  - **Recipe:** a saved copy of the layout (splits, each pane's place and view, terminal folders and their startup commands). Buttons: Save layout as recipe, Update, Reset to recipe (closes what the workspace shows and reopens the recipe), Delete recipe. Each terminal in the recipe has a "runs on start" textarea (one command per line). "Open from the recipe when Kybl starts" makes the workspace start from its recipe at launch instead of where it was left.
  - Recipes are kept per device, apart from workspaces, so closing a workspace does not lose its recipe.
- **What is saved per workspace** (kept in `localStorage`, key `s3b.workspaces`): its name, colour, start mode, recipe id, the tree of splits and their sizes, synchronized-browsing links, which pane was active (and recent-pane order), and for every pane its place (connection, bucket or root, folder), view (list or grid), sort, hidden-files, compact, tile size, and terminal place. Scroll position, selection and filter text are used while switching but are **not** saved between launches.
- Switching is a snapshot swap into a fixed set of pane slots, so it is quick (listings are cached). **Transfers and jobs belong to the app, not to a workspace**, and keep running while you switch.
- First launch with workspaces turns the old single layout into "Default workspace", so nothing is lost.
- **Moving things between workspaces:**
  - Drag a pane onto a tab (see 2.3).
  - Drag files from a list onto a tab: dropping uploads or moves them to the folder of that workspace's active pane. A toast says where, with a **Show** button. Dropping on "+" opens a new workspace at the root the items came from.
  - Files dragged in from Finder or Explorer onto a tab (or "+") are uploaded to that workspace's active pane. Resting 0.5 s on a tab switches to it.

#### 2.5 Other tabs and panels that exist
- **Workspace tabs** (above) are the only tabs in the main window. There is no per-pane tab strip.
- **Terminal pane:** a pane slot can be a terminal (toggle with View > Terminal, Ctrl+`, opens one below the active pane in the same folder). It is saved in workspaces and recipes (with startup commands). Pasting several lines asks first (Settings, General, Safety). Terminals end with their window or workspace.
- **Activity panel** (bottom of the window, collapsible, "Activity"): tabs Activity (in progress), Failed, Done, Log (message log), and Jobs (copies and moves between connections). Header buttons: speed limit menu, Resume all, Pause all, Retry failed, Cancel transfers, Clear finished, Clear failed. Per-row: move to top, pause or resume, cancel, retry, open, show in Finder or Explorer, verified badge. A "Copy the log as text" button. Synced folders and custom actions show as rows too. Opens by itself when a transfer starts (setting). Shown with "editing" chip when files are open in the in-app editor.
- **Settings page:** a full-window page (not a modal), see section 3.
- **Document editor:** full-window "Open" or a sheet ("Edit in Kybl"), see other slices.
- **Command palette** (Cmd+K): see 2.7.
- **Quick Look** (Space) with optional info column.

#### 2.6 Menu bar (macOS only)
Windows and Linux get **no menu bar** (it would be drawn inside the window, which does not fit the design); their shortcuts work from the page. Keys the page already handles (Cmd+R, Cmd+F, Cmd+A, Cmd+Up, Delete, Cmd+Backspace) have no menu accelerator so a key never acts twice.

| Menu | Item | Shortcut |
|---|---|---|
| **Kybl** | About Kybl | |
| | Check for Updates... (opens Settings, General and checks) | |
| | Settings... | Cmd+, |
| | Services, Hide Kybl, Hide Others, Show All | system |
| | Quit Kybl (asks if transfers run) | Cmd+Q |
| **File** | New Connection... | |
| | New Folder | Shift+Cmd+N |
| | Upload Files... | Cmd+U |
| | Upload Folder... | Shift+Cmd+U |
| | Download | Shift+Cmd+D |
| | Get Info | Cmd+I |
| | Edit | Cmd+E |
| | Rename... | (F2 on the page) |
| | Duplicate | Cmd+D |
| | Delete... | (Cmd+Backspace on the page) |
| | Close Window | Cmd+W (page handles it first while several panes are open) |
| **Edit** | Undo, Redo, Cut, Copy, Paste, Select All | standard (for text fields) |
| **View** | Command Palette... | Cmd+K |
| | Refresh | (Cmd+R on the page) |
| | Search... | (Cmd+F on the page) |
| | Show Hidden Files | Shift+Cmd+. |
| | Show or Hide Sidebar | Alt+Cmd+S |
| | Find Connection... | Alt+Cmd+F |
| | Bigger Icons | Cmd+= |
| | Smaller Icons | Cmd+- |
| | Compact Layout | |
| | Split Right | Cmd+\ |
| | Split Down | Shift+Cmd+\ |
| | Close Pane | |
| | Switch Pane | (Tab) |
| | Swap Panes | Shift+Cmd+S |
| | Same Folder in Other Pane | |
| | Compare Folders | |
| | Copy to Other Pane | (F5) |
| | Move to Other Pane | (F6) |
| | Terminal | Ctrl+` |
| | Enter Full Screen | system |
| **Go** | Back | Cmd+[ |
| | Forward | Cmd+] |
| | Enclosing Folder | (Cmd+Up) |
| | Go to Folder... | Shift+Cmd+G |
| **Window** | Minimize, Zoom | system |
| | New Workspace | Cmd+T |
| | Show Previous Workspace | Shift+Cmd+[ |
| | Show Next Workspace | Shift+Cmd+] |
| | Move Workspace Left, Move Workspace Right | |
| | Rename Workspace... | |
| | Workspace Settings... | |
| | Close Workspace | |
| | (macOS also lists open windows here) | |

Menu events are sent to the page as a `menu` event with the item id; the same ids are used by keyboard shortcuts and the command palette, so all three behave identically.

**Tray (menu-bar or system tray) menu** (desktop): a status line ("No folders synced yet", "Syncing... X of Y files", "N folders need attention", "Up to date . N folders"), Open Kybl, Sync now, Pause syncing, Sync settings..., Drives submenu (one item per mounted drive, opens it in Finder), Check for updates... (becomes "Update to Kybl x.y.z..." when one is found), Quit Kybl. Extra items "Review N conflicts..." and "Confirm deletions in N folders..." appear only while something waits. The tray tooltip repeats the status. Left click shows the menu.

#### 2.7 Command palette (Cmd+K)
- One field that finds connections, places, commands and the files of the folder on screen, ranked together. Loaded on first use as its own chunk. Recent picks and recent places are remembered.
- Prefixes: `>` commands only, `@` connections only, `/` or `~` types a path (Tab completes a folder).
- Enter opens in the active pane; Cmd+Enter opens in a new pane to the right (or shows a file in the list).
- Commands disabled for the current state are listed greyed with the reason ("Open a folder first", "Only one pane is open", ...).
- Command groups: File (new folder, upload, download, open, quick look, get info, rename, duplicate, copy, cut, paste, delete, select all, undo), Connections (new, import from FileZilla/Transmit/Cyberduck, find in sidebar), View (refresh, search, hidden files, sidebar, list or icons, sort by name, date, size, kind, reverse order, bigger or smaller icons, compact or roomy, show activity), Go (back, forward, enclosing folder, go to folder), Panes (split right, split down, close, close others, same size, switch, swap, same folder, compare, copy or move to other pane, synchronize browsing with a named pane, focus pane left, right, up, down), Workspaces (new, switch to a named one, next, previous, rename, settings, move, close), Kybl (Settings, Settings: each page, Theme: System, Light, Dark).
- Other features can register their own commands (for example drives or mirrors).

#### 2.8 Keyboard navigation and accessibility
- Full shortcut list (also on Settings, Keyboard shortcuts): palette, search, go to folder (Shift+Cmd+G or Cmd+L), back and forward, up, refresh, arrow selection, Home and End, Page Up and Down, type to jump to a name, select all, extend (Shift+click) and add (Cmd+click) to selection, drag-select an area, open (Cmd+O), edit (Cmd+E), Quick Look (Space), Get Info, actions menu (Shift+F10), copy, cut, paste, duplicate, undo (Cmd+Z), Alt while dragging to copy, rename (F2), new folder, upload, download, delete, Esc to clear or close, settings, show hidden, grid tile size, split, close pane, focus pane, terminal, pane commander keys, workspace shortcuts. On Windows and Linux the Cmd glyphs show as Ctrl, Alt and Shift.
- Lists are real ARIA grids (`role="grid"`, `aria-multiselectable`, rows); the sidebar find field is an ARIA combobox with `aria-activedescendant`; workspace tabs, pane switcher and settings sections are tab lists or groups with `aria-selected` and `aria-pressed`; switches use `role="switch"`; toasts are in an `aria-live` region (errors use `role="alert"`); the update card is a live status; dividers are labeled and keyboard-resizable. Icon buttons carry `aria-label`s.
- Sidebar rows: Enter or Space activates; Left and Right arrows fold groups.
- `prefers-reduced-motion` is respected in 5 places in the CSS. Text size is scalable (see settings). There is no screen reader mode or high-contrast setting beyond choosing a colour scheme.
- Text over native webview zoom (not font-size only), so everything scales together.
- Workspace-bar tab order and dialogs keep the keyboard: clicking a tab does not steal focus from the list.

#### 2.9 Drag and drop
- **Between panes (same window):** drag items from a list onto another pane or folder. Plain drop in the same pane's folder moves; across panes a drop copies and Cmd moves (see shortcuts); Alt copies instead of moving.
- **Between workspaces:** drag items onto a workspace tab (drops into that workspace's active pane, with a Show toast), rest on a tab to switch, rest on "+" to open a new workspace at the source root.
- **Panes themselves:** drag a pane header to rearrange (2.3).
- **From Finder or Explorer into Kybl:** files and folders go to the pane under the pointer (or the active one) as uploads; into a terminal pane, the paths are typed in instead.
- **Out of Kybl into other apps:** while dragging items, leaving the window hands over to a native drag. Items on this computer go as real files. Small files from other connections download to a temp folder as the pointer nears the edge, so chat apps and mail accept them. On macOS anything else goes as a file promise (the receiving app, Finder or Mail, says where, and it downloads like any download). Windows and Linux have no promises: such items stay behind.
- **Between Kybl windows:** there is only one main window, so there is no window-to-window drag.

#### 2.10 Other desktop shell things
- Sync indicator, tray, and "Open at login" described above.
- Stale window refresh: the page refreshes what it shows when the window returns to the front after a while away (`app-resumed`).
- Mouse back and forward buttons navigate history.
- The web view's own context menu (Reload, Inspect) is suppressed in the sidebar.
- Per-connection image mode (Photos setting) overrides can be set from a connection's context menu.

## File browser

### Overview

Conventions used here: on macOS the shortcuts use ⌘ ⌥ ⇧ ⌃. On Windows and Linux the app swaps ⌘ for Ctrl and ⌥ for Alt. "This computer" is the built-in local-disk connection ("This Mac" / "This PC"). Where a menu item only exists for some connections, the condition is stated.

What the app does not have (checked in code): no "New file" command (only New folder), no column (Miller) view (only list and grid), no object-versions or version history screen on desktop, no right-click "Properties" item (Get Info is the equivalent), no redo (Undo only), and no Back or Forward buttons in the toolbar (history is keyboard and mouse buttons only).

---

### Connection capabilities that change the menus
Where: backend capability flags, read by the menus.

| Capability | Which connections | What it switches |
|---|---|---|
| Share link | S3-compatible (a real presigned link with a chosen lifetime), Dropbox and OneDrive (a temporary download link). Not available on SFTP, FTP, WebDAV, Azure, Google Cloud Storage, Google Drive or This computer. | "Copy share link", the Share link section in Get Info |
| Permissions (chmod) | SFTP, FTP/FTPS | "Permissions…" |
| Symbolic links | SFTP | "Show original", "Make link…" |
| Trash (restorable delete) | This computer, Google Drive, OneDrive, Dropbox | "Move to Trash" / "Move to Recycle Bin" instead of "Delete" |
| S3 properties, tags, storage class | S3-compatible (including Kybl Storage) | Get Info "Edit properties", Storage class column |
| S3 URI | S3-compatible (and Kybl Storage) | "Copy S3 URI" |
| Local paths | This computer only | Show in Finder, no Download, no Sync/Keep/Mount, hidden-files toggle, git marks |
| Terminal | This computer (not on Windows), SFTP servers | "Open terminal here", "Open in terminal" |
| Search inside files | This computer, SFTP | "Contents" search mode |
| Server-side Actions | SFTP only (Where = on the server) | custom actions that run over SSH |

---

### Context menus
Where: item menu, empty-space menu, toolbar "…" menu, sidebar menus.

Opened by right-click, Ctrl+click on a Mac, the menu key, or Shift+F10 (from the keyboard the menu opens next to the selected row, or the list if nothing is selected). Separators that would end up first, last or doubled are dropped. Items that don't apply to the situation are left out rather than greyed, unless noted "greyed".

#### Right-click on a file or folder (one item, or several selected)
If the clicked item is already part of the selection the menu works on the whole selection; otherwise the click first selects only that item. Inside an opened archive (read-only) every item that writes is removed: Cut, Duplicate, Rename, Delete / Move to Trash, Move to, Paste, Sync, Keep on this device, Mount as drive, Copy or move to…, Copy share link, Copy to another connection.

In order, top to bottom:

| Item | When it appears |
|---|---|
| **Open** (↵ for a folder, ⌘O for a file) | Always. For several files it reads "Open N files" (greyed if only folders are selected). A folder opens in the list. A file opens in Kybl's viewer or editor (text, code, Markdown, CSV, JSON, Word, Excel, PowerPoint, Google Docs exports) or in its default app. |
| **Open in default app** | One file that Kybl would otherwise open in its own viewer (not on This computer, where files already open in their own app). |
| **Quick Look** (Space) | One file. |
| **Get Info** (⌘I) | Always. |
| **Show original** | One symbolic link, on SFTP. Jumps to the folder the link points into and selects the target. |
| **Permissions…** (or "Permissions of N items…") | SFTP and FTP. |
| **Make link…** | One item, on SFTP. Makes a symbolic link next to it ("report link.pdf"). |
| **Show in folder** | One item, only inside search results. |
| **Open in terminal** | One folder, on This computer or an SFTP server. |
| **Show in Finder / Show in Explorer** | One item on This computer, or inside a folder kept on this device by sync (its copy on disk). |
| **Open with ▸** | One file (any connection; the file is downloaded to a temporary copy first), or a folder on This computer or in a synced folder. Lists the apps for that file type, the default one first and marked "default", icons shown. Ends with "Other…" (macOS, pick any .app) or "Choose another app…" (Windows). Programs, scripts and installers from a connection ask "Run …?" before opening. A Google Doc opens as what it exports to. |
| **Actions ▸** | Only when at least one enabled custom action takes the selection. Each entry shows a server icon or laptop icon, the shortcut as a hint, and "(n of m)" when it takes only part of the selection. Entries are greyed with "Fix it in Settings" when the command template is invalid. See Custom actions. |
| **Edit** (⌘E) | One file on a connection other than This computer (not a Google Doc). Opens a private copy in the default app and uploads each save. |
| **Edit with ▸** | Same condition. Lists apps like Open with, plus Other…/Choose another app…. |
| **Edit in Kybl** | One text-like file (text, code, JSON, Markdown, CSV) on any connection including This computer. Greyed with "over 5 MB" for larger files. This is the only edit item shown on This computer, where Open and Open with already edit in place. |
| **Download** (⇧⌘D), or **Download as <format>** | Not on This computer. For a Google Doc, Sheet or Slides the first export is the main item. |
| **Download as <other format>** | One Google Doc/Sheet/Slides: one item per further export format (for example PDF). |
| **Copy share link (24 hours)** | Connections with share links. The label shows the lifetime set in Settings. Greyed unless exactly one file is selected. |
| **Copy S3 URI** | S3-compatible connections. Greyed unless exactly one item is selected. |
| separator | |
| **Copy** (⌘C) | Always. |
| **Cut** (⌘X) | Always. |
| **Duplicate** (⌘D) | Always. |
| **Paste into “folder”** | One folder, when something is on the clipboard from the same connection. |
| **Copy to “<other pane>”** (F5) | Several panes open. Greyed when both panes show the same folder. |
| **Move to “<other pane>”** (F6) | Several panes open, except between This computer and a cloud (those only copy). |
| **Extract here** / **Extract N archives here** | Every selected item is a .zip, .tar, .tar.gz or .tgz. Inside an archive that is open as a folder it reads "Extract to “<folder the archive is in>”". |
| **Extract to…** | One archive selected, or items inside an open archive. Opens the destination picker (any folder, any connection). |
| **Compress “name”** / **Compress N items** | Not in search results. Not inside an archive. Makes a .zip. |
| **Compare files** or **Compare with “other.txt”** | Exactly two text files selected, or one text file here plus one text file selected in another pane. |
| **Copy or move to…** | Always. Opens the destination picker (a tree of every connection, opened at this folder). Copy/Move is chosen in the picker. |
| **Move to “<parent folder>”** | When not at the top level and not in search results. Moves the selection up one level. |
| separator | |
| **Calculate size** / **Calculate sizes of N folders** | At least one folder selected. |
| **Add to favorites / Remove from favorites** | One folder. |
| **Sync this folder…** | One folder, not on This computer. |
| **Keep on this device** (ticked "Kept on this device" once kept; clicking the ticked item stops keeping, after a question) | One folder, not on This computer. Makes a two-way synced copy in the Kybl folder and opens it. |
| **Mount as drive…** and the drive group (see below) | One folder, not on This computer. |
| **Mirror to…**, **Run “saved mirror”** | One folder. With more than two saved mirrors from that folder they collapse into "Run a saved mirror ▸". |
| separator | |
| **Rename…** (F2) or **Rename N items…** | Always. One item opens a name prompt, several open the Batch rename dialog. |
| **Move to Trash** (⌘⌫), with "…" when confirmation is on | Connections with a restorable trash. Called "Recycle Bin" on a Windows PC. |
| **Delete…** (⌘⌫), red, or **Delete N items…** | All other connections. |

#### Right-click on empty space in a pane
Opened on the blank area of a list or grid.

| Item | When it appears |
|---|---|
| **New folder…** (⇧⌘N) | Always (not in archives). |
| **Upload files…** (⌘U) | Always (not in archives). |
| **Upload folder…** (⇧⌘U) | Always (not in archives). |
| **Paste** (⌘V), shown as Paste “name” or Paste N items | Always, greyed when the clipboard is empty or from another connection. |
| **Select all** (⌘A) | Always, greyed when the folder is empty. |
| **Refresh** (⌘R), or **Search again** during a search | Always. |
| **Clear search** | While search results are showing. |
| **Calculate folder size** | Always. |
| **Sync this folder…** | Not on This computer. |
| **Keep on this device** / **Kept on this device** | Not on This computer. |
| **Mount as drive…** and the drive group | Not on This computer. |
| **Copy this folder to another connection…** (at the top of a bucket: "Copy everything to another connection…") | When the copy-to-connection feature is available. |
| **Mirror to…** and saved mirrors | Always. |
| **Copy S3 URI** | S3-compatible. |
| **Show hidden files** (⇧⌘.), ticked when on | This computer only. |
| **Open terminal here** (⌃`) | This computer (not Windows) and SFTP. |
| **Split ▸ Right / Down / Left / Up** | Always. Items grey out when there is no room or no free slot. Right = ⌘\, Down = ⇧⌘\. |

#### The toolbar "…" menu ("More actions")
Refresh (or Search again), Go to folder… (⇧⌘G), then: Add to / Remove from favorites, and a "Panes ▸" submenu when the pane is narrow. With several panes it also holds: "Open this folder in the <right/left/above/below> pane too", "Swap with the other pane" (⇧⌘S), "Compare with the other pane", "Synced browsing with…" (ticked when linked; a submenu when more than one pane faces this one), and "Mirror to the other pane…". Then the empty-space items (Calculate folder size, Sync, Keep, Mount, Copy to another connection, Mirror, Copy S3 URI, Show hidden files, Open terminal here), and last "Show activity".

#### The toolbar "Upload or create" button
Upload files… (⌘U), Upload folder… (⇧⌘U), New folder… (⇧⌘N). Disabled in an archive.

#### The toolbar "View options" button
As list, As grid, Compact layout, and (grid only) Bigger icons (⌘+), Smaller icons (⌘−). Then Sort by Name / Date modified / Size / Kind (ticked), Ascending / Descending, and "Show hidden files" (This computer only).

#### The "Panes" button menu
Split right / down / left / up. With several panes it adds: Make panes the same size, Move pane ▸ (left, right, up, down), Mirror to the other pane…, Close pane (⌘W), Close other panes.

#### Right-click on the list header (list view)
Column picker: Name (always on), Size, Modified, Kind, Storage class (S3-compatible only), ETag, and "Reset columns". Column widths are dragged on the header edge; double-click resets a width. Clicking a header sorts by it (Size, Modified, Kind, Name).

#### Right-click in the sidebar
| Where | Items |
|---|---|
| A connection | "Sign in again…" (when its sign-in expired), Open (a server's single root) or Expand / Collapse, "Copy everything to…" (not for This computer), the drive group ("Mount as drive…", see below), "Photos in lists" submenu-style group (As in Settings, Off, Placeholders, Thumbnails, and for remote connections "Share placeholders with other devices"), "Tunnels ▸" (SFTP connections that have saved tunnels, tick marks running ones), then for saved connections: "Move to group ▸" (New group…, No group, every group, current one ticked) and "Edit connection…". This computer is built in, so it has no group or Edit items. |
| A bucket (or one of This computer's folders) | Open, Copy everything to…, the drive group (not on This computer), Hide from the sidebar / Show in the sidebar. |
| A group folder | Rename group…, Ungroup, Collapse all. |
| A kind section (S3, SFTP, FTP…) | Expand / Collapse, Collapse all, "New <kind> connection…". |
| A mounted-drive badge | The drive group below. |
| The folded icon rail | Click an icon: a list of the connection's buckets (current one ticked), plus "New bucket…" (where a connection can create buckets) or "Open bucket by name…" (S3). Right-click a kind icon: its connections grouped, plus "New <kind> connection…". |
| A favorite | No right-click menu; it has a hover × button, "Remove from favorites". |
| The pane's connection badge (before the path) | A list of every connection, each with its buckets as a submenu, current one ticked, and "New connection…". |
| A workspace tab | Rename (F2), Settings…, Duplicate, Close workspace, Close other workspaces. |

The drive group appears in folder, bucket and connection menus. Not yet a drive: "Mount as drive…". Mounted: a heading "Mounted as drive “name”" with "Show drive in Finder" and "Eject" ("Unmount" off macOS). Mounting: a "Mounting as drive…" heading and "Drive settings…". Failed: "Try mounting again" and "Drive settings…" (or "Another copy of Kybl has this drive"). Ejected but still saved: "Mount as drive".

---

### File operations
Where: file operations and the dialogs behind them.

#### Copy, cut, paste, move
- **Copy / Cut (⌘C / ⌘X)** remember the items and also put their addresses on the system clipboard as text (S3 URIs on S3, full paths on This computer, paths in the root elsewhere), one per line.
- **Paste (⌘V)** drops into the folder on screen, or into a folder via "Paste into “folder”". A cut is used up only once the move actually ran.
- Paste works across connections: it takes the same route as dragging or F5/F6. Between two clouds a background job copies (a confirm with a path to edit comes first). Between This computer and a cloud the files are uploaded or downloaded, and the originals always stay (a cut becomes a copy there).
- **Copy or move to…** opens the destination picker. Folders on the same connection are copied or moved on the spot; anywhere else becomes a background job.
- **Move to “<parent>”** moves up one level.
- Copying into the folder the items are already in duplicates them as "name (1).ext" without asking.
- Dragging works too (see Drag and drop).

#### Rename and batch rename
- **Rename… (F2)** on one item opens a name prompt. It refuses empty or invalid names and names already taken in the folder. A file (not a folder) whose new name already exists asks "Replace…?". On S3, Azure and GCS a folder rename copies every file, so it carries a note; big files (64 MB and over) and folders there run as a job in Activity instead of a dialog.
- A successful rename offers Undo.
- **Rename N items…** opens **Batch rename**. Two modes:
  - Pattern: variables `{name}` (original name without extension), `{n}` and `{n:3}` (counter, padded), `{date}` or `{date:YYYY-MM-DD HH.mm}` (modified date), `{ext}`, `{size}`, `{folder}`. The extension is added back automatically unless the pattern places `{ext}`. Counter start, step, and order (As shown / Name / Date modified).
  - Find and replace: Find, Replace with, Use regular expression, Match case.
  - For both: Change case (Keep, lowercase, UPPERCASE, Title Case) and Extension (Keep, lowercase, UPPERCASE, Change to…, Remove).
  - A live preview of every row shows problems (empty name, "/" in a name, too long, duplicate, already taken) and nothing runs while any exist. It never overwrites. Swaps and chains (a to b, b to a) go through temporary names. It runs as one job with one Stop and one Undo, and a partly done batch can be retried.

#### Delete
- Delete key, ⌘⌫ (or F8 with several panes), or the menu item. On a connection with a restorable trash it reads "Move to Trash" (the dialog says you can restore from the Trash, or the drive's trash). Everywhere else it is permanent and the confirm says "cannot be undone".
- "Confirm before deleting" in Settings can switch the question off.
- Folders go with everything inside. Deleting a symbolic link removes only the link.
- Runs as a job in Activity. Deleting is not undoable.

#### New folder, upload, duplicate
- **New folder (⇧⌘N, F7 with several panes)** prompts with "New folder" (numbered if taken), refuses names already taken, and selects the new folder.
- **Upload files / folder (⌘U, ⇧⌘U)** use the system picker (several at once). Folders keep their structure. Each upload is a transfer row in Activity (multipart for big files). Names that clash with the destination go through the conflict dialog.
- **Duplicate (⌘D)** copies each item next to itself as "name copy.ext", then "name copy 2.ext" if taken, selects the copy, and offers Undo (which deletes exactly what the duplicate made).
- No "New file".

#### Download and open
- **Download (⇧⌘D)**: one file goes to a Save dialog, or straight to the Downloads folder when "Ask where to save downloads" is off in Settings (a file that already exists is kept and the new one is numbered). Several items, or folders, ask for a download folder; folders are listed first, and files start downloading as they are found (Stop is on the busy line). Google Docs, Sheets and Slides download as their export (Office formats, PDF). Not offered on This computer (it says to Copy instead).
- **Open (↵, ⌘O, double-click)**: a folder opens in the list; a .zip/.tar/.tar.gz opens like a read-only folder; text, code, Markdown, CSV, JSON, Word, Excel and PowerPoint open in Kybl's full-window viewer; anything else downloads a temporary copy and opens in the default app. This computer's own files always open in their own app. Several files open at once in their own apps, up to 10 (folders in the selection are skipped with a note).
- Files from a connection that would run as a program are asked about first ("Run …?").
- A second Open of the same file while it downloads joins the first.
- Changes made in an app opened with Open or Open with are not uploaded. Use Edit for that.

#### Get Info (⌘I)
Opens Quick Look with its info column shown. Shows name, action buttons (copy the file to the clipboard on macOS, Copy or move…, Rename, Delete/Trash), an "Edit…" button for text-like files, the **Share link** section (lifetime 1 hour, 24 hours or 7 days, then Copy; only on connections with share links), and "About this file/folder": size (folders: "Calculate"), modified date, kind, location, and a technical section (exact bytes, content type, Cache-Control, content disposition, content encoding, storage class, object key or path, S3 URI, ETag, metadata, tags) with click-to-copy lines. S3-compatible connections get **Edit properties**: content type, Cache-Control, Content-Disposition, Content-Encoding, storage class (list or a custom name), custom metadata rows and tag rows. With several items selected it shows the count, files and folders, total size (folders count once their size is known; "Add up the folders too"), and Download, Copy or move, Delete buttons.

#### Folder sizes
"Calculate size" (item menu), the "Calculate" link in the Size column of a folder, or Get Info. Lists everything under the folder (one request per 1,000 objects on S3) and keeps the result until something changes the bucket. Runs up to three at once, shows progress, and the status bar shows the size of the folder on screen.

#### Permissions (chmod): SFTP and FTP only
"Permissions…" opens a sheet with Owner, Group and Others rows and Read / Write / Execute boxes, plus an octal field (Enter applies). Shows current owner and group. For folders, "Apply to enclosed items" with Everything / Files only / Folders only.

#### Share links
"Copy share link (<lifetime>)" for one file, and the Share link section of Get Info. Lifetimes: 1 hour, 24 hours, 7 days (default in Settings under Transfers and sharing, "Share link lifetime"). Only on the connections listed in the capability table.

#### Compress and extract
- Formats: extract .zip, .tar, .tar.gz and .tgz. Compress makes .zip only (named after the single item, or "Archive.zip", numbered if taken; items must come from one folder).
- Already-compressed file types (images, video, audio, zips, Office files, PDF) are stored as they are rather than deflated again.
- Extract here puts a folder named after the archive next to it (asks if that name exists). Extract to… lets you pick any destination, including another connection.
- An archive also opens like a read-only folder (Enter or double-click); inside, items can be previewed, copied out, or extracted. The pane header says where it is, and "up" from the top returns to the folder holding the archive. Links, unsafe paths, encrypted entries and decompression bombs are skipped, with a note.
- Where it runs: on SFTP servers, zipping and unzipping happen on the server over SSH when the server has `zip`, `unzip` or `tar`; otherwise (and for every other connection) files are downloaded or read here, packed or unpacked locally, and uploaded. Each job is one row in Activity, stoppable, and the folder reloads when it ends.

#### Compare
- **Compare files**: two text files (here, or one in each pane) open in a side-by-side or inline diff, older file on the left, with changed words marked, line numbers, unchanged stretches folded. Toolbar: Layout, Wrap, Ignore whitespace, Previous / Next change. Keys: F7 or n for next, ⇧F7 or p for previous, Esc closes.
- **Compare folders** (two panes; View menu, palette, or the pane "…" menu): lists items only in each folder, files newer on one side, files that differ with no way to tell which is newer, and how many match. Each differing text file has a Compare button. It selects what the other side is missing so F5 copies it. Files are compared by size, checksum (S3 to S3 plain ETags only) and date. Folders are matched by name only; their contents are not compared.

#### Edit in another app with sync-back
- **Edit (⌘E)** and **Edit with ▸** on a remote file: asks "When you save this file:" (Upload changes automatically, or Upload only if the file on the server hasn't changed since you opened it, Recommended; the last answer is preselected, there is no "don't ask again"). Then it downloads a private copy, opens it in the chosen app, and uploads on every save. A toast confirms. Programs and scripts ask before opening, except when a known text editor is the opener.
- **Edit in Kybl**: the same rule question, then Kybl's own sheet editor, saving under that rule. Files up to 5 MB.
- **Conflict** (the server's copy changed or was deleted): a dialog shows both versions with Compare and offers "Overwrite the server's copy" (or "Upload mine again" if deleted), "Keep both" (uploads yours as "name (edited).ext"), "Discard my changes and reload the server's", and "Stop editing and discard my changes".
- The Activity panel header has an "Editing (n)" chip listing the files being edited: state (Waiting for a save, Uploading, Uploaded <time>, Changed on the server, Upload failed), Open it again, Show the copy on this computer, and Stop editing (asks first if there are unsent changes, then deletes the local copy).
- This computer's files are not copied: they open and save in place.
- Google Docs, Sheets and Slides cannot be edited here ("edited in Google Drive").

#### Sync, keep, mirror and copy-to-connection
- **Sync this folder…** opens the folder-sync dialog prefilled with this place. Directions: Upload only, Download only, Two-way (edited on both sides: you keep both).
- **Keep on this device**: a two-way synced copy in a Kybl folder in your home folder (~/Kybl/…), shown in Finder when ready; the first time it explains that deleting there deletes online too. The ticked item stops it (the copy stays on disk).
- **Mirror to…**: source and destination (swappable), "Upload new and changed files", "Also delete what's gone from the source", "Changed means" (another size or newer / another size / different MD5 checksum where both sides have one), "Leave out" rules (one per line, like .gitignore), and a dry-run preview grouped by folder before it runs as one job. Mirrors can be saved by name and re-run from the folder menu or the palette ("Run mirror “name”").
- **Copy to another connection…**, **Copy everything to…** and the destination picker's "other connection" button start a background job. Options: "If a file is already there" (Skip if it's the same, Always skip, Replace if older, Always replace, Keep both), "Check contents after copying", "Keep modification dates", and "Leave out" patterns. Progress and Stop are in Activity.

#### Undo
⌘Z or the toast's Undo undoes the latest move, copy, duplicate or rename (up to 20 steps; batch renames undo as one). Undoing a copy deletes exactly the objects it made (and asks first when that is many). Nothing is offered when a move or copy replaced or merged something. Delete cannot be undone.

---

### Conflicts (name clashes)
Where: conflict dialog, used by upload, move, copy, paste, extract, rename and new folder.

Every action that writes names first checks the destination (in batches, so a 50,000-file upload costs a few calls). For each clash a dialog asks:
- **Replace** (called **Merge** for folders: everything goes into the existing folder and same-named files are replaced).
- **Skip**.
- **Keep both**: the new item gets a number, "name (1).ext".
- A checkbox "Do this for the other N" applies the answer to the remaining clashes of the same kind (files or folders).
- Closing the dialog cancels the whole action. If checking for existing items fails, it asks whether to continue anyway.
- Rename never overwrites a folder; for a file it asks "Replace “name”?". Batch rename never overwrites at all.
- A background job copy uses its own five options instead (listed above).

---

### Drag and drop
Where: pointer-driven drag of items, plus drops from the operating system.

#### Dragging items from a list or grid
- A plain mouse drag (starts after about 5 pixels). A drop moves; **hold ⌥ (Alt) to copy** (at the press or any time during the drag). Places that can only take copies always copy. ⌘-press on an item adds it to the selection and drags the lot. Pressing an item of a multi-selection keeps the selection so it can be dragged.
- **Drop targets**: a folder row or tile, a breadcrumb segment (including the folded "…" and the enclosing-folder row), the empty space of another pane, a bucket in the sidebar (items land at its top level, also on another connection), a workspace tab, a terminal pane.
- **Within a pane**: onto a folder moves into it. Hover on a folder for a moment (about 0.9 s) and it opens (spring-loaded).
- **Between panes**: dropping on another pane's folder, breadcrumb or empty space sends the items to that place. Between two clouds that the server can't copy between, and between connections, the same background-job route as F5/F6 applies, with its quick confirm. Between This computer and a cloud it is a copy (upload or download); the originals stay.
- **To a sidebar bucket**: same connection moves or copies; another connection copies via job.
- **To a workspace tab**: letting go drops into the folder of that workspace's active pane, with a toast and Show; resting on the tab opens that workspace so you can drop into one of its panes; resting on "+" opens a new workspace at the root the items came from.
- **To a terminal pane**: types the items' quoted paths into the shell (local paths, or paths on the server for SFTP).
- **Out to the OS** (Finder, Mail, a chat, an editor): when the pointer leaves the window the drag becomes the system's. Items on This computer and synced folders go as real files. Small files from other connections (up to 64 MB each, 20 files and 256 MB in all) are fetched ahead, from the file cache when possible, and the hand-over waits up to 1.5 s for them. On macOS everything else goes as a file promise that downloads where the receiver asks. Windows and Linux leave such items behind.
- The drag ghost shows "Move to X · ⌥ to copy" or "Copy to X".
- Pane headers themselves can be dragged (by their empty part) to dock a pane elsewhere in the layout.

#### Dropping from the OS
Files and folders dropped from Finder or Explorer upload into the pane under the pointer (else the active pane), through the conflict dialog. A drop overlay says "Drop to upload to <path>". Dropped on a terminal they type their paths instead. Dropped on a workspace tab they upload into that workspace's active pane, and resting on the tab opens it. Not in archives. Refused with a toast when no folder is open or a dialog is up.

---

### Viewers and previews
Where: Quick Look, Get Info, and the full-window viewer.

#### Quick Look (Space; F3 with several panes)
A large preview over the list, with the info column beside it (the same as Get Info; toggled with the (i) button or ⌘I and remembered; it opens by itself in windows at least 900 px wide).
- Images the web view can draw (jpg, jpeg, png, gif, webp, avif, svg, bmp, ico, and HEIC on Apple systems). For other image types (tif, tiff, RAW and the like) it shows the thumbnail. A blurry placeholder shows while loading.
- Video (mp4, mov, m4v, webm, mkv, avi, and so on) and audio (mp3, m4a, wav, flac, ogg, aac, opus) with controls and autoplay. They stream (presigned link, or through the app) without downloading first.
- PDF (up to 60 MB), drawn in the app.
- Documents in the document viewer: text, code, YAML, JSON, Markdown, CSV and TSV, Word .docx, Excel .xlsx / .xlsm / .xls / .ods, PowerPoint .pptx. Google Docs, Sheets and Slides show as their Office export.
- Plain text files that have no viewer (up to 50 MB) show as text.
- A folder shows its art, name and size (with "Calculate").
- Several items selected: a sheet of up to 240 tiles (thumbnail, name, size); click one to show it alone.
- Anything else: its icon, name, kind, size, date and an "Open in its app" button.
- A header with Previous / Next, the file name, a Copy-file button (macOS: puts the file itself on the clipboard to paste into a chat, mail or folder), Edit (for text-like files), Open, Info and Close buttons.
- Content-search results open to the matching line.
- On the phone the same previews appear on the details screen.

#### In-app viewers (limits)
| Viewer | Files | Largest it opens | Edits? |
|---|---|---|---|
| Text and code | txt, log, yml, toml, xml, html, css, scss, js, ts, tsx, py, rs, go, sh, sql, ini, env, conf, java, kt, swift, c, cpp, cs, php, rb, lua, dart, vue, svelte, Dockerfile, Makefile, dotfiles such as .bashrc and .gitignore, srt, vtt, plist, tf, graphql, diff, patch, and more; also anything with a text/* content type | 20 MB | Yes up to 5 MB |
| JSON | json, jsonl, ndjson, geojson, webmanifest | 20 MB | Yes up to 5 MB, with a validity check and Format / Tidy lines |
| Markdown | md, markdown, mdx | 10 MB | Yes up to 5 MB, with Edit / Split / Preview layouts |
| CSV | csv, tsv | 50 MB | Yes up to 5 MB, as a table or as text |
| Word | docx | 30 MB | No, read-only, laid out like pages |
| Excel | xlsx, xlsm, xls, ods | 30 MB | No, read-only, every sheet as a tab, formulas show cached results |
| PowerPoint | pptx | 100 MB | No, read-only outline: cover picture, each slide's title, text and first picture |
| Image | jpg, png, gif, webp, avif, svg, bmp, ico | 40 MB | No, with zoom |

Bigger files say how big they are and offer "Open in another app". Archives (.zip, .tar, .tar.gz) are not previewed; they open like a folder.

Viewer features: text and code have syntax colours, Find and replace (⌘F), Wrap lines. Markdown renders in a sandbox (cleaned, no scripts); big files draw the preview on request ("Render preview" / "Update preview"). CSV has Show as Table / Text, "First row is the header", and a worker-parsed table that renders rows as they scroll. Images have fit to window, actual size, zoom buttons, ⌘+ ⌘− ⌘0, ⌘/Ctrl scroll or pinch zoom, and double-click to switch between fit and actual size.

#### Full-window viewer and editor
Opened by Open on a supported file, "Edit in Kybl" (as a sheet), or Quick Look. Shows an unsaved-changes dot, a Save button, "Open in another app", and Close. Keys: ⌘S saves, ⇧⌘S saves a copy, ⌘W or Esc closes (asking about unsaved changes). Saving checks whether the file changed on the server; a conflict offers Reload (or "Discard mine and reload"), Overwrite, and Save as copy. While it is open, no other shortcut runs. Reload and the location bar are kept from the web view.

#### Thumbnails and photo modes
- Thumbnails show in grid view for jpg, jpeg, png, gif, webp, bmp, tif, tiff (full decode up to 40 MB; jpg and tif use the small embedded thumbnail at any size), and HEIC on Apple systems (up to 25 MB). Videos and other files show a file icon. The list view shows icons, not thumbnails.
- "Photos" mode (Settings → Browsing, and per connection in its right-click menu): **Off** (file icons only), **Placeholders** (a blurry preview where one is known, nothing is downloaded), **Thumbnails** (the blurry preview at once, then the thumbnail; default). Connections can share placeholders through a hidden file in each photo folder (not on This computer).
- Phones on mobile data with "Wi-Fi only" pause new thumbnails.

---

### Selection, sorting, views, search, navigation

#### Selection
- Click selects one. ⌘/Ctrl-click toggles. Shift-click selects a range from the anchor. Pressing an item of a multi-selection keeps it (so it can be dragged); a click without drag then narrows to that item.
- Rubber-band (marquee) on empty space: drag to select; Shift adds, ⌘ toggles; the list scrolls itself near its edges. Click empty space clears.
- Arrow keys move the cursor (Shift extends). In grid view Left/Right move one tile, Up/Down one row. Home / End jump to the first / last. PageUp / PageDown move a screen.
- Type to select: letters jump to the next name starting with what you typed (typing the same letter again cycles).
- ⌘A selects all. Esc clears. The status bar shows the selection count and size, with an × to clear. Selection drops items that leave the view (filtered out, deleted, moved).
- With several selected, the pane's right-click menu acts on all of them.

#### Views and layout
- **List** (Name plus Size, Modified, Kind, Storage class, ETag columns; sizing and choice remembered; a ".." row at the top goes up; double-click opens) and **Grid** (tiles with thumbnails, size from 96 to 320 px, Bigger/Smaller icons ⌘+ ⌘−, 24 px steps). Compact layout (tighter rows and smaller tiles). View, sort and compact are kept per pane.
- Folders first (Settings, on by default). Dates friendly or full. Sizes decimal (MB) or binary (MiB). Columns also set in Settings → Browsing.
- Large S3 folders list in pages; the status bar says when only the first N items are loaded.
- Git awareness on This computer: a branch chip next to the path and per-item marks (M modified, A added, D deleted, R renamed, C conflicted, U untracked, ignored; a dot on folders with changes inside).

#### Sorting
By Name, Date modified, Size or Kind, ascending or descending: click a column header, or the View options menu, or the palette ("Sort by…", "Reverse Sort Order"). Name sort starts ascending; Size, Modified and Kind sort descending when chosen from the palette. Sorting by size or date loads the whole folder first (up to a limit).

#### Search and filter (⌘F)
- Typing in the toolbar search field filters the current folder by name (substring, instantly). Enter searches all subfolders by name. Matches stream in while it scans; "Stop searching" stops it; the status shows counts and whether the scan was cut short.
- **Contents mode** (This computer and SFTP only): search inside files; each file shows its first matching line, and Quick Look opens at the line. Options: Names / Contents, case sensitive, regular expression. The palette also has "Search Inside Files". Uses ripgrep, grep, or a built-in scan.
- In results: "Show in folder" jumps to the item's folder with it selected; most write actions still work. "Compress" and "Calculate" are limited. Esc or Clear search returns to the folder.

#### Hidden files
Dot-files are hidden on This computer by default. "Show hidden files" (⇧⌘. , View menu, View options, empty-space menu, palette "Show/Hide Hidden Files") toggles it for that pane only. Other connections always show everything (Kybl's own `.kybl` placeholder folder is never shown).

#### Path bar, breadcrumbs, Go to folder
- The path is a row of clickable crumbs (bucket or root, then folders). Long paths fold the middle into "…" starting from the top. The enclosing-folder button (⌘↑, Backspace) goes up; at the top of an archive it goes to the folder holding it; at the top of This computer's Documents it goes on up to Home. The root name is clickable to go to the top. Crumbs are drop targets.
- Click the current folder's name (or press ⇧⌘G / ⌘L) and the bar turns into a text field. Type a path and press Enter (Esc cancels). Accepts a path in this root, `bucket/path`, or `s3://bucket/path` on S3; a full path on This computer; a file's path opens its folder with the file selected. Without the bar on screen it opens a "Go to folder" dialog.
- The star in the toolbar adds or removes the folder from the sidebar Favorites. Favorites follow renames and moves of their folder and go when it is deleted.

#### History
Per pane, last 100 places. Back and Forward: ⌘[ and ⌘], the mouse side buttons (button 4 and 5), the Go menu, the palette. There is no toolbar button. Not cleared by switching connections; entries for a removed connection are dropped.

#### Other pane features
Up to six panes (split right, down, left, up), each with its own connection, view, sort and selection. Swap, same folder in the other pane, compare folders, synced browsing (follow into subfolders; turn off from the toast or the link on the divider), F5/F6 copy and move, a terminal pane (⌃`), workspaces (tabs of saved layouts, recipes) with ⌘T, ⌃Tab and ⌥⌘1–9.

#### Command palette (⌘K, Ctrl+K elsewhere)
One field for connections, places, commands and the folder's files, ranked together. Prefixes: `>` commands only, `@` connections only, `/` or `~` types a path (Tab completes a folder). ↵ opens in the active pane; ⌘↵ opens in a new pane to the right (for a file it shows it in the list). Keys: ↑ ↓ (or Ctrl+N / Ctrl+P), PageUp / PageDown move eight, Tab completes, Esc or ⌘W closes. Sections: Recent, Connections, Places, Commands, Files, Go to.
Commands it holds: every menu-bar command (File: New Folder, Upload Files / Folder, Download, Open, Quick Look, Get Info, Rename, Duplicate, Copy, Cut, Paste, Delete, Select All, Undo; Connections: New Connection, Import Connections, Find Connection in Sidebar; View: Refresh, Search This Folder, Show/Hide Hidden Files, Show/Hide Sidebar, View as List, View as Icons, Sort by Name / Date Modified / Size / Kind, Reverse Sort Order, Bigger / Smaller Icons, Compact/Roomy Layout, Show Activity; Go: Back, Forward, Enclosing Folder, Go to Folder; Panes: Split Right / Down, Close Pane, Close Other Panes, Make Panes the Same Size, Switch Pane, Swap Panes, Same Folder in Other Pane, Compare Folders, Copy / Move to Other Pane, Synchronize Browsing, Focus Pane Left / Right / Up / Down; Workspaces: New, Switch to, Next, Previous, Rename, Settings, Move left/right, Close, Open / Reset / Save Workspace Recipe; Settings and each settings page; Theme System / Light / Dark). Plus Compress to .zip, Extract here and Compare files (for the selection), Search Inside Files, Open Terminal Here and Toggle Terminal, "Run mirror “name”", start/stop each saved tunnel, and "Run “name”" for each enabled custom action (greyed with the reason when it can't run on the selection). Commands that can't run say why in grey.

---


#### Folder info panel (computers)

A compact panel inside each pane, opened and closed by the icon at the right end of that pane's bottom status row. It gives context for the folder on screen; it is not a file preview.

- **Remembered per pane.** The open or closed state is part of the pane's view choices, so workspaces keep it. The panel's code loads the first time one is opened.
- **Always:** the connection (kind, server or bucket, user), the current path with a copy button, and the folder's item count and size (and the whole-folder size once worked out).
- **By connection:**
  - S3: bucket, region and endpoint.
  - SFTP, FTP and WebDAV: server, protocol (TLS on or off, FTPS) and user.
  - Cloud drives: the account and, when the drive says, the space used.
  - Azure and Google Cloud Storage: account or project and container or bucket.
- **Git, for a folder of this computer inside a work tree:**
  - the branch (or the commit when detached) and how far it is ahead of and behind its upstream;
  - changed, staged and untracked counts for the folder, with the first 8 changed files (a click opens the file or folder);
  - the last commit: short hash, subject and age.
- **How git is run:** the backend runs the user's own `git` with an argument list in the repository's folder, never a shell, with a time limit and the repository's own programs switched off (`git status --porcelain=v2 --branch`, `git log -1`). Without git, or outside a work tree, the git section is simply not shown.
- **When it refreshes:** when the folder changes and when the window comes back to the front. There is no polling.
### Custom actions
Where: Settings → Actions; the item menu's "Actions ▸"; the palette; their own shortcuts.

Shell commands you define and run on selected files and folders. Kept per device. Each action has:
- **Name** and **Command**: a shell command line with placeholders, each value shell-quoted by the backend:
  - `{path}` each item (runs once per item)
  - `{paths}` all items, space separated (runs once)
  - `{name}` the item's name
  - `{stem}` the name without extension
  - `{ext}` the extension
  - `{dir}` the folder
  Placeholder chips insert them, a preview shows the result, and a template check refuses placeholders in unsafe spots (inside quotes, after a backslash, in a comment, and so on).
- **Runs**: on this computer (a POSIX `sh`; on Windows the one from Git for Windows), or "On the server" (SFTP connections only, over SSH).
- **Applies to**: Files, Folders, or Both, with an optional extension filter ("jpg, png", "tar.gz" matches).
- **Output**: Show output (a sheet that streams stdout/stderr, with Stop) or Run silently, notify when done.
- **Refresh the folder afterwards**.
- **Shortcut**: ⌘/Ctrl plus a key, or an F-key. Keys the app or menu bar already uses, and other actions' shortcuts, are refused with the reason.
- Enabled switch. Export and import as JSON; imported actions arrive switched off, with no shortcut, and showing output, so each is reviewed and enabled by hand.
- Files from servers are downloaded to a temporary folder first (`{path}` is that copy; changes stay there). Folders on a server can't run on this computer. More than 20 items asks to confirm. Each run is one Activity row. A server action on a non-SFTP connection doesn't appear.
- Starting examples (all off until enabled): Optimize images (macOS, sips), Compute SHA-256, Disk usage on server, Make executable (server, refreshes).

---

### Keyboard shortcuts
Where: global key handler, list navigation, Quick Look, viewers, palette.

On macOS the menu bar owns the keys marked "menu"; they behave the same as the table says. Shortcuts do nothing while a dialog, menu or preview is open (they never act behind it). Typing in a text field leaves most keys alone. While the full-window editor is open only its own keys work.

#### In the file list
| Keys | Action |
|---|---|
| ↑ ↓ ← → | Move the cursor (Left/Right only in grid view); Shift extends the selection |
| Home / End | First / last item |
| PageUp / PageDown | One screen up / down |
| Letters | Jump to a name starting with them |
| ⌘A | Select all |
| Esc | Clear selection |
| Enter (↵) | Open the selection (nothing if none selected) |
| ⌘O or ⌘↓ | Open |
| ⌘↑ or Backspace | Enclosing folder (up one level) |
| Space | Quick Look the selection |
| ⌘I | Get Info (menu) |
| ⌘E | Edit the selected file (menu) |
| F2 | Rename (batch rename for several) |
| Delete, ⌘⌫ | Delete or move to Trash |
| ⌘C / ⌘X / ⌘V | Copy / Cut / Paste items (left alone when text is selected) |
| ⌘D | Duplicate (menu) |
| ⌘Z | Undo the last move, copy, duplicate or rename |
| ⇧⌘N | New folder (menu) |
| ⌘U / ⇧⌘U | Upload files / folder (menu) |
| ⇧⌘D | Download (menu) |
| ⌘R | Refresh |
| ⌘F | Search or filter this folder |
| ⌥⌘F | Find a connection in the sidebar (menu) |
| ⇧⌘G or ⌘L | Go to folder |
| ⌘[ / ⌘] | Back / Forward (menu); also the mouse side buttons |
| ⇧⌘. | Show or hide hidden files (menu) |
| ⌘+ / ⌘− | Bigger / smaller grid tiles (menu) |
| ⌥⌘S | Show or hide the sidebar (menu) |
| ⌘, | Settings (menu) |
| ⌘K | Command palette |
| ⇧F10 or the menu key | Open the context menu for the selection |
| Ctrl + click (Mac) | Right-click |
| ⌥ while dragging | Copy instead of move |

#### Panes and workspaces
| Keys | Action |
|---|---|
| ⌘\ / ⇧⌘\ | Split the pane right / down (menu) |
| ⌘W | Close the active pane (with one pane it closes the window) |
| ⌥⌘ + arrow | Focus the pane in that direction |
| ⇧⌘S | Swap panes (menu) |
| Tab | Switch pane (when several panes are open and the list has focus) |
| F3 / F5 / F6 / F7 / F8 | With several panes: Quick Look / copy to other pane / move to other pane / new folder / delete |
| ⌃` | Open or toggle a terminal below the active pane |
| ⌘T | New workspace |
| ⌃Tab / ⌃⇧Tab, or ⇧⌘] / ⇧⌘[ | Next / previous workspace |
| ⌥⌘1 … 9 | Go to workspace 1 to 9 |
| ⌥⇧⌘[ / ⌥⇧⌘] | Move the workspace left / right |
| F2 on a workspace tab, double-click | Rename the workspace |

#### Quick Look
| Keys | Action |
|---|---|
| Space, Esc, ⌘W, ⌘. | Close |
| ← ↑ / → ↓ | Previous / next item (not with several shown as a sheet) |
| Enter or ⌘O | Open in its app (one item) |
| ⌘I | Show or hide the info column |
| ⌘C | Copy the file to the clipboard (macOS) |
| Home / End / PageUp / PageDown and letters | Held back so the selection stays on this file |

#### Full-window viewer, editor and image zoom
| Keys | Action |
|---|---|
| ⌘S | Save |
| ⇧⌘S | Save a copy |
| ⌘F | Find and replace (text, code, CSV text mode) |
| Esc, ⌘W | Close (asks about unsaved changes) |
| ⌘+ ⌘− ⌘0 | Image zoom in, out, fit |
| F7 / ⇧F7 (or n / p) | Next / previous change in Compare files |

#### Command palette
↑ ↓ (or Ctrl+N / Ctrl+P), PageUp / PageDown, Enter (open), ⌘Enter (open in a new pane or reveal), Tab (complete a path), Esc or ⌘W (close), and prefixes `>`, `@`, `/`, `~`.

#### Settings shortcuts list
Settings → Keyboard shortcuts shows the same list for reference (including "Select an area: drag on empty space", "Extend selection: Shift-click", "Add to selection: ⌘-click", and "Rename a workspace: double-click its tab"). Its "Two panes: copy instead of moving while dragging across: drop copies, ⌘ moves" line does not match the code: the drag code copies with ⌥ held, and ⌘ is only used to add to the selection.

#### Custom action shortcuts
Each custom action can have its own ⌘ (or Ctrl) plus key, or F-key combo. It runs the action on the selection through the same routing as the built-in keys (so nothing runs behind a dialog).

---

### On the phone
The phone app has its own screens (not covered here) but shares the viewers, Quick Look-style details screen, thumbnails, rename, copy and move jobs, and the previews above.

## Connections, transfers and jobs

### Overview

---

### Connection types

The "New connection" picker offers these, in three groups:

| Group | Entries |
|---|---|
| Object storage | Kybl Storage, S3-compatible, Azure Blob Storage, Google Cloud Storage |
| Cloud drives | Google Drive, OneDrive, Dropbox |
| Servers | WebDAV, SFTP, FTP / FTPS |

Besides these:

- **This device** (this computer or phone) is a built-in connection with a reserved id. It shows up as "This Mac", "This PC" or "On this phone" and is not something you add.
- **Box** exists as a name in the code (badge, kind list) but is **not usable**. Opening one says "Box connections aren't supported by this version of Kybl yet." It is not in the picker.
- A connection saved by a newer Kybl is shown as "made with a newer version of Kybl". It can only be deleted, not edited or opened.

Every form also has these shared extras:

- **Name** (optional; Kybl makes one up, such as "alice@files.example.com").
- **Group** (computers only): a sidebar folder; use `/` for nested groups such as `Clients/Acme`.
- **Photos in lists**: per connection, either "As in Settings" or one of the photo display modes.
- **Share placeholders with other devices** (a checkbox, shown when photos are on).
- **Test connection** and **Save** buttons, and **Delete** when editing.

#### Comparison table (what each connection can do)

| | S3-compatible / Kybl | Azure Blob | Google Cloud Storage | Google Drive | OneDrive | Dropbox | WebDAV | SFTP | FTP / FTPS | This device |
|---|---|---|---|---|---|---|---|---|---|---|
| How you sign in | access key + secret | account key or SAS | service-account JSON | browser sign-in | browser sign-in | browser sign-in | user + password | password, key, or SSH agent | user + password, or anonymous | none |
| Top level | buckets (pick one) | one container | one bucket | My Drive, each shared drive, "Shared with me" (read-only) | OneDrive, "Shared with me" (read-only) | one root | one root | one root | one root | each folder/drive |
| Real folders | prefixes (virtual) | prefixes (virtual) | prefixes (virtual) | yes | yes | yes | yes | yes | yes | yes |
| Rename | copy + delete | copy + delete | copy + delete | native | native | native | native (MOVE) | native | native | native |
| Copy on the server | yes (even across buckets) | yes (same container) | yes (same bucket) | yes | yes (same drive) | yes (same account) | yes (COPY) | no (goes through Kybl) | no (goes through Kybl) | yes |
| Share link | yes, expiring (presigned) | no | no | no (deliberately) | yes (temporary under an hour, otherwise view-only link with expiry) | yes (temporary up to 4 h, otherwise public link with expiry on paid plans) | no | no | no | no |
| Trash on delete | no | no | no | Drive trash | recycle bin | Dropbox deleted files | no | no | no | system Trash/Recycle Bin |
| Big-file multipart | yes (up to 5 TB) | no | no | yes (up to 5 TB) | yes (up to 250 GB) | yes (up to 350 GB) | chunked on Nextcloud/ownCloud above 64 MB | no | no | n/a |
| Ranged reads (resume, streaming) | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| Content hash Kybl can use | MD5 (not on Kybl Storage, not with encryption) | MD5 | MD5 | MD5 | QuickXOR | Dropbox hash | none | SHA-256/MD5 run on the server (if the account may run commands) | none | none |
| Thumbnails | made locally | local | local | local + from the service | local + from the service | local + from the service | local | local | local | local |
| Tags, metadata, storage class | yes | no | no | no | no | no | no | no | no | no |
| Unix permissions (chmod) | no | no | no | no | no | no | no | yes | yes (needs `SITE CHMOD`) | no |
| Symbolic links | no | no | no | no | no | no | no | yes | seen in LIST only | shown as files, never descended into |
| Create a new root from the app | Kybl Storage only | no | no | no | no | no | no | no | no | no |
| Server terminal | no | no | no | no | no | no | no | yes (desktop) | no | local shell (Mac/Linux) |
| SSH tunnels | no | no | no | no | no | no | no | yes (desktop) | no | no |
| Mount as a drive, sync, mirror, copy jobs | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes |

Phone backup targets any of these connections (see 4.6).

---

#### 1.1 Kybl Storage (Kybl Cloud)

S3 storage run by Kybl for people with no bucket of their own.

- **Sign-in, no keys to type.** "Connect Kybl Storage" opens the account site (app.kybl.app) in the browser. You approve the computer or phone and the app receives its own access key named "Kybl on <device>". You can revoke it on the site's Access keys page.
- **Two ways in:**
  - Browser flow with PKCE. On computers a local loopback page catches the redirect. On phones it opens a Custom Tab (Android) or a sign-in sheet (iOS) and returns through `kybl://connect`.
  - Device code flow, for when the browser is on another device: the app shows a short code and a QR code of the approval link, with a copy button, and waits (up to about 15 minutes) for approval.
- **Advanced** lets you point at a different account site (kept on this device only).
- The key goes straight into the secret vault.
- If the key is revoked or the account deleted, the app says "This computer's access key was revoked on the web, or the account was deleted. Connect again to get a new key."
- **Capabilities:**
  - It is an S3 connection, so it has everything S3 has.
  - It can **create buckets** from the app ("New bucket"). This is the only connection that can.
  - No conditional writes.
  - Checksums fall back to size only, because the files are encrypted at rest.
- Encryption at rest is done by the storage service, not by the app. The README says files are encrypted with a per-bucket key (SSE-C, AES-256), that this is not end-to-end, that the free plan is 10 GB, and that storage is in Germany. The app code holds no encryption key of its own and has no master-key feature.

#### 1.2 S3-compatible

**Provider presets** (tiles at the top of the form; picking one fills region, endpoint and path-style):

| Preset | Endpoint it fills in | Default region | Notes |
|---|---|---|---|
| Hetzner Object Storage | `https://<region>.your-objectstorage.com` | nbg1; also fsn1 and hel1 in a drop-down | Hint: Hetzner keys cannot list all buckets, so type your bucket name |
| Amazon S3 | `https://s3.<region>.amazonaws.com` (endpoint may be left empty) | eu-central-1 | |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | auto | You must replace `<account-id>` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | eu-central-003 | |
| Wasabi | `https://s3.<region>.wasabisys.com` | eu-central-1 | |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` | fra1 | |
| Other S3-compatible (MinIO, Ceph, …) | you type it | us-east-1 | Path-style is on by default |

Kybl Storage has its own flow and badge (1.1). Changing the region follows the preset's endpoint, but a hand-typed endpoint is kept. Switching presets only changes values the old preset filled in.

**Form fields:**

- Provider tile.
- Name (optional).
- Region (a drop-down for Hetzner, free text elsewhere).
- Bucket (optional; if you set it, the connection opens straight into it. Needed for keys that cannot list buckets).
- Endpoint (must start with http:// or https://; required except for Amazon S3).
- Access key ID.
- Secret access key. When editing, leaving it empty keeps the saved one, but only while the access key ID is unchanged.
- "Use path-style addressing" checkbox (needed by MinIO and many self-hosted servers).
- Whitespace is trimmed from secrets, because a pasted space or newline would break the signature.

**Special capabilities and limits:**

- Buckets are the roots. If listing buckets is denied but a bucket name is set, that bucket is shown. If no bucket is set and listing is denied, the pane says "Couldn't list …" or, for a plain access-denied, "Open bucket by name".
- Server-side copy works across buckets. Presigned share links expire. Multipart upload up to 5 TB. Tags, metadata and storage class are editable. Background uploads work on iOS.
- Provider quirks:
  - Conditional writes (if-match) are trusted only for AWS, R2 and MinIO.
  - Hetzner and unknown "custom" servers are assumed to need a comparison instead.
  - The ETag counts as an MD5 everywhere except Kybl Storage.
  - Bulk delete falls back to one-by-one when the server refuses it.
- Hetzner behaviour (from the project notes, not the app): SSE-C works, but copy, part-number reads, conditional PUT and idle connections misbehave. The app has workarounds.

#### 1.3 Azure Blob Storage

- **Fields:** Name, Storage account, Container (required; one container per connection), Account key or SAS token (a SAS starts with `?` or contains `sig=`), optional Endpoint (only for Azurite or national clouds; default `https://<account>.blob.core.windows.net`).
- **Capabilities:** prefix folders, rename by copy and delete, server copy, range reads, if-match conditional writes, MD5 hashes. No share links, no multipart, no trash.
- Editing: a saved key stays only while the account and endpoint are the same. Change either and the key must be entered again.

#### 1.4 Google Cloud Storage

- **Fields:** Name, Bucket (required), Service account key (paste the JSON, or "Choose file…"; files over 256 KB are refused; the JSON must contain a `private_key`), optional Endpoint (emulators and compatible services).
- **Capabilities:** same as Azure, with conditional writes done by comparing.
- Editing: a changed endpoint needs the key again.

#### 1.5 Google Drive, OneDrive, Dropbox

- **Sign-in:** "Sign in with Google / Microsoft / Dropbox" opens the provider's page in the browser. You approve and the connection is saved automatically. While waiting, there is a Cancel button.
- **No keys to type.** If this build has its own app registered for the provider, that is used. Otherwise the form opens "Use your own OAuth app" and asks for:
  - Client ID.
  - Client secret (Google only, because desktop clients need one).
  - Tenant (OneDrive only; empty means any account).
  - A one-line hint about where to make one (Google "Desktop app", Microsoft Entra public client with redirects `http://localhost/callback` and `kybl://oauth/onedrive`, Dropbox scoped app with full access and the redirects on ports 53682 and 53683).
- You can use your own app even when a built-in one exists. Emptying it while editing goes back to the built-in app.
- **Same account, same connection.** Signing in to an account that already has a connection updates that one. Signing in to a different account when reconnecting is refused with a message naming the right account.
- **Reconnect:** when access ends (revoked, expired, password changed) the app raises a "needs sign-in" marker. The sidebar and the phone home screen show "Sign in again" or "Connect again". The reconnect keeps the id, so open tabs, synced folders and jobs stay attached.
- **Tokens** live in the vault, never in a file. Deleting the connection removes them.
- **Google Drive specifics:**
  - Roots: My Drive, each shared drive, and "Shared with me" (read-only at its top).
  - Delete goes to Drive's trash.
  - Docs, Sheets and Slides have no bytes: they list at size 0 and download as an Office format or PDF. They cannot be overwritten.
  - On a mounted drive they appear as `.gdoc.html`-style shortcut pages that open the browser.
  - Duplicate names are shown as "report.pdf", "report (2).pdf" and so on.
  - No share links, because Drive links are permanent public permissions.
- **OneDrive specifics:** roots are OneDrive and a read-only "Shared with me". Delete goes to the recycle bin. Share links are temporary or view-only with expiry. QuickXOR hashes.
- **Dropbox specifics:** one root. Delete is restorable on dropbox.com. Temporary links up to 4 hours, longer ones become public links with expiry (paid plans). Uses Dropbox's own content hash. Limit 350 GB per file.
- All three: thumbnails come from the service as well as local, they can detect changes, and uploads are chunked.

#### 1.6 WebDAV

- **Fields:**
  - Name.
  - Server address (required; `https://`, `http://`, `dav://`, `davs://`, `webdav://` and `webdavs://` are accepted. A bare address is treated as https).
  - User name (optional).
  - Password (optional).
  - Start in folder.
- **Hints in the form:**
  - Nextcloud and ownCloud: the server address alone is enough. Kybl also tries `/remote.php/dav/files/<user>/` and `/nextcloud/...`.
  - Synology: include the WebDAV port, for example `https://nas.local:5006`.
  - Two-step sign-in: use an app password.
- **Warnings:** an `http://` address shows "your password and files travel unencrypted".
- **Certificates:** a server's own (self-signed or otherwise untrusted) certificate can be trusted, see 2.4.
- **Capabilities:** real folders, native rename, server copy, range reads, if-match writes (also double-checked by reading first). Uploads stream from disk. Nextcloud and ownCloud uploads above 64 MB go in 16 MB chunks, each retried. Other uploads go to a temporary name and are moved over the target, so a cancelled upload leaves nothing. Quota is shown where the server reports it.

#### 1.7 SFTP

- **Fields:**
  - Name.
  - Server. You may paste `sftp://me@host:2222` and it fills Server, Port and User name.
  - Port (empty means 22).
  - User name (required).
  - Sign in with: Password, Key, or SSH agent (computers only).
  - Password (when using a password).
  - Private key (when using a key; paste or "Choose file…", files over 64 KB refused; must start with `-----BEGIN` or be a PuTTY key) and Key passphrase (optional).
  - Start in folder (empty means your home folder).
  - SSH tunnels section (computers only; see 4.9).
- **Keys:** OpenSSH, PEM (PKCS#1/PKCS#8) and PuTTY `.ppk`; Ed25519, ECDSA and RSA. Keys and passphrases are stored in the vault under their own entry. A passphrase can be changed without re-pasting the key. Editing shows "Unchanged" for a saved key.
- **Password:** also answers keyboard-interactive prompts.
- **SSH agent:** asks the agent already running (ssh-agent on macOS/Linux; the OpenSSH agent pipe or Pageant on Windows; 1Password's agent works too). Nothing is stored. A profile saved with agent on a computer falls back to Key on a phone.
- **Host key trust (trust on first use):**
  - First connection shows "Trust this server?" with the SHA256 fingerprint. Test or Save asks before continuing.
  - If the key later changes, Kybl stops hard. It is treated as possible interception, and the safe answer is the default. You can look at the new key and replace the trusted fingerprint with a deliberate click.
  - The trusted fingerprint is shown in the form with a **Forget** button. Changing server or port clears it.
  - "Save without connecting" is offered if Save's first connection failed.
- **Capabilities:** real folders; native (posix) rename; range reads; conditional writes by comparing; no server copy; Unix permissions (chmod, with recursive options); symbolic links (shown, followed, traced, created). One SSH connection per server with keepalives, reopened when dropped. Uploads go to a temporary name then rename. Quota via statvfs on OpenSSH servers. Checksums run `sha256sum`, `shasum` or `md5sum` on the server when allowed.
- **Extras only SFTP has:** a terminal on the server (4.10) and SSH tunnels (4.9).

#### 1.8 FTP / FTPS

- **Fields:**
  - Name.
  - Server (accepts `host:port`).
  - Port (empty means 21, or 990 for implicit).
  - Encryption: **FTPS** (explicit, the usual, port 21), **FTPS, implicit** (older, port 990), **None** (plain).
  - A checkbox "Fall back to plain FTP if the server doesn't support encryption", like FileZilla's "TLS if available".
  - User name (empty means anonymous).
  - Password (optional, with "Remove saved password").
  - Start in folder (must exist).
- **Encryption starts on explicit FTPS.** Plain FTP must be chosen on purpose and shows a warning: password and files cross the network readable.
- **The fallback is cautious.**
  - Kybl asks once ("Connect without encryption") per user, host and port before it ever sends a password unencrypted.
  - A server that has encrypted before, or lists AUTH TLS, is never used unencrypted again.
- **Capabilities:**
  - Passive mode with the NAT fix, UTF-8 names, MLSD listings with LIST as fallback, up to 4 connections per server.
  - Real folders, native rename, range reads, conditional writes by comparing, no server copy.
  - Uploads go to a `.name.kybl-…` temporary name and are renamed (servers refusing dot names get the file written in place).
  - chmod through `SITE CHMOD` where supported.
  - Permission and owner info from MLSD or `ls -l`.

#### 1.9 This device

- On a computer: your disks and folders as drives. On a phone: "On this phone". Files are real files (they can be opened and revealed directly).
- Delete goes to the system Trash or Recycle Bin.
- Used as the other end of uploads, downloads, sync, mirror and copy jobs.
- Only the folders Kybl can open are allowed; anything outside gives "That place is outside the folders Kybl can open here."

---

### Connection management

#### 2.1 Add, edit, delete, test

- **Add:** the picker offers the kinds above. When no Kybl Storage connection exists yet, it is offered first. "Import connections…" is on the picker on computers. Phones show the same dialog as a bottom sheet.
- **Edit:** Settings › Connections lists every connection with its address and an **Edit** button; the sidebar menu also edits. Typed edits are guarded: closing asks "Discard your changes?".
- **Test connection:** opens the backend and lists its roots. That connects, signs in and checks the start folder, so the error shown is the real one. For SFTP it also meets the host key.
- **Save:** runs the test first for SFTP (to learn the host key). Other kinds save straight away.
- **Delete:** a confirm control in the dialog. It removes the connection and its stored secrets, including sign-in tokens and SSH keys.
- Field errors appear only after the first Save or Test attempt.
- **Secrets are tied to where they go.**
  - A saved password is never sent to a different server, user name or transport. Editing those means typing the password again, or removing the saved one.
  - Azure and GCS keys are tied to the endpoint and account the same way.
  - S3 secrets are tied to the access key ID.
  - Name, folder and other edits keep the saved secret.
- **Groups:** connections can be put in folders, nested with `/` ("Clients/Acme").

#### 2.1a Organizing many connections

One model (`src/connections/organize.ts`) lays connections out the same way everywhere they are listed: the pane's connection menu, the sidebar, the destination picker, the command palette and the phone's list.

- **Pinned** connections come first, by name. A pinned connection also stays in its group.
- **Recent** lists the last 5 opened, once there are more than 10 connections. Pinned ones are not repeated there.
- **Groups** are folders (submenus in menus, folders that fold open elsewhere). Connections in no group follow, by name. This computer is always first and is never filed.
- **By type:** with more than 15 connections in no group, they are listed under Servers, Cloud drives and Object storage instead of one long list. The sidebar already has a section per server kind (FTP, SFTP, WebDAV), so there it folds the rest by type.
- **Find** searches every group at once. In menus, a match shows the group it is in beside it.
- **Long menus scroll**, with arrows at the edges. Menus open one level deep, so a nested group is one row with its whole path ("Clients › Acme").
- **Making groups (computers):**
  - ⌘/Ctrl-click (or "Select to organize" in a connection's menu) picks connections. A bar appears with **Move to group…** (existing groups, no group, or a new one) and **Pin** / **Unpin**. Esc clears the selection.
  - Drag connections onto a group row to file them there. Drop them on the "Connections" heading to take them out of a group.
  - A group's menu has **Rename group…** and **Delete group**. Deleting a group only ungroups: its connections stay, one level up.
  - **Pin to the top** / **Unpin** is in a connection's menu.
- **On the phone:** a connection's menu has **Pin to the top** and **Move to group…**. The home list shows Pinned first, then groups that fold open.
- **Saved with the connection:** the group and the pin are fields of the saved connection (`group`, `pinned`), changed without reconnecting. Recent and which groups are folded open are kept per device.


#### 2.2 Import connections (computers)

"Import connections…" (picker and Settings › Connections):

- Sources:
  - **FileZilla**: Site Manager `sitemanager.xml` and files from its Export. Default paths are checked on Windows, macOS and Linux. Folders become sidebar groups.
  - **SSH config** (`~/.ssh/config`): every concrete Host alias becomes an SFTP connection with what `ssh <alias>` would use. Supports Include, first-value-wins, and `LocalForward` lines (they become SSH tunnels). Imported hosts land in an "SSH config" group. `ProxyJump` and `ProxyCommand` are not supported and are noted. Wildcard hosts and Match blocks are skipped.
- Sources found on the computer are listed first, or you can choose a file.
- A preview lists the sites. You tick which to import. Sites already in Kybl and sites Kybl cannot open (with the reason) are left unticked. There is a search box and the app's folders as groups.
- Each site shows its protocol, host, user, start folder, how it signs in (password, anonymous, key file, agent, nothing saved, or encrypted with a master password that Kybl cannot read) and notes about what does not carry over (for example FileZilla's active mode, or "TLS if available" becoming TLS).
- **Passwords never reach the page.** The preview only says whether one is saved. On import the backend rereads the file and stores secrets straight into the vault. Key files are read into the vault too.

#### 2.3 Where secrets are stored

- **Computers and iOS:** the secrets live in an encrypted file (`vault.bin`, AES-256-GCM) in the app's data folder. Only the 32-byte key sits in the system keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service such as GNOME Keyring or KWallet; iOS Keychain). That means one keychain prompt and no size limit.
  - Migration from the older "everything in one keychain item" format is careful: the old item is deleted only after the new file reads back identically. A file that cannot be opened is set aside, never deleted.
  - Settings › "Secret keys" says "Saved encrypted, never in a settings file" and names the keychain.
- **Android:** a sealed file in the app's private storage (`secrets.bin`), with its key held by the Android Keystore (hardware-backed where available). It is excluded from backups. A phone whose Keystore does not work keeps using a plain file. If the Keystore key is gone (screen lock removed, backup restored to another phone), the app reports it instead of acting as if there were no keys.
- What is stored: the main secret under the connection id (S3 secret key, password, account key), plus an SFTP key and passphrase and OAuth tokens and your own client secret under separate entries.
- Connection definitions (host, user, region and so on) are in a profile file with no secrets.
- **App lock (phones only):** Settings › "Lock with Face ID" or "Lock with fingerprint". It asks when Kybl opens and after more than a minute in the background. While locked, nothing of the app is drawn, and a privacy screen keeps content out of the app switcher and screenshots. Unsaved edits survive. Turning it on requires one successful biometric check.
- There is **no app lock on computers** and no user-set master password in the app.
- **Kybl Storage encryption** is on the server side (see 1.1).

#### 2.4 Certificate trust and host keys

- **SFTP host keys** (2.1 and 1.7): unknown means "Trust this server?"; changed means a hard stop with a "Check the new key…" sheet showing the new and saved fingerprints.
- **FTPS and WebDAV (https) certificates**, like FileZilla's trust:
  - A server is accepted when its chain checks out, or when its certificate has the fingerprint you trusted. A different certificate fails the connection with "Trust this certificate…".
  - A sheet shows why it failed in plain sentences (the server signed it itself; not from a known authority; made out to another name; expired on a date; not valid until a date), plus Made out to, Issued by, Valid until and the SHA-256 fingerprint.
  - If a different certificate was trusted before ("changed"), the same default applies: not connecting is the default, and trusting the new one takes a deliberate click.
  - The trusted certificate is shown in the form with **Forget**. Changing the server clears it.
- **Plain FTP fallback** asks once, see 1.8.
- **Anti-spoofing:** trust questions are only believed when the error carries a secret per-run tag that only Kybl's backend knows, so a server cannot fake a "trust me" prompt through its error text. The host shown is always the connection's own.
- These trust fixes are offered in the connection dialog's test result, in the file pane when a folder fails, and on phone error screens.

#### 2.5 Reconnect, Try again, connection state

- If connecting fails, the pane says "Couldn't connect to X" or "Couldn't list X" with the plain-language reason and a **Try again** button. It lets go of the old connection first, so a timeout or a VPN that was off really reconnects. The button shows "Trying again…" while it runs.
- A failed folder load shows "Couldn't load this folder" with Try again.
- Sign-in kinds (Drive, OneDrive, Dropbox, Kybl Storage) show **Sign in again** or **Connect again** when access ended.
- A key that cannot list buckets is not shown as a failure. The pane offers "Open bucket by name". Kybl Storage offers "New bucket".
- Fixable trust problems (certificate, plain FTP, SSH key) put their button right in the empty pane.
- Jobs and syncs stop in a "needs sign-in" state and carry on after Resume once you sign in.

#### 2.6 Connection log

The **Log** tab of the Activity panel (see 3.6) records connecting too:

- "Connecting to X…".
- "Connected to X (1.4 s)".
- "Couldn't connect to X: X didn't answer in time."
- Folders that fail to list.
- The same error repeated is said once a minute.
- Only things you asked for are logged. Background work stays quiet.
- Technical details sit under "Details". The whole log can be copied for a bug report, and it can be filtered to problems only.

#### 2.7 Capabilities detection

Every connection reports a capabilities sheet to the UI (`connection_capabilities`), and menus hide or disable what it cannot do. The sheet covers: roots mode, can-create-root, folder kind, rename kind, server copy, share kind and expiry, streaming kind, range reads, conditional writes, hashes, thumbnails, metadata, tags, storage class, trash, versions, search, change detection, multipart and max file size, background upload, local paths, permissions, links. S3 connections use an S3 default while their own answer loads. Other kinds wait for theirs.

#### 2.8 Bucket and root picker

- Sidebar and pane show the connection's roots:
  - Buckets for S3.
  - Drives and places for Drive, OneDrive and This device.
  - A single root (shown under the connection's own name) for servers, Dropbox, Azure and GCS.
- The empty pane says "Choose a bucket" or "Choose a place", or "Connecting to X…" for single-root kinds.
- **Open bucket by name:** for S3 keys that cannot list buckets (Hetzner, scoped keys). Together with the Bucket field in the S3 form, this lets you work with such keys.
- Root names are remembered so shared drives and paths show by name everywhere (sidebar, breadcrumbs, favorites, Move dialog, Sync, Mount, phone headers).

#### 2.9 Creating buckets

Only Kybl Storage can create a bucket from the app ("New bucket"). The account owns its buckets, so there is no region to pick. Other S3 providers show no create option (the capability is off for them).

---

### Transfers

#### 3.1 The queue

- Uploads and downloads go into one queue that lives outside the UI and updates at most every 120 ms, so thousands of small files do not flood the interface. Rows start in groups of 50.
- Each transfer waits its turn **per connection**. A long upload queue on one connection never holds up a download on another.
- A row shows speed, time left, bytes and state: queued, running, paused, done, error or cancelled.
- Failed rows stay in the list with a plain-language error. Finished successful rows are trimmed (the latest 500 are kept once a batch ends).
- Compress and extract actions show as single rows in the same list.
- Files edited in another app and saved back also show here, but cannot be paused or cancelled from there.
- Settings › Transfers and sharing › Downloads:
  - **Ask where to save downloads.** Off means files go straight to the download folder, and an existing name is kept with the new file getting a number such as "x (1)".
  - **Download folder.**
- **Show activity automatically**: the panel opens when an upload, download, move or delete starts.

#### 3.2 Concurrency and speed limits (Settings › Transfers and sharing › Speed)

- **Files at the same time** per connection: 1 to 8, default 3.
- **Parts per file** (multipart parts in flight): 1 to 8, default 4.
- **Download limit** and **Upload limit**:
  - Separate caps, each shared by all transfers in that direction, so Kybl leaves room for the rest of the network.
  - 0 means unlimited. Changes apply to running transfers immediately.
  - Setting the speed menu in the Activity panel sets both at once. Presets are No limit, 1, 5 and 10 MB/s, plus Custom (MB/s, 0 for none).
  - The panel shows the limit next to the button, for example "limited to 5 MB/s" or "↓ 5 MB/s ↑ 1 MB/s".
  - If a limit fails to save, the panel shows "limit not saved".
- **Wi-Fi only (phones):** uploads, downloads and photo previews wait for Wi-Fi instead of using mobile data. A running download checks every 8 MB and pauses when the phone moves to mobile data.
- The same shared limiter and the same Wi-Fi rule also apply to copy jobs.

#### 3.3 Pause, resume, cancel, Cancel all, retry

- **Per row:** pause, resume, cancel, retry, and "move to top of the queue" (uploads and downloads).
- **Panel buttons** (shown for the tab you are on): **Pause all**, **Resume all**, **Cancel all**, **Retry failed / Retry all N failed**, **Clear** (Done tab), **Clear failed** (Failed tab).
- Pause and Cancel also cut a speed-limiter wait short, so they take effect at once, on uploads too.
- Stop on a folder listing ends the "finding files" step. What was found keeps going. Cancel all stops everything, including listings that are still feeding downloads.
- Retry all also covers failed moves, copies and deletes, and failed copy jobs.
- Retrying a download asks for the same path again. This is how the backend knows to continue from its partial file.
- If a start command is still in flight when you press Pause, Cancel, Resume or Retry, the request is held and applied once the backend has the transfer.
- **Quitting** while transfers or bucket operations run shows a native prompt. On Quit, transfers stop, open multipart uploads are aborted (so parts stop costing storage) and partial downloads are removed. Unsaved editor documents are asked about first. Cancel brings the window back.
- On computers with the "Keep running in the menu bar/tray" setting, closing the window keeps transfers, jobs and sync going.

#### 3.4 Resume after a restart, partial files

- Paused and failed transfers, and every transfer that was queued or running when the app quit or crashed, are written to disk as they start and as parts land. They come back **paused** (or failed) on the next start.
- They carry on from what was kept, where the connection allows:
  - the partial download file and the version it came from;
  - the confirmed parts of an S3 multipart upload;
  - the session of a cloud-drive upload;
  - the temporary file on an SFTP or FTP server.
- A download whose connection drops (a phone in the background, a network change) continues with a ranged request for the same version of the file. If the remote file changed, it restarts and says so.
- Rows say when they continued from a byte offset, or when they had to start over.
- A kept transfer nobody returns to within 7 days is given up and its leftovers are cleaned (servers drop unfinished uploads after about a week too).
- Each running copy of Kybl keeps its own records, so a second copy never resumes or overwrites the first's. A new start takes over the records of runs that ended.
- A cleanup ledger removes partial files and open uploads that no transfer owns any more.
- Android keeps transfers going in a foreground service with a progress notification, and they survive swiping the app away. iOS uses a background task, and iOS background uploads are supported on S3.

#### 3.5 Integrity checks

Settings › Transfers and sharing › Checking › **Verify files after copying**: Off (default), Size, or Checksum.

- **Off:** trusts the server's answer.
- **Size:** compares sizes. A mismatch fails the transfer, with Retry.
- **Checksum:** compares a content hash wherever both sides can give one cheaply, otherwise size. It reads each local file once more. The Done list records what was checked (size, md5, etag, sha256, quickxor, dropbox).

| Where | Compared with the local file |
|---|---|
| S3, single-request upload | the ETag (the MD5) |
| S3, multipart | the multipart ETag (MD5 of the part MD5s, with "-N"), worked out locally; for downloads, usual part sizes are tried |
| S3 with SSE-KMS or SSE-C, Kybl Storage | size only |
| Google Drive | MD5 |
| Dropbox | content hash |
| OneDrive | QuickXOR (or SHA-256) |
| SFTP | `sha256sum` / `shasum` / `md5sum` run on the server (if the account can run commands) |
| FTP, WebDAV, This device | size only |

- Pressing Cancel during a check marks the file as done but unchecked.
- Copy jobs have their own "Check contents after copying" (default on; sizes are always checked).

#### 3.6 Conflict choices

- **Uploads, moves, copies, renames, new folders** check the destination first, in chunks of 1,000, so a 50,000-file upload costs a few calls. If a name exists, a dialog asks:
  - Files: **Replace**, **Skip** or **Keep both** (adds a number, "name (1).ext").
  - Folders: **Merge** (files with the same names are replaced), **Skip** or **Keep both**.
  - "Do this for the other N" answers all the rest of that kind. Closing the dialog cancels the whole action.
- **Downloads:** an existing local file is kept and the new one gets a number, unless you picked the path in a Save dialog (that means replace). A download that finds a file turn up at its name while it runs moves to a free name, and the row shows the path really written.
- **Copy jobs** have five choices:
  - Skip if it's the same (the default, by size and hash or time).
  - Always skip.
  - Replace if older.
  - Always replace.
  - Keep both.
- **Sync** conflicts are handled differently (5.2).

#### 3.7 Streaming folder downloads

- A folder download starts with the first files, not after the whole tree is listed. The backend hands files over in batches as it finds them. This matters on FTP servers where listing thousands of folders takes minutes.
- A busy line shows the listing. It has a **Stop**, and Cancel all also reaches it.
- The picked local folder is the base. The backend refuses to write through a link below it, so a symlink cannot send files elsewhere.
- Folder listings for transfers skip links to folders, and these show up in the failures as "not copied".
- FTP listings run several folders in parallel (up to its connection limit).

#### 3.8 The Activity panel

A panel at the bottom with a speed menu (gauge icon) and these tabs, each with a count:

- **In progress:** running, queued, paused and waiting items, plus running sync, move/delete jobs and copy jobs. Lists up to 40 paused rows, and says how many more.
- **Failed:** failed transfers, jobs, moves and copies. Up to 50 are listed with the rest counted, and Retry all and Clear failed cover all of them.
- **Done:** finished and cancelled items (the latest 40 done and 20 cancelled, plus 30 finished jobs), with what was checked. **Clear** empties it.
- **Log:** the plain-language message log (below).
- **Jobs:** copies and moves between connections (4.1).

Empty tabs say "Nothing in progress right now.", "Nothing has failed." or "Nothing has finished yet." Phones have a Transfers screen with the same actions.

**Plain-language log.** One line when a batch starts ("Started downloading “regina-lite” (folder) from X to Downloads") and one when all of it has ended (counts, size and time, or why it failed, with the first 5 errors under Details). A batch is the rows of one user action. Rows added later for the same kind, connection and destination join the batch, as do rows within about 2 seconds of the last. The batch is closed 1.5 seconds after its last row ended. The log also records connecting and every error with its technical side under Details, and lasts for the session. The log reads newest at the bottom, follows new lines while you are at the bottom, can be filtered to problems, and has a **Copy** button for the whole log.

---

### Jobs

#### 4.1 Copy and move between connections (migration)

- Menu item "Copy to another connection…" (also move) on any selection, folder or connection root, to any folder on any other connection or this device. A dialog on desktop; a full-screen layer on phones. A **LocationPicker** can create a new folder on the way.
- Jobs are stored in a small database (`jobs.db`), so they continue after a crash, a quit or a phone killing the app. Startup resumes jobs that were running (S3 uploads from their confirmed parts).
- **How it works:**
  1. It plans (walks the source).
  2. It copies a few files at a time, using the transfer settings' file concurrency.
  3. For a move, it deletes each original only after its copy is verified.
- **Best route per file:** a native move or server-side copy within one connection; otherwise bytes stream through (ranged parts in parallel into S3) within one memory budget.
- **Options** (remembered): conflict choice (3.6), "Check contents after copying", "Keep modification dates" (where the destination can store them), and **Leave out** (default `.DS_Store, Thumbs.db, desktop.ini`; gitignore-style patterns).
- **Jobs tab:** progress, speed, time left, Pause, Resume, Stop (asks), "Show where it went", Remove from the list, and a list of the files that failed with **Try again**. Retry also resumes a failed job that has not finished all its files.
- **States:**
  - Getting ready.
  - Copying, Moving, or Removing originals.
  - Paused.
  - Waiting for Wi-Fi (phones, or after a network drop; it carries on by itself).
  - Sign in again (resume after reconnecting).
  - Done.
  - Done, with problems.
  - Stopped by a problem.
  - Stopped.
- A running job holds the quit prompt on desktop, and the transfer notification on phones. A big-file rename on a phone runs as a job.
- Uses the shared speed limits and Wi-Fi rule.

#### 4.2 Mirror (deploy a folder, or pull one down)

- From a folder's menu: **Mirror**. A sheet shows From and To (with a swap-direction button, so you can pull instead of push), saved mirrors you can run in one click, and a **dry run** first.
- **Planning** compares both listings without touching either side, and shows new, changed, same and gone files in tabs (upload / remove).
- Options:
  - "Upload new and changed files" (always on).
  - **"Also delete what's gone from the source"** (off by default, with a warning; deletions go to the Trash on this device).
  - **"Changed means"**: another size, or modified more recently (the default, with a tolerance for FAT and FTP clocks and hour-offset detection); another size only; or a different MD5 checksum (disabled when not available on those connections).
  - **Leave out**: gitignore-style, one per line, with an optional "also leave out what the folder's .gitignore lists".
- Case-insensitive destinations (This Mac or PC, OneDrive, Dropbox, Box) are matched by name in any case.
- The job then carries out exactly the previewed list: copies, then deletions last. Nothing outside the preview is touched. Each copy is still checked by the copier, so an identical file is skipped.
- Mirrors can be saved and named. A saved mirror runs from a command and checks first. If it would delete something, the sheet opens to confirm.
- Links are never followed, and neither side's link nor anything under its name is copied or deleted.
- It appears in Jobs like any other job.

#### 4.3 Folder sync (computers only)

- Settings › Sync, and "Sync this folder" in menus. A **mapping** pairs a local folder with a folder on any connection. Fields:
  - Connection and root (bucket or drive).
  - Remote folder (prefix).
  - Local folder.
  - **Direction:** *Upload only* (the local folder is the original; changes go up within seconds), *Download only* (keep a local mirror), or *Two-way* (both sides stay the same).
  - **Mirror deletions** (one-way only): upload deletes remotely; download moves local files to the Trash. Files you edited locally are never removed in download mode. Two-way always propagates deletions, behind the guard.
  - **Keep deleted files in a trash folder** (`.kybl-trash/<date>/` in the remote folder, for connections without their own trash). On by default for two-way, off for one-way.
  - **Ask before big deletions** (on by default): stops and asks before deleting more than max(50 files, 20% of the folder). A side that suddenly looks empty is always checked with you, and held deletions can be confirmed or restored.
  - **Full check every:** 1 min, 5 min (default), 15 min or 1 hour. Download mappings label it "Check for changes every".
  - **Ignore** list, one gitignore-style pattern per line. Defaults: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.tmp`, `*.swp`, `~$*`, `.git/`, `node_modules/`. There is a reset to defaults.
- **Watching:** upload and two-way mappings watch the local folder and send changes a couple of seconds after they happen, plus a periodic full comparison. Download mappings check on the interval only, because most storage cannot push changes.
- **Two-way details:**
  - It remembers both sides of every path as of the last sync, so it can tell "deleted" from "never synced" and "changed here" from "changed there".
  - Renames stay renames.
  - A file edited on both sides keeps both versions: the other side's version keeps the name and this computer's version becomes a conflict copy. Conflicts are listed and resolved in the app.
  - Deletions go to the system Trash locally and to the provider's trash or `.kybl-trash` remotely.
- **Keep on this device** (offline folders) are two-way mappings made from a menu.
- Per mapping: Sync now, Pause, Delete. Global: pause all, sync all now.
- A new mapping that overlaps another saved folder (compared through links) is refused. An edit that leaves the folder unchanged is never refused for an overlap that already existed.
- A status per mapping: idle, scanning, syncing, error or paused, with the current file, files done of total, bytes, last sync time, and conflict and pending-deletion counts.
- Runs from the menu bar or tray with the window closed. "Open at login" starts it quietly.
- Not available on phones. Phones have backup (4.6) instead.

#### 4.4 Backup

There is no separate "Kybl backup" product or schedule screen on computers in this code. Backup is:

- **Phone backup** (4.6): camera roll and picked folders to any connection. Scheduled by the phone.
- **Upload sync mappings** on computers (4.3). A one-way upload mapping with "Mirror deletions" off keeps everything ever uploaded. It is the computer's backup, with a watch plus interval check.
- **Backing up to Kybl Storage** is done by choosing a Kybl Storage connection as the destination in either of those. Nothing in the code treats it specially.
- There is no separate "live backup" feature. The nearest things are the folder watch in upload and two-way sync, and the phone's "on new photos" trigger.

#### 4.5 Mount as a drive (computers)

- Menu on a connection, root or folder: **Mount as drive…**. A dialog asks for the Drive name (a name is suggested, up to 80 characters). If it is already a drive, it offers "Show in Finder". Settings › Drives lists and manages drives; the sidebar badges show mounted or errored drives; the menu offers "Show drive in Finder" and Eject (Unmount outside macOS).
- **How:** each drive is a small WebDAV server inside Kybl on 127.0.0.1, with a random token in its path that changes at every mount. The operating system then mounts it.
  - **macOS:** mounted through the system's WebDAV mount. It appears in Finder.
  - **Linux:** mounted through the desktop's file manager (GVFS).
  - **Windows:** **not available** ("Drives aren't available on Windows yet"). It is planned with Windows' own cloud files support. An experimental WebDAV path exists behind an environment variable (`KYBL_EXPERIMENTAL_WEBDAV_DRIVE=1`).
  - **Phones:** no.
- **Behaviour:**
  - Files download when opened (ranged reads, cached on disk in blocks, with a per-drive cache limit).
  - What you save uploads in the background through a queue with retries.
  - A save that conflicts with a change on the other side is kept as a conflict copy and a notice is shown.
  - Finder and Explorer clutter (such as `.DS_Store`) stays local.
  - Drives can be read-only.
  - Drives are remembered and mounted again when Kybl starts, and unmounted when it quits (the quit prompt counts pending uploads, which carry on next start).
  - Status per drive: mounting, mounted, unmounted, error, unsupported or removed, plus uploads waiting, bytes sent, last upload error and cache size.
  - A second running Kybl cannot take over drives ("Another copy of Kybl has the drive").
  - Google Docs show as shortcut pages.
- Security note from the code: while a drive is mounted, any program on the computer can read the token from the system's mount list. This is the same exposure as the mounted folder for the signed-in user, but wider on shared Macs.

#### 4.6 Phone backup (Android and iOS)

- Backs up the **camera roll** or **picked folders** (Android folder picker, iOS Files folder) to any connection, with a destination folder.
- **Setup flow:** What should Kybl back up? Where should it go? Folder layout, what to include, start point, and when.
- **Folder layout (name template):**
  - Year and month (`{yyyy}/{MM}/{name}`, the default).
  - Year, month and day.
  - Phone name, then year and month.
  - All in one folder.
  - The same folders as on the phone (folder sets).
  - Tokens also include `{yy}`, `{stem}`, `{ext}`, `{device}`, `{album}`, `{type}` and `{path}`.
- **Options:**
  - Videos.
  - Live Photo videos (iOS).
  - Save HEIC photos as JPEG (iOS).
  - Edited photos: as edited, original, or both (iOS).
  - Start with all photos or "Only new from now".
  - **Wi-Fi only** (on by default).
  - **Only while charging** (off by default).
  - A set can be paused.
- **Scheduling:**
  - Android: WorkManager, every 15 minutes, when new photos appear, and on demand (Back up now).
  - iOS: while the app is open, and an overnight background task while charging.
  - Background runs work even when the app process is not up.
- **Dedupe:** each item is uploaded once per version. On a first run against a folder that already holds the photos, a file with the same name and size counts as backed up. A different file with the same name gets "IMG_0001 (2).HEIC".
- **Deletes never propagate:** nothing deletes anything on the destination.
- **Status:** idle, running, waiting for Wi-Fi, waiting for network, needs sign-in, paused. A failures list shows per-file errors and attempts.

#### 4.7 Phone: Keep-offline, system back, and share

Phones also have: share sheet and photo-picker uploads (Android `content://` files are copied to the cache first, then uploaded and the copy removed), downloads into *Files › On My iPhone › Kybl* on iOS and `Download/Kybl` on Android, and app lock (2.3). Folder sync, the menu-bar icon and launch at login are desktop only.

#### 4.8 Updates and background running

Not connection-specific, but jobs depend on it: on computers "Keep running in the menu bar/tray" keeps sync, jobs and drives alive with the window closed, and updates check at start and every few hours.

#### 4.9 SSH tunnels (SFTP connections, computers only)

- In an SFTP connection's form, a **Tunnels** section lets you add local port forwards. Each tunnel has:
  - Local port (on 127.0.0.1).
  - Remote host, as the server sees it (for example `db.internal` or `localhost`).
  - Remote port.
  - Optional name.
  - **Auto start** (started when Kybl first opens the connection in a run).
- Each tunnel listens on 127.0.0.1 only and carries every accepted TCP connection over an SSH channel on a connection of its own.
- Start and stop from Settings, the connection's sidebar menu and the command palette. A badge shows the status, and status events are live.
- The form tidies and validates tunnels (ports, empty fields, duplicates) before saving.
- The SSH config import turns `LocalForward` lines into tunnels.
- Not shown on phones.

#### 4.10 Terminal

- **Terminal panes** sit beside file panes. They open from a folder's menu ("Open in terminal") and from the toolbar.
- **Local terminal:** a shell on this computer, running your login shell in the pane's folder (macOS and Linux only; Windows says "Terminals on this computer aren't available on this system yet. SFTP connections can open one.").
- **Server terminal:** on an SFTP connection, an SSH session with a pseudo-terminal, signed in with the connection's credentials, starting in the pane's folder. Folder changes work with Unix shells. A login shell that is cmd.exe or PowerShell (Windows OpenSSH) gets no automatic `cd`. A server shell refuses file drops.
- **Pane header menu:** Clear, Restart shell, "Follow the folder above" (the shell `cd`s wherever the file pane goes; a note says why it did not follow last time, for example "busy"), Copy, Paste, Bigger text, Smaller text, Actual size, and Close terminal. Keyboard shortcuts are ⌘ on Mac and Ctrl+Shift elsewhere, and ⌃` goes back to the file pane. App-wide shortcuts that a shell needs (⌘K) are kept out of it.
- **Dropping files from Finder** onto a local terminal types their quoted paths ("Drop to paste the paths").
- **Paste dialog (safety):**
  - Pasted text has control characters removed, apart from tab and line breaks.
  - A paste with line breaks asks for confirmation. The preview shows invisible and direction-changing characters as `<U+….>` and shows every line break, so what you see is what runs.
  - Very big pastes (over 1,000,000 characters) always ask. Over 16,000,000 are refused.
  - "Don't ask again" skips the question for that one running terminal only, and only when the shell has bracketed paste on.
  - Settings › "Ask before pasting several lines in a terminal" shows how many terminals have it off, with "Ask in all terminals" to turn it back on.
- Pastes during shell start-up are queued in order and sent when the shell runs.
- Nothing a terminal shows or is sent is ever logged. xterm.js loads as a separate chunk the first time a terminal opens.
- Output is flow-controlled in batches.

---

## Settings, updates, account and more

### Settings (desktop)

The Settings page is a full window page (Esc or "Back to app" closes). Left navigation, three groups: **Settings** (General, Appearance, Browsing, Transfers and sharing, Actions), **Storage** (Folder sync, Drives, Connections, Cache and data), **Help** (Keyboard shortcuts). The tray and the Check for Updates menu item open it directly on a page (General for updates, Folder sync for sync).

#### 3.1 General
| Setting | Options | Default | Notes |
|---|---|---|---|
| Reopen last location (Startup) | on or off | on | Starts in the connection, bucket and folder you were in. |
| Keep running in the menu bar or system tray | on or off | on | Closing the window keeps the app and folder sync running; quit from the tray icon or Cmd+Q. (Backend pref, not in localStorage.) |
| Open at login | on or off | off | Starts quietly in the tray so synced folders stay current. |
| Confirm before deleting (Safety) | on or off | on | Hint explains most connections cannot undo a delete; drives and the Trash or Recycle Bin keep deletions. |
| Ask before pasting several lines in a terminal | button "Ask in all terminals" | asks always | The question itself has "Don't ask again" per running terminal; this turns it back on everywhere. |
| Secret keys | info only | "Encrypted" | Saved encrypted, key in the Keychain, Credential Manager or system keyring. |
| About | version chip ("dev build" when unknown) | | With app lockup and tagline. |
| Check for updates automatically | on or off | on | Looks at start and every 6 hours. Nothing installs without asking. |
| Updates | status text and one button | | Buttons: What's new, Update and restart / Download / View release, Check now, Restart now / Restart anyway. |

#### 3.2 Appearance
| Setting | Options | Default |
|---|---|---|
| Mode | System, Light, Dark | System (follows the OS live) |
| Colour scheme | 8 schemes, each with its own light and dark palette, shown as mini previews: Kybl, Classic, Graphite, Midnight, Nord, Solarized, Ember, Grape | Kybl |
| Accent colour | Scheme (uses the scheme's own), Blue, Purple, Pink, Orange, Green, Graphite | Scheme |
| Font | System, Rounded, Serif, Mono (tiles preview each) | System |
| Size (whole interface zoom) | Small 0.9, Default 1, Large 1.1, Larger 1.25 | Default |
| Compact layout | on or off (applies to every pane; each pane can still change its own) | off |

#### 3.3 Browsing
| Setting | Options | Default |
|---|---|---|
| Photos | Off (icons only), Placeholders (blurry ThumbHash preview only, no thumbnail downloads), Thumbnails (preview then thumbnail, cached on disk) | Thumbnails |
| Folders first | on or off | on |
| Dates | Friendly ("Today, 14:32") or Full | Friendly |
| List columns | Size, Modified, Kind, Storage class, ETag (toggle chips; Name always first; headers are also right-clickable) | Size, Modified, Kind |
| File sizes | MB (1000) or MiB (1024) | MB |

Per connection, right-click lets you give a connection its own Photos mode and turn on **sharing placeholders** (writes a small hidden `.kybl/thumbhash.json` into each photo folder you open so other devices show previews at once).

#### 3.4 Transfers and sharing
| Setting | Options | Default |
|---|---|---|
| Ask where to save downloads | on or off | on (off = straight into Downloads; a same-named file keeps both with a number) |
| Download folder | read-only path | system Downloads |
| Files at the same time | 1 to 8 | 3 |
| Parts per file | 1 to 8 | 4 |
| Download limit | Unlimited, 1, 5, 10, 25, 50 MB/s, or Custom (typed MB/s) | Unlimited |
| Upload limit | same | Unlimited |
| Verify files after copying | Off, Size, Checksum | Off |
| Show activity automatically | on or off | on |
| Share link lifetime | 1 hour, 24 hours, 7 days | 24 hours |

Limits are shared across all running transfers and apply live; they stay in sync with the Activity panel's speed menu. Checksum compares where both sides have one (S3, Google Drive, Dropbox, OneDrive, SFTP), else size; encrypted connections compare size only. `wifiOnly` exists in the transfer prefs but is only exposed on phones.

#### 3.5 Actions, Folder sync, Drives, Connections, Cache and data, Shortcuts
- **Actions:** custom actions list (switch on or off, edit, shortcut, export and import JSON; each has "Runs", "Applies to", "Output", placeholders and a preview).
- **Folder sync:** synced folders, all folders, deletions waiting, conflicts, pause syncing (details belong to the sync slice).
- **Drives:** mounted drives and "How drives work".
- **Connections:** list of saved connections with Edit, "New connection", and "Import connections..." (from FileZilla and other apps).
- **Cache and data:** Clear cache (thumbnails, placeholders and recently opened files; shows current sizes; files opened in other apps in the last hour are kept). **Reset all settings** (two-step confirm) returns settings, transfer settings, compact layout, tray setting and auto-update to defaults. It keeps connections, favorites, sync, actions, layout, sort, tile size, sidebar state and Open at login.
- **Keyboard shortcuts:** the full read-only list (about 55 entries) in OS-correct glyphs.

#### 3.6 Settings that exist but are not in the page
- `sidebarHidden`, `sort`, `tileSize`, `favorites`, `quickInfo` (Quick Look's info column; shown by default in a wide window), `showHiddenFiles`. These are changed in the UI directly.
- Legacy `layout` and `syncBrowsing` are read only once to migrate into the split-layout tree.
- Settings are stored in `localStorage` (`s3b.settings`), applied as `data-*` attributes and inline CSS variables. Accent, scheme, font and theme apply immediately; size uses native webview zoom.
- One-time migrations: old thumbnails switch to the Photos mode; old users who never picked a look move to the Kybl scheme.

#### 3.7 What is NOT there (checked)
- **No release channel setting** (no beta or stable switch). The updater only reads the latest published GitHub release; drafts and pre-releases are never returned.
- **No desktop app lock or privacy page.** App lock is phone only. There is no analytics or telemetry setting; the code has none.
- **No language setting and no i18n.** All text is hard-coded English (see section 8).
- **No window position or size setting.**
- The website says "Kybl pronounced kibble, from Czech and Slovak for bucket".

### Updates

- Source is **GitHub Releases** (no update server). The native side (`updater.rs`) checks 10 seconds after start and every 6 hours, and when you press Check now, the Kybl menu item, or the tray item. Result is kept and pushed to the page as `update-status` events.
- **Install behaviour per platform:**
  - macOS: downloads `Kybl_<arch>.app.tar.gz`, unpacks next to the app, verifies the code signature against the running app, swaps it in place and relaunches.
  - Windows: runs the NSIS setup (or the .msi for MSI installs) passively and starts the app again.
  - Linux AppImage: replaces itself. `.deb` and `.rpm`, Android and iOS: the button becomes **Download** or **View release** and opens the download in the browser (Android's installer, or AltStore on iOS, installs it).
- Every download is checked against the SHA-256 GitHub records (an asset without one is refused), downloaded into a private folder, and checked again right before running.
- **UpdateBanner** (a card bottom corner, desktop and phone): "Kybl x.y.z is available. You have a.b.c. What's new" with **Update and restart** (or Download), **Later** (until next launch), **Skip** ("Don't remind me about this version"), and an x close. During install it shows "Downloading Kybl x... N of M" with a bar, "Installing...", then "Kybl x is installed" with **Restart now**. If transfers are running it says so, and the button becomes "Restart and stop transfers". Failures show the reason with Try again, Release page and Later. The banner is hidden while Settings is open (Settings shows the same state).
- The editor refuses restart while edits are unsaved.

### Kybl account, Kybl Storage and connecting

- **Kybl Storage** is hosted S3 storage run by Kybl (website: 10 GB free, EU, encrypted at rest). It has a provider id `kybl` with its own logo mark in the sidebar.
- **Connect Kybl Storage dialog** (first thing offered on an empty app, and the first option in the New connection picker, shown first only when there is no Kybl connection yet):
  1. **Continue in browser** (or "Connect again in browser" for an existing one): opens the Kybl account site, you sign in and approve this device, and the app receives its own access key. Nobody types or copies keys. On phones the browser comes back via `kybl://connect` (Android Custom Tab, iOS sign-in sheet).
  2. **Sign in on another device with a code:** shows a **QR code** (SVG made in Rust), a short user code you can click to copy, and the verification address. Scan it with your phone or open the link elsewhere and enter the code. A live countdown shows the time left. Phones say "scan the code or open...".
  3. "Browser didn't open? Use a code instead" fallback while waiting.
  4. **Server:** a small link shows the account site in use. It can be changed to another URL (stored as `kybl.appUrl`); the default is built in.
- Editing a Kybl connection shows the account name and endpoint, a "Connect again" (gives this device a fresh key; old keys can be revoked on the account's Access keys page), and a **Remove** with a confirm step (focus starts on Keep).
- If the key is revoked on the web or the account is deleted, the connection shows a "Sign in again" badge in the sidebar and the empty pane says "This computer's access key was revoked...". Connect again goes straight to the browser step.
- Kybl pane empty state includes "New bucket" (making buckets is a Kybl Storage action).
- Cloud drives (Google Drive, OneDrive, Dropbox) use a similar "Sign in with ..." panel with the browser; same reconnect pattern.
- A Kybl-specific "Kyblik" mascot appears in splash and empty states on phones and on the website.

### Onboarding, empty states, toasts and notifications

#### 7.1 Empty and onboarding states (desktop)
- **No connections (Welcome card):** Kybl mark, "Welcome to Kybl", a line saying it browses S3, SFTP, FTP, WebDAV and cloud drives and saves secrets encrypted in the OS keystore, **Connect Kybl Storage** (primary), "Add another S3 connection with keys", and the row of provider badges.
- **Connection chosen, nothing open:** "Choose a bucket" or "Choose a place", "Pick one from the sidebar", with New bucket (Kybl) or Open bucket by name (S3). While a server is connecting: spinner and "Connecting to X...". On failure: "Couldn't connect to X" or "Couldn't list X" with the reason, and the fix buttons (trust a server certificate, connect without encryption for FTP, trust an SFTP host key), Try again, Connect again (revoked), or "Open bucket by name". A key that cannot list buckets is explained as not a failed connection.
- **A recipe pane whose connection is missing:** "'Name' isn't on this device. This pane of the workspace recipe opened empty." with Add connection.
- **Empty folder, search, filter results,** and error banners in the pane header area (see 2.3). Failed folder listings show "Try again" and a hint.
- **Activity panel empty state** (when opened on purpose).
- **Stale favorite:** greyed row; clicking one whose folder is gone shows an error toast with a Remove action.
- **Settings:** "No connections yet - add one to start browsing."

#### 7.2 Toasts
- Stacked toasts in an `aria-live` region. Kinds info, success (3.2 s), error (12 s), and any toast with an action stays at least 8 s. Hovering or reading the details pauses the timer. Click the text to dismiss. Toasts sit above the Activity panel when it is open (and at the top of the screen on phones when a sheet is up).
- **Toasts with an Undo button:**
  - After move, rename and copy (file operations, **Undo** reverses it; Cmd+Z undoes the latest, up to 20 entries; not offered when something was replaced).
  - After closing a workspace or several workspaces.
  - After a workspace recipe action (`useWorkspaceRecipes`, two Undo toasts).
  - On phones, after a move (Undo moves it back) and for copy the button is Open.
- **Toasts with other buttons:** Show (move or upload into another workspace), Retry, Open Transfers, Remove (a missing favorite), Open (a saved download), Continue.
- Examples: "Uploaded 3 files", "2 uploads failed" with Show or Open Transfers, "Added 'name' to Favorites", "Kybl is up to date", "Cache cleared (X freed...)", "Settings are back to the defaults", "Moved 'x' to 'Workspace'".

#### 7.3 Notifications (system)
- **Desktop:** there are **no OS notification popups**. Status is the tray icon, its tooltip and menu text (sync progress and problems), the in-window Activity panel, and toasts.
- **Android:** a foreground-service notification with combined transfer progress and a Cancel action, and a short "done" notification when the app is not on screen. Tapping opens the Transfers screen.
- **iOS:** no notifications; a background task keeps transfers alive for about 30 seconds after leaving the app.

### Internationalisation

- **None.** There is no i18n library, no translation files, and no language setting. All UI text is hard-coded English in the components. (Date, number and sort ordering use the browser or system locale through `toLocaleString`, `toLocaleDateString` and `Intl.Collator`, so numbers, dates and name sorting follow the system, but the words do not.)
- System-specific wording is handled by `osNames.ts`: "This Mac", "This PC", "This computer"; Finder, File Explorer, Files; Keychain, Credential Manager, system keyring; Trash, Recycle Bin; and "menu bar" versus "system tray". Shortcut glyphs differ on Mac vs Windows or Linux.

### The `website/` folder

- It is the **marketing site for kybl.app**, plain static files (no build step): `index.html` (single homepage, about 660 lines), `style.css`, `privacy-policy/` and `terms-of-service/` pages (using `assets/legal.css`), `robots.txt`, `sitemap.xml`, `site.webmanifest`, favicons and touch icons, `og.jpg` share image, `assets/shots/` (app screenshots in light and dark: browse, connect, sync, as WebP), and `llms.txt` plus `llms-full.txt` (plain-text descriptions for AI tools).
- Homepage sections (from the headings): works with the storage you already pay for; your bucket list, sorted; keep a folder in sync even with the window closed; "Kyblik tells you how your folders are doing"; no bucket yet? borrow one of ours (Kybl Storage); good to know before you grab Kybl (FAQ); get Kybl for your computer and phone (downloads).
- Claims on the site: free, 10 GB free Kybl Storage in the EU, encrypted at rest (AES-256, SSE-C, key per bucket; explicitly not end-to-end), secret keys in the OS keychain, folder sync with ignore rules from the tray, platforms as in section 1. The account site is `https://app.kybl.app/`.
- Verified against code: platform list, updater source, tray and sync behaviour and Kybl Storage connect flow match. The `llms.txt` provider list is S3-focused and does not list SFTP, FTP, WebDAV or cloud drives, which the app supports (so the site text is narrower than the app).

## Phone and tablet app

### Screens and behaviour

Same Rust backend, separate touch UI. A **tablet or a large window** (at least 900 x 600) switches to a **wide layout** (sidebar of connections, files in the middle, a details panel on the right). Anything smaller is the phone stack layout.

#### 6.1 Screens and navigation (phone layout)
- **Home:**
  - Top bar with the Kybl lockup, a Transfers button (shows a count of running transfers) and Settings.
  - **First run** welcome: mascot, "Your files, in your pocket", a line about supported storage, **Connect Kybl Storage**, "Add another connection", provider badges.
  - After setup: a **Photo backup card** (hideable; opens backup), **Favorites**, **Recent** (up to 6 places not already favorites), and **Connections** list with buckets or drives under each. A connection's "..." (options) opens a sheet.
- **Browse screen** (connections, then buckets, then folders as a stack with large titles that collapse into a solid bar on scroll):
  - Back, Search, More. Title is the folder. Sort pill (Name, Newest first, Largest first) and a **list or grid** toggle. A filter field for the current folder, plus "Search all subfolders for ..." deep search with a live "Looking for ..." mascot state and the count of files checked.
  - Pull to refresh. Infinite loading of big folders (next page loads when the end scrolls into view) plus a "Load more" button.
  - **Floating "+" button**: Take photo or video (phones), Upload photos and videos, Upload files, New folder.
  - A one-time card "Show photo previews?" (Show previews or Not now) when a photo folder is open and previews are off.
  - Error states: "No connection", "The server didn't answer", "Couldn't open this folder", each with Try again and, where fixable, a connection fix row (trust certificate, allow plain FTP, trust SFTP key). "This folder is empty" with an Upload button.
  - Offline strip at the top: "You're offline - Kybl refreshes when you're back" or "Can't reach the storage" with Retry.
- **Photo and video viewer:** full screen; swipe between the folder's media, pinch or double-tap to zoom, drag down to close, tap to hide the controls. Top bar shows name, "N of M", size. Bottom tools: Share, Save to Photos (phones), Download, Info, Delete. Previous and next buttons for large screens. Neighbours preload; on mobile data only thumbnails are preloaded.
- **Document screen:** opens text and documents in the same in-app editor as desktop; saves report "Saved" in the editor header. "Open in..." hands it to another app.
- **Detail (Info) screen:** a preview pane (share link with expiry, copy, download, rename, move, delete) as a pushed screen on phones, a side panel in the wide layout.
- **Folder info** sheet (bucket or folder info).
- **Transfers screen:** see 6.3.
- **Destination screen:** see 6.4.
- **Move or Copy dialog**, **Copy to another connection** (migration dialog), **Prompt** and **Confirm** dialogs, **Connection dialog**, and the Kybl connect dialog.
- **Settings screen:** see 6.2.
- **Backup screen:** see 6.6.

#### 6.2 Settings (phone) - what differs from desktop
| Section | Item |
|---|---|
| Appearance | Theme: Automatic, Light, Dark (no colour scheme, accent or font choices on phones) |
| Text size | Small, Default, Large, Larger (also follows the phone's own text size) |
| Browsing | Reopen the last folder; Ask before deleting; Binary sizes (1 KiB = 1024 B); Full dates |
| Backup | Photo backup (where the phone has it) |
| Transfers | **Wi-Fi only**: uploads, downloads and photo previews wait for Wi-Fi |
| Privacy | **Lock with Face ID** (iOS) or **Lock with fingerprint** (Android). Turning it on prompts once to prove it works; fails with "Set up a screen lock on your phone first" |
| Photos in lists | Off, Placeholders, Thumbnails (with hint; per-connection override and shared placeholders through the connection's "..." menu) |
| Share links expire after | 1 hour, 24 hours, 7 days |
| Connections | list with edit and "Add a connection" |
| Storage | Clear cache |
| Updates | Check for updates automatically; Check for updates or the install or download button with version and size |
| Footer | where downloads are saved, "Secret keys are kept on this device only", version |

Not on phones: folders first toggle, list columns, concurrency or speed limits, verify, download ask, tray, login, actions, folder sync, drives, shortcuts, compact layout, scheme, accent, font.

#### 6.3 Transfers screen and button
- Bar button shows a **running count** (aria "Transfers, N running"). A notification tap opens this screen too.
- "Stop all" (stops running, queued and paused). Pills: Resume all N, Retry N failed, Clear failed, Clear finished.
- Rows (jobs first, then transfers, sorted by state): icon by state, name, progress bar and a line such as "12 MB of 40 MB . 2 MB/s . 20 s", "Waiting", "Uploaded", "Saved as 'name (1).jpg'", "Stopped . Tap to retry", "Paused . Tap to resume", error text with "Tap to retry". Row buttons: Stop, Resume, Retry, Dismiss. Tapping a finished download opens the file.
- Includes bucket jobs (delete, rename, big moves) and a "Copies between connections" section.
- Empty state: "No transfers. Uploads and downloads show up here. Downloads are saved to {where}".
- Downloads save to *Files > On My iPhone > Kybl* on iOS and `Download/Kybl` on Android (per README; the app text uses the same words via `savedWhere`).
- Background: Android foreground service with a progress notification (tap opens Transfers, notification has Cancel) and a short "done" notification when the app is not on screen. iOS holds a background task, giving about half a minute, then resumes what is left on return.

#### 6.4 Destination picker ("Upload to...")
- Opens when files are **shared into Kybl** from another app (Android share sheet via SEND or SEND_MULTIPLE, iOS document types), at launch or while running. More shares add to the same batch.
- Pick a connection, then bucket, then folder, with Back stepping up. Shows the files being sent ("N files" or the file name). **New folder** can be made here (also for servers where the folder does not exist yet). Starts the uploads, then returns. Back out asks "Don't upload" (the shared files are not kept; share again later).
- Empty state "No connections yet. Add a connection first, then share the files to Kybl again."
- Errors listing a folder offer retry and the same connection fix rows.

#### 6.5 App lock (phones)
- Setting "Lock with Face ID or fingerprint". Locks at launch and when the app returns after **more than 1 minute** in the background. The unlock prompt itself (which can background the app) does not count as being away.
- While locked nothing is drawn: file list, open documents, toasts are hidden (kept underneath so unsaved edits survive). A privacy screen also hides content in the app switcher and from screenshots.
- Lock screen: mascot, "Kybl is locked", "Use Face ID, Touch ID or your passcode to open it" (iOS) or "fingerprint, face or screen lock" (Android), an **Unlock** button. It asks once on its own after a moment.
- Uses the phone's own screen-lock fallback (passcode), and shows an error if the screen lock was removed.

#### 6.6 Photo backup (phone)
- Backup card on Home and "Photo backup" in Settings. Backup screen lists backups with state; each is a set with details, setup flow ("What should Kybl back up?" camera roll or chosen folders, "Where should it go?" any connection and folder), "Back up everything now", "Add another backup", "Remove this backup" (files already backed up stay).
- Options: Videos, Live Photo videos (iOS), Save HEIC as JPEG (iOS), Edited photos (As edited, Original, Both; iOS), Start with (All or Only new from now), When (Wi-Fi only, Only while charging), Folders. Shows failures with retry. The phone does the work in the background (Android WorkManager, iOS background tasks).

#### 6.7 Gestures and interactions
| Gesture | Where | What it does |
|---|---|---|
| Tap | row | Open folder or file (or toggle selection while selecting) |
| **Long press** | row | Starts selecting; haptic tap |
| **Drag over rows after a long press** | list | Selects a range (haptic feedback per change) |
| "..." button | row | Action sheet for that item |
| **Pull down** | top of a list | Refresh, with a mascot indicator (trigger 72 px, rubber band) |
| **Swipe right from the left edge** | iPhone (and dev builds) | Go back; slides the top screen away. Applies to detail, document, destination, transfers, settings, migrate and backup screens |
| **Android system back button or gesture** | Android | Closes the top layer, or leaves the app at the root |
| iOS system history back | iOS | Walks back up the app's layers |
| Drag down | photo viewer | Close |
| Swipe left or right, pinch, double-tap, tap | photo viewer | Next or previous, zoom, zoom, hide controls |
| Two-finger or pinch | | handled by the viewer only |
- **Layer stack:** everything that opens (screens, viewer, document, sheets, dialogs) forms one stack; back always closes the topmost one, and sheets and dialogs move toasts to the top of the screen.
- **There are no row swipe-actions** (no swipe-to-delete or swipe-to-share). Row actions are the "..." sheet and long-press selection.
- **Selection mode:** "N selected" with Done, and a bottom action bar: Share, Download, Move, Delete, More (Copy to..., Copy to another connection, Save to Photos). A single selected item offers its full action sheet.
- **Item action sheet:** Share..., Open in..., Save to Photos (photos), Info, Download as ... (Google Docs exports), Rename, Move or copy..., Copy to another connection..., Select, Delete (danger). Folders: Info, Add or Remove Favorite. Folder "More" sheet: Select, New folder, Refresh, Add or Remove from Favorites, Folder info, Copy to another connection.
- **Connection "..." sheet:** Sign in again, Edit connection, Open (single-root) or Choose buckets to show, New bucket or Open bucket by name, Refresh buckets, Photos mode (As in Settings or its own), Share placeholders, Copy everything to...
- **Place menu** (Favorites or Recent): Add or Remove from Favorites, Remove from Recent.
- Haptics for selection and success. The keyboard fits (the layout moves for it). Safe-area insets are respected (8 places). Text size follows the phone's setting too.

#### 6.8 Differences from desktop (summary)
- One screen at a time (no panes, workspaces, split layouts, tabs or sidebar on phone; tablets get a sidebar plus details panel).
- No menu bar, tray, launch at login, folder sync, drives, terminal, custom actions, command palette, keyboard shortcuts page, compare folders, or commander keys.
- Phone-only: app lock, Wi-Fi only, photo backup, take photo or video, Save to Photos, share into Kybl, deep-link sign-in, foreground-service and notification transfers, pull to refresh, edge swipe, haptics, offline strip.
- Updates: on phones the button opens the download (APK or IPA; AltStore source for iOS).
- Downloads always go to a fixed place (no ask dialog).
- Same: connections and dialogs, Kybl sign-in (with QR), listing and search, preview, editor, undo, copy between connections, image modes, update banner.

## Appendix: where the README is out of date

### From the connections side

- The README's feature list only describes S3 and Kybl Storage plus folder sync. The app now has FTP/FTPS, SFTP, WebDAV, Azure Blob, Google Cloud Storage, Google Drive, OneDrive, Dropbox, This device, imports, copy jobs, mirror, mount as drive, terminals, SSH tunnels and phone backup. None of these are in the README.
- The README says "folder sync … upload or download direction". The code also has **two-way** sync with conflict copies, a deletion guard and a remote trash.
- The README says "Secret keys are stored in the OS keychain". The code now keeps them in an encrypted file with only its key in the keychain (and, on Android, a Keystore-sealed file). The README's Android note ("a file in the app's private storage, excluded from backups") is only partly current.
- README: "Upload files or folders with multipart for big files" and "Folder sizes". Both are correct. The README does not mention verify-after-copy, speed limits, Wi-Fi only, resume after restart, or streaming folder downloads.
- `src-tauri/src/storage/BACKENDS.md` is the most accurate description of the server and blob backends. `src-tauri/src/mount/NATIVE.md` describes planned Windows and macOS native drives. The mention of Windows mount in that file is a plan, not working code.
- Box appears in code as a kind name and badge but is not implemented.
- No master password, app lock on computers, or in-app encryption key exists in the client. App lock is phones only. Kybl Storage's encryption at rest is a server property.
- The Activity panel has five tabs (In progress, Failed, Done, Log, Jobs). The README only mentions "Transfer queue with speed, ETA, cancel and retry".
### From the app shell side
- README statements about updates (one-click on macOS, Windows, AppImage; others open the download) and phone behaviour (Android foreground service, iOS background task, download locations, deep-link sign-in, Custom Tab and ASWebAuthenticationSession) match the code.
- Not backed by code: any release channel or beta feature (none exists); window size persistence (none); desktop app lock (none).
- `tauri.conf.json` still has a generic "bundle.targets: all" (so Linux packages are all produced by the CI build), and the CI builds macOS arm64 and x86_64, Linux, Windows, Android APK and an unsigned iOS IPA.
