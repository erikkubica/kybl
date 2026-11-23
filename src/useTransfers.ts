import { useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage } from "./api";
import { createStore, useStore } from "./store";
import type { Transfer, TransferEvent } from "./types";

type NewTransfer = Pick<Transfer, "kind" | "name" | "profileId" | "bucket" | "key" | "local"> & {
  /** downloads: replace a local file of the same name instead of saving next to it as "x (1)" */
  overwrite?: boolean;
  /**
   * downloads: the file's ETag in the listing. With it, a version already in the file cache is
   * copied without asking the server first. Leave it out where the newest version matters more
   * than a saved HEAD ("Open" in another app).
   */
  etag?: string | null;
  /**
   * Work of another kind (compress, extract) shown as one row: started (and retried) by calling
   * this with the row's id; the backend reports on it with the same `transfer` events.
   */
  run?: (id: string) => Promise<unknown>;
};

/** Finished transfers kept in the list once a batch is over; older successful ones are dropped. */
const KEEP_DONE = 500;

/**
 * The transfer queue. Backend events are buffered and published at most every 120 ms, so
 * thousands of small files cannot flood the UI. It lives outside React: only components that
 * show transfers (the Activity panel) re-render on progress.
 */
const transfersStore = createStore<Transfer[]>([]);
const byId = new Map<string, Transfer>();
const lastSample = new Map<string, { t: number; bytes: number }>();
let dirty = false;
let timer: number | undefined;
let onErrorRef: (msg: string) => void = () => {};
/** Downloads that may replace an existing local file (the user picked the path in a Save dialog). */
const overwriteIds = new Set<string>();
/**
 * The path each download asked for, by id. `local` becomes the path really written ("x (1).jpg"
 * when "x.jpg" was taken); a retry asks for the original again, which is how the backend knows
 * it is the same download and carries on from its partial file instead of starting over.
 */
const requested = new Map<string, string>();
/** The listed version of each download, by id (see `NewTransfer.etag`). */
const listed = new Map<string, { etag: string; size: number }>();
/** Rows started by their own command (see `NewTransfer.run`), by id. */
const runners = new Map<string, (id: string) => Promise<unknown>>();
/** Callers waiting for a transfer to end (see `whenFinished`). */
const waiters = new Map<string, ((t: Transfer) => void)[]>();

function settle(t: Transfer) {
  if (t.state !== "done" && t.state !== "error" && t.state !== "cancelled") return;
  const list = waiters.get(t.id);
  if (!list) return;
  waiters.delete(t.id);
  for (const w of list) w(t);
}

/** Uploads of the current batch: when all of them have finished, `settledListeners` hear about it. */
const batch = new Set<string>();
/** `where` lists each connection and bucket the batch uploaded into. */
type Settled = (ok: number, failed: number, where: { profileId: string; bucket: string }[]) => void;
const settledListeners = new Set<Settled>();

function flush() {
  if (!dirty) return;
  dirty = false;
  let anyActive = false;
  for (const t of byId.values()) {
    if (t.state === "queued" || t.state === "running") {
      anyActive = true;
      break;
    }
  }
  if (batch.size) {
    let ok = 0;
    let bad = 0;
    let pending = false;
    const where = new Map<string, { profileId: string; bucket: string }>();
    for (const id of batch) {
      const t = byId.get(id);
      if (!t) continue;
      where.set(`${t.profileId}\n${t.bucket}`, { profileId: t.profileId, bucket: t.bucket });
      if (t.state === "queued" || t.state === "running") pending = true;
      else if (t.state === "done") ok++;
      else if (t.state === "error") bad++;
    }
    if (!pending) {
      batch.clear();
      for (const l of settledListeners) l(ok, bad, [...where.values()]);
    }
  }
  if (!anyActive) prune();
  transfersStore.set(Array.from(byId.values()));
  // nothing left to report: stop ticking until the next transfer starts
  if (!anyActive && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Drops the oldest successful transfers past `KEEP_DONE`, so a 100k-file upload does not stay in memory. */
function prune() {
  let done = 0;
  for (const t of byId.values()) if (t.state === "done") done++;
  if (done <= KEEP_DONE) return;
  for (const [id, t] of byId) {
    if (done <= KEEP_DONE) break;
    if (t.state === "done") {
      byId.delete(id);
      overwriteIds.delete(id);
      requested.delete(id);
      listed.delete(id);
      done--;
    }
  }
}

function markDirty() {
  dirty = true;
  timer ??= window.setInterval(flush, 120);
}

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  adoptRunning();
  listen<TransferEvent>("transfer", (e) => {
    const ev = e.payload;
    const cur = byId.get(ev.id);
    if (!cur) return;
    const now = performance.now();
    const prev = lastSample.get(ev.id);
    let speed = cur.speed;
    if (ev.state === "running") {
      if (prev && now - prev.t > 250 && ev.bytes >= prev.bytes) {
        const inst = ((ev.bytes - prev.bytes) / (now - prev.t)) * 1000;
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        lastSample.set(ev.id, { t: now, bytes: ev.bytes });
      } else if (!prev) {
        lastSample.set(ev.id, { t: now, bytes: ev.bytes });
      }
    } else {
      speed = 0;
      lastSample.delete(ev.id);
    }
    const next: Transfer = {
      ...cur,
      state: ev.state,
      bytes: ev.state === "done" ? ev.total || cur.total : ev.bytes || cur.bytes,
      total: ev.total || cur.total,
      error: ev.error,
      speed,
    };
    byId.set(ev.id, next);
    settle(next);
    markDirty();
  }).catch(() => {
    listening = false;
  });
}

/**
 * Picks up transfers that were already going when this page loaded. On Android they keep
 * running after the app is swiped away, and opening Kybl again loads a fresh page.
 */
function adoptRunning() {
  api
    .activeTransfers()
    .then((list) => {
      for (const t of list) {
        if (byId.has(t.id)) continue;
        byId.set(t.id, { ...t, speed: 0, error: null });
        if (t.kind === "upload") batch.add(t.id);
      }
      if (list.length) markDirty();
    })
    .catch(() => {});
}

async function start(t: Transfer) {
  try {
    const run = runners.get(t.id);
    if (run) await run(t.id);
    else if (t.kind === "upload") {
      await api.startUpload(t.id, t.profileId, t.bucket, t.key, t.local);
    } else {
      // the backend picks a free name ("photo (1).jpg") unless told to overwrite; keep the path it
      // really writes, so Open and Show in Finder point at the right file
      const local = await api.startDownload(t.id, t.profileId, t.bucket, t.key, requested.get(t.id) ?? t.local, overwriteIds.has(t.id), listed.get(t.id));
      const cur = byId.get(t.id);
      if (cur && typeof local === "string" && local && local !== cur.local) {
        byId.set(t.id, { ...cur, local });
        markDirty();
      }
    }
  } catch (e) {
    const failed: Transfer = { ...(byId.get(t.id) ?? t), state: "error", error: errMessage(e) };
    byId.set(t.id, failed);
    settle(failed);
    markDirty();
    onErrorRef(errMessage(e));
  }
}

/** Takes finished transfers off the list. */
function clearWhere(pick: (t: Transfer) => boolean) {
  for (const [id, t] of byId) {
    if (t.state !== "done" && t.state !== "cancelled" && t.state !== "error") continue;
    if (!pick(t)) continue;
    // a failed or stopped one can't be retried once it is off the list: let the backend drop
    // what it kept to resume it (a partial download, an open multipart upload)
    if (t.state !== "done") api.cancelTransfer(id).catch(() => {});
    byId.delete(id);
    overwriteIds.delete(id);
    requested.delete(id);
    listed.delete(id);
    runners.delete(id);
  }
  dirty = true;
  flush();
}

/** Puts a finished transfer back in the queue under the same id, so the backend can resume it. */
function requeue(id: string): Transfer | null {
  const t = byId.get(id);
  if (!t || t.state === "queued" || t.state === "running" || t.state === "done") return null;
  const fresh: Transfer = { ...t, state: "queued", error: null, speed: 0 };
  byId.set(id, fresh);
  lastSample.delete(id);
  if (t.kind === "upload") batch.add(id);
  return fresh;
}

const actions = {
  add(items: (NewTransfer & { total?: number })[]): Transfer[] {
    listenOnce();
    const created: Transfer[] = items.map(({ overwrite, etag, run, ...it }) => {
      const id = crypto.randomUUID();
      if (run) runners.set(id, run);
      if (overwrite) overwriteIds.add(id);
      if (it.kind === "download") requested.set(id, it.local);
      if (it.kind === "download" && etag && it.total != null) listed.set(id, { etag, size: it.total });
      return { ...it, id, state: "queued" as const, bytes: 0, total: it.total ?? 0, speed: 0 };
    });
    for (const t of created) {
      byId.set(t.id, t);
      if (t.kind === "upload") batch.add(t.id);
    }
    dirty = true;
    flush();
    markDirty();
    // start in small batches so the backend queue is not hammered with thousands of invokes at once
    (async () => {
      for (let i = 0; i < created.length; i += 50) {
        await Promise.all(created.slice(i, i + 50).map(start));
      }
    })();
    return created;
  },
  cancel(id: string) {
    api.cancelTransfer(id).catch(() => {});
  },
  cancelAll() {
    for (const t of byId.values()) {
      if (t.state === "queued" || t.state === "running") api.cancelTransfer(t.id).catch(() => {});
    }
  },
  retry(id: string) {
    const fresh = requeue(id);
    if (!fresh) return;
    dirty = true;
    flush();
    markDirty();
    start(fresh);
  },
  /** Retries every failed (and unless `onlyFailed`, cancelled) transfer; returns how many were started again. */
  retryAll(onlyFailed = false): number {
    const again: Transfer[] = [];
    for (const t of [...byId.values()]) {
      if (t.state !== "error" && (onlyFailed || t.state !== "cancelled")) continue;
      const fresh = requeue(t.id);
      if (fresh) again.push(fresh);
    }
    if (!again.length) return 0;
    dirty = true;
    flush();
    markDirty();
    (async () => {
      for (let i = 0; i < again.length; i += 50) await Promise.all(again.slice(i, i + 50).map(start));
    })();
    return again.length;
  },
  /** Resolves once the transfer is done, failed or cancelled (with its final state and local path). */
  whenFinished(id: string): Promise<Transfer> {
    const t = byId.get(id);
    if (t && (t.state === "done" || t.state === "error" || t.state === "cancelled")) return Promise.resolve(t);
    return new Promise((ok) => waiters.set(id, [...(waiters.get(id) ?? []), ok]));
  },
  /** Clears done and cancelled transfers; failed ones stay (Retry, or `clearFailed`). */
  clearFinished() {
    clearWhere((t) => t.state === "done" || t.state === "cancelled");
  },
  /** Clears failed transfers, and what the backend kept to resume them. */
  clearFailed() {
    clearWhere((t) => t.state === "error");
  },
  /** How many transfers failed, and how many of those are uploads that sent part of the file (kept to resume). */
  failedCounts(): { failed: number; partial: number } {
    let failed = 0;
    let partial = 0;
    for (const t of byId.values()) {
      if (t.state !== "error") continue;
      failed++;
      if (t.kind === "upload" && t.bytes > 0) partial++;
    }
    return { failed, partial };
  },
  /** Called with the counts once every upload of the current batch has finished. */
  onUploadsSettled(cb: Settled): () => void {
    settledListeners.add(cb);
    return () => settledListeners.delete(cb);
  },
};

export type TransferActions = typeof actions;

/** Actions on the queue. Stable across renders and does not subscribe to progress. */
export function useTransfers(onError: (msg: string) => void): TransferActions {
  onErrorRef = onError;
  listenOnce();
  return useMemo(() => actions, []);
}

/** The live list, for components that show it. */
export function useTransferList(): Transfer[] {
  return useStore(transfersStore);
}

/** A transfer's progress in whole percent (null when it isn't in the list); re-renders only when the number changes. */
export function useTransferPercent(id: string | null): number | null {
  return useStore(transfersStore, (list) => {
    if (!id) return null;
    const t = list.find((x) => x.id === id);
    if (!t) return null;
    return t.total > 0 ? Math.min(100, Math.floor((t.bytes / t.total) * 100)) : 0;
  });
}
