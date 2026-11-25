/**
 * Everything one browser pane knows and does, for ONE location at a time: where it is, what is
 * listed there, what is selected, the file actions on it, Quick Look and dragging items. The
 * shell creates one per pane and hands it to a BrowserPane to draw; menus, shortcuts and the
 * sidebar act on whichever pane is active through the same object.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { baseName, parentPrefix } from "../../core/format";
import { localParent } from "../../connections/lib/roots";
import { useFolderSizes } from "./useFolderSizes";
import { peekCaps, useCaps } from "../../core/useCaps";
import { ANON, busyOwner, makeFileOps, type FileOps } from "../../desktop/components/fileOps";
import type { Place } from "../../shell/lib/crossPane";
import type { Sort } from "../components/list/FileTable";
import type { MenuItem } from "../../ui/components/Dialogs";
import type { GroupBy, Settings } from "../../settings/settings";
import type { TransferActions } from "../../transfers/hooks/useTransfers";
import type { useJobs } from "../../jobs/hooks/useJobs";
import type { Entry, Profile } from "../../core/types";
import type { Dialogs } from "../../shell/hooks/useDialogs";
import type { Connections } from "../../shell/hooks/useConnections";
import type { OpenMigration } from "../../shell/hooks/useMigrationHost";
import { useEntries } from "./useEntries";
import { sameLoc, type Listing } from "./useListing";
import { useLocation } from "./useLocation";
import { useSelection } from "./useSelection";
import { useEntryActions } from "./useEntryActions";
import { useGitStatus } from "./useGitStatus";
import { LS, paneKeys, THIS_MAC, type Loc, type PaneId, type PaneView } from "../types";
import { isContextPress } from "../../ui/lib/pointer";
import { archiveProfile, isArchiveName } from "../../archive/archive";
import { makeArchiveOps } from "../../archive/archiveOps";

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
  /** a press on items that may become a drag of them (the shell's, shell/useFileDrag.tsx); a click without a drag runs `onClick` */
  beginItemDrag?: (pane: PaneId, ev: React.MouseEvent, items: Entry[], onClick?: () => void) => void;
  /** extra items for the "…" and empty-space menus (dual pane adds its own) */
  extraPlaceItems?: () => MenuItem[];
  /** the empty-space menu's last item: Split ▸ Right, Down, Left, Up (the shell's) */
  splitItems?: () => MenuItem[];
  /** "Open terminal here" for folder `key` of this pane's root (the shell's; none where a terminal can't open) */
  terminalItems?: (key: string, label?: string) => MenuItem[];
  /** the "…" menu's Tunnels ▸ (an SFTP connection's tunnels, and adding one) */
  tunnelItems?: () => MenuItem[];
  /** "Add or edit tunnels": the connection form on its Tunnels tab */
  editTunnels?: () => void;
  /** extra items for the menu of selected items */
  extraItemItems?: (list: Entry[]) => (MenuItem | false)[];
  /** opens a file in the app's full-window viewer/editor; false when it should open in its own app */
  openDocument?: (e: Entry) => boolean;
  /** whether `openDocument` would take this file */
  canOpenDocument?: (e: Entry) => boolean;
  /** "Edit", "Edit with ▸", "Edit in Kybl" for one file (src/edit); empty when it can't be edited.
   *  `besideOpen`: listed under Open, which leaves out "Edit in Kybl" when Open already does that */
  editItems?: (e: Entry, besideOpen?: boolean) => MenuItem[];
  /** ⌘E and Quick Look's Edit: edits a file in its default app, uploading saves (src/edit) */
  editFile?: (e: Entry) => void;
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
  // an open archive (src/archive) stands in as a connection of its own
  const profile = useMemo(() => profiles.find((p) => p.id === loc.profileId) ?? (loc.profileId ? archiveProfile(loc.profileId, profiles, THIS_MAC) : null), [profiles, loc.profileId]);
  const here: Loc | null = useMemo(() => (profile && bucket != null ? { profileId: profile.id, bucket, prefix } : null), [profile, bucket, prefix]);
  const hereRef = useRef(here);
  hereRef.current = here;

  // the pane's own view choices (sort, hidden files, compact rows, tile size): what one pane does
  // leaves the other alone. Until a pane is given its own, it follows the app's setting.
  const keys = paneKeys(env.id);
  const [sortOwn, setSortOwn] = usePanePref<Settings["sort"]>(keys.sort);
  const [hiddenOwn, setShowHidden] = usePanePref<boolean>(keys.hidden);
  const [compactOwn, setCompact] = usePanePref<boolean>(keys.compact);
  const [tileOwn, setTile] = usePanePref<number>(keys.tile);
  const [groupOwn, setGroupBy] = usePanePref<GroupBy>(keys.group);
  // the info panel beside the list (remembered per pane, and kept by the workspace)
  const [infoOwn, setInfoOpen] = usePanePref<boolean>(keys.info);
  const [infoWOwn, setInfoW] = usePanePref<number>(keys.infoW);
  const sortSetting = sortOwn ?? settings.sort;
  const showHidden = hiddenOwn ?? settings.showHiddenFiles;
  const compact = compactOwn ?? LS.get("s3b.compact") === "1";
  const tile = tileOwn ?? settings.tileSize;
  const groupBy: GroupBy = groupOwn ?? settings.groupBy ?? "none";
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
  const ent = useEntries(here, sort, settings.foldersFirst, onError, hideDotfilesOf, groupBy);
  const { lst, sr, search, entries } = ent;
  // this computer's folders in a git work tree: the branch and the items' status marks
  const git = useGitStatus(here, !!caps?.localPaths, ent.listing);
  /** why this connection can't search inside files (null: it can, on this computer and SFTP servers) */
  const contentsOff = caps?.localPaths || profile?.kind === "sftp" ? null : "Searching inside files works on this computer and on SSH and SFTP servers";
  // another kind of connection opened in the pane: back to names
  const { mode: searchMode, configure: configureSearch } = sr;
  useEffect(() => {
    if (caps && contentsOff && searchMode === "contents") configureSearch({ mode: "names" });
  }, [caps, contentsOff, searchMode, configureSearch]);
  const sel = useSelection(entries, ent.stale);
  const { setSelected, setCursor } = sel;

  const [busy, setBusyText] = useState<string | null>(null);
  // a Stop next to the busy text (opening a big .tar.gz)
  const [busyStop, setBusyStop] = useState<(() => void) | null>(null);
  const setBusy = useCallback(function setBusy(text: string | null, stop?: () => void, owner?: symbol) {
    // a writer that doesn't say who it is takes the line from whoever had it, so a download
    // listing that ends later doesn't clear this writer's text. While that text shows, the line is
    // marked taken (ANON); when the writer clears it the mark goes, so a listing still running
    // can paint its busy text and Stop again on its next batch
    if (owner) busyOwner.set(setBusy, owner);
    else if (text !== null) busyOwner.set(setBusy, ANON);
    else busyOwner.delete(setBusy);
    setBusyText(text);
    setBusyStop(() => (text && stop ? stop : null));
  }, []);
  const [quick, setQuick] = useState<string | null>(null);
  /** Get Info on several items: Quick Look shows them together (their keys), not one by one */
  const [quickGroup, setQuickGroup] = useState<string[] | null>(null);
  /** Quick Look opened by Get Info: its info column shows, whatever it was left at */
  const [quickInfo, setQuickInfo] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  /** a key to select once it shows up in the listing of that connection and bucket */
  const pendingSelect = useRef<{ profileId: string; bucket: string; key: string } | null>(null);
  const viewKey = keys.view;
  const [view, setViewState] = useState<"list" | "grid">(LS.get(viewKey) === "grid" ? "grid" : "list");
  const setView = (v: "list" | "grid") => {
    setViewState(v);
    LS.set(viewKey, v);
  };
  /** The pane's own view choices as they are (null: following the app's setting), for a workspace to keep. */
  const viewState = (): PaneView => ({ view, sort: sortOwn, hidden: hiddenOwn, compact: compactOwn, tile: tileOwn, group: groupOwn, info: infoOwn, infoW: infoWOwn });
  /** Takes a workspace's view choices back. */
  const applyView = (v: PaneView) => {
    if (v.view !== view) setView(v.view);
    setSortOwn(v.sort);
    setShowHidden(v.hidden);
    setCompact(v.compact);
    setTile(v.tile);
    setGroupBy(v.group ?? null);
    setInfoOpen(v.info ? true : null);
    setInfoW(v.infoW ?? null);
  };

  const folderSizes = useFolderSizes(profile?.id ?? null, bucket, (pre, msg) =>
    toast("error", `Couldn’t add up the size of “${pre ? baseName(pre) : (bucket ?? "")}”. ${msg}`),
  );

  // ------------------------------------------------------------ navigation
  /** Shows a place: the one central way to change connection, bucket or folder. */
  const go = useCallback(
    (p: Profile, b: string, pre: string, opts: { selectKey?: string; history?: boolean; seed?: Listing } = {}) => {
      const to = { profileId: p.id, bucket: b, prefix: pre };
      const from = hereRef.current;
      loc.set(to, { history: opts.history });
      sr.clear();
      ent.setQuery("");
      setQuick(null);
      setSelected(new Set());
      setCursor(null, true);
      pendingSelect.current = opts.selectKey ? { profileId: p.id, bucket: b, key: opts.selectKey } : null;
      // a workspace coming back shows the listing it left with at once, then
      // refreshes it quietly: no spinner, and a failure shows the error line above the kept rows
      if (opts.seed && sameLoc(opts.seed.loc, to)) {
        lst.seed(opts.seed);
        void lst.refresh(to, true, true);
      } else void lst.open(to);
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
    const p = to && (profiles.find((x) => x.id === to.profileId) ?? archiveProfile(to.profileId, profiles, THIS_MAC));
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
    shownKeys: ent.shownKeys,
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
  const archive = makeArchiveOps({
    profile,
    bucket,
    prefix,
    searching: !!search,
    profiles,
    local: THIS_MAC,
    ops,
    transfers: env.transfers,
    toast,
    setBusy,
    resolveConflicts: dialogs.resolveConflicts,
    reloadIfShowing: env.reloadIfShowing,
    selectAfterReload: (profileId, b, key) => {
      pendingSelect.current = key ? { profileId, bucket: b, key } : null;
    },
    autoShowActivity: env.autoShowActivity,
    showActivity: env.showActivity,
    go,
    openMigration: env.openMigration,
  });
  const archiveRef = useRef(archive);
  archiveRef.current = archive;

  const openEntry = useCallback(
    (e: Entry) => {
      if (e.kind === "folder") navigate(e.key);
      // .zip, .tar, .tar.gz open like a folder
      else if (isArchiveName(e.name)) void archiveRef.current.open(e);
      // text, code, Markdown, CSV, JSON and Office files open in the app's editor
      else if (!envRef.current.openDocument?.(e)) void opsRef.current.openInApp(e);
    },
    [navigate],
  );

  // ------------------------------------------------------------ Quick Look
  const quickIndex = quick ? entries.findIndex((e) => e.key === quick) : -1;
  /** a file deleted from Quick Look: where it was, so the preview moves on to the one after it */
  const quickNext = useRef<number | null>(null);
  useEffect(() => {
    if (!quick || quickIndex >= 0) return;
    const at = quickNext.current;
    quickNext.current = null;
    const next = at != null && !quickGroup ? entries[Math.min(at, entries.length - 1)] : undefined;
    if (next) {
      setQuick(next.key);
      setSelected(new Set([next.key]));
      setCursor(next.key, true);
    } else setQuick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quick, quickIndex]);
  useEffect(() => {
    if (quick) return;
    setQuickGroup(null);
    setQuickInfo(false);
    quickNext.current = null;
  }, [quick]);
  const quickEntries = useMemo(
    () => (quickGroup ? quickGroup.map((k) => entries.find((e) => e.key === k)).filter((e): e is Entry => !!e) : null),
    [quickGroup, entries],
  );
  const stepQuick = useCallback(
    (delta: number) => {
      const i = entries.findIndex((e) => e.key === quick);
      const next = entries[i + delta];
      if (!next) return;
      quickNext.current = null;
      setQuickGroup(null);
      setQuick(next.key);
      setSelected(new Set([next.key]));
      setCursor(next.key, true);
    },
    [entries, quick, setSelected, setCursor],
  );
  /** From the items shown together, one of them on its own (the selection stays). */
  const pickQuick = useCallback((e: Entry) => {
    setQuickGroup(null);
    setQuick(e.key);
    setCursor(e.key, true);
  }, [setCursor]);
  const closeQuick = useCallback(() => setQuick(null), []);
  /** Delete from Quick Look: it stays open on the next item once this one is gone (or closes). */
  const deleteFromQuick = useCallback(
    (list: Entry[]) => {
      if (list.length === 1 && !quickGroup) quickNext.current = entries.findIndex((e) => e.key === list[0].key);
      else setQuick(null);
      opsRef.current.askDelete(list);
    },
    [entries, quickGroup],
  );
  const downloadOne = useCallback((e: Entry) => void opsRef.current.downloadEntries([e]), []);
  const copyFile = useCallback((e: Entry) => void opsRef.current.copyFile(e), []);
  /** Space / F3: opens the preview of the item under the cursor, or closes it. */
  const quickLook = () => {
    if (quick) return setQuick(null);
    const key = sel.cursor.current && sel.selected.has(sel.cursor.current) ? sel.cursor.current : sel.selectedEntries[0]?.key;
    if (key) setQuick(key);
  };
  /**
   * Get Info (⌘I, the item menu): Quick Look with its info column, for files and folders alike.
   * Several items show together, with what they add up to.
   */
  const getInfo = (e?: Entry) => {
    const list = e && !sel.selected.has(e.key) ? [e] : sel.selectedEntries;
    if (!list.length) return;
    const lead = e ?? list.find((x) => x.key === sel.cursor.current) ?? list[0];
    setQuickGroup(list.length > 1 ? list.map((x) => x.key) : null);
    setQuickInfo(true);
    setQuick(lead.key);
  };

  // ------------------------------------------------------------ press, drag to move
  // the drag itself is the shell's (shell/useFileDrag.tsx): it outlives this pane's place
  const beginDrag = useCallback(
    (ev: React.MouseEvent, items: Entry[], onClick?: () => void) => envRef.current.beginItemDrag?.(env.id, ev, items, onClick),
    [env.id],
  );

  const { select, selRef } = sel;
  const onPress = useCallback(
    (e: Entry, ev: React.MouseEvent) => {
      const { selected: cur, selectedEntries: curEntries } = selRef.current;
      const mods = { meta: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey };
      // Ctrl+click on a Mac is a right-click: the context menu, not a toggle (nor a drag)
      if (isContextPress(ev) && ev.button === 0) {
        if (!cur.has(e.key)) select(e, { meta: false, shift: false });
        return;
      }
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
    busyStop,
    setBusy,
    quick,
    setQuick,
    quickIndex,
    quickEntries,
    quickInfo,
    stepQuick,
    pickQuick,
    closeQuick,
    deleteFromQuick,
    getInfo,
    downloadOne,
    copyFile,
    quickLook,
    folderSizes,
    caps,
    git,
    contentsOff,
    rememberAfterListing,
    searchInput,
    view,
    setView,
    viewState,
    applyView,
    setSort,
    groupBy,
    setGroupBy,
    showHidden,
    setShowHidden,
    compact,
    setCompact,
    tile,
    setTile,
    infoOpen: !!infoOwn,
    /** the info panel's own width (null: the default) */
    infoW: infoWOwn ?? null,
    setInfoW,
    setInfoOpen: (on: boolean) => setInfoOpen(on ? true : null),
    onPress,
    go,
    navigate,
    openBucket,
    historyStep,
    showConnection,
    forgetProfile,
    openEntry,
    archive,
    /** what the list shows while searching is relative to the search's folder */
    relBase: search ? search.loc.prefix : null,
    canUp: !search && (!!prefix || !!upRoot || archive.inArchive),
    goUp: () => {
      if (search) return;
      if (prefix) return navigate(parentPrefix(prefix));
      // the top of an archive goes up to the folder it's in
      if (archive.upFromTop()) return;
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
  return { ...core, actions, editTunnels: env.editTunnels };
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
