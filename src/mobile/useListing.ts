/**
 * The folder on screen, page by page, plus a small cache of recently visited folders.
 *
 * - Going back up (or to a recent place) shows the cached list and scroll position at once and
 *   refreshes it quietly in the background.
 * - A refresh (after delete, rename, upload, pull-to-refresh…) fetches as many pages as were
 *   loaded and swaps the list in one go, so a long folder keeps its length and scroll position.
 * - "Newest first" / "Largest first" can load every page so the sort covers the whole folder.
 */
import { useCallback, useRef, useState } from "react";
import { api, errMessage } from "../api";
import type { ObjInfo } from "../types";

export type Loc = { profileId: string; bucket: string; prefix: string };
export type Listing = { folders: string[]; objects: ObjInfo[]; next: string | null; pages: number };

const EMPTY: Listing = { folders: [], objects: [], next: null, pages: 0 };
/** folders kept for going back */
const MAX_CACHED = 12;
/** a cached folder younger than this is shown without asking the storage again */
const FRESH_MS = 15_000;

export const locKey = (l: Loc) => `${l.profileId}|${l.bucket}|${l.prefix}`;

type Cached = { listing: Listing; scroll: number; at: number };

export function useListing(settle: (l: Loc, ok: boolean) => void) {
  const [listing, setListingState] = useState<Listing>(EMPTY);
  /** first page of a folder not seen before */
  const [loading, setLoading] = useState(false);
  /** a quiet refresh of a list already on screen */
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** "load every page" for sorting: how many items so far, null when not running */
  const [loadingAll, setLoadingAll] = useState<number | null>(null);
  const cache = useRef(new Map<string, Cached>());
  const reqId = useRef(0);
  const cur = useRef<Loc | null>(null);
  const listingRef = useRef(listing);

  const setListing = useCallback((l: Listing) => {
    listingRef.current = l;
    setListingState(l);
    const at = cur.current;
    if (!at) return;
    const k = locKey(at);
    const old = cache.current.get(k);
    cache.current.delete(k);
    cache.current.set(k, { listing: l, scroll: old?.scroll ?? 0, at: Date.now() });
    while (cache.current.size > MAX_CACHED) cache.current.delete(cache.current.keys().next().value!);
  }, []);

  /** Pages 1..`pages` (at least one), in order; null if a newer request took over. */
  const fetchPages = useCallback(async (l: Loc, pages: number, id: number): Promise<Listing | null> => {
    const folders: string[] = [];
    const objects: ObjInfo[] = [];
    let token: string | null = null;
    let n = 0;
    do {
      const res = await api.listObjects(l.profileId, l.bucket, l.prefix, token);
      if (id !== reqId.current) return null;
      folders.push(...res.folders);
      objects.push(...res.objects);
      token = res.nextToken;
      n++;
    } while (token && n < pages);
    return { folders, objects, next: token, pages: n };
  }, []);

  /** Re-reads the folder on screen, keeping as many pages as are loaded. */
  const reload = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      const l = cur.current;
      if (!l) return;
      const id = ++reqId.current;
      const had = listingRef.current;
      const quiet = opts.quiet ?? had.pages > 0;
      setLoadingAll(null);
      if (quiet) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetchPages(l, Math.max(1, had.pages), id);
        if (!res) return;
        settle(l, true);
        setError(null);
        setListing(res);
      } catch (e) {
        if (id !== reqId.current) return;
        settle(l, false);
        setError(errMessage(e));
        // a failed quiet refresh keeps what is on screen; the banner says what went wrong
        if (!quiet) setListing(EMPTY);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fetchPages, settle, setListing],
  );

  /**
   * Shows a folder: from the cache when it was visited lately (then refreshed quietly if it is
   * a little older), else loaded fresh. Returns the scroll position to restore, if any.
   */
  const open = useCallback(
    (l: Loc | null): number => {
      cur.current = l;
      setError(null);
      setLoadingAll(null);
      if (!l) {
        reqId.current++;
        listingRef.current = EMPTY;
        setListingState(EMPTY);
        setLoading(false);
        setRefreshing(false);
        return 0;
      }
      const hit = cache.current.get(locKey(l));
      if (hit) {
        listingRef.current = hit.listing;
        setListingState(hit.listing);
        reqId.current++;
        setLoading(false);
        setRefreshing(false);
        if (Date.now() - hit.at > FRESH_MS) void reload({ quiet: true });
        return hit.scroll;
      }
      listingRef.current = EMPTY;
      setListingState(EMPTY);
      void reload({ quiet: false });
      return 0;
    },
    [reload],
  );

  /** The next page, when the end of the list comes into view. */
  const loadMore = useCallback(async () => {
    const l = cur.current;
    const had = listingRef.current;
    if (!l || !had.next || loading) return;
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await api.listObjects(l.profileId, l.bucket, l.prefix, had.next);
      if (id !== reqId.current) return;
      setListing({
        folders: [...had.folders, ...res.folders],
        objects: [...had.objects, ...res.objects],
        next: res.nextToken,
        pages: had.pages + 1,
      });
    } catch (e) {
      if (id === reqId.current) setError(errMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [loading, setListing]);

  /** Every remaining page, for sorting the whole folder. `stopAll` (or leaving) stops it. */
  const loadAll = useCallback(async () => {
    const l = cur.current;
    if (!l || !listingRef.current.next) return;
    const id = ++reqId.current;
    let acc = listingRef.current;
    setLoadingAll(acc.folders.length + acc.objects.length);
    try {
      while (acc.next) {
        const res = await api.listObjects(l.profileId, l.bucket, l.prefix, acc.next);
        if (id !== reqId.current) return;
        acc = { folders: [...acc.folders, ...res.folders], objects: [...acc.objects, ...res.objects], next: res.nextToken, pages: acc.pages + 1 };
        setLoadingAll(acc.folders.length + acc.objects.length);
        // show progress in the list every few pages, not on every one (each is a full re-sort)
        if (acc.pages % 5 === 0 || !acc.next) setListing(acc);
      }
    } catch (e) {
      if (id === reqId.current) setError(errMessage(e));
    } finally {
      if (id === reqId.current) {
        setListing(acc);
        setLoadingAll(null);
      }
    }
  }, [setListing]);

  const stopAll = useCallback(() => {
    reqId.current++;
    setLoadingAll(null);
    setLoading(false);
  }, []);

  /** Remembers where the list was scrolled, for coming back to it. */
  const saveScroll = useCallback((l: Loc, top: number) => {
    const hit = cache.current.get(locKey(l));
    if (hit) hit.scroll = top;
  }, []);

  /** Drops cached folders of a bucket (after changes made there), except the one on screen. */
  const forget = useCallback((profileId: string, bucket: string) => {
    for (const k of [...cache.current.keys()]) {
      if (k.startsWith(`${profileId}|${bucket}|`) && (!cur.current || k !== locKey(cur.current))) {
        const hit = cache.current.get(k)!;
        // keep the scroll position, but make the next visit refresh
        hit.at = 0;
      }
    }
  }, []);

  return { listing, loading, refreshing, error, loadingAll, open, reload, loadMore, loadAll, stopAll, saveScroll, forget };
}
