/**
 * The desktop app around the browser panes: the sidebar of connections and favorites, the
 * Activity panel, Settings, connection dialogs and the update banner. It owns the panes (one, or
 * several in a layout of splits) and routes the sidebar, the keyboard and the menu bar to the
 * active one.
 */
import { inBackground } from "./notifications";
import { freshConnection } from "../connLog";
import { MountDialog } from "../mount/MountDialog";
import { driveItems } from "../mount/driveMenu";
import { findMount, useMounts } from "../mount/useMounts";
import type { MountInfo } from "../api";
import { tidyMenu } from "../desktop/menus";
import { menuFromKey } from "../desktop/menuKeyWatch";
import { onTrustSaved, trustOnProfile } from "../connections/ConnFix";
import { splitDavUrl } from "../connections/serverHost";
import { flushSync } from "react-dom";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { REMOTE_TERM_DROP, useTerminalPanes } from "../terminal/useTerminalPanes";
import { canTerminal, terminalBusy } from "../terminal/api";
import { LOCAL_PROFILE } from "../browser/types";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { openFromConnection } from "../desktop/openGuard";
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
import { applySettings, isDark, loadSettings, saveSettings, type Favorite, type Settings } from "../settings";
import { undoStack } from "../desktop/undo";
import { usePane, type Pane, type PaneEnv } from "../browser/usePane";
import { BrowserPane } from "../browser/BrowserPane";
import type { EmptyActions } from "../browser/PaneEmpty";
import { PANE_IDS, paneKeys, THIS_MAC, type Loc, type PaneId, type PaneView } from "../browser/types";
import { forgetCaps, peekCaps } from "../useCaps";
import { sendItems } from "./crossPane";
import { clearAuthNeeded, useAuthNeeded } from "../connections/authNeeded";
import { closestLocalRoot, rootIcon, rootsMode } from "../connections/roots";
import { canView, LazyDocumentView, viewerFor } from "../viewers/registry";
import { asExport } from "../connections/native";
import type { DocumentHandle } from "../viewers/DocumentView";
import type { Entry } from "../types";
import type { Profile } from "../types";
import { isShellConn, type PickId } from "../connections/kinds";
import { useDialogs } from "./useDialogs";
import type { MenuItem } from "../components/Dialogs";
import { photoMenuItems } from "./photoMenu";
import { tunnelMenuItems, useTunnelCommands } from "../tunnels/tunnelMenu";
import { loadExpanded, useConnections } from "./useConnections";
import { useFinderDrop } from "./useFinderDrop";
import { useShellCommands } from "./useShellCommands";
import { dualMenuItems, SplitLayout } from "./SplitLayout";
import {
  allFacing,
  closePane,
  dockEdge,
  equalize,
  freeSlot,
  leaf,
  leaves,
  loadLayout,
  loadLinks,
  MAX_PANES,
  minSize,
  movePane,
  moveToEdge,
  moveToward,
  relation,
  sameLink,
  saveLayout,
  saveLinks,
  setSizes,
  shapeOf,
  splitPane,
  syncedWith,
  toggleLink,
  type Dir,
  type DropZone,
  type PaneNode,
  type SyncLink,
} from "./paneLayout";
import { makeDualActions, paneName, type DualContext } from "./dualActions";
import { stopOrCancel } from "../actions/customActions";
import { WorkspaceBar, wsTabAt, type PaneSwitcher } from "./WorkspaceBar";
import { usePaneDrag, type DropCheck, type DropTarget } from "./usePaneDrag";
import { useFileDrag } from "./useFileDrag";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { useWorkspaceRecipes } from "./useWorkspaceRecipes";
import {
  copyLayout,
  copyName,
  loadWorkspaces,
  newId,
  nextName,
  oneLayout,
  paneCount,
  reorder,
  saveWorkspaces,
  writeSlot,
  type Layout,
  type PaneSnap,
  type Workspace,
  type WorkspaceStore,
} from "./workspaces";
import { dropPlace } from "./recipes";
import type { HistorySnap } from "../browser/useHistory";
import { sameLoc, type Listing } from "../browser/useListing";
import { PaneContext } from "./PaneContext";
import { useMigrationHost } from "./useMigrationHost";
import { usePalette } from "../palette/usePalette";
import { forgetPlacesOf } from "../palette/recent";
import { useEdit, type EditPlace } from "../edit/useEdit";
import { EditorSheet } from "../edit/EditorSheet";
import { LazyEditConflictHost, LazyEditingChip } from "../edit/lazy";
import { useEditCount, type SaveRule } from "../edit/editStore";
import { listMirrors, mirrorToPane, quickRun } from "../mirror";
import { registerCommands } from "../palette/commands";
import { connectionMenuItems } from "../connections/organizeMenu";
import { moveInto, togglePins } from "../connections/organize";
import { useConnPicks } from "../connections/useConnPicks";
import {
  allGroups,
  groupLabel,
  groupOf,
  inScope,
  normalizeGroup,
  parentGroup,
  renamedOpen,
  renameGroup,
  revealKeys,
  scopeOf,
  ungroup,
  useOpenGroups,
  useRecentConnections,
  type GroupChanges,
  type GroupNode,
  type KindSection,
} from "../connections/groups";

/** The connection dialog: editing `profile`, or a new one (on `startKind`'s form, when given). */
type ConnDialogAsk = { profile: Profile | null; reconnect?: boolean; startKind?: PickId; startTab?: "tunnels" };

/** Gives a pane's file list keyboard focus (after a sidebar click the arrows should move in it). */
export function focusPaneList(id: PaneId) {
  // (a terminal pane: its terminal's input)
  document.querySelector<HTMLElement>(`[data-pane="${id}"] [data-list-focus], [data-pane="${id}"] textarea.xterm-helper-textarea`)?.focus({ preventScroll: true });
}

export function AppShell() {
  const dialogs = useDialogs();
  const { toast } = dialogs;
  const conns = useConnections();
  // trusted from a destination picker (copy to another connection, mirror): the sidebar's copy follows
  const { upsertProfile } = conns;
  useEffect(() => onTrustSaved(upsertProfile), [upsertProfile]);
  // sign-in connections whose access ended: "Sign in again" in the sidebar
  const authNeeded = useAuthNeeded();
  // drives ("Mount as drive"): the sidebar marks mounted places, the menus offer Eject
  const { mounts } = useMounts();
  // the saved connections, then this computer's own folders
  const saved = conns.profiles;
  const profiles = useMemo(() => [...saved, THIS_MAC], [saved]);
  // ⌘K: Start / Stop tunnel “name” for SFTP connections' SSH tunnels
  useTunnelCommands(saved, toast);
  const [transfersOpen, setTransfersOpen] = useState(true);
  // the activity panel was opened on purpose: it stays up with a note even with nothing going on
  const [activityAsked, setActivityAsked] = useState(false);
  // the Activity panel's tab: transfers and moves, or copies between connections (Jobs)
  const [activityTab, setActivityTab] = useState<ActivityTab>("activity");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // a counter with the page, so asking again for the same page (tray "Sync settings…") goes back to it
  const [settingsPage, setSettingsPage] = useState<{ page?: SettingsPageId; n: number }>({ n: 0 });
  const updates = useUpdates();
  const syncState = useSyncOverall();
  const openSettings = useCallback((page?: SettingsPageId) => {
    setSettingsPage((r) => ({ page, n: r.n + 1 }));
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
  const picks = useConnPicks(conns.profiles);
  // ⌥⌘F: the sidebar's filter field takes the keyboard (each press bumps this)
  const [findSignal, setFindSignal] = useState(0);
  // workspace recipes (recipes.ts): layouts saved to reset to or open again, terminals included
  const rec = useWorkspaceRecipes();
  // workspaces (workspaces.ts): named layouts the window switches between. The one on screen lives
  // in the pane slots and the state below; the others are snapshots. The first launch with them
  // makes "Default workspace" of the layout as it was.
  const [ws, setWs] = useState<WorkspaceStore>(() => {
    const loaded = loadWorkspaces(() => {
      const t = loadLayout(settings.layout);
      return { tree: t, links: loadLinks(t, settings.syncBrowsing), recent: leaves(t) };
    });
    // the ones set to open from their recipe do (their terminals type their startup commands)
    const s = rec.atLaunch(loaded);
    const start = s.list.find((w) => w.id === s.active)!;
    // its panes into their slots' keys, where the slots read where to open and how to show it
    for (const id of leaves(start.tree)) writeSlot(id, start.panes[id]);
    return s;
  });
  const wsNow = ws.list.find((w) => w.id === ws.active) ?? ws.list[0];
  /** the workspace on screen at launch opens at its recipe's folders even with "reopen where I was" off */
  const startSaved = useRef(wsNow.start === "saved" && !!rec.recipeOf(wsNow));
  // the panes on screen as a tree of splits (the workspace's)
  const [tree, setTree] = useState<PaneNode>(() => wsNow.tree);
  const ids = useMemo(() => leaves(tree), [tree]);
  const dual = ids.length > 1;
  // terminal panes (src/terminal): slots that show a shell instead of files
  const term = useTerminalPanes(wsNow);
  const fileIds = ids.filter((id) => !term.terms[id]);
  useEffect(() => {
    // dragging a divider changes the tree on every mouse move: write once it settles
    const t = window.setTimeout(() => saveLayout(tree), 200);
    return () => window.clearTimeout(t);
  }, [tree]);
  // synchronized browsing: pairs of panes that follow each other, switched by the link on the
  // divider between them. Only pairs facing each other across a divider count, so what is lit on
  // screen is exactly what moves together; a link kept from another layout comes back with it.
  const [links, setLinks] = useState<SyncLink[]>(() => wsNow.links);
  useEffect(() => saveLinks(links), [links]);
  // (file panes only: a terminal doesn't follow a folder this way, it has "Follow the folder above")
  const canLink = (a: PaneId, b: PaneId) => !term.terms[a] && !term.terms[b];
  const facing = useMemo(() => allFacing(tree).filter(({ pair: [a, b] }) => !term.terms[a] && !term.terms[b]), [tree, term.terms]);
  const liveLinks = useMemo(() => links.filter((l) => facing.some(({ pair: [a, b] }) => sameLink(l, a, b))), [links, facing]);
  const isLinked = (a: PaneId, b: PaneId) => liveLinks.some((l) => sameLink(l, a, b));
  const toggleSync = (a: PaneId, b: PaneId) => setLinks((cur) => toggleLink(cur, a, b));
  /** a closed pane's slot opens empty next time: it lets go of its links too */
  const unlink = (gone: (id: PaneId) => boolean) => setLinks((cur) => cur.filter(([a, b]) => !gone(a) && !gone(b)));
  // the panes by when they were last active, most recent first: the first on screen is the
  // active one, the next is what "the other pane" means for it (F5 / F6, swap, compare)
  const [recent, setRecent] = useState<PaneId[]>(() => wsNow.recent);
  const setActiveId = useCallback((id: PaneId) => setRecent((cur) => (cur[0] === id ? cur : [id, ...cur.filter((x) => x !== id)])), []);
  const activeId = recent.find((id) => ids.includes(id)) ?? ids[0];
  /** the file pane used last: what the sidebar, the menus and the keyboard act on while a terminal has the keyboard */
  const fileId = recent.find((id) => fileIds.includes(id)) ?? fileIds[0] ?? null;

  const [connDialog, setConnDialogState] = useState<ConnDialogAsk | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** Opens the editor for a connection: Kybl Storage connections have their own (no keys to edit). */
  const setConnDialog = useCallback((d: ConnDialogAsk | null) => {
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
  /** The Activity tab's "Cancel transfers": one click must not throw a whole batch away, partial downloads included. */
  const cancelAllTransfers = async () => {
    const n = transfers.activeCount();
    if (n > 0) {
      const ok = await dialogs.confirm({
        title: n === 1 ? "Cancel this transfer?" : `Cancel ${n.toLocaleString()} transfers?`,
        label: n === 1 ? "Cancel transfer" : "Cancel transfers",
        cancelLabel: n === 1 ? "Keep transfer" : "Keep transfers",
        danger: true,
        message: <p>Partly downloaded files are deleted and what was sent of an upload is let go. Finished ones stay. Pause all keeps the progress, to carry on later.</p>,
      });
      if (!ok) return;
    }
    transfers.cancelAll();
  };
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
    // a workspace not on screen that kept this place's listing would bring back the old rows
    for (const [k, l] of keptListings.current) if (l.loc?.profileId === pid && l.loc.bucket === b) keptListings.current.delete(k);
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
  // ⌘K: each saved mirror runs from the palette (its dry run first, as from a folder's ⋯ menu)
  const dialogsRef = useRef(dialogs);
  dialogsRef.current = dialogs;
  useEffect(
    () =>
      registerCommands("mirrors", () =>
        listMirrors().map((m) => ({
          id: `mirror:${m.id}`,
          title: `Run mirror “${m.name}”`,
          group: "Mirror",
          keywords: `deploy sync ${m.src.connectionName} ${m.dst.connectionName}`,
          icon: "play" as const,
          run: () => quickRun(m, dialogsRef.current, showJobs),
        })),
      ),
    [showJobs],
  );
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
  // `rule`: opened by "Edit in Kybl" (a sheet, saving under the rule picked for this edit)
  const [doc, setDoc] = useState<{ pane: PaneId; profileId: string; bucket: string; entry: Entry; rule?: SaveRule; sheet?: boolean } | null>(null);
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
    // (the stored content type too: "Edit in Kybl" offers files that only it marks as text)
    const v = viewerFor(x.name, x.mime ?? null, x.size);
    return !!v && v.kind !== "image" && canView(x.name, x.size, x.mime ?? null);
  };
  const openDocument = (id: PaneId, e: Entry) => {
    if (!canOpenDocument(id, e)) return false;
    const p = paneById(id);
    p.closeQuick();
    setDoc({ pane: id, profileId: p.profile!.id, bucket: p.bucket!, entry: e });
    return true;
  };
  const closeEditor = async () => (editor.current ? editor.current.requestClose() : true);

  /** a press on items starts the shell's drag of them (useFileDrag, further down) */
  const beginItemDrag = useRef<PaneEnv["beginItemDrag"]>(undefined);
  // ------------------------------------------------------------ Edit (src/edit)
  const editPlace = (id: PaneId): EditPlace | null => {
    const p = paneById(id);
    if (!p.profile || p.bucket == null) return null;
    return { profileId: p.profile.id, bucket: p.bucket, onDisk: !!peekCaps(p.profile.id)?.localPaths, ops: p.ops, pane: id };
  };
  const editing = useEditCount();
  const edits = useEdit({
    dialogs,
    transfers,
    reloadIfShowing,
    openInKybl: (place, e, rule) => {
      const id = (place.pane as PaneId | undefined) ?? activeRef.current.id;
      paneById(id).closeQuick();
      setDoc({ pane: id, profileId: place.profileId, bucket: place.bucket, entry: e, rule: rule ?? "ifUnchanged", sheet: true });
    },
  });

  const envFor = (id: PaneId): PaneEnv => ({
    id,
    storageKey: paneKeys(id).last,
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
    editItems: (e) => {
      const place = editPlace(id);
      return place ? edits.itemsFor(place, e) : [];
    },
    editFile: (e) => {
      const place = editPlace(id);
      if (place) edits.editFile(place, e);
    },
    openMigration: migrations.open,
    openDriveSettings: () => openSettings("drives"),
    sendItems: (ops, src, items, mode, dst, dest, onStarted) => {
      const to = profiles.find((x) => x.id === dst.profileId);
      const names = { connectionName: to?.name ?? "", rootName: conns.rootLabel(dst.profileId, dst.bucket), singleRoot: peekCaps(dst.profileId)?.roots === "single" };
      void sendItems(ops, src, items, mode, { ...dst, ...names }, dest, dualCtx.current!, onStarted);
    },
    // the empty-space menu's Split ▸ (splitItems is defined further down; this runs on a right-click)
    splitItems: () => [{ type: "submenu", label: "Split", icon: "dual-pane", items: () => splitItems(id) }],
    beginItemDrag: (...a) => beginItemDrag.current?.(...a),
    terminalItems: (key, label) => term.items(id, key, label),
    tunnelItems: () => {
      const p = paneById(id).profile;
      return p ? tunnelMenuItems(p, toast, () => setConnDialog({ profile: p, startTab: "tunnels" })) : [];
    },
    editTunnels: () => {
      const p = paneById(id).profile;
      if (p && p.kind !== "local") setConnDialog({ profile: p, startTab: "tunnels" });
    },
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
  const active = slot(fileId ?? activeId);
  /** The file pane `id` pairs with: the one active most recently before it (with two, the other one). */
  const otherOf = (id: PaneId): PaneId | null => recent.find((x) => x !== id && fileIds.includes(x)) ?? fileIds.find((x) => x !== id) ?? null;
  const otherId = dual ? otherOf(active.id) : null;
  const other = otherId ? slot(otherId) : null;
  panesRef.current = fileIds.map(slot);
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
    stopSync: (ids) => {
      const set = new Set(ids);
      setLinks((cur) => cur.filter(([a, b]) => !(set.has(a) && set.has(b))));
    },
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
    busyFor: (pid, b) => panesRef.current.find((p) => p.profile?.id === pid && p.bucket === b)?.setBusy,
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
  /** A cramped window draws only the active pane: when a terminal has it, the file pane comes forward so what opens there is seen. */
  const showFilePane = () => {
    if (!crampedRef.current || fileId == null || activeId === fileId) return;
    keepScrolls();
    setActiveId(fileId);
  };
  /**
   * Opens something "here" (sidebar, favorites, ⌘K, Activity): in the active file pane, or, when
   * every pane on screen is a terminal, in a new file pane next to the active one (the slot
   * behind a terminal isn't drawn, so opening there would show nothing).
   */
  const openHere = (run: (pane: Pane) => void) => {
    if (fileId != null) {
      showFilePane();
      run(activeRef.current);
      return focusListSoon();
    }
    split("row", activeId, false, (fresh) => run(slot(fresh)), true);
  };

  /** the latest connectIn per pane: an older one whose bucket list comes late opens nothing */
  const connectGen = useRef(new Map<PaneId, number>());
  /**
   * Shows a connection in a pane: expands it in the sidebar and opens a bucket of it, unless the
   * pane went somewhere else while its bucket list loaded.
   */
  const connectIn = useCallback(
    async (id: PaneId, p: Profile, preferBucket?: string, startPrefix = "") => {
      const n = (connectGen.current.get(id) ?? 0) + 1;
      connectGen.current.set(id, n);
      const before = paneById(id);
      const was = { here: before.here, profile: before.profile?.id };
      before.showConnection(p.id);
      conns.expand(p.id);
      const names = await conns.loadBuckets(p, true);
      const now = paneById(id);
      // still as it was (not drawn again yet), or still waiting on this connection
      const untouched = now.here === was.here && now.profile?.id === was.profile;
      const waiting = now.here == null && now.profile?.id === p.id;
      if (connectGen.current.get(id) !== n || !(untouched || waiting)) return;
      const pick = preferBucket != null && names.includes(preferBucket) ? preferBucket : p.bucket || names[0];
      // "" is a root too: the one root of a server connection
      if (pick != null) paneById(id).openBucket(p, pick, pick === preferBucket ? startPrefix : "");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conns.expand, conns.loadBuckets],
  );

  /** An SSH connection opens as a terminal on the server (`another`: a new one beside an open one). */
  const openShell = (p: Profile, another = false) => {
    if (sideHidden) sidePeek.close();
    term.openRemote(p.id, another);
  };

  /** Sidebar click on a connection: folds it open or shut, without leaving what is on screen. */
  const toggleConnection = (p: Profile) => {
    if (isShellConn(p)) return openShell(p);
    if (fileId == null || !active.profile) return openHere((pane) => void connectIn(pane.id, p));
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
    forgetPlacesOf(id);
    clearAuthNeeded(id);
    forgetCaps(id);
    conns.dropProfile(id);
    for (const p of allPanes.current) p.forgetProfile(id);
    term.forget(id);
    // and its terminals in the other workspaces: gone from them, so their shells end (gc)
    setWs((cur) => ({
      ...cur,
      list: cur.list.map((w) =>
        w.id === cur.active || !Object.values(w.panes).some((x) => x?.term?.profileId === id)
          ? w
          : { ...w, panes: Object.fromEntries(Object.entries(w.panes).map(([k, x]) => [k, x?.term?.profileId === id ? { ...x, term: undefined } : x])) },
      ),
    }));
  };

  // initial load
  useEffect(() => {
    api
      .listProfiles()
      .then((list) => {
        conns.setProfiles(list);
        // a WebDAV profile saved before addresses were split still has "user:password@" in profiles.json:
        // one save through the backend moves the password to the vault. Once per launch, never retried,
        // so a failure can't loop.
        for (const p of list) {
          if (p.kind === "webdav" && p.net?.url && splitDavUrl(p.net.url).href !== p.net.url.trim()) {
            api.saveProfile(p).then(conns.upsertProfile, () => {});
          }
        }
        const all = [...list, THIS_MAC];
        // opened from its recipe: a pane whose connection isn't on this device stays empty, and says so
        const gone = startSaved.current ? rec.missingAtLaunch(wsNow, (pid) => all.some((x) => x.id === pid)) : {};
        for (const id of Object.keys(gone) as PaneId[]) {
          opened.current.add(id);
          term.assign(id, undefined);
          slot(id).showConnection(null);
        }
        // the first pane on screen opens like the one pane always did; the others follow below
        const firstId = fileIds.find((id) => !gone[id]) ?? ids.find((id) => !gone[id]);
        if (!firstId) return;
        const last = settings.restoreLast || startSaved.current ? slot(firstId).savedLocation() : null;
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
  const first = slot(fileIds.find((id) => !rec.notes[id]) ?? fileIds[0] ?? ids[0]);
  useEffect(() => {
    if (!first.here || !first.profile || !profiles.length) return;
    for (const id of ids) {
      // (a terminal's slot shows no files)
      if (id === first.id || term.terms[id] || opened.current.has(id)) continue;
      opened.current.add(id);
      const p = slot(id);
      if (p.profile) continue;
      const saved = settings.restoreLast || startSaved.current ? p.savedLocation() : null;
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
  /** The room the panes share now. */
  const paneRoom = () => {
    const box = document.querySelector<HTMLElement>(".splits");
    if (box) return { w: box.clientWidth, h: box.clientHeight };
    const one = document.querySelector<HTMLElement>(`[data-pane="${ids[0]}"]`);
    if (!one) return null;
    return { w: one.clientWidth, h: one.clientHeight };
  };
  /** The width the sidebar gave up when a split folded it (0: it wasn't folded for a split). */
  const autoFold = useRef(0);
  useEffect(() => {
    if (!sideHidden) autoFold.current = 0;
  }, [sideHidden]);
  /** After panes close: a sidebar a split folded comes back once the panes left fit beside it. */
  const unfoldIfRoom = (next: PaneNode) => {
    const room = paneRoom();
    if (!autoFold.current || !sideHidden || !room) return;
    if (minSize(next).w <= room.w - autoFold.current) toggleSidebar();
  };
  /** The folded sidebar's rail (styles.css, `.app.side-hidden`). */
  const SIDE_RAIL_W = 82;
  /** The width folding the sidebar to its rail would give the panes (0 when it's folded already). */
  const sideSpare = () => {
    if (sideHidden) return 0;
    const side = document.querySelector<HTMLElement>(".app .side-full > aside.sidebar");
    return side ? Math.max(0, side.offsetWidth - SIDE_RAIL_W) : 0;
  };
  /**
   * Whether pane `id` can be split that way: "no" with the reason (no free slot, or no room even
   * with the sidebar folded), "fold" when it fits once the sidebar folds to its rail, or "ok".
   */
  const splitRoom = (dir: Dir, id: PaneId): { ok: "ok" | "fold" } | { ok: "no"; why: string } => {
    const t = treeRef.current;
    const fresh = freeSlot(t);
    if (!fresh || leaves(t).length >= MAX_PANES) return { ok: "no", why: `Kybl shows up to ${MAX_PANES} panes. Close one to make room.` };
    const room = paneRoom();
    const need = minSize(splitPane(t, id, dir, fresh));
    if (!room || (need.w <= room.w && need.h <= room.h)) return { ok: "ok" };
    if (need.h <= room.h && need.w <= room.w + sideSpare()) return { ok: "fold" };
    return { ok: "no", why: "There isn’t room for another pane. Make the window bigger, or close a pane." };
  };
  /** Why pane `id` can't be split that way, or null when it can (folding the sidebar if need be). */
  const splitRefusal = (dir: Dir, id: PaneId): string | null => {
    const r = splitRoom(dir, id);
    return r.ok === "no" ? r.why : null;
  };
  /**
   * Where a new pane can go when the way asked for (`dir` of pane `id`) has no room: that pane the
   * other way, else the roomiest other pane either way, so a 2 + 1 layout becomes 2 + 2 rather
   * than refusing. One that fits as it is beats one that needs the sidebar folded; null: nowhere.
   */
  const roomyPlace = (dir: Dir, id: PaneId): { dir: Dir; id: PaneId; room: "ok" | "fold" } | null => {
    const t = treeRef.current;
    const other: Dir = dir === "row" ? "col" : "row";
    const area = (x: PaneId) => {
      const el = document.querySelector<HTMLElement>(`[data-pane="${x}"]`);
      return el ? el.clientWidth * el.clientHeight : 0;
    };
    const rest = leaves(t).filter((x) => x !== id).sort((a, b) => area(b) - area(a));
    const tries = [{ dir, id }, { dir: other, id }, ...rest.flatMap((x) => [{ dir, id: x }, { dir: other, id: x }])].map((c) => ({ ...c, r: splitRoom(c.dir, c.id) }));
    const pick = tries.find((c) => c.r.ok === "ok") ?? tries.find((c) => c.r.ok === "fold");
    return pick && pick.r.ok !== "no" ? { dir: pick.dir, id: pick.id, room: pick.r.ok } : null;
  };
  /**
   * Splits a pane: the new one opens the same place (and view) and becomes the active pane. It
   * goes right of or below the pane, or with `before` left of or above it. With `anywhere` (a new
   * terminal, ⌘↵ in the palette) it goes wherever there's room when that way has none.
   */
  const split = (dir: Dir, id: PaneId = activeId, before = false, fill?: (fresh: PaneId) => void, anywhere = false) => {
    const asked = splitRoom(dir, id);
    const place = asked.ok !== "no" || !anywhere ? null : roomyPlace(dir, id);
    if (asked.ok === "no" && !place) return toast("info", asked.why);
    const at = place ?? { dir, id, room: asked.ok as "ok" | "fold" };
    const room = { ok: at.room };
    // the panes need the sidebar's width: it folds to its rail, as a narrow Finder window hides its sidebar
    if (room.ok === "fold") {
      autoFold.current = sideSpare();
      toggleSidebar();
    }
    const t = treeRef.current;
    const fresh = freeSlot(t)!;
    const src = slot(id);
    const p = slot(fresh);
    opened.current.add(fresh);
    // `fill`: the new pane opens somewhere else (the command palette's ⌘↵)
    if (fill) fill(fresh);
    else if (src.here && src.profile) p.go(src.profile, src.here.bucket, src.here.prefix);
    else if (term.terms[id] && profiles.some((x) => x.id === term.terms[id]!.profileId)) {
      // split from a terminal: its folder
      const at = term.terms[id]!;
      p.go(profiles.find((x) => x.id === at.profileId)!, at.bucket, at.prefix);
    } else p.showConnection(src.profile?.id ?? null);
    if (p.view !== src.view) p.setView(src.view);
    keepScrolls();
    setTree(splitPane(t, at.id, at.dir, fresh, place ? place.id === id && place.dir === dir && before : before));
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
    rec.clearNote(id);
    // its list's place goes with it: the next pane in this slot starts at the top
    pendingScroll.current.delete(id);
    lastTop.current.delete(id);
    // a terminal's slot is a file pane again (its shell ends unless another workspace has the pane now)
    term.assign(id, undefined);
  };
  /**
   * Asks before terminals still running a program close with their panes (their shells end):
   * true to go ahead. An idle shell, or one not known to be busy, closes without asking.
   */
  const okToEndShells = async (sids: (string | undefined)[], label: string) => {
    const busy = await busyShells(sids);
    return !busy || confirmEndShells(busy, label);
  };
  /** how many of sessions `sids` run a program */
  const busyShells = async (sids: (string | undefined)[]) => {
    const live = sids.filter((s): s is string => !!s);
    return live.length ? (await Promise.all(live.map((s) => terminalBusy(s)))).filter((b) => b === true).length : 0;
  };
  const confirmEndShells = (busy: number, label: string) =>
    dialogs.confirm({
      title: busy === 1 ? "A program is still running in a terminal" : `Programs are still running in ${busy} terminals`,
      label,
      danger: true,
      icon: "alert",
      message: <p>{busy === 1 ? "Closing ends it, and what the terminal has printed is gone." : "Closing ends them, and what the terminals have printed is gone."}</p>,
    });
  /** the terminals' sessions among panes `of` on screen */
  const sidsOf = (of: PaneId[]) => of.map((x) => term.terms[x]?.sid);
  /** the terminals' sessions in workspace `wsId` */
  const wsSids = (wsId: string) => {
    const l = layoutOf(wsId);
    return wsId === ws.active ? sidsOf(leaves(l.tree)) : leaves(l.tree).map((x) => l.panes[x]?.term?.sid);
  };
  /** the latest close steps, for after a confirm (by then this render's values are old) */
  const paneLater = useRef({ close: (_id: PaneId): boolean => false, closeOthers: (_id: PaneId) => {}, takeFromLive: (_id: PaneId) => {} });
  /**
   * Closes a pane, asking first when it is a terminal with a program running; false when it is
   * the only one (⌘W then closes the window, as it always did).
   */
  const close = (id: PaneId = activeId) => {
    if (!closePane(treeRef.current, id)) return false;
    const sid = term.terms[id]?.sid;
    if (!sid) return closeNow(id);
    void okToEndShells([sid], "Close terminal").then((ok) => ok && paneLater.current.close(id));
    return true;
  };
  const closeOthers = (id: PaneId = activeId) => {
    const sids = sidsOf(ids.filter((x) => x !== id));
    if (!sids.some(Boolean)) return closeOthersNow(id);
    void okToEndShells(sids, "Close other panes").then((ok) => ok && paneLater.current.closeOthers(id));
  };
  const closeNow = (id: PaneId) => {
    const next = closePane(treeRef.current, id);
    if (!next) return false;
    keepScrolls();
    vacate(id);
    setTree(next);
    unfoldIfRoom(next);
    unlink((x) => x === id);
    setRecent((cur) => cur.filter((x) => x !== id));
    if (id === activeId) focusSoon(recent.find((x) => x !== id && leaves(next).includes(x)) ?? leaves(next)[0]);
    return true;
  };
  const closeOthersNow = (id: PaneId) => {
    keepScrolls();
    for (const x of ids) if (x !== id) vacate(x);
    setTree(leaf(id));
    unfoldIfRoom(leaf(id));
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
          { type: "submenu", label: "Move pane", icon: "move", items: () => moveItems(id) },
          mirrorToPane(slot(id), otherOf(id) ? slot(otherOf(id)!) : null, dialogs, showJobs),
          { type: "sep" },
          { type: "item", label: "Close pane", icon: "x", hint: "⌘W", onClick: () => void close(id) },
          { type: "item", label: "Close other panes", onClick: () => closeOthers(id) },
        ] satisfies MenuItem[])
      : []),
  ];
  const panesMenu = (id: PaneId, x: number, y: number) => dialogs.menu(x, y, panesItems(id));

  // ------------------------------------------------------------ workspaces
  /** a workspace's panes' Back / Forward while another is on screen (this session only) */
  const histories = useRef(new Map<string, Partial<Record<PaneId, HistorySnap>>>());
  /**
   * The listings of the panes of workspaces not on screen, by workspace and slot. The slots are
   * shared by every workspace, so without this each switch would list every folder again (and
   * with it reconnect). Held only for what a pane showed when it was left; dropped when that place
   * changes (reloadIfShowing), the workspace closes or resets. No pane stays mounted, so nothing
   * polls in the background.
   */
  const keptListings = useRef(new Map<string, Listing>());
  /** a listing this big is listed again instead of kept: it would weigh on memory for a rare return */
  const KEEP_LISTING_MAX = 20_000;
  const dropKept = (match: (key: string, l: Listing) => boolean) => {
    for (const [k, l] of keptListings.current) if (match(k, l)) keptListings.current.delete(k);
  };
  const keepListings = (wsId: string) => {
    for (const k of [...keptListings.current.keys()]) if (k.startsWith(`${wsId}\n`)) keptListings.current.delete(k);
    for (const id of ids) {
      const p = slot(id);
      const l = p.ent.listing;
      // (one whose pages are still being pulled is listed again: coming back, the pull would bump the
      // request id and the quiet refresh after `seed` would never land, leaving stale rows. A big one
      // that stopped at the cap and waits for scrolling is idle, so it is kept)
      if (term.terms[id] || !p.ent.fresh || p.ent.listError || !l.loc || (l.next && p.ent.pulling) || l.folders.length + l.objects.length > KEEP_LISTING_MAX) continue;
      keptListings.current.set(`${wsId}\n${id}`, l);
    }
  };
  /** how far down a pane's list was, given back once that list is there again */
  const pendingScroll = useRef(new Map<PaneId, { loc: Loc; top: number; selected?: string[] }>());
  /** the workspace being renamed in its tab, and the one whose settings are open */
  const [wsEditing, setWsEditing] = useState<string | null>(null);
  const [wsSettings, setWsSettings] = useState<{ id: string; anchor: DOMRect } | null>(null);
  /** the window is too small for every pane: one shows, the bar's pane switcher picks it */
  const [cramped, setCramped] = useState(false);
  const crampedRef = useRef(false);
  /** how far down each pane's list was when last scrolled, and where (a cramped window draws only one) */
  const lastTop = useRef(new Map<PaneId, { loc: Loc | null; top: number }>());
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useEffect(() => {
    const on = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!el.matches?.(".table-body, .grid-scroll")) return;
      const id = el.closest("[data-pane]")?.getAttribute("data-pane") as PaneId | null;
      if (id) lastTop.current.set(id, { loc: slotRef.current(id).here, top: el.scrollTop });
    };
    document.addEventListener("scroll", on, true);
    return () => document.removeEventListener("scroll", on, true);
  }, []);
  const listScroller = (id: PaneId) => document.querySelector<HTMLElement>(`[data-pane="${id}"] .table-body, [data-pane="${id}"] .grid-scroll`);
  const snapOf = (id: PaneId, withScroll: boolean): PaneSnap => {
    const p = slot(id);
    const t = term.terms[id];
    if (t) return { loc: null, view: p.viewState(), term: t };
    if (!withScroll) return { loc: p.here, view: p.viewState() };
    // this session only: how far down, what is selected and the filter typed (a pane not drawn
    // in a cramped window: how far down it was when last seen)
    const el = listScroller(id);
    const seen = lastTop.current.get(id);
    const top = el ? el.scrollTop : seen && sameLoc(seen.loc, p.here) ? seen.top : 0;
    const selected = [...p.sel.selected];
    const query = p.ent.query;
    return { loc: p.here, view: p.viewState(), ...(top ? { scroll: top } : {}), ...(selected.length ? { selected } : {}), ...(query ? { query } : {}) };
  };
  /** What the workspace on screen shows now. */
  const liveLayout = (withScroll = false): Layout => ({
    tree,
    // all of them: a link kept from another arrangement of these panes comes back with it
    links,
    recent: [activeId, ...recent.filter((x) => x !== activeId && ids.includes(x))],
    panes: Object.fromEntries(ids.map((id) => [id, snapOf(id, withScroll)])),
  });
  const live = liveLayout();
  /** A workspace's layout: the one on screen as it is now, another as it was left. */
  const layoutOf = (id: string): Layout => (id === ws.active ? live : (ws.list.find((w) => w.id === id) ?? wsNow));
  /** The store with the workspace on screen as it is now. */
  const withLive = (s: WorkspaceStore, l: Layout = live) => ({ ...s, list: s.list.map((w) => (w.id === s.active ? { ...w, ...l } : w)) });
  // kept as it changes (dragging a divider changes it on every mouse move: written once it settles),
  // and on the way out
  const liveKey = JSON.stringify(live);
  const flush = useRef(() => {});
  flush.current = () => saveWorkspaces(withLive(ws));
  useEffect(() => {
    const t = window.setTimeout(() => flush.current(), 250);
    return () => window.clearTimeout(t);
  }, [liveKey, ws]);
  useEffect(() => {
    const out = () => flush.current();
    window.addEventListener("pagehide", out);
    window.addEventListener("beforeunload", out);
    return () => {
      window.removeEventListener("pagehide", out);
      window.removeEventListener("beforeunload", out);
    };
  }, []);
  // a cramped window draws only the active pane, anew each time: whichever way it was switched
  // (Tab, an arrow, the palette, the switcher), each list gets back to where it was last seen
  useEffect(() => {
    if (!crampedRef.current) return;
    for (const id of ids) {
      const here = slot(id).here;
      const seen = lastTop.current.get(id);
      if (here && seen?.top && sameLoc(seen.loc, here)) pendingScroll.current.set(id, { ...pendingScroll.current.get(id), loc: here, top: seen.top });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  // a list's place in a workspace that came back: once it is listed again
  useEffect(() => {
    for (const [id, s] of pendingScroll.current) {
      const p = slot(id);
      if (!sameLoc(p.here, s.loc)) {
        if (p.here) pendingScroll.current.delete(id);
        continue;
      }
      if (!p.ent.fresh) continue;
      const el = listScroller(id);
      // not drawn (another pane shows in a cramped window): selected now, the place kept until it is
      if (!el && s.top) {
        if (s.selected) {
          p.sel.setSelected(new Set(s.selected));
          pendingScroll.current.set(id, { loc: s.loc, top: s.top });
        }
        continue;
      }
      pendingScroll.current.delete(id);
      if (s.selected) p.sel.setSelected(new Set(s.selected));
      if (el && s.top) el.scrollTop = s.top;
    }
  });

  const DEFAULT_VIEW: PaneView = { view: "list", sort: null, hidden: null, compact: null, tile: null };
  /**
   * Points the slots at a workspace's panes (`fallback`: where a pane without a place of its own
   * opens; without one, This Mac), and takes its layout and links. Synchronized
   * browsing doesn't follow these moves, and a pane waiting out of step forgets it.
   */
  /**
   * Points slot `id` at a pane as a workspace kept it: its place, how it looked, its Back / Forward
   * and how far down its list was (`fallback`: where it opens without a place; without one, This Mac).
   */
  const fillSlot = (id: PaneId, s: PaneSnap | undefined, hist: HistorySnap | null, fallback: Loc | null, empty = false, seed?: Listing) => {
    const p = slot(id);
    p.closeQuick();
    p.ent.setQuery("");
    p.applyView(s?.view ?? DEFAULT_VIEW);
    opened.current.add(id);
    // a terminal on a connection that no longer exists comes back as an empty file pane
    const t = s?.term && (s.term.profileId === LOCAL_PROFILE || profiles.some((x) => x.id === s.term!.profileId)) ? s.term : undefined;
    term.assign(id, t);
    const at = s?.loc ?? (empty || (s?.term && !t) ? null : fallback);
    const prof = at ? profiles.find((x) => x.id === at.profileId) : null;
    if (t) {
      // a terminal pane: its slot shows no files
      p.showConnection(null);
      p.history.load(null, null);
    } else if (at && prof) {
      p.go(prof, at.bucket, at.prefix, { history: false, seed });
      p.history.load(hist, at);
      void conns.loadBuckets(prof);
      if (s?.query) p.ent.setQuery(s.query);
      if ((s?.scroll || s?.selected?.length) && s.loc) pendingScroll.current.set(id, { loc: s.loc, top: s.scroll ?? 0, selected: s.selected });
      // (its own place, also while a cramped window leaves it undrawn)
      if (s?.scroll && s.loc) lastTop.current.set(id, { loc: s.loc, top: s.scroll });
    } else {
      p.showConnection(null);
      p.history.load(null, null);
      // (a recipe's pane whose connection is gone stays empty, with a note)
      if (!empty) void connectIn(id, THIS_MAC);
    }
  };
  /** `empty`: panes that stay empty (a recipe's, whose connection is gone) */
  const applyLayout = (l: Layout, wsId: string, fallback: Loc | null, focus = true, empty?: Set<PaneId>) => {
    const nextIds = leaves(l.tree);
    const hist = histories.current.get(wsId) ?? {};
    pendingScroll.current.clear();
    // places seen in the layout that leaves (snapshotted by then) would land on the panes that come in
    lastTop.current.clear();
    rec.clearNotes();
    dualPane.quietly(() => {
      for (const id of PANE_IDS) {
        if (!nextIds.includes(id)) {
          if (ids.includes(id)) vacate(id);
          continue;
        }
        fillSlot(id, l.panes[id], hist[id] ?? null, fallback, !!empty?.has(id), keptListings.current.get(`${wsId}\n${id}`));
      }
    });
    dualPane.forgetBehind();
    // used up: this workspace is on screen now, and its panes' own state is the live one
    dropKept((k) => k.startsWith(`${wsId}\n`));
    setTree(l.tree);
    setLinks(l.links);
    setRecent([...l.recent.filter((x) => nextIds.includes(x)), ...nextIds.filter((x) => !l.recent.includes(x))]);
    // the sidebar folds to its rail when that is what it takes to show every pane, as a split
    // does, and comes back when a split had folded it and the panes fit beside it
    const room = paneRoom();
    const need = minSize(l.tree);
    if (room && sideHidden) unfoldIfRoom(l.tree);
    else if (room && need.w > room.w && need.w <= room.w + sideSpare()) {
      autoFold.current = sideSpare();
      toggleSidebar();
    }
    if (focus) focusSoon(l.recent.find((x) => nextIds.includes(x)) ?? nextIds[0]);
  };
  /** Keeps the Back / Forward of the panes on screen for when this workspace comes back. */
  const keepHistories = () => histories.current.set(ws.active, Object.fromEntries(ids.map((id) => [id, slot(id).history.save()])));
  /** Shows workspace `id` (the one on screen is kept as it is). */
  const switchWorkspace = (id: string) => {
    const target = ws.list.find((w) => w.id === id);
    if (!target || id === ws.active) return;
    const now = liveLayout(true);
    keepHistories();
    keepListings(ws.active);
    setWsSettings(null);
    setWs((cur) => ({ ...withLive(cur, now), active: id }));
    applyLayout(target, id, active.here);
  };
  /** Adds a workspace (after the others, or after `after`) and shows it. */
  const addWorkspace = (w: Workspace, after?: string, focus = true, empty?: Set<PaneId>) => {
    const now = liveLayout(true);
    keepHistories();
    keepListings(ws.active);
    setWsSettings(null);
    setWs((cur) => {
      const list = withLive(cur, now).list;
      const at = after ? list.findIndex((x) => x.id === after) + 1 : list.length;
      return { list: [...list.slice(0, at), w, ...list.slice(at)], active: w.id };
    });
    applyLayout(w, w.id, active.here, focus, empty);
  };
  /** "+": one pane where the active pane is (or This Mac), its name ready to type over. */
  const newWorkspace = () => {
    const snap = active.here ? { loc: active.here, view: active.viewState() } : null;
    const w: Workspace = { ...oneLayout(snap), id: newId(), name: nextName(ws.list), color: null, start: "restore", recipe: null };
    addWorkspace(w, undefined, false);
    setWsEditing(w.id);
  };
  const duplicateWorkspace = (id: string) => {
    const src = ws.list.find((w) => w.id === id);
    if (!src) return;
    // a copy of its own: not tied to the source's recipe (updating it there would overwrite the source's)
    const w: Workspace = { ...src, ...copyLayout(layoutOf(id)), id: newId(), name: copyName(ws.list, src.name), recipe: null, start: "restore" };
    addWorkspace(w, id);
  };
  const patchWorkspace = (id: string, patch: Partial<Pick<Workspace, "name" | "color" | "start" | "recipe">>) =>
    setWs((cur) => ({ ...cur, list: cur.list.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  const renameWorkspace = (id: string, name: string) => {
    const n = name.trim().slice(0, 80);
    const before = ws.list.find((w) => w.id === id)?.name;
    if (!n) return;
    patchWorkspace(id, { name: n });
    if (before) rec.renamed(id, before, n);
  };
  /** Shows layout `l` as workspace `id`, in place of what it showed (a reset to its recipe). */
  const replaceWorkspace = (id: string, l: Layout, empty: Set<PaneId>) => {
    histories.current.delete(id);
    dropKept((k) => k.startsWith(`${id}\n`));
    setWsSettings(null);
    if (id === ws.active) {
      setWs((cur) => ({ ...cur, list: cur.list.map((w) => (w.id === id ? { ...w, ...l } : w)) }));
    } else {
      const now = liveLayout(true);
      keepHistories();
      keepListings(ws.active);
      setWs((cur) => {
        const list = withLive(cur, now).list.map((w) => (w.id === id ? { ...w, ...l } : w));
        return { list, active: id };
      });
    }
    applyLayout(l, id, null, true, empty);
  };
  const moveWorkspace = (from: number, to: number) => setWs((cur) => ({ ...cur, list: reorder(cur.list, from, to) }));
  /** The latest of the steps that run after a confirm (by then this render's values are old). */
  const wsLater = useRef({ close: (_id: string) => {}, closeOthers: (_id: string) => {} });
  wsLater.current.close = (id) => {
    const i = ws.list.findIndex((w) => w.id === id);
    const w = ws.list[i];
    if (!w || ws.list.length < 2) return;
    const was = { ...w, ...layoutOf(id) };
    setWsSettings(null);
    histories.current.delete(id);
    dropKept((k) => k.startsWith(`${id}\n`));
    if (id === ws.active) {
      const next = ws.list[i + 1] ?? ws.list[i - 1];
      setWs((cur) => ({ list: cur.list.filter((x) => x.id !== id), active: next.id }));
      applyLayout(next, next.id, null);
    } else setWs((cur) => ({ ...cur, list: cur.list.filter((x) => x.id !== id) }));
    // its shells end now: Undo brings the panes back with fresh terminals, so say so
    const terms = leaves(was.tree).filter((p) => was.panes[p]?.term).length;
    const ended = terms ? (terms === 1 ? "; its terminal ended" : `; its ${terms} terminals ended`) : "";
    toast("info", `Closed “${w.name}”${ended}`, {
      label: "Undo",
      run: () =>
        setWs((cur) => {
          if (cur.list.some((x) => x.id === was.id)) return cur;
          const list = [...cur.list];
          list.splice(Math.min(i, list.length), 0, was);
          return { ...cur, list };
        }),
    });
  };
  wsLater.current.closeOthers = (id) => {
    // as they are now (the one on screen with its live layout), for Undo
    const was = ws.list.map((w) => ({ ...w, ...layoutOf(w.id) }));
    const gone = was.filter((w) => w.id !== id);
    if (!gone.length) return;
    if (id !== ws.active) switchWorkspace(id);
    for (const w of gone) histories.current.delete(w.id);
    setWs((cur) => ({ ...cur, list: cur.list.filter((x) => x.id === id), active: id }));
    // their shells end now: Undo brings the panes back with fresh terminals, so say so
    const terms = gone.reduce((n, w) => n + leaves(w.tree).filter((p) => w.panes[p]?.term).length, 0);
    const ended = terms ? (terms === 1 ? "; a terminal ended" : `; ${terms} terminals ended`) : "";
    toast("info", `Closed ${gone.length === 1 ? `“${gone[0].name}”` : `${gone.length} workspaces`}${ended}`, {
      label: "Undo",
      run: () =>
        setWs((cur) => {
          // back in their old order, around the ones there now
          const list = [...cur.list];
          was.forEach((w, i) => {
            if (!list.some((x) => x.id === w.id)) list.splice(Math.min(i, list.length), 0, w);
          });
          return { ...cur, list };
        }),
    });
  };
  /** Closes a workspace, asking first when it holds several panes. Never the last one. */
  const closeWorkspace = async (id: string) => {
    const w = ws.list.find((x) => x.id === id);
    if (!w || ws.list.length < 2) return;
    const n = paneCount(layoutOf(id));
    const sids = wsSids(id);
    const terms = sids.filter(Boolean).length;
    // a program running in one of its terminals asks for itself; otherwise several panes ask once
    const busy = await busyShells(sids);
    if (busy) {
      if (!(await confirmEndShells(busy, "Close workspace"))) return;
    } else if (n > 1) {
      const ok = await dialogs.confirm({
        title: `Close “${w.name}”?`,
        label: "Close workspace",
        message: (
          <p>
            Its {n} panes and the folders they show close with it{terms ? (terms === 1 ? ", and its terminal ends" : `, and its ${terms} terminals end`) : ""}. No files are
            touched.
          </p>
        ),
      });
      if (!ok) return;
    }
    wsLater.current.close(id);
  };
  const closeOtherWorkspaces = async (id: string) => {
    const others = ws.list.filter((x) => x.id !== id);
    if (!others.length) return;
    const busy = await busyShells(others.flatMap((x) => wsSids(x.id)));
    if (busy) {
      if (!(await confirmEndShells(busy, others.length === 1 ? "Close workspace" : "Close workspaces"))) return;
    } else if (others.some((x) => paneCount(layoutOf(x.id)) > 1)) {
      const ok = await dialogs.confirm({
        title: others.length === 1 ? `Close “${others[0].name}”?` : `Close ${others.length} other workspaces?`,
        label: others.length === 1 ? "Close workspace" : "Close workspaces",
        message: (
          <p>
            {others.length <= 3 ? `${others.map((x) => `“${x.name}”`).join(", ")} and the folders they show close.` : "They close with the folders they show."} Only “
            {ws.list.find((x) => x.id === id)?.name}” stays. No files are touched.
          </p>
        ),
      });
      if (!ok) return;
    }
    wsLater.current.closeOthers(id);
  };
  const stepWorkspace = (d: number) => {
    const n = ws.list.length;
    if (n < 2) return false;
    const i = ws.list.findIndex((w) => w.id === ws.active);
    switchWorkspace(ws.list[(i + d + n) % n].id);
  };
  /** ⌥⌘1–8: that workspace; ⌥⌘9: the last, as browsers do with tabs. */
  const jumpWorkspace = (n: number) => {
    const w = n === 9 ? ws.list[ws.list.length - 1] : ws.list[n - 1];
    if (w) switchWorkspace(w.id);
  };
  const moveActiveWorkspace = (d: number) => {
    const i = ws.list.findIndex((w) => w.id === ws.active);
    if (i + d >= 0 && i + d < ws.list.length) moveWorkspace(i, i + d);
  };
  /** after a menu closes it puts the keyboard back where it was: what opens from it waits a moment */
  const afterMenu = (fn: () => void) => () => window.setTimeout(fn, 40);
  const openWsSettings = (id: string) => {
    const el = document.querySelector<HTMLElement>(`.ws-tab[data-ws="${CSS.escape(id)}"]`);
    if (el) setWsSettings({ id, anchor: el.getBoundingClientRect() });
  };
  const workspaceMenu = (id: string, x: number, y: number) =>
    dialogs.menu(x, y, [
      { type: "item", label: "Rename", icon: "edit", hint: "F2", onClick: afterMenu(() => setWsEditing(id)) },
      { type: "item", label: "Settings…", icon: "settings", onClick: afterMenu(() => openWsSettings(id)) },
      { type: "item", label: "Duplicate", icon: "copy", onClick: () => duplicateWorkspace(id) },
      { type: "sep" },
      { type: "item", label: "Close workspace", icon: "x", disabled: ws.list.length < 2, onClick: () => void closeWorkspace(id) },
      { type: "item", label: "Close other workspaces", disabled: ws.list.length < 2, onClick: () => void closeOtherWorkspaces(id) },
    ]);
  // ------------------------------------------------------------ moving panes
  // A pane dragged by its header's empty part (usePaneDrag) docks beside another or swaps with
  // it, or goes to another workspace: dropped on its tab, or into its layout once resting on the
  // tab has opened it. The panes menu's Move pane ▸ steps it with the keyboard. A pane that moves
  // keeps its slot, place, view, Back / Forward and links; one that changes workspace keeps all
  // but its links (the panes they were with stay behind) and takes a free slot there.
  /** Whether layout `t` fits the room the panes have now. */
  const fitsRoom = (t: PaneNode) => {
    const room = paneRoom();
    const need = minSize(t);
    return !room || (need.w <= room.w + 0.5 && need.h <= room.h + 0.5);
  };
  /** How far down each list on screen is, given back once the layout has changed (a pane that moves to another split is drawn anew). */
  const keepScrolls = () => {
    for (const id of ids) {
      const here = slot(id).here;
      const el = listScroller(id);
      // a pane not drawn now (cramped window): how far down it was when last seen
      const seen = lastTop.current.get(id);
      const top = el ? el.scrollTop : seen && sameLoc(seen.loc, here) ? seen.top : 0;
      if (here && top) pendingScroll.current.set(id, { loc: here, top });
    }
  };
  /** The window gets too small for every pane, or room again: each list keeps its place. */
  const onCramped = (on: boolean) => {
    if (on === crampedRef.current) return;
    crampedRef.current = on;
    // the panes were drawn anew already: their places come from the last scroll seen
    for (const id of ids) {
      const here = slot(id).here;
      const seen = lastTop.current.get(id);
      if (here && seen?.top && sameLoc(seen.loc, here)) pendingScroll.current.set(id, { loc: here, top: seen.top });
    }
    setCramped(on);
  };
  /** The panes on screen laid out as `next` (the same panes, moved): `id` is the one that moved and becomes the active one. */
  const rearrange = (id: PaneId, next: PaneNode) => {
    if (shapeOf(next) === shapeOf(treeRef.current)) return;
    keepScrolls();
    setTree(next);
    setActiveId(id);
    focusSoon(id);
  };
  /** Move pane ▸ Left, Right, Up, Down: past its neighbour that way, greyed out at the window's edge or without room. */
  const moveItems = (id: PaneId): MenuItem[] =>
    (["left", "right", "up", "down"] as const).map((d) => {
      const next = moveToward(treeRef.current, id, d);
      return {
        type: "item",
        label: d[0].toUpperCase() + d.slice(1),
        icon: `arrow-${d}` as const,
        disabled: !next || !fitsRoom(next),
        onClick: () => next && rearrange(id, next),
      };
    });
  /** the pane being dragged: its slot and the workspace it is in (on screen or not, once resting on a tab opened another) */
  const dragFrom = useRef<{ ws: string; id: PaneId } | null>(null);
  /** the dragged pane isn't in the workspace on screen */
  const dragAway = () => !!dragFrom.current && dragFrom.current.ws !== ws.active;
  /** A pane of a workspace not on screen, as it was left there. */
  const keptPane = (wsId: string, id: PaneId) => ({ snap: ws.list.find((w) => w.id === wsId)?.panes[id], hist: histories.current.get(wsId)?.[id] ?? null });
  /** A layout without pane `id`; the only pane leaves an empty one behind (a workspace always has one). */
  const withoutPane = (l: Layout, id: PaneId): Layout => {
    const t = closePane(l.tree, id);
    if (!t) return oneLayout(null);
    const panes = { ...l.panes };
    delete panes[id];
    return { tree: t, links: l.links.filter((x) => !x.includes(id)), recent: l.recent.filter((x) => x !== id), panes };
  };
  /** Takes pane `id` out of workspace `wsId` (not the one on screen). */
  const takeFromKept = (wsId: string, id: PaneId) => {
    const h = histories.current.get(wsId);
    if (h) delete h[id];
    setWs((cur) => ({ ...cur, list: cur.list.map((w) => (w.id === wsId ? { ...w, ...withoutPane(w, id) } : w)) }));
  };
  /** Takes pane `id` off the screen: closed, or as the only one, an empty pane in its place. */
  const takeFromLive = (id: PaneId) => {
    if (closeNow(id)) return;
    vacate(id);
    applyLayout(oneLayout(null), ws.active, null);
  };
  /** Where a pane goes in workspace `l` (dropped on its tab): right of its active pane, else below it; or why it can't. */
  const placeIn = (l: Layout, name: string): { tree: PaneNode; fresh: PaneId } | string => {
    const ls = leaves(l.tree);
    const fresh = freeSlot(l.tree);
    if (!fresh || ls.length >= MAX_PANES) return `“${name}” already shows ${MAX_PANES} panes, the most a workspace can. Close one there first.`;
    const act = l.recent.find((x) => ls.includes(x)) ?? ls[0];
    for (const dir of ["row", "col"] as const) {
      const t = splitPane(l.tree, act, dir, fresh);
      if (fitsRoom(t)) return { tree: t, fresh };
    }
    return `There isn’t room for another pane in “${name}”. Make the window bigger, or close a pane there.`;
  };
  /** Pane `fresh` beside pane `target` on side `zone` of it. */
  const dockAt = (t: PaneNode, target: PaneId, zone: DropZone, fresh: PaneId) =>
    splitPane(t, target, zone === "left" || zone === "right" ? "row" : "col", fresh, zone === "left" || zone === "top");
  /** What dropping the dragged pane on pane `target`'s `zone` would do. */
  const checkDrop = (id: PaneId, target: DropTarget, zone: DropZone): DropCheck => {
    const t = treeRef.current;
    // the outer edge of all the panes: along that whole side
    if (target === "outer") {
      if (zone === "center") return null;
      if (!dragAway()) {
        const next = moveToEdge(t, id, zone);
        if (shapeOf(next) === shapeOf(t)) return null;
        return fitsRoom(next) ? "ok" : { why: "Not enough room" };
      }
      const fresh = freeSlot(t);
      if (!fresh || leaves(t).length >= MAX_PANES) return { why: `${MAX_PANES} panes at most` };
      return fitsRoom(dockEdge(t, fresh, zone)) ? "ok" : { why: "Not enough room" };
    }
    if (!dragAway()) {
      if (target === id) return null;
      const next = movePane(t, id, target, zone);
      if (shapeOf(next) === shapeOf(t)) return null;
      return fitsRoom(next) ? "ok" : { why: "Not enough room" };
    }
    // brought from another workspace: it takes a free slot here
    const fresh = freeSlot(t);
    if (!fresh || leaves(t).length >= MAX_PANES) return { why: `${MAX_PANES} panes at most` };
    return fitsRoom(dockAt(t, target, zone, fresh)) ? "ok" : { why: "Not enough room" };
  };
  const dropPane = (id: PaneId, target: DropTarget, zone: DropZone) => {
    const from = dragFrom.current;
    const outer = target === "outer" && zone !== "center" ? zone : null;
    if (!from || from.ws === ws.active) return rearrange(id, outer ? moveToEdge(treeRef.current, id, outer) : target === "outer" ? treeRef.current : movePane(treeRef.current, id, target, zone));
    // from the workspace it was dragged out of, into a free slot here
    const t = treeRef.current;
    const fresh = freeSlot(t);
    if (!fresh) return;
    const { snap, hist } = keptPane(from.ws, from.id);
    keepScrolls();
    dualPane.quietly(() => fillSlot(fresh, snap, hist, null));
    setTree(outer ? dockEdge(t, fresh, outer) : target === "outer" ? t : dockAt(t, target, zone, fresh));
    setActiveId(fresh);
    focusSoon(fresh);
    takeFromKept(from.ws, from.id);
  };
  /** latest steps for a toast's button (by the time it is clicked this render's values are old) */
  const wsShow = useRef((_id: string) => {});
  wsShow.current = switchWorkspace;
  /** Whether letting go of the dragged pane on workspace `wsId`'s tab moves it there (null: the tab it came from, which only opens). */
  const canToWorkspace = (_id: PaneId, wsId: string) => {
    const from = dragFrom.current;
    const w = ws.list.find((x) => x.id === wsId);
    if (!from || !w || wsId === ws.active) return null;
    if (wsId === from.ws) return null;
    return typeof placeIn(w, w.name) !== "string";
  };
  /** The dragged pane let go on workspace `wsId`'s tab: it moves into that workspace, which stays where it is. */
  const toWorkspace = (_id: PaneId, wsId: string) => {
    const from = dragFrom.current;
    const w = ws.list.find((x) => x.id === wsId);
    if (!from || !w || wsId === from.ws || wsId === ws.active) return;
    const placed = placeIn(w, w.name);
    if (typeof placed === "string") return toast("info", placed);
    const onScreen = from.ws === ws.active;
    const name = onScreen ? nameOf(from.id) : (keptPane(from.ws, from.id).snap?.loc?.prefix.split("/").filter(Boolean).pop() ?? "The pane");
    const { snap, hist } = onScreen ? { snap: snapOf(from.id, true), hist: slot(from.id).history.save() } : keptPane(from.ws, from.id);
    const f = placed.fresh;
    histories.current.set(wsId, { ...histories.current.get(wsId), [f]: hist ?? undefined });
    setWs((cur) => ({
      ...cur,
      list: cur.list.map((x) =>
        x.id !== wsId
          ? x
          : { ...x, tree: placed.tree, links: x.links.filter((l) => !l.includes(f)), recent: [f, ...x.recent.filter((r) => r !== f)], panes: { ...x.panes, [f]: snap } },
      ),
    }));
    if (onScreen) takeFromLive(from.id);
    else takeFromKept(from.ws, from.id);
    toast("info", `Moved “${name}” to “${w.name}”`, { label: "Show", run: () => wsShow.current(wsId) });
  };
  const paneDrag = usePaneDrag({
    // anywhere to move it: another pane, or another workspace (not with one pane at a time in a small window)
    enabled: !cramped && (ids.length > 1 || ws.list.length > 1),
    activeWs: ws.active,
    ghost: (id) => ({ provider: slot(id).profile?.provider, name: nameOf(id) }),
    centre: () => !dragAway(),
    check: checkDrop,
    onDrop: dropPane,
    canToWorkspace,
    onToWorkspace: toWorkspace,
    onSpring: (_id, wsId) => switchWorkspace(wsId),
    onStart: (id) => (dragFrom.current = { ws: ws.active, id }),
    onEnd: () => (dragFrom.current = null),
  });

  // ------------------------------------------------------------ dragging files
  // Items dragged from a list (useFileDrag): onto folders and panes, the sidebar, and other
  // workspaces (their tabs: dropped there, or resting there to open them and drop inside).
  /** A workspace not on screen: its name and the place of its last-used file pane (where a drop on its tab lands). */
  const wsDest = (id: string) => {
    const w = ws.list.find((x) => x.id === id);
    if (!w) return null;
    return { name: w.name, loc: dropPlace(w) };
  };
  const fileDrag = useFileDrag({
    activeWs: ws.active,
    slot,
    profiles,
    rootLabel: conns.rootLabel,
    cross: () => dualCtx.current!,
    transfers,
    autoShowActivity,
    toast,
    wsDest,
    switchWorkspace,
    newWorkspaceAt: (loc) => addWorkspace({ ...oneLayout({ loc, view: DEFAULT_VIEW }), id: newId(), name: nextName(ws.list), color: null, start: "restore", recipe: null }, undefined, false),
    // dropped on a terminal: their paths, typed in
    terminal: { target: term.dropTarget, drop: (pane, from, items) => void term.drop(pane, from, items) },
  });
  beginItemDrag.current = fileDrag.begin;

  // ------------------------------------------------------------ terminal panes
  term.host.current = {
    profiles,
    slot,
    ids,
    activeId,
    fileId,
    splitBelow: (src, fill) => split("col", src, false, fill, true),
    splitAbove: (src, fill) => split("col", src, true, fill, true),
    paneItems: (id) => [
      { type: "submenu", label: "Split", icon: "dual-pane", items: () => splitItems(id) },
      ...(leaves(treeRef.current).length > 1
        ? ([
            { type: "submenu", label: "Move pane", icon: "move", items: () => moveItems(id) },
            { type: "item", label: "Make panes the same size", onClick: () => setTree((t) => equalize(t)) },
            { type: "item", label: "Close other panes", onClick: () => closeOthers(id) },
          ] satisfies MenuItem[])
        : []),
    ],
    setActive: setActiveId,
    focus: focusSoon,
    // the terminal's own Close: asks first when a program runs in it
    close: (id) => void okToEndShells(sidsOf([id]), "Close terminal").then((ok) => ok && paneLater.current.takeFromLive(id)),
    menu: dialogs.menu,
    confirm: dialogs.confirm,
    toast,
    rootLabel: conns.rootLabel,
    connMenu: (id, x, y, current, pick) =>
      dialogs.menu(x, y, [
        // every connection, as the file pane's menu: one that has a shell gets a terminal here, any
        // other turns this pane into its files
        ...connectionMenuItems(profiles, {
          recent: recents.recent,
          skipRecent: current,
          row: (p): MenuItem => ({
            type: "item",
            label: p.name,
            checked: p.id === current || undefined,
            // the shell here ends: asks first when a program runs in it
            onClick: () =>
              p.id !== current &&
              void okToEndShells(sidsOf([id]), "Switch connection").then((ok) => {
                if (!ok) return;
                if (canTerminal(p)) return pick(p.id);
                term.assign(id, undefined);
                setActiveId(id);
                void connectIn(id, p);
                focusSoon(id);
              }),
          }),
        }),
        { type: "sep" },
        { type: "item", label: "New connection…", icon: "plus", onClick: () => setConnDialog({ profile: null }) },
      ]),
  };
  paneLater.current = { close: closeNow, closeOthers: closeOthersNow, takeFromLive };
  // a shell ends once no workspace has its pane any more
  useEffect(() => term.gc(ws), [term.terms, ws]); // eslint-disable-line react-hooks/exhaustive-deps
  rec.host.current = {
    ws,
    layoutOf,
    profiles,
    rootLabel: conns.rootLabel,
    show: replaceWorkspace,
    add: (w, empty) => addWorkspace(w, undefined, true, empty),
    patch: patchWorkspace,
    newEmpty: newWorkspace,
    confirm: dialogs.confirm,
    menu: dialogs.menu,
    toast,
  };

  // refresh listing once all uploads have finished
  useEffect(
    () =>
      transfers.onUploadsSettled((ok, bad, where) => {
        inBackground(() => {
          if (bad) toast("error", `${bad} ${bad === 1 ? "upload" : "uploads"} failed`, { label: "Show", run: showFailed });
          else if (ok) toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
        });
        if (ok) clearAllSizes();
        for (const w of where) if (reloadIfShowing(w.profileId, w.bucket)) break;
      }),
    [transfers, toast, reloadIfShowing, showFailed, clearAllSizes],
  );

  // ------------------------------------------------------------ sidebar
  /** Opens a bucket in the pane that asked (an empty pane), or from the sidebar where "open here" goes. */
  const openBucketIn = (id: PaneId | undefined, p: Profile, name: string) => {
    if (id != null) paneById(id).openBucket(p, name);
    else openHere((pane) => pane.openBucket(p, name));
  };
  const askBucketName = (p: Profile | null = active.profile, id?: PaneId) => {
    if (!p) return;
    dialogs.prompt({
      title: "Open bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Open",
      run: (name) => {
        conns.rememberBucket(p, name);
        openBucketIn(id, p, name);
      },
    });
  };

  /** Kybl Storage: the account owns its buckets, so it can make new ones. */
  const askNewBucket = (p: Profile | null = active.profile, id?: PaneId) => {
    if (!p) return;
    dialogs.prompt({
      title: "New bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Create",
      // a name the server refuses (taken, not allowed) shows in the dialog, with the name kept
      run: async (raw) => {
        const name = raw.trim();
        try {
          await api.createBucket(p.id, name);
        } catch (e) {
          return errSummary(errMessage(e));
        }
        await conns.loadBuckets(p, true);
        conns.setBucketHidden(p, name, false);
        openBucketIn(id, p, name);
        toast("success", `Created ${name}`);
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
    openHere((pane) => pane.go(p, f.bucket, f.prefix));
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
      const saved = await trustOnProfile(p, { certFingerprint: fp });
      forgetCaps(saved.id);
      conns.upsertProfile(saved);
      if (reopen) await connectIn(id, saved);
    },
    // an SFTP server's key (first seen, or changed) trusted from its error: saved the same way
    onTrustHostKey: async (p, fp, reopen) => {
      if (!p.net) return;
      const saved = await trustOnProfile(p, { hostKey: fp });
      forgetCaps(saved.id);
      conns.upsertProfile(saved);
      if (reopen) await connectIn(id, saved);
    },
    // an "encrypt if available" FTP server that offered no encryption: the user agreed to plain FTP
    onAllowPlainFtp: async (p, reopen) => {
      if (!p.net) return;
      await api.ftpAllowPlain(p.net);
      if (reopen) await connectIn(id, p);
    },
    // "Try again" on a connection that failed (timed out before the VPN was up): a fresh connection, then open it
    onRetryConnect: async (p) => {
      await freshConnection(p.id);
      await connectIn(id, p);
    },
    missing: rec.notes[id],
  });

  // the connection in the pane in use: first in Recent, and its kind section and group fold open
  // in the sidebar
  const activeProfile = active.profile;
  // (a section appears once there are a few of a kind: when the active one's section comes or
  // goes, it is revealed again; any other change in the count leaves a group the user shut alone)
  const activeScope = activeProfile ? scopeOf(profiles, activeProfile) : "";
  useEffect(() => {
    if (!activeProfile) return;
    recents.push(activeProfile.id);
    openGroups.reveal(revealKeys(profiles, activeProfile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, activeProfile?.group, activeScope]);

  /** A found or recent connection opens in the pane in use (or just takes the keyboard there, if it's already on screen). */
  const openConnection = (p: Profile) => {
    if (isShellConn(p)) return openShell(p);
    if (sideHidden) sidePeek.close();
    if (fileId == null) return openHere((pane) => void connectIn(pane.id, p));
    showFilePane();
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
  /** Files these connections under group `raw` ("" = the top level). */
  const moveToGroup = (ps: Profile[], raw: string) => {
    const g = normalizeGroup(raw);
    const changes = moveInto(saved, ps.map((p) => p.id), g);
    if (!Object.keys(changes).length) return;
    void applyGroups(changes);
    // follow them there, so they're plain where they went
    if (g) openGroups.reveal(revealKeys(profiles, { ...ps[0], group: g }));
    picks.clear();
  };
  /** Pins these connections, or unpins them when they all are already. */
  const togglePin = async (ids: string[]) => {
    const changes = togglePins(saved, ids);
    if (!Object.keys(changes).length) return;
    try {
      conns.setProfiles(await api.setProfilePins(changes));
      picks.clear();
    } catch (e) {
      toast("error", `Couldn’t pin. ${errMessage(e)}`);
    }
  };
  /** "Move to group" for one or several connections: every group, the top level, or a new one. */
  const groupItems = (ps: Profile[]): MenuItem[] => {
    // the group they all share, ticked
    const shared = new Set(ps.map(groupOf));
    const cur = shared.size === 1 ? [...shared][0] : null;
    const groups = allGroups(saved);
    const who = ps.length === 1 ? ps[0].name : `${ps.length} connections`;
    // the new group and the top level first: a long list of groups can't push them out of reach
    return tidyMenu([
      {
        type: "item",
        label: "New group…",
        icon: "folder-plus",
        onClick: () =>
          dialogs.prompt({
            title: "New group",
            label: `Group for ${who}`,
            initial: "",
            confirmLabel: "Move",
            note: "Use / for a group inside a group, like Clients/Acme.",
            run: (v) => moveToGroup(ps, v),
          }),
      },
      cur !== "" && { type: "item", label: "No group (top level)", icon: "arrow-up", onClick: () => moveToGroup(ps, "") },
      { type: "sep" },
      ...groups.map((g): MenuItem => ({ type: "item", label: groupLabel(g), icon: "folder", checked: g === cur || undefined, onClick: () => moveToGroup(ps, g) })),
    ]);
  };
  /**
   * Right-click on a group's row in the sidebar. A group inside a kind section ("Acme" under
   * SFTP) changes for the connections listed there: what the row shows is what moves.
   */
  const groupMenu = (path: string, scope: string, x: number, y: number) => {
    const listed = inScope(saved, scope);
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
            check: (v) => (normalizeGroup(v).startsWith(`${path}/`) ? "A group can’t go inside itself." : null),
            run: (v) => {
              const to = normalizeGroup(v);
              if (!to || to === path) return;
              void applyGroups(renameGroup(listed, path, to));
              openGroups.update((cur) => renamedOpen(cur, path, to, scope));
            },
          }),
      },
      {
        type: "item",
        // only the folder goes: its connections stay, one level up
        label: parentGroup(path) ? `Delete group (connections move into ${groupLabel(parentGroup(path))})` : "Delete group (connections stay)",
        icon: "arrow-up",
        onClick: () => {
          void applyGroups(ungroup(listed, path));
          openGroups.update((cur) => renamedOpen(cur, path, parentGroup(path), scope));
        },
      },
      { type: "sep" },
      { type: "item", label: "Collapse all", icon: "chevron", disabled: !openGroups.open.size, onClick: openGroups.collapseAll },
    ]);
  };
  /** Right-click on a kind section ("FTP"): fold everything shut, or add another of that kind. */
  const sectionMenu = (s: KindSection, x: number, y: number) =>
    dialogs.menu(x, y, [
      { type: "item", label: openGroups.open.has(s.key) ? "Collapse" : "Expand", icon: "chevron", onClick: () => openGroups.toggle(s.key) },
      { type: "item", label: "Collapse all", icon: "chevron", disabled: !openGroups.open.size, onClick: openGroups.collapseAll },
      { type: "sep" },
      { type: "item", label: `New ${s.label} connection…`, icon: "plus", onClick: () => setConnDialog({ profile: null, startKind: s.kind }) },
    ]);
  /**
   * The folded rail's icon for a kind section: its connections in a menu (a submenu per group
   * first, compact however long the list below them, then the connections at its top), the one on
   * screen ticked.
   */
  const railSection = (s: KindSection, x: number, y: number) => {
    const item = (p: Profile): MenuItem => ({ type: "item", label: p.name, checked: p.id === active.profile?.id || undefined, onClick: () => openConnection(p) });
    // menus go one submenu deep: every group holding connections is one, by its whole path
    const holding: GroupNode[] = [];
    const walk = (n: GroupNode) => {
      for (const g of n.groups) {
        if (g.items.length) holding.push(g);
        walk(g);
      }
    };
    walk(s.tree);
    const level = (n: GroupNode): MenuItem[] =>
      tidyMenu([
        ...holding.map((g): MenuItem => ({ type: "submenu", label: `${groupLabel(g.path)} (${g.items.length})`, icon: "folder", items: () => g.items.map(item) })),
        holding.length > 0 && n.items.length > 0 && { type: "sep" },
        ...n.items.map(item),
      ]);
    dialogs.menu(x, y, [
      { type: "label", label: `${s.label} · ${s.tree.count}` },
      ...level(s.tree),
      { type: "sep" },
      { type: "item", label: `New ${s.label} connection…`, icon: "plus", onClick: () => setConnDialog({ profile: null, startKind: s.kind }) },
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
      // an SSH connection: its terminal first, its files on request
      ...(isShellConn(p)
        ? [
            { type: "item" as const, label: "Open terminal", icon: "terminal" as const, onClick: () => openShell(p) },
            { type: "item" as const, label: "New terminal", icon: "plus" as const, onClick: () => openShell(p, true) },
            { type: "item" as const, label: "Browse files", icon: "folder" as const, onClick: () => openHere((pane) => pane.openBucket(p, "")) },
          ]
        : []),
      isShellConn(p)
        ? null
        : single
        ? { type: "item" as const, label: "Open", icon: "folder" as const, onClick: () => openHere((pane) => pane.openBucket(p, "")) }
        : { type: "item" as const, label: conns.expanded.has(p.id) ? "Collapse" : "Expand", icon: "chevron" as const, onClick: () => toggleConnection(p) },
      // all of this computer is too much to copy in one go: its folders have their own menus
      ...(own ? [] : [{ type: "item" as const, label: "Copy everything to…", icon: "copy" as const, onClick: () => void copyAll() }]),
      ...(own ? [] : driveFor(p, "")),
      ...photoMenuItems(p, dialogs),
      ...tunnelMenuItems(p, toast),
      // This Mac is built in, not saved: it stays where it is
      ...(own
        ? []
        : [
            { type: "sep" as const },
            { type: "item" as const, label: p.pinned ? "Unpin" : "Pin to the top", icon: "pin" as const, onClick: () => void togglePin([p.id]) },
            { type: "item" as const, label: "Select to organize", icon: "check" as const, onClick: () => picks.add(p.id) },
            { type: "submenu" as const, label: "Move to group", icon: "folder" as const, items: () => groupItems(picks.picked.has(p.id) ? saved.filter((x) => picks.picked.has(x.id)) : [p]) },
            { type: "item" as const, label: "Edit connection…", icon: "edit" as const, onClick: () => setConnDialog({ profile: p }) },
          ]),
    ]));
  };
  /**
   * A connection's roots in a menu (the rail's, the pane badge's), with the sidebar's wording and
   * extras: S3 opens a bucket by name, Kybl Storage makes a new one, drives just list.
   */
  const rootMenuItems = (p: Profile, shown: string[], here: string | null, open: (b: string) => void, id: PaneId): MenuItem[] => {
    const caps = peekCaps(p.id);
    const buckets = rootsMode(p, caps) === "buckets";
    const canCreate = caps ? caps.createRoot : p.provider === KYBL;
    const own = p.id === THIS_MAC.id;
    const icon = rootIcon(p.id);
    const extra: MenuItem[] = own
      ? []
      : canCreate
        ? [{ type: "sep" }, { type: "item", label: "New bucket…", icon: "plus", onClick: () => askNewBucket(p, id) }]
        : buckets
          ? [{ type: "sep" }, { type: "item", label: "Open bucket by name…", icon: "plus", onClick: () => askBucketName(p, id) }]
          : [];
    return [
      ...shown.map((b): MenuItem => ({ type: "item", label: conns.rootLabel(p.id, b), icon, checked: b === here || undefined, onClick: () => open(b) })),
      ...(!shown.length ? [{ type: "item" as const, label: conns.bucketsBy[p.id]?.note ?? (buckets ? "No buckets yet" : "Nothing here yet"), disabled: true, onClick: () => {} }] : []),
      ...extra,
    ];
  };
  /** The folded sidebar: a connection's icon lists its buckets (a server's one root just opens). */
  const railPick = async (p: Profile, x: number, y: number) => {
    if (isShellConn(p)) return openShell(p);
    if (fileId == null || !active.profile) return openHere((pane) => void connectIn(pane.id, p));
    if (rootsMode(p, peekCaps(p.id)) === "single") {
      return openHere((pane) => pane.openBucket(p, ""));
    }
    const names = await conns.loadBuckets(p);
    const hidden = new Set(conns.hiddenBuckets[p.id] ?? []);
    const shown = names.filter((b) => !hidden.has(b));
    const here = active.profile?.id === p.id ? active.bucket : null;
    dialogs.menu(x, y, [{ type: "label", label: p.name }, ...rootMenuItems(p, shown, here, (b) => openHere((pane) => pane.openBucket(p, b)), active.id)]);
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
      // pinned, recent, groups, then the rest, with a search over all of them (organizeMenu.ts)
      ...connectionMenuItems(profiles, {
        recent: recents.recent,
        skipRecent: pane.profile?.id,
        row: (p, nested): MenuItem => {
          const current = pane.profile?.id === p.id;
          const single = rootsMode(p, peekCaps(p.id)) === "single";
          // inside a group (and in search results) a menu can't go another level down for the
          // buckets: the row opens the connection, and its buckets are in the pane
          if (single || nested) {
            return {
              type: "item",
              label: p.name,
              checked: current || undefined,
              onClick: () =>
                // an SSH connection opens as its terminal, here as from the sidebar
                isShellConn(p) && !current
                  ? (setActiveId(id), term.shellIn(id, p.id))
                  : single
                    ? open(p, "")
                    : (setActiveId(id), void connectIn(id, p), focusSoon(id)),
            };
          }
          return {
            type: "submenu",
            label: current ? `${p.name} ✓` : p.name,
            items: async () => {
              const names = conns.bucketsBy[p.id]?.names?.length ? conns.bucketsBy[p.id].names : await conns.loadBuckets(p).catch(() => [] as string[]);
              const hidden = new Set(conns.hiddenBuckets[p.id] ?? []);
              const shown = names.filter((b) => !hidden.has(b));
              return rootMenuItems(p, shown, current ? pane.bucket : null, (b) => open(p, b), id);
            },
          };
        },
      }),
      { type: "sep" },
      { type: "item", label: "New connection…", icon: "plus", onClick: () => setConnDialog({ profile: null }) },
    ]);
  };
  /** Right-click on a bucket (or one of this computer's folders) in the sidebar. */
  const bucketMenu = (p: Profile, b: string, x: number, y: number) => {
    const hidden = (conns.hiddenBuckets[p.id] ?? []).includes(b);
    dialogs.menu(x, y, tidyMenu([
      { type: "item", label: "Open", icon: p.id === THIS_MAC.id ? "folder" : "bucket", onClick: () => openHere((pane) => pane.openBucket(p, b)) },
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
    !!document.querySelector(".modal-backdrop, .ctx-menu, .ql-backdrop, .ws-pop, .palette-backdrop");

  const route = useShellCommands({
    active,
    visible: panesRef.current,
    overlayUp,
    settingsOpen,
    openSettings: () => openSettings(),
    closeSettings: () => setSettingsOpen(false),
    shell: {
      undo,
    },
    free: {
      "new-connection": () => setConnDialog({ profile: null }),
      "toggle-sidebar": toggleSidebar,
      "filter-connections": findConnection,
      // grid view: ⌘+ / ⌘− (and a pinch) size the tiles, as Finder's icon view
      // (a terminal has the keyboard: the menu bar took its ⌘+ / ⌘−, so it gets them back as keys)
      "tiles-bigger": () => handBackKey("=", "Equal") || (active.view === "grid" ? active.setTile(Math.min(TILE_MAX, active.tile + 24)) : false),
      "tiles-smaller": () => handBackKey("-", "Minus") || (active.view === "grid" ? active.setTile(Math.max(TILE_MIN, active.tile - 24)) : false),
      "toggle-compact": () => active.setCompact(!active.compact),
      ...dualPane.commands,
      "split-right": () => split("row"),
      "split-down": () => split("col"),
      "close-pane": () => close(),
      "toggle-terminal": () => term.toggle(),
      // the dual pane's old toggle, for anything still sending it
      "toggle-dual": () => (dual ? closeOthers() : split("row")),
      "focus-left": () => focusToward("left"),
      "focus-right": () => focusToward("right"),
      "focus-up": () => focusToward("up"),
      "focus-down": () => focusToward("down"),
      // workspaces
      "new-workspace": newWorkspace,
      "next-workspace": () => stepWorkspace(1),
      "prev-workspace": () => stepWorkspace(-1),
      "move-workspace-left": () => moveActiveWorkspace(-1),
      "move-workspace-right": () => moveActiveWorkspace(1),
      "rename-workspace": () => setWsEditing(ws.active),
      "workspace-settings": () => openWsSettings(ws.active),
      "close-workspace": () => (ws.list.length > 1 ? void closeWorkspace(ws.active) : false),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`workspace-${n}`, () => jumpWorkspace(n)])),
    },
    dual,
    editorOpen: () => !!docRef.current,
    closeEditor,
  });

  // ------------------------------------------------------------ command palette (⌘K)
  const routeRef = useRef(route);
  routeRef.current = route;
  /** ⌘↵ in the palette: a new pane to the right, opened at `fill`'s place */
  const inNewPane = (fill: (fresh: PaneId) => void) => {
    split("row", activeId, false, fill, true);
  };
  const palette = usePalette({
    here: active.here,
    blocked: overlayUp,
    host: () => ({
      profiles,
      builtIn: (p) => p.id === THIS_MAC.id,
      recentConnections: recents.recent,
      rootLabel: conns.rootLabel,
      favorites: settings.favorites,
      active,
      panes: panesRef.current,
      paneCount: ids.length,
      route: (id) => routeRef.current(id),
      openConnection: (p, newPane) => (isShellConn(p) ? openShell(p, newPane) : newPane ? inNewPane((fresh) => void connectIn(fresh, p)) : openConnection(p)),
      openPlace: (loc, newPane, selectKey) => {
        const p = profiles.find((x) => x.id === loc.profileId);
        if (!p) return toast("error", "That connection no longer exists.");
        void conns.loadBuckets(p);
        if (newPane) return inNewPane((fresh) => slot(fresh).go(p, loc.bucket, loc.prefix, { selectKey }));
        openHere((pane) => pane.go(p, loc.bucket, loc.prefix, { selectKey }));
      },
      openFavorite: (f, newPane) => {
        const p = profiles.find((x) => x.id === f.profileId);
        if (newPane && p) inNewPane((fresh) => slot(fresh).go(p, f.bucket, f.prefix));
        else openFavorite(f);
      },
      splitRefusal: (dir) => splitRefusal(dir, activeId),
      closeOtherPanes: () => closeOthers(),
      equalizePanes: () => setTree((t) => equalize(t)),
      syncPartners: facing
        .filter(({ pair: [a, b] }) => a === activeId || b === activeId)
        .map(({ pair: [a, b] }) => {
          const id = a === activeId ? b : a;
          const dir = relation(tree, activeId, id);
          return { id, name: dir ? `the pane ${dir === "up" ? "above" : dir === "down" ? "below" : `to the ${dir}`}` : nameOf(id), on: isLinked(activeId, id) };
        }),
      toggleSync: (id) => toggleSync(activeId, id),
      workspaces: ws.list.map((w) => ({ id: w.id, name: w.name, active: w.id === ws.active })),
      switchWorkspace,
      showActivity: showActivityPanel,
      openSettings,
      importConnections: () => setImportOpen(true),
      undo,
      settings,
      updateSettings,
      settingsOpen,
      closeSettings: () => setSettingsOpen(false),
      toast: (k, t) => toast(k, t),
    }),
  });

  // ------------------------------------------------------------ drag & drop from Finder
  const dropOnArchive = useRef(false);
  /** why a drop on a terminal can't go there (one on a server: these are paths of this computer) */
  const dropOnTermWhy = useRef<string | null>(null);
  /** the server terminal under the pointer (it shows that it takes no files) */
  const dropOnTerm = useRef<PaneId | null>(null);
  const { over: dropOver, refused: dropRefused, tab: finderTab } = useFinderDrop({
    target: (x, y) => {
      dropOnTermWhy.current = null;
      dropOnTerm.current = null;
      dropOnArchive.current = false;
      // a dialog owns the screen: nothing lands behind it
      if (overlayUp()) return null;
      // the pane under the pointer, terminals included; without one (sidebar, no position) the active file pane
      const under = (x != null && y != null ? document.elementFromPoint(x, y)?.closest("[data-pane]")?.getAttribute("data-pane") : null) as PaneId | null;
      // a terminal takes the paths typed in (never an upload), and only one running here
      const t = under ? term.terms[under] : undefined;
      if (under && t) {
        if (t.profileId === THIS_MAC.id) return under;
        dropOnTermWhy.current = REMOTE_TERM_DROP;
        dropOnTerm.current = under;
        return null;
      }
      const p = under ? paneById(under) : activeRef.current;
      // (an archive opens read-only: it takes nothing)
      dropOnArchive.current = !!p.profile && p.archive.inArchive;
      return p.profile && p.bucket != null && !p.archive.inArchive ? p.id : null;
    },
    refusedPane: () => dropOnTerm.current,
    onDrop: (id, paths) => {
      const why = term.dropPaths(id, paths);
      if (why === undefined) void paneById(id).ops.uploadPaths(paths);
      else if (why) toast("info", why);
    },
    // dropped where nothing takes them: behind a dialog, on a pane with no folder open, on a terminal, in an archive
    onRefused: () =>
      toast(
        "info",
        overlayUp()
          ? "Finish what’s open first, then drop the files again."
          : dropOnTermWhy.current
            ? dropOnTermWhy.current
            : dropOnArchive.current
            ? "Archives open read-only. Drop the files on a folder to upload them."
            : "Drop the files on a pane with a folder open to upload them there.",
      ),
    // over a workspace's tab: resting there opens it; letting go uploads into its active pane's folder
    tabs: {
      at: (x, y) => {
        const id = overlayUp() ? null : wsTabAt(x, y);
        return id === ws.active ? null : id;
      },
      accepts: (id) => {
        const at = wsDest(id)?.loc;
        return !!at && profiles.some((p) => p.id === at.profileId);
      },
      onSpring: switchWorkspace,
      onDrop: (id, paths) => {
        const w = wsDest(id);
        const at = w?.loc;
        if (!w || !at) return;
        void activeRef.current.ops.uploadPaths(paths, at.prefix, at).then((ok) => {
          if (ok) toast("info", `Uploading to ${at.prefix ? baseName(at.prefix) : conns.rootLabel(at.profileId, at.bucket)} in “${w.name}”`, { label: "Show", run: () => wsShow.current(id) });
        });
      },
    },
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
      }).concat(mirrorToPane(p, slot(o), dialogs, showJobs));
  };
  const paneProps = (p: Pane) => ({
    pane: p,
    active: p.id === activeId,
    dual,
    label: `Pane ${ids.indexOf(p.id) + 1} of ${ids.length}`,
    dualItems: dualItemsFor(p),
    settings,
    updateSettings,
    dropUpload: dropOver === p.id,
    bucketNote: (p.profile && conns.bucketsBy[p.profile.id]?.note) || null,
    bucketError: (p.profile && conns.bucketsBy[p.profile.id]?.error) || null,
    bucketReconnect: !!(p.profile && conns.bucketsBy[p.profile.id]?.reconnect),
    empty: emptyFor(p.id),
    // one pane: a click splits it, as the dual pane button always did; more: the panes menu
    onSwitchConnection: (x: number, y: number) => switchMenu(p.id, x, y),
    // always the menu, so where the new pane goes is a choice (⌘\ still splits right at once)
    onPanes: (x: number, y: number) => panesMenu(p.id, x, y),
    onTerminal: canTerminal({ id: LOCAL_PROFILE, kind: "local" }) ? () => term.openFor(p.id) : undefined,
    panesItems: () => panesItems(p.id),
    onActivate: () => {
      if (dual && activeId !== p.id) setActiveId(p.id);
    },
    onGrip: paneDrag.grip?.(p.id),
    // (after resting on a tab opened another workspace, this slot may be another pane)
    lifted: paneDrag.dragging === p.id && !dragAway(),
  });
  /** Pane slot `id` on screen: a file pane, or a terminal. */
  const paneView = (id: PaneId, style?: React.CSSProperties) =>
    term.terms[id] ? (
      term.render(id, {
        style,
        active: id === activeId,
        dual,
        onGrip: paneDrag.grip?.(id),
        lifted: paneDrag.dragging === id && !dragAway(),
        drop: dropOver === id ? "paste" : dropRefused === id ? "refuse" : null,
      })
    ) : (
      // keyed by slot: a cramped window draws one pane at a time in the same place, and each
      // must be its own (its list's scroll, open menus, a name being edited)
      <BrowserPane key={id} {...paneProps(slot(id))} style={style} />
    );
  const nameOf =(id: PaneId) => term.nameOf(id) || paneName(slot(id)) || slot(id).profile?.name || "Empty pane";
  const paneSwitcher: PaneSwitcher | null =
    dual && cramped
      ? {
          items: ids.map((id) => ({ id, name: nameOf(id) })),
          activeId,
          onPick: (id) => {
            keepScrolls();
            setActiveId(id);
            focusSoon(id);
          },
        }
      : null;
  const wsOpen = wsSettings ? ws.list.find((w) => w.id === wsSettings.id) : null;

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
          onTerminal={canTerminal({ id: LOCAL_PROFILE, kind: "local" }) ? () => void term.openLocal(undefined, { reuse: true }) : undefined}
          onOpenSync={() => openSettings("sync")}
          onOpenSettings={() => openSettings()}
          onConnectionMenu={connectionMenu}
          onHover={sidePeek.hover}
          recent={recents.recent}
          onMore={findConnection}
          onSection={railSection}
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
            onTerminal={canTerminal({ id: LOCAL_PROFILE, kind: "local" }) ? () => void term.openLocal(undefined, { reuse: true }) : undefined}
          onOpenSync={() => openSettings("sync")}
            onSelectBucket={(p, b) => (isShellConn(p) ? openShell(p) : openHere((pane) => pane.openBucket(p, b)))}
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
            onSectionMenu={sectionMenu}
            onOpenConnection={openConnection}
            picked={picks.picked}
            onTogglePick={(p) => picks.toggle(p.id)}
            onClearPicks={picks.clear}
            onMoveToGroup={(ids, g) => moveToGroup(saved.filter((x) => ids.includes(x.id)), g)}
            onMoveMenu={(ids, x, y) => dialogs.menu(x, y, groupItems(saved.filter((q) => ids.includes(q.id))))}
            onTogglePin={(ids) => void togglePin(ids)}
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
        <WorkspaceBar
          tabs={ws.list.map((w) => ({ id: w.id, name: w.name, color: w.color, panes: paneCount(w.id === ws.active ? live : w) }))}
          activeId={ws.active}
          editingId={wsEditing}
          settingsId={wsSettings?.id ?? null}
          onPick={switchWorkspace}
          onNew={rec.newMenu}
          onEdit={setWsEditing}
          onEditEnd={(id, name) => {
            setWsEditing(null);
            if (name != null) renameWorkspace(id, name);
            if (id === ws.active) focusSoon(activeId);
          }}
          onMenu={workspaceMenu}
          onSettings={(id, anchor) => setWsSettings((cur) => (cur?.id === id ? null : { id, anchor }))}
          onReorder={moveWorkspace}
          switcher={paneSwitcher}
          onFind={palette.toggle}
          dark={isDark(settings)}
          onTheme={() => updateSettings({ theme: isDark(settings) ? "light" : "dark" })}
          drop={paneDrag.tabDrop ?? fileDrag.tabDrop ?? finderTab}
        />
        {paneDrag.view}
        {fileDrag.view}
        <PaneContext.Provider value={{ panes: panesRef.current, active, other, dual, setActive: setActiveId }}>
          {dual ? (
            <div className="content dual-wrap">
              <SplitLayout
                tree={tree}
                activeId={activeId}
                pane={paneView}
                onSizes={(path, sizes) => setTree((t) => setSizes(t, path, sizes))}
                onEqualize={(path) => setTree((t) => equalize(t, path))}
                nameOf={nameOf}
                onCramped={onCramped}
                linked={isLinked}
                onToggleLink={toggleSync}
                canLink={canLink}
              />
            </div>
          ) : (
            paneView(ids[0])
          )}
        </PaneContext.Provider>

        <TransferPanel
          onCancelJob={(id, kind) => (kind === "action" ? stopOrCancel(id) : void api.cancelTransfer(id).catch(() => {}))}
          onDismissJob={jobs.dismiss}
          onOpenJob={(j) => {
            if (j.dest == null) return;
            const p = profiles.find((x) => x.id === j.profileId);
            if (p && j.bucket != null) openHere((pane) => pane.go(p, j.bucket!, j.dest!));
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
            openHere((pane) => pane.go(p, j.spec.dst.root, j.spec.dst.dir));
          }}
          onCancel={transfers.cancel}
          onCancelAll={() => void cancelAllTransfers()}
          onRetry={transfers.retry}
          onRetryAll={() => void transfers.retryAll(true)}
          onOpenLocal={(t) => void openFromConnection(t.local, dialogs.confirm, undefined, t.name).catch((e) => toast("error", `Couldn’t open “${t.name}”. ${errMessage(e)}`))}
          onClear={() => {
            transfers.clearFinished();
            jobs.clearFinished();
          }}
          onClearFailed={() => void clearFailed()}
          onReveal={(t) => revealItemInDir(t.local).catch(() => {})}
          extraShown={editing > 0}
          extra={
            editing > 0 && (
              <Suspense fallback={null}>
                <LazyEditingChip connectionName={(pid) => profiles.find((x) => x.id === pid)?.name ?? ""} onStop={(list) => void edits.stop(list)} onReopen={edits.reopen} onReveal={edits.reveal} />
              </Suspense>
            )
          }
        />
        {editing > 0 && (
          <Suspense fallback={null}>
            <LazyEditConflictHost onStop={(s) => void edits.stop([s])} />
          </Suspense>
        )}
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
          initialPage={settingsPage.page}
          pageRequest={settingsPage.n}
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
            openHere((pane) => void connectIn(pane.id, p));
          }}
          onDeleted={forgetProfile}
        />
      )}
      {connDialog && (
        <ConnectionDialog
          initial={connDialog.profile}
          reconnect={connDialog.reconnect}
          startKind={connDialog.startKind}
          startTab={connDialog.startTab}
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
            // rendered at once: an SSH connection opens as its terminal, which looks the new
            // profile up in the list
            flushSync(() => conns.upsertProfile(p));
            if (isShellConn(p)) openShell(p);
            else openHere((pane) => void connectIn(pane.id, p));
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
        <DocShell sheet={!!doc.sheet} rule={doc.rule && peekCaps(doc.profileId)?.localPaths ? undefined : doc.rule}>
          <Suspense fallback={null}>
            <LazyDocumentView
              ref={editor}
              profileId={doc.profileId}
              bucket={doc.bucket}
              entry={doc.entry}
              mode="full"
              inline={doc.sheet}
              saveRule={doc.rule}
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
        </DocShell>
      )}
      {wsSettings && wsOpen && (
        <WorkspaceSettings
          key={wsOpen.id}
          name={wsOpen.name}
          color={wsOpen.color}
          recipe={rec.view(wsOpen.id)}
          canClose={ws.list.length > 1}
          anchor={wsSettings.anchor}
          onRename={(n) => renameWorkspace(wsOpen.id, n)}
          onColor={(color) => patchWorkspace(wsOpen.id, { color })}
          onSaveRecipe={() => rec.save(wsOpen.id)}
          onResetRecipe={() => {
            setWsSettings(null);
            void rec.reset(wsOpen.id);
          }}
          onDeleteRecipe={() => {
            const r = rec.recipeOf(wsOpen);
            if (r) rec.remove(r.id);
          }}
          onOpenOnLaunch={(on) => patchWorkspace(wsOpen.id, { start: on ? "saved" : "restore" })}
          onStartup={(pane, text) => {
            const r = rec.recipeOf(wsOpen);
            if (r) rec.setLines(r.id, pane, text);
          }}
          onDuplicate={() => duplicateWorkspace(wsOpen.id)}
          onClose={() => {
            setWsSettings(null);
            void closeWorkspace(wsOpen.id);
          }}
          onDismiss={() => setWsSettings(null)}
        />
      )}
      {migrations.element}
      {palette.element}
      {!settingsOpen && <UpdateBanner st={updates} />}
    </div>
  );
}

/**
 * The folded sidebar's overlay: resting on a rail icon brings the whole sidebar in over the
 * panes (nothing moves); it goes once the pointer has left it and no menu from it is up.
 */
const MAC_KEYS = /Mac/i.test(navigator.platform || navigator.userAgent);

/**
 * A menu-bar accelerator took a key that a `[data-own-keys]` element (a terminal) handles itself:
 * hand it back to that element as a keydown, as the palette does for ⌘K. True when handed back.
 */
function handBackKey(key: string, code: string): boolean {
  const el = document.activeElement;
  // a click on the menu item isn't the key: it sizes the tiles
  if (!el?.closest?.("[data-own-keys]") || !menuFromKey()) return false;
  el.dispatchEvent(new KeyboardEvent("keydown", { key, code, metaKey: MAC_KEYS, ctrlKey: !MAC_KEYS, shiftKey: !MAC_KEYS, bubbles: true, cancelable: true }));
  return true;
}

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

/** The document editor full-window ("Open"), or in a sheet ("Edit in Kybl", src/edit). */
function DocShell({ sheet, rule, children }: { sheet: boolean; rule?: SaveRule; children: React.ReactNode }) {
  return sheet ? <EditorSheet rule={rule}>{children}</EditorSheet> : <>{children}</>;
}
