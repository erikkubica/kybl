/**
 * What a pane's list shows: the folder listing (or the deep-search results), filtered by the
 * text in the search field and sorted. Rows only ever show for the place they were listed for,
 * except the previous place's, dimmed and inert, while the next one loads (`stale`).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { baseName } from "../format";
import type { Sort } from "../components/FileTable";
import type { Entry } from "../types";
import { sameLoc, useListing, type Loc } from "./useListing";
import { useSearch } from "./useSearch";

/**
 * Folders up to this many items are loaded whole in the background, so the list is in its final
 * order (S3's byte order differs from ours, and later pages would otherwise slot in above what
 * you are reading). About ten requests; bigger folders load further as you scroll.
 */
const AUTO_ALL = 10_000;
/** Sorting by anything but name needs the whole folder; stop pulling pages past this many objects. */
export const MAX_SORT_ITEMS = 200_000;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const NO_ENTRIES: Entry[] = [];

const folderEntry = (f: string): Entry => ({ kind: "folder", key: f, name: baseName(f), size: 0, modified: null });

export function useEntries(here: Loc | null, sort: Sort, foldersFirst: boolean, onError: (msg: string) => void) {
  const [query, setQuery] = useState("");
  const sr = useSearch(onError);
  const search = sr.search && sameLoc(sr.search.loc, here) ? sr.search : null;

  const needsAll = !search && (sort.key !== "name" || sort.dir !== "asc");
  const lst = useListing(needsAll ? MAX_SORT_ITEMS : AUTO_ALL);
  const { listing } = lst;
  const fresh = sameLoc(listing.loc, here);
  const stale = !search && !fresh && lst.loading && !!listing.loc && !!here;

  const filter = !search ? query.trim().toLowerCase() : "";
  const allEntries: Entry[] = useMemo(() => {
    if (search) {
      // folders whose own name matches: every object below such a folder matched too (the search
      // looks at the whole path), so they can be read off the results
      const needle = search.query.toLowerCase();
      const base = search.loc.prefix;
      const folders = new Set<string>();
      for (const o of search.results) {
        const parts = o.key.slice(base.length).split("/");
        let acc = base;
        for (let i = 0; i < parts.length - 1; i++) {
          acc += `${parts[i]}/`;
          if (parts[i].toLowerCase().includes(needle)) folders.add(acc);
        }
      }
      return [
        ...[...folders].map(folderEntry),
        ...search.results.map<Entry>((o) => ({ kind: "file", key: o.key, name: baseName(o.key), size: o.size, modified: o.modified, etag: o.etag, storageClass: o.storageClass })),
      ];
    }
    if (!fresh && !stale) return [];
    return [
      ...listing.folders.map(folderEntry),
      ...listing.objects.map<Entry>((o) => ({ kind: "file", key: o.key, name: baseName(o.key), size: o.size, modified: o.modified, etag: o.etag, storageClass: o.storageClass })),
    ];
  }, [listing, search, fresh, stale]);

  /** What the list shows. */
  const listEntries: Entry[] = useMemo(() => {
    const list = filter ? allEntries.filter((e) => e.name.toLowerCase().includes(filter)) : allEntries.slice();
    const dir = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: Entry, b: Entry): number => {
      switch (sort.key) {
        case "size":
          return (a.size - b.size) * dir;
        case "modified":
          return ((a.modified ?? 0) - (b.modified ?? 0)) * dir;
        case "kind": {
          const ka = a.kind === "folder" ? "" : a.name.split(".").pop() ?? "";
          const kb = b.kind === "folder" ? "" : b.name.split(".").pop() ?? "";
          return byName.compare(ka, kb) * dir || byName.compare(a.name, b.name);
        }
        default:
          return byName.compare(a.name, b.name) * dir;
      }
    };
    return list.sort((a, b) => {
      if (foldersFirst && a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return cmp(a, b);
    });
  }, [allEntries, filter, sort, foldersFirst]);
  /** What can be selected and acted on: never the rows of the place you just left. */
  const entries = stale ? NO_ENTRIES : listEntries;

  const loadedCount = lst.count;
  const sortCapped = needsAll && !!listing.next && loadedCount >= MAX_SORT_ITEMS;
  // folders bigger than AUTO_ALL in name order: the rest loads as you scroll
  const hasMore = !search && fresh && !!listing.next && !lst.pulling && !needsAll;
  const listLoading = useRef(false);
  listLoading.current = lst.loading;
  const listLoadMore = lst.loadMore;
  const loadMore = useCallback(() => {
    if (!listLoading.current) void listLoadMore();
  }, [listLoadMore]);

  const folderKeys = useMemo(() => new Set(fresh ? listing.folders : []), [fresh, listing.folders]);

  /** Reloads what is on screen: the search when searching, else the folder (keeping rows meanwhile). */
  const refresh = useCallback(() => {
    if (!here) return;
    if (search) void sr.run(search.loc, search.query);
    else void lst.refresh(here);
  }, [here, search, sr, lst]);

  return {
    lst,
    listing,
    sr,
    search,
    query,
    setQuery,
    filter,
    fresh,
    stale,
    needsAll,
    allEntries,
    listEntries,
    entries,
    loadedCount,
    sortCapped,
    hasMore,
    loadMore,
    folderKeys,
    refresh,
    moreOnServer: !search && fresh && !!listing.next,
    listError: fresh ? lst.error : null,
  };
}

export type PaneEntries = ReturnType<typeof useEntries>;
