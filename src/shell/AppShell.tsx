/**
 * The desktop app around the browser panes: the sidebar of connections and favorites, the
 * Activity panel, Settings, connection dialogs and the update banner. It owns the panes (one, or
 * several in a layout of splits) and routes the sidebar, the keyboard and the menu bar to the
 * active one.
 */
import { MountDialog } from "../mount/MountDialog";
import { driveItems } from "../mount/driveMenu";
import { findMount, useMounts } from "../mount/useMounts";
import type { MountInfo } from "../api";
import { tidyMenu } from "../desktop/menus";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { baseName } from "../format";
import { useTransfers } from "../useTransfers";
import { useJobs } from "../useJobs";
import { getJobs, migrations as migrationStore } from "../jobs";
import { Sidebar, SidebarRail } from "../components/Sidebar";
import { TILE_MAX, TILE_MIN } from "../components/Toolbar";
import { TransferPanel, type ActivityTab } from "../components/TransferPanel";
import { ConnectionDialog } from "../components/ConnectionDialog";
import { KyblConnectDialog } from "../components/KyblConnectDialog";
import { ImportDialog } from "../connections/ImportDialog";
import { SettingsPage, type SettingsPageId } from "../components/SettingsPage";
import { UpdateBanner } from "../components/UpdateBanner";
import { KYBL } from "../kybl";
import { useSyncOverall } from "../sync";
import { useUpdates } from "../updates";
import { applySettings, loadSettings, saveSettings, type Favorite, type Settings } from "../settings";
import { undoStack } from "../desktop/undo";
import { usePane, type Pane, type PaneEnv } from "../browser/usePane";
import { BrowserPane } from "../browser/BrowserPane";
import type { EmptyActions } from "../browser/PaneEmpty";
import { PANE_IDS, THIS_MAC, type PaneId } from "../browser/types";
import { forgetCaps, peekCaps } from "../useCaps";
import { sendItems } from "./crossPane";
import { clearAuthNeeded, useAuthNeeded } from "../connections/authNeeded";
import { closestLocalRoot, rootsMode } from "../connections/roots";
import { canView, LazyDocumentView, viewerFor } from "../viewers/registry";
import { asExport } from "../connections/native";
import type { DocumentHandle } from "../viewers/DocumentView";
import type { Entry } from "../types";
import type { Profile } from "../types";
import { useDialogs } from "./useDialogs";
import type { MenuItem } from "../components/Dialogs";
import { photoMenuItems } from "./photoMenu";
import { loadExpanded, useConnections } from "./useConnections";
import { PreviewAside, usePreviewLayout } from "./PreviewAside";
import { useFinderDrop } from "./useFinderDrop";
import { useShellCommands } from "./useShellCommands";
import { dualMenuItems, SplitLayout } from "./SplitLayout";
import {
  allFacing,
  closePane,
  equalize,
  freeSlot,
  leaf,
  leaves,
  loadLayout,
  loadLinks,
  MAX_PANES,
  minSize,
  relation,
  sameLink,
  saveLayout,
  saveLinks,
  setSizes,
  splitPane,
  syncedWith,
  toggleLink,
  type Dir,
  type PaneNode,
  type SyncLink,
} from "./paneLayout";
import { makeDualActions, paneName, type DualContext } from "./dualActions";
import { PaneContext } from "./PaneContext";
import { useMigrationHost } from "./useMigrationHost";
import { allGroups, groupLabel, groupOf, normalizeGroup, parentGroup, renamedOpen, renameGroup, ungroup, useOpenGroups, useRecentConnections, type GroupChanges } from "../connections/groups";

/** Gives a pane's file list keyboard focus (after a sidebar click the arrows should move in it). */
export function focusPaneList(id: PaneId) {
  document.querySelector<HTMLElement>(`[data-pane="${id}"] [data-list-focus]`)?.focus({ preventScroll: true });
}

export function AppShell() {
  const dialogs = useDialogs();
  const { toast } = dialogs;
  const conns = useConnections();
  // sign-in connections whose access ended: "Sign in again" in the sidebar
  const authNeeded = useAuthNeeded();
  // drives ("Mount as drive"): the sidebar marks mounted places, the menus offer Eject
  const { mounts } = useMounts();
  // the saved connections, then this computer's own folders
  const saved = conns.profiles;
  const profiles = useMemo(() => [...saved, THIS_MAC], [saved]);
  const [transfersOpen, setTransfersOpen] = useState(true);
  // the activity panel was opened on purpose: it stays up with a note even with nothing going on
  const [activityAsked, setActivityAsked] = useState(false);
  // the Activity panel's tab: transfers and moves, or copies between connections (Jobs)
  const [activityTab, setActivityTab] = useState<ActivityTab>("activity");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | undefined>(undefined);
  const updates = useUpdates();
  const syncState = useSyncOverall();
  const openSettings = useCallback((page?: SettingsPageId) => {
    setSettingsPage(page);
    setSettingsOpen(true);
  }, []);
  // the menu-bar icon's "Sync settings…": an event while the window exists, or a flag left by the
  // backend when it had to create the window for it
  useEffect(() => {
    const w = window as { __KYBL_OPEN_SETTINGS__?: SettingsPageId };
    if (w.__KYBL_OPEN_SETTINGS__) {
      openSettings(w.__KYBL_OPEN_SETTINGS__);
      delete w.__KYBL_OPEN_SETTINGS__;
    }
    let un: (() => void) | undefined;
    listen<SettingsPageId>("open-settings", (e) => openSettings(e.payload))
      .then((u) => (un = u))
      .catch(() => {});
    return () => un?.();
  }, [openSettings]);
  const updateSettings = useCallback(
    (patch: Partial<Settings>) =>
      setSettings((cur) => {
        const next = { ...cur, ...patch };
        saveSettings(next);
        applySettings(next);
        return next;
      }),
    [],
  );
  const sideHidden = settings.sidebarHidden;
  const toggleSidebar = useCallback(
    () =>
      setSettings((cur) => {
        const next = { ...cur, sidebarHidden: !cur.sidebarHidden };
        saveSettings(next);
        return next;
      }),
    [],
  );
  const sidePeek = useSidePeek(sideHidden, () => dialogs.isOpen());
  // the sidebar's groups folded open, and the connections opened last (both kept per device)
  const openGroups = useOpenGroups();
  const recents = useRecentConnections();
  // ⌥⌘F: the sidebar's filter field takes the keyboard (each press bumps this)
  const [findSignal, setFindSignal] = useState(0);
  // the panes on screen as a tree of splits, kept between launches (an old dual pane becomes a
  // split of two on the first launch)
  const [tree, setTree] = useState<PaneNode>(() => loadLayout(settings.layout));
  const ids = useMemo(() => leaves(tree), [tree]);
  const dual = ids.length > 1;
  useEffect(() => {
    // dragging a divider changes the tree on every mouse move: write once it settles
    const t = window.setTimeout(() => saveLayout(tree), 200);
    return () => window.clearTimeout(t);
  }, [tree]);
  // synchronized browsing: pairs of panes that follow each other, switched by the link on the
  // divider between them. Only pairs facing each other across a divider count, so what is lit on
  // screen is exactly what moves together; a link kept from another layout comes back with it.
  const [links, setLinks] = useState<SyncLink[]>(() => loadLinks(tree, settings.syncBrowsing));
  useEffect(() => saveLinks(links), [links]);
  const facing = useMemo(() => allFacing(tree), [tree]);
  const liveLinks = useMemo(() => links.filter((l) => facing.some(({ pair: [a, b] }) => sameLink(l, a, b))), [links, facing]);
  const isLinked = (a: PaneId, b: PaneId) => liveLinks.some((l) => sameLink(l, a, b));
  const toggleSync = (a: PaneId, b: PaneId) => setLinks((cur) => toggleLink(cur, a, b));
  /** a closed pane's slot opens empty next time: it lets go of its links too */
  const unlink = (gone: (id: PaneId) => boolean) => setLinks((cur) => cur.filter(([a, b]) => !gone(a) && !gone(b)));
  // the panes by when they were last active, most recent first: the first on screen is the
  // active one, the next is what "the other pane" means for it (F5 / F6, swap, compare)
  const [recent, setRecent] = useState<PaneId[]>(() => leaves(tree));
  const setActiveId = useCallback((id: PaneId) => setRecent((cur) => (cur[0] === id ? cur : [id, ...cur.filter((x) => x !== id)])), []);
  const activeId = recent.find((id) => ids.includes(id)) ?? ids[0];
  // two lists side by side leave little room: the details pane has its own switch there, off at first
  const singlePreview = usePreviewLayout("s3b.preview");
  const dualPreview = usePreviewLayout("s3b.preview.dual", false);
  const preview = dual ? dualPreview : singlePreview;

  const [connDialog, setConnDialogState] = useState<{ profile: Profile | null; reconnect?: boolean } | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** Opens the editor for a connection: Kybl Storage connections have their own (no keys to edit). */
  const setConnDialog = useCallback((d: { profile: Profile | null; reconnect?: boolean } | null) => {
    if (d?.profile?.id === THIS_MAC.id) return; // built in: nothing to edit
    if (d?.profile?.provider === KYBL) setKyblDialog({ existing: d.profile, reconnect: d.reconnect });
    else setConnDialogState(d);
  }, []);

  const onError = useCallback((m: string) => toast("error", m), [toast]);
  const showActivity = useCallback(() => setTransfersOpen(true), []);
  /** a failure toast's "Show": the Activity panel on its Failed tab */
  const showFailed = useCallback(() => {
    setActivityTab("failed");
    setTransfersOpen(true);
  }, []);
  const showActivityPanel = useCallback(() => {
    setTransfersOpen(true);
    setActivityAsked(true);
  }, []);
  const transfers = useTransfers(onError);
  const jobs = useJobs();
  /**
   * A transfer or job just started: the panel shows In progress (not the Failed, Done, Log or
   * Jobs tab it was left on), and opens if Settings say so.
   */
  const autoShowActivity = useCallback(() => {
    setActivityTab((t) => (t === "activity" ? t : "activity"));
    if (settingsRef.current.autoOpenTransfers) setTransfersOpen(true);
  }, []);
  /** The Failed tab's "Clear failed": asks first when that throws away what a retry would resume from. */
  const clearFailed = async () => {
    const { partial } = transfers.failedCounts();
    const migs = getJobs().filter((j) => j.progress.state === "failed" || j.progress.state === "needsAuth" || (j.progress.state === "done" && j.progress.filesFailed > 0));
    if (partial > 0 || migs.length > 0) {
      const ok = await dialogs.confirm({
        title: "Clear failed items?",
        label: "Clear failed",
        message: (
          <>
            {partial > 0 && (
              <p>
                {partial === 1 ? "One upload" : `${partial.toLocaleString()} uploads`} got partway. Kybl lets go of what was sent, so trying again later starts from the beginning.
              </p>
            )}
            {migs.length > 0 && <p>Copies between connections that failed leave Jobs too. Files they already copied stay where they are.</p>}
          </>
        ),
      });
      if (!ok) return;
    }
    transfers.clearFailed();
    jobs.clearFailed();
    for (const j of migs) void migrationStore.remove(j.id).catch(() => {});
  };

  // ------------------------------------------------------------ panes
  /** the panes on screen (work that finishes reloads these) */
  const panesRef = useRef<Pane[]>([]);
  const allPanes = useRef<Pane[]>([]);
  const dualCtx = useRef<DualContext | null>(null);
  const dualPane = useMemo(() => makeDualActions(() => dualCtx.current!), []);
  /**
   * After a job in `pid`/`b` finishes, reloads every pane still showing that bucket. Work in
   * another connection or bucket carries on undisturbed in the meantime.
   */
  const reloadIfShowing = useCallback((pid: string, b: string) => {
    let hit = false;
    for (const p of panesRef.current) {
      if (p.profile?.id !== pid || p.bucket !== b) continue;
      p.ent.refresh();
      hit = true;
    }
    return hit;
  }, []);
  const clearAllSizes = useCallback(() => {
    for (const p of allPanes.current) p.folderSizes.clear();
  }, []);
  /** Opens the Activity panel on its Jobs tab (a copy between connections started or ended). */
  const showJobs = useCallback(() => {
    setActivityTab("jobs");
    setTransfersOpen(true);
    setActivityAsked(true);
  }, []);
  // copies between connections: their dialog, the quick F5 / F6 confirm, and what happens when one ends
  const migrations = useMigrationHost({ dialogs, reloadIfShowing, clearAllSizes, showJobs });

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** Favorites follow a folder that was renamed or moved, and go when it is deleted. */
  const foldersChanged = useCallback(
    (pid: string, fromBucket: string, toBucket: string, moves: { from: string; to: string | null }[]) => {
      const favs = settingsRef.current.favorites;
      let changed = false;
      const next = favs.flatMap((f) => {
        if (f.profileId !== pid || f.bucket !== fromBucket) return [f];
        const m = moves.find((x) => f.prefix.startsWith(x.from));
        if (!m) return [f];
        changed = true;
        if (m.to === null) return [];
        const prefix = m.to + f.prefix.slice(m.from.length);
        // a favorite still called by the folder's own name takes the new name
        const name = f.prefix === m.from && f.name === baseName(m.from) ? baseName(m.to) : f.name;
        return [{ ...f, bucket: toBucket, prefix, name }];
      });
      if (changed) updateSettings({ favorites: next });
    },
    [updateSettings],
  );

  // ------------------------------------------------------------ full-window editor
  // Open on a text, code, Markdown, CSV, JSON or Office file shows it here, over everything
  const [doc, setDoc] = useState<{ pane: PaneId; profileId: string; bucket: string; entry: Entry } | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const editor = useRef<DocumentHandle>(null);
  const canOpenDocument = (id: PaneId, e: Entry) => {
    const p = paneById(id);
    if (e.kind !== "file" || !p.profile || p.bucket == null) return false;
    // this computer's own files open in their own apps, where they are
    if (peekCaps(p.profile.id)?.localPaths) return false;
    // a Google Doc / Sheet / Slides opens as its Office export, read-only (DocumentView)
    const x = e.native ? asExport(e) : e;
    if (!x) return false;
    const v = viewerFor(x.name, null, x.size);
    return !!v && v.kind !== "image" && canView(x.name, x.size);
  };
  const openDocument = (id: PaneId, e: Entry) => {
    if (!canOpenDocument(id, e)) return false;
    const p = paneById(id);
    p.closeQuick();
    setDoc({ pane: id, profileId: p.profile!.id, bucket: p.bucket!, entry: e });
    return true;
  };
  const closeEditor = async () => (editor.current ? editor.current.requestClose() : true);

  const envFor = (id: PaneId): PaneEnv => ({
    id,
    storageKey: id === "left" ? "s3b.last" : `s3b.last.${id}`,
    profiles,
    conns,
    settings,
    updateSettings,
    transfers,
    jobs,
    dialogs,
    autoShowActivity,
    showActivity,
    showFailed,
    showActivityPanel,
    reloadIfShowing,
    clearAllSizes,
    foldersChanged,
    rootLabel: conns.rootLabel,
    openDocument: (e) => openDocument(id, e),
    canOpenDocument: (e) => canOpenDocument(id, e),
    openMigration: migrations.open,
    openDriveSettings: () => openSettings("drives"),
    sendItems: (ops, src, items, mode, dst, dest, onStarted) => {
      const to = profiles.find((x) => x.id === dst.profileId);
      const names = { connectionName: to?.name ?? "", rootName: conns.rootLabel(dst.profileId, dst.bucket), singleRoot: peekCaps(dst.profileId)?.roots === "single" };
      void sendItems(ops, src, items, mode, { ...dst, ...names }, dest, dualCtx.current!, onStarted);
    },
    // the empty-space menu's Split ▸ (splitItems is defined further down; this runs on a right-click)
    splitItems: () => [{ type: "submenu", label: "Split", icon: "dual-pane", items: () => splitItems(id) }],
    ...dualPane.envFor(id),
  });
  // one pane per slot, always (hooks can't come and go with the layout); a slot that isn't on
  // screen holds nothing and sits idle
  const left = usePane(envFor("left"));
  const right = usePane(envFor("right"));
  const p3 = usePane(envFor("p3"));
  const p4 = usePane(envFor("p4"));
  const p5 = usePane(envFor("p5"));
  const p6 = usePane(envFor("p6"));
  const slots = [left, right, p3, p4, p5, p6];
  const slot = (id: PaneId) => slots[PANE_IDS.indexOf(id)];
  const active = slot(activeId);
  /** The pane `id` pairs with: the one active most recently before it (with two, the other one). */
  const otherOf = (id: PaneId): PaneId | null => recent.find((x) => x !== id && ids.includes(x)) ?? ids.find((x) => x !== id) ?? null;
  const otherId = dual ? otherOf(activeId) : null;
  const other = otherId ? slot(otherId) : null;
  panesRef.current = ids.map(slot);
  allPanes.current = slots;
  // a trackpad pinch over a grid (the web view sees a wheel with Ctrl) sizes that pane's tiles
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (!e.ctrlKey || !t?.closest?.(".grid-scroll")) return;
      e.preventDefault();
      const id = t.closest<HTMLElement>("[data-pane]")?.dataset.pane;
      const p = allPanes.current.find((x) => x.id === id);
      if (p) p.setTile(Math.round(Math.min(TILE_MAX, Math.max(TILE_MIN, p.tile - e.deltaY * 2))));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);
  dualCtx.current = {
    panes: panesRef.current,
    pane: slot,
    otherOf,
    syncedWith: (id) => syncedWith(liveLinks, id),
    relation: (a, b) => relation(tree, a, b),
    activeId: active.id,
    setActive: setActiveId,
    profiles,
    settings,
    updateSettings,
    dialogs,
    transfers,
    autoShowActivity,
    focusPane: (id: PaneId) => requestAnimationFrame(() => focusPaneList(id)),
    reloadIfShowing,
    confirmMigration: migrations.confirm,
  };

  /** Sidebar clicks, favorites and new connections open here. */
  const activeRef = useRef(active);
  activeRef.current = active;
  const paneById = (id: PaneId) => allPanes.current.find((p) => p.id === id) ?? active;
  const focusListSoon = () => {
    const id = activeRef.current.id;
    requestAnimationFrame(() => focusPaneList(id));
  };

  /** Shows a connection in a pane: expands it in the sidebar and opens a bucket of it. */
  const connectIn = useCallback(
    async (id: PaneId, p: Profile, preferBucket?: string, startPrefix = "") => {
      paneById(id).showConnection(p.id);
      conns.expand(p.id);
      const names = await conns.loadBuckets(p, true);
      const pick = preferBucket != null && names.includes(preferBucket) ? preferBucket : p.bucket || names[0];
      // "" is a root too: the one root of a server connection
      if (pick != null) paneById(id).openBucket(p, pick, pick === preferBucket ? startPrefix : "");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conns.expand, conns.loadBuckets],
  );

  /** Sidebar click on a connection: folds it open or shut, without leaving what is on screen. */
  const toggleConnection = (p: Profile) => {
    if (!active.profile) {
      void connectIn(active.id, p);
      return;
    }
    const open = !conns.expanded.has(p.id);
    conns.setExpandedSaved((cur) => {
      const next = new Set(cur);
      if (open) next.add(p.id);
      else next.delete(p.id);
      return next;
    });
    if (open) void conns.loadBuckets(p);
  };

  /** A connection was deleted: drop it from the sidebar, the history and the screen. */
  const forgetProfile = (id: string) => {
    recents.forget(id);
    clearAuthNeeded(id);
    forgetCaps(id);
    conns.dropProfile(id);
    for (const p of allPanes.current) p.forgetProfile(id);
  };

  // initial load
  useEffect(() => {
    api
      .listProfiles()
      .then((list) => {
        conns.setProfiles(list);
        // the first pane on screen opens like the one pane always did; the others follow below
        const firstId = ids[0];
        const last = settings.restoreLast ? slot(firstId).savedLocation() : null;
        const all = [...list, THIS_MAC];
        // where it was last time (This Mac too); else the first saved connection
        const start = all.find((p) => p.id === last?.profileId) ?? list[0];
        if (start) void connectIn(firstId, start, last?.profileId === start.id ? last.bucket : undefined, last?.prefix ?? "");
        // the other connections left open last time list their buckets too
        for (const p of all) if (p !== start && loadExpanded().has(p.id)) void conns.loadBuckets(p);
      })
      .catch((e) => toast("error", errMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // on launch the other panes reopen where they were, or start at the first one's place (a pane
  // made by a split opens its own place and is marked here at once)
  const opened = useRef(new Set<PaneId>());
  const first = slot(ids[0]);
  useEffect(() => {
    if (!first.here || !first.profile || !profiles.length) return;
    for (const id of ids.slice(1)) {
      if (opened.current.has(id)) continue;
      opened.current.add(id);
      const p = slot(id);
      if (p.profile) continue;
      const saved = settings.restoreLast ? p.savedLocation() : null;
      const prof = saved && profiles.find((x) => x.id === saved.profileId);
      if (prof && saved) p.go(prof, saved.bucket, saved.prefix);
      else p.go(first.profile, first.here.bucket, first.here.prefix);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, first.here, first.profile, profiles, settings.restoreLast]);

  // ------------------------------------------------------------ splitting and closing panes
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const focusSoon = (id: PaneId) => requestAnimationFrame(() => requestAnimationFrame(() => focusPaneList(id)));
  /** The room the panes share now (with one pane, its list less a details panel two panes would show). */
  const paneRoom = () => {
    const box = document.querySelector<HTMLElement>(".splits");
    if (box) return { w: box.clientWidth, h: box.clientHeight };
    const one = document.querySelector<HTMLElement>(`[data-pane="${ids[0]}"]`);
    if (!one) return null;
    return { w: one.clientWidth - (dualPreview.previewOpen ? dualPreview.previewWidth : 0), h: one.clientHeight };
  };
  /** Why pane `id` can't be split that way, or null when it can: a free slot, and room for every pane after it. */
  const splitRefusal = (dir: Dir, id: PaneId): string | null => {
    const t = treeRef.current;
    const fresh = freeSlot(t);
    if (!fresh || leaves(t).length >= MAX_PANES) return `Kybl shows up to ${MAX_PANES} panes. Close one to make room.`;
    const room = paneRoom();
    const need = minSize(splitPane(t, id, dir, fresh));
    if (room && (need.w > room.w || need.h > room.h)) return "There isn’t room for another pane. Make the window bigger, or close a pane.";
    return null;
  };
  /**
   * Splits a pane: the new one opens the same place (and view) and becomes the active pane. It
   * goes right of or below the pane, or with `before` left of or above it.
   */
  const split = (dir: Dir, id: PaneId = activeId, before = false) => {
    const why = splitRefusal(dir, id);
    if (why) return toast("info", why);
    const t = treeRef.current;
    const fresh = freeSlot(t)!;
    const src = slot(id);
    const p = slot(fresh);
    opened.current.add(fresh);
    if (src.here && src.profile) p.go(src.profile, src.here.bucket, src.here.prefix);
    else p.showConnection(src.profile?.id ?? null);
    if (p.view !== src.view) p.setView(src.view);
    setTree(splitPane(t, id, dir, fresh, before));
    setActiveId(fresh);
    focusSoon(fresh);
  };
  /** Split right, down, left and up for pane `id`, each greyed out when there's no room (or no slot) for it. */
  const splitItems = (id: PaneId): MenuItem[] => {
    const can = { row: !splitRefusal("row", id), col: !splitRefusal("col", id) };
    return [
      { type: "item", label: "Right", icon: "arrow-right", hint: "⌘\\", disabled: !can.row, onClick: () => split("row", id) },
      { type: "item", label: "Down", icon: "arrow-down", hint: "⇧⌘\\", disabled: !can.col, onClick: () => split("col", id) },
      { type: "item", label: "Left", icon: "arrow-left", disabled: !can.row, onClick: () => split("row", id, true) },
      { type: "item", label: "Up", icon: "arrow-up", disabled: !can.col, onClick: () => split("col", id, true) },
    ];
  };
  /** A pane leaves the screen: its slot lets go of its place, so it is empty when used again. */
  const vacate = (id: PaneId) => {
    const p = slot(id);
    p.closeQuick();
    p.ent.setQuery("");
    p.sel.setSelected(new Set());
    p.showConnection(null);
    opened.current.delete(id);
  };
  /** Closes a pane; false when it is the only one (⌘W then closes the window, as it always did). */
  const close = (id: PaneId = activeId) => {
    const next = closePane(treeRef.current, id);
    if (!next) return false;
    vacate(id);
    setTree(next);
    unlink((x) => x === id);
    setRecent((cur) => cur.filter((x) => x !== id));
    if (id === activeId) focusSoon(recent.find((x) => x !== id && leaves(next).includes(x)) ?? leaves(next)[0]);
    return true;
  };
  const closeOthers = (id: PaneId = activeId) => {
    for (const x of ids) if (x !== id) vacate(x);
    setTree(leaf(id));
    unlink((x) => x !== id);
    setActiveId(id);
    focusSoon(id);
  };
  /** ⌥⌘ and an arrow: the nearest pane that way (in a window too small for all, the previous or next one). */
  const focusToward = (d: "left" | "right" | "up" | "down") => {
    if (!dual) return false;
    const rect = (id: PaneId) => document.querySelector(`[data-pane="${id}"]`)?.getBoundingClientRect();
    const a = rect(activeId);
    let best: PaneId | null = null;
    let bestScore = Infinity;
    for (const id of ids) {
      const r = id !== activeId && rect(id);
      if (!a || !r) continue;
      const across = d === "left" || d === "right";
      const gap = { left: a.left - r.right, right: r.left - a.right, up: a.top - r.bottom, down: r.top - a.bottom }[d];
      if (gap < -2) continue;
      const overlap = across ? Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top) : Math.min(a.right, r.right) - Math.max(a.left, r.left);
      // beside it first, then the nearest, then the one sharing the longest edge
      const score = (overlap > 0 ? 0 : 1e6) + gap * 10 - overlap;
      if (score < bestScore) (bestScore = score), (best = id);
    }
    if (!best && ids.every((id) => id === activeId || !rect(id))) {
      const i = ids.indexOf(activeId) + (d === "left" || d === "up" ? -1 : 1);
      best = ids[(i + ids.length) % ids.length];
    }
    if (!best) return true;
    setActiveId(best);
    focusSoon(best);
    return true;
  };
  /** The panes menu: split four ways, and with several panes size and close them. */
  const panesItems = (id: PaneId): MenuItem[] => [
    ...splitItems(id).map((it) => (it.type === "item" ? { ...it, label: `Split ${it.label.toLowerCase()}` } : it)),
    ...(leaves(treeRef.current).length > 1
      ? ([
          { type: "sep" },
          { type: "item", label: "Make panes the same size", onClick: () => setTree((t) => equalize(t)) },
          { type: "sep" },
          { type: "item", label: "Close pane", icon: "x", hint: "⌘W", onClick: () => void close(id) },
          { type: "item", label: "Close other panes", onClick: () => closeOthers(id) },
        ] satisfies MenuItem[])
      : []),
  ];
  const panesMenu = (id: PaneId, x: number, y: number) => dialogs.menu(x, y, panesItems(id));

  // refresh listing once all uploads have finished
  useEffect(
    () =>
      transfers.onUploadsSettled((ok, bad, where) => {
        if (bad) toast("error", `${bad} ${bad === 1 ? "upload" : "uploads"} failed`, { label: "Show", run: showFailed });
        else if (ok) toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
        if (ok) clearAllSizes();
        for (const w of where) if (reloadIfShowing(w.profileId, w.bucket)) break;
      }),
    [transfers, toast, reloadIfShowing, showFailed, clearAllSizes],
  );

  // ------------------------------------------------------------ sidebar
  const askBucketName = (p: Profile | null = active.profile, id: PaneId = active.id) => {
    if (!p) return;
    dialogs.prompt({
      title: "Open bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Open",
      run: (name) => {
        conns.rememberBucket(p, name);
        paneById(id).openBucket(p, name);
      },
    });
  };

  /** Kybl Storage: the account owns its buckets, so it can make new ones. */
  const askNewBucket = (p: Profile | null = active.profile, id: PaneId = active.id) => {
    if (!p) return;
    dialogs.prompt({
      title: "New bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Create",
      run: (raw) => {
        const name = raw.trim();
        api
          .createBucket(p.id, name)
          .then(async () => {
            await conns.loadBuckets(p, true);
            conns.setBucketHidden(p, name, false);
            paneById(id).openBucket(p, name);
            toast("success", `Created ${name}`);
          })
          .catch((e) => toast("error", errSummary(errMessage(e))));
      },
    });
  };

  const openFavorite = (f: Favorite) => {
    const p = profiles.find((x) => x.id === f.profileId);
    if (!p) {
      toast("error", "That connection no longer exists.");
      return;
    }
    conns.expand(p.id);
    void conns.loadBuckets(p);
    active.go(p, f.bucket, f.prefix);
    focusListSoon();
    // S3 lists a folder that is gone as an empty one: say so, and offer to drop the favorite
    if (f.prefix)
      api
        .existing(p.id, f.bucket, [], [f.prefix])
        .then((r) => {
          if (!r.prefixes.length) toast("error", `“${f.name}” isn’t there any more. It may have been moved or deleted.`, { label: "Remove", run: () => active.actions.removeFavorite(f) });
        })
        .catch(() => {});
  };

  const emptyFor = (id: PaneId): EmptyActions => ({
    onConnectKybl: () => setKyblDialog({ existing: null }),
    onAddConnection: () => setConnDialog({ profile: null }),
    onReconnect: (p) => setConnDialog({ profile: p, reconnect: true }),
    onNewBucket: (p) => askNewBucket(p, id),
    onOpenBucketByName: (p) => askBucketName(p, id),
    // a server's own certificate, trusted from its error: saved on the connection like any edit
    onTrustCert: async (p, fp, reopen) => {
      if (!p.net) return;
      const saved = await api.saveProfile({ ...p, net: { ...p.net, certFingerprint: fp } });
      forgetCaps(saved.id);
      conns.upsertProfile(saved);
      if (reopen) await connectIn(id, saved);
    },
  });

  // the connection in the pane in use: first in Recent, and its group folds open in the sidebar
  const activeProfile = active.profile;
  useEffect(() => {
    if (!activeProfile) return;
    recents.push(activeProfile.id);
    openGroups.reveal(groupOf(activeProfile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, activeProfile?.group]);

  /** A found or recent connection opens in the pane in use (or just takes the keyboard there, if it's already on screen). */
  const openConnection = (p: Profile) => {
    if (sideHidden) sidePeek.close();
    if (active.profile?.id !== p.id || active.bucket == null) void connectIn(active.id, p);
    // (two frames: the overlay holding the field that had the keyboard goes first)
    focusSoon(active.id);
  };
  /** ⌥⌘F: the filter field atop the sidebar (with it folded away, the sidebar comes in over the panes). */
  const findConnection = () => {
    if (sideHidden) sidePeek.show();
    setFindSignal((n) => n + 1);
  };

  /** Files connections under groups (saved at once; only the group changes). */
  const applyGroups = async (changes: GroupChanges) => {
    if (!Object.keys(changes).length) return;
    try {
      conns.setProfiles(await api.setProfileGroups(changes));
    } catch (e) {
      toast("error", `Couldn’t change the group. ${errMessage(e)}`);
    }
  };
  const moveToGroup = (p: Profile, raw: string) => {
    const g = normalizeGroup(raw);
    if (g === groupOf(p)) return;
    void applyGroups({ [p.id]: g });
    // follow it there, so it's plain where it went
    openGroups.reveal(g);
  };
  /** A connection's "Move to group" submenu: every group, the top level, or a new one. */
  const groupItems = (p: Profile): MenuItem[] => {
    const cur = groupOf(p);
    const groups = allGroups(saved);
    // the new group and the top level first: a long list of groups can't push them out of reach
    return tidyMenu([
      {
        type: "item",
        label: "New group…",
        icon: "folder-plus",
        onClick: () =>
          dialogs.prompt({
            title: "New group",
            label: `Group for ${p.name}`,
            initial: "",
            confirmLabel: "Move",
            note: "Use / for a group inside a group, like Clients/Acme.",
            run: (v) => moveToGroup(p, v),
          }),
      },
      !!cur && { type: "item", label: "No group (top level)", icon: "arrow-up", onClick: () => moveToGroup(p, "") },
      { type: "sep" },
      ...groups.map((g): MenuItem => ({ type: "item", label: groupLabel(g), icon: "folder", checked: g === cur || undefined, onClick: () => moveToGroup(p, g) })),
    ]);
  };
  /** Right-click on a group's row in the sidebar. */
  const groupMenu = (path: string, x: number, y: number) => {
    dialogs.menu(x, y, [
      {
        type: "item",
        label: "Rename group…",
        icon: "edit",
        onClick: () =>
          dialogs.prompt({
            title: "Rename group",
            label: "Group name",
            initial: path,
            confirmLabel: "Rename",
            note: "Use / to put it inside another group. A name that's already a group joins the two.",
            run: (v) => {
              const to = normalizeGroup(v);
              if (!to || to === path) return;
              if (to.startsWith(`${path}/`)) return toast("info", "A group can’t go inside itself.");
              void applyGroups(renameGroup(saved, path, to));
              openGroups.update((cur) => renamedOpen(cur, path, to));
            },
          }),
      },
      {
        type: "item",
        label: parentGroup(path) ? `Ungroup (move into ${groupLabel(parentGroup(path))})` : "Ungroup",
        icon: "arrow-up",
        onClick: () => {
          void applyGroups(ungroup(saved, path));
          openGroups.update((cur) => renamedOpen(cur, path, parentGroup(path)));
        },
      },
      { type: "sep" },
      { type: "item", label: "Collapse all groups", icon: "chevron", disabled: !openGroups.open.size, onClick: openGroups.collapseAll },
    ]);
  };

  /** "Mount as drive…" for a bucket ("" = the whole connection) */
  const askMount = (p: Profile, b: string) =>
    dialogs.show((close) => (
      <MountDialog profileId={p.id} connection={p.name} bucket={b} prefix="" onClose={close} onToast={(k, t) => toast(k, t)} onOpenSettings={() => openSettings("drives")} />
    ));
  /** A bucket's (or with "", the whole connection's) drive items: Mount as drive…, or Show in Finder / Eject once it is one. */
  const driveFor = (p: Profile, b: string) =>
    driveItems(findMount(mounts, p.id, b, ""), { ask: () => askMount(p, b), toast: (k, t) => toast(k, t), openSettings: () => openSettings("drives") });
  /** The sidebar's drive badge: the drive's own items. */
  const driveMenu = (m: MountInfo, x: number, y: number) => {
    const p = profiles.find((q) => q.id === m.profileId);
    if (p) dialogs.menu(x, y, tidyMenu(driveFor(p, m.bucket)));
  };
  /** Right-click on a connection: everything in it (its buckets shown in the sidebar) to another connection. */
  const connectionMenu = (p: Profile, x: number, y: number) => {
    const copyAll = async () => {
      const names = conns.bucketsBy[p.id]?.names?.length ? conns.bucketsBy[p.id].names : await conns.loadBuckets(p);
      const hidden = new Set(conns.hiddenBuckets[p.id] ?? []);
      const shown = names.filter((b) => !hidden.has(b));
      if (!shown.length) return toast("info", "There's nothing in this connection to copy yet.");
      if (shown.length === 1) migrations.open({ profileId: p.id, root: shown[0], items: [{ path: "", isDir: true }] }, "copy");
      else migrations.open({ profileId: p.id, root: shown[0], items: [], roots: shown.map((b) => ({ id: b, name: conns.rootLabel(p.id, b) })) }, "copy");
    };
    const own = p.id === THIS_MAC.id;
    // a server's one root has no row of its own: the connection row is the place
    const single = rootsMode(p, peekCaps(p.id)) === "single";
    dialogs.menu(x, y, tidyMenu([
      ...(authNeeded.has(p.id) ? [{ type: "item" as const, label: "Sign in again…", icon: "refresh" as const, onClick: () => setConnDialog({ profile: p, reconnect: true }) }] : []),
      single
        ? { type: "item" as const, label: "Open", icon: "folder" as const, onClick: () => (active.openBucket(p, ""), focusListSoon()) }
        : { type: "item" as const, label: conns.expanded.has(p.id) ? "Collapse" : "Expand", icon: "chevron" as const, onClick: () => toggleConnection(p) },
      // all of this computer is too much to copy in one go: its folders have their own menus
      ...(own ? [] : [{ type: "item" as const, label: "Copy everything to…", icon: "copy" as const, onClick: () => void copyAll() }]),
      ...(own ? [] : driveFor(p, "")),
      ...photoMenuItems(p, dialogs),
      // This Mac is built in, not saved: it stays where it is
      ...(own
        ? []
        : [
            { type: "sep" as const },
            { type: "submenu" as const, label: "Move to group", icon: "folder" as const, items: () => groupItems(p) },
            { type: "item" as const, label: "Edit connection…", icon: "edit" as const, onClick: () => setConnDialog({ profile: p }) },
          ]),
    ]));
  };
  /** The folded sidebar: a connection's icon lists its buckets (a server's one root just opens). */
  const railPick = async (p: Profile, x: number, y: number) => {
    if (!active.profile) return void connectIn(active.id, p);
    if (rootsMode(p, peekCaps(p.id)) === "single") {
      active.openBucket(p, "");
      return focusListSoon();
    }
    const names = await conns.loadBuckets(p);
    const hidden = new Set(conns.hiddenBuckets[p.id] ?? []);
    const shown = names.filter((b) => !hidden.has(b));
    const own = p.id === THIS_MAC.id;
    const here = active.profile?.id === p.id ? active.bucket : null;
    const note = conns.bucketsBy[p.id]?.note;
    dialogs.menu(x, y, [
      { type: "label", label: p.name },
      ...shown.map((b) => ({
        type: "item" as const,
        label: conns.rootLabel(p.id, b),
        icon: own ? ("folder" as const) : ("bucket" as const),
        checked: b === here ? true : undefined,
        onClick: () => (active.openBucket(p, b), focusListSoon()),
      })),
      ...(!shown.length ? [{ type: "item" as const, label: note ?? "No buckets yet", disabled: true, onClick: () => {} }] : []),
      ...(own ? [] : [{ type: "sep" as const }, { type: "item" as const, label: "Open bucket by name…", icon: "plus" as const, onClick: () => askBucketName(p) }]),
    ]);
  };
  /** The badge before a pane's path: every connection, each with its buckets, opened in that pane. */
  const switchMenu = (id: PaneId, x: number, y: number) => {
    const pane = paneById(id);
    const open = (p: Profile, b: string) => {
      setActiveId(id);
      pane.openBucket(p, b);
      focusSoon(id);
    };
    dialogs.menu(x, y, [
      ...profiles.map((p): MenuItem => {
        const own = p.id === THIS_MAC.id;
        const current = pane.profile?.id === p.id;
        if (rootsMode(p, peekCaps(p.id)) === "single") return { type: "item", label: p.name, checked: current || undefined, onClick: () => open(p, "") };
        return {
          type: "submenu",
          label: current ? `${p.name} ✓` : p.name,
          items: async () => {
            const names = conns.bucketsBy[p.id]?.names?.length ? conns.bucketsBy[p.id].names : await conns.loadBuckets(p).catch(() => [] as string[]);
            const hidden = new Set(conns.hiddenBuckets[p.id] ?? []);
            const shown = names.filter((b) => !hidden.has(b));
            const here = current ? pane.bucket : null;
            return [
              ...shown.map((b): MenuItem => ({ type: "item", label: conns.rootLabel(p.id, b), icon: own ? "folder" : "bucket", checked: b === here || undefined, onClick: () => open(p, b) })),
              ...(!shown.length ? [{ type: "item" as const, label: conns.bucketsBy[p.id]?.note ?? "No buckets yet", disabled: true, onClick: () => {} }] : []),
              ...(own ? [] : [{ type: "sep" as const }, { type: "item" as const, label: "Open bucket by name…", icon: "plus" as const, onClick: () => askBucketName(p, id) }]),
            ];
          },
        };
      }),
      { type: "sep" },
      { type: "item", label: "New connection…", icon: "plus", onClick: () => setConnDialog({ profile: null }) },
    ]);
  };
  /** Right-click on a bucket (or one of this computer's folders) in the sidebar. */
  const bucketMenu = (p: Profile, b: string, x: number, y: number) => {
    const hidden = (conns.hiddenBuckets[p.id] ?? []).includes(b);
    dialogs.menu(x, y, tidyMenu([
      { type: "item", label: "Open", icon: p.id === THIS_MAC.id ? "folder" : "bucket", onClick: () => (active.openBucket(p, b), focusListSoon()) },
      { type: "item", label: "Copy everything to…", icon: "copy", onClick: () => migrations.open({ profileId: p.id, root: b, items: [{ path: "", isDir: true }] }, "copy") },
      ...(p.id === THIS_MAC.id ? [] : driveFor(p, b)),
      { type: "sep" },
      { type: "item", label: hidden ? "Show in the sidebar" : "Hide from the sidebar", icon: hidden ? "eye" : "eye-off", onClick: () => conns.setBucketHidden(p, b, !hidden) },
    ]));
  };

  // ------------------------------------------------------------ commands (keyboard + menu bar)
  const undo = () => {
    const u = undoStack.pop();
    if (!u) {
      toast("info", "Nothing to undo");
      return;
    }
    toast("info", `Undoing the ${u.label}…`);
    void undoStack.runQueued(u);
  };

  /** A dialog, menu or preview is up: it owns the keyboard, and actions must not run behind it. */
  const overlayUp = () =>
    !!docRef.current ||
    dialogs.isOpen() ||
    !!(connDialog || kyblDialog || importOpen || allPanes.current.some((p) => p.quick)) ||
    !!document.querySelector(".modal-backdrop, .ctx-menu, .ql-backdrop");

  useShellCommands({
    active,
    visible: panesRef.current,
    overlayUp,
    settingsOpen,
    openSettings: () => openSettings(),
    closeSettings: () => setSettingsOpen(false),
    shell: {
      "get-info": preview.togglePreview,
      undo,
    },
    free: {
      "new-connection": () => setConnDialog({ profile: null }),
      "toggle-sidebar": toggleSidebar,
      "filter-connections": findConnection,
      // grid view: ⌘+ / ⌘− (and a pinch) size the tiles, as Finder's icon view
      "tiles-bigger": () => (active.view === "grid" ? active.setTile(Math.min(TILE_MAX, active.tile + 24)) : false),
      "tiles-smaller": () => (active.view === "grid" ? active.setTile(Math.max(TILE_MIN, active.tile - 24)) : false),
      "toggle-compact": () => active.setCompact(!active.compact),
      ...dualPane.commands,
      "split-right": () => split("row"),
      "split-down": () => split("col"),
      "close-pane": () => close(),
      // the dual pane's old toggle, for anything still sending it
      "toggle-dual": () => (dual ? closeOthers() : split("row")),
      "focus-left": () => focusToward("left"),
      "focus-right": () => focusToward("right"),
      "focus-up": () => focusToward("up"),
      "focus-down": () => focusToward("down"),
    },
    dual,
    editorOpen: () => !!docRef.current,
    closeEditor,
  });

  // ------------------------------------------------------------ drag & drop from Finder
  const dropOver = useFinderDrop({
    target: (x, y) => {
      // a dialog owns the screen: nothing lands behind it
      if (overlayUp()) return null;
      // with several panes, the one under the pointer; else (or without a position) the active one
      const under = x != null && y != null ? document.elementFromPoint(x, y)?.closest("[data-pane]")?.getAttribute("data-pane") : null;
      const p = (dualCtx.current?.panes.length ?? 0) > 1 && under ? paneById(under as PaneId) : activeRef.current;
      return p.profile && p.bucket != null ? p.id : null;
    },
    onDrop: (id, paths) => void paneById(id).ops.uploadPaths(paths),
    onRefused: () => overlayUp() && toast("info", "Finish what’s open first, then drop the files again."),
  });

  // ------------------------------------------------------------ render
  /** A pane's items for its other pane, first in its toolbar's "…" (several panes only). */
  const dualItemsFor = (p: Pane) => {
    const o = dual ? otherOf(p.id) : null;
    if (!o) return undefined;
    // "the right pane", "the pane below": the way to it says which (the menu has no room for folder names too)
    return () =>
      dualMenuItems({
        toOther: { dir: relation(tree, p.id, o) ?? "right", name: "" },
        onToOther: () => dualPane.sameFolderInOther(p.id),
        onSwap: dualPane.swap,
        onCompare: dualPane.compare,
        syncWith: facing
          .filter(({ pair: [a, b] }) => a === p.id || b === p.id)
          .map(({ pair: [a, b], at }) => {
            const id = a === p.id ? b : a;
            const dir = relation(tree, p.id, id);
            return { id, dir, name: dir ? "" : paneName(slot(id)), on: isLinked(p.id, id), at };
          }),
        onToggleSync: (id) => toggleSync(p.id, id),
      });
  };
  const paneProps = (p: Pane) => ({
    pane: p,
    active: p === active,
    dual,
    label: `Pane ${ids.indexOf(p.id) + 1} of ${ids.length}`,
    dualItems: dualItemsFor(p),
    settings,
    updateSettings,
    previewOpen: preview.previewOpen,
    onTogglePreview: preview.togglePreview,
    dropUpload: dropOver === p.id,
    bucketNote: (p.profile && conns.bucketsBy[p.profile.id]?.note) || null,
    bucketError: (p.profile && conns.bucketsBy[p.profile.id]?.error) || null,
    bucketReconnect: !!(p.profile && conns.bucketsBy[p.profile.id]?.reconnect),
    empty: emptyFor(p.id),
    // one pane: a click splits it, as the dual pane button always did; more: the panes menu
    onSwitchConnection: (x: number, y: number) => switchMenu(p.id, x, y),
    onPanes: (x: number, y: number) => (dual ? panesMenu(p.id, x, y) : split("row", p.id)),
    panesItems: () => panesItems(p.id),
    onActivate: () => {
      if (dual && activeId !== p.id) setActiveId(p.id);
    },
  });
  const previewStyle = { "--preview-w": `${preview.previewWidth}px` } as React.CSSProperties;
  const aside = (p: Pane) => preview.previewOpen && <PreviewAside pane={p} layout={preview} settings={settings} reloadIfShowing={reloadIfShowing} onOpenFull={(e) => openDocument(p.id, e)} />;

  return (
    <div className={`app ${sideHidden ? "side-hidden" : ""}`}>
      {sideHidden && (
        <SidebarRail
          profiles={profiles}
          activeId={active.profile?.id ?? null}
          favorites={settings.favorites}
          syncState={syncState}
          authNeeded={authNeeded}
          builtIn={(p) => p.id === THIS_MAC.id}
          onExpand={toggleSidebar}
          onPick={(p, x, y) => void railPick(p, x, y)}
          onOpenFavorite={openFavorite}
          onNewProfile={() => setConnDialog({ profile: null })}
          onOpenSync={() => openSettings("sync")}
          onOpenSettings={() => openSettings()}
          onConnectionMenu={connectionMenu}
          onHover={sidePeek.hover}
          recent={recents.recent}
          onMore={findConnection}
        />
      )}
      {(!sideHidden || sidePeek.open) && (
        <div
          className={sideHidden ? "side-peek" : "side-full"}
          ref={sidePeek.ref}
          onMouseLeave={sideHidden ? sidePeek.leave : undefined}
          // opening a place from the overlay puts it away: on the way back up, once the row's own
          // click has opened it (closing on the way down unmounted the row before that)
          onClick={sideHidden ? sidePeek.clicked : undefined}
        >
          <Sidebar
            profiles={profiles}
            activeId={active.profile?.id ?? null}
            expanded={conns.expanded}
            bucketsBy={conns.bucketsBy}
            // on this computer, the sidebar folder holding the place (Home › Documents lights up Documents)
            bucket={active.profile && active.bucket != null ? closestLocalRoot(active.profile.id, active.bucket, active.prefix) : active.bucket}
            onToggleProfile={toggleConnection}
            onEditProfile={(p) => setConnDialog({ profile: p })}
            onNewProfile={() => setConnDialog({ profile: null })}
            onOpenSettings={() => openSettings()}
            syncState={syncState}
            onOpenSync={() => openSettings("sync")}
            onSelectBucket={(p, b) => {
              active.openBucket(p, b);
              focusListSoon();
            }}
            onOpenBucketByName={(p) => askBucketName(p)}
            onNewBucket={(p) => askNewBucket(p)}
            hiddenBuckets={conns.hiddenBuckets}
            onHideBucket={conns.setBucketHidden}
            onReconnect={(p) => setConnDialog({ profile: p, reconnect: true })}
            authNeeded={authNeeded}
            onSignInAgain={(p) => setConnDialog({ profile: p, reconnect: true })}
            favorites={settings.favorites}
            onOpenFavorite={openFavorite}
            onRemoveFavorite={active.actions.removeFavorite}
            rootLabel={conns.rootLabel}
            builtIn={(p) => p.id === THIS_MAC.id}
            onConnectionMenu={connectionMenu}
            onBucketMenu={bucketMenu}
            mounts={mounts}
            onDriveMenu={driveMenu}
            onHide={toggleSidebar}
            peek={sideHidden}
            recent={recents.recent}
            openGroups={openGroups.open}
            onToggleGroup={openGroups.toggle}
            onGroupMenu={groupMenu}
            onOpenConnection={openConnection}
            findSignal={findSignal}
            findOnMount={sideHidden && sidePeek.byFind}
            onFindDone={() => {
              if (sideHidden) sidePeek.close();
              focusSoon(activeRef.current.id);
            }}
          />
        </div>
      )}

      <main className="main">
        <PaneContext.Provider value={{ panes: panesRef.current, active, other, dual, setActive: setActiveId }}>
          {dual ? (
            <div className="content dual-wrap" style={previewStyle}>
              <SplitLayout
                tree={tree}
                activeId={activeId}
                pane={(id, style) => <BrowserPane {...paneProps(slot(id))} style={style} />}
                onSizes={(path, sizes) => setTree((t) => setSizes(t, path, sizes))}
                onEqualize={(path) => setTree((t) => equalize(t, path))}
                nameOf={(id) => paneName(slot(id)) || slot(id).profile?.name || "Empty pane"}
                onPick={(id) => {
                  setActiveId(id);
                  focusSoon(id);
                }}
                linked={isLinked}
                onToggleLink={toggleSync}
              />
              {aside(active)}
            </div>
          ) : (
            <BrowserPane {...paneProps(first)} contentStyle={previewStyle} aside={aside(first)} />
          )}
        </PaneContext.Provider>

        <TransferPanel
          onCancelJob={(id) => api.cancelTransfer(id).catch(() => {})}
          onDismissJob={jobs.dismiss}
          onOpenJob={(j) => {
            if (j.dest == null) return;
            const p = profiles.find((x) => x.id === j.profileId);
            if (p && j.bucket != null) active.go(p, j.bucket, j.dest);
          }}
          onOpenSync={() => openSettings("sync")}
          open={transfersOpen}
          onToggle={() => {
            if (transfersOpen) setActivityAsked(false);
            setTransfersOpen(!transfersOpen);
          }}
          showEmpty={activityAsked}
          tab={activityTab}
          onTab={setActivityTab}
          onOpenMigrationDest={(j) => {
            const p = profiles.find((x) => x.id === j.spec.dst.profileId);
            if (!p) return toast("error", "That connection no longer exists.");
            conns.expand(p.id);
            active.go(p, j.spec.dst.root, j.spec.dst.dir);
            focusListSoon();
          }}
          onCancel={transfers.cancel}
          onCancelAll={transfers.cancelAll}
          onRetry={transfers.retry}
          onRetryAll={() => void transfers.retryAll(true)}
          onOpenLocal={(t) => api.openLocal(t.local).catch((e) => toast("error", `Couldn’t open “${t.name}”. ${errMessage(e)}`))}
          onClear={() => {
            transfers.clearFinished();
            jobs.clearFinished();
          }}
          onClearFailed={() => void clearFailed()}
          onReveal={(t) => revealItemInDir(t.local).catch(() => {})}
        />
      </main>

      {settingsOpen && (
        <SettingsPage
          settings={settings}
          compact={active.compact}
          profiles={saved}
          onChange={updateSettings}
          // Settings sets it for every pane (each can still change its own from its toolbar)
          onCompact={(c) => {
            for (const p of slots) p.setCompact(c);
          }}
          onEditProfile={(p) => setConnDialog({ profile: p })}
          onNewProfile={() => setConnDialog({ profile: null })}
          onImportProfiles={() => setImportOpen(true)}
          onClose={() => setSettingsOpen(false)}
          initialPage={settingsPage}
          activeProfileId={active.profile?.id ?? null}
          onToast={toast}
        />
      )}
      {kyblDialog && (
        <KyblConnectDialog
          existing={kyblDialog.existing}
          reconnect={kyblDialog.reconnect}
          onClose={() => setKyblDialog(null)}
          onConnected={(p) => {
            forgetCaps(p.id);
            conns.upsertProfile(p);
            void connectIn(activeRef.current.id, p);
          }}
          onDeleted={forgetProfile}
        />
      )}
      {connDialog && (
        <ConnectionDialog
          initial={connDialog.profile}
          reconnect={connDialog.reconnect}
          onClose={() => setConnDialog(null)}
          onKybl={() => {
            setConnDialog(null);
            setKyblDialog({ existing: null });
          }}
          kyblFirst={!saved.some((p) => p.provider === KYBL)}
          groups={allGroups(saved)}
          onImport={() => {
            setConnDialog(null);
            setImportOpen(true);
          }}
          onSaved={(p) => {
            forgetCaps(p.id);
            clearAuthNeeded(p.id);
            conns.upsertProfile(p);
            void connectIn(activeRef.current.id, p);
          }}
          onDeleted={forgetProfile}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(list) => {
            for (const p of list) conns.upsertProfile(p);
          }}
          toast={toast}
        />
      )}
      {doc && (
        <Suspense fallback={null}>
          <LazyDocumentView
            ref={editor}
            profileId={doc.profileId}
            bucket={doc.bucket}
            entry={doc.entry}
            mode="full"
            onClose={() => {
              setDoc(null);
              requestAnimationFrame(() => focusPaneList(doc.pane));
            }}
            onSaved={() => {
              // size, date and ETag changed (or a copy appeared); the editor's header says
              // "Saved" / "Saved as …" itself, so no toast on top
              reloadIfShowing(doc.profileId, doc.bucket);
            }}
            onOpenExternal={(e) => void paneById(doc.pane).ops.openInApp(e)}
          />
        </Suspense>
      )}
      {migrations.element}
      {!settingsOpen && <UpdateBanner st={updates} />}
    </div>
  );
}

/**
 * The folded sidebar's overlay: resting on a rail icon brings the whole sidebar in over the
 * panes (nothing moves); it goes once the pointer has left it and no menu from it is up.
 */
function useSidePeek(folded: boolean, menuUp: () => boolean) {
  const [open, setOpenState] = useState(false);
  // brought up by ⌥⌘F or the rail's "All connections": the filter field takes the keyboard
  const [byFind, setByFind] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const setOpen = useCallback((on: boolean, find = false) => {
    setOpenState(on);
    setByFind(on && find);
  }, []);
  useEffect(() => {
    if (!folded) setOpen(false);
    return () => window.clearTimeout(timer.current);
  }, [folded, setOpen]);
  // put away while the pointer rests on the rail (its "All connections", say): it doesn't come
  // straight back until the pointer has moved off that icon
  const resting = useRef(false);
  const hover = useCallback((on: boolean) => {
    window.clearTimeout(timer.current);
    if (!on) resting.current = false;
    else if (!resting.current) timer.current = window.setTimeout(() => setOpenState(true), 280);
  }, []);
  // it stays while the pointer is on it, a menu from it is up, or something in it has the
  // keyboard (typing in its filter field with the pointer elsewhere)
  const check = useCallback(() => {
    const keep = menuUp() || ref.current?.matches(":hover") || ref.current?.contains(document.activeElement);
    if (keep) timer.current = window.setTimeout(check, 300);
    else setOpen(false);
  }, [menuUp, setOpen]);
  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(check, 220);
  }, [check]);
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(true, true);
    timer.current = window.setTimeout(check, 600);
  }, [check, setOpen]);
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    resting.current = !!ref.current?.matches(":hover");
    setOpen(false);
  }, [setOpen]);
  const clicked = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as Element;
      if (t.closest(".side-item.sub, .fav-row, .side-item.conn.single, .side-toggle, .recent-row, .find-row")) close();
    },
    [close],
  );
  return { open, byFind, ref, hover, leave, clicked, show, close };
}
