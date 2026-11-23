/**
 * Mirror's engine glue: list both folders, work out the plan (the dry run), and start it as one
 * job of the job engine (src-tauri/src/jobs/mirror.rs), which copies exactly the planned files
 * and then deletes exactly the planned ones.
 *
 * For a command palette: `listMirrors()`, then `runMirror(id, { dryRun: true })` to see what a
 * saved mirror would do and `runMirror(id)` to do it.
 */
import { invoke } from "@tauri-apps/api/core";
import { api, errMessage, jobsApi, type Capabilities, type JobSpec } from "../api";
import { capsFor } from "../useCaps";
import { refreshJobs, startMigrations } from "../jobs/useMigrations";
import { makeMatcher } from "./ignore";
import { defaultTolerance, planIsEmpty, planMirror, type Listing, type MirrorPlan } from "./plan";
import { getMirror, markRun, type MirrorConfig } from "./store";
import { Cancelled, walk, type Place } from "./walk";

export type MirrorPreview = {
  config: MirrorConfig;
  plan: MirrorPlan;
  /** the destination folder isn't there yet: it is made first */
  dstMissing: boolean;
  /** the .gitignore patterns that were added, when there was one and it was asked for */
  gitignore: string | null;
  toleranceMs: number;
  /** both listings, so a change of mode or comparison is planned again without listing */
  lists: { src: Listing; dst: Listing; compare: MirrorConfig["compare"] };
};

export type MirrorStatus = { phase: "listing-src" | "listing-dst" | "checksums"; done: number; total?: number };

const GITIGNORE_MAX = 256 * 1024;

/** The .gitignore at the top of a folder on this device (null: none, or not on this device). */
export async function readGitignore(at: Place, caps: Capabilities | null): Promise<string | null> {
  if (!caps?.localPaths) return null;
  try {
    const r = await api.textPreview(at.profileId, at.root, `${at.dir}.gitignore`, GITIGNORE_MAX);
    return r.text;
  } catch {
    return null;
  }
}

/** Which of the two ends of a mirror is on this device (its .gitignore applies), source first. */
export function gitignoreSide(config: MirrorConfig, srcCaps: Capabilities | null, dstCaps: Capabilities | null): Place | null {
  if (srcCaps?.localPaths) return config.src;
  if (dstCaps?.localPaths) return config.dst;
  return null;
}

/** Checksums can be compared: each side's store reports MD5s, or its files are on this device. */
export const canChecksum = (a: Capabilities | null, b: Capabilities | null) =>
  [a, b].every((c) => !!c && (c.localPaths || c.hashes.includes("md5")));

/** Why these two folders can't be mirrored, or null. */
export function mirrorBlocked(src: Place, dst: Place): string | null {
  if (src.profileId !== dst.profileId) return null;
  const inside = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  const full = (p: Place) => `${p.root.replace(/[/\\]+$/, "")}/${p.dir}`;
  if (src.profileId === "local" ? inside(full(src), full(dst)) : src.root === dst.root && inside(src.dir, dst.dir))
    return src.root === dst.root && src.dir === dst.dir ? "That's the same folder." : "One folder is inside the other. Pick two separate folders.";
  return null;
}

async function kindOf(profileId: string): Promise<string | undefined> {
  if (profileId === "local") return "local";
  try {
    return (await api.listProfiles()).find((p) => p.id === profileId)?.kind ?? "s3";
  } catch {
    return undefined;
  }
}

/** Lists the destination; a folder that isn't there yet is an empty one (made when the mirror runs). */
async function walkDst(at: Place, caps: Capabilities | null, ex: ReturnType<typeof makeMatcher>, signal?: AbortSignal, onCount?: (n: number) => void): Promise<{ list: Listing; missing: boolean }> {
  try {
    return { list: await walk(at, caps, ex, { signal, onCount }), missing: false };
  } catch (e) {
    if (e instanceof Cancelled || !at.dir) throw e;
    // gone, or never made: its parent lists without it
    const parent = at.dir.replace(/[^/]+\/$/, "");
    const page = await api.listObjects(at.profileId, at.root, parent, null).catch(() => null);
    if (!page || page.folders.includes(at.dir)) throw e;
    return { list: { files: new Map(), dirs: new Set(), excluded: 0 }, missing: true };
  }
}

/** The dry run: lists both folders and decides what the mirror would copy and delete. */
export async function previewMirror(config: MirrorConfig, opts: { signal?: AbortSignal; onStatus?: (s: MirrorStatus) => void } = {}): Promise<MirrorPreview> {
  // only the settings (a saved mirror has its name and dates too)
  const { src: s0, dst: d0, deleteExtra, compare: c0, excludes, useGitignore } = config;
  config = { src: s0, dst: d0, deleteExtra, compare: c0, excludes, useGitignore };
  const why = mirrorBlocked(config.src, config.dst);
  if (why) throw new Error(why);
  const [srcCaps, dstCaps, srcKind, dstKind] = await Promise.all([
    capsFor(config.src.profileId).catch(() => null),
    capsFor(config.dst.profileId).catch(() => null),
    kindOf(config.src.profileId),
    kindOf(config.dst.profileId),
  ]);
  const side = config.useGitignore ? gitignoreSide(config, srcCaps, dstCaps) : null;
  const gitignore = side ? await readGitignore(side, side === config.src ? srcCaps : dstCaps) : null;
  const ex = makeMatcher(config.excludes, gitignore ?? "");
  const { signal, onStatus } = opts;
  const src = await walk(config.src, srcCaps, ex, { signal, onCount: (n) => onStatus?.({ phase: "listing-src", done: n }) });
  const dst = await walkDst(config.dst, dstCaps, ex, signal, (n) => onStatus?.({ phase: "listing-dst", done: n }));
  const compare = config.compare === "checksum" && !canChecksum(srcCaps, dstCaps) ? "time" : config.compare;
  if (compare === "checksum") await fillChecksums(config, src, dst.list, srcCaps, dstCaps, signal, onStatus);
  const toleranceMs = defaultTolerance([srcKind, dstKind]);
  const plan = planMirror(src, dst.list, { deleteExtra: config.deleteExtra, compare, toleranceMs });
  return { config, plan, dstMissing: dst.missing, gitignore, toleranceMs, lists: { src, dst: dst.list, compare } };
}

/**
 * The same dry run for other options, without listing again: only when just "also delete" or
 * how changes are decided differ (checksums need the hashes the first run worked out). Null when
 * the folders have to be listed again.
 */
export function replan(p: MirrorPreview, config: MirrorConfig): MirrorPreview | null {
  const same = (a: MirrorConfig, b: MirrorConfig) =>
    JSON.stringify([a.src, a.dst, a.excludes, a.useGitignore]) === JSON.stringify([b.src, b.dst, b.excludes, b.useGitignore]);
  if (!same(p.config, config)) return null;
  if (config.compare === "checksum" && p.lists.compare !== "checksum") return null;
  const compare = config.compare === "checksum" ? p.lists.compare : config.compare;
  const plan = planMirror(p.lists.src, p.lists.dst, { deleteExtra: config.deleteExtra, compare, toleranceMs: p.toleranceMs });
  return { ...p, config, plan };
}

/** Same-size pairs where only this device's side lacks an MD5: hashed here (a few at a time). */
async function fillChecksums(config: MirrorConfig, src: Listing, dst: Listing, srcCaps: Capabilities | null, dstCaps: Capabilities | null, signal?: AbortSignal, onStatus?: (s: MirrorStatus) => void) {
  const todo: { place: Place; file: { md5?: string | null; key?: string } }[] = [];
  for (const [rel, s] of src.files) {
    const d = dst.files.get(rel);
    if (!d || d.size !== s.size) continue;
    if (!s.md5 && srcCaps?.localPaths) todo.push({ place: config.src, file: s });
    if (!d.md5 && dstCaps?.localPaths) todo.push({ place: config.dst, file: d });
  }
  let done = 0;
  const total = todo.length;
  const next = async (): Promise<void> => {
    const job = todo.shift();
    if (!job) return;
    if (signal?.aborted) throw new Cancelled();
    job.file.md5 = await invoke<string | null>("mirror_md5", { profileId: job.place.profileId, bucket: job.place.root, key: job.file.key }).catch(() => null);
    onStatus?.({ phase: "checksums", done: ++done, total });
    return next();
  };
  await Promise.all([next(), next(), next(), next()]);
}

const placeName = (e: MirrorConfig["src"]) => [e.rootName, ...e.dir.split("/").filter(Boolean)].pop() || e.connectionName;

/** "Mirror acme to Acme live" */
export const defaultMirrorName = (c: MirrorConfig) => `Mirror ${placeName(c.src)} to ${c.dst.profileId === c.src.profileId ? placeName(c.dst) : c.dst.connectionName}`;

/** Starts the job for a preview; resolves to its id (null: nothing to do). */
export async function startMirror(preview: MirrorPreview, title?: string): Promise<string | null> {
  const { config: c, plan } = preview;
  if (planIsEmpty(plan)) return null;
  if (preview.dstMissing && c.dst.dir) await api.createFolder(c.dst.profileId, c.dst.root, c.dst.dir);
  const spec: JobSpec = {
    mode: "copy",
    src: { profileId: c.src.profileId, root: c.src.root, items: [{ path: c.src.dir, isDir: true }] },
    dst: { profileId: c.dst.profileId, root: c.dst.root, dir: c.dst.dir },
    // the plan decided what to copy; the copier still skips a file proven identical by its hash
    conflict: "overwrite",
    verify: "hash",
    preserveMtime: true,
    ignore: [],
    title: title || defaultMirrorName(c),
    mirror: {
      copy: [
        ...plan.mkdirs.map((rel) => ({ rel })),
        ...plan.upload.map((u) => ({ rel: u.rel, size: u.size, mtime: u.file?.mtime ?? null, md5: u.file?.md5 ?? null })),
      ],
      delete: [...plan.remove.map((r) => r.rel), ...plan.removeDirs],
    },
  };
  startMigrations();
  const id = await jobsApi.jobCreate(spec);
  await refreshJobs();
  return id;
}

/**
 * Runs a saved mirror: works out its plan and, unless `dryRun`, starts it. Deletions run too when
 * the mirror has them on, so a palette should show a dry run's `plan.remove` first.
 */
export async function runMirror(id: string, opts: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<{ preview: MirrorPreview; jobId: string | null }> {
  const m = getMirror(id);
  if (!m) throw new Error("This mirror isn't saved any more.");
  const preview = await previewMirror(m, { signal: opts.signal });
  if (opts.dryRun) return { preview, jobId: null };
  try {
    const jobId = await startMirror(preview, m.name);
    markRun(id);
    return { preview, jobId };
  } catch (e) {
    throw new Error(errMessage(e));
  }
}
