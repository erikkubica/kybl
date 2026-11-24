import { useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage } from "./api";
import { logMessage } from "./activityLog";
import { formatBytes } from "./format";
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
   * downloads of a folder: the local folder the user picked. The rest of `local` comes from
   * remote names, and the backend refuses to write it through a link below this folder.
   */
  base?: string;
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
/** The picked folder of each folder download, by id (see `NewTransfer.base`). */
const bases = new Map<string, string>();
/**
 * Transfers the backend runs on its own, shown here with `track` (uploads of files edited in
 * another app, src/edit): never started, cancelled or retried through the queue. Retry runs
 * their own hook instead (which keeps their safety checks).
 */
const external = new Map<string, { retry?: () => void }>();
/** Rows started by their own command (see `NewTransfer.run`), by id. */
const runners = new Map<string, (id: string) => Promise<unknown>>();
/**
 * The backend only knows a transfer once its start command returns (rows start in groups of 50,
 * so thousands can wait their turn here). `sending`: its start command is under way; `sent`: the
 * backend has it. A queued row in neither is stopped or paused here, and `start` skips it.
 */
const sending = new Set<string>();
const sent = new Set<string>();
/** Cancel or Pause asked while the start command was under way: sent again once it returns. */
const held = new Map<string, "cancel" | "pause">();
/** Resume or Retry pressed while the start command was under way: started again once it returns. */
const again = new Set<string>();
/**
 * Finished so its file can be used: done, and not stopped by Cancel during its check (the user
 * asked it to stop, so Open, Copy, drag-out and actions don't carry on with it).
 */
export const finishedOk = (t: Transfer) => t.state === "done" && !t.checkStopped;

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
/** Uploads of the batch that finished fine and were already pruned off the list (still counted). */
let batchPrunedOk = 0;
const batchPrunedWhere = new Map<string, { profileId: string; bucket: string }>();
/**
 * Transfers started (or started again) since the queue was last idle: the header's "X of Y" and
 * time left count only these, not every finished row still listed from earlier.
 */
const currentRun = new Set<string>();
/** Bytes of the current run's finished transfers that were pruned off the list. */
let runPrunedBytes = 0;
/** `where` lists each connection and bucket the batch uploaded into. */
type Settled = (ok: number, failed: number, where: { profileId: string; bucket: string }[]) => void;
const settledListeners = new Set<Settled>();

/** No progress for this long: the speed drops to 0, so the header and row stop showing an old speed and time left. */
const STALL_MS = 3000;

function flush() {
  const now = performance.now();
  for (const [id, s] of lastSample) {
    if (now - s.t < STALL_MS) continue;
    const t = byId.get(id);
    if (t?.state === "running" && t.speed > 0) {
      byId.set(id, { ...t, speed: 0 });
      dirty = true;
    }
  }
  if (!dirty) return;
  dirty = false;
  let anyActive = false;
  for (const t of byId.values()) {
    if (t.state === "queued" || t.state === "running") {
      anyActive = true;
      break;
    }
  }
  // every tick, not only once idle: a 100k-file batch would otherwise keep (and copy) every row
  prune();
  if (batch.size) {
    let ok = batchPrunedOk;
    let bad = 0;
    let pending = false;
    const where = new Map(batchPrunedWhere);
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
      batchPrunedOk = 0;
      batchPrunedWhere.clear();
      for (const l of settledListeners) l(ok, bad, [...where.values()]);
    }
  }
  if (!anyActive) {
    currentRun.clear();
    runPrunedBytes = 0;
  }
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
      pruneDone(id, t);
      forget(id);
      done--;
    }
  }
}

/** Keeps a done row's part in the current run and batch once it leaves the list. */
function pruneDone(id: string, t: Transfer) {
  if (batch.delete(id)) {
    batchPrunedOk++;
    batchPrunedWhere.set(`${t.profileId}\n${t.bucket}`, { profileId: t.profileId, bucket: t.bucket });
  }
  if (currentRun.delete(id)) runPrunedBytes += t.total;
}

/** Takes a row off the list with everything kept about it. */
function forget(id: string) {
  byId.delete(id);
  overwriteIds.delete(id);
  requested.delete(id);
  listed.delete(id);
  bases.delete(id);
  external.delete(id);
  runners.delete(id);
  sent.delete(id);
  held.delete(id);
  again.delete(id);
}

/** A queued row the backend hasn't been given yet (see `sending`). */
const notStarted = (t: Transfer | undefined): boolean => !!t && t.state === "queued" && !sending.has(t.id) && !sent.has(t.id) && !external.has(t.id);

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
      } else if (!prev || ev.bytes < prev.bytes) {
        // first sample, or the transfer started over: measure afresh from here
        if (prev) speed = 0;
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
      verified: ev.state === "done" ? ev.verified : undefined,
      checkStopped: ev.state === "done" ? ev.checkStopped : undefined,
      checkPending: ev.state === "paused" ? ev.checkPending : undefined,
      local: ev.local ?? cur.local,
    };
    // just finished: to the end of the list, so Done lists (and pruning drops) rows by finish
    // order, not by when they started
    if ((ev.state === "done" || ev.state === "cancelled") && cur.state !== ev.state) byId.delete(ev.id);
    byId.set(ev.id, next);
    if (ev.local) logMessage("info", `${cur.name}: a file with that name turned up while it downloaded, so it was saved as ${ev.local}.`);
    if (ev.resumedFrom) logMessage("info", `${cur.name}: carried on from ${formatBytes(ev.resumedFrom)} instead of starting over.`);
    else if (ev.restarted) logMessage("info", `${cur.name}: couldn't carry on where it stopped, so it started over.`);
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
        sent.add(t.id);
        currentRun.add(t.id);
        if (t.kind === "upload") batch.add(t.id);
      }
      if (list.length) markDirty();
    })
    .catch(() => {});
  // paused or failed ones kept from before (also across a restart): Resume / Retry carries on
  api
    .keptTransfers()
    .then((list) => {
      for (const k of list) {
        if (byId.has(k.id)) continue;
        const { requested: asked, overwrite, state, stamp, ...t } = k;
        byId.set(k.id, { ...t, state, speed: 0, checkPending: k.kind === "download" && state === "paused" && !!stamp });
        if (k.kind === "download") requested.set(k.id, asked || k.local);
        if (overwrite) overwriteIds.add(k.id);
      }
      if (list.length) {
        dirty = true;
        flush();
      }
    })
    .catch(() => {});
}

async function start(t: Transfer) {
  // stopped or paused while it waited for its group's turn
  if (!notStarted(byId.get(t.id))) return;
  sending.add(t.id);
  try {
    const run = runners.get(t.id);
    if (run) await run(t.id);
    else if (t.kind === "upload") {
      await api.startUpload(t.id, t.profileId, t.bucket, t.key, t.local);
    } else {
      // the backend picks a free name ("photo (1).jpg") unless told to overwrite; keep the path it
      // really writes, so Open and Show in Finder point at the right file
      const local = await api.startDownload(t.id, t.profileId, t.bucket, t.key, requested.get(t.id) ?? t.local, overwriteIds.has(t.id), listed.get(t.id), bases.get(t.id));
      const cur = byId.get(t.id);
      // only while it hasn't ended: a `done` event that came first already carries the path it
      // really landed at ("photo (1).jpg"), which must not go back to the reserved one
      if (cur && (cur.state === "queued" || cur.state === "running") && typeof local === "string" && local && local !== cur.local) {
        byId.set(t.id, { ...cur, local });
        markDirty();
      }
    }
    sending.delete(t.id);
    sent.add(t.id);
    // Cancel or Pause came while the backend didn't know it yet: now it does
    const want = held.get(t.id);
    held.delete(t.id);
    // stopped after a Retry during the start: that Retry is void (left set, the next Retry would
    // start the row twice)
    if (want) again.delete(t.id);
    if (want === "cancel") api.cancelTransfer(t.id).catch(() => {});
    else if (want === "pause") api.pauseTransfer(t.id).catch(() => {});
    else if (startAgain(t.id)) return;
  } catch (e) {
    sending.delete(t.id);
    const want = held.get(t.id);
    held.delete(t.id);
    const cur = byId.get(t.id) ?? t;
    // the user stopped it while it was starting: it ends the way they asked, without an error
    if (want) {
      again.delete(t.id);
      const stopped: Transfer = { ...cur, state: want === "cancel" ? "cancelled" : "paused", error: null, speed: 0 };
      byId.set(t.id, stopped);
      settle(stopped);
      markDirty();
      return;
    }
    if (startAgain(t.id)) return;
    const failed: Transfer = { ...cur, state: "error", error: errMessage(e) };
    byId.set(t.id, failed);
    settle(failed);
    markDirty();
    onErrorRef(errMessage(e));
  }
}

/** A Resume or Retry that came while the row was starting: hand it over once more. */
function startAgain(id: string): boolean {
  if (!again.delete(id)) return false;
  const cur = byId.get(id);
  if (!cur || cur.state !== "queued") return false;
  sent.delete(id);
  void start(cur);
  return true;
}

/** Takes finished transfers off the list. */
function clearWhere(pick: (t: Transfer) => boolean) {
  for (const [id, t] of byId) {
    if (t.state !== "done" && t.state !== "cancelled" && t.state !== "error") continue;
    if (!pick(t)) continue;
    // a failed or stopped one can't be retried once it is off the list: let the backend drop
    // what it kept to resume it (a partial download, an open multipart upload)
    if (t.state !== "done" && !external.has(id)) api.cancelTransfer(id).catch(() => {});
    // a done one still counts in the run's totals and its batch's "Uploaded N files", as when
    // pruning takes it off
    if (t.state === "done") pruneDone(id, t);
    forget(id);
  }
  dirty = true;
  flush();
}

/** Puts a finished transfer back in the queue under the same id, so the backend can resume it. */
function requeue(id: string): Transfer | null {
  const ext = external.get(id);
  if (ext) {
    ext.retry?.();
    return null;
  }
  const t = byId.get(id);
  if (!t || t.state === "queued" || t.state === "running" || t.state === "done") return null;
  // a cancelled run kept nothing (the backend dropped its partial), so it starts from 0; paused
  // and failed ones carry on from what they kept
  const fresh: Transfer = { ...t, state: "queued", error: null, speed: 0, verified: undefined, checkPending: undefined, checkStopped: undefined, bytes: t.state === "cancelled" ? 0 : t.bytes };
  // to the end of the list: it finishes after the rest, so Done and pruning see it as the newest
  byId.delete(id);
  byId.set(id, fresh);
  lastSample.delete(id);
  // its first start command is still under way: start it again once that returns
  if (sending.has(id)) {
    held.delete(id);
    again.add(id);
  }
  // the backend let go of it when it ended: `start` hands it over again
  sent.delete(id);
  currentRun.add(id);
  if (t.kind === "upload") batch.add(id);
  return fresh;
}

/**
 * Cancel or Pause one row. The backend stops what it runs; a row it doesn't know yet ends (or
 * pauses) here, so `start` skips it, and one whose start command is under way gets the request
 * again once it returns. `backendDone`: the caller already asked the backend (Pause all).
 * Returns whether the list changed here.
 */
function stopOne(id: string, what: "cancel" | "pause", backendDone = false): boolean {
  if (external.has(id)) return false;
  const t = byId.get(id);
  if (!backendDone) {
    // cancelling also drops what an earlier run kept (a partial file, an open multipart upload)
    if (what === "cancel") api.cancelTransfer(id).catch(() => {});
    else if (!notStarted(t)) api.pauseTransfer(id).catch(() => {});
  }
  if (sending.has(id)) held.set(id, what);
  // a paused one isn't running, so no event comes back: it ends here (what it kept is dropped)
  if (!(notStarted(t) || (what === "cancel" && t?.state === "paused"))) return false;
  // a paused download whose whole file is in place: Cancel keeps the file and skips its check
  // (the backend drops only what it kept to resume)
  const next: Transfer =
    what === "cancel" && t?.checkPending
      ? { ...t, state: "done", bytes: t.total, speed: 0, checkPending: undefined, checkStopped: true }
      : { ...t!, state: what === "cancel" ? "cancelled" : "paused", speed: 0 };
  // ended: to the end of the list, in finish order (as the event path does)
  if (next.state !== "paused") byId.delete(id);
  byId.set(id, next);
  settle(next);
  return true;
}

const actions = {
  add(items: (NewTransfer & { total?: number })[]): Transfer[] {
    listenOnce();
    const created: Transfer[] = items.map(({ overwrite, etag, run, base, ...it }) => {
      const id = crypto.randomUUID();
      if (run) runners.set(id, run);
      if (overwrite) overwriteIds.add(id);
      if (it.kind === "download") requested.set(id, it.local);
      if (it.kind === "download" && base) bases.set(id, base);
      if (it.kind === "download" && etag && it.total != null) listed.set(id, { etag, size: it.total });
      return { ...it, id, state: "queued" as const, bytes: 0, total: it.total ?? 0, speed: 0 };
    });
    for (const t of created) {
      byId.set(t.id, t);
      currentRun.add(t.id);
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
    if (stopOne(id, "cancel")) {
      dirty = true;
      flush();
    }
  },
  /** Stops a queued or running transfer but keeps what it did; Resume carries on from there. */
  pause(id: string) {
    if (stopOne(id, "pause")) {
      dirty = true;
      flush();
    }
  },
  pauseAll() {
    api.pauseAllTransfers().catch(() => {});
    // the backend pauses what it knows; rows still waiting for their turn are paused here
    let changed = false;
    for (const t of [...byId.values()]) if (t.state === "queued" && stopOne(t.id, "pause", true)) changed = true;
    if (changed) {
      dirty = true;
      flush();
    }
  },
  /** Starts a paused (or failed) transfer again under the same id, so it carries on. */
  resume(id: string) {
    actions.retry(id);
  },
  /** Resumes every paused transfer; returns how many. */
  resumeAll(): number {
    const again: Transfer[] = [];
    for (const t of [...byId.values()]) {
      if (t.state !== "paused") continue;
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
  /** Lets a queued transfer start next (on its connection), and lists it first among the queued. */
  moveToTop(id: string) {
    const t = byId.get(id);
    if (!t || t.state !== "queued") return;
    api.moveTransferToTop(id).catch(() => {});
    // Map order is list order: put it before the first queued one
    const entries = [...byId.entries()];
    const from = entries.findIndex(([k]) => k === id);
    const to = entries.findIndex(([, x]) => x.state === "queued");
    if (from <= to) return;
    const [moved] = entries.splice(from, 1);
    entries.splice(to, 0, moved);
    byId.clear();
    for (const [k, v] of entries) byId.set(k, v);
    dirty = true;
    flush();
  },
  cancelAll() {
    let changed = false;
    for (const t of [...byId.values()]) {
      if ((t.state === "queued" || t.state === "running") && stopOne(t.id, "cancel")) changed = true;
    }
    if (changed) {
      dirty = true;
      flush();
    }
  },
  /**
   * Shows (or updates) a transfer the backend runs by itself, under its own id; `retry` is what
   * Retry does for it. It never goes through the queue.
   */
  track(t: Omit<Transfer, "speed">, hooks?: { retry?: () => void }) {
    listenOnce();
    if (hooks || !external.has(t.id)) external.set(t.id, hooks ?? external.get(t.id) ?? {});
    const next: Transfer = { ...t, error: t.error ?? null, speed: 0 };
    byId.set(t.id, next);
    if (next.state === "queued" || next.state === "running") currentRun.add(t.id);
    settle(next);
    dirty = true;
    flush();
    markDirty();
  },
  /** Takes a `track`ed transfer off the list (its failure was dealt with another way). */
  untrack(id: string) {
    if (!external.delete(id)) return;
    byId.delete(id);
    dirty = true;
    flush();
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

/**
 * What the Activity panel may offer for a row: the backend's own transfers (`track`) can't be
 * paused, cancelled or moved, and Retry only works when their owner gave a hook for it.
 */
export function transferControls(id: string): { manage: boolean; retry: boolean } {
  const ext = external.get(id);
  return ext ? { manage: false, retry: !!ext.retry } : { manage: true, retry: true };
}

/** Bytes of the current run (see `currentRun`) for the header: everything, and what is done. */
export function runTotals(list: Transfer[]): { total: number; done: number } {
  let total = runPrunedBytes;
  let done = runPrunedBytes;
  for (const t of list) {
    if (!currentRun.has(t.id)) continue;
    if (t.state !== "running" && t.state !== "queued" && t.state !== "done") continue;
    total += t.total;
    done += t.state === "done" ? t.total : t.bytes;
  }
  return { total, done };
}

/** The queue's actions, for components outside the hook (the Activity panel's pause and resume). */
export const transferActions: TransferActions = actions;

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

/** Whether any transfer is queued or running; re-renders only when that changes. */
export function useTransfersActive(): boolean {
  return useStore(transfersStore, (list) => list.some((t) => t.state === "queued" || t.state === "running"));
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
