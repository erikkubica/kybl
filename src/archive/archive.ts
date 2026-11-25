/**
 * Archives (.zip, .tar, .tar.gz) in panes: an archive opens like a folder, read-only, as its own
 * connection whose id names where the archive is (src-tauri/src/archive). This module is small
 * and safe to import anywhere: names, ids and the backend calls.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Profile } from "../core/types";
import { LOCAL_ID } from "../core/api";

export const ARCHIVE_PREFIX = "archive:";

export type ArchiveFormat = "zip" | "tar" | "targz";

export function archiveFormat(name: string): ArchiveFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith(".zip")) return "zip";
  if (n.endsWith(".tar.gz") || n.endsWith(".tgz")) return "targz";
  if (n.endsWith(".tar")) return "tar";
  return null;
}

export const isArchiveName = (name: string) => archiveFormat(name) !== null;
export const isArchiveId = (profileId: string | null | undefined) => !!profileId?.startsWith(ARCHIVE_PREFIX);

/** "site-backup.tar.gz" → "site-backup"; a stem that is nothing or only dots (".zip", "...zip": ".." would be the parent folder) → "extracted" */
export function archiveStem(name: string): string {
  const m = /\.(tar\.gz|tgz|zip|tar)$/i.exec(name);
  const s = m ? name.slice(0, m.index) : name;
  return /^\.*$/.test(s) ? "extracted" : s;
}

const b64url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** Where an archive is: the same encoding as the backend's `archive::encode_id`. */
export type ArchiveOrigin = { profileId: string; root: string; key: string };

export function archiveId(o: ArchiveOrigin): string {
  return ARCHIVE_PREFIX + b64url(`${o.profileId}\n${o.root}\n${o.key}`);
}

export function archiveOrigin(id: string | null | undefined): ArchiveOrigin | null {
  if (!isArchiveId(id)) return null;
  try {
    const [profileId, root, ...rest] = unb64url(id!.slice(ARCHIVE_PREFIX.length)).split("\n");
    return root === undefined ? null : { profileId, root, key: rest.join("\n") };
  } catch {
    return null;
  }
}

/**
 * The pane's stand-in connection for an open archive: named and drawn like the connection the
 * archive is on, so the header still says where it is.
 */
export function archiveProfile(id: string, profiles: Profile[], local?: Profile): Profile | null {
  const o = archiveOrigin(id);
  if (!o) return null;
  const from = o.profileId === LOCAL_ID ? local : profiles.find((p) => p.id === o.profileId);
  return { id, name: from?.name ?? "Archive", kind: "unknown", provider: from?.provider ?? "local", endpoint: "", region: "", accessKeyId: "", pathStyle: false };
}

export type ArchiveInfo = {
  id: string;
  root: string;
  format: ArchiveFormat;
  files: number;
  folders: number;
  bytes: number;
  skipped: { unsafePaths: number; links: number; encrypted: number; other: number };
};

export type ExtractJob = {
  srcProfileId: string;
  srcRoot: string;
  srcKey?: string;
  paths?: string[];
  base?: string;
  renames?: Record<string, string>;
  destProfileId: string;
  destRoot: string;
  destDir: string;
  folder?: string | null;
  overwrite?: boolean;
  local?: string | null;
};

export const archiveApi = {
  /** `opId`: `cancel_transfer` with it stops the open; `archive-open-progress` events say how much of a .tar.gz is unpacked. */
  open: (profileId: string, root: string, key: string, local: string | null, opId?: string) => invoke<ArchiveInfo>("archive_open", { profileId, root, key, local, opId: opId ?? null }),
  extract: (id: string, job: ExtractJob) => invoke<void>("archive_extract", { id, job }),
  compress: (id: string, job: { profileId: string; root: string; items: string[]; destKey: string }) => invoke<void>("archive_compress", { id, job }),
};

/** What the index left out, in a sentence (or null). */
export function skippedNote(s: ArchiveInfo["skipped"]): string | null {
  const parts: string[] = [];
  const n = (c: number, one: string, many: string) => `${c.toLocaleString()} ${c === 1 ? one : many}`;
  if (s.unsafePaths) parts.push(n(s.unsafePaths, "item whose path leads outside the archive", "items whose paths lead outside the archive"));
  if (s.links) parts.push(n(s.links, "link", "links"));
  if (s.encrypted) parts.push(n(s.encrypted, "password-protected file", "password-protected files"));
  if (s.other) parts.push(n(s.other, "special item", "special items"));
  return parts.length ? `Not shown: ${parts.join(", ")}.` : null;
}
