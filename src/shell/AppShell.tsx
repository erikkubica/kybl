/**
 * The desktop app around the browser panes: the sidebar of connections and favorites, the
 * Activity panel, Settings, connection dialogs and the update banner. It owns the panes (one, or
 * two side by side) and routes the sidebar, the keyboard and the menu bar to the active one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { useTransfers } from "../useTransfers";
import { useJobs } from "../useJobs";
import { Sidebar } from "../components/Sidebar";
import { TransferPanel } from "../components/TransferPanel";
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
import { LS, type PaneId } from "../browser/types";
import type { Profile } from "../types";
import { useDialogs } from "./useDialogs";
import { loadExpanded, useConnections } from "./useConnections";
import { PreviewAside, usePreviewLayout } from "./PreviewAside";
import { useFinderDrop } from "./useFinderDrop";
import { useShellCommands } from "./useShellCommands";
import { DualPane } from "./DualPane";
import { makeDualActions, type DualContext } from "./dualActions";
import { PaneContext } from "./PaneContext";

/** Gives a pane's file list keyboard focus (after a sidebar click the arrows should move in it). */
export function focusPaneList(id: PaneId) {
  document.querySelector<HTMLElement>(`[data-pane="${id}"] [data-list-focus]`)?.focus({ preventScroll: true });
}

export function AppShell() {
  const dialogs = useDialogs();
  const { toast } = dialogs;
  const conns = useConnections();
  const { profiles } = conns;
  const [transfersOpen, setTransfersOpen] = useState(true);
  // the activity panel was opened on purpose: it stays up with a note even with nothing going on
  const [activityAsked, setActivityAsked] = useState(false);
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
  // the slider moves the tiles at once; the setting is saved once it settles
  const [tile, setTile] = useState(settings.tileSize);
  const tileTimer = useRef(0);
  const changeTile = (px: number) => {
    setTile(px);
    window.clearTimeout(tileTimer.current);
    tileTimer.current = window.setTimeout(() => updateSettings({ tileSize: px }), 300);
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

  const [connDialog, setConnDialogState] = useState<{ profile: Profile | null } | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  /** Opens the editor for a connection: Kybl Storage connections have their own (no keys to edit). */
  const setConnDialog = useCallback((d: { profile: Profile | null } | null) => {
    if (d?.profile?.provider === KYBL) setKyblDialog({ existing: d.profile });
    else setConnDialogState(d);
  }, []);

  const onError = useCallback((m: string) => toast("error", m), [toast]);
  const showActivity = useCallback(() => setTransfersOpen(true), []);
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
    showActivityPanel,
    reloadIfShowing,
    clearAllSizes,
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
      const pick = preferBucket && names.includes(preferBucket) ? preferBucket : p.bucket || names[0];
      if (pick) paneById(id).openBucket(p, pick, pick === preferBucket ? startPrefix : "");
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
        const start = list.find((p) => p.id === last?.profileId) ?? list[0];
        if (start) void connectIn("left", start, last?.profileId === start.id ? last.bucket : undefined, last?.prefix ?? "");
        // the other connections left open last time list their buckets too
        for (const p of list) if (p !== start && loadExpanded().has(p.id)) void conns.loadBuckets(p);
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
        if (bad) toast("error", `${bad} ${bad === 1 ? "upload" : "uploads"} failed`, { label: "Show", run: showActivity });
        else if (ok) toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
        if (ok) clearAllSizes();
        for (const w of where) if (reloadIfShowing(w.profileId, w.bucket)) break;
      }),
    [transfers, toast, reloadIfShowing, showActivity, clearAllSizes],
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
  };

  const emptyFor = (id: PaneId): EmptyActions => ({
    onConnectKybl: () => setKyblDialog({ existing: null }),
    onAddConnection: () => setConnDialog({ profile: null }),
    onReconnect: (p) => setKyblDialog({ existing: p, reconnect: true }),
    onNewBucket: (p) => askNewBucket(p, id),
    onOpenBucketByName: (p) => askBucketName(p, id),
  });

  // ------------------------------------------------------------ commands (keyboard + menu bar)
  const undo = () => {
    const u = undoStack.pop();
    if (!u) {
      toast("info", "Nothing to undo");
      return;
    }
    toast("info", `Undoing the ${u.label}…`);
    void u.run();
  };

  /** A dialog, menu or preview is up: it owns the keyboard, and actions must not run behind it. */
  const overlayUp = () =>
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
      ...dualPane.commands,
    },
    dual,
  });

  // ------------------------------------------------------------ drag & drop from Finder
  const dropOver = useFinderDrop({
    target: (x, y) => {
      // with two panes, the one under the pointer; else (or without a position) the active one
      const under = x != null && y != null ? document.elementFromPoint(x, y)?.closest("[data-pane]")?.getAttribute("data-pane") : null;
      const p = dualCtx.current?.dual && under ? paneById(under as PaneId) : activeRef.current;
      return p.profile && p.bucket ? p.id : null;
    },
    onDrop: (id, paths) => void paneById(id).ops.uploadPaths(paths),
  });

  // ------------------------------------------------------------ render
  const paneProps = (p: Pane) => ({
    pane: p,
    active: p === active,
    dual,
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
  const aside = (p: Pane) => preview.previewOpen && <PreviewAside pane={p} layout={preview} settings={settings} reloadIfShowing={reloadIfShowing} />;

  return (
    <div className="app">
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
        onReconnect={(p) => setKyblDialog({ existing: p, reconnect: true })}
        favorites={settings.favorites}
        onOpenFavorite={openFavorite}
        onRemoveFavorite={active.actions.removeFavorite}
      />

      <main className="main">
        <PaneContext.Provider value={{ left, right, active, other, dual, setActive: setActiveId }}>
          {dual ? (
            <div className="content dual-wrap" style={previewStyle}>
              <DualPane left={(style) => <BrowserPane {...paneProps(left)} style={style} />} right={(style) => <BrowserPane {...paneProps(right)} style={style} />} />
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
            if (p && j.bucket) active.go(p, j.bucket, j.dest);
          }}
          onOpenSync={() => openSettings("sync")}
          open={transfersOpen}
          onToggle={() => {
            if (transfersOpen) setActivityAsked(false);
            setTransfersOpen(!transfersOpen);
          }}
          showEmpty={activityAsked}
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
          profiles={profiles}
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
            conns.upsertProfile(p);
            void connectIn(activeRef.current.id, p);
          }}
          onDeleted={forgetProfile}
        />
      )}
      {connDialog && (
        <ConnectionDialog
          initial={connDialog.profile}
          onClose={() => setConnDialog(null)}
          onKybl={() => {
            setConnDialog(null);
            setKyblDialog({ existing: null });
          }}
          kyblFirst={!profiles.some((p) => p.provider === KYBL)}
          onSaved={(p) => {
            conns.upsertProfile(p);
            void connectIn(activeRef.current.id, p);
          }}
          onDeleted={forgetProfile}
        />
      )}
      {!settingsOpen && <UpdateBanner st={updates} />}
    </div>
  );
}
