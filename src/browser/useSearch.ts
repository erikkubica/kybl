/**
 * Deep search below a folder, by name or (this computer and SFTP servers) inside files. Matches
 * stream in while the backend scans (`search-progress`, `content-search-progress`), the scan can
 * be stopped, and every run has its own id so a late answer from an earlier search or another
 * folder never replaces what is on screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage } from "../api";
import type { ObjInfo } from "../types";
import type { Loc } from "./useListing";
import { devtoolsApi, type ContentHit, type ContentProgress } from "./devtoolsApi";

/** what Enter in the search field looks at: names (everywhere) or what is inside files */
export type SearchMode = "names" | "contents";

export type SearchState = {
  query: string;
  loc: Loc;
  results: ObjInfo[];
  scanned: number;
  truncated: boolean;
  running: boolean;
  /** stopped by the user before the scan finished */
  stopped: boolean;
  mode: SearchMode;
  /** contents: each file's first matching line, by key */
  hits?: Record<string, ContentHit>;
  /** contents: matching lines in all */
  matches?: number;
  /** contents: what searched ("ripgrep", "grep", "built-in") */
  engine?: string;
  /** contents: why this place can't be searched inside files */
  unavailable?: string | null;
  caseSensitive?: boolean;
  regex?: boolean;
};

type Progress = { opId: string; scanned: number; found: ObjInfo[] };

let seq = 0;

const hitObj = (h: ContentHit): ObjInfo => ({ key: h.key, size: h.size, modified: h.modified, etag: null, storageClass: null });

/**
 * `showsHidden(profileId)`: the pane shows dotfiles there, so a search inside files looks in them too.
 */
export function useSearch(onError: (msg: string) => void, showsHidden: (profileId: string) => boolean = () => false) {
  const [search, setSearch] = useState<SearchState | null>(null);
  const [mode, setModeState] = useState<SearchMode>("names");
  const [caseSensitive, setCaseState] = useState(false);
  const [regex, setRegexState] = useState(false);
  const opts = useRef({ mode, caseSensitive, regex });
  const op = useRef<string | null>(null);
  const errRef = useRef(onError);
  errRef.current = onError;
  const hiddenRef = useRef(showsHidden);
  hiddenRef.current = showsHidden;
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    const offs = [
      listen<Progress>("search-progress", (e) => {
        const p = e.payload;
        if (p.opId !== op.current) return;
        setSearch((s) => (s && s.running ? { ...s, scanned: p.scanned, results: p.found.length ? s.results.concat(p.found) : s.results } : s));
      }),
      listen<ContentProgress>("content-search-progress", (e) => {
        const p = e.payload;
        if (p.opId !== op.current) return;
        setSearch((s) => {
          if (!s || !s.running) return s;
          const hits = { ...s.hits };
          const fresh = p.hits.filter((h) => !hits[h.key]);
          for (const h of p.hits) hits[h.key] = h;
          return { ...s, hits, matches: p.matches, scanned: p.files, results: fresh.length ? s.results.concat(fresh.map(hitObj)) : s.results };
        });
      }),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()).catch(() => {}));
  }, []);

  const stopRunning = () => {
    if (op.current) api.cancelTransfer(op.current).catch(() => {});
  };

  const run = useCallback(async (loc: Loc, query: string) => {
    stopRunning();
    const id = `search-${Date.now().toString(36)}-${++seq}`;
    op.current = id;
    const { mode: m, caseSensitive: cs, regex: rx } = opts.current;
    const base: SearchState = { query, loc, results: [], scanned: 0, truncated: false, running: true, stopped: false, mode: m };
    if (m === "contents") {
      setSearch({ ...base, hits: {}, matches: 0, caseSensitive: cs, regex: rx });
      try {
        const r = await devtoolsApi.contentSearch(loc.profileId, loc.bucket, loc.prefix, query, { caseSensitive: cs, regex: rx, hidden: hiddenRef.current(loc.profileId) }, id);
        if (op.current !== id) return;
        const hits = Object.fromEntries(r.hits.map((h) => [h.key, h]));
        setSearch((s) => (s ? { ...s, results: r.hits.map(hitObj), hits, matches: r.matches, scanned: r.files, truncated: r.truncated, engine: r.engine, unavailable: r.unavailable, running: false } : s));
      } catch (e) {
        if (op.current !== id) return;
        setSearch((s) => (s ? { ...s, running: false } : s));
        errRef.current(errMessage(e));
      }
      return;
    }
    setSearch(base);
    try {
      const r = await api.searchObjects(loc.profileId, loc.bucket, loc.prefix, query, id);
      if (op.current !== id) return;
      setSearch((s) => (s ? { ...s, results: r.objects, scanned: r.scanned, truncated: r.truncated, running: false } : s));
    } catch (e) {
      if (op.current !== id) return;
      setSearch((s) => (s ? { ...s, running: false } : s));
      errRef.current(errMessage(e));
    }
  }, []);

  /** Changes what a search looks at; the search on screen runs again that way. */
  const configure = useCallback(
    (patch: Partial<{ mode: SearchMode; caseSensitive: boolean; regex: boolean }>) => {
      opts.current = { ...opts.current, ...patch };
      if (patch.mode !== undefined) setModeState(patch.mode);
      if (patch.caseSensitive !== undefined) setCaseState(patch.caseSensitive);
      if (patch.regex !== undefined) setRegexState(patch.regex);
      const s = searchRef.current;
      // the case and regex options only matter to a search inside files
      if (s && (patch.mode !== undefined ? patch.mode !== s.mode : opts.current.mode === "contents")) void run(s.loc, s.query);
    },
    [run],
  );

  /** Stops the scan and keeps what was found so far. */
  const stop = useCallback(() => {
    stopRunning();
    setSearch((s) => (s && s.running ? { ...s, stopped: true } : s));
  }, []);

  /** Leaves search mode; a scan still running is stopped and its answer ignored. */
  const clear = useCallback(() => {
    stopRunning();
    op.current = null;
    setSearch(null);
  }, []);

  return { search, run, stop, clear, mode, caseSensitive, regex, configure };
}
