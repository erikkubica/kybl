/**
 * Where a photo, video or song plays from.
 *
 * S3 connections hand out presigned URLs, which the web view fetches straight from the provider.
 * Connections that can't (this device's folders, and the network and cloud providers) are played
 * through the app itself: the `media:` scheme, or on Linux a private server on 127.0.0.1 (WebKitGTK
 * can't play media from app schemes). Both answer Range requests piece by piece (see
 * storage/media.rs); which one to use comes from the backend (`media_base`), asked once.
 *
 * Local files deliberately don't use Tauri's asset protocol: it would need a scope covering the
 * whole home folder and every disk, a second way in next to the confined local backend.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { api, type Capabilities } from "../../core/api";
import { capsFor } from "../../core/useCaps";
import type { Entry } from "../../core/types";

/** "media": `convertFileSrc(id, "media")`; "http": `base` + the encoded id. */
export type MediaBase = { scheme: "media" | "http"; base: string };

let base: Promise<MediaBase> | null = null;

/** How media reaches the web view; asked once (a failure is asked again next time). */
export function mediaBase(): Promise<MediaBase> {
  if (!base) {
    base = invoke<MediaBase>("media_base").catch((e) => {
      base = null;
      throw e;
    });
  }
  return base;
}

/** The fields storage/media.rs unpacks: one file version, like thumb:// URLs. */
const idOf = (profileId: string, bucket: string, e: Pick<Entry, "key" | "size" | "etag">) =>
  [profileId, bucket, String(e.size), e.etag ?? "", e.key].join("\n");

/** The app's own URL for a file (whatever the connection can do). */
export async function mediaUrl(profileId: string, bucket: string, e: Pick<Entry, "key" | "size" | "etag">): Promise<string> {
  const b = await mediaBase();
  const id = idOf(profileId, bucket, e);
  return b.scheme === "http" ? b.base + encodeURIComponent(id) : convertFileSrc(id, "media");
}

/** How long a presigned playback link stays valid. */
const LINK_SECS = 3600;

/**
 * A URL an <img>, <video> or <audio> can play `e` from: presigned where the connection streams
 * that way, else through the app. `caps` may be left out (or null while it loads); it is then
 * looked up.
 */
export async function playableUrl(
  profileId: string,
  bucket: string,
  e: Pick<Entry, "key" | "size" | "etag">,
  caps?: Capabilities | null,
): Promise<string> {
  const c = caps ?? (await capsFor(profileId).catch(() => null));
  // unknown capabilities: S3's presigned links, as before there were other kinds
  if (!c || c.streaming === "presign") return api.presign(profileId, bucket, e.key, LINK_SECS);
  return mediaUrl(profileId, bucket, e);
}

/** Up to this size a photo is shown from its bytes, kept in the file cache. */
const CACHED_IMAGE_MAX = 40_000_000;

/**
 * Full-size photos loaded right now, shared: the phone's details screen and Quick Look asking for the same
 * photo get the same bytes and blob URL (one fetch, whichever asked first), and the blob is let
 * go when the last of them is done with it.
 */
type Shared = { p: Promise<string | null>; url?: string; refs: number };
const shared = new Map<string, Shared>();
const imageHooks = new Map<string, Set<() => void>>();

/** True while a full-size copy of this photo is loaded (another view holds it). */
export function hasImage(profileId: string, bucket: string, e: Pick<Entry, "key" | "size" | "etag">): boolean {
  return !!shared.get(idOf(profileId, bucket, e))?.url;
}

/** Calls `f` when a full-size copy of this photo finishes loading anywhere. */
export function onImageReady(profileId: string, bucket: string, e: Pick<Entry, "key" | "size" | "etag">, f: () => void): () => void {
  const k = idOf(profileId, bucket, e);
  let set = imageHooks.get(k);
  if (!set) imageHooks.set(k, (set = new Set()));
  set.add(f);
  return () => {
    set!.delete(f);
    if (!set!.size) imageHooks.delete(k);
  };
}

/**
 * A URL to show a photo at full size. Up to 40 MB it comes through the file cache (a blob URL:
 * `revoke` lets it go), so opening, downloading or copying the photo afterwards needs no second
 * fetch; bigger ones, and this computer's own files, stream as `playableUrl` does.
 */
export async function imageUrl(
  profileId: string,
  bucket: string,
  e: Pick<Entry, "key" | "size" | "etag" | "name">,
  caps?: Capabilities | null,
): Promise<{ url: string; revoke?: () => void }> {
  const c = caps ?? (await capsFor(profileId).catch(() => null));
  if (!c?.localPaths && e.size <= CACHED_IMAGE_MAX) {
    const k = idOf(profileId, bucket, e);
    let s = shared.get(k);
    if (!s) {
      const entry: Shared = { refs: 0, p: Promise.resolve(null) };
      entry.p = api
        .objectBytes(profileId, bucket, e.key, CACHED_IMAGE_MAX, true, { etag: e.etag, size: e.size })
        .then((bytes) => {
          const url = URL.createObjectURL(new Blob([bytes], { type: imageType(e.name) }));
          if (shared.get(k) !== entry) {
            // everyone gave up while it loaded
            URL.revokeObjectURL(url);
            return null;
          }
          entry.url = url;
          for (const f of imageHooks.get(k) ?? []) f();
          return url;
        })
        .catch(() => {
          if (shared.get(k) === entry) shared.delete(k);
          return null;
        });
      shared.set(k, (s = entry));
    }
    const mine = s;
    mine.refs++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      if (--mine.refs > 0 || shared.get(k) !== mine) return;
      shared.delete(k);
      if (mine.url) URL.revokeObjectURL(mine.url);
    };
    const url = await mine.p;
    if (url) return { url, revoke: release };
    release();
    /* stream it instead */
  }
  return { url: await playableUrl(profileId, bucket, e, c) };
}

function imageType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const t: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff" };
  return t[ext] ?? "application/octet-stream";
}
