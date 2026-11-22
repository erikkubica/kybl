/**
 * Deep search below a folder. Matches stream in while the backend scans (`search-progress`), the
 * scan can be stopped, and every run has its own id so a late answer from an earlier search or
 * another folder never replaces what is on screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage } from "../api";
import type { ObjInfo } from "../types";
import type { Loc } from "./useListing";

export type SearchState = {
  query: string;
  loc: Loc;
  results: ObjInfo[];
  scanned: number;
  truncated: boolean;
  running: boolean;
  /** stopped by the user before the scan finished */
  stopped: boolean;
};

type Progress = { opId: string; scanned: number; found: ObjInfo[] };

let seq = 0;

export function useSearch(onError: (msg: string) => void) {
  const [search, setSearch] = useState<SearchState | null>(null);
  const op = useRef<string | null>(null);
  const errRef = useRef(onError);
  errRef.current = onError;

  useEffect(() => {
    const off = listen<Progress>("search-progress", (e) => {
      const p = e.payload;
      if (p.opId !== op.current) return;
      setSearch((s) => (s && s.running ? { ...s, scanned: p.scanned, results: p.found.length ? s.results.concat(p.found) : s.results } : s));
    });
    return () => void off.then((f) => f()).catch(() => {});
  }, []);

  const stopRunning = () => {
    if (op.current) api.cancelTransfer(op.current).catch(() => {});
  };

  const run = useCallback(async (loc: Loc, query: string) => {
    stopRunning();
    const id = `search-${Date.now().toString(36)}-${++seq}`;
    op.current = id;
    setSearch({ query, loc, results: [], scanned: 0, truncated: false, running: true, stopped: false });
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

  return { search, run, stop, clear };
}
