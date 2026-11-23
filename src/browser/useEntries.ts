/**
 * What a pane's list shows: the folder listing (or the deep-search results), filtered by the
 * text in the search field and sorted. Rows only ever show for the place they were listed for,
 * except the previous place's, dimmed and inert, while the next one loads (`stale`).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { baseName } from "../format";
import type { Sort } from "../components/FileTable";
import type { Entry, ObjInfo } from "../types";
import { sameLoc, useListing, type Loc } from "./useListing";
import { useSearch } from "./useSearch";
import { isPlaceholderIndex, useFolderPlaceholders } from "../thumbhash";
import { useImageModes } from "../imageMode";

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

const folderEntry = (f: string, info?: ObjInfo): Entry => ({
  kind: "folder",
  key: f,
  name: baseName(f),
  size: 0,
  modified: info?.modified ?? null,
  ...(info && { mode: info.mode, owner: info.owner, group: info.group, link: info.link }),
});
/** A listed file as a row (servers' permissions and link targets included when they say). */
const fileEntry = (o: ObjInfo): Entry => ({
  kind: "file",
  key: o.key,
  name: baseName(o.key),
  size: o.size,
  modified: o.modified,
  etag: o.etag,
  storageClass: o.storageClass,
  native: o.native,
  mime: o.mime,
  id: o.id,
  ...(o.mode !== undefined && { mode: o.mode, owner: o.owner, group: o.group }),
  ...(o.link !== undefined && { link: o.link }),
});

/** A name (or any folder on the way to it) that starts with ".": hidden, like Finder does. */
const dotted = (rel: string) => rel.startsWith(".") || rel.includes("/.");

export function useEntries(
  here: Loc | null,
  sort: Sort,
  foldersFirst: boolean,
  onError: (msg: string) => void,
  /**
   * leave out dotfiles of a connection's listing (this computer's disk, unless "Show hidden
   * files" is on). Asked per listing: while another place loads, the old one stays on screen,
   * greyed, and keeps its own rule
   */
  hideDotfilesOf: (profileId: string) => boolean = () => false,
) {
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
      const results = search.results.filter((o) => !isPlaceholderIndex(o.key));
      for (const o of results) {
        const parts = o.key.slice(base.length).split("/");
        let acc = base;
        for (let i = 0; i < parts.length - 1; i++) {
          acc += `${parts[i]}/`;
          if (parts[i].toLowerCase().includes(needle)) folders.add(acc);
        }
      }
      const found = [
        ...[...folders].map((f) => folderEntry(f)),
        ...results.map(fileEntry),
      ];
      return hideDotfilesOf(search.loc.profileId) ? found.filter((e) => !dotted(e.key.slice(base.length))) : found;
    }
    if (!fresh && !stale) return [];
    const info = listing.folderInfo?.length ? new Map(listing.folderInfo.map((i) => [i.key, i])) : null;
    const all = [
      // a folder's shared photo placeholders (.kybl/) are Kybl's, never shown
      ...listing.folders.filter((f) => !isPlaceholderIndex(f)).map((f) => folderEntry(f, info?.get(f))),
      ...listing.objects.map(fileEntry),
    ];
    return listing.loc && hideDotfilesOf(listing.loc.profileId) ? all.filter((e) => !e.name.startsWith(".")) : all;
  }, [listing, search, fresh, stale, hideDotfilesOf]);

  // the folder's shared photo placeholders follow its whole listing (never the filtered one)
  const imageModes = useImageModes();
  useFolderPlaceholders(!search && fresh ? here : null, allEntries, !listing.next, imageModes);

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

  // read by refresh, so leaving search takes effect before the next render
  const searchRef = useRef(search);
  searchRef.current = search;
  /** Reloads what is on screen: the search when searching, else the folder (keeping rows meanwhile). */
  const refresh = useCallback(() => {
    if (!here) return;
    const s = searchRef.current;
    if (s) void sr.run(s.loc, s.query);
    else void lst.refresh(here);
  }, [here, sr, lst]);
  /** Back from search results (or a filter) to the plain folder. */
  const leaveSearch = useCallback(() => {
    searchRef.current = null;
    sr.clear();
    setQuery("");
  }, [sr]);

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
    leaveSearch,
    moreOnServer: !search && fresh && !!listing.next,
    listError: fresh ? lst.error : null,
  };
}

export type PaneEntries = ReturnType<typeof useEntries>;
