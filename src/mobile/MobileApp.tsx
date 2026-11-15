/**
 * Kybl on a phone or tablet (iOS / Android). Same Rust backend and the same building blocks as the
 * desktop app (api, transfer queue, jobs, preview, connection and move dialogs), laid out for touch.
 *
 * Phones: connections → buckets → folders as a stack of screens with large titles, files open full
 * screen (photos and videos in a swipeable viewer), long-press selects, and the system back
 * gesture / button walks back up. Tablets (≥ 900 px): connections in a sidebar, files in the
 * middle, details in a panel on the right, like the desktop app.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { baseName, classify, formatBytes, formatDate, isWebImage, parentPrefix } from "../format";
import { useTransfers } from "../useTransfers";
import { useJobs } from "../useJobs";
import { applySettings, loadSettings, saveSettings, type Settings } from "../settings";
import { Icon, type IconName } from "../Icons";
import { ConnectionDialog } from "../components/ConnectionDialog";
import { KyblConnectDialog } from "../components/KyblConnectDialog";
import { KYBL, KYBL_CONNECT, REVOKED_SAY, isRevokedKey } from "../kybl";
import { ConfirmDialog, PromptDialog, Toasts, type Toast } from "../components/Dialogs";
import { MoveDialog } from "../components/MoveDialog";
import { PreviewPane } from "../components/PreviewPane";
import { ProviderBadge } from "../components/Sidebar";
import { FileIcon } from "../components/FileIcon";
import { destKey, destLabel, entryParent } from "../moving";
import { PROVIDERS } from "../providers";
import { EntryRow, EntryTile, SkeletonList } from "./rows";
import { ActionSheet, type SheetItem } from "./ActionSheet";
import { TransfersScreen, useActiveCount } from "./TransfersScreen";
import { SettingsScreen } from "./SettingsScreen";
import { Viewer } from "./Viewer";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Lockup, Mascot } from "./Mascot";
import { Presence, useCollapsed, useWide } from "./ui";
import type { Entry, ObjInfo, Profile } from "../types";
import "../styles.css";
import "./mobile.css";

type Loc = { profileId: string; bucket: string; prefix: string };
type Listing = { folders: string[]; objects: ObjInfo[]; next: string | null };
/** `revoked`: a Kybl Storage key the storage no longer knows (offer "Connect again") */
type Buckets = { names: string[]; note: string | null; loading: boolean; revoked?: boolean };
type SortKey = "name" | "modified" | "size";
type ViewMode = "auto" | "list" | "grid";

const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const ANDROID = /Android/i.test(navigator.userAgent);
const SAVED_WHERE = IOS ? "Files › On My iPhone › Kybl" : "Download/Kybl";
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

const toArray = (r: string | string[] | null): string[] => (r == null ? [] : Array.isArray(r) ? r : [r]);
const sameLoc = (a: Loc, b: Loc) => a.profileId === b.profileId && a.bucket === b.bucket && a.prefix === b.prefix;
const isMedia = (e: Entry) => e.kind === "file" && ((classify(e.name) === "image" && isWebImage(e.name)) || classify(e.name) === "video");

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // older Android web views refuse the async clipboard: fall back to a selected textarea
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("Could not access the clipboard");
  }
}


export default function MobileApp() {
  const wide = useWide();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [buckets, setBuckets] = useState<Record<string, Buckets>>({});
  const [loc, setLoc] = useState<Loc | null>(null);
  const [nav, setNav] = useState<"in" | "out">("in");
  const [listing, setListing] = useState<Listing>({ folders: [], objects: [], next: null });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
  const [detail, setDetail] = useState<Entry | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [sheet, setSheet] = useState<{ title?: string; items: SheetItem[] } | null>(null);
  const [screen, setScreen] = useState<"transfers" | "settings" | null>(null);
  const [connDialog, setConnDialog] = useState<{ profile: Profile | null } | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  /** Kybl Storage connections have their own editor: there are no keys to edit. */
  const editProfile = useCallback((p: Profile) => {
    if (p.provider === KYBL && KYBL_CONNECT) setKyblDialog({ existing: p });
    else setConnDialog({ profile: p });
  }, []);
  const connectKybl = useCallback(() => setKyblDialog({ existing: null }), []);
  const [confirm, setConfirm] = useState<null | { title: string; message: React.ReactNode; label: string; run: () => void }>(null);
  const [prompt, setPrompt] = useState<null | { title: string; label: string; initial: string; confirmLabel: string; run: (v: string) => void }>(null);
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

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 2800);
  }, []);
  const onError = useCallback((m: string) => toast("error", errSummary(m)), [toast]);
  const transfers = useTransfers(onError);
  const jobs = useJobs();
  const activeTransfers = useActiveCount();


  const updateSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
    applySettings(s);
  };

  // the launch splash in index.html stays until the first screen is ready
  useEffect(() => {
    if (profiles === null) return;
    const s = document.getElementById("splash");
    if (!s) return;
    s.classList.add("gone");
    const t = window.setTimeout(() => s.remove(), 400);
    return () => window.clearTimeout(t);
  }, [profiles]);

  // ------------------------------------------------------------ data
  const reqId = useRef(0);
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

  const load = useCallback(async (l: Loc, token: string | null = null) => {
    const id = ++reqId.current;
    setLoading(true);
    setListError(null);
    try {
      const res = await api.listObjects(l.profileId, l.bucket, l.prefix, token);
      if (id !== reqId.current) return;
      if (!token) settleBucket(l, true);
      setListing((prev) =>
        token
          ? { folders: [...prev.folders, ...res.folders], objects: [...prev.objects, ...res.objects], next: res.nextToken }
          : { folders: res.folders, objects: res.objects, next: res.nextToken },
      );
    } catch (e) {
      if (id !== reqId.current) return;
      if (!token) settleBucket(l, false);
      setListError(errMessage(e));
      if (!token) setListing({ folders: [], objects: [], next: null });
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [settleBucket]);

  const locRef = useRef(loc);
  locRef.current = loc;
  const refresh = useCallback(() => {
    if (locRef.current) load(locRef.current);
  }, [load]);
  const reloadIfShowing = useCallback(
    (pid: string, b: string) => {
      const l = locRef.current;
      if (l && l.profileId === pid && l.bucket === b) load(l);
    },
    [load],
  );

  const go = useCallback(
    (l: Loc | null, dir: "in" | "out" = "in") => {
      setNav(dir);
      setLoc(l);
      setSelecting(null);
      stopSearch();
      setSearchOpen(false);
      setQuery("");
      setDetail(null);
      setViewer(null);
      setListing({ folders: [], objects: [], next: null });
      if (l) {
        LS.set("m.last", JSON.stringify(l));
        setRecent((r) => {
          const next = [l, ...r.filter((x) => !sameLoc(x, l))].slice(0, 8);
          LS.set("m.recent", JSON.stringify(next));
          return next;
        });
        load(l);
      } else {
        LS.set("m.last", "");
        reqId.current++;
      }
    },
    [load],
  );

  const loadBuckets = useCallback(async (p: Profile) => {
    setBuckets((m) => ({ ...m, [p.id]: { names: m[p.id]?.names ?? [], note: null, loading: true } }));
    let names: string[] = [];
    let note: string | null = null;
    let revoked = false;
    try {
      names = (await api.listBuckets(p.id)).map((b) => b.name);
    } catch (e) {
      const msg = errMessage(e);
      revoked = p.provider === KYBL && KYBL_CONNECT && isRevokedKey(msg);
      note = revoked
        ? REVOKED_SAY
        : /access denied|not allowed/i.test(msg)
          ? "This key can't list buckets. Open one by its name below."
          : errSummary(msg);
    }
    if (p.bucket && !names.includes(p.bucket)) names = [p.bucket, ...names];
    // buckets opened by name stay with the connection (a key may reach buckets it cannot list)
    for (const b of readJson<Record<string, string[]>>("m.extraBuckets", {})[p.id] ?? []) if (!names.includes(b)) names.push(b);
    setBuckets((m) => ({ ...m, [p.id]: { names, note: names.length && !revoked ? null : note, loading: false, revoked } }));
    return names;
  }, []);

  const reloadProfiles = useCallback(async () => {
    try {
      const list = await api.listProfiles();
      setProfiles(list);
      return list;
    } catch (e) {
      toast("error", errMessage(e));
      setProfiles([]);
      return [];
    }
  }, [toast]);

  useEffect(() => {
    (async () => {
      const list = await reloadProfiles();
      for (const p of list) loadBuckets(p);
      // forget recent places of connections that are gone
      setRecent((r) => r.filter((x) => list.some((p) => p.id === x.profileId)));
      if (!settings.restoreLast) return;
      const last = readJson<Loc | null>("m.last", null);
      if (last && list.some((p) => p.id === last.profileId)) go(last);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () =>
      transfers.onUploadsSettled((ok, failed, where) => {
        for (const w of where) reloadIfShowing(w.profileId, w.bucket);
        if (failed) toast("error", `${failed} ${failed === 1 ? "upload" : "uploads"} failed. Open Transfers to retry.`);
        else if (ok) toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
      }),
    [transfers, reloadIfShowing, toast],
  );

  // ------------------------------------------------------------ entries
  const entries: Entry[] = useMemo(() => {
    if (search) {
      return search.results.map((o) => ({ kind: "file" as const, key: o.key, name: baseName(o.key), size: o.size, modified: o.modified, etag: o.etag, storageClass: o.storageClass }));
    }
    const folders: Entry[] = listing.folders.map((f) => ({ kind: "folder", key: f, name: baseName(f), size: 0, modified: null }));
    const files: Entry[] = listing.objects
      .filter((o) => o.key !== loc?.prefix)
      .map((o) => ({ kind: "file", key: o.key, name: baseName(o.key), size: o.size, modified: o.modified, etag: o.etag, storageClass: o.storageClass }));
    const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const cmp =
      sort === "modified"
        ? (a: Entry, b: Entry) => (b.modified ?? 0) - (a.modified ?? 0) || byName(a, b)
        : sort === "size"
          ? (a: Entry, b: Entry) => b.size - a.size || byName(a, b)
          : byName;
    folders.sort(byName);
    files.sort(cmp);
    return [...folders, ...files];
  }, [listing, search, sort, loc?.prefix]);

  const media = useMemo(() => entries.filter(isMedia), [entries]);
  const fileCount = entries.filter((e) => e.kind === "file").length;
  // "auto": photo folders open as a grid, everything else as a list
  const showGrid = view === "grid" || (view === "auto" && fileCount >= 2 && media.length / fileCount >= 0.6);

  // a deleted photo leaves the viewer on its neighbour, or closes it
  useEffect(() => {
    if (viewer === null) return;
    if (media.length === 0) setViewer(null);
    else if (viewer >= media.length) setViewer(media.length - 1);
  }, [media, viewer]);

  // ------------------------------------------------------------ back navigation
  /**
   * One step back, from the topmost thing on screen down to the connection list. The system back
   * (Android button, the history) and every on-screen back arrow go through here.
   */
  const back = (): boolean => {
    if (confirm) setConfirm(null);
    else if (prompt) setPrompt(null);
    else if (moveDialog) setMoveDialog(null);
    else if (connDialog) setConnDialog(null);
    else if (sheet) setSheet(null);
    else if (detail) setDetail(null);
    else if (viewer !== null) setViewer(null);
    else if (screen) setScreen(null);
    else if (selecting) setSelecting(null);
    else if (searchOpen || search) {
      setSearchOpen(false);
      stopSearch();
      setQuery("");
    } else if (loc && loc.prefix) go({ ...loc, prefix: parentPrefix(loc.prefix) }, "out");
    else if (loc) go(null, "out");
    else return false;
    return true;
  };
  const backRef = useRef(back);
  backRef.current = back;
  const depth =
    Number(!!confirm) + Number(!!prompt) + Number(!!moveDialog) + Number(!!connDialog) + Number(!!sheet) + Number(!!detail) +
    Number(viewer !== null) + Number(!!screen) + Number(!!selecting) + Number(searchOpen || !!search) + (loc ? 1 : 0);

  // Keep exactly one history entry ahead while there is somewhere to go back to: the system back
  // pops it, and we step back in the app instead of leaving. At the root the entry is dropped so
  // the next back leaves the app as people expect.
  const armed = useRef(false);
  const skipPop = useRef(false);
  // Bumped on every handled back, so the entry is re-armed even when the depth stays the same
  // (going up one folder keeps depth at 1).
  const [popTick, setPopTick] = useState(0);
  useEffect(() => {
    // Android's back button calls this directly (MainActivity.kt), no history needed.
    if (ANDROID) {
      (window as unknown as { __kyblBack?: () => boolean }).__kyblBack = () => backRef.current();
      return;
    }
    if (depth > 0 && !armed.current) {
      history.pushState({ kybl: 1 }, "");
      armed.current = true;
    } else if (depth === 0 && armed.current) {
      armed.current = false;
      skipPop.current = true;
      history.back();
    }
  }, [depth, popTick]);
  useEffect(() => {
    const onPop = () => {
      if (skipPop.current) {
        skipPop.current = false;
        return;
      }
      armed.current = false;
      backRef.current();
      setPopTick((t) => t + 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // iOS keeps the layout viewport full height under the keyboard and scrolls the page instead,
  // pushing fixed sheets up under the status bar. Size the app to the visible part and keep the
  // page pinned, so everything sits above the keyboard as on Android.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !IOS) return;
    // the tallest the view has been at this width is the height without a keyboard; some
    // WebViews shrink innerHeight along with the visual viewport, so it can't be the reference
    let full = 0;
    let width = 0;
    const fit = () => {
      if (vv.width !== width) {
        width = vv.width;
        full = 0;
      }
      full = Math.max(full, vv.height);
      document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      document.documentElement.classList.toggle("m-kb", vv.height < full - 80);
      if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, []);

  // When the keyboard opens the view shrinks; keep the field being typed in on screen.
  useEffect(() => {
    const reveal = () => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };
    let t: number | undefined;
    const later = () => {
      window.clearTimeout(t);
      t = window.setTimeout(reveal, 120);
    };
    // iOS doesn't resize the window for the keyboard, only the visual viewport
    const vv = window.visualViewport;
    window.addEventListener("resize", later);
    vv?.addEventListener("resize", later);
    document.addEventListener("focusin", later);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", later);
      vv?.removeEventListener("resize", later);
      document.removeEventListener("focusin", later);
    };
  }, []);

  // ------------------------------------------------------------ actions
  const openEntry = (e: Entry) => {
    if (!loc) return;
    if (e.kind === "folder") go({ ...loc, prefix: e.key });
    else if (isMedia(e) && !wide) setViewer(media.findIndex((m) => m.key === e.key));
    else setDetail(e);
  };

  const copyLink = async (e: Entry, secs: number) => {
    if (!loc) return;
    try {
      const url = await api.presign(loc.profileId, loc.bucket, e.key, secs);
      await copyToClipboard(url);
      const n = secs >= 86400 ? Math.round(secs / 86400) : Math.round(secs / 3600);
      toast("success", `Link copied. It expires in ${n} ${secs >= 86400 ? "day" : "hour"}${n === 1 ? "" : "s"}`);
    } catch (err) {
      toast("error", errSummary(errMessage(err)));
    }
  };

  const copyText = async (text: string, what: string) => {
    try {
      await copyToClipboard(text);
      toast("success", `${what} copied`);
    } catch {
      toast("error", "Could not access the clipboard");
    }
  };

  const upload = async (mode: "media" | "document") => {
    if (!loc) return;
    const l = loc;
    try {
      const picked = toArray(await openDialog({ multiple: true, pickerMode: mode, title: "Choose files to upload" }));
      if (picked.length === 0) return;
      const files = await api.pickedFiles(picked);
      transfers.add(
        files.map((f) => ({
          kind: "upload" as const,
          name: f.name,
          profileId: l.profileId,
          bucket: l.bucket,
          key: l.prefix + f.name,
          local: f.path,
          total: f.size,
        })),
      );
      toast("info", `Uploading ${files.length} ${files.length === 1 ? "file" : "files"}`);
    } catch (e) {
      toast("error", errSummary(errMessage(e)));
    }
  };

  const download = async (list: Entry[]) => {
    if (!loc || list.length === 0) return;
    const l = loc;
    try {
      const dir = await api.downloadFolder();
      const join = (rel: string) => `${dir.replace(/\/$/, "")}/${rel}`;
      const items: Parameters<typeof transfers.add>[0] = [];
      for (const e of list) {
        if (e.kind === "file") {
          items.push({ kind: "download", name: e.name, profileId: l.profileId, bucket: l.bucket, key: e.key, local: join(e.name), total: e.size });
        } else {
          const base = parentPrefix(e.key);
          for (const rf of await api.listAllUnder(l.profileId, l.bucket, e.key)) {
            const rel = rf.key.slice(base.length);
            items.push({ kind: "download", name: rel, profileId: l.profileId, bucket: l.bucket, key: rf.key, local: join(rel), total: rf.size });
          }
        }
      }
      if (items.length === 0) {
        toast("info", "Nothing to download");
        return;
      }
      transfers.add(items);
      toast("info", `Saving ${items.length === 1 ? `“${items[0].name}”` : `${items.length} files`} to ${SAVED_WHERE}`);
    } catch (e) {
      toast("error", errSummary(errMessage(e)));
    }
  };

  const askDelete = (list: Entry[]) => {
    if (!loc || list.length === 0) return;
    const { profileId: pid, bucket: b } = loc;
    const folders = list.filter((e) => e.kind === "folder");
    const files = list.filter((e) => e.kind === "file");
    const what = list.length === 1 ? `“${list[0].name}”` : `${list.length} items`;
    const run = async () => {
      setSelecting(null);
      setDetail(null);
      const id = jobs.start({ kind: "delete", title: `Deleting ${what}` });
      try {
        const r = await api.deleteObjects(pid, b, files.map((e) => e.key), folders.map((e) => e.key), id);
        jobs.finish(id, r);
        if (r.error && r.error !== "Cancelled") toast("error", `Deleting stopped after ${r.done} of ${r.total} objects. ${errSummary(r.error)}`);
        else toast("success", `Deleted ${what}`);
      } catch (e) {
        jobs.finish(id, { error: errMessage(e) });
        toast("error", errSummary(errMessage(e)));
      }
      reloadIfShowing(pid, b);
    };
    if (!settings.confirmDelete) return void run();
    setConfirm({
      title: `Delete ${what}?`,
      label: "Delete",
      message: (
        <p>
          {folders.length > 0 ? "Folders are deleted with everything inside them. " : ""}
          This permanently removes {list.length === 1 ? "it" : "them"} from the bucket and <strong>cannot be undone</strong>.
        </p>
      ),
      run,
    });
  };

  /** Buckets the key can use but not list (or another account's): opened by name, then kept. */
  const askBucketName = (p: Profile) => {
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
  };

  const askRename = (e: Entry) => {
    if (!loc) return;
    const { profileId: pid, bucket: b } = loc;
    setPrompt({
      title: e.kind === "folder" ? "Rename folder" : "Rename file",
      label: "New name",
      initial: e.name,
      confirmLabel: "Rename",
      run: async (name) => {
        if (name.includes("/")) return toast("error", "A name cannot contain “/”");
        if (!name || name === e.name) return;
        const isFolder = e.kind === "folder";
        const parent = isFolder ? parentPrefix(e.key) : e.key.slice(0, e.key.lastIndexOf("/") + 1);
        const to = isFolder ? `${parent}${name}/` : `${parent}${name}`;
        const id = jobs.start({ kind: "rename", title: `Renaming “${e.name}” to “${name}”`, dest: parent, profileId: pid, bucket: b });
        try {
          const r = await api.moveMany(pid, b, [{ from: e.key, to, isPrefix: isFolder }], true, id);
          jobs.finish(id, r);
          if (r.error && r.error !== "Cancelled") toast("error", errSummary(r.error));
          else if (detail?.key === e.key) setDetail({ ...e, key: to, name });
        } catch (err) {
          jobs.finish(id, { error: errMessage(err) });
          toast("error", errSummary(errMessage(err)));
        }
        reloadIfShowing(pid, b);
      },
    });
  };

  const relocate = async (list: Entry[], dest: string, mode: "move" | "copy") => {
    if (!loc) return;
    const { profileId: pid, bucket: b } = loc;
    const todo = list.filter((e) => entryParent(e) !== dest && !(e.kind === "folder" && dest.startsWith(e.key)));
    if (todo.length === 0) return;
    setSelecting(null);
    if (mode === "move") setDetail(null);
    const what = todo.length === 1 ? `“${todo[0].name}”` : `${todo.length} items`;
    const id = jobs.start({ kind: mode, title: `${mode === "move" ? "Moving" : "Copying"} ${what} to ${destLabel(dest, b)}`, dest, profileId: pid, bucket: b });
    try {
      const r = await api.moveMany(pid, b, todo.map((e) => ({ from: e.key, to: destKey(e, dest), isPrefix: e.kind === "folder" })), mode === "move", id);
      jobs.finish(id, r);
      if (r.error && r.error !== "Cancelled") toast("error", errSummary(r.error));
      else toast("success", `${mode === "move" ? "Moved" : "Copied"} ${what}`);
    } catch (err) {
      jobs.finish(id, { error: errMessage(err) });
      toast("error", errSummary(errMessage(err)));
    }
    reloadIfShowing(pid, b);
  };

  const newFolder = () => {
    if (!loc) return;
    const l = loc;
    setPrompt({
      title: "New folder",
      label: "Folder name",
      initial: "",
      confirmLabel: "Create",
      run: async (name) => {
        const n = name.trim().replace(/^\/+|\/+$/g, "");
        if (!n) return;
        try {
          await api.createFolder(l.profileId, l.bucket, `${l.prefix}${n}/`);
          reloadIfShowing(l.profileId, l.bucket);
        } catch (e) {
          toast("error", errSummary(errMessage(e)));
        }
      },
    });
  };

  const runSearch = async (q: string) => {
    const query = q.trim();
    if (!loc || !query) return;
    if (searchOp.current) api.cancelTransfer(searchOp.current).catch(() => {});
    const op = `search-${Date.now()}`;
    searchOp.current = op;
    setSearch({ query, results: [], truncated: false, scanned: 0, done: false });
    try {
      const r = await api.searchObjects(loc.profileId, loc.bucket, loc.prefix, query, op);
      if (searchOp.current !== op) return;
      setSearch({ query, results: r.objects, truncated: r.truncated, scanned: r.scanned, done: true });
    } catch (e) {
      if (searchOp.current !== op) return;
      setSearch(null);
      toast("error", errSummary(errMessage(e)));
    } finally {
      if (searchOp.current === op) searchOp.current = null;
    }
  };

  const entryActions = (e: Entry): SheetItem[] => {
    const items: SheetItem[] = [{ icon: "download", label: e.kind === "folder" ? "Download folder" : "Download", run: () => download([e]) }];
    if (e.kind === "file") items.push({ icon: "link", label: "Copy share link", run: () => copyLink(e, settings.linkExpiry) });
    items.push(
      { icon: "edit", label: "Rename", run: () => askRename(e) },
      { icon: "move", label: "Move or copy…", run: () => setMoveDialog({ items: [e], mode: "move" }) },
      { icon: "check", label: "Select", run: () => setSelecting(new Set([e.key])) },
      { icon: "trash", label: "Delete", danger: true, run: () => askDelete([e]) },
    );
    return items;
  };

  const sortSheet = () =>
    setSheet({
      title: "Sort files by",
      items: (["name", "modified", "size"] as SortKey[]).map((k) => ({
        icon: sort === k ? "check" : "sort",
        label: SORT_LABEL[k],
        run: () => {
          setSortState(k);
          LS.set("m.sort", k);
        },
      })),
    });

  const setView = (v: ViewMode) => {
    setViewState(v);
    LS.set("m.view", v);
  };

  const addSheet = () =>
    setSheet({
      items: [
        { icon: "image", label: "Upload photos & videos", run: () => upload("media") },
        { icon: "upload", label: "Upload files", run: () => upload("document") },
        { icon: "folder-plus", label: "New folder", run: newFolder },
      ],
    });

  const toggleSelect = (key: string) =>
    setSelecting((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next.size ? next : null;
    });

  const selectedEntries = selecting ? entries.filter((e) => selecting.has(e.key)) : [];

  // load the next page when the end of the list scrolls into view
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !listing.next || search) return;
    const io = new IntersectionObserver((xs) => {
      if (xs.some((x) => x.isIntersecting) && !loading && locRef.current && listing.next) load(locRef.current, listing.next);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [listing.next, loading, load, search]);

  // ------------------------------------------------------------ render
  const title = loc ? (loc.prefix ? baseName(loc.prefix) : loc.bucket) : "Kybl";
  const [heroRef, collapsed] = useCollapsed<HTMLDivElement>(`${loc?.profileId}${loc?.bucket}${loc?.prefix}${!!search}`);
  const locKey = loc ? `${loc.profileId}|${loc.bucket}|${loc.prefix}` : "home";

  const browse = loc && (
    <section className="m-screen m-browse">
      {selecting ? (
        <header className="m-bar m-bar-select solid">
          <button className="m-icon" onClick={() => setSelecting(null)} aria-label="Cancel selection">
            <Icon name="x" size={22} />
          </button>
          <div className="m-title center">
            <h1>{selecting.size ? `${selecting.size} selected` : "Select items"}</h1>
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
              placeholder={`Search in ${title}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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
            <Breadcrumbs compact={!wide} bucket={loc.bucket} parts={loc.prefix.split("/").filter(Boolean)} onNavigate={(prefix) => go({ ...loc, prefix }, "out")} />
          </div>
          <button className="m-icon" onClick={() => setSearchOpen(true)} aria-label="Search">
            <Icon name="search" size={20} />
          </button>
          {!wide && <TransfersButton count={activeTransfers} onClick={() => setScreen("transfers")} />}
          <button
            className="m-icon"
            aria-label="More"
            onClick={() =>
              setSheet({
                title,
                items: [
                  { icon: "check", label: "Select", run: () => entries[0] && setSelecting(new Set()) },
                  { icon: "folder-plus", label: "New folder", run: newFolder },
                  { icon: "refresh", label: "Refresh", run: refresh },
                ],
              })
            }
          >
            <Icon name="more" size={20} />
          </button>
        </header>
      )}

      <div className="m-scroll" key={`${locKey}${search ? "?" : ""}${settings.listThumbs}`}>
        <div className={`m-page ${nav === "out" ? "from-left" : "from-right"}`}>
          {/* the path (or the query) lives in the bar; this marks the top so the bar turns solid once the list scrolls */}
          <div className="m-sentinel" ref={heroRef} />

          {entries.length > 0 && (
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
                  {entries.length}
                  {listing.next ? "+" : ""} {entries.length === 1 ? "item" : "items"}
                </span>
              )}
              <button className="m-pill" onClick={sortSheet}>
                <Icon name="sort" size={14} />
                {SORT_LABEL[sort]}
              </button>
              <div className="m-seg-icons" role="group" aria-label="View">
                <button className={!showGrid ? "on" : ""} onClick={() => setView("list")} aria-label="List">
                  <Icon name="list" size={16} />
                </button>
                <button className={showGrid ? "on" : ""} onClick={() => setView("grid")} aria-label="Grid">
                  <Icon name="grid" size={16} />
                </button>
              </div>
            </div>
          )}

          {listError ? (
            <div className="m-empty">
              <div className="m-empty-art warn">
                <Icon name="alert" size={30} />
              </div>
              <h3>Couldn't open this {loc.prefix ? "folder" : "bucket"}</h3>
              {/* the plain sentence only: the SDK's debug text helps nobody on a phone */}
              <p className="m-empty-err">{errSummary(listError)}</p>
              <button className="btn" onClick={refresh}>
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
              <p>
                {search.scanned
                  ? `${search.scanned.toLocaleString()} files checked in ${title}`
                  : `Going through ${title}…`}
              </p>
              <div className="m-seek-bar" />
            </div>
          ) : loading && entries.length === 0 && !search ? (
            <SkeletonList />
          ) : entries.length === 0 ? (
            <div className="m-empty">
              <div className="m-empty-art">
                {search ? <Icon name="search" size={30} /> : <FileIcon entry={{ kind: "folder", key: "", name: "", size: 0, modified: null }} size={64} />}
              </div>
              <h3>{search ? "Nothing found" : "This folder is empty"}</h3>
              {search ? (
                <p>
                  No file names in {title} contain “{search.query}”
                  {search.scanned ? ` (${search.scanned.toLocaleString()} checked)` : ""}.
                </p>
              ) : (
                <p>Upload photos, videos or files from your device.</p>
              )}
              {!search && (
                <button className="btn btn-primary m-big-btn" onClick={addSheet}>
                  <Icon name="upload" size={16} /> Upload
                </button>
              )}
            </div>
          ) : showGrid ? (
            <div className="m-grid">
              {entries.map((e, i) => (
                <div key={e.key} className="m-cell" style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
                  <EntryTile
                    entry={e}
                    profileId={loc.profileId}
                    bucket={loc.bucket}
                    selected={selecting?.has(e.key)}
                    selecting={!!selecting}
                    active={wide && detail?.key === e.key}
                    onTap={() => (selecting ? toggleSelect(e.key) : openEntry(e))}
                    onLongPress={() => (selecting ? toggleSelect(e.key) : setSheet({ title: e.name, items: entryActions(e) }))}
                  />
                </div>
              ))}
            </div>
          ) : (
            <ul className="m-list">
              {entries.map((e) => (
                <EntryRow
                  key={e.key}
                  entry={e}
                  profileId={loc.profileId}
                  bucket={loc.bucket}
                  sub={
                    search
                      ? `${parentPrefix(e.key) || "/"} · ${formatBytes(e.size)}`
                      : e.kind === "folder"
                        ? "Folder"
                        : `${formatBytes(e.size)} · ${formatDate(e.modified)}`
                  }
                  selected={selecting?.has(e.key)}
                  selecting={!!selecting}
                  active={wide && detail?.key === e.key}
                  onTap={() => (selecting ? toggleSelect(e.key) : openEntry(e))}
                  onLongPress={() => toggleSelect(e.key)}
                  onMore={() => setSheet({ title: e.name, items: entryActions(e) })}
                />
              ))}
            </ul>
          )}
          {listing.next && !search && (
            <div ref={sentinel} className="m-more">
              {loading ? <span className="spinner" /> : <button className="btn btn-sm" onClick={() => load(loc, listing.next)}>Load more</button>}
            </div>
          )}
        </div>
      </div>

      {selecting ? (
        <nav className="m-actionbar">
          <BarButton icon="download" label="Download" disabled={!selecting.size} onClick={() => download(selectedEntries)} />
          <BarButton icon="move" label="Move" disabled={!selecting.size || !!search} onClick={() => setMoveDialog({ items: selectedEntries, mode: "move" })} />
          <BarButton icon="trash" label="Delete" danger disabled={!selecting.size} onClick={() => askDelete(selectedEntries)} />
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
    <PreviewPane
      profileId={loc.profileId}
      bucket={loc.bucket}
      selection={[detail]}
      defaultExpiry={settings.linkExpiry}
      onCopyLink={(secs) => copyLink(detail, secs)}
      onCopyText={copyText}
      onDownload={() => download([detail])}
      onRename={() => askRename(detail)}
      onMoveTo={() => setMoveDialog({ items: [detail], mode: "move" })}
      onDelete={() => askDelete([detail])}
      onContext={(ev) => ev.preventDefault()}
    />
  );

  const connections = (
    <Connections
      profiles={profiles}
      buckets={buckets}
      current={loc}
      compact={wide}
      onRetry={loadBuckets}
      onOpen={(p, b) => go({ profileId: p.id, bucket: b, prefix: "" })}
      onAdd={() => setConnDialog({ profile: null })}
      onEdit={editProfile}
      onReconnect={(p) => setKyblDialog({ existing: p, reconnect: true })}
      onOpenByName={askBucketName}
    />
  );

  return (
    <div className={`m-app ${wide ? "wide" : ""}`}>
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
              <TransfersButton count={activeTransfers} onClick={() => setScreen("transfers")} />
              <button className="m-icon" onClick={() => setScreen("settings")} aria-label="Settings">
                <Icon name="settings" size={20} />
              </button>
            </div>
          </aside>
          <main className="m-main">
            <div className="m-main-files">
              {browse || (
                <div className="m-placeholder">
                  <Mascot size={88} />
                  <h3>{profiles?.length ? "Pick a bucket" : "Welcome to Kybl"}</h3>
                  <p>{profiles?.length ? "Choose a bucket on the left to browse its files." : "Add a connection to start browsing your S3 storage."}</p>
                  {!profiles?.length && KYBL_CONNECT && (
                    <button className="btn btn-primary m-big-btn" onClick={connectKybl}>
                      <Icon name="cloud" size={16} /> Connect Kybl Storage
                    </button>
                  )}
                  {!profiles?.length && (
                    <button
                      className={`btn m-big-btn ${KYBL_CONNECT ? "btn-ghost m-alt-btn" : "btn-primary"}`}
                      onClick={() => setConnDialog({ profile: null })}
                    >
                      <Icon name="plus" size={16} /> {KYBL_CONNECT ? "Add another S3 connection" : "Add a connection"}
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
              profiles={profiles}
              recent={recent}
              activeTransfers={activeTransfers}
              connections={connections}
              onRecent={(l) => go(l)}
              onAdd={() => setConnDialog({ profile: null })}
              onKybl={KYBL_CONNECT ? connectKybl : undefined}
              onTransfers={() => setScreen("transfers")}
              onSettings={() => setScreen("settings")}
            />
          )}
          <Presence show={!!detail && !!loc}>
            {detail && loc && (
              <section key={detail.key} className={`m-screen m-overlay m-detail ${viewer !== null ? "over-viewer" : ""}`}>
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

      <Presence show={viewer !== null && !!loc && media.length > 0}>
        {viewer !== null && loc && media[viewer] && (
          <Viewer
            items={media}
            index={viewer}
            profileId={loc.profileId}
            bucket={loc.bucket}
            onIndex={setViewer}
            onClose={() => setViewer(null)}
            onInfo={(e) => setDetail(e)}
            onShare={(e) => copyLink(e, settings.linkExpiry)}
            onDownload={(e) => download([e])}
            onDelete={(e) => askDelete([e])}
          />
        )}
      </Presence>

      <Presence show={screen === "transfers"}>
        <TransfersScreen onBack={() => backRef.current()} transfers={transfers} savedWhere={SAVED_WHERE} />
      </Presence>
      <Presence show={screen === "settings"}>
        <SettingsScreen
          onBack={() => backRef.current()}
          settings={settings}
          onChange={updateSettings}
          profiles={profiles ?? []}
          onEdit={editProfile}
          onAdd={() => setConnDialog({ profile: null })}
          savedWhere={SAVED_WHERE}
          toast={toast}
        />
      </Presence>

      <Presence show={!!sheet} ms={200}>
        {sheet && (
          <ActionSheet
            title={sheet.title}
            items={sheet.items}
            onClose={() => setSheet(null)}
            onPick={(item) => {
              if (!item.keepOpen) setSheet(null);
              item.run();
            }}
          />
        )}
      </Presence>

      {connDialog && (
        <ConnectionDialog
          initial={connDialog.profile}
          onClose={() => setConnDialog(null)}
          onKybl={
            KYBL_CONNECT
              ? () => {
                  setConnDialog(null);
                  connectKybl();
                }
              : undefined
          }
          onSaved={async (p) => {
            setConnDialog(null);
            await reloadProfiles();
            loadBuckets(p);
          }}
          onDeleted={async (id) => {
            setConnDialog(null);
            if (loc?.profileId === id) go(null, "out");
            await reloadProfiles();
          }}
        />
      )}
      {kyblDialog && (
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
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          danger
          onConfirm={() => {
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          confirmLabel={prompt.confirmLabel}
          onSubmit={(v) => {
            const run = prompt.run;
            setPrompt(null);
            run(v);
          }}
          onClose={() => setPrompt(null)}
        />
      )}
      {moveDialog && loc && (
        <MoveDialog
          profileId={loc.profileId}
          bucket={loc.bucket}
          items={moveDialog.items}
          startPrefix={loc.prefix}
          initialMode={moveDialog.mode}
          onSubmit={(dest, mode) => {
            const items = moveDialog.items;
            setMoveDialog(null);
            relocate(items, dest, mode);
          }}
          onClose={() => setMoveDialog(null)}
        />
      )}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function TransfersButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className="m-icon" onClick={onClick} aria-label={count ? `Transfers, ${count} running` : "Transfers"}>
      <Icon name="transfers" size={20} />
      {count > 0 && <span className="m-badge">{count > 99 ? "99+" : count}</span>}
    </button>
  );
}

function BarButton({ icon, label, onClick, disabled, danger }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={`m-barbtn ${danger ? "danger" : ""}`} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={21} />
      <span>{label}</span>
    </button>
  );
}

/** Connections with their buckets, as cards (phone home) or a sidebar list (tablets). */
function Connections({
  profiles,
  buckets,
  current,
  compact,
  onRetry,
  onOpen,
  onAdd,
  onEdit,
  onReconnect,
  onOpenByName,
}: {
  profiles: Profile[] | null;
  buckets: Record<string, Buckets>;
  current: Loc | null;
  compact: boolean;
  onRetry: (p: Profile) => void;
  onOpen: (p: Profile, bucket: string) => void;
  onAdd: () => void;
  onEdit: (p: Profile) => void;
  onReconnect: (p: Profile) => void;
  onOpenByName: (p: Profile) => void;
}) {
  const [all, setAll] = useState<Record<string, boolean>>({});
  if (profiles === null) return <SkeletonList />;
  if (profiles.length === 0) return null;
  return (
    <div className={compact ? "m-conns compact" : "m-conns"}>
      {profiles.map((p) => {
        const bl = buckets[p.id];
        const names = bl?.names ?? [];
        const limit = compact || all[p.id] ? names.length : 5;
        return (
          <section key={p.id} className="m-conn">
            <header className="m-conn-head">
              <ProviderBadge provider={p.provider} />
              <span className="m-conn-text">
                <strong>{p.name || p.endpoint}</strong>
                {!compact && <small>{p.endpoint.replace(/^https?:\/\//, "")}</small>}
              </span>
              <button className="m-icon m-conn-edit" onClick={() => onEdit(p)} aria-label={`Edit ${p.name}`}>
                <Icon name={compact ? "more" : "edit"} size={compact ? 16 : 17} />
              </button>
            </header>
            <ul className="m-buckets">
              {bl?.loading && !names.length && (
                <li className="m-bucket-note">
                  <span className="spinner" /> Loading buckets…
                </li>
              )}
              {bl?.note && (
                <li className="m-bucket-note">
                  <span>{bl.note}</span>
                  {bl.revoked ? (
                    <button className="btn btn-primary btn-sm" onClick={() => onReconnect(p)}>
                      Connect again
                    </button>
                  ) : (
                    <button className="btn btn-sm" onClick={() => onRetry(p)}>
                      Retry
                    </button>
                  )}
                </li>
              )}
              {names.slice(0, limit).map((b) => {
                const here = current?.profileId === p.id && current.bucket === b;
                return (
                  <li key={b}>
                    <button className={`m-bucket ${here ? "here" : ""}`} onClick={() => onOpen(p, b)}>
                      <span className="m-bucket-ico">
                        <Icon name="bucket" size={compact ? 16 : 18} />
                      </span>
                      <span className="m-bucket-name">{b}</span>
                      {!compact && <Icon name="chevron" size={13} className="m-chev" />}
                    </button>
                  </li>
                );
              })}
              {names.length > limit && (
                <li>
                  <button className="m-bucket m-bucket-all" onClick={() => setAll((a) => ({ ...a, [p.id]: true }))}>
                    Show all {names.length} buckets
                  </button>
                </li>
              )}
              {!bl?.loading && (
                <li>
                  <button className="m-bucket m-bucket-add" onClick={() => onOpenByName(p)}>
                    <span className="m-bucket-ico">
                      <Icon name="plus" size={compact ? 15 : 17} />
                    </span>
                    <span className="m-bucket-name">Open bucket by name…</span>
                  </button>
                </li>
              )}
            </ul>
          </section>
        );
      })}
      {!compact && (
        <button className="m-add-row" onClick={onAdd}>
          <Icon name="plus" size={16} /> Add a connection
        </button>
      )}
    </div>
  );
}

function HomeScreen({
  profiles,
  recent,
  activeTransfers,
  connections,
  onRecent,
  onAdd,
  onKybl,
  onTransfers,
  onSettings,
}: {
  profiles: Profile[] | null;
  recent: Loc[];
  activeTransfers: number;
  connections: React.ReactNode;
  onRecent: (l: Loc) => void;
  onAdd: () => void;
  /** "Connect Kybl Storage" (not on iOS yet) */
  onKybl?: () => void;
  onTransfers: () => void;
  onSettings: () => void;
}) {
  const [heroRef, collapsed] = useCollapsed<HTMLDivElement>(profiles?.length);
  const places = recent.filter((r) => profiles?.some((p) => p.id === r.profileId)).slice(0, 6);
  return (
    <section className="m-screen m-home">
      <header className={`m-bar ${collapsed ? "solid" : ""}`}>
        <h1 className="m-home-brand">
          <Lockup size={28} />
        </h1>
        <TransfersButton count={activeTransfers} onClick={onTransfers} />
        <button className="m-icon" onClick={onSettings} aria-label="Settings">
          <Icon name="settings" size={20} />
        </button>
      </header>
      <div className="m-scroll">
        <div className="m-page from-left">
          {profiles !== null && profiles.length === 0 ? (
            <div className="m-welcome">
              <Mascot size={120} className="m-bob" />
              <h1>Your buckets, in your pocket</h1>
              <p>Browse, preview, upload and share files on Hetzner, AWS, Cloudflare R2, Backblaze, Wasabi, MinIO or any S3-compatible storage.</p>
              {onKybl && (
                <button className="btn btn-primary m-big-btn" onClick={onKybl}>
                  <Icon name="cloud" size={16} /> Connect Kybl Storage
                </button>
              )}
              <button className={`btn m-big-btn ${onKybl ? "btn-ghost m-alt-btn" : "btn-primary"}`} onClick={onAdd}>
                <Icon name="plus" size={16} /> {onKybl ? "Add another S3 connection" : "Add a connection"}
              </button>
              <div className="m-providers">
                {PROVIDERS.slice(0, 6).map((p) => (
                  <ProviderBadge key={p.id} provider={p.id} large />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* the brand sits in the bar; this marks the top so the bar turns solid on scroll */}
              <div className="m-sentinel" ref={heroRef} />
              {places.length > 0 && (
                <>
                  <h2 className="m-section">Recent</h2>
                  <div className="m-recent">
                    {places.map((r) => {
                      const p = profiles?.find((x) => x.id === r.profileId);
                      const name = r.prefix ? baseName(r.prefix) : r.bucket;
                      return (
                        <button key={`${r.profileId}|${r.bucket}|${r.prefix}`} className="m-place" onClick={() => onRecent(r)}>
                          <span className="m-place-art">
                            {r.prefix ? (
                              <FileIcon entry={{ kind: "folder", key: r.prefix, name, size: 0, modified: null }} big />
                            ) : (
                              <span className="m-place-bucket">
                                <Icon name="bucket" size={26} />
                              </span>
                            )}
                          </span>
                          <strong>{name}</strong>
                          <small>{r.prefix ? r.bucket : p?.name || p?.endpoint}</small>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              <h2 className="m-section">Connections</h2>
              {connections}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
