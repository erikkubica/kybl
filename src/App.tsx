import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorText } from "./components/ErrorText";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
import { listen } from "@tauri-apps/api/event";
import { MoveDialog } from "./components/MoveDialog";
import { destKey, destLabel, entryParent } from "./moving";
import { useItemDrag } from "./useItemDrag";
import { applySettings, expiryLabel, loadSettings, saveSettings, type Settings } from "./settings";
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  Toasts,
  type MenuItem,
  type Toast,
} from "./components/Dialogs";
import { Icon } from "./Icons";
import type { Entry, ObjInfo, Profile } from "./types";
import "./styles.css";

const PREVIEW_MIN = 260;
const PREVIEW_MAX = 760;
const PREVIEW_DEFAULT = 336;

type Listing = { folders: string[]; objects: ObjInfo[]; next: string | null };
type SearchState = { query: string; results: ObjInfo[]; scanned: number; truncated: boolean };

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

/** Sorting by anything but name needs the whole folder; stop pulling pages past this many objects. */
const MAX_SORT_ITEMS = 200_000;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const toArray = (r: unknown): string[] => (Array.isArray(r) ? (r as string[]) : r ? [r as string] : []);
const joinPath = (dir: string, rel: string) => `${dir.replace(/[\\/]$/, "")}/${rel}`;

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
  const [listing, setListing] = useState<Listing>({ folders: [], objects: [], next: null });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
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
  const updateSettings = (patch: Partial<Settings>) =>
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      saveSettings(next);
      applySettings(next);
      return next;
    });
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [connDialog, setConnDialogState] = useState<{ profile: Profile | null } | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  /** Opens the editor for a connection: Kybl Storage connections have their own (no keys to edit). */
  const setConnDialog = useCallback((d: { profile: Profile | null } | null) => {
    if (d?.profile?.provider === KYBL) setKyblDialog({ existing: d.profile });
    else setConnDialogState(d);
  }, []);
  const [confirm, setConfirm] = useState<null | { title: string; message: React.ReactNode; label: string; run: () => void; safe?: boolean }>(null);
  const [moveDialog, setMoveDialog] = useState<null | { items: Entry[]; mode: "move" | "copy" }>(null);
  const [previewWidth, setPreviewWidth] = useState(() => {
    const w = Number(LS.get("s3b.previewWidth"));
    return w >= PREVIEW_MIN && w <= PREVIEW_MAX ? w : PREVIEW_DEFAULT;
  });
  const [prompt, setPrompt] = useState<null | { title: string; label: string; initial: string; confirmLabel: string; run: (v: string) => void }>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; items: MenuItem[] }>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const anchor = useRef<string | null>(null);
  const cursor = useRef<string | null>(null);
  const reqId = useRef(0);
  const pendingSelect = useRef<string | null>(null);

  // ------------------------------------------------------------ toasts
  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3200);
  }, []);
  const onError = useCallback((m: string) => toast("error", m), [toast]);

  const transfers = useTransfers(onError);
  const jobs = useJobs();

  const profile = useMemo(() => profiles.find((p) => p.id === activeId) ?? null, [profiles, activeId]);
  const folderSizes = useFolderSizes(profile?.id ?? null, bucket);

  // ------------------------------------------------------------ listing
  const load = useCallback(
    async (profileId: string, b: string, p: string, token: string | null = null) => {
      const id = ++reqId.current;
      setLoading(true);
      setListError(null);
      try {
        const res = await api.listObjects(profileId, b, p, token);
        if (id !== reqId.current) return;
        setListing((prev) =>
          token
            ? { folders: [...prev.folders, ...res.folders], objects: [...prev.objects, ...res.objects], next: res.nextToken }
            : { folders: res.folders, objects: res.objects, next: res.nextToken },
        );
        if (!token && pendingSelect.current) {
          const key = pendingSelect.current;
          pendingSelect.current = null;
          if (res.objects.some((o) => o.key === key)) {
            setSelected(new Set([key]));
            anchor.current = cursor.current = key;
          }
        }
      } catch (e) {
        if (id !== reqId.current) return;
        setListError(errMessage(e));
        if (!token) setListing({ folders: [], objects: [], next: null });
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [],
  );

  /**
   * Pulls every remaining page (for sorts S3 can't do). Pages are gathered and shown about once a
   * second instead of one by one, so a 200,000-object folder is not re-sorted 200 times.
   */
  const loadRest = useCallback(async (profileId: string, b: string, p: string, token: string, have: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setListError(null);
    let folders: string[] = [];
    let objects: ObjInfo[] = [];
    let next: string | null = token;
    let last = performance.now();
    const commit = () => {
      const [f, o, n] = [folders, objects, next];
      folders = [];
      objects = [];
      setListing((prev) => ({ folders: f.length ? prev.folders.concat(f) : prev.folders, objects: o.length ? prev.objects.concat(o) : prev.objects, next: n }));
      last = performance.now();
    };
    try {
      while (next && have < MAX_SORT_ITEMS) {
        const res = await api.listObjects(profileId, b, p, next);
        if (id !== reqId.current) return;
        for (const f of res.folders) folders.push(f);
        for (const o of res.objects) objects.push(o);
        have += res.folders.length + res.objects.length;
        next = res.nextToken;
        if (performance.now() - last > 1000) commit();
      }
      commit();
    } catch (e) {
      if (id !== reqId.current) return;
      commit();
      setListError(errMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    if (profile && bucket) load(profile.id, bucket, prefix);
  }, [profile, bucket, prefix, load]);

  // async actions finish after the user may have navigated: always reload what is on screen now
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // what is on screen right now, for work that finishes later (uploads, moves, deletes, renames)
  const onScreen = useRef<{ profileId?: string; bucket: string | null; query?: string; doSearch?: (q: string) => Promise<void> }>({ bucket: null });
  /**
   * After a job in `pid`/`b` finishes, reloads the listing only if that bucket is still the one on
   * screen. Work in another connection or bucket carries on undisturbed in the meantime.
   */
  const reloadIfShowing = useCallback((pid: string, b: string) => {
    const v = onScreen.current;
    if (v.profileId !== pid || v.bucket !== b) return false;
    if (v.query !== undefined && v.doSearch) void v.doSearch(v.query);
    else refreshRef.current();
    return true;
  }, []);

  const navigate = useCallback(
    (p: string, selectKey?: string) => {
      if (!profile || !bucket) return;
      setPrefix(p);
      setSearch(null);
      setSelected(new Set());
      anchor.current = cursor.current = null;
      pendingSelect.current = selectKey ?? null;
      LS.set("s3b.last", JSON.stringify({ profileId: profile.id, bucket, prefix: p }));
      load(profile.id, bucket, p);
    },
    [profile, bucket, load],
  );

  const openBucket = useCallback(
    (p: Profile, b: string, startPrefix = "") => {
      setActiveId(p.id);
      setBucket(b);
      setPrefix(startPrefix);
      setSearch(null);
      setSelected(new Set());
      LS.set("s3b.last", JSON.stringify({ profileId: p.id, bucket: b, prefix: startPrefix }));
      load(p.id, b, startPrefix);
    },
    [load],
  );

  const setExpandedSaved = useCallback((fn: (cur: Set<string>) => Set<string>) => {
    setExpanded((cur) => {
      const next = fn(cur);
      LS.set(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

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
  const bucketsRef = useRef(bucketsBy);
  bucketsRef.current = bucketsBy;

  /** Shows a connection: expands it in the sidebar and opens a bucket of it. */
  const connect = useCallback(
    async (p: Profile, preferBucket?: string, startPrefix = "") => {
      setActiveId(p.id);
      setBucket(null);
      setListing({ folders: [], objects: [], next: null });
      setListError(null);
      setExpandedSaved((cur) => (cur.has(p.id) ? cur : new Set(cur).add(p.id)));
      const names = await loadBuckets(p, true);
      const pick = preferBucket && names.includes(preferBucket) ? preferBucket : p.bucket || names[0];
      if (pick) openBucket(p, pick, pick === preferBucket ? startPrefix : "");
    },
    [openBucket, loadBuckets, setExpandedSaved],
  );

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
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  /** A connection was deleted: drop it from the sidebar and the screen. */
  const forgetProfile = useCallback(
    (id: string) => {
      setProfiles((list) => list.filter((x) => x.id !== id));
      setExpandedSaved((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
      if (id === activeIdRef.current) {
        setActiveId(null);
        setBucket(null);
        setListing({ folders: [], objects: [], next: null });
      }
    },
    [setExpandedSaved],
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
  useEffect(
    () =>
      transfers.onUploadsSettled((ok, bad, where) => {
        if (bad) toast("error", `${bad} ${bad === 1 ? "upload" : "uploads"} failed`);
        else if (ok) toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
        for (const w of where) if (reloadIfShowing(w.profileId, w.bucket)) break;
      }),
    [transfers, toast, reloadIfShowing],
  );

  // ------------------------------------------------------------ entries
  const entries: Entry[] = useMemo(() => {
    let list: Entry[];
    if (search) {
      list = search.results.map((o) => ({
        kind: "file",
        key: o.key,
        name: baseName(o.key),
        size: o.size,
        modified: o.modified,
        etag: o.etag,
        storageClass: o.storageClass,
      }));
    } else {
      list = [
        ...listing.folders.map<Entry>((f) => ({ kind: "folder", key: f, name: baseName(f), size: 0, modified: null })),
        ...listing.objects.map<Entry>((o) => ({
          kind: "file",
          key: o.key,
          name: baseName(o.key),
          size: o.size,
          modified: o.modified,
          etag: o.etag,
          storageClass: o.storageClass,
        })),
      ];
    }
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
      if (!search && settings.foldersFirst && a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return cmp(a, b);
    });
  }, [listing, search, sort, settings.foldersFirst]);

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.key)), [entries, selected]);
  const singleFile = selectedEntries.length === 1 && selectedEntries[0].kind === "file";
  useEffect(() => {
    selRef.current = { selected, selectedEntries };
  });

  // S3 only lists in key order, one page at a time. Any other order is only correct once the whole
  // folder is in memory, so keep pulling pages until it is (or the cap is hit).
  const needsAll = !search && (sort.key !== "name" || sort.dir !== "asc");
  const loadedCount = listing.folders.length + listing.objects.length;
  const sortCapped = needsAll && !!listing.next && loadedCount >= MAX_SORT_ITEMS;
  const loadingAll = needsAll && !!listing.next && !sortCapped && !listError;
  useEffect(() => {
    if (loadingAll && !loading && profile && bucket && listing.next) loadRest(profile.id, bucket, prefix, listing.next, loadedCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingAll, loading, profile, bucket, prefix, listing.next, loadRest]);


  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

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

  // refs so the memoised grid cards don't re-render on every selection change
  const selRef = useRef({ selected, selectedEntries: [] as Entry[] });

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

  const openEntry = useCallback(
    (e: Entry) => {
      if (e.kind === "folder") navigate(e.key);
      else if (search) navigate(parentPrefix(e.key), e.key);
      else setPreviewOpen(true);
    },
    [navigate, search],
  );

  // ------------------------------------------------------------ actions
  const doSearch = async (query: string) => {
    if (!profile || !bucket) return;
    setBusy(`Searching for “${query}”…`);
    try {
      const r = await api.searchObjects(profile.id, bucket, prefix, query);
      setSearch({ query, results: r.objects, scanned: r.scanned, truncated: r.truncated });
      setSelected(new Set());
    } catch (e) {
      toast("error", errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  onScreen.current = { profileId: profile?.id, bucket, query: search?.query, doSearch };

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

  const uploadPaths = useCallback(
    async (paths: string[]) => {
      if (!profile || !bucket || paths.length === 0) return;
      try {
        const files = await api.expandPaths(paths);
        if (files.length === 0) {
          toast("info", "Nothing to upload");
          return;
        }
        transfers.add(
          files.map((f) => ({
            kind: "upload" as const,
            name: f.rel,
            profileId: profile.id,
            bucket,
            key: prefix + f.rel,
            local: f.path,
            total: f.size,
          })),
        );
        if (settings.autoOpenTransfers) setTransfersOpen(true);
      } catch (e) {
        toast("error", errMessage(e));
      }
    },
    [profile, bucket, prefix, transfers, toast],
  );

  const pickAndUpload = async (directory: boolean) => {
    const r = await openDialog({ multiple: true, directory, title: directory ? "Choose folders to upload" : "Choose files to upload" });
    await uploadPaths(toArray(r));
  };

  const downloadEntries = async (list: Entry[]) => {
    if (!profile || !bucket || list.length === 0) return;
    try {
      if (list.length === 1 && list[0].kind === "file") {
        const f = list[0];
        const dest = await saveDialog({ defaultPath: f.name, title: "Save as" });
        if (!dest) return;
        transfers.add([{ kind: "download", name: f.name, profileId: profile.id, bucket, key: f.key, local: dest, total: f.size }]);
        if (settings.autoOpenTransfers) setTransfersOpen(true);
        return;
      }
      const dir = toArray(await openDialog({ directory: true, multiple: false, title: "Choose a download folder" }))[0];
      if (!dir) return;
      const items: Parameters<typeof transfers.add>[0] = [];
      for (const e of list) {
        if (e.kind === "file") {
          items.push({ kind: "download", name: e.name, profileId: profile.id, bucket, key: e.key, local: joinPath(dir, e.name), total: e.size });
        } else {
          setBusy(`Listing ${e.name}…`);
          const base = parentPrefix(e.key);
          for (const rf of await api.listAllUnder(profile.id, bucket, e.key)) {
            const rel = rf.key.slice(base.length);
            items.push({ kind: "download", name: rel, profileId: profile.id, bucket, key: rf.key, local: joinPath(dir, rel), total: rf.size });
          }
        }
      }
      setBusy(null);
      if (items.length === 0) {
        toast("info", "Nothing to download");
        return;
      }
      transfers.add(items);
      if (settings.autoOpenTransfers) setTransfersOpen(true);
      toast("info", `Downloading ${items.length} ${items.length === 1 ? "file" : "files"} to ${dir}`);
    } catch (e) {
      setBusy(null);
      toast("error", errMessage(e));
    }
  };

  const askDelete = (list: Entry[]) => {
    if (!profile || !bucket || list.length === 0) return;
    const folders = list.filter((e) => e.kind === "folder");
    const files = list.filter((e) => e.kind === "file");
    const what = list.length === 1 ? `“${list[0].name}”` : `${list.length} items`;
    const pid = profile.id;
    const b = bucket;
    const run = async () => {
      const id = jobs.start({ kind: "delete", title: `Deleting ${what}` });
      if (settings.autoOpenTransfers) setTransfersOpen(true);
      setSelected((sel) => {
        const next = new Set(sel);
        list.forEach((e) => next.delete(e.key));
        return next;
      });
      try {
        const r = await api.deleteObjects(pid, b, files.map((e) => e.key), folders.map((e) => e.key), id);
        jobs.finish(id, r);
        if (r.error && r.error !== "Cancelled") toast("error", `Deleting stopped after ${r.done.toLocaleString()} of ${r.total.toLocaleString()} objects. ${r.error}`);
      } catch (e) {
        jobs.finish(id, { error: errMessage(e) });
        toast("error", errMessage(e));
      }
      folderSizes.clear();
      reloadIfShowing(pid, b);
    };
    if (!settings.confirmDelete) {
      run();
      return;
    }
    setConfirm({
      title: `Delete ${what}?`,
      label: "Delete",
      message: (
        <>
          <p>
            {folders.length > 0
              ? "Folders are deleted together with everything inside them. "
              : ""}
            This permanently removes the {files.length + folders.length === 1 ? "item" : "items"} from the bucket and{" "}
            <strong>cannot be undone</strong>.
          </p>
          {!list.every((e) => e.kind === "folder") && files.length > 0 && (
            <p>
              {files.length} {files.length === 1 ? "file" : "files"}, {formatBytes(files.reduce((s, e) => s + e.size, 0))}
            </p>
          )}
        </>
      ),
      run,
    });
  };

  const askRename = (e: Entry) => {
    if (!profile || !bucket) return;
    setPrompt({
      title: e.kind === "folder" ? "Rename folder" : "Rename file",
      label: "New name",
      initial: e.name,
      confirmLabel: "Rename",
      run: async (name) => {
        if (name.includes("/")) {
          toast("error", "A name cannot contain “/”");
          return;
        }
        if (name === e.name) return;
        const parent = e.kind === "folder" ? parentPrefix(e.key) : e.key.slice(0, e.key.lastIndexOf("/") + 1);
        const isFolder = e.kind === "folder";
        const to = isFolder ? `${parent}${name}/` : `${parent}${name}`;
        // a single file renames instantly; a folder is every object inside it
        const pid = profile.id;
        const b = bucket;
        const id = jobs.start({ kind: "rename", title: `Renaming “${e.name}” to “${name}”`, dest: parent, profileId: pid, bucket: b });
        if (isFolder && settings.autoOpenTransfers) setTransfersOpen(true);
        let renamed = false;
        try {
          const r = await api.moveMany(pid, b, [{ from: e.key, to, isPrefix: isFolder }], true, id);
          jobs.finish(id, r);
          if (r.error && r.error !== "Cancelled") toast("error", `Renaming stopped after ${r.done.toLocaleString()} of ${r.total.toLocaleString()} objects. ${r.error}`);
          else renamed = !r.error;
        } catch (err) {
          jobs.finish(id, { error: errMessage(err) });
          toast("error", errMessage(err));
        }
        const v = onScreen.current;
        if (renamed && v.profileId === pid && v.bucket === b) {
          pendingSelect.current = isFolder ? null : to;
          setSelected(new Set());
        }
        reloadIfShowing(pid, b);
      },
    });
  };

  /** Moves or copies entries into `dest` (same bucket), asking before replacing existing files. */
  const relocate = async (list: Entry[], dest: string, mode: "move" | "copy") => {
    if (!profile || !bucket) return;
    const pid = profile.id;
    const b = bucket;
    const todo = list.filter((e) => entryParent(e) !== dest && !(e.kind === "folder" && dest.startsWith(e.key)));
    if (todo.length === 0) return;
    const where = destLabel(dest, b);

    const run = async () => {
      const what = todo.length === 1 ? `“${todo[0].name}”` : `${todo.length} items`;
      const id = jobs.start({ kind: mode, title: `${mode === "move" ? "Moving" : "Copying"} ${what} to ${where}`, dest, profileId: pid, bucket: b });
      if (settings.autoOpenTransfers) setTransfersOpen(true);
      if (mode === "move")
        setSelected((sel) => {
          const next = new Set(sel);
          todo.forEach((e) => next.delete(e.key));
          return next;
        });
      try {
        const r = await api.moveMany(
          pid,
          b,
          todo.map((e) => ({ from: e.key, to: destKey(e, dest), isPrefix: e.kind === "folder" })),
          mode === "move",
          id,
        );
        jobs.finish(id, r);
        if (r.error && r.error !== "Cancelled")
          toast(
            "error",
            `Stopped after ${r.done.toLocaleString()} of ${r.total.toLocaleString()} objects. ${r.error}` +
              (mode === "move" ? " Everything not moved yet is still in its old place." : ""),
          );
      } catch (err) {
        jobs.finish(id, { error: errMessage(err) });
        toast("error", errMessage(err));
      }
      folderSizes.clear();
      reloadIfShowing(pid, b);
    };

    // files that already exist at the destination would be silently overwritten
    const files = todo.filter((e) => e.kind === "file");
    let clashes: Entry[] = [];
    if (files.length && files.length <= 200) {
      setBusy("Checking the destination…");
      const found = await Promise.all(
        files.map((e) =>
          api
            .headObject(pid, b, destKey(e, dest))
            .then(() => true)
            .catch(() => false),
        ),
      );
      setBusy(null);
      clashes = files.filter((_, i) => found[i]);
    }
    if (clashes.length === 0) {
      run();
      return;
    }
    setConfirm({
      title: clashes.length === 1 ? `Replace “${clashes[0].name}”?` : `Replace ${clashes.length} files?`,
      label: "Replace",
      safe: true,
      message: (
        <p>
          {clashes.length === 1 ? "A file with this name already exists" : `${clashes.length} files with the same names already exist`} in{" "}
          <strong>/{dest}</strong>. {mode === "move" ? "Moving" : "Copying"} will overwrite {clashes.length === 1 ? "it" : "them"}.
        </p>
      ),
      run,
    });
  };

  const askMove = (list: Entry[], mode: "move" | "copy" = "move") => {
    if (list.length) setMoveDialog({ items: list, mode });
  };

  const askNewFolder = () => {
    if (!profile || !bucket) return;
    setPrompt({
      title: "New folder",
      label: "Folder name",
      initial: "New folder",
      confirmLabel: "Create",
      run: async (name) => {
        if (name.includes("/")) {
          toast("error", "A name cannot contain “/”");
          return;
        }
        try {
          await api.createFolder(profile.id, bucket, `${prefix}${name}/`);
          refresh();
        } catch (e) {
          toast("error", errMessage(e));
        }
      },
    });
  };

  const askBucketName = (p: Profile | null = profile) => {
    if (!p) return;
    setPrompt({
      title: "Open bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Open",
      run: (name) => {
        setBucketsBy((m) => {
          const cur = m[p.id] ?? { names: [], note: null, loading: false };
          return cur.names.includes(name) ? m : { ...m, [p.id]: { ...cur, names: [...cur.names, name], note: null } };
        });
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

  // ------------------------------------------------------------ context menu
  const onContext = (ev: React.MouseEvent, e: Entry) => {
    const list = selected.has(e.key) ? selectedEntries : [e];
    if (!selected.has(e.key)) {
      setSelected(new Set([e.key]));
      anchor.current = cursor.current = e.key;
    }
    const one = list.length === 1;
    const items: MenuItem[] = [
      { type: "item", label: e.kind === "folder" && one ? "Open" : "Details", icon: e.kind === "folder" ? "folder" : "eye", hint: "↵", disabled: !one, onClick: () => openEntry(e) },
      { type: "item", label: "Download", icon: "download", onClick: () => downloadEntries(list) },
      {
        type: "item",
        label: `Copy share link (${expiryLabel(settings.linkExpiry)})`,
        icon: "link",
        disabled: !(one && e.kind === "file"),
        onClick: () => copyLink(e, settings.linkExpiry),
      },
      {
        type: "item",
        label: "Copy S3 URI",
        icon: "copy",
        disabled: !one || !bucket,
        onClick: () => copyText(`s3://${bucket}/${e.key}`, "S3 URI"),
      },
      { type: "sep" },
      { type: "item", label: "Move to…", icon: "move", onClick: () => askMove(list, "move") },
      { type: "item", label: "Copy to…", icon: "copy", onClick: () => askMove(list, "copy") },
      ...(prefix && !search
        ? [{ type: "item" as const, label: `Move to “${destLabel(parentPrefix(prefix), bucket ?? "")}”`, icon: "arrow-up" as const, onClick: () => relocate(list, parentPrefix(prefix), "move") }]
        : []),
      { type: "sep" },
      { type: "item", label: "Rename…", icon: "edit", disabled: !one, onClick: () => askRename(e) },
      { type: "item", label: list.length > 1 ? `Delete ${list.length} items…` : "Delete…", icon: "trash", hint: "⌘⌫", danger: true, onClick: () => askDelete(list) },
    ];
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  };

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key === ",") {
        ev.preventDefault();
        openSettings();
        return;
      }
      if (confirm || prompt || connDialog || moveDialog) return;
      if (settingsOpen) {
        // a dialog open on top of settings handles its own Escape
        if (ev.key === "Escape" && !document.querySelector(".modal")) setSettingsOpen(false);
        return;
      }
      if (mod && ev.key.toLowerCase() === "r") {
        ev.preventDefault();
        refresh();
      } else if (typing) {
        return;
      } else if (mod && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        setSelected(new Set(entries.map((e) => e.key)));
      } else if (ev.key === "Delete" || (mod && ev.key === "Backspace")) {
        if (selectedEntries.length) {
          ev.preventDefault();
          askDelete(selectedEntries);
        }
      } else if (ev.key === "Enter" && selectedEntries.length === 1) {
        openEntry(selectedEntries[0]);
      } else if (ev.key === "Escape") {
        setSelected(new Set());
      } else if ((mod && ev.key === "ArrowUp") || ev.key === "Backspace") {
        if (prefix) navigate(parentPrefix(prefix));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------ drag & drop from Finder
  const dropRef = useRef(uploadPaths);
  dropRef.current = uploadPaths;
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
          if (canDrop.current) dropRef.current(p.paths);
        }
      })
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  // ------------------------------------------------------------ press, drag to move
  const relocateRef = useRef(relocate);
  relocateRef.current = relocate;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const { drag, begin: beginDrag } = useItemDrag({
    onDrop: (items, dest, copy) => relocateRef.current(items, dest, copy ? "copy" : "move"),
    onSpring: (dest) => navigateRef.current(dest),
  });

  const onPress = useCallback(
    (e: Entry, ev: React.MouseEvent) => {
      const { selected: sel, selectedEntries: selEntries } = selRef.current;
      const mods = { meta: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey };
      if (ev.button !== 0) {
        if (ev.button === 2 && sel.has(e.key)) return;
        select(e, mods);
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

  // ------------------------------------------------------------ render
  const emptyAction = (
    <button className="btn btn-sm" onClick={() => pickAndUpload(false)}>
      <Icon name="upload" size={14} /> Upload files
    </button>
  );
  const moreOnServer = !search && !!listing.next;
  // only the rows on screen are rendered (see useWindowed); this pulls the next page from S3
  const hasMore = moreOnServer && !needsAll;
  const loadMore = () => {
    if (profile && bucket && listing.next && !loading && !needsAll) load(profile.id, bucket, prefix, listing.next);
  };
  const totalSize = entries.reduce((s, e) => s + (e.kind === "file" ? e.size : 0), 0);

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
      />

      <main className="main">
        <Toolbar
          bucket={bucket}
          prefix={prefix}
          canUp={!!prefix}
          selectionCount={selected.size}
          singleFileSelected={singleFile}
          previewOpen={previewOpen}
          searchActive={!!search}
          disabled={!profile || !bucket}
          working={loading || !!busy}
          view={view}
          compact={compact}
          sort={sort}
          onView={setView}
          onCompact={setCompact}
          onSortChange={setSort}
          onNavigate={navigate}
          onUp={() => navigate(parentPrefix(prefix))}
          onRefresh={refresh}
          onUploadMenu={(x, y) =>
            setMenu({
              x,
              y,
              items: [
                { type: "item", label: "Files…", icon: "file", onClick: () => pickAndUpload(false) },
                { type: "item", label: "Folder…", icon: "folder", onClick: () => pickAndUpload(true) },
              ],
            })
          }
          onNewFolder={askNewFolder}
          onDownload={() => downloadEntries(selectedEntries)}
          onCopyLink={() => singleFile && copyLink(selectedEntries[0], settings.linkExpiry)}
          onRename={() => selectedEntries[0] && askRename(selectedEntries[0])}
          onMoveTo={() => askMove(selectedEntries)}
          onDelete={() => askDelete(selectedEntries)}
          onSearch={doSearch}
          onClearSearch={() => setSearch(null)}
          onClearSelection={() => setSelected(new Set())}
          onTogglePreview={() => {
            setPreviewOpen((o) => {
              LS.set("s3b.preview", o ? "0" : "1");
              return !o;
            });
          }}
        />

        {search && (
          <div className="banner">
            <Icon name="search" size={14} />
            <span>
              <strong>
                {search.results.length.toLocaleString()} {search.results.length === 1 ? "result" : "results"}
              </strong>{" "}
              for “{search.query}” in <code>/{prefix}</code>
              {search.truncated ? " · showing the first matches only, refine your search" : ` · ${search.scanned.toLocaleString()} objects scanned`}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => setSearch(null)}>
              Clear search
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
                {listError && entries.length === 0 ? (
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
                    loading={loading}
                    hasMore={hasMore}
                    searchMode={!!search}
                    prefix={prefix}
                    tile={compact ? 128 : 192}
                    profileId={profile.id}
                    bucket={bucket}
                    emptyAction={emptyAction}
                    onPress={onPress}
                    onOpen={openEntry}
                    onContext={onContext}
                    onLoadMore={loadMore}
                    onClearSelection={() => setSelected(new Set())}
                    onMove={moveSelection}
                  />
                ) : (
                  <FileTable
                    key={`${settings.binaryUnits}${settings.absoluteDates}`}
                    entries={entries}
                    selected={selected}
                    sort={sort}
                    loading={loading}
                    hasMore={hasMore}
                    searchMode={!!search}
                    prefix={prefix}
                    emptyAction={emptyAction}
                    onSort={onSort}
                    onPress={onPress}
                    onOpen={openEntry}
                    onContext={onContext}
                    onLoadMore={loadMore}
                    onClearSelection={() => setSelected(new Set())}
                    onMove={moveSelection}
                  />
                )}
                <footer className="statusbar">
                  <span>
                    {entries.length.toLocaleString()}
                    {moreOnServer ? "+" : ""} {entries.length === 1 && !moreOnServer ? "item" : "items"}
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
                  <span className="spacer" />
                  {loadingAll && !busy && (
                    <span className="busy">
                      <span className="spinner" /> Loading the whole folder to sort it…
                    </span>
                  )}
                  {sortCapped && !busy && <span>Sorted the first {MAX_SORT_ITEMS.toLocaleString()} items only</span>}
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
              onDownload={() => downloadEntries(selectedEntries)}
              onRename={() => selectedEntries[0] && askRename(selectedEntries[0])}
              onMoveTo={() => askMove(selectedEntries)}
              onDelete={() => askDelete(selectedEntries)}
              onContext={onContext}
            />
          )}
        </div>

        <TransferPanel
          onCancelJob={(id) => api.cancelTransfer(id).catch(() => {})}
          onDismissJob={jobs.dismiss}
          onOpenJob={(j) => {
            if (j.dest == null) return;
            if (j.profileId === profile?.id && j.bucket === bucket) navigate(j.dest);
            else toast("info", "That was in another bucket. Open it from the sidebar.");
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
          onClose={() => setConfirm(null)}
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
          items={moveDialog.items}
          initialMode={moveDialog.mode}
          startPrefix={prefix}
          onSubmit={(dest, mode) => relocate(moveDialog.items, dest, mode)}
          onClose={() => setMoveDialog(null)}
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
                ? `${drag.copy ? "Copy" : "Move"} to ${destLabel(drag.dest, bucket ?? "")}`
                : "Drop on a folder · ⌥ to copy"}
            </span>
          </span>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
