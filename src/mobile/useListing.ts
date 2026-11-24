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
import { isNetworkError } from "./net";

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
  /** the last refresh failed: the list on screen may be out of date until one works */
  const [refreshError, setRefreshError] = useState<string | null>(null);
  /** the last "load more" / "load all" failed (a later page working clears it, not a refresh's) */
  const [pageError, setPageError] = useState<string | null>(null);
  const error = refreshError ?? pageError;
  /**
   * A page that arrived proves the storage answers: a refresh that failed for the network is
   * over (the pill and auto-paging come back). Any other refresh failure stays on the banner.
   */
  const pageCame = useCallback(() => {
    setPageError(null);
    setRefreshError((e) => (e && isNetworkError(e) ? null : e));
  }, []);
  /** "load every page" for sorting: how many items so far, null when not running */
  const [loadingAll, setLoadingAll] = useState<number | null>(null);
  const cache = useRef(new Map<string, Cached>());
  const reqId = useRef(0);
  const cur = useRef<Loc | null>(null);
  const listingRef = useRef(listing);
  /** bumped by stopAll, a refresh and leaving, so a "load all" still waiting or paging stops */
  const allToken = useRef(0);
  /** a "load all" is running (or waiting for a refresh): "load more" and it never run together */
  const allRunning = useRef(false);
  const endAll = useCallback(() => {
    allToken.current++;
    allRunning.current = false;
    setLoadingAll(null);
  }, []);

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

  /** the refresh in flight: "load more" and "load all" wait for it rather than cancel it */
  const refreshRun = useRef<Promise<void> | null>(null);

  const reloadNow = useCallback(
    async (opts: { quiet?: boolean }) => {
      const l = cur.current;
      if (!l) return;
      const id = ++reqId.current;
      const had = listingRef.current;
      const quiet = opts.quiet ?? had.pages > 0;
      // a "load all" stops (it reads on from the list this brings, if the sort still wants it)
      endAll();
      if (quiet) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetchPages(l, Math.max(1, had.pages), id);
        if (!res) return;
        settle(l, true);
        setRefreshError(null);
        setPageError(null);
        setListing(res);
      } catch (e) {
        if (id !== reqId.current) return;
        settle(l, false);
        setRefreshError(errMessage(e));
        // a failed quiet refresh keeps what is on screen; the banner says what went wrong
        // and a failed first load shows nothing, but is not remembered as an empty folder
        if (!quiet) {
          listingRef.current = EMPTY;
          setListingState(EMPTY);
          cache.current.delete(locKey(l));
        }
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fetchPages, settle, setListing, endAll],
  );

  /** Re-reads the folder on screen, keeping as many pages as are loaded. */
  const reload = useCallback(
    (opts: { quiet?: boolean } = {}): Promise<void> => {
      const run = reloadNow(opts);
      refreshRun.current = run;
      void run.finally(() => {
        if (refreshRun.current === run) refreshRun.current = null;
      });
      return run;
    },
    [reloadNow],
  );

  /** Waits for a refresh in flight; false when the folder changed meanwhile. */
  const afterRefresh = useCallback(async (l: Loc) => {
    while (refreshRun.current) await refreshRun.current;
    return cur.current === l;
  }, []);

  /**
   * Shows a folder: from the cache when it was visited lately (then refreshed quietly if it is
   * a little older), else loaded fresh. Returns the scroll position to restore, if any.
   */
  const open = useCallback(
    (l: Loc | null): number => {
      cur.current = l;
      setRefreshError(null);
      setPageError(null);
      endAll();
      if (!l) {
        reqId.current++;
        listingRef.current = EMPTY;
        setListingState(EMPTY);
        setLoading(false);
        setRefreshing(false);
        return 0;
      }
      const hit = cache.current.get(locKey(l));
      // (a listing with no page read is nothing to show: load it)
      if (hit && hit.listing.pages > 0) {
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
    [reload, endAll],
  );

  /** The next page, when the end of the list comes into view. */
  const more = useRef(false);
  /** "load more" asked while a refresh runs: it waits, and says so (the footer's spinner) */
  const [moreWaiting, setMoreWaiting] = useState(false);
  const loadMore = useCallback(async () => {
    const l = cur.current;
    if (!l || !listingRef.current.next || loading || more.current || allRunning.current) return;
    more.current = true;
    try {
      // a refresh in flight (after a delete, an upload) finishes first: cancelling it would leave
      // the old list on screen with the next page added to it, and its progress bar up
      if (refreshRun.current) {
        setMoreWaiting(true);
        try {
          if (!(await afterRefresh(l))) return;
        } finally {
          setMoreWaiting(false);
        }
      }
      if (allRunning.current) return;
      const had = listingRef.current;
      if (!had.next) return;
      const id = ++reqId.current;
      setLoading(true);
      try {
        const res = await api.listObjects(l.profileId, l.bucket, l.prefix, had.next);
        if (id !== reqId.current) return;
        pageCame();
        setListing({
          folders: [...had.folders, ...res.folders],
          objects: [...had.objects, ...res.objects],
          next: res.nextToken,
          pages: had.pages + 1,
        });
      } catch (e) {
        if (id === reqId.current) setPageError(errMessage(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    } finally {
      more.current = false;
    }
  }, [loading, afterRefresh, setListing, pageCame]);

  /** Every remaining page, for sorting the whole folder. `stopAll` (or leaving) stops it. */
  const loadAll = useCallback(async () => {
    const l = cur.current;
    // a page being loaded (or waiting to) finishes first; the sort asks again once it has
    if (!l || !listingRef.current.next || more.current) return;
    const token = ++allToken.current;
    allRunning.current = true;
    setLoadingAll(listingRef.current.folders.length + listingRef.current.objects.length);
    try {
      // after a refresh in flight, from the list it brings (see loadMore)
      if (!(await afterRefresh(l)) || token !== allToken.current) return;
      let acc = listingRef.current;
      if (!acc.next) return;
      const id = ++reqId.current;
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
        // every page came: an earlier page's failure is over (a failed refresh's only when the
        // network was its cause)
        pageCame();
      } catch (e) {
        if (id === reqId.current) setPageError(errMessage(e));
      } finally {
        if (id === reqId.current) setListing(acc);
      }
    } finally {
      // however it ended, unless a newer "load all" took over: the note with Stop goes
      if (token === allToken.current) {
        allRunning.current = false;
        setLoadingAll(null);
      }
    }
  }, [afterRefresh, setListing, pageCame]);

  const stopAll = useCallback(() => {
    endAll();
    // a refresh in flight runs on (it isn't what Stop is for)
    if (refreshRun.current) return;
    reqId.current++;
    setLoading(false);
  }, [endAll]);

  /** Remembers where the list was scrolled, for coming back to it. */
  const saveScroll = useCallback((l: Loc, top: number) => {
    const hit = cache.current.get(locKey(l));
    if (hit) hit.scroll = top;
  }, []);

  /** Where the folder was last scrolled to (0 when not known). */
  const scrollOf = useCallback((l: Loc) => cache.current.get(locKey(l))?.scroll ?? 0, []);

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

  return { listing, loading, refreshing, error, refreshError, pageError, loadingAll, moreWaiting, open, reload, loadMore, loadAll, stopAll, saveScroll, scrollOf, forget };
}
