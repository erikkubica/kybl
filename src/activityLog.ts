/**
 * The Activity panel's "Log": what the app told you (every toast) and what it did (transfers
 * started and ended, connecting, connections and folders that failed), newest last, with the
 * time. A line can carry `detail` (the technical side, shown under "Details"). Everything is run
 * through `redact` first, so no password, token or signed URL lands here. In memory for this
 * session only; capped so a long session can't grow it without bound.
 */
import { useSyncExternalStore } from "react";
import { errorDetail, errorSentence, redact } from "./logText.ts";

export type LogEntry = { id: number; at: number; kind: "success" | "error" | "info"; text: string; detail?: string };

const MAX = 500;
/** a detail longer than this is cut (a listing's whole HTML error page helps nobody) */
const MAX_DETAIL = 4000;
let entries: LogEntry[] = [];
let seq = 0;
const subs = new Set<() => void>();

/**
 * Adds a line. A backend error ("sentence\n\ndetail") passed as `text` is split: the sentence is
 * the line, the rest its details.
 */
export function logMessage(kind: LogEntry["kind"], text: string, detail?: string | null) {
  let line = text;
  let more = detail ?? null;
  if (more == null && text.includes("\n\n")) {
    line = errorSentence(text);
    more = errorDetail(text);
  }
  line = redact(line.replace(/\s*\n+\s*/g, " ").trim());
  more = more ? redact(more.trim()) : null;
  if (more && more.length > MAX_DETAIL) more = `${more.slice(0, MAX_DETAIL)}…`;
  const entry: LogEntry = { id: ++seq, at: Date.now(), kind, text: line };
  if (more) entry.detail = more;
  entries = [...entries.slice(-(MAX - 1)), entry];
  for (const f of subs) f();
}

export function clearLog() {
  entries = [];
  for (const f of subs) f();
}

/** The log as it is now, without subscribing (Copy log). */
export const currentLog = (): LogEntry[] => entries;

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export function useActivityLog(): LogEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}
