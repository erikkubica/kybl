/**
 * Long bucket operations (move, copy, delete, rename) shown in the Activity panel. They run in
 * the background while you keep browsing; progress arrives as `move-progress` events.
 */
import { listen } from "@tauri-apps/api/event";
import { createStore, useStore } from "./store";

export type JobKind = "move" | "copy" | "delete" | "rename";
export type JobState = "running" | "done" | "error" | "cancelled";

export type Job = {
  id: string;
  kind: JobKind;
  /** "Moving 3 items to exports" */
  title: string;
  /** prefix to open from the finished job, in this connection and bucket */
  dest?: string;
  profileId?: string;
  bucket?: string;
  state: JobState;
  phase: "listing" | "copying" | "deleting" | null;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  /** 0..1, null until known */
  frac: number | null;
  eta: string | null;
  error: string | null;
  started: number;
  finished: number | null;
  /** a failed job: runs what is left of it again (a new job) */
  retry?: () => void;
  /** a rename that may take long (a batch): gets a Stop button like moves do */
  stoppable?: boolean;
};

type Progress = { opId: string; phase: "listing" | "copying" | "deleting"; done: number; total: number; bytes: number; totalBytes: number };

/** Completed fraction and a smoothed "about N min left" from successive progress reports. */
function tracker() {
  const start = Date.now();
  let smooth: number | null = null;
  return (p: Progress) => {
    const byCount = p.total ? p.done / p.total : 0;
    // per-object latency and bytes both cost time: weigh them equally
    const frac = p.totalBytes > 0 ? 0.5 * byCount + 0.5 * (p.bytes / p.totalBytes) : byCount;
    const elapsed = (Date.now() - start) / 1000;
    if (p.phase === "listing" || frac < 0.01 || elapsed < 3 || frac >= 1) return { frac, eta: null };
    const left = (elapsed * (1 - frac)) / frac;
    smooth = smooth == null ? left : smooth * 0.75 + left * 0.25;
    return { frac, eta: etaLabel(smooth) };
  };
}

export function etaLabel(secs: number): string {
  if (secs < 50) return "less than a minute left";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `about ${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `about ${h} h${m ? ` ${m} min` : ""} left`;
}

/** Jobs live outside React state: progress re-renders only the Activity panel. */
const jobsStore = createStore<Job[]>([]);
const trackers = new Map<string, ReturnType<typeof tracker>>();

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  listen<Progress>("move-progress", (e) => {
    const p = e.payload;
    const t = trackers.get(p.opId);
    if (!t) return;
    const { frac, eta } = t(p);
    jobsStore.set((list) =>
      list.map((j) =>
        j.id === p.opId && j.state === "running"
          ? { ...j, phase: p.phase, done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes, frac: p.phase === "listing" ? null : frac, eta }
          : j,
      ),
    );
  }).catch(() => {
    listening = false;
  });
}

const actions = {
  start(j: Pick<Job, "kind" | "title" | "dest" | "profileId" | "bucket" | "stoppable">): string {
    listenOnce();
    const id = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    trackers.set(id, tracker());
    jobsStore.set((list) => [
      ...list,
      { ...j, id, state: "running", phase: null, done: 0, total: 0, bytes: 0, totalBytes: 0, frac: null, eta: null, error: null, started: Date.now(), finished: null },
    ]);
    return id;
  },

  /**
   * Records how a job ended. A "Cancelled" error means the user stopped it. `retry` (kept when it
   * failed) runs what is left of it again.
   */
  finish(id: string, r: { done?: number; total?: number; error?: string | null }, retry?: () => void) {
    trackers.delete(id);
    jobsStore.set((list) =>
      list.map((j) => {
        if (j.id !== id) return j;
        const state: JobState = !r.error ? "done" : r.error === "Cancelled" ? "cancelled" : "error";
        return {
          ...j,
          state,
          done: r.done ?? j.done,
          total: r.total ?? j.total,
          error: state === "error" ? r.error ?? null : null,
          frac: state === "done" ? 1 : j.frac,
          eta: null,
          finished: Date.now(),
          retry: state === "error" ? retry : undefined,
        };
      }),
    );
  },

  /** Clears finished and cancelled jobs (failed ones stay until retried or cleared on their own). */
  clearFinished: () => jobsStore.set((list) => list.filter((j) => j.state === "running" || j.state === "error")),
  clearFailed: () => jobsStore.set((list) => list.filter((j) => j.state !== "error")),
  /** Runs a failed job's rest again; false when it can't be retried. */
  retry(id: string): boolean {
    const j = jobsStore.get().find((x) => x.id === id);
    if (!j || j.state !== "error" || !j.retry) return false;
    jobsStore.set((list) => list.filter((x) => x.id !== id));
    j.retry();
    return true;
  },
  dismiss: (id: string) => jobsStore.set((list) => list.filter((j) => j.id !== id)),
};

/** Actions on the job list. Stable, and does not subscribe to progress. */
export function useJobs() {
  listenOnce();
  return actions;
}

/** The live list, for components that show it. */
export function useJobList(): Job[] {
  return useStore(jobsStore);
}
