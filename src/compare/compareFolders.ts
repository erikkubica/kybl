/**
 * Compares the listings of two folders (one per pane) by name. Files count as the same when
 * their size matches and, where both sides are S3 listings with plain ETags, the ETag too;
 * otherwise the newer one is the one to copy. Folders are matched by name only: their contents are not compared (that needs
 * a recursive "compare" job, see docs/phase2-architecture.md §6.1).
 */
import type { Entry, Profile } from "../types";

/** S3 ETags of multipart uploads ("…-12") are not content hashes, so they can't be compared. */
const plainEtag = (e: Entry) => {
  const t = e.etag?.replace(/"/g, "");
  return t && !t.includes("-") ? t : null;
};
/**
 * ETags only say "same content" between two S3 listings: there a single-part upload's ETag is its
 * MD5. Elsewhere (WebDAV, Dropbox revs, Azure, GCS) it is a version tag, and Kybl Storage encrypts
 * with SSE-C, whose ETags aren't MD5s either.
 */
export function etagsComparable(a: Pick<Profile, "kind" | "provider"> | null | undefined, b: Pick<Profile, "kind" | "provider"> | null | undefined): boolean {
  const s3 = (p: typeof a) => !!p && (p.kind ?? "s3") === "s3" && p.provider !== "kybl";
  return s3(a) && s3(b);
}

/** Clocks and upload times differ a little; closer than this counts as the same time. */
const SAME_TIME_MS = 2000;

export type FolderDiff = {
  /** names on one side only */
  leftOnly: Entry[];
  rightOnly: Entry[];
  /** files on both sides that differ, where one copy is clearly newer */
  leftNewer: Entry[];
  rightNewer: Entry[];
  /** files that differ with no way to tell which is newer: [left, right] */
  differ: [Entry, Entry][];
  /** items that look the same on both sides */
  same: number;
};

/** `etags`: the two listings' ETags mean the same thing (see `etagsComparable`) */
export function compareFolders(left: Entry[], right: Entry[], { etags = false }: { etags?: boolean } = {}): FolderDiff {
  const key = (e: Entry) => `${e.kind}:${e.name}`;
  const byName = new Map(right.map((e) => [key(e), e]));
  const out: FolderDiff = { leftOnly: [], rightOnly: [], leftNewer: [], rightNewer: [], differ: [], same: 0 };
  const seen = new Set<string>();
  for (const a of left) {
    const k = key(a);
    const b = byName.get(k);
    seen.add(k);
    if (!b) {
      out.leftOnly.push(a);
      continue;
    }
    if (a.kind === "folder" || sameFile(a, b, etags)) {
      out.same++;
      continue;
    }
    const dt = (a.modified ?? 0) - (b.modified ?? 0);
    if (a.modified != null && b.modified != null && Math.abs(dt) > SAME_TIME_MS) (dt > 0 ? out.leftNewer : out.rightNewer).push(dt > 0 ? a : b);
    else out.differ.push([a, b]);
  }
  for (const b of right) if (!seen.has(key(b))) out.rightOnly.push(b);
  return out;
}

function sameFile(a: Entry, b: Entry, etags: boolean): boolean {
  if (a.size !== b.size) return false;
  const ea = etags ? plainEtag(a) : null;
  const eb = etags ? plainEtag(b) : null;
  if (ea && eb) return ea === eb;
  // same size and no comparable hash: the same unless the times are far apart
  if (a.modified == null || b.modified == null) return true;
  return Math.abs(a.modified - b.modified) <= SAME_TIME_MS;
}

/** What each side should select: what the other side is missing or has an older copy of. */
export function diffSelection(d: FolderDiff): { left: string[]; right: string[] } {
  return {
    left: [...d.leftOnly, ...d.leftNewer, ...d.differ.map(([a]) => a)].map((e) => e.key),
    right: [...d.rightOnly, ...d.rightNewer, ...d.differ.map(([, b]) => b)].map((e) => e.key),
  };
}
