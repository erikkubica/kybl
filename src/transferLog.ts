/**
 * Transfers as the Activity log tells them: one line when something starts ("Started
 * downloading “regina-lite” (folder) from X to Downloads") and one when all of it has ended
 * (counts, size and time, or why it failed, with the first errors under Details), however many
 * files it was. The queue (useTransfers.ts) reports rows as they are added and as their state
 * changes; rows of one user action are one batch.
 *
 * A batch is the rows added together. Rows added later for the same kind, connection and
 * destination that share a top folder (a folder download that starts while it is still being
 * listed), or that come within a moment of the last ones, join it instead of starting another.
 */
import { api } from "./api";
import { logMessage } from "./activityLog";
import { connLabel } from "./connLog";
import { rootName } from "./connections/roots";
import { batchDetail, batchEndLine, batchStartLine, batchSubject, lastSegment, type BatchEnd, type BatchInfo } from "./logText.ts";
import type { Transfer, TransferState } from "./types";

/** quiet time after the last row ended before the batch counts as over (more rows may still come) */
const SETTLE_MS = 1500;
/** rows added this soon after a batch's last ones join it even without a shared top folder */
const JOIN_MS = 2000;
/** errors kept per batch for its Details */
const KEEP_ERRORS = 5;

type Batch = {
  info: BatchInfo;
  sig: string;
  /** its connection and root (the name is read again when it ends: it may not have been known yet) */
  pid: string;
  root: string;
  /** what lands at the top of the destination, and whether each is a folder */
  tops: Map<string, boolean>;
  states: Map<string, TransferState>;
  started: number;
  lastAdd: number;
  doneBytes: number;
  /** by row id: the first few, name and message kept apart (a name can hold ": ") */
  errors: Map<string, { name: string; message: string }>;
  facts: [string, string | null][];
  /** when its last row ended */
  endAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const batchOf = new Map<string, Batch>();
const open = new Set<Batch>();
/** folder listings still feeding downloads, by batch signature: their batches stay open meanwhile */
const listing = new Map<string, number>();
let tempDir: string | null = null;
let askedTemp = false;

const ended = (s: TransferState) => s === "done" || s === "error" || s === "cancelled";
const dirOf = (p: string) => p.replace(/[\\/]+[^\\/]*$/, "");
const topOf = (name: string) => name.replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0];

/** Where the row lands, as a folder: the batch's destination. */
function placeOf(t: Transfer, base?: string): string {
  if (t.kind === "download") return base ?? dirOf(t.local);
  if (t.kind === "upload") return t.key.endsWith(t.name) ? t.key.slice(0, t.key.length - t.name.length) : dirOf(t.key);
  // compress / extract: one row is one action
  return t.id;
}

/** "X" or "X (bucket)" when the root has a name of its own. */
function connWithRoot(profileId: string, bucket: string): string {
  const conn = connLabel(profileId);
  if (!bucket) return conn;
  const r = rootName(profileId, bucket);
  return r && r !== conn ? `${conn} (${r})` : conn;
}

/**
 * Rows just added to the queue. `how`: "new" (a user action), "retry" (Retry / Retry all on rows
 * whose batch already ended), "adopted" (already running when the page loaded: followed, not announced).
 */
export function noteAdded(rows: Transfer[], how: "new" | "retry" | "adopted" = "new", bases?: Map<string, string>) {
  if (!rows.length) return;
  if (!askedTemp) {
    askedTemp = true;
    api.tempFolder().then((d) => (tempDir = d), () => {});
  }
  const now = Date.now();
  const groups = new Map<string, { rows: Transfer[]; place: string }>();
  for (const t of rows) {
    if (batchOf.has(t.id)) continue;
    const place = placeOf(t, bases?.get(t.id));
    const sig = `${t.kind}\n${t.profileId}\n${t.bucket}\n${place}`;
    const g = groups.get(sig) ?? { rows: [], place };
    g.rows.push(t);
    groups.set(sig, g);
  }
  for (const [sig, g] of groups) {
    const tops = new Map<string, boolean>();
    for (const t of g.rows) {
      const n = t.name.replace(/\\/g, "/").replace(/^\/+/, "");
      const top = topOf(n);
      tops.set(top, (tops.get(top) ?? false) || n.length > top.length);
    }
    let b: Batch | undefined;
    if (how === "new") {
      // a shared top folder is an exact match and wins over "came right after the last rows":
      // two folders streaming to one destination would otherwise mix their later files
      for (const o of open) if (o.sig === sig && [...tops.keys()].some((x) => o.tops.has(x))) {
        b = o;
        break;
      }
      if (!b) {
        const mine = new Set(tops.keys());
        for (const o of open) {
          if (o.sig !== sig || now - o.lastAdd >= JOIN_MS) continue;
          // not the batch of another folder that is still being listed
          if (listing.get(sig) && [...o.tops].some(([x, folder]) => folder && !mine.has(x))) continue;
          b = o;
          break;
        }
      }
    }
    if (!b) {
      const first = g.rows[0];
      const temp = first.kind === "download" && !!tempDir && first.local.startsWith(tempDir);
      const subject = first.kind === "compress" || first.kind === "extract" ? `“${first.name}”` : batchSubject(g.rows.map((t) => t.name));
      const place = first.kind === "download" ? lastSegment(g.place) : first.kind === "upload" ? lastSegment(g.place) : "";
      const info: BatchInfo = { kind: first.kind, subject, conn: connWithRoot(first.profileId, first.bucket), place, temp, retry: how === "retry" };
      const remote = first.kind === "download" ? dirOf(first.key) : first.kind === "upload" ? g.place : first.key;
      b = {
        info,
        sig,
        pid: first.profileId,
        root: first.bucket,
        tops: new Map(tops),
        states: new Map(),
        started: now,
        lastAdd: now,
        doneBytes: 0,
        endAt: now,
        errors: new Map(),
        facts: [
          ["Connection", connWithRoot(first.profileId, first.bucket)],
          [first.kind === "download" ? "From" : first.kind === "upload" ? "To" : "Where", `/${remote.replace(/^\/+/, "")}`],
          [first.kind === "download" ? "To" : first.kind === "upload" ? "From" : "", first.kind === "download" ? g.place : first.kind === "upload" ? dirOf(first.local) : null],
        ],
      };
      open.add(b);
      if (how !== "adopted") logMessage("info", batchStartLine(info));
    } else {
      let grew = false;
      for (const [x, folder] of tops) {
        const had = b.tops.get(x);
        const next = folder || !!had;
        if (had !== next) {
          b.tops.set(x, next);
          grew = true;
        }
      }
      // a second top folder or file joined: "“a” and 1 more" when it ends
      if (grew && (b.info.kind === "download" || b.info.kind === "upload"))
        b.info = { ...b.info, subject: batchSubject([...b.tops].map(([x, f]) => (f ? `${x}/_` : x))) };
    }
    b.lastAdd = now;
    for (const t of g.rows) {
      batchOf.set(t.id, b);
      b.states.set(t.id, t.state);
    }
    check(b);
  }
}

/** A row's state changed (or it left the list: `gone`). */
export function noteState(t: Transfer, gone = false) {
  const b = batchOf.get(t.id);
  if (!b) return;
  const before = b.states.get(t.id);
  const state: TransferState = gone && !ended(t.state) ? "cancelled" : t.state;
  if (before === state) return;
  b.states.set(t.id, state);
  if (state === "done") b.doneBytes += t.total || t.bytes;
  else if (before === "done") b.doneBytes -= t.total || t.bytes;
  if (state === "error" && b.errors.size < KEEP_ERRORS) b.errors.set(t.id, { name: t.name, message: t.error ?? "failed" });
  else if (before === "error" && state !== "error") b.errors.delete(t.id);
  check(b);
}

/** Whether a row is part of a batch still being followed (Retry on it continues that batch). */
export const inOpenBatch = (id: string) => batchOf.has(id);

function check(b: Batch) {
  if (b.timer !== undefined) {
    clearTimeout(b.timer);
    b.timer = undefined;
  }
  // rows still being found for it: not over, however quiet it is
  if (listing.get(b.sig)) return;
  for (const s of b.states.values()) if (!ended(s)) return;
  b.endAt = Date.now();
  b.timer = setTimeout(() => finish(b), SETTLE_MS);
}

/**
 * A folder download is still listing its files into `dir`: its batch is not over when the rows so
 * far have ended (a slow listing hands over the next files later than the settle time, which
 * would otherwise log "Started… Downloaded…" again for one action). Call the returned function
 * once the listing ended, however it ended.
 */
export function holdBatch(profileId: string, bucket: string, dir: string): () => void {
  const sig = `download\n${profileId}\n${bucket}\n${dir}`;
  listing.set(sig, (listing.get(sig) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (listing.get(sig) ?? 1) - 1;
    if (left > 0) listing.set(sig, left);
    else listing.delete(sig);
    for (const b of open) if (b.sig === sig) check(b);
  };
}

function finish(b: Batch) {
  b.timer = undefined;
  if (listing.get(b.sig)) return;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  for (const s of b.states.values()) {
    if (!ended(s)) return;
    if (s === "done") done++;
    else if (s === "error") failed++;
    else cancelled++;
  }
  open.delete(b);
  for (const id of b.states.keys()) if (batchOf.get(id) === b) batchOf.delete(id);
  const conn = connWithRoot(b.pid, b.root);
  const end: BatchEnd = { ...b.info, conn, count: b.states.size, done, failed, cancelled, bytes: Math.max(0, b.doneBytes), ms: b.endAt - b.started, errors: [...b.errors.values()] };
  const line = batchEndLine(end);
  logMessage(line.kind, line.text, batchDetail(end, [["Connection", conn], ...b.facts.slice(1).filter(([k]) => k)]));
}
