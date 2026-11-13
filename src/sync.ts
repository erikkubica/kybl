/** Folder sync: types, backend calls and a hook that keeps live status. */
import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore, useStore } from "./store";

export type SyncDirection = "upload" | "download";

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
};

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
