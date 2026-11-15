import { convertFileSrc } from "@tauri-apps/api/core";
import { extOf } from "./format";
import type { Entry } from "./types";

/** Formats the thumbnail engine can decode (EXIF thumbnails for jpg/tif, full decode for the rest). */
const THUMB_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"];
/** Must match `MAX_FULL_DOWNLOAD` in thumbs.rs: bigger files are refused there anyway. */
const MAX_BYTES = 40 * 1000 * 1000;

/** Off by default: lists show file-type icons and download nothing until this is turned on. */
let listThumbs = false;
export function setListThumbs(on: boolean) {
  listThumbs = on;
}
/** Thumbnails in folder lists and grids. A single opened image still uses its thumbnail. */
export function canListThumb(e: Entry): boolean {
  return listThumbs && canThumb(e);
}

export function canThumb(e: Entry): boolean {
  if (e.kind !== "file") return false;
  const ext = extOf(e.name);
  if (!THUMB_EXT.includes(ext)) return false;
  // jpg/tif can use the tiny embedded thumbnail regardless of size; other types are fully downloaded
  const small = ext === "jpg" || ext === "jpeg" || ext === "tif" || ext === "tiff" || e.size <= MAX_BYTES;
  return small;
}

/**
 * Thumbnails are served by the app itself at `thumb://…` URLs (see thumbs.rs), so what is kept
 * here is only the short URL; the image bytes live in the web view's image cache, which manages
 * its own memory. A failure is remembered for a while so it is not retried on every scroll.
 */
const MAX_CACHE = 5000;
const MAX_ACTIVE = 6;
const RETRY_AFTER_MS = 60_000;
// string = loaded URL, number = time it failed
const cache = new Map<string, string | number>();
const inflight = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
let active = 0;

const keyOf = (profileId: string, bucket: string, e: Entry) =>
  `${profileId}|${bucket}|${e.key}|${e.etag ?? ""}|${e.size}`;

/** The URL the backend answers with the thumbnail JPEG; the fields are unpacked in thumbs.rs. */
const urlOf = (profileId: string, bucket: string, e: Entry) =>
  convertFileSrc([profileId, bucket, String(e.size), e.etag ?? "", e.key].join("\n"), "thumb");

/** The thumbnail URL if it already loaded, null if it failed recently, undefined if unknown. */
export function cachedThumb(profileId: string, bucket: string, e: Entry): string | null | undefined {
  const v = cache.get(keyOf(profileId, bucket, e));
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  return Date.now() - v < RETRY_AFTER_MS ? null : undefined;
}

function remember(k: string, v: string | number) {
  cache.delete(k);
  cache.set(k, v);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

function slot(): Promise<void> {
  if (active < MAX_ACTIVE) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(() => { active++; resolve(); }));
}

function release() {
  active--;
  waiting.shift()?.();
}

/** Resolves once the image has loaded (and so sits in the web view's cache), or rejects. */
function preload(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("no thumbnail"));
    img.src = url;
  });
}

/**
 * Loads a thumbnail and resolves with its URL (null when none can be made). `stillWanted` is
 * checked just before the request starts, so tiles that scrolled out of view while queued are
 * skipped (resolving undefined) instead of wasting bandwidth.
 */
export function loadThumb(
  profileId: string,
  bucket: string,
  e: Entry,
  stillWanted: () => boolean,
): Promise<string | null | undefined> {
  const k = keyOf(profileId, bucket, e);
  const known = cachedThumb(profileId, bucket, e);
  if (known !== undefined) return Promise.resolve(known);
  const existing = inflight.get(k);
  if (existing) return existing;
  const p = (async () => {
    await slot();
    try {
      if (!stillWanted()) return undefined;
      const url = urlOf(profileId, bucket, e);
      await preload(url);
      remember(k, url);
      return url;
    } catch {
      remember(k, Date.now());
      return null;
    } finally {
      release();
      inflight.delete(k);
    }
  })();
  inflight.set(k, p as Promise<string | null>);
  return p;
}
