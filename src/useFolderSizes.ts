/**
 * Folder sizes. S3 has no such thing, so a folder's size is worked out by listing everything
 * under it, which costs one request per 1,000 objects. That is why it runs on demand (menu, the
 * Size column, the details pane) and the result is kept until something changes the bucket.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errMessage } from "./api";

export type FolderSize = {
  state: "loading" | "done" | "error";
  bytes: number;
  objects: number;
  error?: string;
};

const PARALLEL = 3;
let seq = 0;

export function useFolderSizes(profileId: string | null, bucket: string | null) {
  const [sizes, setSizes] = useState<Record<string, FolderSize>>({});
  // read through a ref so `calc` keeps one identity instead of changing on every progress event
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const ops = useRef(new Map<string, string>()); // opId -> map key
  const queue = useRef<{ id: string; key: string; prefix: string }[]>([]);
  const running = useRef(0);
  const scope = `${profileId}/${bucket}/`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    const off = listen<{ opId: string; bytes: number; objects: number }>("size-progress", (e) => {
      const key = ops.current.get(e.payload.opId);
      if (key) setSizes((s) => (s[key]?.state === "loading" ? { ...s, [key]: { state: "loading", bytes: e.payload.bytes, objects: e.payload.objects } } : s));
    });
    return () => void off.then((f) => f());
  }, []);

  const pump = useCallback(() => {
    while (running.current < PARALLEL && queue.current.length) {
      const job = queue.current.shift()!;
      running.current++;
      ops.current.set(job.id, job.key);
      const [pid, b] = [profileId, bucket];
      invoke<{ bytes: number; objects: number }>("folder_size", { profileId: pid, bucket: b, prefix: job.prefix, opId: job.id })
        .then((r): FolderSize => ({ state: "done", bytes: r.bytes, objects: r.objects }))
        .catch((e): FolderSize => ({ state: "error", bytes: 0, objects: 0, error: errMessage(e) }))
        .then((res) => {
          ops.current.delete(job.id);
          running.current--;
          if (scopeRef.current.startsWith(`${pid}/${b}/`)) {
            // a stopped run just goes back to "not calculated"
            setSizes((s) => {
              if (res.error === "Cancelled") {
                const { [job.key]: _gone, ...rest } = s;
                return rest;
              }
              return job.key in s ? { ...s, [job.key]: res } : s;
            });
          }
          pump();
        });
    }
  }, [profileId, bucket]);

  /** Starts the folders that are not already calculated or running. */
  const calc = useCallback(
    (prefixes: string[]) => {
      if (!profileId || !bucket) return;
      const cur = sizesRef.current;
      const todo = prefixes.filter((p) => !(scope + p in cur) || cur[scope + p].state === "error");
      if (!todo.length) return;
      setSizes((s) => {
        const next = { ...s };
        for (const p of todo) next[scope + p] = { state: "loading", bytes: 0, objects: 0 };
        return next;
      });
      for (const p of todo) queue.current.push({ id: `size-${++seq}`, key: scope + p, prefix: p });
      pump();
    },
    [profileId, bucket, scope, pump],
  );

  const cancel = useCallback(
    (prefix: string) => {
      const key = scope + prefix;
      queue.current = queue.current.filter((j) => j.key !== key);
      for (const [id, k] of ops.current) if (k === key) invoke("cancel_transfer", { id }).catch(() => {});
      setSizes((s) => (s[key]?.state === "loading" && ![...ops.current.values()].includes(key) ? (({ [key]: _g, ...r }) => r)(s) : s));
    },
    [scope],
  );

  /** Forget everything: call after anything that changes what is in the bucket. */
  const clear = useCallback(() => {
    for (const id of ops.current.keys()) invoke("cancel_transfer", { id }).catch(() => {});
    queue.current = [];
    setSizes({});
  }, []);

  const get = useCallback((prefix: string): FolderSize | undefined => sizes[scope + prefix], [sizes, scope]);

  return { get, calc, cancel, clear };
}
