/**
 * Photo placeholders: a ThumbHash (~25 bytes) per photo, decoded here into a tiny blurry image
 * that stands in for the thumbnail at once, or instead of it in the "placeholders" image mode
 * (imageMode.ts). Where the hashes come from is explained in placeholders.rs; in short, cheapest
 * first:
 *  1. this device's index (every thumbnail made here, every photo uploaded from here): one local
 *     call for a batch of tiles, no network
 *  2. the folder's shared index `.kybl/thumbhash.json`, when the connection shares placeholders:
 *     one request per folder, and the folder's new hashes are written back to it
 *  3. the photo's own `x-amz-meta-thumbhash` (uploads from Kybl to S3): one HEAD per photo, only
 *     for tiles on screen, a few at a time, skipping tiles that scrolled away while queued
 * A hash belongs to one version of a file (etag + size), like a thumbnail.
 */
import { useEffect, useState } from "react";
import { api, type PlaceholderItem } from "./api";
import { capsFor } from "./useCaps";
import { extOf, isHeic, parentPrefix } from "./format";
import { imageModeFor, sharedPlaceholdersOn } from "./imageMode";
import { thumbsPaused } from "./thumbs";
import type { Entry } from "./types";

/** Photos a placeholder can exist for: what the thumbnail engine reads, and HEIC. */
const PHOTO_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"];

export function canPlaceholder(e: Entry): boolean {
  return e.kind === "file" && !e.native && (PHOTO_EXT.includes(extOf(e.name)) || isHeic(e.name));
}

/**
 * The folder holding a shared index (`<folder>/.kybl/thumbhash.json`), or anything inside one:
 * lists never show it, whatever the hidden-files setting (it is Kybl's, not the user's).
 */
export function isPlaceholderIndex(key: string): boolean {
  return /(^|\/)\.kybl\//.test(key);
}

// ---------------------------------------------------------------- decoding

/** The tiny image a hash stands for: 32 px on its long side, its aspect ratio roughly the photo's. */
export function thumbHashToRGBA(hash: Uint8Array): { w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const { PI, min, max, cos, round } = Math;
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = header24 >> 23;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const isLandscape = header16 >> 15;
  const lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7);
  const aDc = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const aScale = (hash[5] >> 4) / 15;

  // the varying factors (saturation boosted 1.25x to make up for quantization)
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  const decodeChannel = (nx: number, ny: number, scale: number) => {
    const ac: number[] = [];
    for (let cy = 0; cy < ny; cy++)
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++, acIndex++)
        ac.push((((hash[acStart + (acIndex >> 1)] >> ((acIndex & 1) << 2)) & 15) / 7.5 - 1) * scale);
    return ac;
  };
  const lAc = decodeChannel(lx, ly, lScale);
  const pAc = decodeChannel(3, 3, pScale * 1.25);
  const qAc = decodeChannel(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? decodeChannel(5, 5, aScale) : [];

  const ratio = thumbHashRatio(hash);
  const w = round(ratio > 1 ? 32 : 32 * ratio);
  const h = round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const fx: number[] = [];
  const fy: number[] = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc;
      let p = pDc;
      let q = qDc;
      let a = aDc;
      for (let cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++) fx[cx] = cos((PI / w) * (x + 0.5) * cx);
      for (let cy = 0, n = max(ly, hasAlpha ? 5 : 3); cy < n; cy++) fy[cy] = cos((PI / h) * (y + 0.5) * cy);
      for (let cy = 0, j = 0; cy < ly; cy++)
        for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx * ly < lx * (ly - cy); cx++, j++) l += lAc[j] * fx[cx] * fy2;
      for (let cy = 0, j = 0; cy < 3; cy++)
        for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 3 - cy; cx++, j++) {
          const f = fx[cx] * fy2;
          p += pAc[j] * f;
          q += qAc[j] * f;
        }
      if (hasAlpha)
        for (let cy = 0, j = 0; cy < 5; cy++)
          for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 5 - cy; cx++, j++) a += aAc[j] * fx[cx] * fy2;
      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      const g = r - q;
      rgba[i] = max(0, 255 * min(1, r));
      rgba[i + 1] = max(0, 255 * min(1, g));
      rgba[i + 2] = max(0, 255 * min(1, b));
      rgba[i + 3] = max(0, 255 * min(1, a));
    }
  }
  return { w, h, rgba };
}

/** Width / height of the photo, roughly (the hash keeps it in steps). */
export function thumbHashRatio(hash: Uint8Array): number {
  const header = hash[3];
  const hasAlpha = hash[2] & 0x80;
  const isLandscape = hash[4] & 0x80;
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7;
  return lx / ly;
}

/** Decoded images by hash, as small PNG data URLs (~1–2 KB each); the oldest go first. */
const MAX_DECODED = 3000;
const decoded = new Map<string, string>();
let canvas: HTMLCanvasElement | null = null;

/** The placeholder image of a base64 hash, as a data URL; null when the hash is unusable. */
export function placeholderUrl(hash: string): string | null {
  const have = decoded.get(hash);
  if (have) {
    decoded.delete(hash);
    decoded.set(hash, have);
    return have;
  }
  try {
    const bin = atob(hash);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (bytes.length < 5) return null;
    const { w, h, rgba } = thumbHashToRGBA(bytes);
    canvas ??= document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    const url = canvas.toDataURL("image/png");
    decoded.set(hash, url);
    if (decoded.size > MAX_DECODED) {
      const first = decoded.keys().next().value;
      if (first !== undefined) decoded.delete(first);
    }
    return url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- what is known

/** By file version: the hash, or null when every source was asked and none had one. */
const MAX_KNOWN = 50_000;
const known = new Map<string, string | null>();
/** File versions this device's index had nothing for (not asked again this session). */
const localMissed = new Set<string>();

const bare = (etag: string | null | undefined) => (etag ?? "").replace(/^"|"$/g, "");
const keyOf = (profileId: string, bucket: string, e: Entry) => `${profileId}|${bucket}|${e.key}|${bare(e.etag)}|${e.size}`;
const itemOf = (e: Entry): PlaceholderItem => ({ key: e.key, etag: e.etag ?? null, size: e.size });

function remember(profileId: string, bucket: string, e: Entry, hash: string | null) {
  const k = keyOf(profileId, bucket, e);
  if (hash === null && typeof known.get(k) === "string") return;
  known.delete(k);
  known.set(k, hash);
  if (known.size > MAX_KNOWN) {
    const first = known.keys().next().value;
    if (first !== undefined) known.delete(first);
  }
  if (hash) noteForFolder(profileId, bucket, e, hash);
}

/** The placeholder if it is known, null when there is none, undefined when not asked yet. */
export function cachedPlaceholder(profileId: string, bucket: string, e: Entry): string | null | undefined {
  const h = known.get(keyOf(profileId, bucket, e));
  if (h === undefined) return undefined;
  return h === null ? null : placeholderUrl(h);
}

// ---------------------------------------------------------------- 1. this device's index

type Ask = { e: Entry; done: (hash: string | null) => void };
const LOOKUP_BATCH = 300;
const lookups = new Map<string, Ask[]>();
let lookupTimer: ReturnType<typeof setTimeout> | null = null;

/** Asks this device's index; tiles that ask within a few ms share one call. */
function localLookup(profileId: string, bucket: string, e: Entry): Promise<string | null> {
  return new Promise((done) => {
    const g = `${profileId}\n${bucket}`;
    const list = lookups.get(g) ?? [];
    list.push({ e, done });
    lookups.set(g, list);
    lookupTimer ??= setTimeout(flushLookups, 16);
  });
}

async function flushLookups() {
  lookupTimer = null;
  const groups = [...lookups];
  lookups.clear();
  for (const [g, asks] of groups) {
    const [profileId, bucket] = g.split("\n");
    for (let i = 0; i < asks.length; i += LOOKUP_BATCH) {
      const chunk = asks.slice(i, i + LOOKUP_BATCH);
      const found = await api.placeholdersLookup(profileId, bucket, chunk.map((a) => itemOf(a.e))).catch(() => [] as (string | null)[]);
      chunk.forEach((a, n) => a.done(found[n] ?? null));
    }
  }
}

// ---------------------------------------------------------------- 3. the photo's own metadata

const MAX_HEADS = 3;
let heads = 0;
const headQueue: Array<() => void> = [];

function headSlot(): Promise<void> {
  if (heads < MAX_HEADS) {
    heads++;
    return Promise.resolve();
  }
  return new Promise((ok) => headQueue.push(() => (heads++, ok())));
}

function headDone() {
  heads--;
  headQueue.shift()?.();
}

/** Only S3 objects carry one (uploads from Kybl), and never on mobile data with "Wi-Fi only". */
/**
 * Whether to ask the connection for this photo's placeholder (one small request, see
 * `placeholder_head` in placeholders.rs): only in Placeholders mode (Thumbnails fetches the
 * thumbnail anyway, which leaves its placeholder behind), never for this device's own files.
 * S3 answers for any photo (an upload's stored placeholder, or a JPEG's camera thumbnail);
 * other connections only for JPEGs.
 */
async function mayHead(profileId: string, e: Entry): Promise<boolean> {
  if (thumbsPaused() || imageModeFor(profileId) !== "placeholders") return false;
  const caps = await capsFor(profileId).catch(() => null);
  if (!caps || caps.localPaths) return false;
  return caps.metadata === "s3" || /\.(jpe?g|tiff?)$/i.test(e.name);
}

// ---------------------------------------------------------------- loading one

const inflight = new Map<string, Promise<string | null | undefined>>();

/**
 * The placeholder of a photo, from wherever it is known (see the top of this file): a data URL,
 * null when there is none, undefined when the tile scrolled away before its turn (`stillWanted`).
 */
export function loadPlaceholder(profileId: string, bucket: string, e: Entry, stillWanted: () => boolean): Promise<string | null | undefined> {
  const now = cachedPlaceholder(profileId, bucket, e);
  if (now !== undefined) return Promise.resolve(now);
  const k = keyOf(profileId, bucket, e);
  const existing = inflight.get(k);
  if (existing) return existing;
  const p = (async () => {
    try {
      if (!localMissed.has(k)) {
        const h = await localLookup(profileId, bucket, e);
        if (h) {
          remember(profileId, bucket, e, h);
          return placeholderUrl(h);
        }
        localMissed.add(k);
      }
      // the folder's shared index may still be on its way
      const loading = folderLoads.get(folderKey(profileId, bucket, parentPrefix(e.key)));
      if (loading) await loading;
      const fromFolder = known.get(k);
      if (fromFolder) return placeholderUrl(fromFolder);
      if (!(await mayHead(profileId, e))) return null;
      await headSlot();
      try {
        if (!stillWanted()) return undefined;
        let h: string | null;
        try {
          h = await api.placeholderHead(profileId, bucket, itemOf(e));
        } catch {
          // a failed request (offline, a timeout) isn't "this photo has none": ask again next time
          return null;
        }
        remember(profileId, bucket, e, h);
        return h ? placeholderUrl(h) : null;
      } finally {
        headDone();
      }
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/**
 * A thumbnail was just made for this photo, so this device's index now has its placeholder: it
 * is picked up for the folder's shared index (the only one that needs it right away).
 */
/**
 * A thumbnail of this photo was just made (it leaves its placeholder in this device's index):
 * forget an earlier "none", so the next ask finds it.
 */
export function forgetPlaceholderMiss(profileId: string, bucket: string, e: Entry) {
  const k = keyOf(profileId, bucket, e);
  localMissed.delete(k);
  if (known.get(k) === null) known.delete(k);
}

export function learnPlaceholder(profileId: string, bucket: string, e: Entry) {
  if (!sharedPlaceholdersOn(profileId) || typeof known.get(keyOf(profileId, bucket, e)) === "string") return;
  void localLookup(profileId, bucket, e).then((h) => h && remember(profileId, bucket, e, h));
}

// ---------------------------------------------------------------- 2. the folder's shared index

/** `[etag, size, hash]` by name, as placeholders.rs keeps them. */
type Stamp = [string, number, string];
type Folder = {
  profileId: string;
  bucket: string;
  prefix: string;
  /** the folder's photos, by key */
  photos: Map<string, Entry>;
  /** the whole folder is listed, so names missing from it are gone */
  complete: boolean;
  index: Map<string, Stamp>;
  fetched: number;
  /** hashes the shared index doesn't have yet, by key */
  pending: Map<string, PlaceholderItem & { hash: string }>;
  /** keys this device's index was asked about for the folder */
  seeded: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Folders visited lately; their index is fetched again after a while. */
const MAX_FOLDERS = 40;
const REFETCH_MS = 10 * 60_000;
const SAVE_AFTER_MS = 4000;
const folders = new Map<string, Folder>();
const folderLoads = new Map<string, Promise<void>>();
const folderKey = (profileId: string, bucket: string, prefix: string) => `${profileId}|${bucket}|${prefix}`;

function matchIndex(f: Folder, e: Entry): string | null {
  const s = f.index.get(e.key.slice(f.prefix.length));
  return s && s[0] === bare(e.etag) && s[1] === e.size ? s[2] : null;
}

function noteForFolder(profileId: string, bucket: string, e: Entry, hash: string) {
  const f = folders.get(folderKey(profileId, bucket, parentPrefix(e.key)));
  if (!f || !sharedPlaceholdersOn(profileId) || matchIndex(f, e) === hash) return;
  f.pending.set(e.key, { ...itemOf(e), hash });
  if (f.timer) clearTimeout(f.timer);
  f.timer = setTimeout(() => void saveFolder(f), SAVE_AFTER_MS);
}

/** Writes the folder's new hashes into its shared index (merged there with what others wrote). */
async function saveFolder(f: Folder) {
  f.timer = null;
  if (!f.pending.size || !sharedPlaceholdersOn(f.profileId)) return;
  const known = [...f.pending.values()];
  f.pending.clear();
  const present = f.complete ? [...f.photos.keys()] : null;
  try {
    await api.placeholdersFolderSave(f.profileId, f.bucket, f.prefix, known, present);
    for (const k of known) f.index.set(k.key.slice(f.prefix.length), [bare(k.etag), k.size, k.hash]);
  } catch {
    // tried again with the next hash learned in this folder
    for (const k of known) if (!f.pending.has(k.key)) f.pending.set(k.key, k);
  }
}

/**
 * Hashes this device already has for the folder's photos go into its shared index too, so the
 * first device to share a folder fills it with everything it knows, not just the tiles shown.
 */
async function seedFromLocal(f: Folder) {
  const ask = [...f.photos.values()].filter((e) => !f.seeded.has(e.key) && known.get(keyOf(f.profileId, f.bucket, e)) == null);
  for (const e of ask) f.seeded.add(e.key);
  for (let i = 0; i < ask.length; i += LOOKUP_BATCH) {
    const chunk = ask.slice(i, i + LOOKUP_BATCH);
    const found = await api.placeholdersLookup(f.profileId, f.bucket, chunk.map(itemOf)).catch(() => [] as (string | null)[]);
    chunk.forEach((e, n) => {
      const h = found[n];
      if (h) remember(f.profileId, f.bucket, e, h);
      else localMissed.add(keyOf(f.profileId, f.bucket, e));
    });
  }
}

/**
 * A folder was listed (`entries`: the whole listing so far, unfiltered). With the connection
 * sharing placeholders, its shared index is fetched (once in a while) and matched against the
 * photos. Never for this device's own files.
 */
export function primeFolder(profileId: string, bucket: string, prefix: string, entries: Entry[], complete: boolean) {
  if (imageModeFor(profileId) === "off" || !sharedPlaceholdersOn(profileId)) return;
  const photos = entries.filter((e) => canPlaceholder(e) && parentPrefix(e.key) === prefix);
  if (!photos.length) return;
  const fk = folderKey(profileId, bucket, prefix);
  let f = folders.get(fk);
  const fetch = !f || Date.now() - f.fetched > REFETCH_MS;
  if (!f) {
    f = { profileId, bucket, prefix, photos: new Map(), complete, index: new Map(), fetched: 0, pending: new Map(), seeded: new Set(), timer: null };
    folders.set(fk, f);
    if (folders.size > MAX_FOLDERS) {
      const old = [...folders.values()].find((x) => !x.pending.size && x !== f);
      if (old) folders.delete(folderKey(old.profileId, old.bucket, old.prefix));
    }
  }
  const folder = f;
  folder.photos = new Map(photos.map((e) => [e.key, e]));
  folder.complete = complete;
  const apply = () => {
    for (const e of folder.photos.values()) {
      const h = matchIndex(folder, e);
      if (h && known.get(keyOf(profileId, bucket, e)) !== h) remember(profileId, bucket, e, h);
    }
  };
  if (folderLoads.has(fk)) return;
  if (!fetch) {
    apply();
    void seedFromLocal(folder);
    return;
  }
  folder.fetched = Date.now();
  const load = (async () => {
    const caps = await capsFor(profileId).catch(() => null);
    // this device's own files, and phones on mobile data with "Wi-Fi only": nothing fetched
    if (!caps || caps.localPaths || thumbsPaused()) return;
    const index = await api.placeholdersFolder(profileId, bucket, prefix).catch(() => null);
    if (index) folder.index = new Map(Object.entries(index));
    apply();
  })();
  folderLoads.set(fk, load);
  void load.finally(() => {
    folderLoads.delete(fk);
    void seedFromLocal(folder);
  });
}

/**
 * Keeps the shared index of the folder on screen in step with its listing. `entries` must be the
 * whole listing (not what a search field filters), or photos would look deleted.
 */
export function useFolderPlaceholders(loc: { profileId: string; bucket: string; prefix: string } | null, entries: Entry[], complete: boolean, modes: number) {
  const profileId = loc?.profileId;
  const bucket = loc?.bucket;
  const prefix = loc?.prefix;
  useEffect(() => {
    if (profileId != null && bucket != null && prefix != null) primeFolder(profileId, bucket, prefix, entries, complete);
  }, [profileId, bucket, prefix, entries, complete, modes]);
}

/**
 * The placeholder of one photo for a preview (Quick Look, the phone's details screen) to show while the
 * image loads; null when there is none (or the connection's image mode is off).
 */
export function usePlaceholder(profileId: string, bucket: string, e: Entry | null): string | null {
  const enabled = !!e && canPlaceholder(e) && imageModeFor(profileId) !== "off";
  const [url, setUrl] = useState<string | null>(() => (enabled && e ? (cachedPlaceholder(profileId, bucket, e) ?? null) : null));
  useEffect(() => {
    if (!enabled || !e) return setUrl(null);
    const have = cachedPlaceholder(profileId, bucket, e);
    setUrl(have ?? null);
    if (have !== undefined) return;
    let live = true;
    loadPlaceholder(profileId, bucket, e, () => live).then((u) => live && setUrl(u ?? null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, profileId, bucket, e?.key, e?.etag, e?.size]);
  return url;
}
