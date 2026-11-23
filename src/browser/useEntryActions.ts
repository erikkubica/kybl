/**
 * The actions of one pane as menus and commands: the context menus of items and of empty
 * space, the toolbar's "…" menu, share links, Move to…, Go to folder, favorites, and the command
 * ids the keyboard and the menu bar run (see desktop/useShortcuts).
 */
import { asExport } from "../connections/native";
import { createElement } from "react";
import { api, errMessage } from "../api";
import { peekSyncMappings, reloadSync, syncApi, type SyncMapping } from "../sync";
import { deviceName } from "../jobs/LocationPicker";
import { baseName, parentPrefix } from "../format";
import { destLabel, entryParent } from "../moving";
import { expiryLabel, type Favorite } from "../settings";
import { tidyMenu } from "../desktop/menus";
import { openInItems } from "../desktop/openWith";
import { parseLocation } from "../desktop/paths";
import { GoToDialog } from "../desktop/GoToDialog";
import { SyncThisFolder } from "../desktop/SyncThisFolder";
import { MountDialog } from "../mount/MountDialog";
import { driveItems } from "../mount/driveMenu";
import { findMount, useMounts } from "../mount/useMounts";
import { MoveDialog } from "../components/MoveDialog";
import type { MenuItem } from "../components/Dialogs";
import type { Entry } from "../types";
import { itemClipboard } from "../desktop/clipboard";
import { actionCommandMap, actionsMenu, type ActionContext } from "../actions/customActions";
import type { PaneCore, PaneEnv } from "./usePane";

/** localStorage: the first "Keep on this device" explained what two-way sync means */
const KEEP_EXPLAINED = "kybl.keepExplained";

export function useEntryActions(pane: PaneCore, env: PaneEnv) {
  const { profile, bucket, prefix, ent, sel, ops, relBase } = pane;
  const { search, entries } = ent;
  const { selected, selectedEntries } = sel;
  const { settings, dialogs, conns } = env;
  const { toast } = dialogs;
  // what this connection can do: actions it can't take stay out of the menus
  const { caps } = pane;
  // drives: a folder that is one offers Show in Finder / Eject instead of "Mount as drive…"
  const { mounts } = useMounts();
  const canShare = caps?.share !== "none";
  const isS3 = !profile?.kind || profile.kind === "s3";
  /** this computer's own disk: no folder sync (it is the local side), hidden files to toggle */
  const onDisk = !!caps?.localPaths;
  const toggleHidden = () => {
    if (!onDisk) return;
    // this pane only: the other one keeps showing (or hiding) them
    const show = !pane.showHidden;
    pane.setShowHidden(show);
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
    const pid = profile.id;
    const roots = conns.bucketsBy[pid]?.names ?? [bucket];
    // one picker for every destination: a tree of all connections, opened at this folder; folders
    // this connection reaches are copied or moved on the spot, anywhere else becomes a job
    if (env.openMigration) {
      env.openMigration(
        { profileId: pid, root: bucket, items: list.map((e) => ({ path: e.key, isDir: e.kind === "folder", size: e.kind === "folder" ? undefined : e.size })) },
        mode,
        { profileId: pid, root: bucket, dir: startPrefix },
        { roots: roots.includes(bucket) ? roots : [...roots, bucket], run: (dest, m) => ops.relocate(list, dest.dir, m, { destBucket: dest.root }) },
      );
      return;
    }
    dialogs.show((close) =>
      createElement(MoveDialog, {
        profileId: pid,
        bucket,
        buckets: conns.bucketsBy[pid]?.names,
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
    // "" is a real root: a server's (or a single container's) one root
    if (!loc || b == null) return;
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
    // the pane's own path bar turns into a text field; the dialog only when it isn't on screen
    const bar = pane.searchInput.current?.closest(".chrome")?.querySelector(".crumbs.can-edit");
    if (bar) {
      bar.dispatchEvent(new Event("kybl-edit-path"));
      return;
    }
    dialogs.show((close) => createElement(GoToDialog, { bucket, prefix, onGo: goToPath, onClose: close }));
  };
  /** "Keep on this device": a two-way synced copy in ~/Kybl/…, opened in Finder when ready */
  const keepOffline = async (pre: string) => {
    if (!profile || bucket == null) return;
    const name = destLabel(pre, bucket, profile.id);
    const show = (m: SyncMapping) => ({ label: "Show", run: () => void api.revealLocal(m.localPath).catch(() => {}) });
    const kept = keptMapping(pre);
    if (kept) return void toast("info", `Already kept on this device: “${name}”.`, show(kept));
    try {
      const m = await syncApi.keepOffline(profile.id, bucket, pre);
      void reloadSync();
      // the first time, say what two-way means (deleting on this device deletes online too)
      let first = false;
      try {
        first = !localStorage.getItem(KEEP_EXPLAINED);
        localStorage.setItem(KEEP_EXPLAINED, "1");
      } catch {
        /* storage off: say it every time */
        first = true;
      }
      toast(
        "success",
        `Keeping “${name}” on this device. ` + (first ? "Changes sync both ways: deleting it here deletes it online too." : "The first sync starts in a moment."),
        show(m),
      );
    } catch (err) {
      toast("error", errMessage(err));
    }
  };
  /** The two-way mapping that keeps this folder of the bucket on screen on this device, if any. */
  const keptMapping = (pre: string) =>
    profile && bucket != null ? peekSyncMappings().find((m) => m.direction === "twoway" && m.profileId === profile.id && m.bucket === bucket && m.prefix === pre) : undefined;
  /** "Kept on this device" (ticked) stops keeping it, after asking; the copy on disk stays. */
  const stopKeeping = async (m: SyncMapping, pre: string) => {
    if (!profile || bucket == null) return;
    const name = destLabel(pre, bucket, profile.id);
    const device = deviceName().replace(/^This /, "this ");
    const ok = await dialogs.confirm({
      title: `Stop keeping “${name}” on this device?`,
      label: "Stop keeping",
      message: createElement("p", null, `The copy on ${device} stays; it just stops syncing.`),
    });
    if (!ok) return;
    try {
      await syncApi.remove(m.id);
      await reloadSync();
      toast("success", `“${name}” is no longer kept on this device.`, { label: "Show", run: () => void api.revealLocal(m.localPath).catch(() => {}) });
    } catch (err) {
      toast("error", errMessage(err));
    }
  };
  const keepItem = (pre: string): MenuItem => {
    const kept = keptMapping(pre);
    return kept
      ? { type: "item", label: "Kept on this device", icon: "download", checked: true, onClick: () => void stopKeeping(kept, pre) }
      : { type: "item", label: "Keep on this device", icon: "download", onClick: () => void keepOffline(pre) };
  };

  /** "Mount as drive…": the folder (or the whole bucket) in Finder through a local WebDAV drive */
  const askMount = (pre: string) => {
    if (!profile || bucket == null) return;
    const [p, b] = [profile, bucket];
    dialogs.show((close) => createElement(MountDialog, { profileId: p.id, connection: p.name, bucket: b, prefix: pre, onClose: close, onToast: (k, t) => toast(k, t), onOpenSettings: env.openDriveSettings }));
  };

  /** "Mount as drive…" for a folder, or once it's a drive: Show in Finder, Eject */
  const driveFor = (pre: string): MenuItem[] =>
    !profile || bucket == null
      ? []
      : driveItems(findMount(mounts, profile.id, bucket, pre), { ask: () => askMount(pre), toast: (k, t) => toast(k, t), openSettings: env.openDriveSettings });

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

  // custom actions (Settings → Actions): "Actions ▸" and their shortcuts
  const actionCtx: ActionContext = {
    profile,
    bucket,
    prefix,
    onDisk,
    dialogs,
    transfers: env.transfers,
    jobs: env.jobs,
    refresh: ent.refresh,
    selection: () => sel.selectedEntries,
  };

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
          !onDisk && { type: "item", label: "Sync this folder…", icon: "sync", onClick: () => askSync(prefix) },
          !onDisk && keepItem(prefix),
          ...(onDisk ? [] : driveFor(prefix)),
          !!env.openMigration && { type: "item", label: prefix ? "Copy this folder to another connection…" : "Copy everything to another connection…", icon: "copy", onClick: migrateHere },
          isS3 && { type: "item", label: "Copy S3 URI", icon: "copy", onClick: () => copyText(`s3://${bucket}/${prefix}`, "S3 URI") },
          onDisk && { type: "item", label: "Show hidden files", icon: "eye", hint: "⇧⌘.", checked: pane.showHidden, onClick: toggleHidden },
          ...(env.extraPlaceItems?.() ?? []),
        ];

  const selectAll = () => sel.setSelected(new Set(entries.map((e) => e.key)));
  /** one item: the plain rename; several: the Batch rename dialog, counting in the list's order */
  const rename = (list: Entry[]) => (list.length === 1 ? ops.askRename(list[0]) : list.length > 1 && ops.askBatchRename(list, entries, ent.allEntries));

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
        { type: "sep" },
        ...(env.splitItems?.() ?? []),
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
      one && e.kind === "file" && env.canOpenDocument?.(e) && { type: "item", label: "Open in default app", icon: "external", onClick: () => void ops.openInApp(e) },
      one && e.kind === "file" && { type: "item", label: "Quick Look", icon: "eye", hint: "Space", onClick: () => pane.setQuick(e.key) },
      { type: "item", label: "Get Info", icon: "info", hint: "⌘I", onClick: () => pane.getInfo(e) },
      search && one && { type: "item", label: "Show in folder", icon: "folder", onClick: () => pane.navigate(entryParent(e), e.key) },
      // Show in Finder, Open with ▸ (desktop/openWith.ts)
      ...(one ? openInItems({ profileId: profile.id, bucket, onDisk, ops, toast }, e) : []),
      ...actionsMenu(actionCtx, list),
      // this computer's own files aren't downloaded: Copy, Move and F5/F6 put them elsewhere
      !onDisk && { type: "item", label: one && e.native?.exports.length ? `Download as ${e.native.exports[0].label}` : "Download", icon: "download", hint: "⇧⌘D", onClick: () => ops.downloadEntries(list, relBase) },
      // a Google Doc / Sheet / Slides: its other formats (PDF…)
      ...(one ? (e.native?.exports.slice(1) ?? []) : []).map((x) => ({ type: "item" as const, label: `Download as ${x.label}`, icon: "download" as const, onClick: () => ops.downloadEntries([asExport(e, x.ext) ?? e], relBase) })),
      canShare && { type: "item", label: `Copy share link (${expiryLabel(settings.linkExpiry)})`, icon: "link", disabled: !(one && e.kind === "file"), onClick: () => copyLink(e, settings.linkExpiry) },
      isS3 && { type: "item", label: "Copy S3 URI", icon: "copy", disabled: !one, onClick: () => copyText(`s3://${bucket}/${e.key}`, "S3 URI") },
      { type: "sep" },
      { type: "item", label: "Copy", icon: "copy", hint: "⌘C", onClick: () => ops.clip(list, "copy") },
      { type: "item", label: "Cut", icon: "move", hint: "⌘X", onClick: () => ops.clip(list, "cut") },
      { type: "item", label: "Duplicate", icon: "copy", hint: "⌘D", onClick: () => void ops.duplicate(list) },
      folder && clip && { type: "item", label: `Paste into “${e.name}”`, icon: "copy", onClick: () => ops.paste(e.key) },
      // dual pane: to the other pane's folder (F5 / F6)
      ...(env.extraItemItems?.(list) ?? []),
      // one picker for any folder: this connection's (any bucket or drive), or another connection
      { type: "item", label: "Copy or move to…", icon: "move", onClick: () => askMove(list, "copy") },
      !!prefix && !search && {
        type: "item",
        label: `Move to “${destLabel(parentPrefix(prefix), bucket, profile.id)}”`,
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
      folder && !onDisk && keepItem(e.key),
      ...(folder && !onDisk ? driveFor(e.key) : []),
      { type: "sep" },
      { type: "item", label: one ? "Rename…" : `Rename ${list.length} items…`, icon: "edit", hint: "F2", onClick: () => rename(list) },
      { type: "item", label: list.length > 1 ? `Delete ${list.length} items…` : "Delete…", icon: "trash", hint: "⌘⌫", danger: true, onClick: () => ops.askDelete(list) },
    ]);
    dialogs.menu(ev.clientX, ev.clientY, items);
  };

  /** The toolbar's "…": `lead` is what the toolbar puts first (refresh, the other pane's items). */
  const onMoreMenu = (x: number, y: number, lead: (MenuItem | false)[] = []) =>
    dialogs.menu(x, y, tidyMenu([...lead, { type: "sep" }, ...placeItems(), { type: "sep" }, { type: "item", label: "Show activity", icon: "transfers", onClick: env.showActivityPanel }]));

  const focusSearch = () => {
    pane.searchInput.current?.focus();
    pane.searchInput.current?.select();
  };

  /** This pane's part of the commands the keyboard and the menu bar run, by menu id. */
  const commands: Record<string, () => void> = {
    "new-folder": () => ops.askNewFolder(),
    "upload-files": () => void ops.pickAndUpload(false),
    "upload-folder": () => void ops.pickAndUpload(true),
    download: () =>
      onDisk ? toast("info", "These files are already on this computer. Copy (⌘C) or Copy or move to… puts them somewhere else.") : void ops.downloadEntries(selectedEntries, relBase),
    refresh: ent.refresh,
    "go-up": () => void pane.goUp(),
    back: () => pane.historyStep(-1),
    forward: () => pane.historyStep(1),
    "go-to": () => bucket != null && askGoTo(),
    search: focusSearch,
    "select-all": selectAll,
    delete: () => selectedEntries.length && ops.askDelete(selectedEntries),
    rename: () => rename(selectedEntries),
    open: () => openSelection(),
    "quick-look": pane.quickLook,
    "get-info": () => pane.getInfo(),
    copy: () => ops.clip(selectedEntries, "copy"),
    cut: () => ops.clip(selectedEntries, "cut"),
    duplicate: () => selectedEntries.length > 0 && void ops.duplicate(selectedEntries),
    paste: () => ops.paste(),
    deselect: () => sel.setSelected(new Set()),
    "toggle-hidden": toggleHidden,
    ...actionCommandMap(actionCtx),
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
    goToPath,
    toggleFavorite,
    isFavorite: !!(profile && bucket != null && favoriteOf(profile.id, bucket, prefix)),
    calcSizes,
    removeFavorite,
    onContext,
    onBackgroundContext,
    onMoreMenu,
    /** custom actions' view of this pane (the palette runs them on its selection) */
    actionCtx,
  };
}

export type EntryActions = ReturnType<typeof useEntryActions>;
