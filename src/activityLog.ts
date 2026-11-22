/**
 * The Activity panel's "Log": what the app told you (every toast), newest last, with the time.
 * In memory for this session only; capped so a long session can't grow it without bound.
 */
import { useSyncExternalStore } from "react";

export type LogEntry = { id: number; at: number; kind: "success" | "error" | "info"; text: string };

const MAX = 500;
let entries: LogEntry[] = [];
let seq = 0;
const subs = new Set<() => void>();

export function logMessage(kind: LogEntry["kind"], text: string) {
  entries = [...entries.slice(-(MAX - 1)), { id: ++seq, at: Date.now(), kind, text }];
  for (const f of subs) f();
}

export function clearLog() {
  entries = [];
  for (const f of subs) f();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export function useActivityLog(): LogEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}
