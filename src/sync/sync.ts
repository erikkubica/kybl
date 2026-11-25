/** Folder sync: types, backend calls and a hook that keeps live status. */
import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore, useStore } from "../core/store";

/** upload: back the folder up · download: keep a local mirror · twoway: keep both sides the same */
export type SyncDirection = "upload" | "download" | "twoway";

export type SyncMapping = {
  id: string;
  profileId: string;
  bucket: string;
  /** "" = bucket root, otherwise ends with "/" */
  prefix: string;
  localPath: string;
  direction: SyncDirection;
  ignore: string[];
  mirrorDeletes: boolean;
  intervalMins: number;
  paused: boolean;
  /**
   * Deleted remote files go to a `.kybl-trash/<date>/` folder (on connections without a trash of
   * their own). null: on for two-way, off for one-way.
   */
  remoteTrash?: boolean | null;
  /** Ask before deleting more than 50 files (and a fifth of the folder) at once. Default on. */
  deleteGuard?: boolean;
};

export type SyncState = "idle" | "scanning" | "syncing" | "error" | "paused";

export type SyncStatus = {
  id: string;
  state: SyncState;
  lastSync: number | null;
  error: string | null;
  current: string | null;
  done: number;
  total: number;
  files: number;
  summary: string | null;
  /** bytes sent/received so far in this run, and the run's total */
  bytes: number;
  totalBytes: number;
  /** conflict copies waiting to be looked at (two-way) */
  conflicts?: number;
  /** deletions held until the user confirms them */
  pendingDeletes?: number;
};

/** A file changed on both sides: the other side's version kept the name, this computer's is the copy. */
export type SyncConflict = {
  path: string;
  copy: string;
  createdAt: number;
  /** absolute paths on this computer */
  localPath: string;
  copyLocalPath: string;
};

/** A deletion the guard is holding: `side` is where the file would be deleted. */
export type PendingDelete = { path: string; side: "local" | "remote"; size: number };

/** Remote trash on, unless set otherwise (two-way) or asked for (one-way). */
export function remoteTrashOn(m: Pick<SyncMapping, "remoteTrash" | "direction">): boolean {
  return m.remoteTrash ?? m.direction === "twoway";
}

export type SyncOverview = { pausedAll: boolean; mappings: SyncMapping[]; statuses: SyncStatus[] };

export type AppPrefs = { closeToTray: boolean; launchAtLogin: boolean };

export const DEFAULT_IGNORE = [".DS_Store", "Thumbs.db", "desktop.ini", "*.tmp", "*.swp", "~$*", ".git/", "node_modules/"];

export const INTERVALS = [
  { value: 1, label: "1 min" },
  { value: 5, label: "5 min" },
  { value: 15, label: "15 min" },
  { value: 60, label: "1 hour" },
];

export const syncApi = {
  list: () => invoke<SyncOverview>("sync_list"),
  save: (mapping: SyncMapping) => invoke<SyncMapping>("sync_save", { mapping }),
  remove: (id: string) => invoke<void>("sync_delete", { id }),
  now: (id: string) => invoke<void>("sync_now", { id }),
  setPaused: (id: string, paused: boolean) => invoke<void>("sync_set_paused", { id, paused }),
  pauseAll: (paused: boolean) => invoke<void>("sync_pause_all", { paused }),
  conflicts: (id: string) => invoke<SyncConflict[]>("sync_conflicts", { id }),
  /** keep: "both", "original" (the version that kept the name) or "copy" (this computer's) */
  resolveConflict: (id: string, copy: string, keep: "both" | "original" | "copy") => invoke<void>("sync_resolve_conflict", { id, copy, keep }),
  pending: (id: string) => invoke<PendingDelete[]>("sync_pending", { id }),
  /** Confirms exactly the held deletions the user was shown; fails (confirming nothing) when a
   * run changed the list meanwhile, so the UI shows it again. */
  confirmDeletes: (id: string, items: Pick<PendingDelete, "path" | "side">[]) =>
    invoke<void>("sync_confirm_deletes", { id, items: items.map(({ path, side }) => ({ path, side })) }),
  restoreDeletes: (id: string) => invoke<void>("sync_restore_deletes", { id }),
  /** "Keep on this device": a two-way synced copy, by default in ~/Kybl/<connection>/<bucket>/<folder> */
  keepOffline: (profileId: string, bucket: string, prefix: string, localPath?: string | null) =>
    invoke<SyncMapping>("sync_keep_offline", { profileId, bucket, prefix, localPath: localPath ?? null }),
  getPrefs: () => invoke<AppPrefs>("get_app_prefs"),
  setPrefs: (p: Partial<AppPrefs>) =>
    invoke<AppPrefs>("set_app_prefs", { closeToTray: p.closeToTray ?? null, launchAtLogin: p.launchAtLogin ?? null }),
};

export type SyncModel = {
  pausedAll: boolean;
  mappings: SyncMapping[];
  status: Record<string, SyncStatus>;
  reload: () => Promise<void>;
};

type SyncData = { pausedAll: boolean; mappings: SyncMapping[]; status: Record<string, SyncStatus> };

/** Shared by every component that shows sync state; status arrives as "sync-status" events. */
const syncStore = createStore<SyncData>({ pausedAll: false, mappings: [], status: {} });

async function reload() {
  try {
    const o = await syncApi.list();
    syncStore.set({ pausedAll: o.pausedAll, mappings: o.mappings, status: Object.fromEntries(o.statuses.map((s) => [s.id, s])) });
  } catch {
    /* backend without sync (shouldn't happen) */
  }
}

let started = false;
function startOnce() {
  if (started) return;
  started = true;
  reload();
  listen<SyncStatus>("sync-status", (e) => syncStore.set((d) => ({ ...d, status: { ...d.status, [e.payload.id]: e.payload } }))).catch(() => {
    started = false;
  });
}

/** The mappings right now, without subscribing (menus); starts loading them on first use. */
export function peekSyncMappings(): SyncMapping[] {
  startOnce();
  return syncStore.get().mappings;
}

/** Loads the mappings again (after adding or removing one). */
export const reloadSync = () => reload();

/** Mappings plus live status. Re-renders on every status update: use [`useSyncOverall`] where only the summary matters. */
export function useSync(): SyncModel {
  startOnce();
  const d = useStore(syncStore);
  return useMemo(() => ({ ...d, reload }), [d]);
}

/** Only the overall state; re-renders when that changes, not on every progress tick. */
export function useSyncOverall(): SyncState | null {
  startOnce();
  return useStore(syncStore, (d) => overallState(d));
}

/** Overall state for the sidebar indicator. */
export function overallState(model: Pick<SyncModel, "pausedAll" | "mappings" | "status">): SyncState | null {
  if (model.mappings.length === 0) return null;
  if (model.pausedAll) return "paused";
  const st = model.mappings.map((m) => model.status[m.id]?.state ?? "idle");
  if (st.includes("syncing")) return "syncing";
  if (st.includes("error")) return "error";
  if (st.includes("scanning")) return "scanning";
  if (st.every((s) => s === "paused")) return "paused";
  return "idle";
}

export function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** "/Users/alex/Pictures" -> "~/Pictures" */
export function prettyPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}
