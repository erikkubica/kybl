/**
 * The desktop app around the browser panes: the sidebar of connections and favorites, the
 * Activity panel, Settings, connection dialogs and the update banner. It owns the panes (one, or
 * two side by side) and routes the sidebar, the keyboard and the menu bar to the active one.
 */
import { MountDialog } from "../mount/MountDialog";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { baseName } from "../format";
import { useTransfers } from "../useTransfers";
import { useJobs } from "../useJobs";
import { Sidebar, SidebarRail } from "../components/Sidebar";
import { TransferPanel, type ActivityTab } from "../components/TransferPanel";
import { ConnectionDialog } from "../components/ConnectionDialog";
import { KyblConnectDialog } from "../components/KyblConnectDialog";
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
import { LS, THIS_MAC, type PaneId } from "../browser/types";
import { forgetCaps, peekCaps } from "../useCaps";
import { clearAuthNeeded, useAuthNeeded } from "../connections/authNeeded";
import { rootsMode } from "../connections/roots";
import { canView, LazyDocumentView, viewerFor } from "../viewers/registry";
import { asExport } from "../connections/native";
import type { DocumentHandle } from "../viewers/DocumentView";
import type { Entry } from "../types";
import type { Profile } from "../types";
import { useDialogs } from "./useDialogs";
import { loadExpanded, useConnections } from "./useConnections";
import { PreviewAside, usePreviewLayout } from "./PreviewAside";
import { useFinderDrop } from "./useFinderDrop";
import { useShellCommands } from "./useShellCommands";
import { DualPane, DualTools } from "./DualPane";
import { makeDualActions, type DualContext } from "./dualActions";
import { PaneContext } from "./PaneContext";
import { useMigrationHost } from "./useMigrationHost";

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
  // the slider moves the tiles at once; the setting is saved once it settles
  // (the setting stays the source of truth, so a change in Settings shows at once too)
  const [tileDraft, setTileDraft] = useState<number | null>(null);
  const tile = tileDraft ?? settings.tileSize;
  const tileTimer = useRef(0);
  const changeTile = (px: number) => {
    setTileDraft(px);
    window.clearTimeout(tileTimer.current);
    tileTimer.current = window.setTimeout(() => {
      updateSettings({ tileSize: px });
      setTileDraft(null);
    }, 300);
  };
  const [compact, setCompactState] = useState(LS.get("s3b.compact") === "1");
  const setCompact = (c: boolean) => {
    setCompactState(c);
    LS.set("s3b.compact", c ? "1" : "0");
  };
  const dual = settings.layout === "dual";
  const [activeId, setActiveId] = useState<PaneId>("left");
  // two lists side by side leave little room: the details pane has its own switch there, off at first
  const singlePreview = usePreviewLayout("s3b.preview");
  const dualPreview = usePreviewLayout("s3b.preview.dual", false);
  const preview = dual ? dualPreview : singlePreview;

  const [connDialog, setConnDialogState] = useState<{ profile: Profile | null; reconnect?: boolean } | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
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
    autoShowActivity: () => void (settings.autoOpenTransfers && setTransfersOpen(true)),
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
    ...dualPane.envFor(id),
  });
  const left = usePane(envFor("left"));
  const right = usePane(envFor("right"));
  const active = dual && activeId === "right" ? right : left;
  const other = dual ? (active === left ? right : left) : null;
  panesRef.current = dual ? [left, right] : [left];
  allPanes.current = [left, right];
  dualCtx.current = {
    left,
    right,
    dual,
    activeId: active.id,
    setActive: setActiveId,
    profiles,
    settings,
    updateSettings,
    dialogs,
    transfers,
    autoShowActivity: () => void (settings.autoOpenTransfers && setTransfersOpen(true)),
    focusPane: (id: PaneId) => requestAnimationFrame(() => focusPaneList(id)),
    reloadIfShowing,
    confirmMigration: migrations.confirm,
  };

  /** Sidebar clicks, favorites and new connections open here. */
  const activeRef = useRef(active);
  activeRef.current = active;
  const paneById = (id: PaneId) => allPanes.current.find((p) => p.id === id) ?? left;
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
        const last = settings.restoreLast ? left.savedLocation() : null;
        const all = [...list, THIS_MAC];
        // where it was last time (This Mac too); else the first saved connection
        const start = all.find((p) => p.id === last?.profileId) ?? list[0];
        if (start) void connectIn("left", start, last?.profileId === start.id ? last.bucket : undefined, last?.prefix ?? "");
        // the other connections left open last time list their buckets too
        for (const p of all) if (p !== start && loadExpanded().has(p.id)) void conns.loadBuckets(p);
      })
      .catch((e) => toast("error", errMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // two panes: the right one reopens where it was, or starts at the left one's place
  const rightTried = useRef(false);
  useEffect(() => {
    if (!dual) {
      rightTried.current = false;
      return;
    }
    if (rightTried.current || right.profile || !left.here || !profiles.length) return;
    rightTried.current = true;
    const saved = settings.restoreLast ? right.savedLocation() : null;
    const p = saved && profiles.find((x) => x.id === saved.profileId);
    if (p && saved) right.go(p, saved.bucket, saved.prefix);
    else if (left.profile) right.go(left.profile, left.here.bucket, left.here.prefix);
  }, [dual, left.here, left.profile, right, profiles, settings.restoreLast]);
  // back to one pane: the keyboard goes to the one left on screen
  useEffect(() => {
    if (!dual) setActiveId("left");
  }, [dual]);

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
  });

  /** "Mount as drive…" for a bucket ("" = the whole connection) */
  const askMount = (p: Profile, b: string) =>
    dialogs.show((close) => (
      <MountDialog profileId={p.id} connection={p.name} bucket={b} prefix="" onClose={close} onToast={(k, t) => toast(k, t)} onOpenSettings={() => openSettings("drives")} />
    ));
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
    dialogs.menu(x, y, [
      ...(authNeeded.has(p.id) ? [{ type: "item" as const, label: "Sign in again…", icon: "refresh" as const, onClick: () => setConnDialog({ profile: p, reconnect: true }) }] : []),
      single
        ? { type: "item" as const, label: "Open", icon: "folder" as const, onClick: () => (active.openBucket(p, ""), focusListSoon()) }
        : { type: "item" as const, label: conns.expanded.has(p.id) ? "Collapse" : "Expand", icon: "chevron" as const, onClick: () => toggleConnection(p) },
      // all of this computer is too much to copy in one go: its folders have their own menus
      ...(own ? [] : [{ type: "item" as const, label: "Copy everything to…", icon: "copy" as const, onClick: () => void copyAll() }]),
      ...(own ? [] : [{ type: "item" as const, label: "Mount as drive…", icon: "server" as const, onClick: () => askMount(p, "") }]),
      ...(own ? [] : [{ type: "sep" as const }, { type: "item" as const, label: "Edit connection…", icon: "edit" as const, onClick: () => setConnDialog({ profile: p }) }]),
    ]);
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
  /** Right-click on a bucket (or one of this computer's folders) in the sidebar. */
  const bucketMenu = (p: Profile, b: string, x: number, y: number) => {
    const hidden = (conns.hiddenBuckets[p.id] ?? []).includes(b);
    dialogs.menu(x, y, [
      { type: "item", label: "Open", icon: p.id === THIS_MAC.id ? "folder" : "bucket", onClick: () => (active.openBucket(p, b), focusListSoon()) },
      { type: "item", label: "Copy everything to…", icon: "copy", onClick: () => migrations.open({ profileId: p.id, root: b, items: [{ path: "", isDir: true }] }, "copy") },
      ...(p.id === THIS_MAC.id ? [] : [{ type: "item" as const, label: "Mount as drive…", icon: "server" as const, onClick: () => askMount(p, b) }]),
      { type: "sep" },
      { type: "item", label: hidden ? "Show in the sidebar" : "Hide from the sidebar", icon: hidden ? "eye" : "eye-off", onClick: () => conns.setBucketHidden(p, b, !hidden) },
    ]);
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
    !!(connDialog || kyblDialog || allPanes.current.some((p) => p.quick)) ||
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
      ...dualPane.commands,
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
      // with two panes, the one under the pointer; else (or without a position) the active one
      const under = x != null && y != null ? document.elementFromPoint(x, y)?.closest("[data-pane]")?.getAttribute("data-pane") : null;
      const p = dualCtx.current?.dual && under ? paneById(under as PaneId) : activeRef.current;
      return p.profile && p.bucket != null ? p.id : null;
    },
    onDrop: (id, paths) => void paneById(id).ops.uploadPaths(paths),
    onRefused: () => overlayUp() && toast("info", "Finish what’s open first, then drop the files again."),
  });

  // ------------------------------------------------------------ render
  const paneProps = (p: Pane) => ({
    pane: p,
    active: p === active,
    dual,
    dualTools: dual ? (
      <DualTools
        side={p === left ? "left" : "right"}
        onToOther={() => dualPane.sameFolderInOther(p === left ? "left" : "right")}
        onSwap={dualPane.swap}
        onCompare={dualPane.compare}
        syncBrowsing={settings.syncBrowsing}
        onSyncBrowsing={() => updateSettings({ syncBrowsing: !settings.syncBrowsing })}
      />
    ) : undefined,
    settings,
    updateSettings,
    compact,
    onCompact: setCompact,
    tile,
    onTileSize: changeTile,
    previewOpen: preview.previewOpen,
    onTogglePreview: preview.togglePreview,
    dropUpload: dropOver === p.id,
    bucketNote: (p.profile && conns.bucketsBy[p.profile.id]?.note) || null,
    bucketReconnect: !!(p.profile && conns.bucketsBy[p.profile.id]?.reconnect),
    empty: emptyFor(p.id),
    onToggleDual: () => void dualPane.commands["toggle-dual"](),
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
            bucket={active.bucket}
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
            onHide={toggleSidebar}
            peek={sideHidden}
          />
        </div>
      )}

      <main className="main">
        <PaneContext.Provider value={{ left, right, active, other, dual, setActive: setActiveId }}>
          {dual ? (
            <div className="content dual-wrap" style={previewStyle}>
              <DualPane
                left={(style) => <BrowserPane {...paneProps(left)} style={style} />}
                right={(style) => <BrowserPane {...paneProps(right)} style={style} />}
              />
              {aside(active)}
            </div>
          ) : (
            <BrowserPane {...paneProps(left)} contentStyle={previewStyle} aside={aside(left)} />
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
          onRetryAll={() => void transfers.retryAll()}
          onOpenLocal={(t) => api.openLocal(t.local).catch((e) => toast("error", `Couldn’t open “${t.name}”. ${errMessage(e)}`))}
          onClear={() => {
            transfers.clearFinished();
            jobs.clearFinished();
          }}
          onReveal={(t) => revealItemInDir(t.local).catch(() => {})}
        />
      </main>

      {settingsOpen && (
        <SettingsPage
          settings={settings}
          compact={compact}
          profiles={saved}
          onChange={updateSettings}
          onCompact={setCompact}
          onEditProfile={(p) => setConnDialog({ profile: p })}
          onNewProfile={() => setConnDialog({ profile: null })}
          onClearThumbnails={() =>
            api
              .clearThumbnailCache()
              .then(() => toast("success", "Thumbnail cache cleared"))
              .catch((e) => toast("error", errMessage(e)))
          }
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
          onSaved={(p) => {
            forgetCaps(p.id);
            clearAuthNeeded(p.id);
            conns.upsertProfile(p);
            void connectIn(activeRef.current.id, p);
          }}
          onDeleted={forgetProfile}
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  useEffect(() => {
    if (!folded) setOpen(false);
    return () => window.clearTimeout(timer.current);
  }, [folded]);
  const hover = useCallback((on: boolean) => {
    window.clearTimeout(timer.current);
    if (on) timer.current = window.setTimeout(() => setOpen(true), 280);
  }, []);
  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    const check = () => {
      if (menuUp() || ref.current?.matches(":hover")) timer.current = window.setTimeout(check, 300);
      else setOpen(false);
    };
    timer.current = window.setTimeout(check, 220);
  }, [menuUp]);
  const clicked = useCallback((e: React.MouseEvent) => {
    const t = e.target as Element;
    if (t.closest(".side-item.sub, .fav-row, .side-item.conn.single, .side-toggle")) {
      window.clearTimeout(timer.current);
      setOpen(false);
    }
  }, []);
  return { open, ref, hover, leave, clicked };
}
