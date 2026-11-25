/**
 * Lists a folder to its end for Mirror, a page at a time through any `list` (every connection's
 * `list_objects`), leaving out what the exclude rules match: an excluded folder isn't opened at
 * all. Links (SFTP folder links, links on this computer) are never gone into, copied or deleted:
 * they are noted in `links`, like the job engine's planner does, so a mirror's deletions stay
 * inside the mirrored folder. Pure (type imports only), so `node --test` runs it.
 */
import type { Capabilities } from "../../core/api";
import type { ListResult, ObjInfo } from "../../core/types";
import type { Matcher } from "./ignore";
import type { Listing, MFile } from "./plan";

/** A folder somewhere: `dir` is "" for the top of the root, else ends with "/". */
export type Place = { profileId: string; root: string; dir: string };

/** One page of a folder (`token` null for the first). */
export type Lister = (prefix: string, token: string | null) => Promise<ListResult>;

/** Folders listed at the same time (servers with one connection queue them anyway). */
const PARALLEL = 4;

const isMd5 = (s: string | null | undefined): s is string => !!s && /^[0-9a-f]{32}$/i.test(s);
const isLink = (o: ObjInfo) => o.link !== undefined && o.link !== null;

/** The MD5 a listing gives for a file: a provider hash, or an S3 ETag where single uploads' are MD5s. */
export function listedMd5(o: ObjInfo, caps: Capabilities | null): string | null {
  if (isMd5(o.hashes?.md5)) return o.hashes!.md5!.toLowerCase();
  const tag = o.etag?.replace(/"/g, "");
  return caps?.hashes.includes("md5") && isMd5(tag) ? tag.toLowerCase() : null;
}

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export async function walkWith(
  list: Lister,
  at: Place,
  caps: Capabilities | null,
  excluded: Matcher,
  opts: { signal?: AbortSignal; onCount?: (files: number) => void } = {},
): Promise<Listing> {
  const links = new Set<string>();
  const out: Listing = { files: new Map(), dirs: new Set(), excluded: 0, links };
  const base = at.dir;
  const queue: string[] = [base];
  let active = 0;
  let failure: unknown = null;

  const listDir = async (prefix: string) => {
    let token: string | null = null;
    do {
      if (opts.signal?.aborted) throw new Cancelled();
      const page: ListResult = await list(prefix, token);
      // folders that are links: what's behind them isn't this folder's (it may be anywhere)
      const linked = new Set((page.folderInfo ?? []).filter(isLink).map((i) => i.key));
      for (const f of page.folders) {
        if (!f.startsWith(base) || f === prefix) continue;
        const rel = f.slice(base.length);
        if (excluded(rel, true)) out.excluded++;
        else if (linked.has(f)) links.add(rel);
        else if (!out.dirs.has(rel)) {
          out.dirs.add(rel);
          queue.push(f);
        }
      }
      for (const o of page.objects) {
        // folder markers, and Google Docs and the like (no bytes to copy)
        if (o.key.endsWith("/") || !o.key.startsWith(base) || o.native) continue;
        const rel = o.key.slice(base.length);
        if (excluded(rel, false)) {
          out.excluded++;
          continue;
        }
        if (isLink(o)) {
          links.add(rel);
          continue;
        }
        const file: MFile = { size: o.size, mtime: o.modified, md5: listedMd5(o, caps), key: o.key };
        out.files.set(rel, file);
      }
      opts.onCount?.(out.files.size);
      token = page.nextToken;
    } while (token);
  };

  await new Promise<void>((done, fail) => {
    const pump = () => {
      if (failure) return;
      if (!queue.length && !active) return done();
      while (active < PARALLEL && queue.length) {
        const dir = queue.shift()!;
        active++;
        listDir(dir).then(
          () => {
            active--;
            pump();
          },
          (e) => {
            failure = e;
            fail(e);
          },
        );
      }
    };
    pump();
  });
  return out;
}

/**
 * Whether the folder `at.dir` is really not there: its parent listed to the end (every page)
 * without it. Anything short of that (the parent can't be listed either) is an unknown, never
 * "missing": a destination taken for empty would be copied over in full.
 */
export async function folderMissing(list: Lister, at: Place, signal?: AbortSignal): Promise<boolean> {
  if (!at.dir) return false;
  const parent = at.dir.replace(/[^/]+\/$/, "");
  const asFile = at.dir.slice(0, -1);
  let token: string | null = null;
  do {
    if (signal?.aborted) throw new Cancelled();
    let page: ListResult;
    try {
      page = await list(parent, token);
    } catch {
      return false;
    }
    if (page.folders.includes(at.dir)) return false;
    // a store showing it as a file-like entry (a link on this computer) has it too
    if (page.objects.some((o) => o.key === at.dir || o.key === asFile)) return false;
    token = page.nextToken;
  } while (token);
  return true;
}
