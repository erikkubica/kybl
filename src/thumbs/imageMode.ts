/**
 * How photos show in folder lists and grids, app-wide (Settings) and per connection:
 *  - "off": file icons only, nothing is asked for
 *  - "placeholders": a blurry ThumbHash placeholder (thumbhash.ts) where one is known, never a
 *    thumbnail download. Cheap enough for a cloud bucket on a slow line.
 *  - "full": the placeholder at once, then the real thumbnail over it
 * A connection can follow the app's setting or keep its own (a home NAS on "full" next to a
 * cloud bucket on "placeholders"). The per-connection choices live in localStorage, like a
 * pane's own view choices.
 */
import { useSyncExternalStore } from "react";

export type ImageMode = "off" | "placeholders" | "full";

export const IMAGE_MODES: { id: ImageMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "File icons only. Nothing is downloaded." },
  { id: "placeholders", label: "Placeholders", hint: "A blurry preview of each photo where one is known. Thumbnails are never downloaded." },
  { id: "full", label: "Thumbnails", hint: "The blurry preview at once, then the thumbnail (each one is a download the first time)." },
];

/** Plain words for turning sharing on (menus have no room for them). */
export const SHARE_PLACEHOLDERS_TEXT =
  "Kybl writes a small hidden file (.kybl/thumbhash.json) into each photo folder you open, with a tiny blurry preview of every photo in it. Your other devices with Kybl then show those previews straight away instead of loading each photo. Lists never show the file.";

export function imageModeLabel(m: ImageMode): string {
  return IMAGE_MODES.find((x) => x.id === m)?.label ?? m;
}

const isMode = (v: unknown): v is ImageMode => v === "off" || v === "placeholders" || v === "full";

let appMode: ImageMode = "full";
let version = 0;
const listeners = new Set<() => void>();
const modeKey = (id: string) => `s3b.imageMode.${id}`;
const sharedKey = (id: string) => `s3b.sharedPlaceholders.${id}`;
// read from localStorage once per connection; tiles ask on every render
const own = new Map<string, ImageMode | null>();
const shared = new Map<string, boolean>();

function changed() {
  version++;
  for (const f of listeners) f();
}

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function lsSet(k: string, v: string | null) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** The app-wide setting (applied from Settings). */
export function setAppImageMode(m: ImageMode) {
  if (m === appMode) return;
  appMode = m;
  changed();
}

export function appImageMode(): ImageMode {
  return appMode;
}

/** The connection's own mode; null when it follows the app's setting. */
export function connImageMode(profileId: string): ImageMode | null {
  if (!own.has(profileId)) {
    const v = lsGet(modeKey(profileId));
    own.set(profileId, isMode(v) ? v : null);
  }
  return own.get(profileId) ?? null;
}

export function setConnImageMode(profileId: string, m: ImageMode | null) {
  own.set(profileId, m);
  lsSet(modeKey(profileId), m);
  changed();
}

/** What lists of this connection show. */
export function imageModeFor(profileId: string): ImageMode {
  return connImageMode(profileId) ?? appMode;
}

/**
 * The connection shares placeholders through a small hidden file in each photo folder
 * (`.kybl/thumbhash.json`), so other devices get them with one request. Off unless turned on.
 */
export function sharedPlaceholdersOn(profileId: string): boolean {
  if (!shared.has(profileId)) shared.set(profileId, lsGet(sharedKey(profileId)) === "1");
  return shared.get(profileId) ?? false;
}

export function setSharedPlaceholders(profileId: string, on: boolean) {
  shared.set(profileId, on);
  lsSet(sharedKey(profileId), on ? "1" : null);
  changed();
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** A number that changes whenever any of these choices do (for keys and effect dependencies). */
export function useImageModes(): number {
  return useSyncExternalStore(subscribe, () => version);
}
