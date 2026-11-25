import type { usePanesHost } from "./usePanesHost";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast } from "../../ui/components/Dialogs";
import type { Settings } from "../../settings/settings";
import type { WorkspaceStore, Workspace } from "../lib/workspaces";
import type { ConnDialogAsk } from "../lib/types";
import type { SettingsPageId } from "../../settings/SettingsPage";
import type { DualContext } from "../components/dualActions";
import { type PaneId, paneKeys, PANE_IDS, THIS_MAC } from "../../browser/types";
import { type EditPlace, useEdit } from "../../edit/hooks/useEdit";
import { peekCaps, forgetCaps } from "../../core/useCaps";
import { useEditCount, type SaveRule } from "../../edit/lib/editStore";
import { type PaneEnv, usePane, type Pane } from "../../browser/hooks/usePane";
import { sendItems } from "../lib/crossPane";
import { tunnelMenuItems } from "../../tunnels/tunnelMenu";
import { useEffect, useRef, useCallback, type RefObject, type Dispatch, type SetStateAction } from "react";
import { TILE_MAX, TILE_MIN } from "../../browser/components/Toolbar";
import { syncedWith, relation, type SyncLink, type PaneNode } from "../lib/paneLayout";
import { focusPaneList } from "../lib/focus";
import { type Profile, type Entry } from "../../core/types";
import { isShellConn } from "../../connections/lib/kinds";
import { forgetPlacesOf } from "../../palette/lib/recent";
import { clearAuthNeeded } from "../../connections/lib/authNeeded";
import { api, errMessage } from "../../core/api";
import { splitDavUrl } from "../../connections/lib/serverHost";
import { loadExpanded, useConnections } from "./useConnections";
import { useDialogs } from "./useDialogs";
import { useJobs } from "../../jobs/hooks/useJobs";
import { useMigrationHost } from "./useMigrationHost";
import { useWorkspaceRecipes } from "./useWorkspaceRecipes";
import { useRecentConnections } from "../../connections/lib/groups";
import { useSidePeek } from "./useSidePeek";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";
import { useTransfers } from "../../transfers/hooks/useTransfers";
import type { Late } from "../lib/late";

export interface UsePaneSlotsDeps {
  activeId: PaneId;
  allPanes: RefObject<Pane[]>;
  autoShowActivity: () => void;
  beginItemDrag: RefObject<((pane: PaneId, ev: React.MouseEvent, items: Entry[], onClick?: () => void) => void) | undefined>;
  canOpenDocument: (id: PaneId, e: Entry) => boolean;
  clearAllSizes: () => void;
  conns: ReturnType<typeof useConnections>;
  dialogs: ReturnType<typeof useDialogs>;
  dual: boolean;
  dualCtx: RefObject<DualContext | null>;
  dualPane: ReturnType<typeof usePanesHost>["dualPane"];
  fileId: PaneId;
  fileIds: (PaneId)[];
  foldersChanged: (pid: string, fromBucket: string, toBucket: string, moves: { from: string; to: string | null; }[]) => void;
  ids: (PaneId)[];
  jobs: ReturnType<typeof useJobs>;
  liveLinks: SyncLink[];
  migrations: ReturnType<typeof useMigrationHost>;
  openDocument: (id: PaneId, e: Entry) => boolean;
  openSettings: (page?: SettingsPageId) => void;
  panesRef: RefObject<Pane[]>;
  profiles: Profile[];
  rec: ReturnType<typeof useWorkspaceRecipes>;
  recent: (PaneId)[];
  recents: ReturnType<typeof useRecentConnections>;
  reloadIfShowing: (pid: string, b: string) => boolean;
  setActiveId: (id: PaneId) => void;
  setConnDialog: (d: ConnDialogAsk | null) => void;
  setDoc: Dispatch<SetStateAction<{ pane: PaneId; profileId: string; bucket: string; entry: Entry; rule?: SaveRule; sheet?: boolean; } | null>>;
  setLinks: Dispatch<SetStateAction<SyncLink[]>>;
  setWs: Dispatch<SetStateAction<WorkspaceStore>>;
  settings: Settings;
  showActivity: () => void;
  showActivityPanel: () => void;
  showFailed: () => void;
  sideHidden: boolean;
  sidePeek: ReturnType<typeof useSidePeek>;
  startSaved: RefObject<boolean>;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  transfers: ReturnType<typeof useTransfers>;
  tree: PaneNode;
  updateSettings: (patch: Partial<Settings>) => void;
  wsNow: Workspace;
  late: Late;
}

/** The pane slots (one pane per slot, always) with what each pane gets from the shell, Edit in another app, and opening connections and places in them. */
export function usePaneSlots(s: UsePaneSlotsDeps) {
  const editPlace = (id: PaneId): EditPlace | null => {
    const p = paneById(id);
    if (!p.profile || p.bucket == null) return null;
    return { profileId: p.profile.id, bucket: p.bucket, onDisk: !!peekCaps(p.profile.id)?.localPaths, ops: p.ops, pane: id };
  };
  const editing = useEditCount();
  const edits = useEdit({
    dialogs: s.dialogs,
    transfers: s.transfers,
    reloadIfShowing: s.reloadIfShowing,
    openInKybl: (place, e, rule) => {
      const id = (place.pane as PaneId | undefined) ?? activeRef.current.id;
      paneById(id).closeQuick();
      s.setDoc({ pane: id, profileId: place.profileId, bucket: place.bucket, entry: e, rule: rule ?? "ifUnchanged", sheet: true });
    },
  });

  const envFor = (id: PaneId): PaneEnv => ({
    id,
    storageKey: paneKeys(id).last,
    profiles: s.profiles,
    conns: s.conns,
    settings: s.settings,
    updateSettings: s.updateSettings,
    transfers: s.transfers,
    jobs: s.jobs,
    dialogs: s.dialogs,
    autoShowActivity: s.autoShowActivity,
    showActivity: s.showActivity,
    showFailed: s.showFailed,
    showActivityPanel: s.showActivityPanel,
    reloadIfShowing: s.reloadIfShowing,
    clearAllSizes: s.clearAllSizes,
    foldersChanged: s.foldersChanged,
    rootLabel: s.conns.rootLabel,
    openDocument: (e) => s.openDocument(id, e),
    canOpenDocument: (e) => s.canOpenDocument(id, e),
    editItems: (e) => {
      const place = editPlace(id);
      return place ? edits.itemsFor(place, e) : [];
    },
    editFile: (e) => {
      const place = editPlace(id);
      if (place) edits.editFile(place, e);
    },
    openMigration: s.migrations.open,
    openDriveSettings: () => s.openSettings("drives"),
    sendItems: (ops, src, items, mode, dst, dest, onStarted) => {
      const to = s.profiles.find((x) => x.id === dst.profileId);
      const names = { connectionName: to?.name ?? "", rootName: s.conns.rootLabel(dst.profileId, dst.bucket), singleRoot: peekCaps(dst.profileId)?.roots === "single" };
      void sendItems(ops, src, items, mode, { ...dst, ...names }, dest, s.dualCtx.current!, onStarted);
    },
    // the empty-space menu's Split ▸ (splitItems is defined further down; this runs on a right-click)
    splitItems: () => [{ type: "submenu", label: "Split", icon: "dual-pane", items: () => s.late.splitItems(id) }],
    beginItemDrag: (...a) => s.beginItemDrag.current?.(...a),
    terminalItems: (key, label) => s.term.items(id, key, label),
    tunnelItems: () => {
      const p = paneById(id).profile;
      return p ? tunnelMenuItems(p, s.toast, () => s.setConnDialog({ profile: p, startTab: "tunnels" })) : [];
    },
    editTunnels: () => {
      const p = paneById(id).profile;
      if (p && p.kind !== "local") s.setConnDialog({ profile: p, startTab: "tunnels" });
    },
    ...s.dualPane.envFor(id),
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
  const active = slot(s.fileId ?? s.activeId);
  /** The file pane `id` pairs with: the one active most recently before it (with two, the other one). */
  const otherOf = (id: PaneId): PaneId | null => s.recent.find((x) => x !== id && s.fileIds.includes(x)) ?? s.fileIds.find((x) => x !== id) ?? null;
  /** the pane active before `id`, a terminal too (where a split came from) */
  const lastBefore = (id: PaneId): PaneId | null => s.recent.find((x) => x !== id && s.ids.includes(x)) ?? null;
  const otherId = s.dual ? otherOf(active.id) : null;
  const other = otherId ? slot(otherId) : null;
  s.panesRef.current = s.fileIds.map(slot);
  s.allPanes.current = slots;
  // a trackpad pinch over a grid (the web view sees a wheel with Ctrl) sizes that pane's tiles
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (!e.ctrlKey || !t?.closest?.(".grid-scroll")) return;
      e.preventDefault();
      const id = t.closest<HTMLElement>("[data-pane]")?.dataset.pane;
      const p = s.allPanes.current.find((x) => x.id === id);
      if (p) p.setTile(Math.round(Math.min(TILE_MAX, Math.max(TILE_MIN, p.tile - e.deltaY * 2))));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);
  s.dualCtx.current = {
    panes: s.panesRef.current,
    pane: slot,
    otherOf,
    syncedWith: (id) => syncedWith(s.liveLinks, id),
    stopSync: (ids) => {
      const set = new Set(ids);
      s.setLinks((cur) => cur.filter(([a, b]) => !(set.has(a) && set.has(b))));
    },
    relation: (a, b) => relation(s.tree, a, b),
    activeId: active.id,
    setActive: s.setActiveId,
    profiles: s.profiles,
    settings: s.settings,
    updateSettings: s.updateSettings,
    dialogs: s.dialogs,
    transfers: s.transfers,
    autoShowActivity: s.autoShowActivity,
    focusPane: (id: PaneId) => requestAnimationFrame(() => focusPaneList(id)),
    reloadIfShowing: s.reloadIfShowing,
    busyFor: (pid, b) => s.panesRef.current.find((p) => p.profile?.id === pid && p.bucket === b)?.setBusy,
    confirmMigration: s.migrations.confirm,
  };

  /** Sidebar clicks, favorites and new connections open here. */
  const activeRef = useRef(active);
  activeRef.current = active;
  const paneById = (id: PaneId) => s.allPanes.current.find((p) => p.id === id) ?? active;
  const focusListSoon = () => {
    const id = activeRef.current.id;
    requestAnimationFrame(() => focusPaneList(id));
  };
  /** A cramped window draws only the active pane: when a terminal has it, the file pane comes forward so what opens there is seen. */
  const showFilePane = () => {
    if (!s.late.crampedRef.current || s.fileId == null || s.activeId === s.fileId) return;
    s.late.keepScrolls();
    s.setActiveId(s.fileId);
  };
  /**
   * Opens something "here" (sidebar, favorites, ⌘K, Activity): in the active file pane, or, when
   * every pane on screen is a terminal, in a new file pane next to the active one (the slot
   * behind a terminal isn't drawn, so opening there would show nothing).
   */
  const openHere = (run: (pane: Pane) => void) => {
    if (s.fileId != null) {
      showFilePane();
      run(activeRef.current);
      return focusListSoon();
    }
    s.late.split("row", s.activeId, false, (fresh) => run(slot(fresh)), true);
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
      s.conns.expand(p.id);
      const names = await s.conns.loadBuckets(p, true);
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
    [s.conns.expand, s.conns.loadBuckets],
  );

  /** An SSH connection opens as a terminal on the server (`another`: a new one beside an open one). */
  const openShell = (p: Profile, another = false) => {
    if (s.sideHidden) s.sidePeek.close();
    s.term.openRemote(p.id, another);
  };

  /** Sidebar click on a connection: folds it open or shut, without leaving what is on screen. */
  const toggleConnection = (p: Profile) => {
    if (isShellConn(p)) return openShell(p);
    if (s.fileId == null || !active.profile) return openHere((pane) => void connectIn(pane.id, p));
    const open = !s.conns.expanded.has(p.id);
    s.conns.setExpandedSaved((cur) => {
      const next = new Set(cur);
      if (open) next.add(p.id);
      else next.delete(p.id);
      return next;
    });
    if (open) void s.conns.loadBuckets(p);
  };

  /** A connection was deleted: drop it from the sidebar, the history and the screen. */
  const forgetProfile = (id: string) => {
    s.recents.forget(id);
    forgetPlacesOf(id);
    clearAuthNeeded(id);
    forgetCaps(id);
    s.conns.dropProfile(id);
    for (const p of s.allPanes.current) p.forgetProfile(id);
    s.term.forget(id);
    // and its terminals in the other workspaces: gone from them, so their shells end (gc)
    s.setWs((cur) => ({
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
        s.conns.setProfiles(list);
        // a WebDAV profile saved before addresses were split still has "user:password@" in profiles.json:
        // one save through the backend moves the password to the vault. Once per launch, never retried,
        // so a failure can't loop.
        for (const p of list) {
          if (p.kind === "webdav" && p.net?.url && splitDavUrl(p.net.url).href !== p.net.url.trim()) {
            api.saveProfile(p).then(s.conns.upsertProfile, () => {});
          }
        }
        const all = [...list, THIS_MAC];
        // opened from its recipe: a pane whose connection isn't on this device stays empty, and says so
        const gone = s.startSaved.current ? s.rec.missingAtLaunch(s.wsNow, (pid) => all.some((x) => x.id === pid)) : {};
        for (const id of Object.keys(gone) as PaneId[]) {
          opened.current.add(id);
          s.term.assign(id, undefined);
          slot(id).showConnection(null);
        }
        // the first pane on screen opens like the one pane always did; the others follow below
        const firstId = s.fileIds.find((id) => !gone[id]) ?? s.ids.find((id) => !gone[id]);
        if (!firstId) return;
        const last = s.settings.restoreLast || s.startSaved.current ? slot(firstId).savedLocation() : null;
        // where it was last time (This Mac too); else the first saved connection
        const start = all.find((p) => p.id === last?.profileId) ?? list[0];
        if (start) void connectIn(firstId, start, last?.profileId === start.id ? last.bucket : undefined, last?.prefix ?? "");
        // the other connections left open last time list their buckets too
        for (const p of all) if (p !== start && loadExpanded().has(p.id)) void s.conns.loadBuckets(p);
      })
      .catch((e) => s.toast("error", errMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // on launch the other panes reopen where they were; one with nowhere to go stays empty and asks
  // what to show (PaneLauncher). A pane made by a split is marked here at once.
  const opened = useRef(new Set<PaneId>());
  const first = slot(s.fileIds.find((id) => !s.rec.notes[id]) ?? s.fileIds[0] ?? s.ids[0]);
  useEffect(() => {
    if (!s.profiles.length) return;
    for (const id of s.ids) {
      // (a terminal's slot shows no files)
      if (id === first.id || s.term.terms[id] || opened.current.has(id)) continue;
      opened.current.add(id);
      const p = slot(id);
      if (p.profile) continue;
      const saved = s.settings.restoreLast || s.startSaved.current ? p.savedLocation() : null;
      const prof = saved && s.profiles.find((x) => x.id === saved.profileId);
      if (prof && saved) p.go(prof, saved.bucket, saved.prefix);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ids, first.id, s.profiles, s.settings.restoreLast]);
  return { editing, edits, slots, slot, active, otherOf, other, activeRef, paneById, showFilePane, openHere, connectIn, openShell, toggleConnection, forgetProfile, opened, lastBefore };
}
