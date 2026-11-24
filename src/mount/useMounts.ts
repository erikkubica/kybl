/** Drives ("Mount as drive"): one shared list, kept live by `mount-status` events. */
import { listen } from "@tauri-apps/api/event";
import { MOUNT_STATUS_EVENT, mountApi, type MountInfo } from "../api";
import { createStore, useStore } from "../store";
import { ON_OS } from "../osNames";
import { rootLabel } from "../connections/roots";

type MountData = { loaded: boolean; mounts: MountInfo[] };

const store = createStore<MountData>({ loaded: false, mounts: [] });
let started = false;

export async function reloadMounts() {
  try {
    store.set({ loaded: true, mounts: await mountApi.mountList() });
  } catch {
    // a backend without drives (phones): nothing to show
    store.set({ loaded: true, mounts: [] });
  }
}

function start() {
  if (started) return;
  started = true;
  reloadMounts();
  listen<MountInfo>(MOUNT_STATUS_EVENT, (e) => {
    const m = e.payload;
    store.set((d) => {
      if (m.state === "removed") return { ...d, mounts: d.mounts.filter((x) => x.id !== m.id) };
      const known = d.mounts.some((x) => x.id === m.id);
      return { ...d, mounts: known ? d.mounts.map((x) => (x.id === m.id ? m : x)) : [...d.mounts, m] };
    });
  }).catch(() => {});
}

/** Every drive, live. */
export function useMounts(): MountData {
  start();
  return useStore(store);
}

/** The drive showing exactly this place, if there is one. */
export function findMount(mounts: MountInfo[], profileId: string, bucket: string, prefix: string): MountInfo | undefined {
  const norm = (p: string) => (p.replace(/^\/+|\/+$/g, "") ? `${p.replace(/^\/+|\/+$/g, "")}/` : "");
  return mounts.find((m) => m.profileId === profileId && m.bucket === bucket && m.prefix === norm(prefix));
}

/** What the system's file browser is called here, for "Show in …". */
export function fileManagerName(): string {
  return ON_OS.fileManager;
}

/** "media-prod › photos/2026", "Google Drive › My Drive › Photos" — where a drive points, for people. */
export function mountWhere(m: Pick<MountInfo, "profileId" | "bucket" | "prefix">, connection: string): string {
  const parts = [connection];
  if (m.bucket) parts.push(rootLabel(m.profileId, m.bucket));
  if (m.prefix) parts.push(m.prefix.replace(/\/$/, ""));
  return parts.join(" › ");
}
