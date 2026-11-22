/**
 * Browser-only stand-in for the job engine (`pnpm dev` without Tauri): jobs live in memory and
 * a timer moves them along, sending `job-progress` like the backend does. Seeded with a running,
 * a finished-with-problems and a paused job so every state can be looked at.
 */
import { emit } from "@tauri-apps/api/event";
import type { JobFailure, JobProgress, JobSpec, JobSummary } from "../api";

type MockJob = JobSummary & {
  /** bytes per file, to move bytesDone along with filesDone */
  avg: number;
  failAt: Set<number>;
  failures: JobFailure[];
  planLeft: number;
  /** where a retry starts counting again */
  retrying?: boolean;
};

const HOUR = 3600_000;
const now = Date.now();
const jobs: MockJob[] = [];

function progress(id: string, p: Partial<JobProgress>): JobProgress {
  return {
    id,
    state: "running",
    phase: "copying",
    filesDone: 0,
    filesTotal: 0,
    filesFailed: 0,
    filesSkipped: 0,
    bytesDone: 0,
    bytesTotal: 0,
    rateBps: 0,
    etaSecs: null,
    current: [],
    error: null,
    ...p,
  };
}

const baseSpec = (over: Partial<JobSpec>): JobSpec => ({
  mode: "copy",
  src: { profileId: "p1", root: "media-prod", items: [{ path: "", isDir: true }] },
  dst: { profileId: "p2", root: "backups", dir: "media/" },
  conflict: "skipIdentical",
  verify: "hash",
  preserveMtime: true,
  ignore: [".DS_Store"],
  ...over,
});

function seed() {
  const running = "job-demo-running";
  jobs.push({
    id: running,
    title: "Everything in media-prod to AWS production",
    spec: baseSpec({ id: running }),
    created: now - 0.4 * HOUR,
    updated: now,
    progress: progress(running, { filesDone: 1_204, filesSkipped: 310, filesTotal: 4_620, bytesDone: 6_200_000_000, bytesTotal: 18_400_000_000, rateBps: 42_000_000 }),
    avg: 4_000_000,
    failAt: new Set([1_600, 2_210]),
    failures: [],
    planLeft: 0,
  });
  const paused = "job-demo-paused";
  jobs.push({
    id: paused,
    title: "“Pictures” to Hetzner · media",
    spec: baseSpec({ id: paused, src: { profileId: "local", root: "/Users/demo", items: [{ path: "Pictures/", isDir: true }] }, dst: { profileId: "p1", root: "media-prod", dir: "photos/" }, mode: "move" }),
    created: now - 2 * HOUR,
    updated: now - HOUR,
    progress: progress(paused, { state: "paused", filesDone: 40, filesTotal: 128, bytesDone: 120_000_000, bytesTotal: 410_000_000 }),
    avg: 3_200_000,
    failAt: new Set(),
    failures: [],
    planLeft: 0,
  });
  const done = "job-demo-done";
  const failures: JobFailure[] = [
    { path: "website/assets/video/hero-loop.webm", error: "The server closed the connection before the file was complete.\n\nconnection reset by peer" },
    { path: "website/old/index (copy).html", error: "Access denied. This key isn't allowed to write here.\n\nAccessDenied: s3:PutObject" },
    { path: "website/.cache/tmp-8812.bin", error: "This file changed while it was being copied. Try again.\n\nsize mismatch: 1048576 != 1050112" },
  ];
  jobs.push({
    id: done,
    title: "“website” to AWS production",
    spec: baseSpec({ id: done, src: { profileId: "p1", root: "media-prod", items: [{ path: "website/", isDir: true }] }, dst: { profileId: "p2", root: "static-assets", dir: "" } }),
    created: now - 26 * HOUR,
    updated: now - 25 * HOUR,
    progress: progress(done, { state: "done", phase: "finished", filesDone: 892, filesSkipped: 44, filesFailed: failures.length, filesTotal: 939, bytesDone: 2_300_000_000, bytesTotal: 2_310_000_000 }),
    avg: 2_500_000,
    failAt: new Set(),
    failures,
    planLeft: 0,
  });
}
seed();

// copies, like the real IPC hands out: the page must never hold the object the timer mutates (a
// job finishing in place would never look like it changed, and "finished" would never fire)
const summary = (j: MockJob): JobSummary => ({ id: j.id, title: j.title, spec: j.spec, created: j.created, updated: j.updated, progress: { ...j.progress, current: [...j.progress.current] } });
const send = (j: MockJob) => {
  j.updated = Date.now();
  void emit("job-progress", { ...j.progress, current: [...j.progress.current] });
};

const NAMES = ["IMG_4412.jpg", "clip-00231.mp4", "export/final-v3.mov", "photos/2026/hanoi/pho.jpg", "backup-2026-11-10.tar.gz", "docs/contract.pdf"];

function tick() {
  for (const j of jobs) {
    const p = j.progress;
    if (p.state === "planning") {
      p.filesTotal += 180 + Math.round(Math.random() * 120);
      p.bytesTotal = p.filesTotal * j.avg;
      if (--j.planLeft <= 0) {
        p.state = "running";
        p.phase = "copying";
      }
      send(j);
      continue;
    }
    if (p.state !== "running") continue;
    const step = 3 + Math.round(Math.random() * 4);
    for (let i = 0; i < step; i++) {
      const at = p.filesDone + p.filesSkipped + p.filesFailed;
      if (at >= p.filesTotal) break;
      if (j.failAt.has(at)) {
        p.filesFailed++;
        j.failures.push({ path: `photos/IMG_${at}.jpg`, error: "The server didn't answer in time. Check your internet connection.\n\ntimeout after 30s" });
      } else if (!j.retrying && at % 11 === 0) p.filesSkipped++;
      else p.filesDone++;
    }
    const at = p.filesDone + p.filesSkipped + p.filesFailed;
    p.bytesDone = Math.min(p.bytesTotal, Math.round((p.bytesTotal * at) / Math.max(1, p.filesTotal)));
    p.rateBps = Math.round(38_000_000 + Math.random() * 12_000_000);
    p.etaSecs = p.rateBps > 0 ? Math.round((p.bytesTotal - p.bytesDone) / p.rateBps) : null;
    p.current = [NAMES[at % NAMES.length], NAMES[(at + 1) % NAMES.length], NAMES[(at + 3) % NAMES.length]];
    if (at >= p.filesTotal) {
      p.state = "done";
      p.phase = "finished";
      p.rateBps = 0;
      p.etaSecs = null;
      p.current = [];
      j.retrying = false;
    }
    send(j);
  }
}
setInterval(tick, 250);

const find = (id: string) => {
  const j = jobs.find((x) => x.id === id);
  if (!j) throw "This job isn't there any more.";
  return j;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleJob(cmd: string, a: any): Promise<unknown> {
  switch (cmd) {
    case "job_list":
      return [...jobs].sort((x, y) => y.created - x.created).map(summary);
    case "job_create": {
      const spec = a.spec as JobSpec;
      const id = spec.id || `job-${Math.random().toString(36).slice(2, 10)}`;
      const j: MockJob = {
        id,
        title: spec.title || "Copy",
        spec: { ...spec, id },
        created: Date.now(),
        updated: Date.now(),
        progress: progress(id, { state: "planning", phase: "planning" }),
        avg: 2_800_000,
        failAt: new Set([7, 61]),
        failures: [],
        planLeft: 8,
      };
      jobs.push(j);
      send(j);
      return id;
    }
    case "job_pause": {
      const j = find(a.id);
      if (j.progress.state === "running" || j.progress.state === "planning" || j.progress.state === "waitingNetwork") {
        j.progress = { ...j.progress, state: "paused", rateBps: 0, etaSecs: null, current: [] };
        send(j);
      }
      return null;
    }
    case "job_resume": {
      const j = find(a.id);
      j.progress = { ...j.progress, state: j.planLeft > 0 ? "planning" : "running", error: null };
      send(j);
      return null;
    }
    case "job_cancel": {
      const j = find(a.id);
      j.progress = { ...j.progress, state: "cancelled", phase: "finished", rateBps: 0, etaSecs: null, current: [] };
      send(j);
      return null;
    }
    case "job_delete": {
      const i = jobs.findIndex((x) => x.id === a.id);
      if (i >= 0 && ["running", "planning"].includes(jobs[i].progress.state)) throw "Stop the job before removing it.";
      if (i >= 0) jobs.splice(i, 1);
      return null;
    }
    case "job_failures": {
      const j = find(a.id);
      return j.failures.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 100));
    }
    case "job_retry_failed": {
      const j = find(a.id);
      // the files that failed before go through again, and this time they make it
      j.progress = { ...j.progress, state: "running", phase: "copying", filesFailed: 0 };
      j.failures = [];
      j.failAt = new Set();
      j.retrying = true;
      send(j);
      return null;
    }
    default:
      throw `Unknown job command ${cmd}`;
  }
}
