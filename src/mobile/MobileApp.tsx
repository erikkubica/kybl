/**
 * Kybl on a phone or tablet (iOS / Android). Same Rust backend and the same building blocks as the
 * desktop app (api, transfer queue, jobs, preview, connection and move dialogs), laid out for touch.
 *
 * Phones: connections → buckets → folders as a stack of screens with large titles, files open full
 * screen (photos and videos in a swipeable viewer), long-press selects, and the system back
 * gesture / button (or a swipe from the left edge on iPhone) walks back up. Tablets (≥ 900 × 600):
 * connections in a sidebar, files in the middle, details in a panel on the right, like the desktop.
 */
import { asExport } from "../connections/native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { baseName, classify, isPlayableVideo, isWebImage, parentPrefix } from "../format";
import { useTransfers, useTransferList } from "../useTransfers";
import { useJobs } from "../useJobs";
import { applySettings, loadSettings, saveSettings, type Favorite, type Settings } from "../settings";
import { Icon, type IconName } from "../Icons";
import { ConnectionDialog } from "../components/ConnectionDialog";
import type { ConnectionDialogHandle } from "../connections/ConnectionDialog";
import { KyblConnectDialog } from "../components/KyblConnectDialog";
import { KYBL, REVOKED_SAY, isRevokedKey } from "../kybl";
import { ConfirmDialog, PromptDialog, Toasts, type Toast } from "../components/Dialogs";
import { MoveDialog } from "../components/MoveDialog";
import { PreviewPane } from "../components/PreviewPane";
import { FileIcon } from "../components/FileIcon";
import { useUpdates } from "../updates";
import { UpdateBanner } from "../components/UpdateBanner";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { canThumb, thumbsPaused } from "../thumbs";
import type { Entry, ObjInfo, Profile } from "../types";
import { SkeletonList, type PressPoint, type RowHandlers } from "./rows";
import { ActionSheet, type SheetItem } from "./ActionSheet";
import { TransfersButton, TransfersScreen } from "./TransfersScreen";
import { SettingsScreen } from "./SettingsScreen";
// WP-C: phone backup
import { BackupCard, BackupScreen, useBackup, type BackupHandle } from "./BackupScreen";
import { Viewer } from "./Viewer";
import { Lockup, Mascot } from "./Mascot";
import { Layer, Presence, useCollapsed, useWide } from "./ui";
import { FileList } from "./FileList";
import { Connections, HomeScreen, addKind, rootWord, type Buckets } from "./Home";
import { rootsMode } from "../connections/roots";
import { FolderInfo } from "./FolderInfo";
import { DestinationScreen, type SharedFile } from "./DestinationScreen";
import { PullIndicator, useEdgeSwipe, usePullToRefresh } from "./gestures";
import { MIcon, type MIconName } from "./icons";
import { isNetworkError, syncThumbPause, useNetwork, useTransferPrefs } from "./net";
import { useFileOps, type Pill, type ToastAction } from "./useFileOps";
import { locKey, useListing, type Loc } from "./useListing";
import { useKeyboardFit, useSystemBack } from "./useSystemBack";
import { SHEETS, SWIPEABLE, layerElement, layerZ, useLayerStack, type LayerId } from "./layers";
import { DocScreen } from "./DocScreen";
import { ON_DEVICE, connName, isLocal } from "./connName";
import { rootIcon, rootName, setConnectionNames, setRootNames, useRootName, usesListRoots } from "../connections/roots";
import { clearAuthNeeded, useAuthNeeded } from "../connections/authNeeded";
import { LockScreen, useAppLock } from "./AppLock";
import { canView, viewerFor } from "../viewers/registry";
import type { DocumentHandle } from "../viewers/DocumentView";
import { capsFor, forgetCaps, peekCaps, useCaps } from "../useCaps";
import { MigrationDialog, type MigrationSource } from "../jobs";
import { useMigrate } from "./useMigrate";
import "../styles.css";
import "./mobile.css";

type SortKey = "name" | "modified" | "size";
type ViewMode = "auto" | "list" | "grid";

const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const ANDROID = /Android/i.test(navigator.userAgent);
const PHONE_OS = IOS || ANDROID;
/** iPhone and iPad (Android has a system back gesture); also in dev builds, for testing in a browser */
const EDGE_SWIPE = IOS || (import.meta.env.DEV && !ANDROID);
const SORT_LABEL: Record<SortKey, string> = { name: "Name", modified: "Newest first", size: "Largest first" };

const LS = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const readJson = <T,>(k: string, fallback: T): T => {
  try {
    return (JSON.parse(LS.get(k) || "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
};

const sameLoc = (a: Loc, b: Loc) => a.profileId === b.profileId && a.bucket === b.bucket && a.prefix === b.prefix;
const isMedia = (e: Entry) => e.kind === "file" && ((classify(e.name) === "image" && isWebImage(e.name)) || classify(e.name) === "video");
/** Documents (text, code, Markdown, CSV, Office files) open in the app's own document screen; photos keep the viewer. */
const opensAsDoc = (picked: Entry) => {
  // a Google Doc / Sheet / Slides opens as its Office export, read-only (DocumentView)
  const e = picked.native ? asExport(picked) : picked;
  return !!e && e.kind === "file" && canView(e.name, e.size) && (viewerFor(e.name)?.kind !== "image" || !isMedia(e));
};
const toEntry = (o: ObjInfo): Entry => ({ kind: "file", key: o.key, name: baseName(o.key), size: o.size, modified: o.modified, etag: o.etag, storageClass: o.storageClass, native: o.native, mime: o.mime });

/** Where downloads land, in the words people see in their Files app. */
function friendlyFolder(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/$/, "");
  if (IOS && /\/Documents(\/|$)/.test(p)) return `Files › On My ${/iPad/.test(navigator.userAgent) ? "iPad" : "iPhone"} › Kybl`;
  const shared = p.match(/\/storage\/emulated\/\d+\/(.+)$/);
  if (shared && !shared[1].startsWith("Android/")) return shared[1];
  if (/\/Android\/data\//.test(p) || /^\/data\//.test(p)) return "Kybl's own folder (Files › Android › data › Kybl)";
  return p;
}

/** Text size on phones scales the text (see --m-u in mobile.css), not the whole page. */
function applyMobileSettings(s: Settings) {
  document.documentElement.style.setProperty("--m-scale", String(s.scale || 1));
  applySettings({ ...s, scale: 1 });
}

/**
 * Watches download batches in the transfer list and reports each once it has finished. It sits
 * in its own tiny component so transfer progress re-renders only this, never the file list.
 */
function DownloadWatch({ batches }: { batches: React.RefObject<Map<string, { ids: Set<string>; done: (ok: string[], failed: number) => void }>> }) {
  const list = useTransferList();
  useEffect(() => {
    const map = batches.current;
    if (!map?.size) return;
    const byId = new Map(list.map((t) => [t.id, t]));
    for (const [k, b] of map) {
      const ts = [...b.ids].map((id) => byId.get(id));
      if (ts.some((t) => t && (t.state === "queued" || t.state === "running"))) continue;
      map.delete(k);
      const ok = ts.filter((t) => t?.state === "done").map((t) => t!.local);
      b.done(ok, ts.filter((t) => t?.state === "error").length);
    }
  }, [list, batches]);
  return null;
}

export default function MobileApp() {
  const wide = useWide();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const listed = useMemo(() => (profiles ? [...profiles, ON_DEVICE] : null), [profiles]);
  useEffect(() => setConnectionNames(profiles ?? []), [profiles]);
  /** what a root is called on screen (drive ids, this device's paths, a server's "") */
  const rootLabel = useRootName();
  const [buckets, setBuckets] = useState<Record<string, Buckets>>({});
  const [loc, setLoc] = useState<Loc | null>(null);
  const [nav, setNav] = useState<"in" | "out">("in");
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
  const [detail, setDetail] = useState<Entry | null>(null);
  /** the photo or video open in the viewer, by key, so a refresh can't swap it for another */
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  // the closing viewer still runs its last slide for a moment: paging then must not reopen it
  const viewerOpen = useRef(false);
  viewerOpen.current = viewerKey !== null;
  const [sheet, setSheet] = useState<{ title?: string; message?: string; items: SheetItem[] } | null>(null);
  const [folderInfo, setFolderInfo] = useState<{ prefix: string; name: string } | null>(null);
  /** files shared into Kybl from another app, waiting for a destination */
  const [intake, setIntake] = useState<{ files: SharedFile[]; at: Loc | null } | null>(null);
  /** a document open full screen, with the bucket it is in */
  const [doc, setDoc] = useState<{ entry: Entry; profileId: string; bucket: string } | null>(null);
  const docRef = useRef<DocumentHandle>(null);
  /** progress pills of running operations, oldest first */
  const [pills, setPills] = useState<[string, Pill][]>([]);
  const setPill = useCallback((id: string, p: Pill | null) => {
    setPills((cur) => {
      if (!p) return cur.some(([k]) => k === id) ? cur.filter(([k]) => k !== id) : cur;
      return cur.some(([k]) => k === id) ? cur.map((x) => (x[0] === id ? [id, p] : x)) : [...cur, [id, p]];
    });
  }, []);
  // buckets left out of the connection lists, per connection (all show until one is hidden)
  const [hiddenBuckets, setHiddenBuckets] = useState<Record<string, string[]>>(() => readJson<Record<string, string[]>>("m.hiddenBuckets", {}));
  const [choosing, setChoosing] = useState<string | null>(null);
  const setBucketHidden = useCallback((p: Profile, name: string, hide: boolean) => {
    void api.haptic("selection");
    setHiddenBuckets((cur) => {
      const list = (cur[p.id] ?? []).filter((b) => b !== name);
      const next = { ...cur, [p.id]: hide ? [...list, name] : list };
      if (!next[p.id].length) delete next[p.id];
      LS.set("m.hiddenBuckets", JSON.stringify(next));
      return next;
    });
  }, []);
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // WP-C: phone backup ("setup" opens straight into setting one up)
  const [backupOpen, setBackupOpen] = useState<false | "list" | "setup">(false);
  const backup = useBackup(PHONE_OS || import.meta.env.DEV);
  const backupHandle = useRef<BackupHandle | null>(null);
  const [backupCardHidden, setBackupCardHidden] = useState(() => LS.get("m.backupCard") === "hidden");
  const backupHere = !!backup.overview && backup.overview.platform !== "desktop";
  const openTransfers = useCallback(() => setTransfersOpen(true), []);
  const [connDialog, setConnDialog] = useState<{ profile: Profile | null; reconnect?: boolean } | null>(null);
  const connRef = useRef<ConnectionDialogHandle>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  /** Kybl Storage connections have their own editor: there are no keys to edit. */
  const editProfile = useCallback((p: Profile) => {
    if (p.provider === KYBL) setKyblDialog({ existing: p });
    else setConnDialog({ profile: p });
  }, []);
  /** A Google Drive / OneDrive / Dropbox connection whose access ended: sign in again, same id. */
  const signInAgain = useCallback((p: Profile) => setConnDialog({ profile: p, reconnect: true }), []);
  const authNeeded = useAuthNeeded();
  const connectKybl = useCallback(() => setKyblDialog({ existing: null }), []);
  const [confirm, setConfirm] = useState<null | { title: string; message: React.ReactNode; label: string; danger?: boolean; run: () => void }>(null);
  const [prompt, setPrompt] = useState<null | { title: string; label: string; initial: string; confirmLabel: string; note?: string; run: (v: string) => void }>(null);
  const [moveDialog, setMoveDialog] = useState<null | { items: Entry[]; mode: "move" | "copy" }>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** `done` is false while the scan runs; matches stream into `results` as pages are checked */
  const [search, setSearch] = useState<{ query: string; results: ObjInfo[]; truncated: boolean; scanned: number; done: boolean } | null>(null);
  const searchOp = useRef<string | null>(null);
  const searching = !!search && !search.done;
  /** stops a running scan on the server side too */
  const stopSearch = useCallback(() => {
    if (searchOp.current) api.cancelTransfer(searchOp.current).catch(() => {});
    searchOp.current = null;
    setSearch(null);
  }, []);
  useEffect(() => {
    const off = listen<{ opId: string; scanned: number; found: ObjInfo[] }>("search-progress", (e) => {
      if (e.payload.opId !== searchOp.current) return;
      setSearch((s) => (s && !s.done ? { ...s, scanned: e.payload.scanned, results: e.payload.found.length ? [...s.results, ...e.payload.found] : s.results } : s));
    });
    return () => {
      off.then((f) => f());
    };
  }, []);
  const [sort, setSortState] = useState<SortKey>((LS.get("m.sort") as SortKey) || "name");
  const [view, setViewState] = useState<ViewMode>((LS.get("m.view") as ViewMode) || "auto");
  const [recent, setRecent] = useState<Loc[]>(() => readJson<Loc[]>("m.recent", []));
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const [prefs, savePrefs] = useTransferPrefs();
  const updates = useUpdates();
  const lock = useAppLock(settings.appLock);

  const toast = useCallback((kind: Toast["kind"], text: string, action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : kind === "error" ? 6000 : 2800);
  }, []);
  const onError = useCallback((m: string) => toast("error", errSummary(m)), [toast]);
  const transfers = useTransfers(onError);
  const jobs = useJobs();

  const updateSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
    applyMobileSettings(s);
  };
  // the page zoom set at launch would scale everything; phones scale the text instead
  useEffect(() => {
    document.documentElement.classList.toggle("m-ios", IOS);
    applyMobileSettings(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // where downloads go (Android falls back to the app's own folder where it can't use Download)
  useEffect(() => {
    api.downloadFolder().then(setDownloadDir).catch(() => {});
  }, []);
  const savedWhere = downloadDir ? friendlyFolder(downloadDir) : IOS ? "Files › On My iPhone › Kybl" : "Download/Kybl";

  // the launch splash in index.html stays until the first screen is ready
  useEffect(() => {
    if (profiles === null && !profilesError) return;
    const s = document.getElementById("splash");
    if (!s) return;
    s.classList.add("gone");
    const t = window.setTimeout(() => s.remove(), 400);
    return () => window.clearTimeout(t);
  }, [profiles, profilesError]);

  // ------------------------------------------------------------ data
  // a bucket typed in "Open bucket by name": kept with its connection once it opens, dropped if it doesn't
  const pendingBucket = useRef<{ profileId: string; bucket: string } | null>(null);
  const settleBucket = useCallback((l: Loc, ok: boolean) => {
    const pb = pendingBucket.current;
    if (!pb || pb.profileId !== l.profileId || pb.bucket !== l.bucket) return;
    pendingBucket.current = null;
    if (ok) {
      const extra = readJson<Record<string, string[]>>("m.extraBuckets", {});
      if (!(extra[pb.profileId] ?? []).includes(pb.bucket)) {
        extra[pb.profileId] = [...(extra[pb.profileId] ?? []), pb.bucket];
        LS.set("m.extraBuckets", JSON.stringify(extra));
      }
    } else {
      setBuckets((m) => {
        const cur = m[pb.profileId];
        return cur ? { ...m, [pb.profileId]: { ...cur, names: cur.names.filter((n) => n !== pb.bucket) } } : m;
      });
      // and from the recent places, so a typo doesn't linger on the home screen
      setRecent((r) => {
        const next = r.filter((x) => !(x.profileId === pb.profileId && x.bucket === pb.bucket));
        LS.set("m.recent", JSON.stringify(next));
        return next;
      });
    }
  }, []);

  const lst = useListing(settleBucket);
  const { listing, open: openListing, reload: reloadListing, loadMore, loadAll, stopAll, saveScroll, forget: forgetListing } = lst;
  const locRef = useRef(loc);
  locRef.current = loc;

  // the scroller is keyed by place, so it is a new element in each folder
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const pendingScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    const top = pendingScroll.current;
    if (!scrollEl || top == null) return;
    pendingScroll.current = null;
    scrollEl.scrollTop = top;
    // once more after the list has measured its rows
    const f = requestAnimationFrame(() => (scrollEl.scrollTop = top));
    return () => cancelAnimationFrame(f);
  }, [scrollEl]);

  const go = useCallback(
    (l: Loc | null, dir: "in" | "out" = "in") => {
      setNav(dir);
      setLoc(l);
      setSelecting(null);
      stopSearch();
      setSearchOpen(false);
      setQuery("");
      setDetail(null);
      setViewerKey(null);
      setChoosing(null);
      const top = openListing(l);
      pendingScroll.current = top || null;
      if (l) {
        LS.set("m.last", JSON.stringify(l));
        setRecent((r) => {
          const next = [l, ...r.filter((x) => !sameLoc(x, l))].slice(0, 8);
          LS.set("m.recent", JSON.stringify(next));
          return next;
        });
      } else LS.set("m.last", "");
    },
    [openListing, stopSearch],
  );

  const loadBuckets = useCallback(async (p: Profile) => {
    setBuckets((m) => ({ ...m, [p.id]: { names: m[p.id]?.names ?? [], note: null, loading: true } }));
    let names: string[] = [];
    let note: string | null = null;
    let revoked = false;
    let labels: Record<string, string> | undefined;
    // the "+" row follows what the connection can do: make buckets, open one by name, or neither
    const caps = await capsFor(p.id).catch(() => null);
    const add: Buckets["add"] = caps ? (caps.createRoot ? "new" : caps.roots === "buckets" ? "open" : null) : undefined;
    try {
      if (usesListRoots(p)) {
        // this phone's folders (ids are paths), drives (ids), a server's one root (""): named roots
        const roots = await api.listRoots(p.id);
        names = roots.map((r) => r.id);
        labels = Object.fromEntries(roots.map((r) => [r.id, r.name]));
        setRootNames(p.id, roots);
      } else names = (await api.listBuckets(p.id)).map((b) => b.name);
    } catch (e) {
      const msg = errMessage(e);
      revoked = p.provider === KYBL && isRevokedKey(msg);
      note = revoked
        ? REVOKED_SAY
        : /access denied|not allowed/i.test(msg) && !usesListRoots(p)
          ? "This key can't list buckets. Open one by its name below."
          : errSummary(msg);
    }
    if (p.bucket && !names.includes(p.bucket)) names = [p.bucket, ...names];
    // buckets opened by name stay with the connection (a key may reach buckets it cannot list)
    if (!usesListRoots(p)) for (const b of readJson<Record<string, string[]>>("m.extraBuckets", {})[p.id] ?? []) if (!names.includes(b)) names.push(b);
    setBuckets((m) => ({ ...m, [p.id]: { names, labels, add, note: names.length && !revoked ? null : note, loading: false, revoked } }));
    return names;
  }, []);

  const reloadProfiles = useCallback(async (): Promise<Profile[] | null> => {
    try {
      const list = await api.listProfiles();
      setProfiles(list);
      setProfilesError(null);
      return list;
    } catch (e) {
      // not "no connections": that would show the welcome screen and invite adding them twice
      setProfilesError(errSummary(errMessage(e)));
      return null;
    }
  }, []);

  const startup = useCallback(async (restore: boolean) => {
    const list = await reloadProfiles();
    if (!list) return;
    const all = [...list, ON_DEVICE];
    for (const p of all) loadBuckets(p);
    // forget recent places of connections that are gone
    setRecent((r) => r.filter((x) => all.some((p) => p.id === x.profileId)));
    if (!restore) return;
    const last = readJson<Loc | null>("m.last", null);
    if (last && all.some((p) => p.id === last.profileId)) go(last);
  }, [reloadProfiles, loadBuckets, go]);

  useEffect(() => {
    startup(settings.restoreLast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Something changed in a bucket: refresh it if it is on screen, and fix up search results. */
  const changed = useCallback(
    (pid: string, b: string, patch?: (r: ObjInfo[]) => ObjInfo[]) => {
      forgetListing(pid, b);
      const l = locRef.current;
      if (!l || l.profileId !== pid || l.bucket !== b) return;
      void reloadListing({ quiet: true });
      if (patch) setSearch((s) => (s ? { ...s, results: patch(s.results) } : s));
    },
    [forgetListing, reloadListing],
  );

  useEffect(
    () =>
      transfers.onUploadsSettled((ok, failed, where) => {
        for (const w of where) changed(w.profileId, w.bucket);
        if (failed) toast("error", `${failed} ${failed === 1 ? "upload" : "uploads"} failed`, { label: "Open Transfers", run: openTransfers });
        else if (ok) toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
      }),
    [transfers, changed, toast],
  );

  // copies between connections (src/jobs): the screen that starts one, and what happens when one ends
  const mig = useMigrate({ toast, changed, openTransfers });
  /** "Copy to another connection…" for entries of the bucket on screen */
  const migrateEntries = (list: Entry[], mode: "copy" | "move" = "copy") =>
    loc &&
    mig.open(
      { profileId: loc.profileId, root: loc.bucket, items: list.map((e) => ({ path: e.key, isDir: e.kind === "folder", size: e.kind === "folder" ? undefined : e.size })) },
      mode,
    );

  // a transfer notification was tapped
  useEffect(() => {
    const off = listen("open-transfers", openTransfers);
    return () => void off.then((f) => f()).catch(() => {});
  }, []);

  // files shared from other apps: at launch, and while running
  useEffect(() => {
    const take = (files: SharedFile[]) => {
      if (!files?.length) return;
      setIntake((cur) => ({ files: [...(cur?.files ?? []), ...files], at: cur?.at ?? locRef.current }));
    };
    api.takeSharedFiles().then(take).catch(() => {});
    const off = listen<SharedFile[]>("shared-files", (e) => {
      take(e.payload);
      // the queue keeps them for a later launch until taken
      api.takeSharedFiles().catch(() => {});
    });
    return () => void off.then((f) => f()).catch(() => {});
  }, []);

  // ------------------------------------------------------------ network
  const refreshAll = useCallback(() => {
    if (locRef.current) void reloadListing({ quiet: true });
    for (const p of listed ?? []) if (buckets[p.id]?.note && !buckets[p.id]?.revoked) loadBuckets(p);
    if (profilesError) void startup(false);
  }, [reloadListing, listed, buckets, loadBuckets, profilesError, startup]);
  const net = useNetwork(() => refreshAll());
  const offline = !net.online || (!!lst.error && isNetworkError(lst.error));
  useEffect(() => syncThumbPause(prefs, net), [prefs, net]);
  const thumbsKey = `${settings.listThumbs}-${!!prefs?.wifiOnly && net.metered}`;

  // ------------------------------------------------------------ entries
  const filter = searchOpen && !search ? query.trim().toLowerCase() : "";
  const entries: Entry[] = useMemo(() => {
    if (search) return search.results.map(toEntry);
    const folders: Entry[] = listing.folders.map((f) => ({ kind: "folder", key: f, name: baseName(f), size: 0, modified: null }));
    const files: Entry[] = listing.objects.filter((o) => o.key !== loc?.prefix).map(toEntry);
    const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const cmp =
      sort === "modified"
        ? (a: Entry, b: Entry) => (b.modified ?? 0) - (a.modified ?? 0) || byName(a, b)
        : sort === "size"
          ? (a: Entry, b: Entry) => b.size - a.size || byName(a, b)
          : byName;
    folders.sort(byName);
    files.sort(cmp);
    const all = [...folders, ...files];
    return filter ? all.filter((e) => e.name.toLowerCase().includes(filter)) : all;
  }, [listing, search, sort, loc?.prefix, filter]);

  const media = useMemo(() => entries.filter(isMedia), [entries]);
  const fileCount = useMemo(() => entries.filter((e) => e.kind === "file").length, [entries]);
  const photoFolder = fileCount >= 2 && media.length / fileCount >= 0.6;
  // "auto": photo folders open as a grid, everything else as a list
  const showGrid = view === "grid" || (view === "auto" && photoFolder);

  // the viewer stays on the same photo across refreshes; a deleted one hands over to its neighbour
  const foundIdx = viewerKey ? media.findIndex((m) => m.key === viewerKey) : -1;
  const lastViewerIdx = useRef(0);
  if (foundIdx >= 0) lastViewerIdx.current = foundIdx;
  // gone from the list: show the neighbour right away (no flicker), then follow it by key
  const viewerIdx = viewerKey === null ? -1 : foundIdx >= 0 ? foundIdx : media.length ? Math.min(lastViewerIdx.current, media.length - 1) : -1;
  useEffect(() => {
    if (viewerKey === null || foundIdx >= 0) return;
    setViewerKey(viewerIdx >= 0 ? media[viewerIdx].key : null);
  }, [media, viewerKey, foundIdx, viewerIdx]);

  // "Newest" and "Largest" sort the whole folder: load every page (people can stop it)
  const stoppedAll = useRef(new Set<string>());
  const here = loc ? locKey(loc) : "";
  useEffect(() => {
    if (!loc || sort === "name" || search || !listing.next || lst.loadingAll !== null || lst.loading || lst.error) return;
    if (stoppedAll.current.has(here)) return;
    void loadAll();
  }, [loc, here, sort, search, listing.next, loadAll, lst.loadingAll, lst.loading, lst.error]);

  // ------------------------------------------------------------ downloads watch
  const batches = useRef(new Map<string, { ids: Set<string>; done: (ok: string[], failed: number) => void }>());
  const watchDownloads = useCallback((ids: string[], done: (ok: string[], failed: number) => void) => {
    batches.current.set(ids[0] ?? String(Date.now()), { ids: new Set(ids), done });
  }, []);

  // what the connection on screen can do (null while it loads: S3's usual actions show)
  const caps = useCaps(loc?.profileId);
  const ops = useFileOps({
    caps,
    loc,
    settings,
    transfers,
    jobs,
    toast,
    setPill,
    setConfirm,
    setPrompt,
    setSheet,
    changed,
    watchDownloads,
    downloadDir: async () => downloadDir ?? (await api.downloadFolder()),
    savedWhere,
    openTransfers,
    go: (l) => go(l),
    clearSelection: () => setSelecting(null),
    closeDetail: () => setDetail(null),
    renamedDetail: (from, e) => setDetail((d) => (d?.key === from ? e : d)),
  });

  // ------------------------------------------------------------ layers and back navigation
  const locked = lock.locked;
  const stack = useLayerStack({
    detail: !!detail && !!loc,
    viewer: viewerIdx >= 0 && !!loc,
    doc: !!doc,
    intake: !!intake,
    transfers: transfersOpen,
    settings: settingsOpen,
    backup: !!backupOpen,
    folderInfo: !!folderInfo && !!loc,
    sheet: !!sheet,
    move: !!moveDialog && !!loc,
    migrate: !!mig.migrate,
    prompt: !!prompt,
    confirm: !!confirm,
    conn: !!connDialog,
    kybl: !!kyblDialog,
  });
  const top: LayerId | undefined = stack[stack.length - 1];
  const z = (id: LayerId) => layerZ(Math.max(0, stack.indexOf(id)));
  /** How each layer closes when back reaches it. */
  const closeLayer: Record<LayerId, () => void> = {
    confirm: () => setConfirm(null),
    prompt: () => setPrompt(null),
    kybl: () => setKyblDialog(null),
    // something typed into the form asks first; the dialog closes itself through onClose
    conn: () => (connRef.current ? connRef.current.requestClose() : setConnDialog(null)),
    move: () => setMoveDialog(null),
    migrate: mig.close,
    sheet: () => setSheet(null),
    folderInfo: () => setFolderInfo(null),
    // "Upload to…" walks back up the folders it went into, then closes
    intake: () => {
      const at = intake?.at;
      if (!at) setIntake(null);
      else setIntake((cur) => cur && { ...cur, at: at.prefix ? { ...at, prefix: parentPrefix(at.prefix) } : null });
    },
    // a document with unsaved changes asks first; it closes itself through onClose
    doc: () => (docRef.current ? void docRef.current.requestClose() : setDoc(null)),
    detail: () => setDetail(null),
    viewer: () => setViewerKey(null),
    transfers: () => setTransfersOpen(false),
    settings: () => setSettingsOpen(false),
    // a set or a setup step goes back inside the screen first
    backup: () => {
      if (!backupHandle.current?.back()) setBackupOpen(false);
    },
  };
  /**
   * One step back: the layer on top of the stack, then selection, search, the bucket picker and
   * the folders up to the connection list. The system back (Android button, the history), the
   * iPhone edge swipe and every on-screen back arrow go here.
   */
  const back = (): boolean => {
    // the lock screen has nothing to go back to: the system back leaves the app
    if (locked) return false;
    if (top) closeLayer[top]();
    else if (selecting) setSelecting(null);
    else if (searchOpen || search) {
      setSearchOpen(false);
      stopSearch();
      setQuery("");
    } else if (choosing) setChoosing(null);
    else if (loc && loc.prefix) go({ ...loc, prefix: parentPrefix(loc.prefix) }, "out");
    else if (loc) go(null, "out");
    else return false;
    return true;
  };
  const depth = locked ? 0 : stack.length + Number(!!selecting) + Number(searchOpen || !!search) + Number(!!choosing) + (loc ? 1 : 0);
  const backRef = useSystemBack(back, depth);
  useKeyboardFit(IOS);
  // iPhone: swipe from the left edge (Android has its own back gesture). It moves the screen on
  // top of the stack, or the folder page when nothing is open; never a sheet, dialog or the viewer.
  const swipeable = !wide && !locked && depth > 0 && (!top || SWIPEABLE.has(top));
  const swipeTarget = () => {
    if (top) {
      const el = layerElement(top);
      return el ? { el, overlay: true } : null;
    }
    const page = document.querySelector<HTMLElement>(".m-app .m-browse .m-page");
    return page ? { el: page, overlay: false } : null;
  };
  useEdgeSwipe(EDGE_SWIPE, swipeable, () => backRef.current(), swipeTarget);

  // closing the filter or search goes back to where the folder was scrolled (the search list had
  // a scroller of its own; the filter scrolled the folder's own)
  const finding = searchOpen || !!search;
  const wasFinding = useRef(finding);
  useLayoutEffect(() => {
    const was = wasFinding.current;
    wasFinding.current = finding;
    if (!was || finding || !loc) return;
    const top = lst.scrollOf(loc);
    const el = scrollEl;
    // the search's scroller is gone: the folder's new one picks the position up when it mounts
    if (!el?.isConnected) {
      pendingScroll.current = top || null;
      return;
    }
    el.scrollTop = top;
    const f = requestAnimationFrame(() => (el.scrollTop = top));
    return () => cancelAnimationFrame(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding]);

  // ------------------------------------------------------------ pull to refresh
  const pullRefresh = useCallback(async () => {
    if (search && loc) {
      runSearch(search.query);
      return;
    }
    await reloadListing({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadListing, search, loc]);
  const ptr = usePullToRefresh(scrollEl, pullRefresh, !!loc && !selecting && !searching);

  // ------------------------------------------------------------ actions
  const openDoc = (e: Entry) => loc && setDoc({ entry: e, profileId: loc.profileId, bucket: loc.bucket });
  const openEntry = (e: Entry) => {
    if (!loc) return;
    if (e.kind === "folder") go({ ...loc, prefix: e.key });
    else if (isMedia(e) && !wide) setViewerKey(e.key);
    // documents open full screen on phones; tablets show them in the details pane first
    else if (!wide && opensAsDoc(e)) openDoc(e);
    else setDetail(e);
  };

  const runSearch = async (q: string) => {
    const text = q.trim();
    if (!loc || !text) return;
    if (searchOp.current) api.cancelTransfer(searchOp.current).catch(() => {});
    const op = `search-${Date.now()}`;
    searchOp.current = op;
    setSearch({ query: text, results: [], truncated: false, scanned: 0, done: false });
    try {
      const r = await api.searchObjects(loc.profileId, loc.bucket, loc.prefix, text, op);
      if (searchOp.current !== op) return;
      setSearch({ query: text, results: r.objects, truncated: r.truncated, scanned: r.scanned, done: true });
    } catch (e) {
      if (searchOp.current !== op) return;
      setSearch(null);
      toast("error", errSummary(errMessage(e)));
    } finally {
      if (searchOp.current === op) searchOp.current = null;
    }
  };

  const favorites = settings.favorites ?? [];
  const isFavorite = (l: Loc) => favorites.some((f) => sameLoc(f, l));
  const setFavorite = (l: Loc, on: boolean) => {
    const rest = favorites.filter((f) => !sameLoc(f, l));
    const name = l.prefix ? baseName(l.prefix) : rootName(l.profileId, l.bucket);
    const next: Favorite[] = on ? [...rest, { ...l, name }] : rest;
    updateSettings({ ...settings, favorites: next });
    void api.haptic("success");
    toast("success", on ? `Added “${name}” to Favorites` : `Removed “${name}” from Favorites`);
  };

  const isPhoto = (e: Entry) => isMedia(e) || (e.kind === "file" && classify(e.name) === "image");
  const entryActions = (e: Entry): SheetItem[] => {
    const items: SheetItem[] = [];
    if (e.kind === "file") {
      items.push({ icon: "share", label: "Share…", run: () => ops.shareSheet([e]) });
      if (!isMedia(e) || (classify(e.name) === "video" && !isPlayableVideo(e.name))) items.push({ icon: "open", label: "Open in…", run: () => ops.openIn(e) });
      if (PHONE_OS && isPhoto(e)) items.push({ icon: "photos", label: "Save to Photos", run: () => ops.saveToPhotos([e]) });
      // photos and documents open full screen: their details (size, link, properties) are here
      if (detail?.key !== e.key) items.push({ icon: "info", label: "Info", run: () => setDetail(e) });
    }
    items.push({ icon: "download", label: e.kind === "folder" ? "Download folder" : e.native?.exports.length ? `Download as ${e.native.exports[0].label}` : "Download", run: () => ops.download([e]) });
    // a Google Doc / Sheet / Slides: its other formats (PDF…)
    for (const x of e.native?.exports.slice(1) ?? []) items.push({ icon: "download", label: `Download as ${x.label}`, run: () => ops.download([asExport(e, x.ext) ?? e]) });
    if (e.kind === "folder") {
      const at = loc && { ...loc, prefix: e.key };
      items.push({ icon: "info", label: "Info", run: () => setFolderInfo({ prefix: e.key, name: e.name }) });
      if (at) items.push(isFavorite(at) ? { icon: "star-fill", label: "Remove from Favorites", run: () => setFavorite(at, false) } : { icon: "star", label: "Add to Favorites", run: () => setFavorite(at, true) });
    }
    items.push(
      { icon: "edit", label: "Rename", run: () => ops.askRename(e) },
      { icon: "move", label: "Move or copy…", run: () => setMoveDialog({ items: [e], mode: "move" }) },
      { icon: "copy", label: "Copy to another connection…", run: () => migrateEntries([e]) },
      { icon: "check", label: "Select", run: () => select(e) },
      { icon: "trash", label: "Delete", danger: true, run: () => ops.askDelete([e]) },
    );
    return items;
  };

  const sortSheet = () =>
    setSheet({
      title: "Sort files by",
      message: listing.next ? "Newest and Largest load the whole folder first, so the sort covers everything." : undefined,
      items: (["name", "modified", "size"] as SortKey[]).map((k) => ({
        icon: sort === k ? "check" : "sort",
        label: SORT_LABEL[k],
        run: () => {
          setSortState(k);
          LS.set("m.sort", k);
          stoppedAll.current.clear();
        },
      })),
    });

  const setView = (v: ViewMode) => {
    void api.haptic("selection");
    setViewState(v);
    LS.set("m.view", v);
  };

  const camera = useRef<HTMLInputElement>(null);
  const addSheet = () =>
    setSheet({
      items: [
        ...(PHONE_OS ? [{ icon: "camera" as MIconName, label: "Take photo or video", run: () => camera.current?.click() }] : []),
        { icon: "image", label: "Upload photos & videos", run: () => ops.upload("media") },
        { icon: "upload", label: "Upload files", run: () => ops.upload("document") },
        { icon: "folder-plus", label: "New folder", run: ops.newFolder },
      ],
    });

  // ------------------------------------------------------------ selection
  /** keys selected when the current drag started, so dragging back unselects what it added */
  const dragBase = useRef<Set<string>>(new Set());
  const select = (e: Entry) => {
    void api.haptic("selection");
    setSelecting((cur) => {
      const next = new Set(cur ?? []);
      next.add(e.key);
      dragBase.current = new Set(next);
      return next;
    });
  };
  const toggleSelect = (key: string) => {
    void api.haptic("selection");
    // the last one off keeps selection mode ("0 selected", Done) instead of jumping out of it
    setSelecting((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const onDragRange = useCallback((anchor: number, to: number) => {
    const list = entriesRef.current;
    const [a, b] = anchor < to ? [anchor, to] : [to, anchor];
    const next = new Set(dragBase.current);
    for (let i = a; i <= b && i < list.length; i++) next.add(list[i].key);
    void api.haptic("selection");
    setSelecting(next);
  }, []);

  // stable row handlers: they read the latest state through a ref, so rows stay memoized
  const live = useRef({ selecting, openEntry, toggleSelect, select, entryActions });
  live.current = { selecting, openEntry, toggleSelect, select, entryActions };
  const [rowHandlers] = useState<RowHandlers>(() => ({
    tap: (e) => (live.current.selecting ? live.current.toggleSelect(e.key) : live.current.openEntry(e)),
    longPress: (e: Entry, _i: number, _p: PressPoint) => live.current.select(e),
    more: (e) => setSheet({ title: e.name, items: live.current.entryActions(e) }),
  }));

  const selectedEntries = selecting ? entries.filter((e) => selecting.has(e.key)) : [];
  const selectionMore = () => {
    const list = selectedEntries;
    if (list.length === 1) return setSheet({ title: list[0].name, items: entryActions(list[0]).filter((i) => i.label !== "Select") });
    const items: SheetItem[] = [
      { icon: "copy", label: "Copy to…", run: () => setMoveDialog({ items: list, mode: "copy" }) },
      { icon: "copy", label: "Copy to another connection…", run: () => migrateEntries(list) },
    ];
    if (PHONE_OS && list.some(isPhoto)) items.push({ icon: "photos", label: "Save to Photos", run: () => ops.saveToPhotos(list) });
    setSheet({ title: `${list.length} selected`, items });
  };

  // load the next page when the end of the list scrolls into view
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !listing.next || search || lst.loadingAll !== null) return;
    // rooted at the list's scroller: rooted at the screen, the margin would be clipped away
    const io = new IntersectionObserver(
      (xs) => {
        if (xs.some((x) => x.isIntersecting)) void loadMore();
      },
      { root: scrollEl, rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [listing.next, loadMore, lst.loadingAll, search, scrollEl]);

  // ------------------------------------------------------------ photo previews, asked once
  const [askedThumbs, setAskedThumbs] = useState(() => !!LS.get("m.askedThumbs"));
  const answerThumbs = (on: boolean) => {
    LS.set("m.askedThumbs", "1");
    setAskedThumbs(true);
    if (on) updateSettings({ ...settings, listThumbs: true });
  };
  const offerThumbs = !askedThumbs && !settings.listThumbs && photoFolder && !search && media.some((m) => canThumb(m));

  // ------------------------------------------------------------ render
  const title = loc ? (loc.prefix ? baseName(loc.prefix) : rootLabel(loc.profileId, loc.bucket)) : "Kybl";
  const [heroRef, collapsed] = useCollapsed<HTMLDivElement>(`${here}${!!search}`);

  const moreSheet = () => {
    if (!loc) return;
    const items: SheetItem[] = [
      { icon: "check", label: "Select", run: () => entries[0] && setSelecting(new Set()) },
      { icon: "folder-plus", label: "New folder", run: ops.newFolder },
      { icon: "refresh", label: "Refresh", run: () => void reloadListing({ quiet: true }) },
      isFavorite(loc) ? { icon: "star-fill", label: "Remove from Favorites", run: () => setFavorite(loc, false) } : { icon: "star", label: "Add to Favorites", run: () => setFavorite(loc, true) },
      { icon: "info", label: loc.prefix ? "Folder info" : "Bucket info", run: () => setFolderInfo({ prefix: loc.prefix, name: title }) },
      {
        icon: "copy",
        label: loc.prefix ? "Copy to another connection…" : "Copy everything to another connection…",
        run: () => mig.open({ profileId: loc.profileId, root: loc.bucket, items: [{ path: loc.prefix, isDir: true }] }),
      },
    ];
    setSheet({ title, items });
  };

  const total = listing.folders.length + listing.objects.length;
  const browse = loc && (
    <section className="m-screen m-browse">
      {selecting ? (
        <header className="m-bar m-bar-select solid">
          <button className="m-text-btn" onClick={() => setSelecting(null)}>
            Done
          </button>
          <div className="m-title center">
            <h1>{selecting.size.toLocaleString()} selected</h1>
          </div>
          <button className="m-text-btn" onClick={() => setSelecting(selecting.size === entries.length ? new Set() : new Set(entries.map((e) => e.key)))}>
            {selecting.size === entries.length ? "None" : "All"}
          </button>
        </header>
      ) : searchOpen ? (
        <header className="m-bar solid">
          <form
            className="m-search"
            onSubmit={(ev) => {
              ev.preventDefault();
              (document.activeElement as HTMLElement | null)?.blur();
              runSearch(query);
            }}
          >
            <Icon name="search" size={17} />
            <input
              autoFocus
              type="search"
              enterKeyHint="search"
              placeholder={`Filter ${title}`}
              aria-label={`Filter ${title}`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // typing again goes back to filtering this folder
                if (search) stopSearch();
              }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="m-search-clear"
                aria-label="Clear"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery("");
                  stopSearch();
                  (document.querySelector(".m-search input") as HTMLInputElement | null)?.focus();
                }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </form>
          <button className="m-text-btn" onClick={() => backRef.current()}>
            Cancel
          </button>
          {searching && <span className="m-bar-progress" aria-hidden="true" />}
        </header>
      ) : (
        <header className={`m-bar ${collapsed ? "solid" : ""}`}>
          {(!wide || loc.prefix) && (
            <button className="m-icon" onClick={() => backRef.current()} aria-label="Back">
              <Icon name="arrow-left" size={22} />
            </button>
          )}
          <div className="m-bar-path">
            <Breadcrumbs compact={!wide} bucket={loc.bucket} label={rootLabel(loc.profileId, loc.bucket)} icon={rootIcon(loc.profileId, loc.bucket)} parts={loc.prefix.split("/").filter(Boolean)} onNavigate={(prefix) => go({ ...loc, prefix }, "out")} />
          </div>
          <button className="m-icon" onClick={() => setSearchOpen(true)} aria-label="Search">
            <Icon name="search" size={20} />
          </button>
          {!wide && <TransfersButton onClick={openTransfers} />}
          <button className="m-icon" aria-label="More" onClick={moreSheet}>
            <Icon name="more" size={20} />
          </button>
          {lst.refreshing && !ptr.busy && <span className="m-bar-progress" aria-hidden="true" />}
        </header>
      )}

      <PullIndicator pull={ptr.pull} busy={ptr.busy} />
      <div
        className="m-scroll"
        key={`${here}${search ? "?" : ""}`}
        ref={setScrollEl}
        // a filtered or searched list is shorter: where it is scrolled to is not the folder's place
        onScroll={(e) => loc && !searchOpen && !search && saveScroll(loc, e.currentTarget.scrollTop)}
      >
        <div
          className={`m-page ${nav === "out" ? "from-left" : "from-right"} ${ptr.busy || !ptr.pull ? "ptr-settle" : ""}`}
          style={ptr.pull ? { transform: `translateY(${ptr.pull}px)` } : undefined}
        >
          {/* the path (or the query) lives in the bar; this marks the top so the bar turns solid once the list scrolls */}
          <div className="m-sentinel" ref={heroRef} />

          {(entries.length > 0 || filter) && (
            <div className="m-toolbar">
              {search ? (
                <span className="m-count m-search-sum">
                  {searching ? (
                    <>
                      <span className="spinner" />
                      <span>
                        <b>{entries.length.toLocaleString()}</b> found so far
                      </span>
                    </>
                  ) : (
                    <span>
                      <b>
                        {entries.length.toLocaleString()} {entries.length === 1 ? "match" : "matches"}
                      </b>
                      {search.truncated ? " · stopped early" : ""}
                    </span>
                  )}
                </span>
              ) : (
                <span className="m-count">
                  {filter ? `${entries.length.toLocaleString()} of ${total.toLocaleString()}${listing.next ? "+" : ""}` : `${entries.length.toLocaleString()}${listing.next ? "+" : ""} ${entries.length === 1 ? "item" : "items"}`}
                </span>
              )}
              <button className="m-pill" onClick={sortSheet} aria-label={`Sort: ${SORT_LABEL[sort]}`}>
                <Icon name="sort" size={14} />
                {SORT_LABEL[sort]}
              </button>
              <div className="m-seg-icons" role="group" aria-label="View">
                <button className={!showGrid ? "on" : ""} onClick={() => setView("list")} aria-label="List" aria-pressed={!showGrid}>
                  <Icon name="list" size={16} />
                </button>
                <button className={showGrid ? "on" : ""} onClick={() => setView("grid")} aria-label="Grid" aria-pressed={showGrid}>
                  <Icon name="grid" size={16} />
                </button>
              </div>
            </div>
          )}

          {!search && sort !== "name" && (lst.loadingAll !== null || listing.next) && (
            <div className="m-note" role="status">
              {lst.loadingAll !== null ? (
                <>
                  <span className="spinner" />
                  <span>Loading the whole folder to sort it… {lst.loadingAll.toLocaleString()} items so far</span>
                  <button
                    className="m-text-btn"
                    onClick={() => {
                      stoppedAll.current.add(here);
                      stopAll();
                    }}
                  >
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <span>Sorted the first {total.toLocaleString()} items only.</span>
                  <button
                    className="m-text-btn"
                    onClick={() => {
                      stoppedAll.current.delete(here);
                      void loadAll();
                    }}
                  >
                    Load all
                  </button>
                </>
              )}
            </div>
          )}

          {filter && query.trim() && (
            <button className="m-deep-search" onClick={() => runSearch(query)}>
              <Icon name="search" size={16} />
              <span>
                Search all subfolders for “{query.trim()}”
                <small>Looks through every file in {title}</small>
              </span>
              <Icon name="chevron" size={13} className="m-chev" />
            </button>
          )}

          {offerThumbs && (
            <div className="m-offer">
              <MIcon name="photos" size={22} />
              <div>
                <strong>Show photo previews?</strong>
                <p>Small pictures instead of icons. Each one is a small download the first time{prefs?.wifiOnly ? ", on Wi-Fi only" : ""}.</p>
                <div className="m-offer-btns">
                  <button className="btn btn-primary btn-sm" onClick={() => answerThumbs(true)}>
                    Show previews
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => answerThumbs(false)}>
                    Not now
                  </button>
                </div>
              </div>
            </div>
          )}

          {lst.error && total === 0 && !search ? (
            <div className="m-empty">
              <div className="m-empty-art warn">
                <Icon name={isNetworkError(lst.error) ? "cloud" : "alert"} size={30} />
              </div>
              <h3>{isNetworkError(lst.error) ? "No connection" : `Couldn't open this ${loc.prefix ? "folder" : "bucket"}`}</h3>
              {/* the plain sentence only: the SDK's debug text helps nobody on a phone */}
              <p className="m-empty-err">{isNetworkError(lst.error) ? "Check your internet connection and try again." : errSummary(lst.error)}</p>
              <button className="btn" onClick={() => void reloadListing({ quiet: false })}>
                <Icon name="retry" size={14} /> Try again
              </button>
            </div>
          ) : searching && entries.length === 0 ? (
            <div className="m-empty m-seeking" aria-live="polite">
              <div className="m-seek-art">
                <Mascot size={92} />
                <svg className="m-seek-glass" viewBox="0 0 48 48" aria-hidden="true">
                  <circle cx="20" cy="20" r="13" />
                  <path d="M30 30 L42 42" />
                </svg>
              </div>
              <h3>Looking for “{search.query}”</h3>
              <p>{search.scanned ? `${search.scanned.toLocaleString()} files checked in ${title}` : `Going through ${title}…`}</p>
              <div className="m-seek-bar" />
            </div>
          ) : lst.loading && entries.length === 0 && !search && !filter ? (
            <SkeletonList />
          ) : entries.length === 0 ? (
            <div className="m-empty">
              <div className="m-empty-art">
                {search || filter ? <Icon name="search" size={30} /> : <FileIcon entry={{ kind: "folder", key: "", name: "", size: 0, modified: null }} size={64} />}
              </div>
              <h3>{search || filter ? "Nothing found" : "This folder is empty"}</h3>
              {search ? (
                <p>
                  No file names in {title} contain “{search.query}”
                  {search.scanned ? ` (${search.scanned.toLocaleString()} checked)` : ""}.
                </p>
              ) : filter ? (
                <p>Nothing in this folder{listing.next ? " (so far)" : ""} has “{query.trim()}” in its name.</p>
              ) : (
                <p>Upload photos, videos or files from your device.</p>
              )}
              {!search && !filter && (
                <button className="btn btn-primary m-big-btn" onClick={addSheet}>
                  <Icon name="upload" size={16} /> Upload
                </button>
              )}
            </div>
          ) : (
            <FileList
              entries={entries}
              grid={showGrid}
              profileId={loc.profileId}
              bucket={loc.bucket}
              showPath={!!search}
              selected={selecting}
              selecting={!!selecting}
              activeKey={wide ? (detail?.key ?? null) : null}
              thumbs={thumbsKey}
              h={rowHandlers}
              onDragRange={onDragRange}
            />
          )}
          {listing.next && !search && lst.loadingAll === null && (
            <div ref={sentinel} className="m-more">
              {lst.loading ? (
                <span className="spinner" />
              ) : (
                <button className="btn btn-sm" onClick={() => void loadMore()}>
                  Load more
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {selecting ? (
        <nav className="m-actionbar">
          <BarButton icon="share" label="Share" disabled={!selectedEntries.some((e) => e.kind === "file")} onClick={() => ops.shareSheet(selectedEntries)} />
          <BarButton icon="download" label="Download" disabled={!selecting.size} onClick={() => ops.download(selectedEntries)} />
          <BarButton icon="move" label="Move" disabled={!selecting.size || !!search} onClick={() => setMoveDialog({ items: selectedEntries, mode: "move" })} />
          <BarButton icon="trash" label="Delete" danger disabled={!selecting.size} onClick={() => ops.askDelete(selectedEntries)} />
          <BarButton icon="more" label="More" disabled={!selecting.size || !!search} onClick={selectionMore} />
        </nav>
      ) : (
        !search && (
          <button className="m-fab" aria-label="Upload or create" onClick={addSheet}>
            <Icon name="plus" size={26} />
          </button>
        )
      )}
    </section>
  );

  const detailPane = detail && loc && (
    <>
      <PreviewPane
        profileId={loc.profileId}
        bucket={loc.bucket}
        selection={[detail]}
        defaultExpiry={settings.linkExpiry}
        onCopyLink={(secs) => ops.copyLink(detail, secs)}
        onCopyText={ops.copyText}
        onDownload={() => ops.download([detail])}
        onRename={() => ops.askRename(detail)}
        onMoveTo={() => setMoveDialog({ items: [detail], mode: "move" })}
        onDelete={() => ops.askDelete([detail])}
        onContext={(ev) => ev.preventDefault()}
        // properties saved, or the file turned out to be gone: the list catches up
        onChanged={() => changed(loc.profileId, loc.bucket)}
        onOpenFull={openDoc}
        onOpenExternal={(e) => void ops.openIn(e)}
      />
      {detail.kind === "file" && (
        <div className="m-detail-open">
          {opensAsDoc(detail) && (
            <button className="btn btn-primary" onClick={() => openDoc(detail)}>
              <MIcon name="open" size={16} /> Open
            </button>
          )}
          <button className="btn" onClick={() => ops.openIn(detail)}>
            <MIcon name="open" size={16} /> Open in…
          </button>
          <button className="btn" onClick={() => ops.shareSheet([detail])}>
            <MIcon name="share" size={16} /> Share
          </button>
        </div>
      )}
    </>
  );

  const connections = (
    <Connections
      profiles={listed}
      error={profilesError}
      buckets={buckets}
      current={loc}
      compact={wide}
      onRetry={loadBuckets}
      onRetryProfiles={() => void startup(false)}
      onOpen={(p, b) => go({ profileId: p.id, bucket: b, prefix: "" })}
      onAdd={() => setConnDialog({ profile: null })}
      onConnMenu={(p) => {
        const add = addKind(p, buckets[p.id]);
        const caps = peekCaps(p.id);
        const single = rootsMode(p, caps) === "single";
        const words = rootWord(p, caps, true);
        const items: SheetItem[] = [];
        if (authNeeded.has(p.id)) items.push({ icon: "refresh", label: "Sign in again", run: () => signInAgain(p) });
        // this phone's own folder has nothing to edit
        if (!isLocal(p)) items.push({ icon: "edit", label: "Edit connection", run: () => editProfile(p) });
        if (single) items.push({ icon: "folder", label: "Open", run: () => go({ profileId: p.id, bucket: "", prefix: "" }) });
        else items.push({ icon: "eye", label: `Choose ${words} to show`, run: () => setChoosing(p.id) });
        if (add === "new") items.push({ icon: "plus", label: "New bucket", run: () => askNewBucket(p) });
        else if (add === "open") items.push({ icon: "bucket", label: "Open bucket by name", run: () => askBucketName(p) });
        if (!single) items.push({ icon: "refresh", label: `Refresh ${words}`, run: () => void loadBuckets(p) });
        // everything this connection shows, each bucket into a folder of its own name
        const shown = (buckets[p.id]?.names ?? []).filter((b) => !(hiddenBuckets[p.id] ?? []).includes(b));
        if (!isLocal(p) && shown.length > 0) {
          const source: MigrationSource =
            shown.length === 1
              ? { profileId: p.id, root: shown[0], items: [{ path: "", isDir: true }] }
              : { profileId: p.id, root: shown[0], items: [], roots: shown.map((b) => ({ id: b, name: buckets[p.id]?.labels?.[b] ?? rootName(p.id, b) })) };
          items.push({ icon: "copy", label: "Copy everything to…", run: () => mig.open(source) });
        }
        setSheet({ title: connName(p), items });
      }}
      onAddBucket={(p) => (addKind(p, buckets[p.id]) === "new" ? askNewBucket(p) : askBucketName(p))}
      onReconnect={(p) => setKyblDialog({ existing: p, reconnect: true })}
      authNeeded={authNeeded}
      onSignInAgain={signInAgain}
      hidden={hiddenBuckets}
      onBucketMenu={(p, b, hidden) =>
        setSheet({
          title: rootName(p.id, b),
          items: [
            hidden ? { icon: "eye", label: "Show in the list", run: () => setBucketHidden(p, b, false) } : { icon: "eye-off", label: "Hide from the list", run: () => setBucketHidden(p, b, true) },
            { icon: "eye", label: `Choose ${rootWord(p, peekCaps(p.id), true)} to show`, run: () => setChoosing(p.id) },
            { icon: "copy", label: "Copy everything to…", run: () => mig.open({ profileId: p.id, root: b, items: [{ path: "", isDir: true }] }) },
          ],
        })
      }
      onBucketHidden={setBucketHidden}
      choosing={choosing}
      onChoose={setChoosing}
    />
  );

  /** Kybl Storage: the account owns its buckets, so it can make new ones. */
  function askNewBucket(p: Profile) {
    setPrompt({
      title: "New bucket",
      label: `Bucket name in ${p.name || p.endpoint}`,
      initial: "",
      confirmLabel: "Create",
      run: (raw) => {
        const name = raw.trim();
        if (!name) return;
        api
          .createBucket(p.id, name)
          .then(async () => {
            await loadBuckets(p);
            setBucketHidden(p, name, false);
            go({ profileId: p.id, bucket: name, prefix: "" });
            toast("success", `Created ${name}`);
          })
          .catch((e) => toast("error", errSummary(errMessage(e))));
      },
    });
  }

  /** Buckets the key can use but not list (or another account's): opened by name, then kept. */
  function askBucketName(p: Profile) {
    setPrompt({
      title: "Open bucket",
      label: `Bucket name in ${p.name || p.endpoint}`,
      initial: "",
      confirmLabel: "Open",
      run: (raw) => {
        const name = raw.trim();
        if (!name) return;
        if (name.includes("/")) return toast("error", "A bucket name cannot contain “/”");
        setBuckets((m) => {
          const cur = m[p.id] ?? { names: [], note: null, loading: false };
          if (cur.names.includes(name)) return m;
          pendingBucket.current = { profileId: p.id, bucket: name };
          return { ...m, [p.id]: { ...cur, names: [...cur.names, name], note: null } };
        });
        go({ profileId: p.id, bucket: name, prefix: "" });
      },
    });
  }

  const placeMenu = (kind: "favorite" | "recent", l: Loc, name: string) =>
    setSheet({
      title: name,
      items: [
        kind === "favorite"
          ? { icon: "star", label: "Remove from Favorites", run: () => setFavorite(l, false) }
          : { icon: "star", label: "Add to Favorites", run: () => setFavorite(l, true) },
        ...(kind === "recent"
          ? [
              {
                icon: "x" as MIconName,
                label: "Remove from Recent",
                run: () =>
                  setRecent((r) => {
                    const next = r.filter((x) => !sameLoc(x, l));
                    LS.set("m.recent", JSON.stringify(next));
                    return next;
                  }),
              },
            ]
          : []),
      ],
    });

  return (
    <div className={`m-app ${wide ? "wide" : ""} ${locked ? "m-locked" : ""} ${top && SHEETS.has(top) ? "m-toasts-top" : ""}`}>
      <DownloadWatch batches={batches} />
      {locked && <LockScreen unlock={lock.unlock} error={lock.error} busy={lock.busy} />}
      {offline && (
        <div className="m-offline" role="status">
          <MIcon name="wifi-off" size={15} />
          <span>{net.online ? "Can't reach the storage" : "You're offline"} · Kybl refreshes when you're back</span>
        </div>
      )}
      {wide ? (
        <>
          <aside className="m-side">
            <div className="m-side-brand">
              <Lockup size={28} />
            </div>
            <div className="m-side-scroll">{connections}</div>
            <div className="m-side-foot">
              <button className="m-side-btn" onClick={() => setConnDialog({ profile: null })}>
                <Icon name="plus" size={17} /> New connection
              </button>
              <TransfersButton onClick={openTransfers} />
              <button className="m-icon" onClick={() => setSettingsOpen(true)} aria-label="Settings">
                <Icon name="settings" size={20} />
              </button>
            </div>
          </aside>
          <main className="m-main">
            <div className="m-main-files">
              {browse || (
                <div className="m-placeholder">
                  <Mascot size={88} />
                  <h3>{profiles?.length ? "Pick a bucket" : profilesError ? "Couldn't load your connections" : "Welcome to Kybl"}</h3>
                  <p>{profiles?.length ? "Choose a bucket on the left to browse its files." : profilesError ?? "Add a connection to start browsing your S3 storage."}</p>
                  {!profiles?.length && !profilesError && (
                    <button className="btn btn-primary m-big-btn" onClick={connectKybl}>
                      <Icon name="cloud" size={16} /> Connect Kybl Storage
                    </button>
                  )}
                  {!profiles?.length && !profilesError && (
                    <button className="btn btn-ghost m-big-btn m-alt-btn" onClick={() => setConnDialog({ profile: null })}>
                      <Icon name="plus" size={16} /> Add another S3 connection
                    </button>
                  )}
                </div>
              )}
            </div>
            {detail && loc && (
              <aside className="m-pane" key={detail.key}>
                <header className="m-bar solid">
                  <div className="m-title">
                    <h1>{detail.name}</h1>
                  </div>
                  <button className="m-icon" onClick={() => setDetail(null)} aria-label="Close details">
                    <Icon name="x" size={20} />
                  </button>
                </header>
                <div className="m-scroll m-detail-body">{detailPane}</div>
              </aside>
            )}
          </main>
        </>
      ) : (
        <>
          {loc ? (
            browse
          ) : (
            <HomeScreen
              profiles={listed}
              firstRun={profiles !== null && profiles.length === 0 && !profilesError}
              error={profilesError}
              recent={recent}
              favorites={favorites}
              connections={connections}
              onRecent={(l) => go(l)}
              onPlaceMenu={placeMenu}
              onAdd={() => setConnDialog({ profile: null })}
              onKybl={connectKybl}
              onTransfers={openTransfers}
              onSettings={() => setSettingsOpen(true)}
              backupCard={
                <BackupCard
                  overview={backup.overview}
                  onOpen={() => setBackupOpen(backup.overview?.sets.length ? "list" : "setup")}
                  onHide={
                    backupCardHidden
                      ? undefined
                      : () => {
                          LS.set("m.backupCard", "hidden");
                          setBackupCardHidden(true);
                        }
                  }
                />
              }
            />
          )}
          <Presence show={!!detail && !!loc} layer="detail" z={z("detail")}>
            {detail && loc && (
              <section key={detail.key} className="m-screen m-overlay m-detail">
                <header className="m-bar solid">
                  <button className="m-icon" onClick={() => backRef.current()} aria-label="Back">
                    <Icon name="arrow-left" size={22} />
                  </button>
                  <div className="m-title center">
                    <h1>{detail.name}</h1>
                  </div>
                  <button className="m-icon" aria-label="More" onClick={() => setSheet({ title: detail.name, items: entryActions(detail).filter((i) => i.label !== "Select") })}>
                    <Icon name="more" size={20} />
                  </button>
                </header>
                <div className="m-scroll m-detail-body">{detailPane}</div>
              </section>
            )}
          </Presence>
        </>
      )}

      {/* every layer below takes its place in the stack (--m-z): whatever opened last is on top */}
      <Presence show={viewerIdx >= 0 && !!loc} layer="viewer" z={z("viewer")}>
        {viewerIdx >= 0 && loc && (
          <Viewer
            items={media}
            index={viewerIdx}
            profileId={loc.profileId}
            bucket={loc.bucket}
            // originals of the neighbours only on a network known not to cost anything
            lowData={!net.unmetered || thumbsPaused()}
            photos={PHONE_OS}
            onIndex={(i) => viewerOpen.current && media[i] && setViewerKey(media[i].key)}
            onClose={() => setViewerKey(null)}
            onInfo={(e) => setDetail(e)}
            onShare={(e) => ops.shareSheet([e])}
            onDownload={(e) => ops.download([e])}
            onSaveToPhotos={(e) => ops.saveToPhotos([e])}
            onOpenIn={(e) => ops.openIn(e)}
            onDelete={(e) => ops.askDelete([e])}
          />
        )}
      </Presence>

      <Presence show={!!doc} layer="doc" z={z("doc")}>
        {doc && (
          <DocScreen
            key={`${doc.profileId}|${doc.bucket}|${doc.entry.key}`}
            handle={docRef}
            profileId={doc.profileId}
            bucket={doc.bucket}
            entry={doc.entry}
            onClose={() => setDoc(null)}
            onSaved={() => {
              // the editor's header says "Saved" / "Saved as …" itself: no toast on top
              changed(doc.profileId, doc.bucket);
              void api.haptic("success");
            }}
            onOpenExternal={(e) => void ops.openIn(e)}
          />
        )}
      </Presence>

      <Presence show={!!intake} layer="intake" z={z("intake")}>
        {intake && (
          <DestinationScreen
            files={intake.files}
            at={intake.at}
            profiles={profiles ?? []}
            buckets={buckets}
            onAt={(at) => setIntake({ ...intake, at })}
            onPick={(at) => {
              void ops.queueUploads(at, intake.files);
              setIntake(null);
            }}
            onBack={() => backRef.current()}
          />
        )}
      </Presence>

      <Presence show={transfersOpen} layer="transfers" z={z("transfers")}>
        <TransfersScreen
          onBack={() => backRef.current()}
          transfers={transfers}
          savedWhere={savedWhere}
          onOpenFile={(p) => api.openLocal(p).catch((e) => toast("error", errSummary(errMessage(e))))}
          onOpenPlace={(l) => {
            setTransfersOpen(false);
            go({ profileId: l.profileId, bucket: l.root, prefix: l.dir });
          }}
        />
      </Presence>
      <Presence show={!!mig.migrate} layer="migrate" z={z("migrate")}>
        {mig.migrate && (
          <MigrationDialog
            key={mig.migrate.key}
            variant="screen"
            source={mig.migrate.source}
            initialMode={mig.migrate.mode}
            onClose={mig.close}
            onStarted={(_id, spec) => mig.started(spec.mode)}
          />
        )}
      </Presence>
      <Presence show={settingsOpen} layer="settings" z={z("settings")}>
        <SettingsScreen
          updates={updates}
          onBack={() => backRef.current()}
          settings={settings}
          onChange={updateSettings}
          profiles={profiles ?? []}
          onEdit={editProfile}
          onAdd={() => setConnDialog({ profile: null })}
          savedWhere={savedWhere}
          toast={toast}
          prefs={prefs}
          onPrefs={savePrefs}
          lockable={PHONE_OS || import.meta.env.DEV}
          onBackup={backupHere ? () => setBackupOpen("list") : undefined}
        />
      </Presence>
      <Presence show={!!backupOpen} layer="backup" z={z("backup")}>
        {backupOpen && (
          <BackupScreen backup={backup} handle={backupHandle} startSetup={backupOpen === "setup"} onBack={() => backRef.current()} toast={toast} />
        )}
      </Presence>

      <Presence show={!!sheet} ms={200} layer="sheet" z={z("sheet")}>
        {sheet && (
          <ActionSheet
            title={sheet.title}
            message={sheet.message}
            items={sheet.items}
            onClose={() => setSheet(null)}
            onPick={(item) => {
              if (!item.keepOpen) setSheet(null);
              item.run();
            }}
          />
        )}
      </Presence>
      <Presence show={!!folderInfo && !!loc} ms={200} layer="folderInfo" z={z("folderInfo")}>
        {folderInfo && loc && (
          <FolderInfo
            profileId={loc.profileId}
            bucket={loc.bucket}
            prefix={folderInfo.prefix}
            name={folderInfo.name}
            onClose={() => setFolderInfo(null)}
            onCopyPath={(t) => ops.copyText(t, "Path")}
          />
        )}
      </Presence>

      {pills.length > 0 && (
        <div className="m-pills">
          {pills.map(([id, p]) => (
            <div key={id} className="m-busy" role="status">
              <span className="spinner" />
              <span className="m-busy-text">
                {p.text}
                {p.frac != null && <b> {Math.round(p.frac * 100)}%</b>}
              </span>
              {p.cancel && (
                <button className="m-text-btn" onClick={p.cancel}>
                  Cancel
                </button>
              )}
              {p.frac != null && <span className="m-busy-bar" style={{ width: `${Math.round(p.frac * 100)}%` }} />}
            </div>
          ))}
        </div>
      )}

      {/* the camera, for "Take photo or video" */}
      <input
        ref={camera}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void ops.uploadCaptured(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />

      {connDialog && (
        <Layer id="conn" z={z("conn")}>
          <ConnectionDialog
            ref={connRef}
            initial={connDialog.profile}
            reconnect={connDialog.reconnect}
            onClose={() => setConnDialog(null)}
            onKybl={() => {
              setConnDialog(null);
              connectKybl();
            }}
            kyblFirst={!profiles?.some((p) => p.provider === KYBL)}
            onSaved={async (p) => {
              setConnDialog(null);
              forgetCaps(p.id);
              clearAuthNeeded(p.id);
              await reloadProfiles();
              await loadBuckets(p);
              // a server has one root: open it, as the desktop does after saving
              if (rootsMode(p, await capsFor(p.id).catch(() => null)) === "single") go({ profileId: p.id, bucket: "", prefix: "" });
              // a sign-in done again: the folder on screen loads now
              else if (locRef.current?.profileId === p.id) void reloadListing({ quiet: true });
            }}
            onDeleted={async (id) => {
              setConnDialog(null);
              forgetCaps(id);
              clearAuthNeeded(id);
              if (loc?.profileId === id) go(null, "out");
              await reloadProfiles();
            }}
          />
        </Layer>
      )}
      {kyblDialog && (
        <Layer id="kybl" z={z("kybl")}>
          <KyblConnectDialog
            existing={kyblDialog.existing}
            reconnect={kyblDialog.reconnect}
            onClose={() => setKyblDialog(null)}
            onConnected={async (p) => {
              await reloadProfiles();
              loadBuckets(p);
            }}
            onDeleted={async (id) => {
              if (loc?.profileId === id) go(null, "out");
              await reloadProfiles();
            }}
          />
        </Layer>
      )}
      {confirm && (
        <Layer id="confirm" z={z("confirm")}>
          <ConfirmDialog
            title={confirm.title}
            message={confirm.message}
            confirmLabel={confirm.label}
            danger={confirm.danger ?? true}
            onConfirm={() => {
              const run = confirm.run;
              setConfirm(null);
              run();
            }}
            onClose={() => setConfirm(null)}
          />
        </Layer>
      )}
      {prompt && (
        <Layer id="prompt" z={z("prompt")}>
          <PromptDialog
            title={prompt.title}
            label={prompt.label}
            initial={prompt.initial}
            confirmLabel={prompt.confirmLabel}
            note={prompt.note}
            onSubmit={(v) => {
              const run = prompt.run;
              setPrompt(null);
              run(v);
            }}
            onClose={() => setPrompt(null)}
          />
        </Layer>
      )}
      {moveDialog && loc && (
        <Layer id="move" z={z("move")}>
          <MoveDialog
            profileId={loc.profileId}
            bucket={loc.bucket}
            items={moveDialog.items}
            startPrefix={loc.prefix}
            initialMode={moveDialog.mode}
            onSubmit={(dest, mode) => {
              const items = moveDialog.items;
              setMoveDialog(null);
              void ops.relocate(items, dest, mode);
            }}
            onClose={() => setMoveDialog(null)}
          />
        </Layer>
      )}
      {!transfersOpen && !settingsOpen && <UpdateBanner st={updates} mobile />}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function BarButton({ icon, label, onClick, disabled, danger }: { icon: IconName | MIconName; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={`m-barbtn ${danger ? "danger" : ""}`} onClick={onClick} disabled={disabled}>
      <MIcon name={icon} size={21} />
      <span>{label}</span>
    </button>
  );
}
