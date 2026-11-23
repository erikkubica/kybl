/**
 * Copies and moves between connections ("jobs"), kept by the backend in jobs.db so they survive
 * restarts. This store mirrors the backend's list: loaded once, then kept current by
 * `job-progress` events, which are buffered and published at most every 150 ms so a busy job
 * only re-renders the components that show jobs.
 */
import { listen } from "@tauri-apps/api/event";
import { jobsApi, type JobFailure, type JobProgress, type JobSpec, type JobState, type JobSummary } from "../api";
import { createStore, useStore } from "../store";

/** States in which a job still has work to do on its own (the quit prompt and badges count these). */
export const ACTIVE_STATES: ReadonlySet<JobState> = new Set(["planning", "running", "waitingNetwork"]);
/** States a job never leaves by itself. */
export const FINISHED_STATES: ReadonlySet<JobState> = new Set(["done", "failed", "cancelled"]);

export const isActive = (j: JobSummary) => ACTIVE_STATES.has(j.progress.state);
export const isFinished = (j: JobSummary) => FINISHED_STATES.has(j.progress.state);

const jobsStore = createStore<JobSummary[]>([]);
/** progress events not published yet, by job id */
const pending = new Map<string, JobProgress>();
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let loading: Promise<void> | null = null;
/** A second read asked for while one was in flight (see `refreshJobs`). */
let again: Promise<void> | null = null;
/** The list was read once: a job that first shows up already finished started (and ended) since. */
let loadedOnce = false;
/** Jobs removed from the list: a read that began before the delete went through must not bring them back. */
const removed = new Set<string>();

type Finished = (job: JobSummary) => void;
const finishedListeners = new Set<Finished>();

function publish() {
  timer = undefined;
  if (!pending.size) return;
  const updates = new Map(pending);
  pending.clear();
  let unknown = false;
  const ended: JobSummary[] = [];
  jobsStore.set((cur) => {
    const seen = new Set<string>();
    const next = cur.map((j) => {
      const p = updates.get(j.id);
      if (!p) return j;
      seen.add(j.id);
      if (!FINISHED_STATES.has(j.progress.state) && FINISHED_STATES.has(p.state)) ended.push({ ...j, progress: p });
      return { ...j, progress: p, updated: Date.now() };
    });
    if (seen.size < updates.size) unknown = true;
    return next;
  });
  // a job this page hasn't heard of (started elsewhere, or before the list loaded): ask again
  if (unknown) void refreshJobs();
  notifyEnded(ended);
}

function notifyEnded(ended: JobSummary[]) {
  for (const j of ended) for (const l of finishedListeners) l(j);
}

function schedule() {
  if (timer === undefined) timer = setTimeout(publish, 150);
}

/** Loads the list from the backend again (pending progress for known jobs is kept). */
export function refreshJobs(): Promise<void> {
  // the read in flight began before this caller's change (a job just created, paused): read once
  // more after it, or the caller would get a list without its change
  if (loading) {
    again ??= loading.then(() => {
      again = null;
      return refreshJobs();
    });
    return again;
  }
  loading = jobsApi
    .jobList()
    .then((list) => {
      // a job can end between two events and the next list (a cancel, or while the page slept):
      // the list is then the first to say so, and "finished" must still fire once. So must one
      // that is new to this list and already over (a small copy that ended within a second)
      const before = new Map(jobsStore.get().map((j) => [j.id, j.progress.state]));
      const listedBefore = loadedOnce;
      loadedOnce = true;
      list = list.filter((j) => !removed.has(j.id));
      jobsStore.set(list);
      notifyEnded(
        list.filter((j) => {
          const was = before.get(j.id);
          if (!FINISHED_STATES.has(j.progress.state)) return false;
          return was === undefined ? listedBefore : !FINISHED_STATES.has(was);
        }),
      );
    })
    .catch(() => {
      /* an older backend without jobs: the list stays empty */
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * Starts listening for job progress and loads the list. Call once when the app starts (desktop
 * and phone); calling it again does nothing.
 */
export function startMigrations(): void {
  if (started) return;
  started = true;
  void listen<JobProgress>("job-progress", (e) => {
    pending.set(e.payload.id, e.payload);
    schedule();
  });
  // phones: the backend may have moved on (or been restarted) while the page slept
  void listen("app-resumed", () => void refreshJobs());
  void refreshJobs();
}

/** Called when a job ends by itself or is cancelled (done, failed, cancelled), e.g. for a toast. */
export function onJobFinished(listener: Finished): () => void {
  finishedListeners.add(listener);
  return () => finishedListeners.delete(listener);
}

/** Every job, newest first. */
export function useMigrations(): JobSummary[] {
  return useStore(jobsStore);
}

/** Jobs that are planning, copying or waiting for the network (for a badge on the Jobs tab). */
export function useActiveJobCount(): number {
  return useStore(jobsStore, (list) => list.reduce((n, j) => n + (isActive(j) ? 1 : 0), 0));
}

/** The current list without subscribing (event handlers). */
export const getJobs = () => jobsStore.get();

/** Shows a state change right away; the backend's next event confirms or corrects it. */
function optimistic(id: string, state: JobState) {
  jobsStore.set((cur) => cur.map((j) => (j.id === id ? { ...j, progress: { ...j.progress, state } } : j)));
}

export const migrations = {
  /** Starts a job; resolves to its id once the backend has it. */
  async create(spec: JobSpec): Promise<string> {
    startMigrations();
    const id = await jobsApi.jobCreate(spec);
    await refreshJobs();
    return id;
  },
  async pause(id: string) {
    optimistic(id, "paused");
    try {
      await jobsApi.jobPause(id);
    } finally {
      void refreshJobs();
    }
  },
  async resume(id: string) {
    optimistic(id, "running");
    try {
      await jobsApi.jobResume(id);
    } finally {
      void refreshJobs();
    }
  },
  async cancel(id: string) {
    try {
      await jobsApi.jobCancel(id);
    } finally {
      void refreshJobs();
    }
  },
  /** Removes a finished (or paused) job from the list. */
  async remove(id: string) {
    removed.add(id);
    jobsStore.set((cur) => cur.filter((j) => j.id !== id));
    try {
      await jobsApi.jobDelete(id);
    } catch (e) {
      removed.delete(id);
      void refreshJobs();
      throw e;
    }
  },
  async retryFailed(id: string) {
    optimistic(id, "running");
    try {
      await jobsApi.jobRetryFailed(id);
    } finally {
      void refreshJobs();
    }
  },
  failures: (id: string, offset = 0, limit = 50): Promise<JobFailure[]> => jobsApi.jobFailures(id, offset, limit),
};
