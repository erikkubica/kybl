import { useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage } from "./api";
import { createStore, useStore } from "./store";
import type { Transfer, TransferEvent } from "./types";

type NewTransfer = Pick<Transfer, "kind" | "name" | "profileId" | "bucket" | "key" | "local">;

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
    byId.set(ev.id, {
      ...cur,
      state: ev.state,
      bytes: ev.state === "done" ? ev.total || cur.total : ev.bytes || cur.bytes,
      total: ev.total || cur.total,
      error: ev.error,
      speed,
    });
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
    if (t.kind === "upload") {
      await api.startUpload(t.id, t.profileId, t.bucket, t.key, t.local);
    } else {
      await api.startDownload(t.id, t.profileId, t.bucket, t.key, t.local);
    }
  } catch (e) {
    byId.set(t.id, { ...t, state: "error", error: errMessage(e) });
    markDirty();
    onErrorRef(errMessage(e));
  }
}

const actions = {
  add(items: (NewTransfer & { total?: number })[]): Transfer[] {
    listenOnce();
    const created: Transfer[] = items.map((it) => ({
      ...it,
      id: crypto.randomUUID(),
      state: "queued" as const,
      bytes: 0,
      total: it.total ?? 0,
      speed: 0,
    }));
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
    const t = byId.get(id);
    if (!t) return;
    const fresh: Transfer = { ...t, state: "queued", bytes: 0, error: null, speed: 0 };
    byId.set(id, fresh);
    if (t.kind === "upload") batch.add(id);
    dirty = true;
    flush();
    markDirty();
    start(fresh);
  },
  clearFinished() {
    for (const [id, t] of byId) {
      if (t.state === "done" || t.state === "cancelled" || t.state === "error") byId.delete(id);
    }
    dirty = true;
    flush();
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
