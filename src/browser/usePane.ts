/**
 * Everything one browser pane knows and does, for ONE location at a time: where it is, what is
 * listed there, what is selected, the file actions on it, Quick Look and dragging items. The
 * shell creates one per pane and hands it to a BrowserPane to draw; menus, shortcuts and the
 * sidebar act on whichever pane is active through the same object.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { baseName, parentPrefix } from "../format";
import { localParent } from "../connections/roots";
import { useFolderSizes } from "../useFolderSizes";
import { useItemDrag } from "../useItemDrag";
import { peekCaps, useCaps } from "../useCaps";
import { makeFileOps, type FileOps } from "../desktop/fileOps";
import { makeDragOut } from "../desktop/dragOut";
import { crossesDiskAt, viaJobAt, type Place } from "../shell/crossPane";
import type { Sort } from "../components/FileTable";
import type { MenuItem } from "../components/Dialogs";
import type { Settings } from "../settings";
import type { TransferActions } from "../useTransfers";
import type { useJobs } from "../useJobs";
import type { Entry, Profile } from "../types";
import type { Dialogs } from "../shell/useDialogs";
import type { Connections } from "../shell/useConnections";
import type { OpenMigration } from "../shell/useMigrationHost";
import { useEntries } from "./useEntries";
import { useLocation } from "./useLocation";
import { useSelection } from "./useSelection";
import { useEntryActions } from "./useEntryActions";
import { LS, type Loc, type PaneId } from "./types";

/** What a pane gets from the shell. */
export type PaneEnv = {
  id: PaneId;
  /** localStorage key of this pane's last place */
  storageKey: string;
  profiles: Profile[];
  conns: Connections;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  transfers: TransferActions;
  jobs: ReturnType<typeof useJobs>;
  dialogs: Dialogs;
  /** opens the Activity panel if Settings say so (a transfer or job just started) */
  autoShowActivity: () => void;
  showActivity: () => void;
  /** the Activity panel on its Failed tab (a failure toast's "Show") */
  showFailed?: () => void;
  /** opens the Activity panel on purpose (it stays up with a note even when idle) */
  showActivityPanel: () => void;
  /** reloads every pane showing this bucket; true when one did */
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  /** forgets the folder sizes of every pane (something in storage changed) */
  clearAllSizes: () => void;
  /** after this pane moved to another place (synchronized browsing listens) */
  onNavigated?: (from: Loc | null, to: Loc) => void;
  /** items dropped on a place shown in another pane; true when that pane took them */
  dropOnOtherPane?: (items: Entry[], pane: PaneId, dest: string, copy: boolean) => void;
  /** a drop target in another pane: label and whether it accepts these items */
  otherPaneTarget?: (pane: PaneId, dest: string | null, items: Entry[]) => { dest: string; label: string } | null;
  /** extra items for the "…" and empty-space menus (dual pane adds its own) */
  extraPlaceItems?: () => MenuItem[];
  /** extra items for the menu of selected items */
  extraItemItems?: (list: Entry[]) => (MenuItem | false)[];
  /** opens a file in the app's full-window viewer/editor; false when it should open in its own app */
  openDocument?: (e: Entry) => boolean;
  /** whether `openDocument` would take this file */
  canOpenDocument?: (e: Entry) => boolean;
  /** what to call a root on screen ("Desktop" for this computer's /Users/me/Desktop) */
  rootLabel?: (profileId: string, root: string) => string;
  /** folders were renamed, moved or deleted (favorites follow) */
  foldersChanged?: (profileId: string, fromBucket: string, toBucket: string, moves: { from: string; to: string | null }[]) => void;
  /** "Copy to another connection…": opens the job dialog for these items (src/jobs) */
  openMigration?: OpenMigration;
  /** copies or moves items into another place by the route the two need (shell/crossPane.ts) */
  /** opens Settings on its Drives page (the mount dialog's "Open Settings") */
  openDriveSettings?: () => void;
  sendItems?: (ops: FileOps, src: Place, items: Entry[], mode: "copy" | "move", dst: Place, dest: string, onStarted?: () => void) => void;
};

function usePaneCore(env: PaneEnv) {
  const { profiles, settings, dialogs } = env;
  const { toast } = dialogs;
  const envRef = useRef(env);
  envRef.current = env;
  const onError = useCallback((m: string) => envRef.current.dialogs.toast("error", m), []);

  const loc = useLocation(env.storageKey);
  const { bucket, prefix } = loc;
  const profile = useMemo(() => profiles.find((p) => p.id === loc.profileId) ?? null, [profiles, loc.profileId]);
  const here: Loc | null = useMemo(() => (profile && bucket != null ? { profileId: profile.id, bucket, prefix } : null), [profile, bucket, prefix]);
  const hereRef = useRef(here);
  hereRef.current = here;

  // the pane's own view choices (sort, hidden files, compact rows, tile size): what one pane does
  // leaves the other alone. Until a pane is given its own, it follows the app's setting.
  const [sortOwn, setSortOwn] = usePanePref<Settings["sort"]>(`s3b.sort.${env.id}`);
  const [hiddenOwn, setShowHidden] = usePanePref<boolean>(`s3b.hidden.${env.id}`);
  const [compactOwn, setCompact] = usePanePref<boolean>(`s3b.compact.${env.id}`);
  const [tileOwn, setTile] = usePanePref<number>(`s3b.tile.${env.id}`);
  const sortSetting = sortOwn ?? settings.sort;
  const showHidden = hiddenOwn ?? settings.showHiddenFiles;
  const compact = compactOwn ?? LS.get("s3b.compact") === "1";
  const tile = tileOwn ?? settings.tileSize;
  const sort: Sort = useMemo(() => ({ key: sortSetting.by, dir: sortSetting.desc ? "desc" : "asc" }), [sortSetting]);
  const setSort = (s: Sort) => setSortOwn({ by: s.key, desc: s.dir === "desc" });
  const caps = useCaps(profile?.id);
  // this computer's disk hides dotfiles (.DS_Store and the like) unless "Show hidden files" is on
  // (asked per listing, so the old one greyed out while another place loads keeps its rule; caps
  // is a dependency so the answer is asked again once this connection's capabilities arrive)
  const hideDotfilesOf = useCallback(
    (id: string) => !showHidden && !!(id === profile?.id ? caps : peekCaps(id))?.localPaths,
    [showHidden, profile?.id, caps],
  );
  const ent = useEntries(here, sort, settings.foldersFirst, onError, hideDotfilesOf);
  const { lst, sr, search, entries } = ent;
  const sel = useSelection(entries, ent.stale);
  const { setSelected, setCursor } = sel;

  const [busy, setBusy] = useState<string | null>(null);
  const [quick, setQuick] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  /** a key to select once it shows up in the listing of that connection and bucket */
  const pendingSelect = useRef<{ profileId: string; bucket: string; key: string } | null>(null);
  const viewKey = env.id === "left" ? "s3b.view" : `s3b.view.${env.id}`;
  const [view, setViewState] = useState<"list" | "grid">(LS.get(viewKey) === "grid" ? "grid" : "list");
  const setView = (v: "list" | "grid") => {
    setViewState(v);
    LS.set(viewKey, v);
  };

  const folderSizes = useFolderSizes(profile?.id ?? null, bucket, (pre, msg) =>
    toast("error", `Couldn’t add up the size of “${pre ? baseName(pre) : (bucket ?? "")}”. ${msg}`),
  );

  // ------------------------------------------------------------ navigation
  /** Shows a place: the one central way to change connection, bucket or folder. */
  const go = useCallback(
    (p: Profile, b: string, pre: string, opts: { selectKey?: string; history?: boolean } = {}) => {
      const to = { profileId: p.id, bucket: b, prefix: pre };
      const from = hereRef.current;
      loc.set(to, { history: opts.history });
      sr.clear();
      ent.setQuery("");
      setQuick(null);
      setSelected(new Set());
      setCursor(null, true);
      pendingSelect.current = opts.selectKey ? { profileId: p.id, bucket: b, key: opts.selectKey } : null;
      void lst.open(to);
      envRef.current.onNavigated?.(from, to);
    },
    [loc, sr, ent, lst, setSelected, setCursor],
  );

  /**
   * Opens folder `p` of the bucket on screen. Going up (Up, "..", Backspace, ⌘↑, a breadcrumb)
   * selects the folder you came from, like Finder, unless `selectKey` says otherwise.
   */
  const navigate = useCallback(
    (p: string, selectKey?: string) => {
      if (!profile || bucket == null) return;
      const cur = hereRef.current?.prefix ?? "";
      if (selectKey === undefined && p !== cur && cur.startsWith(p)) selectKey = p + cur.slice(p.length).split("/")[0] + "/";
      go(profile, bucket, p, { selectKey });
    },
    [profile, bucket, go],
  );
  const openBucket = useCallback((p: Profile, b: string, startPrefix = "") => go(p, b, startPrefix), [go]);
  /** a root of this computer that sits in another one (Documents in Home): where Up goes from its top */
  const upRoot = profile && bucket ? localParent(profile.id, bucket) : null;

  const historyStep = (delta: number) => {
    const to = loc.history.step(delta);
    const p = to && profiles.find((x) => x.id === to.profileId);
    if (to && p) go(p, to.bucket, to.prefix, { history: false });
  };

  /** A connection with no bucket open yet: nothing listed until one opens. */
  const showConnection = useCallback(
    (id: string | null) => {
      loc.showConnection(id);
      lst.clear();
      sr.clear();
    },
    [loc, lst, sr],
  );

  /** A connection was deleted: drop it from the history and, if on screen, from the pane. */
  const forgetProfile = useCallback(
    (id: string) => {
      loc.history.forget(id);
      if (id === loc.profileId) showConnection(null);
    },
    [loc.history, loc.profileId, showConnection],
  );

  // select a key once it is in the listing (after a rename, new folder, Go to a file…)
  const { listing, fresh } = ent;
  useEffect(() => {
    const ps = pendingSelect.current;
    if (!ps || !fresh || !here || ps.profileId !== here.profileId || ps.bucket !== here.bucket) return;
    if (listing.objects.some((o) => o.key === ps.key) || listing.folders.includes(ps.key)) {
      pendingSelect.current = null;
      setSelected(new Set([ps.key]));
      setCursor(ps.key, true);
    }
  }, [listing, fresh, here, setSelected, setCursor]);

  // a bucket typed into Go to joins the sidebar only once it lists
  const rememberAfterListing = useRef<{ profileId: string; bucket: string } | null>(null);
  const { listError } = ent;
  useEffect(() => {
    const r = rememberAfterListing.current;
    if (!r || !here || r.profileId !== here.profileId || r.bucket !== here.bucket || !fresh || lst.loading) return;
    rememberAfterListing.current = null;
    const p = envRef.current.profiles.find((x) => x.id === r.profileId);
    if (!listError && p) envRef.current.conns.rememberBucket(p, r.bucket);
  }, [here, fresh, lst.loading, listError]);

  // ------------------------------------------------------------ file actions
  const ops = makeFileOps({
    profile,
    bucket,
    prefix,
    folderKeys: ent.folderKeys,
    settings,
    transfers: env.transfers,
    jobs: env.jobs,
    toast,
    autoShowActivity: env.autoShowActivity,
    showActivity: env.showActivity,
    showFailed: env.showFailed,
    setBusy,
    confirm: dialogs.confirm,
    prompt: dialogs.prompt,
    show: dialogs.show,
    resolveConflicts: dialogs.resolveConflicts,
    reloadIfShowing: env.reloadIfShowing,
    selectAfterReload: (profileId, b, key) => {
      pendingSelect.current = key ? { profileId, bucket: b, key } : null;
    },
    deselect: sel.deselect,
    clearSizes: env.clearAllSizes,
    leaveSearch: ent.leaveSearch,
    foldersChanged: (...a) => envRef.current.foldersChanged?.(...a),
    localPaths: !!caps?.localPaths,
    sendItems: (...a) => envRef.current.sendItems?.(opsRef.current, ...a),
  });
  const opsRef = useRef(ops);
  opsRef.current = ops;

  const openEntry = useCallback(
    (e: Entry) => {
      if (e.kind === "folder") navigate(e.key);
      // text, code, Markdown, CSV, JSON and Office files open in the app's editor
      else if (!envRef.current.openDocument?.(e)) void opsRef.current.openInApp(e);
    },
    [navigate],
  );

  // ------------------------------------------------------------ Quick Look
  const quickIndex = quick ? entries.findIndex((e) => e.key === quick) : -1;
  useEffect(() => {
    if (quick && quickIndex < 0) setQuick(null);
  }, [quick, quickIndex]);
  const stepQuick = useCallback(
    (delta: number) => {
      const i = entries.findIndex((e) => e.key === quick);
      const next = entries[i + delta];
      if (!next) return;
      setQuick(next.key);
      setSelected(new Set([next.key]));
      setCursor(next.key, true);
    },
    [entries, quick, setSelected, setCursor],
  );
  const closeQuick = useCallback(() => setQuick(null), []);
  const downloadOne = useCallback((e: Entry) => void opsRef.current.downloadEntries([e]), []);
  const copyFile = useCallback((e: Entry) => void opsRef.current.copyFile(e), []);
  /** Space / F3: opens the preview of the item under the cursor, or closes it. */
  const quickLook = () => {
    if (quick) return setQuick(null);
    const key = sel.cursor.current && sel.selected.has(sel.cursor.current) ? sel.cursor.current : sel.selectedEntries[0]?.key;
    if (key) setQuick(key);
  };

  // ------------------------------------------------------------ press, drag to move
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // dragged out of the window: the items go to another app as files (desktop/dragOut.ts)
  const dragOutCtx = useRef<Parameters<typeof makeDragOut>[0]>(() => null);
  dragOutCtx.current = () =>
    profile && bucket != null
      ? { profileId: profile.id, bucket, localPaths: !!caps?.localPaths, transfers: envRef.current.transfers, autoShowActivity: envRef.current.autoShowActivity }
      : null;
  const dragOut = useMemo(() => makeDragOut(() => dragOutCtx.current()), []);
  const { drag, begin: beginDrag } = useItemDrag({
    paneId: env.id,
    onDrop: (items, dest, copy, destBucket, pane, destProfile) => {
      const e = envRef.current;
      if (pane) e.dropOnOtherPane?.(items, pane, dest, copy);
      // another connection, or a root of this one the server can't copy into: by the route those take
      else if (profile && bucket != null && destBucket != null && e.sendItems && (destProfile ? destProfile !== profile.id : viaJobAt({ profileId: profile.id, bucket }, { profileId: profile.id, bucket: destBucket })))
        e.sendItems(opsRef.current, { profileId: profile.id, bucket }, items, copy ? "copy" : "move", { profileId: destProfile ?? profile.id, bucket: destBucket }, dest);
      else void opsRef.current.relocate(items, dest, copy ? "copy" : "move", destBucket ? { destBucket } : {});
    },
    onSpring: (dest) => navigateRef.current(dest),
    bucketTarget: (pid, b) => {
      if (!profile || search) return null;
      if (pid === profile.id) return b === bucket ? "same" : "other";
      const to = envRef.current.profiles.find((x) => x.id === pid);
      if (!to || !envRef.current.sendItems) return null;
      const root = envRef.current.rootLabel?.(pid, b) ?? b;
      return { label: b ? `“${root}” on ${to.name}` : to.name, copyOnly: crossesDiskAt({ profileId: profile.id, bucket: "" }, { profileId: pid, bucket: b }) };
    },
    paneTarget: (pane, dest, items) => envRef.current.otherPaneTarget?.(pane, dest, items) ?? null,
    dragOut,
  });

  const { select, selRef } = sel;
  const onPress = useCallback(
    (e: Entry, ev: React.MouseEvent) => {
      const { selected: cur, selectedEntries: curEntries } = selRef.current;
      const mods = { meta: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey };
      if (ev.button !== 0) {
        if (ev.button === 2 && cur.has(e.key)) return;
        if (ev.button === 2) select(e, mods);
        return;
      }
      const was = cur.has(e.key);
      if (mods.shift) {
        select(e, mods);
        return;
      }
      if (mods.meta) {
        // ⌘-press, like Finder: an unselected item joins the selection and the lot can be dragged
        // straight away; on a selected item the toggle (deselect) waits for a click without a drag
        if (was) beginDrag(ev, curEntries, () => select(e, mods));
        else {
          select(e, mods);
          beginDrag(ev, [...curEntries, e]);
        }
        return;
      }
      // pressing an item of a multi-selection keeps the selection (so it can be dragged);
      // a click without dragging then narrows it to that item, like Finder
      if (!was) select(e, mods);
      beginDrag(ev, was ? curEntries : [e], was && cur.size > 1 ? () => select(e, mods) : undefined);
    },
    [select, selRef, beginDrag],
  );

  const pane = {
    id: env.id,
    profile,
    bucket,
    /** what the root is called on screen (the bucket's name; "Desktop" for a folder of this computer) */
    bucketLabel: profile && bucket != null ? (env.rootLabel?.(profile.id, bucket) ?? bucket) : bucket,
    prefix,
    here,
    history: loc.history,
    savedLocation: loc.saved,
    sort,
    ent,
    sel,
    ops,
    busy,
    setBusy,
    quick,
    setQuick,
    quickIndex,
    stepQuick,
    closeQuick,
    downloadOne,
    copyFile,
    quickLook,
    folderSizes,
    caps,
    rememberAfterListing,
    searchInput,
    view,
    setView,
    setSort,
    showHidden,
    setShowHidden,
    compact,
    setCompact,
    tile,
    setTile,
    drag,
    onPress,
    go,
    navigate,
    openBucket,
    historyStep,
    showConnection,
    forgetProfile,
    openEntry,
    /** what the list shows while searching is relative to the search's folder */
    relBase: search ? search.loc.prefix : null,
    canUp: !search && (!!prefix || !!upRoot),
    goUp: () => {
      if (search) return;
      if (prefix) return navigate(parentPrefix(prefix));
      // this computer's Documents at its top goes on up to Home (or the disk), selecting it there
      if (upRoot && profile && bucket != null) go(profile, upRoot.root, upRoot.prefix, { selectKey: upRoot.prefix + bucket.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() + "/" });
    },
  };
  return pane;
}

export type PaneCore = ReturnType<typeof usePaneCore>;

/** A pane with its menus and commands (useEntryActions). */
export function usePane(env: PaneEnv) {
  const core = usePaneCore(env);
  const actions = useEntryActions(core, env);
  return { ...core, actions };
}

export type Pane = ReturnType<typeof usePane>;

/**
 * One of a pane's own view choices, kept per pane in localStorage. `null` means "not chosen":
 * the pane follows the app's setting (and setting null hands it back to it).
 */
function usePanePref<T>(key: string): [T | null, (v: T | null) => void] {
  const [v, setV] = useState<T | null>(() => {
    const raw = LS.get(key);
    if (raw == null || raw === "") return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (next: T | null) => {
      setV(next);
      LS.set(key, next == null ? "" : JSON.stringify(next));
    },
    [key],
  );
  return [v, set];
}
