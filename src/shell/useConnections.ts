/**
 * The connections in the sidebar: the saved profiles, which ones are folded open, their bucket
 * lists and the buckets someone chose to hide. Panes only read these; opening a place in a pane
 * goes through the shell.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMessage, errSummary } from "../api";
import { KYBL, isRevokedKey } from "../kybl";
import { LS } from "../browser/types";
import type { BucketList } from "../components/Sidebar";
import type { Profile } from "../types";
import { setConnectionNames, setRootNames, useRootName, usesListRoots } from "../connections/roots";
import { watchConn } from "../connLog";

const EXPANDED_KEY = "s3b.expanded";
export function loadExpanded(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Buckets left out of the sidebar, per connection (all are shown until someone hides one). */
const HIDDEN_KEY = "s3b.hiddenBuckets";
function loadHidden(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function useConnections() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // bucket lists of every connection opened in the sidebar; several can be expanded at once
  const [bucketsBy, setBucketsBy] = useState<Record<string, BucketList>>({});
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [hiddenBuckets, setHiddenBuckets] = useState<Record<string, string[]>>(loadHidden);
  /** What to call a root (bucket) on screen: names of roots whose id isn't one (paths, drive ids, a server's ""). */
  const rootLabel = useRootName();
  useEffect(() => setConnectionNames(profiles), [profiles]);

  const setBucketHidden = useCallback((p: Profile, name: string, hide: boolean) => {
    setHiddenBuckets((cur) => {
      const list = (cur[p.id] ?? []).filter((b) => b !== name);
      const next = { ...cur, [p.id]: hide ? [...list, name] : list };
      if (!next[p.id].length) delete next[p.id];
      LS.set(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const setExpandedSaved = useCallback((fn: (cur: Set<string>) => Set<string>) => {
    setExpanded((cur) => {
      const next = fn(cur);
      LS.set(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);
  /** Folds a connection open in the sidebar (if it isn't already). */
  const expand = useCallback((id: string) => setExpandedSaved((cur) => (cur.has(id) ? cur : new Set(cur).add(id))), [setExpandedSaved]);

  const bucketsRef = useRef(bucketsBy);
  bucketsRef.current = bucketsBy;
  /** Fetches a connection's bucket list into the sidebar (again, when `force`). */
  const loadBuckets = useCallback(async (p: Profile, force = false): Promise<string[]> => {
    const have = bucketsRef.current[p.id];
    if (have && !have.loading && !force) return have.names;
    setBucketsBy((m) => ({ ...m, [p.id]: { names: m[p.id]?.names ?? [], note: null, loading: true } }));
    let names: string[] = [];
    let note: string | null = null;
    let error: string | null = null;
    let reconnect = false;
    try {
      if (usesListRoots(p)) {
        // other kinds name their roots ("Home" for /Users/me): the id stays what commands take
        const roots = await watchConn(p.id, null, () => api.listRoots(p.id));
        names = roots.map((r) => r.id);
        setRootNames(p.id, roots);
      } else names = (await watchConn(p.id, null, () => api.listBuckets(p.id))).map((b) => b.name);
    } catch (e) {
      const msg = errMessage(e);
      error = msg;
      reconnect = p.provider === KYBL && isRevokedKey(msg);
      note = reconnect
        ? "This computer's key was revoked, or the account was deleted."
        : /access denied|not allowed/i.test(msg)
          ? "This key can't list buckets. Open a bucket by name."
          : errSummary(msg);
    }
    if (p.bucket && !names.includes(p.bucket)) names = [p.bucket, ...names];
    setBucketsBy((m) => ({ ...m, [p.id]: { names, note: names.length ? null : note, error: names.length ? null : error, loading: false, reconnect } }));
    return names;
  }, []);

  /** Remembers a bucket opened by name, so it shows in the sidebar and the Move dialog. */
  const rememberBucket = useCallback((p: Profile, name: string) => {
    setBucketsBy((m) => {
      const cur = m[p.id] ?? { names: [], note: null, loading: false };
      return cur.names.includes(name) ? m : { ...m, [p.id]: { ...cur, names: [...cur.names, name], note: null } };
    });
  }, []);

  /** A saved or edited profile: replace it in the list, or add it. */
  const upsertProfile = useCallback((p: Profile) => {
    setProfiles((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
  }, []);

  /** A deleted connection leaves the list and the sidebar. */
  const dropProfile = useCallback(
    (id: string) => {
      setProfiles((list) => list.filter((x) => x.id !== id));
      setExpandedSaved((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    },
    [setExpandedSaved],
  );

  return {
    profiles,
    setProfiles,
    bucketsBy,
    expanded,
    hiddenBuckets,
    rootLabel,
    setBucketHidden,
    setExpandedSaved,
    expand,
    loadBuckets,
    rememberBucket,
    upsertProfile,
    dropProfile,
  };
}

export type Connections = ReturnType<typeof useConnections>;
