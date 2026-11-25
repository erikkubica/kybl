/**
 * Saved mirrors ("Deploy Acme to live"), kept on this device (localStorage): a source and a
 * destination folder with the mirror's options, to run again with one click.
 */
import { useSyncExternalStore } from "react";
import type { CompareMode } from "./plan";
import type { Place } from "./walk";

/** One end of a mirror, with the names to show for it. */
export type MirrorEnd = Place & { connectionName: string; rootName: string };

export type MirrorConfig = {
  src: MirrorEnd;
  dst: MirrorEnd;
  /** also delete at the destination what's gone from the source */
  deleteExtra: boolean;
  compare: CompareMode;
  /** .gitignore-style patterns, one per line */
  excludes: string;
  /** add the patterns of the .gitignore at the top of the folder on this device */
  useGitignore: boolean;
};

export type SavedMirror = MirrorConfig & { id: string; name: string; created: number; lastRun: number | null };

const KEY = "kybl.mirrors";
const listeners = new Set<() => void>();
let cache: SavedMirror[] | null = null;

/** An end saved by an older version (bucket / prefix) in today's shape (root / dir). */
const end = (e: MirrorEnd & { bucket?: string; prefix?: string }): MirrorEnd => ({ ...e, root: e.root ?? e.bucket ?? "", dir: e.dir ?? e.prefix ?? "" });

function read(): SavedMirror[] {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(v) ? v.filter((m) => m && typeof m.id === "string" && m.src && m.dst).map((m) => ({ ...m, src: end(m.src), dst: end(m.dst) })) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: SavedMirror[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: kept for this session only */
  }
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  // another window of the app saved one
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    cache = null;
    listeners.forEach((l) => l());
  });
}

/** Every saved mirror, by name. */
export function listMirrors(): SavedMirror[] {
  return [...read()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export const getMirror = (id: string): SavedMirror | undefined => read().find((m) => m.id === id);

/** Saves a new mirror (no id) or updates one; resolves to what was saved. */
export function saveMirror(m: MirrorConfig & { id?: string; name: string }): SavedMirror {
  const list = read();
  const have = m.id ? list.find((x) => x.id === m.id) : undefined;
  const saved: SavedMirror = { ...m, id: have?.id ?? m.id ?? crypto.randomUUID(), name: m.name.trim() || "Mirror", created: have?.created ?? Date.now(), lastRun: have?.lastRun ?? null };
  write(have ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved]);
  return saved;
}

export function deleteMirror(id: string) {
  write(read().filter((m) => m.id !== id));
}

export function markRun(id: string) {
  const list = read();
  if (list.some((m) => m.id === id)) write(list.map((m) => (m.id === id ? { ...m, lastRun: Date.now() } : m)));
}

const samePlace = (a: Place, b: Place) => a.profileId === b.profileId && a.root === b.root && a.dir === b.dir;

/** Saved mirrors whose source (or destination, with `either`) is this folder. */
export const mirrorsAt = (at: Place, either = false) => listMirrors().filter((m) => samePlace(m.src, at) || (either && samePlace(m.dst, at)));

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The saved mirrors, kept up to date. */
export function useMirrors(): SavedMirror[] {
  const list = useSyncExternalStore(subscribe, read);
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
