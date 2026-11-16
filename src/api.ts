import { invoke } from "@tauri-apps/api/core";

/**
 * Reads that a provider refused with AccessDenied get two more tries. Ceph-based providers
 * (Hetzner, and other RGW setups) take a few minutes to spread a new key to every server, and
 * until then some requests are refused while others go through. A real lack of permission
 * still fails, about two seconds later. Only for reads, which are safe to repeat.
 */
async function read<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      if (i >= 2 || !/AccessDenied|status: 403/.test(String(e))) throw e;
      await new Promise((ok) => setTimeout(ok, 500 + i * 1000));
    }
  }
}
import type {
  ListResult,
  LocalFile,
  ObjectDetails,
  Profile,
  RemoteFile,
  SearchResult,
  Transfer,
} from "./types";

/** Outcome of a long bucket operation; `error` is "Cancelled" when the user stopped it. */
export type OpResult = { done: number; total: number; error: string | null };

export const api = {
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  saveProfile: (profile: Profile, secret?: string) =>
    invoke<Profile>("save_profile", { profile, secret: secret || null }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  testConnection: (profile: Profile, secret?: string) =>
    invoke<string>("test_connection", { profile, secret: secret || null }),

  listBuckets: (profileId: string) =>
    read<{ name: string; created: number | null }[]>("list_buckets", { profileId }),
  listObjects: (profileId: string, bucket: string, prefix: string, token?: string | null) =>
    read<ListResult>("list_objects", { profileId, bucket, prefix, token: token ?? null }),
  /** With an `opId`, matches stream in as `search-progress` events and `cancelTransfer(opId)` stops it. */
  searchObjects: (profileId: string, bucket: string, prefix: string, query: string, opId?: string) =>
    read<SearchResult>("search_objects", { profileId, bucket, prefix, query, opId: opId ?? null }),
  headObject: (profileId: string, bucket: string, key: string) =>
    read<ObjectDetails>("head_object", { profileId, bucket, key }),
  /** The whole object as bytes, for previews rendered in the app (PDF). Rejects above `maxBytes`. */
  objectBytes: (profileId: string, bucket: string, key: string, maxBytes: number) =>
    invoke<ArrayBuffer>("get_object_bytes", { profileId, bucket, key, maxBytes }),
  textPreview: (profileId: string, bucket: string, key: string, maxBytes = 262144) =>
    invoke<{ text: string; truncated: boolean }>("get_text_preview", {
      profileId,
      bucket,
      key,
      maxBytes,
    }),
  presign: (profileId: string, bucket: string, key: string, expiresSecs: number) =>
    invoke<string>("presign_get", { profileId, bucket, key, expiresSecs }),

  createFolder: (profileId: string, bucket: string, prefix: string) =>
    invoke<void>("create_folder", { profileId, bucket, prefix }),
  deleteObjects: (profileId: string, bucket: string, keys: string[], prefixes: string[], opId?: string) =>
    invoke<OpResult>("delete_objects", { profileId, bucket, keys, prefixes, opId: opId ?? null }),
  copyOrMove: (
    profileId: string,
    bucket: string,
    from: string,
    to: string,
    isPrefix: boolean,
    deleteSource: boolean,
  ) => invoke<number>("copy_or_move", { profileId, bucket, from, to, isPrefix, deleteSource }),

  moveMany: (
    profileId: string,
    bucket: string,
    items: { from: string; to: string; isPrefix: boolean }[],
    deleteSource: boolean,
    opId: string,
  ) => invoke<OpResult>("move_many", { profileId, bucket, items, deleteSource, opId }),

  expandPaths: (paths: string[]) => invoke<LocalFile[]>("expand_paths", { paths }),
  listAllUnder: (profileId: string, bucket: string, prefix: string) =>
    invoke<RemoteFile[]>("list_all_under", { profileId, bucket, prefix }),

  startUpload: (
    id: string,
    profileId: string,
    bucket: string,
    key: string,
    localPath: string,
  ) => invoke<void>("start_upload", { id, profileId, bucket, key, localPath }),
  startDownload: (
    id: string,
    profileId: string,
    bucket: string,
    key: string,
    destPath: string,
  ) => invoke<void>("start_download", { id, profileId, bucket, key, destPath }),
  cancelTransfer: (id: string) => invoke<void>("cancel_transfer", { id }),
  /** Transfers still queued or running, including ones started before this page loaded. */
  activeTransfers: () => invoke<Omit<Transfer, "speed" | "error">[]>("active_transfers"),

  clearThumbnailCache: () => invoke<number>("clear_thumbnail_cache"),

  /** Names and sizes of files from the system picker (paths, or URIs on phones). */
  pickedFiles: (uris: string[]) =>
    invoke<{ path: string; name: string; size: number }[]>("picked_files", { uris }),
  /** Where downloads are saved without asking (phones; Downloads on desktop). */
  downloadFolder: () => invoke<string>("download_folder"),
};

export function errMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * Storage errors come from the backend as a plain-language sentence, a blank line, then the raw
 * technical error. These split the two: the sentence is what people read, the rest sits behind
 * "Details" for when someone needs to debug it.
 */
export function errSummary(msg: string): string {
  const i = msg.indexOf("\n\n");
  return i < 0 ? msg : msg.slice(0, i);
}
export function errDetail(msg: string): string | null {
  const i = msg.indexOf("\n\n");
  return i < 0 ? null : msg.slice(i + 2);
}
