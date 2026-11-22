import { useEffect, useState } from "react";
import { api, type Capabilities } from "./api";

/**
 * What an S3 connection can do (Kybl Storage also creates buckets). A fallback for S3 profiles
 * while their own answer loads: `useCaps(id) ?? S3_CAPS`. Other kinds should wait for theirs.
 */
export const S3_CAPS: Capabilities = {
  roots: "buckets",
  createRoot: false,
  folders: "prefix",
  rename: "copy-delete",
  serverCopy: "cross-root",
  share: "presign",
  shareExpiry: true,
  streaming: "presign",
  rangeRead: true,
  conditionalWrite: "compare",
  hashes: [],
  thumbnails: "local",
  metadata: "s3",
  tags: true,
  storageClass: true,
  trash: false,
  versions: false,
  search: "scan",
  changes: false,
  multipart: true,
  maxObjectSize: 5 * 1024 ** 4,
  backgroundUpload: true,
  localPaths: false,
};

// A connection's capabilities only change when it is saved again, so one answer per connection
// serves every pane and dialog until `forgetCaps`.
const cache = new Map<string, Capabilities>();
const pending = new Map<string, Promise<Capabilities>>();
const listeners = new Set<() => void>();

/** The capabilities of a connection, asked once and then cached. */
export function capsFor(profileId: string): Promise<Capabilities> {
  const have = cache.get(profileId);
  if (have) return Promise.resolve(have);
  let p = pending.get(profileId);
  if (!p) {
    p = api
      .capabilities(profileId)
      .then((c) => {
        cache.set(profileId, c);
        return c;
      })
      .finally(() => pending.delete(profileId));
    pending.set(profileId, p);
  }
  return p;
}

/** The cached answer, if there is one yet. */
export function peekCaps(profileId: string): Capabilities | undefined {
  return cache.get(profileId);
}

/** Call after a connection is saved or deleted (no id: forget them all). */
export function forgetCaps(profileId?: string) {
  if (profileId === undefined) cache.clear();
  else cache.delete(profileId);
  listeners.forEach((l) => l());
}

/**
 * What the connection can do, so the UI can hide what it can't. Null while it loads (or when
 * there is no connection, or the connection is gone).
 */
export function useCaps(profileId: string | null | undefined): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(() => (profileId ? (cache.get(profileId) ?? null) : null));
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const bump = () => setEpoch((n) => n + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  useEffect(() => {
    if (!profileId) {
      setCaps(null);
      return;
    }
    const have = cache.get(profileId);
    setCaps(have ?? null);
    if (have) return;
    let live = true;
    capsFor(profileId).then(
      (c) => live && setCaps(c),
      () => live && setCaps(null),
    );
    return () => {
      live = false;
    };
  }, [profileId, epoch]);

  return caps;
}
