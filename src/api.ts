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

/** One listed file version, as the photo placeholder commands take it. */
export type PlaceholderItem = { key: string; etag: string | null; size: number };

/** Outcome of a long bucket operation; `error` is "Cancelled" when the user stopped it. */
export type OpResult = { done: number; total: number; error: string | null };

export const api = {
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  /** `clearSecret`: forget the saved password (FTP and WebDAV), when no new one is given */
  saveProfile: (profile: Profile, secret?: string, clearSecret?: boolean) =>
    invoke<Profile>("save_profile", { profile, secret: secret || null, clearSecret: !!clearSecret }),
  /** a saved connection has a password in the vault */
  profileHasSecret: (id: string) => invoke<boolean>("profile_has_secret", { id }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  /** Files connections under sidebar groups by id ("" = the top level); returns every profile. */
  setProfileGroups: (groups: Record<string, string>) =>
    invoke<Profile[]>("set_profile_groups", { groups: Object.fromEntries(Object.entries(groups).map(([id, g]) => [id, g || null])) }),
  /** `clearSecret`: test without the saved password, as Save with `clearSecret` would leave it */
  testConnection: (profile: Profile, secret?: string, clearSecret?: boolean) =>
    invoke<string>("test_connection", { profile, secret: secret || null, clearSecret: !!clearSecret }),

  listBuckets: (profileId: string) =>
    read<{ name: string; created: number | null }[]>("list_buckets", { profileId }),
  createBucket: (profileId: string, bucket: string) => invoke<void>("create_bucket", { profileId, bucket }),
  listObjects: (profileId: string, bucket: string, prefix: string, token?: string | null) =>
    read<ListResult>("list_objects", { profileId, bucket, prefix, token: token ?? null }),
  /** With an `opId`, matches stream in as `search-progress` events and `cancelTransfer(opId)` stops it. */
  searchObjects: (profileId: string, bucket: string, prefix: string, query: string, opId?: string) =>
    read<SearchResult>("search_objects", { profileId, bucket, prefix, query, opId: opId ?? null }),
  headObject: (profileId: string, bucket: string, key: string) =>
    read<ObjectDetails>("head_object", { profileId, bucket, key }),
  /**
   * The whole object as bytes, for previews rendered in the app (PDF). Rejects above `maxBytes`.
   * `cache` reads through the file cache (documents); thumbnails leave it off. `listed` (the
   * listing's version) lets a cached copy answer without a request to the server.
   */
  objectBytes: (profileId: string, bucket: string, key: string, maxBytes: number, cache = false, listed?: { etag?: string | null; size: number }) =>
    invoke<ArrayBuffer>("get_object_bytes", { profileId, bucket, key, maxBytes, cache, etag: listed?.etag ?? null, size: listed?.etag ? listed.size : null }),
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

  /**
   * Copies or moves keys/prefixes. `destBucket` (same connection) copies across buckets
   * server-side; null keeps them in `bucket`. Keeps Content-Type and metadata, also for big files.
   */
  moveMany: (
    profileId: string,
    bucket: string,
    items: { from: string; to: string; isPrefix: boolean }[],
    deleteSource: boolean,
    opId: string,
    destBucket?: string | null,
  ) => invoke<OpResult>("move_many", { profileId, bucket, items, deleteSource, opId, destBucket: destBucket ?? null }),

  /**
   * Which of these already exist, for name-clash prompts before upload, rename, new folder,
   * move and copy. A prefix "exists" when at least one key starts with it. At most a few
   * thousand entries per call; the backend checks them concurrently.
   */
  existing: (profileId: string, bucket: string, keys: string[], prefixes: string[] = []) =>
    read<{ keys: string[]; prefixes: string[] }>("existing_keys", { profileId, bucket, keys, prefixes }),

  /** Replaces the object's headers in place (copy onto itself, metadata REPLACE). Omitted fields keep their value. */
  updateObjectProps: (profileId: string, bucket: string, key: string, props: ObjectProps) =>
    invoke<ObjectDetails>("update_object_props", { profileId, bucket, key, props }),
  objectTags: (profileId: string, bucket: string, key: string) =>
    read<Record<string, string>>("get_object_tags", { profileId, bucket, key }),
  setObjectTags: (profileId: string, bucket: string, key: string, tags: Record<string, string>) =>
    invoke<void>("put_object_tags", { profileId, bucket, key, tags }),

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
  /**
   * Resolves to the local path actually written. Unless `overwrite`, an existing file is kept
   * and the download gets a free name ("photo (1).jpg"), like Finder. Paths with ".." parts are
   * refused. Retrying the same id resumes from the partial file where possible. `listed` is the
   * version the listing showed: when the file cache holds it, the download is a local copy.
   */
  startDownload: (
    id: string,
    profileId: string,
    bucket: string,
    key: string,
    destPath: string,
    overwrite = false,
    listed?: { etag: string; size: number },
  ) => invoke<string>("start_download", { id, profileId, bucket, key, destPath, overwrite, etag: listed?.etag ?? null, size: listed?.size ?? null }),
  cancelTransfer: (id: string) => invoke<void>("cancel_transfer", { id }),
  /** Transfers still queued or running, including ones started before this page loaded. */
  activeTransfers: () => invoke<Omit<Transfer, "speed" | "error">[]>("active_transfers"),
  /** Paused and failed transfers kept across restarts: start them again under the same id to carry on. */
  keptTransfers: () => invoke<KeptTransfer[]>("kept_transfers"),
  /** Stops a transfer but keeps what it did (partial file, parts sent), to carry on from later. */
  pauseTransfer: (id: string) => invoke<void>("pause_transfer", { id }),
  /** Pauses every queued or running transfer; resolves to how many. */
  pauseAllTransfers: () => invoke<number>("pause_all_transfers"),
  /** Moves a transfer still waiting for its turn to the front of its connection's queue. */
  moveTransferToTop: (id: string) => invoke<boolean>("move_transfer_to_top", { id }),

  clearThumbnailCache: () => invoke<number>("clear_thumbnail_cache"),
  /** Bytes in the thumbnail cache and in the cache of recently opened files. */
  cacheUsage: () => invoke<{ thumbnails: number; files: number }>("cache_usage"),
  /** Clears both caches; resolves to the bytes freed. */
  clearCaches: () => invoke<number>("clear_caches"),

  // photo placeholders (ThumbHash, see placeholders.rs and thumbhash.ts); null = none known
  placeholdersLookup: (profileId: string, root: string, items: PlaceholderItem[]) =>
    invoke<(string | null)[]>("placeholders_lookup", { profileId, root, items }),
  placeholderHead: (profileId: string, root: string, item: PlaceholderItem) =>
    invoke<string | null>("placeholder_head", { profileId, root, key: item.key, etag: item.etag, size: item.size }),
  /** the folder's shared index: `[etag, size, hash]` by name (empty when it has none) */
  placeholdersFolder: (profileId: string, root: string, prefix: string) =>
    invoke<Record<string, [string, number, string]>>("placeholders_folder", { profileId, root, prefix }),
  placeholdersFolderSave: (profileId: string, root: string, prefix: string, known: (PlaceholderItem & { hash: string })[], present: string[] | null) =>
    invoke<void>("placeholders_folder_save", { profileId, root, prefix, known, present }),
  placeholderFromThumbnail: (profileId: string, root: string, item: PlaceholderItem, jpeg: Uint8Array) =>
    invoke<string | null>("placeholder_from_thumbnail", { profileId, root, key: item.key, etag: item.etag, size: item.size, jpeg: Array.from(jpeg) }),

  /** Names and sizes of files from the system picker (paths, or URIs on phones). */
  pickedFiles: (uris: string[]) =>
    invoke<{ path: string; name: string; size: number }[]>("picked_files", { uris }),
  /** Where downloads are saved without asking (phones; Downloads on desktop). */
  downloadFolder: () => invoke<string>("download_folder"),
  /** A per-app temporary folder (for "open in default app" on desktop); cleaned on start. */
  tempFolder: () => invoke<string>("temp_folder"),

  /** Bytes and object count under a prefix; progress as `size-progress` events, cancel with `cancelTransfer(opId)`. */
  folderSize: (profileId: string, bucket: string, prefix: string, opId: string) =>
    invoke<{ bytes: number; objects: number }>("folder_size", { profileId, bucket, prefix, opId }),

  /** Opens a local file in its default app (desktop) or an "Open with" chooser (phones). */
  openLocal: (path: string) => invoke<void>("open_local", { path }),
  /** puts a local file on the clipboard as a file (pastes into chats, mail, Finder); macOS */
  copyFileToClipboard: (path: string) => invoke<void>("copy_file_to_clipboard", { path }),
  /**
   * Starts the system's drag of items out of the window (desktop/dragOut.ts), from where the
   * pointer is; fails when nothing can go or the button is already up. Promised items (macOS)
   * come back as `drag-out-promise` events, answered with `dragOutDone`.
   */
  startDragOut: (token: string, items: { path: string | null; name: string; folder: boolean }[], image: string | null) =>
    invoke<void>("start_drag_out", { token, items, image }),
  dragOutDone: (token: string, index: number, error: string | null) => invoke<void>("drag_out_done", { token, index, error }),
  /** Shows the file in Finder / Explorer / the file manager. Desktop only. */
  revealLocal: (path: string) => invoke<void>("reveal_local", { path }),
  /**
   * The apps that open a file called `name` (only the extension counts, so a file not downloaded
   * yet works too) or, with `folder`, a folder. Default first. Desktop; empty on phones.
   */
  appsFor: (name: string, folder: boolean) => invoke<AppChoice[]>("apps_for", { name, folder }),
  /** Opens a local file or folder with `app` (an `AppChoice.path`; "" is the default app). */
  openWith: (path: string, app: string) => invoke<void>("open_with", { path, app }),
  /** Windows: the system's "How do you want to open this file?" window. */
  openWithChooser: (path: string) => invoke<void>("open_with_chooser", { path }),
  /** System share sheet with local files (phones; macOS share menu where available). */
  shareFiles: (paths: string[]) => invoke<void>("share_files", { paths }),
  /** System share sheet with text, such as a share link. */
  shareText: (text: string) => invoke<void>("share_text", { text }),
  /** iOS: adds an image or video to Photos. Android: copies it into Pictures/Kybl. */
  saveToPhotos: (path: string) => invoke<void>("save_to_photos", { path }),
  /** Light haptic feedback on phones; a no-op elsewhere. Never throws. */
  haptic: (kind: "selection" | "light" | "medium" | "success" | "warning" | "error") =>
    invoke<void>("haptic", { kind }).catch(() => {}),
  /**
   * Files other apps shared into Kybl (Android share sheet / iOS) that are waiting for an
   * upload destination. Taking them clears the queue. New ones also arrive as a
   * `shared-files` event with the same payload; the event doesn't clear the queue, so on the
   * event call `takeSharedFiles()` (and once at start-up) and use what it returns.
   */
  takeSharedFiles: () => invoke<{ path: string; name: string; size: number }[]>("take_shared_files"),

  // App lock (additive, native round): unlock prompt + privacy screen. The UI owns the setting.
  /**
   * Face ID / Touch ID / fingerprint, falling back to the device passcode. Resolves true when
   * unlocked, false when cancelled; rejects when the phone has no screen lock (and on desktop).
   */
  biometricUnlock: (reason: string) => invoke<boolean>("biometric_unlock", { reason }),
  /**
   * While app lock is on: Android keeps the app out of the app switcher's preview and
   * screenshots (FLAG_SECURE); iOS blurs it while inactive. Call at start-up with the setting
   * and whenever it changes. No-op on desktop.
   */
  setPrivacyScreen: (enabled: boolean) => invoke<void>("set_privacy_screen", { enabled }),
  /**
   * Computers: how many documents open in the editor have unsaved changes. Quitting (and closing
   * the window when it quits the app) asks first while any do. Never throws (phones don't quit).
   */
  setUnsavedDocuments: (count: number) => invoke<void>("set_unsaved_documents", { count }).catch(() => {}),
  /**
   * Phones: writes bytes the web view holds (a photo or video just taken with the camera picker)
   * to a new file in the temporary folder and resolves to its path, for `startUpload`. The bytes
   * go as the raw request body; the file name (URI-encoded) in the `x-file-name` header.
   */
  writeTempFile: (name: string, data: ArrayBuffer, appendTo?: string) =>
    invoke<string>("write_temp_file", new Uint8Array(data), {
      // `appendTo`: a path an earlier call returned; these bytes go on its end (big files in chunks)
      headers: appendTo ? { "x-file-name": encodeURIComponent(name), "x-append-to": encodeURIComponent(appendTo) } : { "x-file-name": encodeURIComponent(name) },
    }),

  /** Transfer tuning; the backend applies changes to new transfers right away. */
  transferPrefs: () => invoke<TransferPrefs>("get_transfer_prefs"),
  setTransferPrefs: (p: Partial<TransferPrefs>) => invoke<TransferPrefs>("set_transfer_prefs", { prefs: p }),

  // WP0: storage core. Every command above also works for non-S3 connections (and for
  // LOCAL_ID) with `bucket` = a root id from `listRoots`, except presign / props / tags, which
  // reject where `capabilities` says the connection can't.
  /** Where browsing starts: buckets, drives, one server folder, or this device's folders. */
  listRoots: (profileId: string) => read<RootInfo[]>("list_roots", { profileId }),
  /** What the connection can do; `useCaps` caches it per connection. */
  capabilities: (profileId: string) => invoke<Capabilities>("connection_capabilities", { profileId }),
  /**
   * The real path of a key, for connections that are this device's disk (`localPaths`), e.g. to
   * download into the folder a local pane shows. Null elsewhere or outside the root.
   */
  localPath: (profileId: string, bucket: string, key: string) =>
    invoke<string | null>("local_path", { profileId, bucket, key }),
};

/** An app from `appsFor`: "Open with ▸" lists these. */
export type AppChoice = {
  name: string;
  /** what `openWith` takes: the app bundle on macOS, "" for "the default app" on Windows / Linux */
  path: string;
  isDefault: boolean;
  /** a small PNG data URL (macOS) */
  icon: string | null;
};

/** Editable object headers; see `updateObjectProps`. `metadata` replaces all user metadata when given. */
export type ObjectProps = {
  contentType?: string | null;
  cacheControl?: string | null;
  contentDisposition?: string | null;
  contentEncoding?: string | null;
  storageClass?: string | null;
  metadata?: Record<string, string>;
};

/** A transfer the backend keeps to carry on (`kept_transfers`). */
export type KeptTransfer = {
  id: string;
  kind: "upload" | "download";
  name: string;
  profileId: string;
  bucket: string;
  key: string;
  local: string;
  /** a download: the path first asked for */
  requested: string;
  overwrite: boolean;
  bytes: number;
  total: number;
  state: "paused" | "error";
  error: string | null;
};

export type TransferPrefs = {
  /** Files transferred at the same time per connection, 1..8 (default 3). */
  concurrency: number;
  /** Multipart parts in flight per file, 1..8 (default 4). */
  partConcurrency: number;
  /** Download speed cap in KiB/s, shared fairly by every running download; 0 = unlimited. */
  downloadLimitKbps: number;
  /** Upload speed cap in KiB/s, shared fairly by every running upload; 0 = unlimited. */
  uploadLimitKbps: number;
  /** After each transfer: compare nothing, the size, or a checksum where both sides have one (else the size). */
  verify: "off" | "size" | "checksum";
  /** Phones: only transfer (and fetch thumbnails) on Wi-Fi / unmetered networks. */
  wifiOnly: boolean;
};

/**
 * Native app events (listen with `@tauri-apps/api/event`):
 * - `menu` (string): macOS menu bar / app menu item ids: "new-folder", "upload-files",
 *   "upload-folder", "download", "refresh", "go-up", "back", "forward", "go-to", "search",
 *   "select-all", "delete", "rename", "duplicate" (⌘D), "get-info", "edit" (⌘E), "settings", "new-connection".
 *   Panes (View menu): "split-right" (⌘\), "split-down" (⇧⌘\), "close-pane",
 *   "swap-panes" (⇧⌘S), "same-folder", "compare-folders", "pane-copy" (F5), "pane-move" (F6),
 *   "switch-pane", "toggle-hidden", "toggle-sidebar" (⌥⌘S), "filter-connections" (⌥⌘F), "tiles-bigger" (⌘+), "tiles-smaller" (⌘−), "toggle-compact" (all in the View menu).
 *   Workspaces (Window menu): "new-workspace" (⌘T), "prev-workspace" (⇧⌘[), "next-workspace" (⇧⌘]),
 *   "move-workspace-left", "move-workspace-right", "rename-workspace", "workspace-settings",
 *   "close-workspace". "command-palette" (⌘K, View menu): handled by palette/usePalette.tsx.
 *   "toggle-terminal" (⌃`, View menu): a terminal below the active pane, or back and forth to it.
 * - `shared-files`: see `takeSharedFiles`.
 * - `open-transfers` (null): a transfer notification was tapped (phones).
 * - `app-resumed` (null): the app came back to the foreground (phones; desktop on window focus).
 */
export type NativeEvent = "menu" | "shared-files" | "open-transfers" | "app-resumed";

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

// ---------------------------------------------------------------- WP-D: documents (src/viewers)

/** What the backend knows about an opened or saved document. ETags come without quotes. */
export type DocMeta = {
  etag: string | null;
  size: number;
  modified: number | null;
  contentType: string | null;
  version: string | null;
  /** a save that went through but couldn't keep something (the file's tags) */
  warning?: string;
};

/**
 * What a save expects to find:
 * - `match`: the file as it was opened (anything else is a conflict),
 * - `absent`: a new name ("Save as copy"); `headersFrom` lends its content type and headers,
 * - `any`: overwrite whatever is there.
 */
export type DocPrecondition =
  | { kind: "match"; etag: string | null; size: number; modified: number | null; version: string | null }
  | { kind: "absent"; headersFrom?: string | null }
  | { kind: "any" };

/** A save was refused because the file changed (or, with `current` null, was deleted) meanwhile. */
export class DocConflict extends Error {
  current: DocMeta | null;
  constructor(current: DocMeta | null) {
    super(current ? "This file was changed somewhere else since you opened it." : "This file was deleted since you opened it.");
    this.current = current;
  }
}

/** The opened state as a `match` precondition for the next save. */
export const expectMeta = (m: DocMeta): DocPrecondition => ({ kind: "match", etag: m.etag, size: m.size, modified: m.modified, version: m.version });

/**
 * The whole file plus its metadata, from one read. The body is framed as
 * `[u32 BE json length][json DocMeta][bytes]`. Rejects above `maxBytes`.
 */
export async function docOpen(profileId: string, bucket: string, key: string, maxBytes: number): Promise<{ meta: DocMeta; bytes: Uint8Array }> {
  const raw = await read<ArrayBuffer>("doc_open", { profileId, root: bucket, path: key, maxBytes });
  const len = new DataView(raw).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, len))) as DocMeta;
  return { meta, bytes: new Uint8Array(raw, 4 + len) };
}

/** Saves `bytes` (sent raw, no JSON) if `expect` still holds; throws `DocConflict` otherwise. */
export async function docSave(profileId: string, bucket: string, key: string, bytes: Uint8Array, expect: DocPrecondition): Promise<DocMeta> {
  try {
    return await invoke<DocMeta>("doc_save", bytes, {
      headers: {
        // IPC headers must be plain ASCII
        "x-kybl-profile": encodeURIComponent(profileId),
        "x-kybl-root": encodeURIComponent(bucket),
        "x-kybl-path": encodeURIComponent(key),
        "x-kybl-expect": encodeURIComponent(JSON.stringify(expect)),
      },
    });
  } catch (e) {
    const msg = errMessage(e);
    if (msg.startsWith("CONFLICT\n\n")) throw new DocConflict(JSON.parse(msg.slice(10)) as DocMeta | null);
    throw e;
  }
}

// ---------------------------------------------------------------- WP0: storage core

export type { ConnKind } from "./types";

/** The reserved connection id of this computer or phone. Never in `listProfiles`. */
export const LOCAL_ID = "local";

export type RootKind =
  | "bucket"
  | "drive"
  | "shared"
  | "folder"
  | "home"
  | "desktop"
  | "documents"
  | "downloads"
  | "volume";

/**
 * A place browsing starts in. `id` is what every command takes as `bucket`; show `name`.
 * For LOCAL_ID the id is the folder's absolute path.
 */
export type RootInfo = {
  id: string;
  name: string;
  kind: RootKind;
  created: number | null;
  readOnly: boolean;
};

/** What a connection can do; the UI hides what it can't. */
export type Capabilities = {
  /** "single": one root, so skip the root level; "drives": a few named roots. */
  roots: "buckets" | "single" | "drives";
  createRoot: boolean;
  /** "prefix": folders are key prefixes (empty ones need a marker). */
  folders: "prefix" | "real";
  /** "copy-delete": renaming a folder copies everything, so warn for big ones. */
  rename: "native" | "copy-delete";
  serverCopy: "none" | "same-root" | "cross-root";
  /** "none": hide "Share link". */
  share: "presign" | "link" | "none";
  shareExpiry: boolean;
  /** "proxy": media plays through the app's media:// scheme instead of a presigned URL. */
  streaming: "presign" | "proxy";
  rangeRead: boolean;
  conditionalWrite: "if-match" | "compare" | "rev" | "none";
  hashes: Array<"md5" | "sha1" | "sha256" | "quickxor" | "dropbox">;
  thumbnails: "local" | "remote" | "local+remote";
  /** "s3": the Properties editor (headers, metadata). */
  metadata: "s3" | "none";
  tags: boolean;
  storageClass: boolean;
  /** Deleting moves things to a trash the user can restore from (say "Move to Trash"). */
  trash: boolean;
  versions: boolean;
  search: "scan" | "server";
  changes: boolean;
  multipart: boolean;
  maxObjectSize: number | null;
  /** iOS background uploads can work. */
  backgroundUpload: boolean;
  /** Files are real files on this device: `localPath`, open and reveal work on them. */
  localPaths: boolean;
  /** Unix permissions can be changed (SFTP; FTP servers with SITE CHMOD): "Permissions…". */
  permissions?: boolean;
  /** Symbolic links are told apart, traced ("Show original") and made ("Make link…"). */
  links?: boolean;
};

// ---------------------------------------------------------------- WP-B1: copying between connections (src/jobs)

/**
 * What to do when a file is already at the destination:
 * - `skipIdentical` (default): skip it when it has the same size (and the same content hash or a
 *   time no older than the source's), copy it over otherwise
 * - `skip`: never touch what is there
 * - `overwrite`: always replace it
 * - `keepBoth`: copy next to it as "name (1).ext"
 * - `newerWins`: replace it only when the source was changed more recently
 */
export type JobConflict = "skipIdentical" | "skip" | "overwrite" | "keepBoth" | "newerWins";

/**
 * A copy or move between any two places, even on different connections (or this device,
 * LOCAL_ID). `items` are files and folders (`isDir`, path ending with "/") in `src.root`; each
 * lands inside `dst.dir` under its own name. A folder item with path "" means everything in the
 * root (its contents go straight into `dst.dir`).
 */
export type JobSpec = {
  /** leave empty: the backend picks one */
  id?: string;
  mode: "copy" | "move";
  src: { profileId: string; root: string; items: { path: string; isDir: boolean }[] };
  /** `dir` is "" for the top of the root, else ends with "/" */
  dst: { profileId: string; root: string; dir: string };
  conflict: JobConflict;
  /**
   * `size`: sizes must match. `hash`: also compares content hashes where both sides have one
   * (S3 uploads are always checked by the server per part, with Content-MD5). Move only deletes
   * an original once its copy is verified.
   */
  verify: "size" | "hash";
  /** keep modification times where the destination stores them (this device, SFTP) */
  preserveMtime: boolean;
  /** names or paths to leave out, with `*`, `?` and `**` (".DS_Store", "node_modules/", "*.tmp") */
  ignore: string[];
  /** shown in the jobs list, e.g. "Photos to Kybl Storage"; the backend makes one when empty */
  title?: string;
  /**
   * Mirror (src/mirror): exactly these copies (paths relative to the one source folder and to
   * `dst.dir`; folders end with "/"), then these deletions at the destination. Listed jobs keep
   * only the counts.
   */
  mirror?: {
    copy?: { rel: string; size?: number; mtime?: number | null; md5?: string | null }[];
    delete?: string[];
    copies?: number;
    deletes?: number;
  };
};

export type JobState = "planning" | "running" | "paused" | "waitingNetwork" | "needsAuth" | "done" | "failed" | "cancelled";

/** Event `job-progress`, at most 4 a second per job (and once on every state change). */
export type JobProgress = {
  id: string;
  state: JobState;
  /** what a running job is doing right now */
  phase: "planning" | "copying" | "deleting" | "finished";
  filesDone: number;
  filesTotal: number;
  filesFailed: number;
  filesSkipped: number;
  bytesDone: number;
  bytesTotal: number;
  /** bytes per second, smoothed */
  rateBps: number;
  etaSecs: number | null;
  /** paths being copied right now */
  current: string[];
  /** why a job failed or waits (needsAuth, waitingNetwork) */
  error: string | null;
};

export type JobSummary = {
  id: string;
  title: string;
  spec: JobSpec;
  created: number;
  updated: number;
  progress: JobProgress;
};

export type JobFailure = { path: string; error: string };

export const jobsApi = {
  /** Plans and starts the job right away; resolves to its id. Jobs survive restarts. */
  jobCreate: (spec: JobSpec) => invoke<string>("job_create", { spec }),
  /** Every job, newest first, including finished ones until deleted. */
  jobList: () => invoke<JobSummary[]>("job_list"),
  jobPause: (id: string) => invoke<void>("job_pause", { id }),
  jobResume: (id: string) => invoke<void>("job_resume", { id }),
  /** Stops for good (copies already made stay); unfinished uploads are cleaned up. */
  jobCancel: (id: string) => invoke<void>("job_cancel", { id }),
  /** Removes a job that isn't running from the list. */
  jobDelete: (id: string) => invoke<void>("job_delete", { id }),
  jobFailures: (id: string, offset = 0, limit = 100) => invoke<JobFailure[]>("job_failures", { id, offset, limit }),
  /** Puts the failed files back in line and runs the job again. */
  jobRetryFailed: (id: string) => invoke<void>("job_retry_failed", { id }),
};

// ---------------------------------------------------------------- WP-A2: cloud drive sign-in

/** The kinds that sign in in the browser (Google Drive, OneDrive, Dropbox). */
export type CloudKind = "gdrive" | "onedrive" | "dropbox";

/**
 * "Use your own OAuth app": the user's client ID (and secret, for Google "Desktop" clients).
 * The secret goes to the vault (`{id}#oauth`), never into the profile.
 */
export type OAuthClient = {
  clientId: string;
  clientSecret?: string | null;
  /** Microsoft: a tenant id or domain for apps limited to one organization ("common" when empty). */
  tenant?: string | null;
};

/** Payload of the `connection-auth` event (see `CONNECTION_AUTH_EVENT`). */
export type ConnectionAuthEvent = { profileId: string };

/**
 * Emitted when a sign-in connection's access is gone for good (revoked, expired, password changed).
 * Its commands fail until the user reconnects: show "Reconnect", which calls
 * `oauthStart(kind, flowId, null, profileId)`. See src-tauri/src/oauth/README.md.
 */
export const CONNECTION_AUTH_EVENT = "connection-auth";

/**
 * Signs in to a cloud drive in the browser and saves the connection. Resolves with the new profile
 * (or, with `replaceId`, the same profile updated: Reconnect keeps the id, open tabs and sync
 * folders). Rejects with "Cancelled" after `oauthCancel(flowId)`.
 */
export const oauthStart = (kind: CloudKind, flowId: string, client?: OAuthClient | null, replaceId?: string | null) =>
  invoke<Profile>("oauth_start", { kind, flowId, client: client ?? null, replaceId: replaceId ?? null });

/** Stops a sign-in that is waiting for the browser. */
export const oauthCancel = (flowId: string) => invoke<void>("oauth_cancel", { flowId });

/** Which kinds this build can sign in to on its own; false: show "Needs your own client ID". */
export const oauthBuiltinClients = () => invoke<Record<CloudKind, boolean>>("oauth_builtin_clients");

// ---------------------------------------------------------------- WP-E4: drives ("Mount as drive")

/** Where a drive is at (desktop only; see src-tauri/src/mount). */
export type MountState = "mounting" | "mounted" | "unmounted" | "error" | "unsupported" | "removed";

/** A connection, root or folder shown as a drive in Finder / the file manager. */
export type MountInfo = {
  id: string;
  profileId: string;
  /** "" = every root of the connection, as top-level folders */
  bucket: string;
  /** "" or a folder ending with "/" */
  prefix: string;
  name: string;
  readOnly: boolean;
  state: MountState;
  /** why it isn't mounted ("message\n\ndetail", see ErrorText) */
  error: string | null;
  /** the folder (or drive letter) the system mounted it at */
  mountPoint: string | null;
  /** saves waiting to upload or uploading, their bytes, and bytes sent so far */
  uploading: number;
  uploadBytes: number;
  uploadSent: number;
  /** why a waiting upload failed last; Kybl keeps trying */
  uploadError: string | null;
  /** something to tell the user once (a save kept as a conflict copy); clear with mountDismiss */
  notice: string | null;
  cacheBytes: number;
};

/** Emitted with a `MountInfo` whenever a drive changes (state "removed" when it's gone). */
export const MOUNT_STATUS_EVENT = "mount-status";

export const mountApi = {
  mountList: () => invoke<MountInfo[]>("mount_list"),
  /** Saves the drive and mounts it; resolves with its state (which may be "error"). */
  mountAdd: (profileId: string, bucket: string, prefix: string, name?: string | null) =>
    invoke<MountInfo>("mount_add", { profileId, bucket, prefix, name: name ?? null }),
  /** Unmounts and forgets the drive. Rejects while saves from it still wait to upload. */
  mountRemove: (id: string) => invoke<void>("mount_remove", { id }),
  /** Opens the mounted drive in Finder / the file manager. */
  mountReveal: (id: string) => invoke<void>("mount_reveal", { id }),
  /** Mounts again after an error or an unmount. */
  mountRetry: (id: string) => invoke<MountInfo>("mount_retry", { id }),
  /** Unmounts but keeps the drive in the list. */
  mountEject: (id: string) => invoke<MountInfo>("mount_eject", { id }),
  mountDismiss: (id: string) => invoke<void>("mount_dismiss", { id }),
};

// WP-C ─── phone backup ───────────────────────────────────────────────────────────────────────

/** What a backup set copies: the camera roll, an Android folder, or an iOS Files folder. */
export type BackupSource =
  | { type: "cameraRoll" }
  | { type: "androidTree"; uri: string; label: string }
  | { type: "iosBookmark"; bookmark: string; label: string };

/** One thing the phone backs up, to one connection. */
export interface BackupSet {
  id: string;
  source: BackupSource;
  profileId: string;
  root: string;
  /** folder inside root: "" or "phone/photos/" */
  destPrefix: string;
  /** "Connection › bucket/folder", for showing */
  destLabel: string;
  /** naming template, e.g. "{yyyy}/{MM}/{name}" */
  template: string;
  includeVideos: boolean;
  livePhotoVideo: boolean;
  heic: "keep" | "convertJpeg";
  edited: "current" | "original" | "both";
  wifiOnly: boolean;
  chargingOnly: boolean;
  /** only items made after this (ms); null backs up everything */
  since: number | null;
  /** false: paused */
  enabled: boolean;
  created: number;
}

export type BackupRunState = "idle" | "running" | "waitingWifi" | "waitingNetwork" | "needsAuth" | "paused";

export interface BackupSetStatus {
  set: BackupSet;
  state: BackupRunState;
  backedUp: number;
  pending: number;
  failed: number;
  lastRun: number | null;
  lastError: string | null;
  current: { name: string; done: number; total: number } | null;
  runDone: number;
  runTotal: number;
}

export interface BackupFailure {
  sourceId: string;
  name: string;
  error: string;
  at: number;
  attempts: number;
}

export type PhotoAccess = "granted" | "limited" | "denied" | "notDetermined" | "unsupported";

export interface BackupPermission {
  photos: PhotoAccess;
  /** Android 13+: videos are a separate permission */
  videos?: PhotoAccess;
  /** photo locations are kept */
  location?: boolean;
  /** the progress notification can show */
  notifications?: boolean;
  sdk?: number;
}

export interface BackupOverview {
  platform: "android" | "ios" | "desktop";
  sets: BackupSetStatus[];
}

/** Sent with a BackupSetStatus whenever a set's progress or state changes. */
export const BACKUP_STATUS_EVENT = "backup-status";

/** A set as the setup sends it: no id creates one. */
export type BackupSetDraft = Partial<BackupSet> & Pick<BackupSet, "source" | "profileId" | "root">;

export const backupApi = {
  overview: () => invoke<BackupOverview>("backup_overview"),
  /** creates (empty id) or changes a set */
  save: (set: BackupSetDraft) => invoke<BackupSetStatus>("backup_save", { set }),
  delete: (id: string) => invoke<void>("backup_delete", { id }),
  setPaused: (id: string, paused: boolean) => invoke<BackupSetStatus>("backup_set_paused", { id, paused }),
  /** every set when id is omitted */
  runNow: (id?: string) => invoke<void>("backup_run_now", { id: id ?? null }),
  cancel: (id?: string) => invoke<void>("backup_cancel", { id: id ?? null }),
  failures: (id: string) => invoke<BackupFailure[]>("backup_failures", { id }),
  /** how many failed items will be tried again */
  retry: (id: string) => invoke<number>("backup_retry", { id }),
  permission: () => invoke<BackupPermission>("backup_permission"),
  requestPermission: () => invoke<BackupPermission>("backup_request_permission"),
  /** iOS limited access: choose more photos; elsewhere the app's settings */
  manageAccess: () => invoke<unknown>("backup_manage_access"),
  /** null when the picker was closed */
  pickFolder: () => invoke<BackupSource | null>("backup_pick_folder"),
};
