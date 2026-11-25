/**
 * The backend's transfer prefs, shared by Settings and the Activity panel's speed menu, so a
 * limit set in one shows in the other straight away. Changes apply to running transfers live.
 */
import { useEffect } from "react";
import { api, type TransferPrefs } from "../../core/api";
import { createStore, useStore } from "../../core/store";

/** 1 MB/s in the KiB/s the backend counts in. */
export const MBPS = 1_000_000 / 1024;

const store = createStore<TransferPrefs | null>(null);
let loading: Promise<void> | null = null;

/** Loads the prefs once (again after a failed save); rejects when they can't be read. */
export function loadTransferPrefs(): Promise<void> {
  loading ??= api.transferPrefs().then(store.set, (e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Saves a change: shown at once, then whatever the backend kept (it clamps). */
export async function saveTransferPrefs(p: Partial<TransferPrefs>): Promise<void> {
  const cur = store.get();
  if (cur) store.set({ ...cur, ...p });
  try {
    store.set(await api.setTransferPrefs(p));
  } catch (e) {
    api.transferPrefs().then(store.set, () => {});
    throw e;
  }
}

/** The backend's defaults (src-tauri/src/tuning.rs `TransferPrefs::default`). */
export const TRANSFER_DEFAULTS: TransferPrefs = {
  concurrency: 3,
  partConcurrency: 4,
  downloadLimitKbps: 0,
  uploadLimitKbps: 0,
  verify: "off",
  wifiOnly: false,
};

export function useTransferPrefsStore(): TransferPrefs | null {
  useEffect(() => {
    loadTransferPrefs().catch(() => {});
  }, []);
  return useStore(store);
}

/** A KiB/s limit in words: "5 MB/s", "2.5 MB/s", "500 KB/s". */
export function limitLabel(kbps: number): string {
  const mb = kbps / MBPS;
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB/s`;
  return `${Math.max(1, Math.round(mb * 1000))} KB/s`;
}
