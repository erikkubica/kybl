/**
 * The actions of one pane as menus and commands: the context menus of items and of empty
 * space, the toolbar's "…" menu, share links, Move to…, Go to folder, favorites, and the command
 * ids the keyboard and the menu bar run (see desktop/useShortcuts).
 */
import { asExport } from "../connections/native";
import { createElement } from "react";
import { api, errMessage } from "../api";
import { syncApi } from "../sync";
import { baseName, parentPrefix } from "../format";
import { destLabel, entryParent } from "../moving";
import { expiryLabel, type Favorite } from "../settings";
import { tidyMenu } from "../desktop/menus";
import { parseLocation } from "../desktop/paths";
import { GoToDialog } from "../desktop/GoToDialog";
import { SyncThisFolder } from "../desktop/SyncThisFolder";
import { MoveDialog } from "../components/MoveDialog";
import type { MenuItem } from "../components/Dialogs";
import type { Entry } from "../types";
import { itemClipboard } from "../desktop/clipboard";
import type { PaneCore, PaneEnv } from "./usePane";

export function useEntryActions(pane: PaneCore, env: PaneEnv) {
  const { profile, bucket, prefix, ent, sel, ops, relBase } = pane;
  const { search, entries } = ent;
  const { selected, selectedEntries } = sel;
  const { settings, dialogs, conns } = env;
  const { toast } = dialogs;
  // what this connection can do: actions it can't take stay out of the menus
  const { caps } = pane;
  const canShare = caps?.share !== "none";
  const isS3 = !profile?.kind || profile.kind === "s3";
  /** this computer's own disk: no folder sync (it is the local side), hidden files to toggle */
  const onDisk = !!caps?.localPaths;
  const toggleHidden = () => {
    if (!onDisk) return;
    const show = !settings.showHiddenFiles;
    env.updateSettings({ showHiddenFiles: show });
    toast("info", show ? "Showing hidden files" : "Hiding hidden files");
  };

  /** Enter / ⌘O / ⌘↓: a folder opens in the list; files open in their apps (a few at most). */
  const openSelection = (list: Entry[] = selectedEntries) => {
    if (list.length === 1 && list[0].kind === "folder") return pane.navigate(list[0].key);
    const files = list.filter((e) => e.kind === "file");
    // one document opens in the app's editor; several go to their own apps
    if (files.length === 1 && env.openDocument?.(files[0])) return;
    if (files.length > 10) toast("info", "Opening the first 10 files");
    for (const f of files.slice(0, 10)) void ops.openInApp(f);
  };

  const doSearch = (q: string) => {
    if (pane.here) void ent.sr.run(pane.here, q);
    sel.setSelected(new Set());
  };
  const clearSearch = () => {
    ent.sr.clear();
    ent.setQuery("");
  };

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", `${what} copied`);
    } catch {
      toast("error", "Could not access the clipboard");
    }
  };

  const copyLink = async (entry: Entry, secs: number) => {
    if (!profile || bucket == null) return;
    try {
      const url = await api.presign(profile.id, bucket, entry.key, secs);
      await navigator.clipboard.writeText(url);
      const n = secs >= 86400 ? Math.round(secs / 86400) : Math.round(secs / 3600);
      const label = `${n} ${secs >= 86400 ? "day" : "hour"}${n === 1 ? "" : "s"}`;
      toast("success", `Link copied. It expires in ${label}`);
    } catch (e) {
      toast("error", errMessage(e));
    }
  };

  const askMove = (list: Entry[], mode: "move" | "copy" = "move") => {
    if (!list.length || !profile || bucket == null) return;
    const startPrefix = search ? entryParent(list[0]) : prefix;
    dialogs.show((close) =>
      createElement(MoveDialog, {
        profileId: profile.id,
        bucket,
        buckets: conns.bucketsBy[profile.id]?.names,
        items: list,
        initialMode: mode,
        startPrefix,
        onSubmit: (dest, m, destBucket) => ops.relocate(list, dest, m, { destBucket }),
        onClose: close,
      }),
    );
  };

  /** Go to folder: a path in this bucket, `bucket/path` or an s3:// address. */
  const goToPath = async (input: string) => {
    if (!profile) return;
    const names = conns.bucketsBy[profile.id]?.names ?? [];
    const loc = parseLocation(input, names);
    const b = loc?.bucket ?? bucket;
    if (!loc || !b) return;
    if (loc.bucket != null && loc.bucket !== bucket) pane.rememberAfterListing.current = { profileId: profile.id, bucket: loc.bucket };
    let pre = loc.prefix;
    if (pre && !pre.endsWith("/")) {
      // the path of a file opens its folder with the file selected
      try {
        const r = await api.existing(profile.id, b, [pre], [`${pre}/`]);
        if (!r.prefixes.length && r.keys.length) return pane.go(profile, b, parentPrefix(pre), { selectKey: pre });
      } catch {
        /* treat it as a folder */
      }
      pre += "/";
    }
    pane.go(profile, b, pre);
  };
  const askGoTo = () => {
    if (bucket == null) return;
    dialogs.show((close) => createElement(GoToDialog, { bucket, prefix, onGo: goToPath, onClose: close }));
  };
  /** "Keep on this device": a two-way synced copy in ~/Kybl/…, opened in Finder when ready */
  const keepOffline = async (pre: string) => {
    if (!profile || bucket == null) return;
    try {
      const m = await syncApi.keepOffline(profile.id, bucket, pre);
      toast("success", `Keeping “${destLabel(pre, bucket)}” on this device. The first sync starts in a moment.`, {
        label: "Show",
        run: () => void api.revealLocal(m.localPath).catch(() => {}),
      });
    } catch (err) {
      toast("error", errMessage(err));
    }
  };

  const askSync = (pre: string) => {
    if (!profile || bucket == null) return;
    const [pid, b] = [profile.id, bucket];
    dialogs.show((close) =>
      createElement(SyncThisFolder, {
        profiles: env.profiles,
        profileId: pid,
        bucket: b,
        prefix: pre,
        onDone: () => toast("success", "Folder added. The first sync starts in a moment."),
        onClose: close,
      }),
    );
  };

  /** "Copy to another connection…": a background job to any connection or this computer. */
  const migrate = (list: Entry[], mode: "copy" | "move") => {
    if (!profile || bucket == null || !list.length || !env.openMigration) return;
    env.openMigration(
      {
        profileId: profile.id,
        root: bucket,
        items: list.map((e) => ({ path: e.key, isDir: e.kind === "folder", size: e.kind === "folder" ? undefined : e.size })),
      },
      mode,
    );
  };
  /** The folder on screen, or the whole root at its top, to another connection. */
  const migrateHere = () => {
    if (!profile || bucket == null || !env.openMigration) return;
    env.openMigration({ profileId: profile.id, root: bucket, items: [{ path: prefix, isDir: true }] }, "copy");
  };

  // ------------------------------------------------------------ favorites
  const favoriteOf = (pid: string, b: string, pre: string) => settings.favorites.find((f) => f.profileId === pid && f.bucket === b && f.prefix === pre);
  const removeFavorite = (f: Favorite) =>
    env.updateSettings({ favorites: settings.favorites.filter((x) => !(x.profileId === f.profileId && x.bucket === f.bucket && x.prefix === f.prefix)) });
  const toggleFavorite = (b: string, pre: string) => {
    if (!profile) return;
    const have = favoriteOf(profile.id, b, pre);
    if (have) {
      removeFavorite(have);
      return;
    }
    const name = pre ? baseName(pre) : (env.rootLabel?.(profile.id, b) ?? b);
    env.updateSettings({ favorites: [...settings.favorites, { profileId: profile.id, bucket: b, prefix: pre, name }] });
    toast("success", `Added “${name}” to favorites`);
  };
  const favoriteItem = (b: string, pre: string): MenuItem => ({
    type: "item",
    label: profile && favoriteOf(profile.id, b, pre) ? "Remove from favorites" : "Add to favorites",
    icon: "plus",
    onClick: () => toggleFavorite(b, pre),
  });

  // ------------------------------------------------------------ context menus
  const calcSizes = (keys: string[]) => pane.folderSizes.calc(keys);
  const clipFor = () => {
    const c = itemClipboard.get();
    return c && profile && c.profileId === profile.id ? c : null;
  };

  /** What applies to the folder on screen: from the empty-space menu and the toolbar's "…". */
  const placeItems = (): (MenuItem | false)[] =>
    !profile || bucket == null
      ? []
      : [
          { type: "item", label: "Calculate folder size", icon: "info", onClick: () => calcSizes([prefix]) },
          favoriteItem(bucket, prefix),
          !onDisk && { type: "item", label: "Sync this folder…", icon: "sync", onClick: () => askSync(prefix) },
          !onDisk && { type: "item", label: "Keep on this device", icon: "download", onClick: () => void keepOffline(prefix) },
          !!env.openMigration && { type: "item", label: prefix ? "Copy this folder to another connection…" : "Copy everything to another connection…", icon: "copy", onClick: migrateHere },
          isS3 && { type: "item", label: "Copy S3 URI", icon: "copy", onClick: () => copyText(`s3://${bucket}/${prefix}`, "S3 URI") },
          onDisk && { type: "item", label: "Show hidden files", icon: "eye", hint: "⇧⌘.", checked: settings.showHiddenFiles, onClick: toggleHidden },
          { type: "sep" },
          { type: "item", label: "Go to folder…", icon: "arrow-up", hint: "⇧⌘G", onClick: askGoTo },
          ...(env.extraPlaceItems?.() ?? []),
        ];

  const selectAll = () => sel.setSelected(new Set(entries.map((e) => e.key)));

  const onBackgroundContext = (ev: React.MouseEvent) => {
    if (!profile || bucket == null) return;
    const clip = clipFor();
    dialogs.menu(
      ev.clientX,
      ev.clientY,
      tidyMenu([
        { type: "item", label: "New folder…", icon: "folder-plus", hint: "⇧⌘N", onClick: () => ops.askNewFolder() },
        { type: "item", label: "Upload files…", icon: "upload", hint: "⌘U", onClick: () => ops.pickAndUpload(false) },
        { type: "item", label: "Upload folder…", icon: "folder", hint: "⇧⌘U", onClick: () => ops.pickAndUpload(true) },
        { type: "sep" },
        {
          type: "item",
          label: clip ? `Paste ${clip.items.length === 1 ? `“${clip.items[0].name}”` : `${clip.items.length} items`}` : "Paste",
          icon: "copy",
          hint: "⌘V",
          disabled: !clip,
          onClick: () => ops.paste(),
        },
        { type: "item", label: "Select all", icon: "check", hint: "⌘A", disabled: !entries.length, onClick: selectAll },
        { type: "item", label: search ? "Search again" : "Refresh", icon: "refresh", hint: "⌘R", onClick: ent.refresh },
        search && { type: "item", label: "Clear search", icon: "x", onClick: clearSearch },
        { type: "sep" },
        ...placeItems(),
      ]),
    );
  };

  const onContext = (ev: React.MouseEvent, e: Entry) => {
    if (!profile || bucket == null) return;
    const list = selected.has(e.key) ? selectedEntries : [e];
    if (!selected.has(e.key)) sel.selectOnly(e.key);
    const one = list.length === 1;
    const folder = one && e.kind === "folder";
    const files = list.filter((x) => x.kind === "file");
    const folders = list.filter((x) => x.kind === "folder");
    const clip = clipFor();
    const items = tidyMenu([
      folder
        ? { type: "item", label: "Open", icon: "folder", hint: "↵", onClick: () => pane.navigate(e.key) }
        : { type: "item", label: files.length > 1 ? `Open ${files.length} files` : "Open", icon: "reveal", hint: "⌘O", disabled: !files.length, onClick: () => openSelection(list) },
      one && e.kind === "file" && env.canOpenDocument?.(e) && { type: "item", label: "Open in Default App", icon: "external", onClick: () => void ops.openInApp(e) },
      one && e.kind === "file" && { type: "item", label: "Quick Look", icon: "eye", hint: "Space", onClick: () => pane.setQuick(e.key) },
      search && one && { type: "item", label: "Show in folder", icon: "folder", onClick: () => pane.navigate(entryParent(e), e.key) },
      { type: "item", label: one && e.native?.exports.length ? `Download as ${e.native.exports[0].label}` : "Download", icon: "download", hint: "⇧⌘D", onClick: () => ops.downloadEntries(list, relBase) },
      // a Google Doc / Sheet / Slides: its other formats (PDF…)
      ...(one ? (e.native?.exports.slice(1) ?? []) : []).map((x) => ({ type: "item" as const, label: `Download as ${x.label}`, icon: "download" as const, onClick: () => ops.downloadEntries([asExport(e, x.ext) ?? e], relBase) })),
      canShare && { type: "item", label: `Copy share link (${expiryLabel(settings.linkExpiry)})`, icon: "link", disabled: !(one && e.kind === "file"), onClick: () => copyLink(e, settings.linkExpiry) },
      isS3 && { type: "item", label: "Copy S3 URI", icon: "copy", disabled: !one, onClick: () => copyText(`s3://${bucket}/${e.key}`, "S3 URI") },
      { type: "sep" },
      { type: "item", label: "Copy", icon: "copy", hint: "⌘C", onClick: () => ops.clip(list, "copy") },
      { type: "item", label: "Cut", icon: "move", hint: "⌘X", onClick: () => ops.clip(list, "cut") },
      folder && clip && { type: "item", label: `Paste into “${e.name}”`, icon: "copy", onClick: () => ops.paste(e.key) },
      { type: "item", label: "Move to…", icon: "move", onClick: () => askMove(list, "move") },
      { type: "item", label: "Copy to…", icon: "copy", onClick: () => askMove(list, "copy") },
      !!env.openMigration && { type: "item", label: "Copy to another connection…", icon: "copy", onClick: () => migrate(list, "copy") },
      !!env.openMigration && { type: "item", label: "Move to another connection…", icon: "move", onClick: () => migrate(list, "move") },
      ...(env.extraItemItems?.(list) ?? []),
      !!prefix && !search && {
        type: "item",
        label: `Move to “${destLabel(parentPrefix(prefix), bucket)}”`,
        icon: "arrow-up",
        onClick: () => ops.relocate(list, parentPrefix(prefix), "move"),
      },
      { type: "sep" },
      folders.length > 0 && {
        type: "item",
        label: folders.length > 1 ? `Calculate sizes of ${folders.length} folders` : "Calculate size",
        icon: "info",
        onClick: () => calcSizes(folders.map((f) => f.key)),
      },
      folder && favoriteItem(bucket, e.key),
      folder && !onDisk && { type: "item", label: "Sync this folder…", icon: "sync", onClick: () => askSync(e.key) },
      folder && !onDisk && { type: "item", label: "Keep on this device", icon: "download", onClick: () => void keepOffline(e.key) },
      { type: "sep" },
      { type: "item", label: "Rename…", icon: "edit", disabled: !one, onClick: () => ops.askRename(e) },
      { type: "item", label: list.length > 1 ? `Delete ${list.length} items…` : "Delete…", icon: "trash", hint: "⌘⌫", danger: true, onClick: () => ops.askDelete(list) },
    ]);
    dialogs.menu(ev.clientX, ev.clientY, items);
  };

  const onMoreMenu = (x: number, y: number) =>
    dialogs.menu(x, y, tidyMenu([...placeItems(), { type: "sep" }, { type: "item", label: "Show activity", icon: "transfers", onClick: env.showActivityPanel }]));

  const onUploadMenu = (x: number, y: number) =>
    dialogs.menu(x, y, [
      { type: "item", label: "Files…", icon: "file", hint: "⌘U", onClick: () => ops.pickAndUpload(false) },
      { type: "item", label: "Folder…", icon: "folder", hint: "⇧⌘U", onClick: () => ops.pickAndUpload(true) },
    ]);

  const focusSearch = () => {
    pane.searchInput.current?.focus();
    pane.searchInput.current?.select();
  };

  /** This pane's part of the commands the keyboard and the menu bar run, by menu id. */
  const commands: Record<string, () => void> = {
    "new-folder": () => ops.askNewFolder(),
    "upload-files": () => void ops.pickAndUpload(false),
    "upload-folder": () => void ops.pickAndUpload(true),
    download: () => void ops.downloadEntries(selectedEntries, relBase),
    refresh: ent.refresh,
    "go-up": () => void pane.goUp(),
    back: () => pane.historyStep(-1),
    forward: () => pane.historyStep(1),
    "go-to": () => bucket != null && askGoTo(),
    search: focusSearch,
    "select-all": selectAll,
    delete: () => selectedEntries.length && ops.askDelete(selectedEntries),
    rename: () => selectedEntries.length === 1 && ops.askRename(selectedEntries[0]),
    open: () => openSelection(),
    "quick-look": pane.quickLook,
    copy: () => ops.clip(selectedEntries, "copy"),
    cut: () => ops.clip(selectedEntries, "cut"),
    paste: () => ops.paste(),
    deselect: () => sel.setSelected(new Set()),
    "toggle-hidden": toggleHidden,
  };

  return {
    commands,
    openSelection,
    doSearch,
    clearSearch,
    copyText,
    copyLink,
    canShare,
    askMove,
    migrate,
    askGoTo,
    calcSizes,
    removeFavorite,
    onContext,
    onBackgroundContext,
    onMoreMenu,
    onUploadMenu,
  };
}

export type EntryActions = ReturnType<typeof useEntryActions>;
