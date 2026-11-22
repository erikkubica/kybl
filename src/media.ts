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
import { api, type Capabilities } from "./api";
import { capsFor } from "./useCaps";
import type { Entry } from "./types";

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
    try {
      const bytes = await api.objectBytes(profileId, bucket, e.key, CACHED_IMAGE_MAX, true, { etag: e.etag, size: e.size });
      const url = URL.createObjectURL(new Blob([bytes], { type: imageType(e.name) }));
      return { url, revoke: () => URL.revokeObjectURL(url) };
    } catch {
      /* stream it instead */
    }
  }
  return { url: await playableUrl(profileId, bucket, e, c) };
}

function imageType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const t: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff" };
  return t[ext] ?? "application/octet-stream";
}
