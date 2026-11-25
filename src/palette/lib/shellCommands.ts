/**
 * The app's own commands in the palette: the menu bar's and the keyboard's, run through the same
 * route (so they behave exactly as from the menu), plus a few that only had a button (views,
 * sorting, synchronized browsing, workspaces by name, Settings pages). Built when the palette
 * opens, so `disabled` says why one can't run on what is on screen now.
 */
import type { SortKey } from "../../browser/components/list/FileTable";
import { TILE_MAX, TILE_MIN } from "../../browser/components/Toolbar";
import type { PaletteCommand } from "./commands";
import type { PaletteHost } from "../types";

export function shellCommands(h: PaletteHost): PaletteCommand[] {
  const a = h.active;
  const noFolder = a.bucket == null ? "Open a folder first" : null;
  const picked = a.sel.selectedEntries.length;
  const noSel = noFolder ?? (picked ? null : "Select something first");
  // panes on screen (terminals too) for closing, sizing and focusing; file panes for file-to-file commands
  const onePane = h.paneCount > 1 ? null : "Only one pane is open";
  const oneFilePane = h.panes.length > 1 ? null : "Needs a second file pane";
  const onDisk = !!a.caps?.localPaths;
  const workspaces = h.workspaces.length;
  /** a menu command, by its route id */
  const r = (id: string, title: string, more: Omit<PaletteCommand, "id" | "title" | "run"> = {}): PaletteCommand => ({
    id: `app:${id}`,
    title,
    run: () => void h.route(id),
    ...more,
  });
  const sortBy = (key: SortKey, label: string): PaletteCommand => ({
    id: `app:sort-${key}`,
    title: `Sort by ${label}`,
    group: "View",
    icon: "sort",
    keywords: a.sort.key === key ? "current" : undefined,
    disabled: noFolder,
    run: () => a.setSort({ key, dir: key === "name" ? "asc" : "desc" }),
  });

  return [
    // ---- files
    r("new-folder", "New Folder", { group: "File", icon: "folder-plus", shortcut: "⇧⌘N", disabled: noFolder }),
    r("new-file", "New File", { group: "File", icon: "file-plus", shortcut: "⌥⌘N", disabled: noFolder }),
    r("upload-files", "Upload Files…", { group: "File", icon: "upload", shortcut: "⌘U", disabled: noFolder }),
    r("upload-folder", "Upload Folder…", { group: "File", icon: "upload", shortcut: "⇧⌘U", disabled: noFolder }),
    r("download", "Download", { group: "File", icon: "download", shortcut: "⇧⌘D", disabled: noSel }),
    r("open", "Open", { group: "File", icon: "external", shortcut: "⌘O", disabled: noSel }),
    r("quick-look", "Quick Look", { group: "File", icon: "eye", shortcut: "Space", keywords: "preview", disabled: noSel }),
    r("get-info", "Get Info", { group: "File", icon: "info", shortcut: "⌘I", keywords: "properties details", disabled: noFolder }),
    r("rename", "Rename…", { group: "File", icon: "edit", shortcut: "F2", disabled: noSel }),
    r("duplicate", "Duplicate", { group: "File", icon: "copy", shortcut: "⌘D", disabled: noSel }),
    r("copy", "Copy", { group: "File", icon: "copy", shortcut: "⌘C", disabled: noSel }),
    r("cut", "Cut", { group: "File", shortcut: "⌘X", disabled: noSel }),
    r("paste", "Paste", { group: "File", shortcut: "⌘V", disabled: noFolder }),
    r("delete", "Delete…", { group: "File", icon: "trash", shortcut: "⌘⌫", keywords: "remove trash", disabled: noSel }),
    r("select-all", "Select All", { group: "File", shortcut: "⌘A", disabled: noFolder }),
    { id: "app:undo", title: "Undo", group: "File", shortcut: "⌘Z", keywords: "revert", run: h.undo },
    // ---- help (opens the website or GitHub in the browser)
    r("help", "Kybl Manual", { group: "Help", icon: "book", shortcut: "F1", keywords: "help docs documentation guide how" }),
    r("keyboard-shortcuts", "Keyboard Shortcuts", { group: "Help", icon: "info", keywords: "keys hotkeys help" }),
    r("whats-new", "What’s New in Kybl", { group: "Help", icon: "bell", keywords: "release notes changelog version" }),
    r("report-problem", "Report a Problem…", { group: "Help", icon: "external", keywords: "bug issue feedback github" }),
    r("new-connection", "New Connection…", { group: "Connections", icon: "plus", keywords: "add server sftp ftp s3 webdav" }),
    { id: "app:import-connections", title: "Import Connections…", group: "Connections", icon: "download", keywords: "filezilla transmit cyberduck", run: h.importConnections },
    r("filter-connections", "Find Connection in Sidebar", { group: "Connections", icon: "search", shortcut: "⌥⌘F" }),

    // ---- view
    r("refresh", "Refresh", { group: "View", icon: "refresh", shortcut: "⌘R", keywords: "reload", disabled: noFolder }),
    r("search", "Search This Folder", { group: "View", icon: "search", shortcut: "⌘F", keywords: "find filter", disabled: noFolder }),
    r("toggle-hidden", a.showHidden ? "Hide Hidden Files" : "Show Hidden Files", {
      group: "View",
      icon: a.showHidden ? "eye-off" : "eye",
      shortcut: "⇧⌘.",
      keywords: "dotfiles toggle",
      disabled: noFolder ?? (onDisk ? null : "Only for folders on this computer"),
    }),
    r("toggle-sidebar", h.settings.sidebarHidden ? "Show Sidebar" : "Hide Sidebar", { group: "View", icon: "sidebar", shortcut: "⌥⌘S", keywords: "toggle" }),
    { id: "app:view-list", title: "View as List", group: "View", icon: "list", keywords: a.view === "list" ? "current" : "details", disabled: noFolder, run: () => a.setView("list") },
    { id: "app:view-grid", title: "View as Icons", group: "View", icon: "grid", keywords: a.view === "grid" ? "current grid" : "grid thumbnails", disabled: noFolder, run: () => a.setView("grid") },
    sortBy("name", "Name"),
    sortBy("modified", "Date Modified"),
    sortBy("size", "Size"),
    sortBy("kind", "Kind"),
    { id: "app:sort-reverse", title: "Reverse Sort Order", group: "View", icon: "sort", keywords: "ascending descending", disabled: noFolder, run: () => a.setSort({ ...a.sort, dir: a.sort.dir === "asc" ? "desc" : "asc" }) },
    // run here, not through the route: from the palette they're meant for the file pane, never
    // handed back to a terminal that had the keyboard (as the menu's ⌘+ / ⌘− are)
    { id: "app:tiles-bigger", title: "Bigger Icons", group: "View", shortcut: "⌘+", disabled: a.view === "grid" ? (noFolder ?? (a.tile >= TILE_MAX ? "Already the biggest" : null)) : "Only in icon view", run: () => a.setTile(Math.min(TILE_MAX, a.tile + 24)) },
    { id: "app:tiles-smaller", title: "Smaller Icons", group: "View", shortcut: "⌘−", disabled: a.view === "grid" ? (noFolder ?? (a.tile <= TILE_MIN ? "Already the smallest" : null)) : "Only in icon view", run: () => a.setTile(Math.max(TILE_MIN, a.tile - 24)) },
    r("toggle-compact", a.compact ? "Roomy Layout" : "Compact Layout", { group: "View", icon: "density", keywords: "density rows" }),
    { id: "app:activity", title: "Show Activity", group: "View", icon: "transfers", keywords: "transfers uploads downloads jobs progress", run: h.showActivity },

    // ---- go
    r("back", "Back", { group: "Go", icon: "arrow-left", shortcut: "⌘[", disabled: a.history.canBack ? null : "Nothing to go back to" }),
    r("forward", "Forward", { group: "Go", icon: "arrow-right", shortcut: "⌘]", disabled: a.history.canForward ? null : "Nothing to go forward to" }),
    r("go-up", "Enclosing Folder", { group: "Go", icon: "arrow-up", shortcut: "⌘↑", keywords: "parent up", disabled: noFolder ?? (a.canUp ? null : "Already at the top") }),
    r("go-to", "Go to Folder…", { group: "Go", icon: "folder", shortcut: "⇧⌘G", keywords: "path", disabled: noFolder }),

    // ---- panes
    r("split-right", "Split Right", { group: "Panes", icon: "dual-pane", shortcut: "⌘\\", keywords: "pane new", disabled: h.splitRefusal("row") }),
    r("split-down", "Split Down", { group: "Panes", icon: "split-down", shortcut: "⇧⌘\\", keywords: "pane new", disabled: h.splitRefusal("col") }),
    r("close-pane", "Close Pane", { group: "Panes", icon: "x", shortcut: "⌘W", disabled: onePane }),
    { id: "app:close-other-panes", title: "Close Other Panes", group: "Panes", disabled: onePane, run: h.closeOtherPanes },
    { id: "app:equalize-panes", title: "Make Panes the Same Size", group: "Panes", icon: "columns", keywords: "equalize", disabled: onePane, run: h.equalizePanes },
    r("switch-pane", "Switch Pane", { group: "Panes", shortcut: "Tab", disabled: oneFilePane }),
    r("swap-panes", "Swap Panes", { group: "Panes", icon: "swap", shortcut: "⇧⌘S", disabled: oneFilePane }),
    r("same-folder", "Same Folder in Other Pane", { group: "Panes", disabled: oneFilePane ?? noFolder }),
    r("compare-folders", "Compare Folders", { group: "Panes", icon: "compare", keywords: "diff", disabled: oneFilePane ?? noFolder }),
    r("pane-copy", "Copy To…", { group: "File", icon: "copy", shortcut: "F5", disabled: noSel }),
    r("pane-move", "Move To…", { group: "File", icon: "move", shortcut: "F6", disabled: noSel }),
    ...h.syncPartners.map(
      (s): PaletteCommand => ({
        id: `app:sync-${s.id}`,
        title: `${s.on ? "Stop Synchronized Browsing" : "Synchronize Browsing"} with ${s.name}`,
        group: "Panes",
        icon: "link",
        keywords: "sync browsing link follow",
        run: () => h.toggleSync(s.id),
      }),
    ),
    ...(["left", "right", "up", "down"] as const).map((d) =>
      r(`focus-${d}`, `Focus Pane ${d[0].toUpperCase()}${d.slice(1)}`, { group: "Panes", icon: `arrow-${d}`, shortcut: `⌥⌘${{ left: "←", right: "→", up: "↑", down: "↓" }[d]}`, disabled: onePane }),
    ),

    // ---- workspaces
    r("new-workspace", "New Workspace", { group: "Workspaces", icon: "plus", shortcut: "⌘T", keywords: "tab" }),
    ...h.workspaces.map(
      (w, i): PaletteCommand => ({
        id: `app:workspace:${w.id}`,
        title: `Switch to Workspace “${w.name}”`,
        group: "Workspaces",
        icon: "panel",
        shortcut: i < 8 ? `⌥⌘${i + 1}` : undefined,
        keywords: "tab",
        disabled: w.active ? "It’s the workspace on screen" : null,
        run: () => h.switchWorkspace(w.id),
      }),
    ),
    r("next-workspace", "Next Workspace", { group: "Workspaces", shortcut: "⌃Tab", disabled: workspaces > 1 ? null : "Only one workspace" }),
    r("prev-workspace", "Previous Workspace", { group: "Workspaces", shortcut: "⌃⇧Tab", disabled: workspaces > 1 ? null : "Only one workspace" }),
    r("rename-workspace", "Rename Workspace…", { group: "Workspaces", icon: "edit" }),
    r("workspace-settings", "Workspace Settings…", { group: "Workspaces", icon: "settings" }),
    r("move-workspace-left", "Move Workspace Left", { group: "Workspaces", shortcut: "⌥⇧⌘[", disabled: workspaces > 1 ? null : "Only one workspace" }),
    r("move-workspace-right", "Move Workspace Right", { group: "Workspaces", shortcut: "⌥⇧⌘]", disabled: workspaces > 1 ? null : "Only one workspace" }),
    r("close-workspace", "Close Workspace", { group: "Workspaces", icon: "x", disabled: workspaces > 1 ? null : "Only one workspace" }),

    // ---- app
    { id: "app:settings", title: "Settings…", group: "Kybl", icon: "settings", shortcut: "⌘,", keywords: "preferences options", run: () => h.openSettings() },
    ...(
      [
        ["appearance", "Appearance", "theme dark light accent font"],
        ["browsing", "Browsing", "folders first double click"],
        ["transfers", "Transfers and Sharing", "concurrency bandwidth links"],
        ["sync", "Folder Sync", "mirror backup"],
        ["drives", "Drives", "mount finder"],
        ["connections", "Connections", "profiles"],
        ["storage", "Cache and Data", "thumbnails clear"],
        ["shortcuts", "Keyboard Shortcuts", "keys hotkeys help"],
      ] as const
    ).map(([page, label, keywords]): PaletteCommand => ({ id: `app:settings-${page}`, title: `Settings: ${label}`, group: "Kybl", icon: "settings", keywords, run: () => h.openSettings(page) })),
    ...(["system", "light", "dark"] as const).map(
      (t): PaletteCommand => ({
        id: `app:theme-${t}`,
        title: `Theme: ${t[0].toUpperCase()}${t.slice(1)}`,
        group: "Kybl",
        icon: "eye",
        keywords: "appearance mode",
        disabled: h.settings.theme === t ? "Already in use" : null,
        run: () => h.updateSettings({ theme: t }),
      }),
    ),
  ];
}
