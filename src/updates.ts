/**
 * App updates, from GitHub Releases (see src-tauri/src/updater.rs). The native side checks on its
 * own and keeps the state; the page shows it and passes clicks back.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type UpdateRelease = {
  version: string;
  /** the release page on GitHub */
  page: string;
  notes: string;
  published: string;
  /** "install": the app downloads and installs it; "open": the download opens in the browser */
  how: "install" | "open";
  asset: { name: string; url: string; size: number; sha256: string | null } | null;
};

export type UpdateStatus = {
  current: string;
  auto: boolean;
  skipped: string | null;
  checking: boolean;
  lastChecked: number | null;
  error: string | null;
  available: UpdateRelease | null;
  phase: "" | "downloading" | "installing" | "ready";
  received: number;
  total: number;
};

export const updatesApi = {
  status: () => invoke<UpdateStatus>("update_status"),
  check: () => invoke<UpdateStatus>("update_check"),
  settings: (p: { auto?: boolean; skip?: string }) => invoke<UpdateStatus>("update_settings", { auto: p.auto ?? null, skip: p.skip ?? null }),
  install: () => invoke<UpdateStatus>("update_install"),
  /** rejects with "busy" while transfers run, unless forced; with a sentence to show while edits aren't saved (even forced) */
  restart: (force = false) => invoke<void>("update_restart", { force }),
};

/** The update state, kept current from the native side's events. */
export function useUpdates(): UpdateStatus | null {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    updatesApi
      .status()
      .then((s) => alive && setSt(s))
      .catch(() => {});
    const un = listen<UpdateStatus>("update-status", (e) => alive && setSt(e.payload));
    return () => {
      alive = false;
      un.then((f) => f()).catch(() => {});
    };
  }, []);
  return st;
}

/** What the install button says on this device. */
export function actionLabel(r: UpdateRelease): string {
  if (r.how === "install") return "Update and restart";
  return r.asset ? "Download" : "View release";
}

export function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Install, then restart, unless transfers are running: then `onBusy` is called and the user
 * restarts when ready. Errors land in the status (`error`).
 */
export async function installAndRestart(onBusy: () => void) {
  const st = await updatesApi.install();
  if (st.phase !== "ready") return;
  try {
    await updatesApi.restart();
  } catch (e) {
    if (String(e) === "busy") onBusy();
    else throw e;
  }
}
