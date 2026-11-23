/**
 * Lists a folder to its end for Mirror (every connection's `list_objects`, a page at a time),
 * leaving out what the exclude rules match: an excluded folder isn't opened at all.
 */
import { api } from "../api";
import type { Capabilities } from "../api";
import type { ObjInfo } from "../types";
import type { Matcher } from "./ignore";
import type { Listing, MFile } from "./plan";

/** A folder somewhere: `dir` is "" for the top of the root, else ends with "/". */
export type Place = { profileId: string; root: string; dir: string };

/** Folders listed at the same time (servers with one connection queue them anyway). */
const PARALLEL = 4;

const isMd5 = (s: string | null | undefined): s is string => !!s && /^[0-9a-f]{32}$/i.test(s);

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

export async function walk(
  at: Place,
  caps: Capabilities | null,
  excluded: Matcher,
  opts: { signal?: AbortSignal; onCount?: (files: number) => void } = {},
): Promise<Listing> {
  const out: Listing = { files: new Map(), dirs: new Set(), excluded: 0 };
  const base = at.dir;
  const queue: string[] = [base];
  let active = 0;
  let failure: unknown = null;

  const listDir = async (prefix: string) => {
    let token: string | null = null;
    do {
      if (opts.signal?.aborted) throw new Cancelled();
      const page = await api.listObjects(at.profileId, at.root, prefix, token);
      for (const f of page.folders) {
        if (!f.startsWith(base) || f === prefix) continue;
        const rel = f.slice(base.length);
        if (excluded(rel, true)) out.excluded++;
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
