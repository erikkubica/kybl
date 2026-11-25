/**
 * What a pane's list shows: the folder listing (or the deep-search results), filtered by the
 * text in the search field and sorted. Rows only ever show for the place they were listed for,
 * except the previous place's, dimmed and inert, while the next one loads (`stale`).
 */
import { nameMatcher } from "../lib/nameMatch";
import { useCallback, useMemo, useRef, useState } from "react";
import { baseName, entryKind, extOf } from "../../core/format";
import { groupEntries, type Group } from "../lib/grouping";
import type { GroupBy } from "../../settings/settings";
import type { Sort } from "../components/list/FileTable";
import type { Entry, ObjInfo } from "../../core/types";
import { sameLoc, useListing, type Loc } from "./useListing";
import { useSearch } from "./useSearch";
import { isPlaceholderIndex, useFolderPlaceholders } from "../../thumbs/thumbhash";
import { useImageModes } from "../../thumbs/imageMode";

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
  created: o.created ?? null,
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
  /** rows in headed groups (lib/grouping.ts): the order selection and the keys follow too */
  groupBy: GroupBy = "none",
) {
  const [query, setQuery] = useState("");
  const sr = useSearch(onError, (id) => !hideDotfilesOf(id));
  const search = sr.search && sameLoc(sr.search.loc, here) ? sr.search : null;

  // groups (like any sort but A to Z by name) only hold still once the whole folder is in
  const needsAll = !search && (sort.key !== "name" || sort.dir !== "asc" || groupBy !== "none");
  const lst = useListing(needsAll ? MAX_SORT_ITEMS : AUTO_ALL);
  const { listing } = lst;
  const fresh = sameLoc(listing.loc, here);
  const stale = !search && !fresh && lst.loading && !!listing.loc && !!here;

  // typing filters the folder by name; with "Contents" chosen it waits for Enter instead
  const filter = !search && sr.mode === "names" ? (sr.regex ? query : query.trim()) : "";
  const filterHit = useMemo(() => nameMatcher(filter, sr.caseSensitive, sr.regex), [filter, sr.caseSensitive, sr.regex]);
  const allEntries: Entry[] = useMemo(() => {
    if (search) {
      // folders whose own name matches: every object below such a folder matched too (the search
      // looks at the whole path), so they can be read off the results
      const hit = nameMatcher(search.query, !!search.caseSensitive, !!search.regex);
      const base = search.loc.prefix;
      const folders = new Set<string>();
      const results = search.results.filter((o) => !isPlaceholderIndex(o.key));
      // inside files: just the files
      if (search.mode === "names") for (const o of results) {
        const parts = o.key.slice(base.length).split("/");
        let acc = base;
        for (let i = 0; i < parts.length - 1; i++) {
          acc += `${parts[i]}/`;
          if (hit(parts[i])) folders.add(acc);
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

  /** What the list shows, in its groups when grouping. */
  const grouped = useMemo(() => {
    const list = filter ? allEntries.filter((e) => filterHit(e.name)) : allEntries.slice();
    const dir = sort.dir === "asc" ? 1 : -1;
    // by what the Kind column says ("File" for README and dotfiles, "JavaScript" for .js and .mjs), worked out once each
    const kinds = sort.key === "kind" ? new Map(list.map((e) => [e, e.kind === "folder" ? "" : entryKind(e)])) : null;
    const cmp = (a: Entry, b: Entry): number => {
      switch (sort.key) {
        case "size":
          return (a.size - b.size) * dir;
        case "modified":
          return ((a.modified ?? 0) - (b.modified ?? 0)) * dir;
        case "created":
          return ((a.created ?? 0) - (b.created ?? 0)) * dir || byName.compare(a.name, b.name);
        case "type":
          return byName.compare(a.kind === "folder" ? "" : extOf(a.name), b.kind === "folder" ? "" : extOf(b.name)) * dir || byName.compare(a.name, b.name);
        case "kind":
          return byName.compare(kinds!.get(a)!, kinds!.get(b)!) * dir || byName.compare(a.name, b.name);
        default:
          return byName.compare(a.name, b.name) * dir;
      }
    };
    list.sort((a, b) => {
      if (foldersFirst && a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return cmp(a, b);
    });
    return groupEntries(list, groupBy, sort);
  }, [allEntries, filter, filterHit, sort, foldersFirst, groupBy]);
  const listEntries = grouped.entries;
  /** the headed groups the rows fall in, or null when not grouping */
  const groups: Group[] | null = grouped.groups;
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
  /**
   * Every key in the folder on screen, once all of it is loaded (else null): a paste or upload
   * into this folder checks its name clashes against it at once, as FileZilla does, instead of
   * asking the server about each name. Only rows a real load read from the server count (`at`
   * says when; the caller also wants them young): a listing restored from a workspace is no proof
   * until its refresh succeeded.
   */
  const loadedAt = lst.loadedAt;
  const shownKeys = useMemo(
    () => (fresh && !listing.next && listing.loc && loadedAt != null ? { loc: listing.loc, at: loadedAt, keys: new Set([...listing.folders, ...listing.objects.map((o) => o.key)]) } : null),
    [fresh, listing.next, listing.loc, listing.folders, listing.objects, loadedAt],
  );

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
    groups,
    entries,
    loadedCount,
    sortCapped,
    hasMore,
    loadMore,
    folderKeys,
    shownKeys,
    refresh,
    leaveSearch,
    /** more pages are still being pulled in the background (not just waiting for a scroll) */
    pulling: lst.pulling,
    moreOnServer: !search && fresh && !!listing.next,
    listError: fresh ? lst.error : null,
  };
}

export type PaneEntries = ReturnType<typeof useEntries>;
