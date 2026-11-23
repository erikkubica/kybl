import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import { HEIC_IN_WEBVIEW, extOf, isHeic } from "./format";
import { imageModeFor } from "./imageMode";
import { retryFailure } from "./thumbRetry";
import type { Entry } from "./types";

/** Formats the thumbnail engine can decode (EXIF thumbnails for jpg/tif, full decode for the rest). */
const THUMB_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"];
/** Must match `MAX_FULL_DOWNLOAD` in thumbs.rs: bigger files are refused there anyway. */
const MAX_BYTES = 40 * 1000 * 1000;
/**
 * HEIC/HEIF: the thumbnail engine can't decode it, but Apple's WebKit can (see HEIC_IN_WEBVIEW).
 * Those photos are fetched whole, drawn small on a canvas and kept as a small JPEG, so a grid of
 * iPhone photos doesn't keep dozens of 12-megapixel images decoded in memory. Elsewhere HEIC
 * keeps its file icon, as before.
 */
const MAX_HEIC_BYTES = 25 * 1000 * 1000;
const THUMB_PX = 360;

/**
 * Phones on mobile data with "Wi-Fi only" on: lists don't fetch new thumbnails (ones already
 * loaded still show). A single opened photo still gets one.
 */
let paused = false;
export function setThumbsPaused(on: boolean) {
  paused = on;
}
export function thumbsPaused(): boolean {
  return paused;
}
/**
 * Thumbnails in folder lists and grids: only in the "full" image mode of the connection
 * (imageMode.ts). A single opened image still uses its thumbnail.
 */
export function canListThumb(e: Entry, profileId: string): boolean {
  return imageModeFor(profileId) === "full" && !paused && canThumb(e);
}

export function canThumb(e: Entry): boolean {
  if (e.kind !== "file") return false;
  if (isHeic(e.name)) return HEIC_IN_WEBVIEW && e.size <= MAX_HEIC_BYTES;
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
/** HEIC thumbnails are blob URLs holding real bytes (~30 KB each), so fewer of them are kept. */
const MAX_BLOBS = 400;
const MAX_ACTIVE = 6;
const RETRY_AFTER_MS = 60_000;
// string = loaded URL, number = time it failed
const cache = new Map<string, string | number>();
const blobs: { k: string; url: string }[] = [];
const inflight = new Map<string, Promise<string | null>>();
/** tiles waiting to hear that their thumbnail exists, whoever asked for it (Quick Look, the phone's details screen) */
const readyHooks = new Map<string, Set<(url: string) => void>>();

/**
 * Calls `f` when a thumbnail for this file is made anywhere in the app (a preview asking
 * for the selected photo, say), so a tile showing an icon or a placeholder can take it at once.
 */
export function onThumbReady(profileId: string, bucket: string, e: Entry, f: (url: string) => void): () => void {
  const k = keyOf(profileId, bucket, e);
  let set = readyHooks.get(k);
  if (!set) readyHooks.set(k, (set = new Set()));
  set.add(f);
  return () => {
    set!.delete(f);
    if (!set!.size) readyHooks.delete(k);
  };
}
/** thumbnails being made right now (past the queue), and who wants to know when one starts */
const started = new Set<string>();
const startHooks = new Map<string, Array<() => void>>();
/** each caller's "still wanted" check for a request in flight (several tiles can share one) */
const wanters = new Map<string, Array<() => boolean>>();
const waiting: Array<() => void> = [];
let active = 0;

const keyOf = (profileId: string, bucket: string, e: Entry) =>
  `${profileId}|${bucket}|${e.key}|${e.etag ?? ""}|${e.size}`;

/** The URL the backend answers with the thumbnail JPEG; the fields are unpacked in thumbs.rs. */
const urlOf = (profileId: string, bucket: string, e: Entry) =>
  convertFileSrc([profileId, bucket, String(e.size), e.etag ?? "", e.key].join("\n"), "thumb");

/** tiles showing an icon because their thumbnail failed, to try again when the network is back */
const retryHooks = new Set<() => void>();

/** Calls `f` when failed thumbnails may be asked for again (retryFailedThumbs). */
export function onThumbRetry(f: () => void): () => void {
  retryHooks.add(f);
  return () => void retryHooks.delete(f);
}

/** failures made while the device said it was offline */
const offlineFails = new Set<string>();

/**
 * The network is back, or the app resumed: thumbnails that failed meanwhile are asked for again
 * (on resume only those that failed offline or a while ago: see retryFailure).
 */
export function retryFailedThumbs(why: "online" | "resumed" = "online") {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (typeof v !== "number" || !retryFailure(why, v, offlineFails.has(k), now, RETRY_AFTER_MS)) continue;
    cache.delete(k);
    offlineFails.delete(k);
  }
  for (const f of [...retryHooks]) f();
}

/** The thumbnail URL if it already loaded, null if it failed recently, undefined if unknown. */
export function cachedThumb(profileId: string, bucket: string, e: Entry): string | null | undefined {
  const v = cache.get(keyOf(profileId, bucket, e));
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  return Date.now() - v < RETRY_AFTER_MS ? null : undefined;
}

function remember(k: string, v: string | number) {
  cache.delete(k);
  offlineFails.delete(k);
  cache.set(k, v);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) {
      cache.delete(first);
      offlineFails.delete(first);
    }
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
function preload(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("no thumbnail"));
    img.src = url;
  });
}

/** One HEIC at a time: each is decoded at full size for a moment. */
let heicChain: Promise<unknown> = Promise.resolve();

function heicThumb(profileId: string, bucket: string, e: Entry, k: string): Promise<string> {
  const run = async () => {
    // through the backend, not a share link: a canvas can only export same-origin pixels
    const bytes = await api.objectBytes(profileId, bucket, e.key, MAX_HEIC_BYTES);
    const full = URL.createObjectURL(new Blob([bytes], { type: "image/heic" }));
    try {
      const img = await preload(full);
      const s = Math.min(1, THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * s));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * s));
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
      const small = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.8));
      if (!small) throw new Error("no thumbnail");
      // the backend can't decode HEIC: it makes this photo's placeholder from the small JPEG
      await small
        .arrayBuffer()
        .then((b) => api.placeholderFromThumbnail(profileId, bucket, { key: e.key, etag: e.etag ?? null, size: e.size }, new Uint8Array(b)))
        .catch(() => {});
      const url = URL.createObjectURL(small);
      blobs.push({ k, url });
      if (blobs.length > MAX_BLOBS) {
        const old = blobs.shift()!;
        cache.delete(old.k);
        URL.revokeObjectURL(old.url);
      }
      return url;
    } finally {
      URL.revokeObjectURL(full);
    }
  };
  const p = heicChain.then(run, run);
  heicChain = p.catch(() => {});
  return p;
}

/**
 * Loads a thumbnail and resolves with its URL (null when none can be made). `stillWanted` is
 * checked just before the request starts, so tiles that scrolled out of view while queued are
 * skipped (resolving undefined) instead of wasting bandwidth. `onStart` runs when its turn comes
 * and the thumbnail is really being made (the tile shows it loading only then, not while queued).
 */
export function loadThumb(
  profileId: string,
  bucket: string,
  e: Entry,
  stillWanted: () => boolean,
  onStart?: () => void,
): Promise<string | null | undefined> {
  const k = keyOf(profileId, bucket, e);
  const known = cachedThumb(profileId, bucket, e);
  if (known !== undefined) return Promise.resolve(known);
  const existing = inflight.get(k);
  if (existing) {
    // joining: the request goes ahead while any of its tiles still wants it
    wanters.get(k)?.push(stillWanted);
    if (onStart) (startHooks.get(k) ?? startHooks.set(k, []).get(k)!).push(onStart);
    if (started.has(k)) onStart?.();
    return existing;
  }
  if (onStart) startHooks.set(k, [onStart]);
  wanters.set(k, [stillWanted]);
  const p = (async () => {
    await slot();
    try {
      if (!wanters.get(k)?.some((f) => f())) return undefined;
      started.add(k);
      for (const f of startHooks.get(k) ?? []) f();
      let url: string;
      if (isHeic(e.name)) url = await heicThumb(profileId, bucket, e, k);
      else {
        url = urlOf(profileId, bucket, e);
        await preload(url);
      }
      remember(k, url);
      for (const f of readyHooks.get(k) ?? []) f(url);
      return url;
    } catch {
      remember(k, Date.now());
      if (typeof navigator !== "undefined" && navigator.onLine === false) offlineFails.add(k);
      return null;
    } finally {
      release();
      inflight.delete(k);
      wanters.delete(k);
      started.delete(k);
      startHooks.delete(k);
    }
  })();
  inflight.set(k, p as Promise<string | null>);
  return p;
}
