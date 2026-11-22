import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorText } from "./components/ErrorText";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errMessage, errSummary } from "./api";
import { baseName, formatBytes, parentPrefix } from "./format";
import { useTransfers } from "./useTransfers";
import { useJobs } from "./useJobs";
import { useFolderSizes } from "./useFolderSizes";
import { ProviderBadge, Sidebar, type BucketList } from "./components/Sidebar";
import { PROVIDERS } from "./providers";
import { Toolbar } from "./components/Toolbar";
import { FileTable, type Sort, type SortKey } from "./components/FileTable";
import { GridView } from "./components/GridView";
import { PreviewPane } from "./components/PreviewPane";
import { TransferPanel } from "./components/TransferPanel";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { KyblConnectDialog } from "./components/KyblConnectDialog";
import { KyblMark } from "./components/KyblMark";
import { KYBL, isRevokedKey, kyblError } from "./kybl";
import { SettingsPage, type SettingsPageId } from "./components/SettingsPage";
import { useSyncOverall } from "./sync";
import { useUpdates } from "./updates";
import { UpdateBanner } from "./components/UpdateBanner";
import { listen } from "@tauri-apps/api/event";
import { MoveDialog } from "./components/MoveDialog";
import { destLabel, entryParent } from "./moving";
import { useItemDrag } from "./useItemDrag";
import { applySettings, expiryLabel, loadSettings, saveSettings, type Favorite, type Settings } from "./settings";
import { ConfirmDialog, ContextMenu, PromptDialog, Toasts, type MenuItem, type Toast } from "./components/Dialogs";
import { useConflictPrompt } from "./components/ConflictDialog";
import { Icon } from "./Icons";
import type { Entry, Profile } from "./types";
import { sameLoc, useListing, type Loc } from "./desktop/useListing";
import { useSearch } from "./desktop/useSearch";
import { useHistory } from "./desktop/useHistory";
import { makeFileOps, type ToastAction } from "./desktop/fileOps";
import { itemClipboard } from "./desktop/clipboard";
import { undoStack } from "./desktop/undo";
import { parseLocation } from "./desktop/paths";
import { MENU_OWNS_SHORTCUTS, tidyMenu } from "./desktop/menus";
import { QuickLook } from "./desktop/QuickLook";
import { GoToDialog } from "./desktop/GoToDialog";
import { SyncThisFolder } from "./desktop/SyncThisFolder";
import "./styles.css";
import "./desktop/desktop.css";

const PREVIEW_MIN = 260;
const PREVIEW_MAX = 760;
const PREVIEW_DEFAULT = 336;

const EXPANDED_KEY = "s3b.expanded";
function loadExpanded(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Buckets left out of the sidebar, per connection (all are shown until someone hides one). */
const HIDDEN_KEY = "s3b.hiddenBuckets";
function loadHidden(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const LS = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Folders up to this many items are loaded whole in the background, so the list is in its final
 * order (S3's byte order differs from ours, and later pages would otherwise slot in above what
 * you are reading). About ten requests; bigger folders load further as you scroll.
 */
const AUTO_ALL = 10_000;
/** Sorting by anything but name needs the whole folder; stop pulling pages past this many objects. */
const MAX_SORT_ITEMS = 200_000;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** At most this often, a window coming back to the front reloads the folder on screen. */
const RESUME_REFRESH_MS = 15_000;

type ConfirmState = { title: string; message: React.ReactNode; label: string; safe?: boolean; run: () => void; cancel?: () => void };

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // bucket lists of every connection opened in the sidebar; several can be expanded at once
  const [bucketsBy, setBucketsBy] = useState<Record<string, BucketList>>({});
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [hiddenBuckets, setHiddenBuckets] = useState<Record<string, string[]>>(loadHidden);
  const setBucketHidden = useCallback((p: Profile, name: string, hide: boolean) => {
    setHiddenBuckets((cur) => {
      const list = (cur[p.id] ?? []).filter((b) => b !== name);
      const next = { ...cur, [p.id]: hide ? [...list, name] : list };
      if (!next[p.id].length) delete next[p.id];
      LS.set(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const [bucket, setBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [previewOpen, setPreviewOpen] = useState(LS.get("s3b.preview") !== "0");
  const [view, setViewState] = useState<"list" | "grid">(LS.get("s3b.view") === "grid" ? "grid" : "list");
  const [compact, setCompactState] = useState(LS.get("s3b.compact") === "1");
  const setView = (v: "list" | "grid") => {
    setViewState(v);
    LS.set("s3b.view", v);
  };
  const setCompact = (c: boolean) => {
    setCompactState(c);
    LS.set("s3b.compact", c ? "1" : "0");
  };
  const [transfersOpen, setTransfersOpen] = useState(true);
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
  const sort: Sort = useMemo(() => ({ key: settings.sort.by, dir: settings.sort.desc ? "desc" : "asc" }), [settings.sort]);
  const setSort = (s: Sort) => updateSettings({ sort: { by: s.key, desc: s.dir === "desc" } });
  // the slider moves the tiles at once; the setting is saved once it settles
  const [tile, setTile] = useState(settings.tileSize);
  const tileTimer = useRef(0);
  const changeTile = (px: number) => {
    setTile(px);
    window.clearTimeout(tileTimer.current);
    tileTimer.current = window.setTimeout(() => updateSettings({ tileSize: px }), 300);
  };

  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [connDialog, setConnDialogState] = useState<{ profile: Profile | null } | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  /** Opens the editor for a connection: Kybl Storage connections have their own (no keys to edit). */
  const setConnDialog = useCallback((d: { profile: Profile | null } | null) => {
    if (d?.profile?.provider === KYBL) setKyblDialog({ existing: d.profile });
    else setConnDialogState(d);
  }, []);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [moveDialog, setMoveDialog] = useState<null | { items: Entry[]; mode: "move" | "copy" }>(null);
  const [goTo, setGoTo] = useState(false);
  const [syncFor, setSyncFor] = useState<null | { profileId: string; bucket: string; prefix: string }>(null);
  const [quick, setQuick] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState(() => {
    const w = Number(LS.get("s3b.previewWidth"));
    return w >= PREVIEW_MIN && w <= PREVIEW_MAX ? w : PREVIEW_DEFAULT;
  });
  const [prompt, setPrompt] = useState<null | { title: string; label: string; initial: string; confirmLabel: string; run: (v: string) => void }>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; items: MenuItem[] }>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const conflicts = useConflictPrompt();

  const anchor = useRef<string | null>(null);
  const cursor = useRef<string | null>(null);
  /** a key to select once it shows up in the listing of that connection and bucket */
  const pendingSelect = useRef<{ profileId: string; bucket: string; key: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // ------------------------------------------------------------ toasts
  const toast = useCallback((kind: Toast["kind"], text: string, action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : kind === "error" ? 7000 : 3200);
  }, []);
  const onError = useCallback((m: string) => toast("error", m), [toast]);
  const showActivity = useCallback(() => setTransfersOpen(true), []);

  const transfers = useTransfers(onError);
  const jobs = useJobs();
  const hist = useHistory();
  const sr = useSearch(onError);

  const profile = useMemo(() => profiles.find((p) => p.id === activeId) ?? null, [profiles, activeId]);
  const folderSizes = useFolderSizes(profile?.id ?? null, bucket);
  const here: Loc | null = useMemo(() => (profile && bucket ? { profileId: profile.id, bucket, prefix } : null), [profile, bucket, prefix]);
  const search = sr.search && sameLoc(sr.search.loc, here) ? sr.search : null;

  // ------------------------------------------------------------ listing
  const needsAll = !search && (sort.key !== "name" || sort.dir !== "asc");
  const lst = useListing(needsAll ? MAX_SORT_ITEMS : AUTO_ALL);
  const { listing } = lst;
  // rows only ever show for the place they were listed for
  const fresh = sameLoc(listing.loc, here);

  /** Shows a place: the one central way to change connection, bucket or folder. */
  const go = useCallback(
    (p: Profile, b: string, pre: string, opts: { selectKey?: string; history?: boolean } = {}) => {
      const loc = { profileId: p.id, bucket: b, prefix: pre };
      setActiveId(p.id);
      setBucket(b);
      setPrefix(pre);
      sr.clear();
      setQuery("");
      setQuick(null);
      setSelected(new Set());
      anchor.current = cursor.current = null;
      pendingSelect.current = opts.selectKey ? { profileId: p.id, bucket: b, key: opts.selectKey } : null;
      LS.set("s3b.last", JSON.stringify(loc));
      if (opts.history !== false) hist.push(loc);
      void lst.open(loc);
    },
    [sr, hist, lst],
  );

  const navigate = useCallback(
    (p: string, selectKey?: string) => {
      if (profile && bucket) go(profile, bucket, p, { selectKey });
    },
    [profile, bucket, go],
  );
  const openBucket = useCallback((p: Profile, b: string, startPrefix = "") => go(p, b, startPrefix), [go]);

  const historyStep = (delta: number) => {
    const loc = hist.step(delta);
    const p = loc && profiles.find((x) => x.id === loc.profileId);
    if (loc && p) go(p, loc.bucket, loc.prefix, { history: false });
  };

  // select a key once it is in the listing (after a rename, new folder, Go to a file…)
  useEffect(() => {
    const ps = pendingSelect.current;
    if (!ps || !fresh || !here || ps.profileId !== here.profileId || ps.bucket !== here.bucket) return;
    if (listing.objects.some((o) => o.key === ps.key) || listing.folders.includes(ps.key)) {
      pendingSelect.current = null;
      setSelected(new Set([ps.key]));
      anchor.current = cursor.current = ps.key;
    }
  }, [listing, fresh, here]);

  /** Reloads what is on screen: the search when searching, else the folder (keeping rows meanwhile). */
  const refresh = useCallback(() => {
    if (!here) return;
    if (search) void sr.run(search.loc, search.query);
    else void lst.refresh(here);
  }, [here, search, sr, lst]);

  // what is on screen right now, for work that finishes later (uploads, moves, deletes, renames)
  const onScreen = useRef<{ profileId?: string; bucket: string | null; refresh: () => void }>({ bucket: null, refresh: () => {} });
  onScreen.current = { profileId: profile?.id, bucket, refresh };
  /**
   * After a job in `pid`/`b` finishes, reloads the listing only if that bucket is still the one on
   * screen. Work in another connection or bucket carries on undisturbed in the meantime.
   */
  const reloadIfShowing = useCallback((pid: string, b: string) => {
    const v = onScreen.current;
    if (v.profileId !== pid || v.bucket !== b) return false;
    v.refresh();
    return true;
  }, []);

  const setExpandedSaved = useCallback((fn: (cur: Set<string>) => Set<string>) => {
    setExpanded((cur) => {
      const next = fn(cur);
      LS.set(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const bucketsRef = useRef(bucketsBy);
  bucketsRef.current = bucketsBy;
  /** Fetches a connection's bucket list into the sidebar (again, when `force`). */
  const loadBuckets = useCallback(async (p: Profile, force = false): Promise<string[]> => {
    const have = bucketsRef.current[p.id];
    if (have && !have.loading && !force) return have.names;
    setBucketsBy((m) => ({ ...m, [p.id]: { names: m[p.id]?.names ?? [], note: null, loading: true } }));
    let names: string[] = [];
    let note: string | null = null;
    let reconnect = false;
    try {
      names = (await api.listBuckets(p.id)).map((b) => b.name);
    } catch (e) {
      const msg = errMessage(e);
      reconnect = p.provider === KYBL && isRevokedKey(msg);
      note = reconnect
        ? "This computer's key was revoked, or the account was deleted."
        : /access denied|not allowed/i.test(msg)
          ? "This key can't list buckets. Open a bucket by name."
          : errSummary(msg);
    }
    if (p.bucket && !names.includes(p.bucket)) names = [p.bucket, ...names];
    setBucketsBy((m) => ({ ...m, [p.id]: { names, note: names.length ? null : note, loading: false, reconnect } }));
    return names;
  }, []);

  /** Remembers a bucket opened by name, so it shows in the sidebar and the Move dialog. */
  const rememberBucket = useCallback((p: Profile, name: string) => {
    setBucketsBy((m) => {
      const cur = m[p.id] ?? { names: [], note: null, loading: false };
      return cur.names.includes(name) ? m : { ...m, [p.id]: { ...cur, names: [...cur.names, name], note: null } };
    });
  }, []);

  /** Shows a connection: expands it in the sidebar and opens a bucket of it. */
  const connect = useCallback(
    async (p: Profile, preferBucket?: string, startPrefix = "") => {
      setActiveId(p.id);
      setBucket(null);
      lst.clear();
      sr.clear();
      setExpandedSaved((cur) => (cur.has(p.id) ? cur : new Set(cur).add(p.id)));
      const names = await loadBuckets(p, true);
      const pick = preferBucket && names.includes(preferBucket) ? preferBucket : p.bucket || names[0];
      if (pick) openBucket(p, pick, pick === preferBucket ? startPrefix : "");
    },
    [openBucket, loadBuckets, setExpandedSaved, lst, sr],
  );

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  /** Sidebar click on a connection: folds it open or shut, without leaving what is on screen. */
  const toggleConnection = useCallback(
    (p: Profile) => {
      if (!activeIdRef.current) {
        connect(p);
        return;
      }
      const open = !expanded.has(p.id);
      setExpandedSaved((cur) => {
        const next = new Set(cur);
        if (open) next.add(p.id);
        else next.delete(p.id);
        return next;
      });
      if (open) loadBuckets(p);
    },
    [expanded, connect, loadBuckets, setExpandedSaved],
  );

  /** A connection was deleted: drop it from the sidebar, the history and the screen. */
  const forgetProfile = useCallback(
    (id: string) => {
      setProfiles((list) => list.filter((x) => x.id !== id));
      setExpandedSaved((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
      hist.forget(id);
      if (id === activeIdRef.current) {
        setActiveId(null);
        setBucket(null);
        lst.clear();
        sr.clear();
      }
    },
    [setExpandedSaved, hist, lst, sr],
  );

  // initial load
  useEffect(() => {
    api
      .listProfiles()
      .then((list) => {
        setProfiles(list);
        let last: { profileId: string; bucket: string; prefix: string } | null = null;
        try {
          last = settings.restoreLast ? JSON.parse(LS.get("s3b.last") ?? "null") : null;
        } catch {
          last = null;
        }
        const start = list.find((p) => p.id === last?.profileId) ?? list[0];
        if (start) connect(start, last?.profileId === start.id ? last.bucket : undefined, last?.prefix ?? "");
        // the other connections left open last time list their buckets too
        for (const p of list) if (p !== start && loadExpanded().has(p.id)) loadBuckets(p);
      })
      .catch((e) => toast("error", errMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // refresh listing once all uploads have finished
  const clearSizes = folderSizes.clear;
  useEffect(
    () =>
      transfers.onUploadsSettled((ok, bad, where) => {
        if (bad) toast("error", `${bad} ${bad === 1 ? "upload" : "uploads"} failed`, { label: "Show", run: showActivity });
        else if (ok) toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
        if (ok) clearSizes();
        for (const w of where) if (reloadIfShowing(w.profileId, w.bucket)) break;
      }),
    [transfers, toast, reloadIfShowing, showActivity, clearSizes],
  );

  // ------------------------------------------------------------ entries
  const filter = !search ? query.trim().toLowerCase() : "";
  const allEntries: Entry[] = useMemo(() => {
    if (search) {
      // folders whose own name matches: every object below such a folder matched too (the search
      // looks at the whole path), so they can be read off the results
      const needle = search.query.toLowerCase();
      const base = search.loc.prefix;
      const folders = new Set<string>();
      for (const o of search.results) {
        const parts = o.key.slice(base.length).split("/");
        let acc = base;
        for (let i = 0; i < parts.length - 1; i++) {
          acc += `${parts[i]}/`;
          if (parts[i].toLowerCase().includes(needle)) folders.add(acc);
        }
      }
      return [
        ...[...folders].map<Entry>((f) => ({ kind: "folder", key: f, name: baseName(f), size: 0, modified: null })),
        ...search.results.map<Entry>((o) => ({ kind: "file", key: o.key, name: baseName(o.key), size: o.size, modified: o.modified, etag: o.etag, storageClass: o.storageClass })),
      ];
    }
    if (!fresh) return [];
    return [
      ...listing.folders.map<Entry>((f) => ({ kind: "folder", key: f, name: baseName(f), size: 0, modified: null })),
      ...listing.objects.map<Entry>((o) => ({ kind: "file", key: o.key, name: baseName(o.key), size: o.size, modified: o.modified, etag: o.etag, storageClass: o.storageClass })),
    ];
  }, [listing, search, fresh]);

  const entries: Entry[] = useMemo(() => {
    const list = filter ? allEntries.filter((e) => e.name.toLowerCase().includes(filter)) : allEntries.slice();
    const dir = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: Entry, b: Entry): number => {
      switch (sort.key) {
        case "size":
          return (a.size - b.size) * dir;
        case "modified":
          return ((a.modified ?? 0) - (b.modified ?? 0)) * dir;
        case "kind": {
          const ka = a.kind === "folder" ? "" : a.name.split(".").pop() ?? "";
          const kb = b.kind === "folder" ? "" : b.name.split(".").pop() ?? "";
          return byName.compare(ka, kb) * dir || byName.compare(a.name, b.name);
        }
        default:
          return byName.compare(a.name, b.name) * dir;
      }
    };
    return list.sort((a, b) => {
      if (settings.foldersFirst && a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return cmp(a, b);
    });
  }, [allEntries, filter, sort, settings.foldersFirst]);

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.key)), [entries, selected]);
  const singleFile = selectedEntries.length === 1 && selectedEntries[0].kind === "file";
  // refs so the memoised grid cards don't re-render on every selection change
  const selRef = useRef({ selected, selectedEntries: [] as Entry[] });
  useEffect(() => {
    selRef.current = { selected, selectedEntries };
  });

  const loadedCount = lst.count;
  const sortCapped = needsAll && !!listing.next && loadedCount >= MAX_SORT_ITEMS;
  // folders bigger than AUTO_ALL in name order: the rest loads as you scroll
  const hasMore = !search && fresh && !!listing.next && !lst.pulling && !needsAll;
  const listLoading = useRef(false);
  listLoading.current = lst.loading;
  const listLoadMore = lst.loadMore;
  const loadMore = useCallback(() => {
    if (!listLoading.current) void listLoadMore();
  }, [listLoadMore]);

  const onSort = (key: SortKey) => setSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });

  // ------------------------------------------------------------ selection
  const select = useCallback(
    (e: Entry, mods: { meta: boolean; shift: boolean }) => {
      const idx = entries.findIndex((x) => x.key === e.key);
      if (mods.shift && anchor.current) {
        const a = entries.findIndex((x) => x.key === anchor.current);
        const [lo, hi] = a < idx ? [a, idx] : [idx, a];
        setSelected(new Set(entries.slice(lo, hi + 1).map((x) => x.key)));
      } else if (mods.meta) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(e.key)) next.delete(e.key);
          else next.add(e.key);
          return next;
        });
        anchor.current = e.key;
      } else {
        setSelected(new Set([e.key]));
        anchor.current = e.key;
      }
      cursor.current = e.key;
    },
    [entries],
  );

  const selectOnly = (key: string) => {
    setSelected(new Set([key]));
    anchor.current = cursor.current = key;
  };

  const moveSelection = useCallback(
    (delta: number, shift: boolean) => {
      if (entries.length === 0) return;
      const cur = cursor.current ? entries.findIndex((x) => x.key === cursor.current) : -1;
      const next = Math.max(0, Math.min(entries.length - 1, (cur < 0 ? (delta > 0 ? -1 : entries.length) : cur) + delta));
      const key = entries[next].key;
      cursor.current = key;
      if (shift && anchor.current) {
        const a = entries.findIndex((x) => x.key === anchor.current);
        const [lo, hi] = a < next ? [a, next] : [next, a];
        setSelected(new Set(entries.slice(lo, hi + 1).map((x) => x.key)));
      } else {
        anchor.current = key;
        setSelected(new Set([key]));
      }
    },
    [entries],
  );

  // ------------------------------------------------------------ actions
  const confirmAsync = useCallback(
    (o: { title: string; message: React.ReactNode; label: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) =>
        setConfirm({ title: o.title, message: o.message, label: o.label, safe: !o.danger, run: () => resolve(true), cancel: () => resolve(false) }),
      ),
    [],
  );

  const ops = makeFileOps({
    profile,
    bucket,
    prefix,
    folderKeys: new Set(fresh ? listing.folders : []),
    settings,
    transfers,
    jobs,
    toast,
    autoShowActivity: () => settings.autoOpenTransfers && setTransfersOpen(true),
    showActivity,
    setBusy,
    confirm: confirmAsync,
    prompt: setPrompt,
    resolveConflicts: conflicts.resolve,
    reloadIfShowing,
    selectAfterReload: (profileId, b, key) => {
      pendingSelect.current = key ? { profileId, bucket: b, key } : null;
    },
    deselect: (keys) =>
      setSelected((sel) => {
        const next = new Set(sel);
        keys.forEach((k) => next.delete(k));
        return next;
      }),
    clearSizes: folderSizes.clear,
  });
  const relBase = search ? search.loc.prefix : null;

  const openEntry = useCallback(
    (e: Entry) => {
      if (e.kind === "folder") navigate(e.key);
      else void opsRef.current.openInApp(e);
    },
    [navigate],
  );
  const opsRef = useRef(ops);
  opsRef.current = ops;

  /** Enter / ⌘O / ⌘↓: a folder opens in the list; files open in their apps (a few at most). */
  const openSelection = (list: Entry[] = selectedEntries) => {
    if (list.length === 1 && list[0].kind === "folder") return navigate(list[0].key);
    const files = list.filter((e) => e.kind === "file");
    if (files.length > 10) toast("info", "Opening the first 10 files");
    for (const f of files.slice(0, 10)) void ops.openInApp(f);
  };

  const doSearch = (q: string) => {
    if (here) void sr.run(here, q);
    setSelected(new Set());
  };
  const clearSearch = () => {
    sr.clear();
    setQuery("");
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
    if (!profile || !bucket) return;
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
    if (list.length) setMoveDialog({ items: list, mode });
  };

  const askBucketName = (p: Profile | null = profile) => {
    if (!p) return;
    setPrompt({
      title: "Open bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Open",
      run: (name) => {
        rememberBucket(p, name);
        openBucket(p, name);
      },
    });
  };

  /** Kybl Storage: the account owns its buckets, so it can make new ones. */
  const askNewBucket = (p: Profile | null = profile) => {
    if (!p) return;
    setPrompt({
      title: "New bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Create",
      run: (raw) => {
        const name = raw.trim();
        api
          .createBucket(p.id, name)
          .then(async () => {
            await loadBuckets(p, true);
            setBucketHidden(p, name, false);
            openBucket(p, name);
            toast("success", `Created ${name}`);
          })
          .catch((e) => toast("error", errSummary(errMessage(e))));
      },
    });
  };

  /** Go to folder: a path in this bucket, `bucket/path` or an s3:// address. */
  const goToPath = async (input: string) => {
    if (!profile) return;
    const names = bucketsBy[profile.id]?.names ?? [];
    const loc = parseLocation(input, names);
    const b = loc?.bucket ?? bucket;
    if (!loc || !b) return;
    if (loc.bucket) rememberBucket(profile, loc.bucket);
    let pre = loc.prefix;
    if (pre && !pre.endsWith("/")) {
      // the path of a file opens its folder with the file selected
      try {
        const r = await api.existing(profile.id, b, [pre], [`${pre}/`]);
        if (!r.prefixes.length && r.keys.length) return go(profile, b, parentPrefix(pre), { selectKey: pre });
      } catch {
        /* treat it as a folder */
      }
      pre += "/";
    }
    go(profile, b, pre);
  };

  // ------------------------------------------------------------ favorites
  const favoriteOf = (pid: string, b: string, pre: string) => settings.favorites.find((f) => f.profileId === pid && f.bucket === b && f.prefix === pre);
  const toggleFavorite = (b: string, pre: string) => {
    if (!profile) return;
    const have = favoriteOf(profile.id, b, pre);
    if (have) {
      removeFavorite(have);
      return;
    }
    const name = pre ? baseName(pre) : b;
    updateSettings({ favorites: [...settings.favorites, { profileId: profile.id, bucket: b, prefix: pre, name }] });
    toast("success", `Added “${name}” to favorites`);
  };
  const removeFavorite = (f: Favorite) =>
    updateSettings({ favorites: settings.favorites.filter((x) => !(x.profileId === f.profileId && x.bucket === f.bucket && x.prefix === f.prefix)) });
  const openFavorite = (f: Favorite) => {
    const p = profiles.find((x) => x.id === f.profileId);
    if (!p) {
      toast("error", "That connection no longer exists.");
      return;
    }
    setExpandedSaved((cur) => (cur.has(p.id) ? cur : new Set(cur).add(p.id)));
    void loadBuckets(p);
    go(p, f.bucket, f.prefix);
  };

  // ------------------------------------------------------------ context menus
  const calcSizes = (keys: string[]) => folderSizes.calc(keys);
  const clipFor = () => {
    const c = itemClipboard.get();
    return c && profile && c.profileId === profile.id ? c : null;
  };
  const favoriteItem = (b: string, pre: string): MenuItem => ({
    type: "item",
    label: profile && favoriteOf(profile.id, b, pre) ? "Remove from favorites" : "Add to favorites",
    icon: "plus",
    onClick: () => toggleFavorite(b, pre),
  });

  /** What applies to the folder on screen: from the empty-space menu and the toolbar's "…". */
  const placeItems = (): (MenuItem | false)[] =>
    !profile || !bucket
      ? []
      : [
          { type: "item", label: "Calculate folder size", icon: "info", onClick: () => calcSizes([prefix]) },
          favoriteItem(bucket, prefix),
          { type: "item", label: "Sync this folder…", icon: "sync", onClick: () => setSyncFor({ profileId: profile.id, bucket, prefix }) },
          { type: "item", label: "Copy S3 URI", icon: "copy", onClick: () => copyText(`s3://${bucket}/${prefix}`, "S3 URI") },
          { type: "sep" },
          { type: "item", label: "Go to folder…", icon: "arrow-up", hint: "⇧⌘G", onClick: () => setGoTo(true) },
        ];

  const onBackgroundContext = (ev: React.MouseEvent) => {
    if (!profile || !bucket) return;
    const clip = clipFor();
    setMenu({
      x: ev.clientX,
      y: ev.clientY,
      items: tidyMenu([
        { type: "item", label: "New folder…", icon: "folder-plus", hint: "⇧⌘N", onClick: () => ops.askNewFolder() },
        { type: "item", label: "Upload files…", icon: "upload", hint: "⌘U", onClick: () => ops.pickAndUpload(false) },
        { type: "item", label: "Upload folder…", icon: "folder", onClick: () => ops.pickAndUpload(true) },
        { type: "sep" },
        {
          type: "item",
          label: clip ? `Paste ${clip.items.length === 1 ? `“${clip.items[0].name}”` : `${clip.items.length} items`}` : "Paste",
          icon: "copy",
          hint: "⌘V",
          disabled: !clip,
          onClick: () => ops.paste(),
        },
        { type: "item", label: "Select all", icon: "check", hint: "⌘A", disabled: !entries.length, onClick: () => setSelected(new Set(entries.map((e) => e.key))) },
        { type: "item", label: search ? "Search again" : "Refresh", icon: "refresh", hint: "⌘R", onClick: refresh },
        search && { type: "item", label: "Clear search", icon: "x", onClick: clearSearch },
        { type: "sep" },
        ...placeItems(),
      ]),
    });
  };

  const onContext = (ev: React.MouseEvent, e: Entry) => {
    if (!profile || !bucket) return;
    const list = selected.has(e.key) ? selectedEntries : [e];
    if (!selected.has(e.key)) selectOnly(e.key);
    const one = list.length === 1;
    const folder = one && e.kind === "folder";
    const files = list.filter((x) => x.kind === "file");
    const folders = list.filter((x) => x.kind === "folder");
    const clip = clipFor();
    const items = tidyMenu([
      folder
        ? { type: "item", label: "Open", icon: "folder", hint: "↵", onClick: () => navigate(e.key) }
        : { type: "item", label: files.length > 1 ? `Open ${files.length} files` : "Open", icon: "reveal", hint: "⌘O", disabled: !files.length, onClick: () => openSelection(list) },
      one && e.kind === "file" && { type: "item", label: "Quick Look", icon: "eye", hint: "Space", onClick: () => setQuick(e.key) },
      search && one && { type: "item", label: "Show in folder", icon: "folder", onClick: () => navigate(entryParent(e), e.key) },
      { type: "item", label: "Download", icon: "download", onClick: () => ops.downloadEntries(list, relBase) },
      { type: "item", label: `Copy share link (${expiryLabel(settings.linkExpiry)})`, icon: "link", disabled: !(one && e.kind === "file"), onClick: () => copyLink(e, settings.linkExpiry) },
      { type: "item", label: "Copy S3 URI", icon: "copy", disabled: !one, onClick: () => copyText(`s3://${bucket}/${e.key}`, "S3 URI") },
      { type: "sep" },
      { type: "item", label: "Copy", icon: "copy", hint: "⌘C", onClick: () => ops.clip(list, "copy") },
      { type: "item", label: "Cut", icon: "move", hint: "⌘X", onClick: () => ops.clip(list, "cut") },
      folder && clip && { type: "item", label: `Paste into “${e.name}”`, icon: "copy", onClick: () => ops.paste(e.key) },
      { type: "item", label: "Move to…", icon: "move", onClick: () => askMove(list, "move") },
      { type: "item", label: "Copy to…", icon: "copy", onClick: () => askMove(list, "copy") },
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
      folder && { type: "item", label: "Sync this folder…", icon: "sync", onClick: () => setSyncFor({ profileId: profile.id, bucket, prefix: e.key }) },
      { type: "sep" },
      { type: "item", label: "Rename…", icon: "edit", disabled: !one, onClick: () => ops.askRename(e) },
      { type: "item", label: list.length > 1 ? `Delete ${list.length} items…` : "Delete…", icon: "trash", hint: "⌘⌫", danger: true, onClick: () => ops.askDelete(list) },
    ]);
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  };

  const onMoreMenu = (x: number, y: number) => setMenu({ x, y, items: tidyMenu(placeItems()) });

  // ------------------------------------------------------------ commands (keyboard + menu bar)
  const togglePreview = () =>
    setPreviewOpen((o) => {
      LS.set("s3b.preview", o ? "0" : "1");
      return !o;
    });
  const focusSearch = () => {
    searchInput.current?.focus();
    searchInput.current?.select();
  };
  const undo = () => {
    const u = undoStack.pop();
    if (!u) {
      toast("info", "Nothing to undo");
      return;
    }
    toast("info", `Undoing the ${u.label}…`);
    void u.run();
  };
  const quickLook = () => {
    if (quick) return setQuick(null);
    const key = cursor.current && selected.has(cursor.current) ? cursor.current : selectedEntries[0]?.key;
    if (key) setQuick(key);
  };

  /** Every action reachable from a shortcut or the menu bar, by menu id. */
  const commands: Record<string, () => void> = {
    "new-folder": () => ops.askNewFolder(),
    "upload-files": () => void ops.pickAndUpload(false),
    "upload-folder": () => void ops.pickAndUpload(true),
    download: () => void ops.downloadEntries(selectedEntries, relBase),
    refresh,
    "go-up": () => prefix && !search && navigate(parentPrefix(prefix)),
    back: () => historyStep(-1),
    forward: () => historyStep(1),
    "go-to": () => bucket && setGoTo(true),
    search: focusSearch,
    "select-all": () => setSelected(new Set(entries.map((e) => e.key))),
    delete: () => selectedEntries.length && ops.askDelete(selectedEntries),
    rename: () => selectedEntries.length === 1 && ops.askRename(selectedEntries[0]),
    "get-info": togglePreview,
    settings: () => openSettings(),
    "new-connection": () => setConnDialog({ profile: null }),
    open: () => openSelection(),
    "quick-look": quickLook,
    copy: () => ops.clip(selectedEntries, "copy"),
    cut: () => ops.clip(selectedEntries, "cut"),
    paste: () => ops.paste(),
    undo,
    deselect: () => setSelected(new Set()),
  };

  /** A dialog, menu or preview is up: it owns the keyboard, and actions must not run behind it. */
  const overlayUp = () =>
    !!(confirm || prompt || connDialog || moveDialog || kyblDialog || menu || conflicts.open || goTo || syncFor || quick) ||
    !!document.querySelector(".modal-backdrop, .ctx-menu, .ql-backdrop");

  const route = (id: string): boolean => {
    if (id === "settings") {
      openSettings();
      return true;
    }
    if (overlayUp()) return false;
    if (settingsOpen) {
      if (id === "new-connection") commands[id]();
      return id === "new-connection";
    }
    const run = commands[id];
    if (!run || !bucket) {
      // without a bucket on screen only connection-level actions make sense
      if (id === "new-connection" || id === "back" || id === "forward") run?.();
      return !!run;
    }
    run();
    return true;
  };
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.isComposing) return;
      const t = ev.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      const onControl = !!t.closest?.("button, a[href], [role=button], [role=menuitem], [role=tab], [role=switch]");
      const mod = ev.metaKey || ev.ctrlKey;
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      const textSelected = !!window.getSelection()?.toString();
      // keys with a menu-bar accelerator on macOS are handled there (the `menu` event)
      const own = (id: string) => (MENU_OWNS_SHORTCUTS ? null : id);
      let id: string | null = null;
      if (mod && k === ",") id = own("settings");
      else if (mod && ev.shiftKey && k === "n") id = own("new-folder");
      else if (mod && !ev.shiftKey && k === "u") id = own("upload-files");
      else if (mod && k === "[") id = own("back");
      else if (mod && k === "]") id = own("forward");
      else if (mod && ev.shiftKey && k === "g") id = own("go-to");
      else if (mod && k === "i") id = own("get-info");
      else if (mod && k === "l") id = "go-to";
      else if (mod && k === "r") id = "refresh";
      else if (mod && k === "f") id = "search";
      else if (settingsOpen) {
        // a dialog open on top of settings handles its own Escape
        if (ev.key === "Escape" && !overlayUp()) setSettingsOpen(false);
        return;
      } else if (typing) return;
      else if (mod && k === "a") id = "select-all";
      else if (ev.key === "Delete" || (mod && ev.key === "Backspace")) id = "delete";
      else if (mod && k === "c" && !textSelected) id = "copy";
      else if (mod && k === "x" && !textSelected) id = "cut";
      else if (mod && k === "v") id = "paste";
      else if (mod && k === "z" && !ev.shiftKey) id = "undo";
      else if (mod && k === "o") id = "open";
      else if (mod && ev.key === "ArrowUp") id = "go-up";
      else if (mod && ev.key === "ArrowDown") id = "open";
      else if (mod) return;
      else if (ev.key === "Backspace") id = "go-up";
      else if (ev.key === "F2") id = "rename";
      else if (onControl && (ev.key === "Enter" || ev.key === " ")) return;
      else if (ev.key === "Enter") id = selectedEntries.length ? "open" : null;
      else if (ev.key === " ") id = selectedEntries.length ? "quick-look" : null;
      else if (ev.key === "Escape") id = "deselect";
      else if (ev.key.startsWith("Arrow") && (document.activeElement === document.body || !document.activeElement) && !overlayUp()) {
        // nothing focused (after a sidebar click or a closed dialog): arrows still move in the list
        const list = document.querySelector<HTMLElement>(".table, .grid-scroll");
        const grid = list?.classList.contains("grid-scroll");
        const cols = grid ? getComputedStyle(list!.querySelector(".grid")!).gridTemplateColumns.split(" ").length || 1 : 1;
        const delta = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: grid ? 1 : 0, ArrowLeft: grid ? -1 : 0 }[ev.key] ?? 0;
        if (delta && bucket) {
          ev.preventDefault();
          moveSelection(delta, ev.shiftKey);
          list?.focus();
        }
        return;
      }
      if (!id) return;
      if (routeRef.current(id)) ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // menu bar items, the window coming back to the front, mouse back/forward buttons
  const lastResume = useRef(0);
  const resumeRef = useRef(() => {});
  resumeRef.current = () => {
    if (!here || search || lst.loading || overlayUp() || Date.now() - lastResume.current < RESUME_REFRESH_MS) return;
    lastResume.current = Date.now();
    void lst.refresh(here);
  };
  useEffect(() => {
    const offs = [
      listen<string>("menu", (e) => void routeRef.current(String(e.payload))),
      listen("app-resumed", () => resumeRef.current()),
    ];
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      routeRef.current(e.button === 3 ? "back" : "forward");
    };
    // WebKit's own menu (Reload, Inspect…) means nothing here; text fields and selected text keep theirs
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, [contenteditable=true]") || window.getSelection()?.toString()) return;
      e.preventDefault();
    };
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      for (const off of offs) off.then((f) => f()).catch(() => {});
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  // ------------------------------------------------------------ drag & drop from Finder
  const dropRef = useRef(ops.uploadPaths);
  dropRef.current = ops.uploadPaths;
  const canDrop = useRef(false);
  canDrop.current = !!(profile && bucket);
  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") setDragOver(canDrop.current);
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          if (canDrop.current) void dropRef.current(p.paths);
        }
      })
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  // ------------------------------------------------------------ press, drag to move
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const { drag, begin: beginDrag } = useItemDrag({
    onDrop: (items, dest, copy, destBucket) => void opsRef.current.relocate(items, dest, copy ? "copy" : "move", destBucket ? { destBucket } : {}),
    onSpring: (dest) => navigateRef.current(dest),
    bucketTarget: (pid, b) => (pid === profile?.id && !search ? (b === bucket ? "same" : "other") : null),
  });

  const onPress = useCallback(
    (e: Entry, ev: React.MouseEvent) => {
      const { selected: sel, selectedEntries: selEntries } = selRef.current;
      const mods = { meta: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey };
      if (ev.button !== 0) {
        if (ev.button === 2 && sel.has(e.key)) return;
        if (ev.button === 2) select(e, mods);
        return;
      }
      const was = sel.has(e.key);
      // pressing an item of a multi-selection keeps the selection (so it can be dragged);
      // a click without dragging then narrows it to that item, like Finder
      if (!(was && !mods.meta && !mods.shift)) select(e, mods);
      if (mods.meta || mods.shift) return;
      beginDrag(ev, was ? selEntries : [e], was && sel.size > 1 ? () => select(e, mods) : undefined);
    },
    [select, beginDrag],
  );

  // ------------------------------------------------------------ details pane resize
  const startResize = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const sx = ev.clientX;
    const sw = previewWidth;
    const max = () => Math.min(PREVIEW_MAX, Math.round(window.innerWidth * 0.6));
    let w = sw;
    document.body.classList.add("resizing-col");
    const move = (e: MouseEvent) => {
      w = Math.max(PREVIEW_MIN, Math.min(max(), sw + sx - e.clientX));
      setPreviewWidth(w);
    };
    const up = () => {
      document.body.classList.remove("resizing-col");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      LS.set("s3b.previewWidth", String(w));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const resizeBy = (delta: number) => {
    const w = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, previewWidth + delta));
    setPreviewWidth(w);
    LS.set("s3b.previewWidth", String(w));
  };

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
      anchor.current = cursor.current = next.key;
    },
    [entries, quick],
  );
  const closeQuick = useCallback(() => setQuick(null), []);
  const openFromQuick = useCallback((e: Entry) => openEntry(e), [openEntry]);
  const downloadFromQuick = useCallback((e: Entry) => void opsRef.current.downloadEntries([e]), []);

  // ------------------------------------------------------------ render
  const emptyAction = (
    <button className="btn btn-sm" onClick={() => ops.pickAndUpload(false)}>
      <Icon name="upload" size={14} /> Upload files
    </button>
  );
  const moreOnServer = !search && fresh && !!listing.next;
  const listError = fresh ? lst.error : null;
  const totalSize = entries.reduce((s, e) => s + (e.kind === "file" ? e.size : 0), 0);
  const hereSize = folderSizes.get(prefix);
  const working = lst.loading || !!busy || !!search?.running;

  return (
    <div className="app">
      <Sidebar
        profiles={profiles}
        activeId={activeId}
        expanded={expanded}
        bucketsBy={bucketsBy}
        bucket={bucket}
        onToggleProfile={toggleConnection}
        onEditProfile={(p) => setConnDialog({ profile: p })}
        onNewProfile={() => setConnDialog({ profile: null })}
        onOpenSettings={() => openSettings()}
        syncState={syncState}
        onOpenSync={() => openSettings("sync")}
        onSelectBucket={(p, b) => openBucket(p, b)}
        onOpenBucketByName={askBucketName}
        onNewBucket={askNewBucket}
        hiddenBuckets={hiddenBuckets}
        onHideBucket={setBucketHidden}
        onReconnect={(p) => setKyblDialog({ existing: p, reconnect: true })}
        favorites={settings.favorites}
        onOpenFavorite={openFavorite}
        onRemoveFavorite={removeFavorite}
      />

      <main className="main">
        <Toolbar
          bucket={bucket}
          prefix={prefix}
          canUp={!!prefix && !search}
          canBack={hist.canBack}
          canForward={hist.canForward}
          selectionCount={selected.size}
          singleFileSelected={singleFile}
          previewOpen={previewOpen}
          searchActive={!!search}
          searchRunning={!!search?.running && !search.stopped}
          query={query}
          searchInput={searchInput}
          disabled={!profile || !bucket}
          working={working}
          view={view}
          compact={compact}
          sort={sort}
          tileSize={tile}
          onView={setView}
          onCompact={setCompact}
          onSortChange={setSort}
          onTileSize={changeTile}
          onNavigate={navigate}
          onUp={() => navigate(parentPrefix(prefix))}
          onBack={() => historyStep(-1)}
          onForward={() => historyStep(1)}
          onRefresh={refresh}
          onUploadMenu={(x, y) =>
            setMenu({
              x,
              y,
              items: [
                { type: "item", label: "Files…", icon: "file", hint: "⌘U", onClick: () => ops.pickAndUpload(false) },
                { type: "item", label: "Folder…", icon: "folder", onClick: () => ops.pickAndUpload(true) },
              ],
            })
          }
          onMoreMenu={onMoreMenu}
          onNewFolder={() => ops.askNewFolder()}
          onDownload={() => ops.downloadEntries(selectedEntries, relBase)}
          onCopyLink={() => singleFile && copyLink(selectedEntries[0], settings.linkExpiry)}
          onRename={() => selectedEntries[0] && ops.askRename(selectedEntries[0])}
          onMoveTo={() => askMove(selectedEntries)}
          onDelete={() => ops.askDelete(selectedEntries)}
          onQuery={(q) => {
            setQuery(q);
            // editing the text after a deep search goes back to filtering the folder
            if (search && q.trim() !== search.query) sr.clear();
          }}
          onSearch={doSearch}
          onStopSearch={sr.stop}
          onClearSearch={clearSearch}
          onClearSelection={() => setSelected(new Set())}
          onTogglePreview={togglePreview}
        />

        {search && (
          <div className="banner">
            {search.running && !search.stopped ? <span className="spinner" /> : <Icon name="search" size={14} />}
            <span>
              <strong>
                {entries.length.toLocaleString()} {entries.length === 1 ? "result" : "results"}
              </strong>{" "}
              for “{search.query}” in <code>/{search.loc.prefix}</code>
              {search.running && !search.stopped
                ? ` · searching, ${search.scanned.toLocaleString()} objects checked so far`
                : search.stopped
                  ? " · stopped early"
                  : search.truncated
                    ? " · showing the first matches only, refine your search"
                    : ` · ${search.scanned.toLocaleString()} objects checked`}
            </span>
            {search.running && !search.stopped ? (
              <button className="btn btn-sm" onClick={sr.stop}>
                Stop
              </button>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={clearSearch}>
                Clear search
              </button>
            )}
          </div>
        )}
        {!search && filter && fresh && (
          <div className="banner">
            <Icon name="search" size={14} />
            <span>
              <strong>
                {entries.length.toLocaleString()} of {allEntries.length.toLocaleString()}
              </strong>{" "}
              {moreOnServer ? "loaded items" : "items"} in this folder match “{query.trim()}”
            </span>
            <button className="btn btn-sm" onClick={() => doSearch(query.trim())}>
              Search subfolders too
            </button>
          </div>
        )}
        {listError && entries.length > 0 && (
          <div className="banner error">
            <Icon name="alert" size={14} />
            <span>{listError}</span>
            <button className="btn btn-sm" onClick={refresh}>
              <Icon name="retry" size={13} /> Retry
            </button>
          </div>
        )}

        <div className="content" style={{ "--preview-w": `${previewWidth}px` } as React.CSSProperties}>
          <div className={`pane ${compact ? "compact" : ""}`}>
            {!profile && (
              <div className="welcome">
                <div className="welcome-card">
                  <KyblMark size={76} className="welcome-mark" />
                  <h1>Welcome to Kybl</h1>
                  <p>Browse, upload, download and share files on any S3-compatible storage. Your secret keys stay in the system keychain.</p>
                  <button className="btn btn-primary" onClick={() => setKyblDialog({ existing: null })}>
                    <Icon name="cloud" size={15} /> Connect Kybl Storage
                  </button>
                  <button className="btn btn-ghost welcome-alt" onClick={() => setConnDialog({ profile: null })}>
                    Add another S3 connection with keys
                  </button>
                  <div className="welcome-providers" aria-hidden="true">
                    {PROVIDERS.map((p) => (
                      <ProviderBadge key={p.id} provider={p.id} large />
                    ))}
                  </div>
                </div>
              </div>
            )}
            {profile && !bucket && (
              <div className="welcome">
                <div className="welcome-card">
                  <div className="welcome-logo plain">
                    <Icon name="bucket" size={30} />
                  </div>
                  <h1>Choose a bucket</h1>
                  <p>{(activeId && bucketsBy[activeId]?.note) || "Pick a bucket from the sidebar."}</p>
                  {profile && activeId && bucketsBy[activeId]?.reconnect ? (
                    <button className="btn btn-primary" onClick={() => setKyblDialog({ existing: profile, reconnect: true })}>
                      <Icon name="refresh" size={14} /> Connect again
                    </button>
                  ) : (
                    <button className="btn" onClick={() => (profile?.provider === KYBL ? askNewBucket() : askBucketName())}>
                      {profile?.provider === KYBL ? "New bucket" : "Open bucket by name"}
                    </button>
                  )}
                </div>
              </div>
            )}
            {profile && bucket && (
              <>
                {listError && entries.length === 0 && !search ? (
                  <div className="empty error-state">
                    <div className="empty-art">
                      <Icon name="alert" size={26} />
                    </div>
                    <h3>Couldn’t load this folder</h3>
                    <p>
                      <ErrorText message={profile.provider === KYBL && isRevokedKey(listError) ? kyblError(listError) : listError} />
                    </p>
                    {profile.provider === KYBL && isRevokedKey(listError) ? (
                      <button className="btn btn-primary btn-sm kybl-reconnect" onClick={() => setKyblDialog({ existing: profile, reconnect: true })}>
                        <Icon name="refresh" size={13} /> Connect again
                      </button>
                    ) : (
                      <button className="btn btn-sm" onClick={refresh}>
                        <Icon name="retry" size={13} /> Try again
                      </button>
                    )}
                  </div>
                ) : view === "grid" ? (
                  <GridView
                    key={`${settings.binaryUnits}${settings.absoluteDates}${settings.listThumbs}`}
                    entries={entries}
                    selected={selected}
                    loading={search ? search.running && !search.stopped && entries.length === 0 : lst.loading || !fresh}
                    hasMore={hasMore}
                    searchMode={!!search}
                    prefix={search ? search.loc.prefix : prefix}
                    tile={tile}
                    profileId={profile.id}
                    bucket={bucket}
                    emptyAction={emptyAction}
                    onPress={onPress}
                    onOpen={openEntry}
                    onContext={onContext}
                    onLoadMore={loadMore}
                    onClearSelection={() => setSelected(new Set())}
                    onMove={moveSelection}
                    onBackgroundContextMenu={onBackgroundContext}
                  />
                ) : (
                  <FileTable
                    key={`${settings.binaryUnits}${settings.absoluteDates}`}
                    entries={entries}
                    selected={selected}
                    sort={sort}
                    loading={search ? search.running && !search.stopped && entries.length === 0 : lst.loading || !fresh}
                    hasMore={hasMore}
                    searchMode={!!search}
                    prefix={search ? search.loc.prefix : prefix}
                    emptyAction={emptyAction}
                    onSort={onSort}
                    onPress={onPress}
                    onOpen={openEntry}
                    onContext={onContext}
                    onLoadMore={loadMore}
                    onClearSelection={() => setSelected(new Set())}
                    onMove={moveSelection}
                    onBackgroundContextMenu={onBackgroundContext}
                    folderSize={folderSizes.get}
                    onCalcSize={(k) => calcSizes([k])}
                  />
                )}
                <footer className="statusbar">
                  <span>
                    {entries.length.toLocaleString()}
                    {moreOnServer && !filter ? "+" : ""} {entries.length === 1 && !moreOnServer ? "item" : "items"}
                    {totalSize > 0 ? ` · ${formatBytes(totalSize)}` : ""}
                  </span>
                  {selected.size > 0 && (
                    <span className="sel">
                      · {selected.size} selected
                      {selectedEntries.some((e) => e.kind === "file")
                        ? ` (${formatBytes(selectedEntries.reduce((s, e) => s + (e.kind === "file" ? e.size : 0), 0))})`
                        : ""}
                    </span>
                  )}
                  {hereSize && !search && (
                    <span title={hereSize.error}>
                      ·{" "}
                      {hereSize.state === "done"
                        ? `Whole folder: ${formatBytes(hereSize.bytes)} in ${hereSize.objects.toLocaleString()} objects`
                        : hereSize.state === "loading"
                          ? `Adding up the folder… ${formatBytes(hereSize.bytes)} so far`
                          : "Couldn’t work out the folder size"}
                    </span>
                  )}
                  <span className="spacer" />
                  {lst.pulling && !busy && !search && (
                    <span className="busy">
                      <span className="spinner" /> {needsAll ? "Loading the whole folder to sort it" : "Loading the rest of the folder"}… {loadedCount.toLocaleString()} so far
                    </span>
                  )}
                  {sortCapped && !busy && <span>Sorted the first {MAX_SORT_ITEMS.toLocaleString()} items only</span>}
                  {hasMore && !lst.loading && !busy && <span title="S3 lists big folders in pages">In order: the first {loadedCount.toLocaleString()} items. More load as you scroll</span>}
                  {busy && (
                    <span className="busy">
                      <span className="spinner" /> {busy}
                    </span>
                  )}
                </footer>
              </>
            )}
            {dragOver && (
              <div className="drop-overlay">
                <div className="drop-card">
                  <Icon name="upload" size={34} />
                  <strong>Drop to upload</strong>
                  <span>
                    to {bucket}/{prefix}
                  </span>
                </div>
              </div>
            )}
          </div>
          {previewOpen && profile && bucket && (
            <div
              className="pane-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize details pane"
              aria-valuenow={previewWidth}
              aria-valuemin={PREVIEW_MIN}
              aria-valuemax={PREVIEW_MAX}
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              onMouseDown={startResize}
              onDoubleClick={() => {
                setPreviewWidth(PREVIEW_DEFAULT);
                LS.set("s3b.previewWidth", String(PREVIEW_DEFAULT));
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") resizeBy(24);
                if (e.key === "ArrowRight") resizeBy(-24);
              }}
            />
          )}
          {previewOpen && profile && bucket && (
            <PreviewPane
              defaultExpiry={settings.linkExpiry}
              profileId={profile.id}
              bucket={bucket}
              selection={selectedEntries}
              onCopyLink={(secs) => selectedEntries[0] && copyLink(selectedEntries[0], secs)}
              onCopyText={copyText}
              onDownload={() => ops.downloadEntries(selectedEntries, relBase)}
              onRename={() => selectedEntries[0] && ops.askRename(selectedEntries[0])}
              onMoveTo={() => askMove(selectedEntries)}
              onDelete={() => ops.askDelete(selectedEntries)}
              onContext={onContext}
              onChanged={() => reloadIfShowing(profile.id, bucket)}
              folderSize={folderSizes.get}
              onCalcSize={(k) => calcSizes([k])}
            />
          )}
        </div>

        <TransferPanel
          onCancelJob={(id) => api.cancelTransfer(id).catch(() => {})}
          onDismissJob={jobs.dismiss}
          onOpenJob={(j) => {
            if (j.dest == null) return;
            const p = profiles.find((x) => x.id === j.profileId);
            if (p && j.bucket) go(p, j.bucket, j.dest);
          }}
          onOpenSync={() => openSettings("sync")}
          open={transfersOpen}
          onToggle={() => setTransfersOpen((o) => !o)}
          onCancel={transfers.cancel}
          onCancelAll={transfers.cancelAll}
          onRetry={transfers.retry}
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
          activeProfileId={activeId}
          onToast={toast}
        />
      )}
      {kyblDialog && (
        <KyblConnectDialog
          existing={kyblDialog.existing}
          reconnect={kyblDialog.reconnect}
          onClose={() => setKyblDialog(null)}
          onConnected={(p) => {
            setProfiles((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
            connect(p);
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
            setProfiles((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
            connect(p);
          }}
          onDeleted={forgetProfile}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          danger={!confirm.safe}
          onConfirm={confirm.run}
          onClose={() => {
            confirm.cancel?.();
            setConfirm(null);
          }}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          confirmLabel={prompt.confirmLabel}
          onSubmit={prompt.run}
          onClose={() => setPrompt(null)}
        />
      )}
      {moveDialog && profile && bucket && (
        <MoveDialog
          profileId={profile.id}
          bucket={bucket}
          buckets={bucketsBy[profile.id]?.names}
          items={moveDialog.items}
          initialMode={moveDialog.mode}
          startPrefix={search ? entryParent(moveDialog.items[0]) : prefix}
          onSubmit={(dest, mode, destBucket) => ops.relocate(moveDialog.items, dest, mode, { destBucket })}
          onClose={() => setMoveDialog(null)}
        />
      )}
      {goTo && bucket && <GoToDialog bucket={bucket} prefix={prefix} onGo={goToPath} onClose={() => setGoTo(false)} />}
      {syncFor && (
        <SyncThisFolder
          profiles={profiles}
          profileId={syncFor.profileId}
          bucket={syncFor.bucket}
          prefix={syncFor.prefix}
          onDone={() => toast("success", "Folder added. The first sync starts in a moment.")}
          onClose={() => setSyncFor(null)}
        />
      )}
      {conflicts.element}
      {quick && quickIndex >= 0 && profile && bucket && (
        <QuickLook
          profileId={profile.id}
          bucket={bucket}
          entry={entries[quickIndex]}
          index={quickIndex}
          count={entries.length}
          onStep={stepQuick}
          onClose={closeQuick}
          onOpen={openFromQuick}
          onDownload={downloadFromQuick}
        />
      )}
      {drag && (
        <div className="drag-ghost" style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 12}px)` }} aria-hidden="true">
          <span className="drag-stack">
            <Icon name={drag.items.length === 1 && drag.items[0].kind === "file" ? "file" : "folder"} size={14} />
            {drag.items.length > 1 && <span className="drag-count">{drag.items.length}</span>}
          </span>
          <span className="drag-text">
            <strong>{drag.items.length === 1 ? drag.items[0].name : `${drag.items.length} items`}</strong>
            <span>
              {drag.dest != null
                ? `${drag.copy ? "Copy" : "Move"} to ${drag.bucket ?? destLabel(drag.dest, bucket ?? "")}${drag.bucket ? (drag.copy ? " · ⌘ to move" : "") : ""}`
                : "Drop on a folder · ⌥ to copy"}
            </span>
          </span>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {!settingsOpen && <UpdateBanner st={updates} />}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
