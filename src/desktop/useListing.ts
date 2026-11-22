/**
 * The folder listing on screen. Every load is tagged with the location it is for and a request
 * id, so a slow answer for a folder or bucket you already left can never replace what is on
 * screen, and rows are always labelled with where they came from (`loc`), so App can refuse to
 * show or act on rows of another place.
 *
 * S3 lists 1,000 keys per page in byte order, which differs from the app's sort (natural order,
 * folders first). Pages that arrive later would then slot in above what you are looking at, so
 * folders are pulled in full in the background up to `limit` items, and only folders bigger than
 * that fall back to loading more as you scroll.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMessage } from "../api";
import type { ListResult, ObjInfo } from "../types";

export type Loc = { profileId: string; bucket: string; prefix: string };
export type Listing = { loc: Loc | null; folders: string[]; objects: ObjInfo[]; next: string | null };

const EMPTY: Listing = { loc: null, folders: [], objects: [], next: null };

export const sameLoc = (a: Loc | null, b: Loc | null) =>
  !!a && !!b && a.profileId === b.profileId && a.bucket === b.bucket && a.prefix === b.prefix;

export function useListing(limit: number) {
  const [listing, setListing] = useState<Listing>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  const current = useRef(listing);
  current.current = listing;

  /** Shows a new place: the old rows go at once (a skeleton shows), then the first page arrives. */
  const open = useCallback(async (loc: Loc): Promise<ListResult | null> => {
    const id = ++reqId.current;
    setListing({ ...EMPTY, loc });
    setLoading(true);
    setError(null);
    try {
      const res = await api.listObjects(loc.profileId, loc.bucket, loc.prefix, null);
      if (id !== reqId.current) return null;
      setListing({ loc, folders: res.folders, objects: res.objects, next: res.nextToken });
      return res;
    } catch (e) {
      if (id !== reqId.current) return null;
      setError(errMessage(e));
      return null;
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  /**
   * Reloads the place on screen without blanking it: pages are gathered until there are at least
   * as many items as before, then swapped in at once, so the scroll position and selection stay.
   */
  const refresh = useCallback(
    async (loc: Loc): Promise<ListResult | null> => {
      const before = current.current;
      if (!sameLoc(before.loc, loc)) return open(loc);
      const id = ++reqId.current;
      setLoading(true);
      setError(null);
      const want = Math.min(Math.max(before.folders.length + before.objects.length, 1), limit);
      const folders: string[] = [];
      const objects: ObjInfo[] = [];
      let next: string | null = null;
      let first: ListResult | null = null;
      try {
        do {
          const res = await api.listObjects(loc.profileId, loc.bucket, loc.prefix, next);
          if (id !== reqId.current) return null;
          first ??= res;
          folders.push(...res.folders);
          objects.push(...res.objects);
          next = res.nextToken;
        } while (next && folders.length + objects.length < want);
        setListing({ loc, folders, objects, next });
        return first;
      } catch (e) {
        if (id !== reqId.current) return null;
        setError(errMessage(e));
        return null;
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [open, limit],
  );

  /** The next page, appended (folders past `limit`, loaded as you scroll). */
  const loadMore = useCallback(async () => {
    const cur = current.current;
    if (!cur.loc || !cur.next) return;
    const { loc, next: token } = cur;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listObjects(loc.profileId, loc.bucket, loc.prefix, token);
      if (id !== reqId.current) return;
      setListing((prev) =>
        sameLoc(prev.loc, loc) ? { loc, folders: prev.folders.concat(res.folders), objects: prev.objects.concat(res.objects), next: res.nextToken } : prev,
      );
    } catch (e) {
      if (id === reqId.current) setError(errMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  /**
   * Pulls the remaining pages up to `limit` items. They are gathered and shown about once a
   * second instead of one by one, so a big folder is not re-sorted for every page.
   */
  const loadRest = useCallback(async (cap: number) => {
    const cur = current.current;
    if (!cur.loc || !cur.next) return;
    const loc = cur.loc;
    let next: string | null = cur.next;
    let have = cur.folders.length + cur.objects.length;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    let folders: string[] = [];
    let objects: ObjInfo[] = [];
    let last = performance.now();
    const commit = () => {
      const [f, o, n] = [folders, objects, next];
      folders = [];
      objects = [];
      setListing((prev) =>
        sameLoc(prev.loc, loc)
          ? { loc, folders: f.length ? prev.folders.concat(f) : prev.folders, objects: o.length ? prev.objects.concat(o) : prev.objects, next: n }
          : prev,
      );
      last = performance.now();
    };
    try {
      while (next && have < cap) {
        const res: ListResult = await api.listObjects(loc.profileId, loc.bucket, loc.prefix, next);
        if (id !== reqId.current) return;
        folders.push(...res.folders);
        objects.push(...res.objects);
        have += res.folders.length + res.objects.length;
        next = res.nextToken;
        if (performance.now() - last > 1000) commit();
      }
      commit();
    } catch (e) {
      if (id !== reqId.current) return;
      commit();
      setError(errMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  /** Forget the listing (no bucket on screen). Any load still running is ignored. */
  const clear = useCallback(() => {
    reqId.current++;
    setListing(EMPTY);
    setLoading(false);
    setError(null);
  }, []);

  // keep pulling pages in the background until the folder is whole or the cap is reached
  const count = listing.folders.length + listing.objects.length;
  const pulling = !!listing.loc && !!listing.next && count < limit && !error;
  useEffect(() => {
    if (pulling && !loading) loadRest(limit);
  }, [pulling, loading, limit, loadRest]);

  return { listing, loading, error, count, pulling, open, refresh, loadMore, clear };
}
