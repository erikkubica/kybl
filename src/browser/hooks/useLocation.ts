/**
 * Where a pane is: connection, bucket (root) and folder, with Back / Forward through the places
 * it visited and the last place kept in localStorage so it can reopen there.
 */
import { useCallback, useState } from "react";
import { useHistory } from "./useHistory";
import { LS, type Loc } from "../types";

export function useLocation(storageKey: string) {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const history = useHistory();

  /** Moves to a place; `history: false` for moves made by Back / Forward themselves. */
  const set = useCallback(
    (loc: Loc, opts: { history?: boolean } = {}) => {
      setProfileId(loc.profileId);
      setBucket(loc.bucket);
      setPrefix(loc.prefix);
      LS.set(storageKey, JSON.stringify(loc));
      if (opts.history !== false) history.push(loc);
    },
    [storageKey, history.push],
  );

  /** Shows a connection with no bucket open yet (while its buckets load, or when it has none). */
  const showConnection = useCallback((id: string | null) => {
    setProfileId(id);
    setBucket(null);
  }, []);

  /** The place this pane showed last time, if any. */
  const saved = useCallback((): Loc | null => {
    try {
      const v = JSON.parse(LS.get(storageKey) ?? "null");
      return v && typeof v.profileId === "string" && typeof v.bucket === "string" && typeof v.prefix === "string" ? v : null;
    } catch {
      return null;
    }
  }, [storageKey]);

  return { profileId, bucket, prefix, set, showConnection, saved, history };
}
