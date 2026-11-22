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
