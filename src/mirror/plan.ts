/**
 * What a mirror does, decided from two listings without touching either side: which files are
 * new or changed (to copy), which are gone from the source (to delete, when asked), which are the
 * same. Pure, so the dry run and the run are the same decision (and the tests run it with plain
 * `node --test`: no imports but types).
 *
 * "Changed" by default means another size, or a source modified more recently than the
 * destination's copy (beyond a tolerance: FTP servers give minutes, FAT disks two seconds). S3
 * keeps the upload time, which is after the file was last edited, so that works there too. A
 * server whose clock or listing is off by whole hours (FTP LIST in local time) is spotted when
 * most same-size files are exactly that far apart, and allowed for. With checksums, files whose
 * MD5 is known on both sides are compared by it (another size still means changed).
 */

/** A file in a listing; `rel` paths are relative to the mirrored folder. */
export type MFile = { size: number; mtime: number | null; md5?: string | null; key?: string };
/**
 * One side, listed: files by relative path, folders as relative paths ending with "/". `links`:
 * links met (folders end with "/"), never gone into; neither side's link, nor anything at or
 * below its name on the other side, is copied or deleted.
 */
export type Listing = { files: Map<string, MFile>; dirs: Set<string>; excluded: number; links?: Set<string> };

export type CompareMode = "time" | "size" | "checksum";
export type PlanOptions = {
  /** also delete what's at the destination but gone from the source */
  deleteExtra: boolean;
  compare: CompareMode;
  /** modification times this close count as the same */
  toleranceMs: number;
  /**
   * The destination doesn't tell names apart by letter case (this Mac's or PC's disk, OneDrive,
   * Dropbox, Box): a file there is matched by its name in any case, and two source names that
   * differ only in case can't both be mirrored. Either way a destination name that differs from a
   * source name only in case is never deleted (a server's case rules aren't always known).
   */
  caseInsensitive?: boolean;
};

export type Change = { rel: string; size: number; why: "new" | "changed" | "same" | "gone" | "kept" | "blocked"; note?: string; file?: MFile };

export type MirrorPlan = {
  /** files to copy, new and changed, in path order */
  upload: Change[];
  /** folders missing at the destination (empty ones too), parents first */
  mkdirs: string[];
  /** files to delete at the destination (only with `deleteExtra`) */
  remove: Change[];
  /** folders to delete at the destination once empty, deepest first (only with `deleteExtra`) */
  removeDirs: string[];
  /** only at the destination and left alone */
  kept: Change[];
  /** can't be mirrored: a file where the other side has a folder of that name, or the reverse */
  blocked: Change[];
  /** the same on both sides, skipped */
  unchanged: Change[];
  /** links on either side, and what the other side has at or below their names: left alone */
  links: Change[];
  same: number;
  sameBytes: number;
  uploadBytes: number;
  removeBytes: number;
  /** listed files and folders the exclude rules left out, on both sides */
  excluded: number;
  /** a clock difference allowed for (destination minus source), 0 when none */
  offsetMs: number;
  /** pairs settled by comparing checksums */
  checksummed: number;
};

const HOUR = 3600_000;

/** The usual tolerance between two kinds of connections. */
export function defaultTolerance(kinds: (string | undefined | null)[]): number {
  // MDTM / LIST give whole minutes at best
  if (kinds.includes("ftp")) return 61_000;
  return 2_000;
}

/**
 * Whether a destination of this kind tells names apart by letter case: like the job engine's
 * `storage::case_insensitive`, this device's disk on macOS, iOS and Windows (from `platform`,
 * e.g. the user agent), and OneDrive, Dropbox and Box.
 */
export function caseInsensitiveKind(kind: string | undefined | null, platform: string): boolean {
  if (kind === "onedrive" || kind === "dropbox" || kind === "box") return true;
  return kind === "local" && /Mac|Win|iPhone|iPad|iPod/i.test(platform);
}

type At = { profileId: string; root: string; dir: string };

/**
 * One of the two folders is inside the other (or they are the same), like the job engine's
 * `jobs::mirror::overlaps`. On this device the full paths count, whatever the roots: they are
 * compared with `/` as the only separator (Windows roots come with `\`), at folder boundaries,
 * and ignoring letter case where the disk does (`foldCase`, or a Windows-style root).
 */
export function foldersOverlap(src: At, dst: At, foldCase: boolean): boolean {
  if (src.profileId !== dst.profileId) return false;
  const inside = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  if (src.profileId !== "local") return src.root === dst.root && inside(src.dir, dst.dir);
  const windows = (r: string) => r.includes("\\") || r[1] === ":";
  const fold = foldCase || windows(src.root) || windows(dst.root);
  const full = (p: At) => {
    const joined = `${p.root}/${p.dir}`.replace(/\\/g, "/");
    const out = (joined.startsWith("/") ? "/" : "") + joined.split("/").filter(Boolean).map((s) => `${s}/`).join("");
    return fold ? out.toLowerCase() : out;
  };
  return inside(full(src), full(dst));
}

/**
 * A whole-hour clock difference most same-size pairs share (the destination's time minus the
 * source's), or 0. Needs at least 3 such pairs, more than match without one, and half of them.
 */
export function detectOffset(pairs: [MFile, MFile][], toleranceMs: number): number {
  const deltas: number[] = [];
  for (const [s, d] of pairs) if (s.size === d.size && s.mtime != null && d.mtime != null) deltas.push(d.mtime - s.mtime);
  if (deltas.length < 3) return 0;
  const near = (x: number, h: number) => Math.abs(x - h * HOUR) <= toleranceMs;
  const atZero = deltas.filter((x) => near(x, 0)).length;
  let best = 0;
  let bestCount = 0;
  for (let h = -14; h <= 14; h++) {
    if (h === 0) continue;
    const c = deltas.filter((x) => near(x, h)).length;
    if (c > bestCount) [best, bestCount] = [h, c];
  }
  return bestCount >= 3 && bestCount > atZero && bestCount * 2 >= deltas.length ? best * HOUR : 0;
}

/** Whether the destination's copy `d` is out of date against the source's `s`, and why. */
export function compareFiles(s: MFile, d: MFile, o: PlanOptions, offsetMs = 0): { changed: boolean; note?: string; byHash?: boolean } {
  if (s.size !== d.size) return { changed: true, note: "another size" };
  if (o.compare === "checksum" && s.md5 && d.md5) return s.md5.toLowerCase() === d.md5.toLowerCase() ? { changed: false, byHash: true } : { changed: true, note: "different content", byHash: true };
  if (o.compare === "size" || s.mtime == null || d.mtime == null) return { changed: false };
  return s.mtime - (d.mtime - offsetMs) > o.toleranceMs ? { changed: true, note: "newer here" } : { changed: false };
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const parentOf = (rel: string) => rel.replace(/\/$/, "").replace(/[^/]*$/, "");
const depth = (rel: string) => rel.replace(/\/$/, "").split("/").length;

export function planMirror(src: Listing, dst: Listing, o: PlanOptions): MirrorPlan {
  const out: MirrorPlan = { upload: [], mkdirs: [], remove: [], removeDirs: [], kept: [], blocked: [], unchanged: [], links: [], same: 0, sameBytes: 0, uploadBytes: 0, removeBytes: 0, excluded: src.excluded + dst.excluded, offsetMs: 0, checksummed: 0 };

  const ci = !!o.caseInsensitive;
  const fold = (rel: string) => (ci ? rel.toLowerCase() : rel);

  // links: never followed, so nothing at or below a link's name is copied or deleted on either
  // side (SFTP resolves a path through a link on the server: deleting "uploads/a.jpg" under a
  // linked "uploads" would delete the real file wherever the link points)
  const linkNames = new Map<string, "source" | "destination">();
  for (const [side, l] of [["source", src.links], ["destination", dst.links]] as const) for (const rel of l ?? []) linkNames.set(fold(rel.replace(/\/$/, "")), side);
  for (const [name, side] of linkNames) out.links.push({ rel: name, size: 0, why: "kept", note: `a link at the ${side}: left alone` });
  const linkOf = (rel: string): "source" | "destination" | undefined => {
    if (!linkNames.size) return undefined;
    const parts = fold(rel.replace(/\/$/, "")).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const side = linkNames.get(parts.slice(0, i).join("/"));
      if (side) return side;
    }
    return undefined;
  };
  const underLink = (rel: string, sideOf: MFile | null) => {
    const side = linkOf(rel);
    if (side && sideOf) out.links.push({ rel, size: sideOf.size, why: "kept", note: `behind a link at the ${side}: left alone` });
    return !!side;
  };
  // the destination's names as it tells them apart
  const dstFiles = new Map<string, MFile>();
  for (const [rel, d] of dst.files) if (!dstFiles.has(fold(rel))) dstFiles.set(fold(rel), d);
  const dstDirs = new Set([...dst.dirs].map(fold));
  const dstFile = (rel: string) => dst.files.get(rel) ?? dstFiles.get(fold(rel));

  // a name that is a file on one side and a folder on the other: neither can replace the other
  const blockedDirs: string[] = [];
  for (const rel of src.files.keys()) if (dstDirs.has(fold(`${rel}/`))) out.blocked.push({ rel, size: src.files.get(rel)!.size, why: "blocked", note: "a folder of this name is at the destination" });
  for (const dir of src.dirs) {
    const name = dir.slice(0, -1);
    if (dstFiles.has(fold(name))) {
      out.blocked.push({ rel: dir, size: 0, why: "blocked", note: "a file of this name is at the destination" });
      blockedDirs.push(dir);
    }
  }
  // two source files whose names differ only in case would land on one file there: the first in
  // path order is mirrored, the others can't be
  if (ci) {
    const seen = new Set<string>();
    for (const rel of [...src.files.keys()].sort(byPath)) {
      if (seen.has(fold(rel))) out.blocked.push({ rel, size: src.files.get(rel)!.size, why: "blocked", note: "another file here differs only in letter case, and the destination can't keep both" });
      else seen.add(fold(rel));
    }
  }
  const blockedSet = new Set(out.blocked.map((b) => b.rel));
  const isBlocked = (rel: string) => blockedSet.has(rel) || blockedDirs.some((d) => rel.startsWith(d));

  const pairs: [MFile, MFile][] = [];
  for (const [rel, s] of src.files) {
    const d = dstFile(rel);
    if (d) pairs.push([s, d]);
  }
  out.offsetMs = o.compare === "time" && o.toleranceMs < HOUR ? detectOffset(pairs, o.toleranceMs) : 0;

  for (const [rel, s] of src.files) {
    if (isBlocked(rel) || underLink(rel, s)) continue;
    const d = dstFile(rel);
    if (!d) {
      out.upload.push({ rel, size: s.size, why: "new", file: s });
      out.uploadBytes += s.size;
      continue;
    }
    const c = compareFiles(s, d, o, out.offsetMs);
    if (c.byHash) out.checksummed++;
    if (c.changed) {
      out.upload.push({ rel, size: s.size, why: "changed", note: c.note, file: s });
      out.uploadBytes += s.size;
    } else {
      out.unchanged.push({ rel, size: s.size, why: "same", note: c.byHash ? "same checksum" : undefined });
      out.same++;
      out.sameBytes += s.size;
    }
  }
  for (const dir of src.dirs) if (!dstDirs.has(fold(dir)) && !isBlocked(dir) && !linkOf(dir)) out.mkdirs.push(dir);

  // at the destination only. A name that differs from a source file's only in letter case is
  // kept: where case doesn't count it is the file just copied, and deleting it would lose that
  const folded = new Set([...src.files.keys(), ...src.dirs].map((r) => r.toLowerCase()));
  for (const [rel, d] of dst.files) {
    if (src.files.has(rel) || src.dirs.has(`${rel}/`)) continue;
    if (underLink(rel, d)) continue;
    if (folded.has(rel.toLowerCase())) {
      out.kept.push({ rel, size: d.size, why: "kept", note: "differs from a source file only in letter case" });
    } else if (o.deleteExtra) {
      out.remove.push({ rel, size: d.size, why: "gone", file: d });
      out.removeBytes += d.size;
    } else out.kept.push({ rel, size: d.size, why: "kept" });
  }
  if (o.deleteExtra) for (const dir of dst.dirs) if (!src.dirs.has(dir) && !src.files.has(dir.slice(0, -1)) && !folded.has(dir.toLowerCase()) && !linkOf(dir)) out.removeDirs.push(dir);

  out.upload.sort((a, b) => byPath(a.rel, b.rel));
  out.remove.sort((a, b) => byPath(a.rel, b.rel));
  out.kept.sort((a, b) => byPath(a.rel, b.rel));
  out.unchanged.sort((a, b) => byPath(a.rel, b.rel));
  out.links.sort((a, b) => byPath(a.rel, b.rel));
  out.mkdirs.sort((a, b) => depth(a) - depth(b) || byPath(a, b));
  out.removeDirs.sort((a, b) => depth(b) - depth(a) || byPath(a, b));
  return out;
}

/** Nothing to copy or delete. */
export const planIsEmpty = (p: MirrorPlan) => !p.upload.length && !p.mkdirs.length && !p.remove.length && !p.removeDirs.length;

export type FolderGroup = { dir: string; items: Change[]; bytes: number };

/** Changes grouped by the folder they are in ("" for the top), folders in path order. */
export function groupByFolder(items: Change[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const c of items) {
    const dir = parentOf(c.rel);
    let g = groups.get(dir);
    if (!g) groups.set(dir, (g = { dir, items: [], bytes: 0 }));
    g.items.push(c);
    g.bytes += c.size;
  }
  return [...groups.values()].sort((a, b) => byPath(a.dir, b.dir));
}
