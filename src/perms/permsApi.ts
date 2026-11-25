/**
 * Unix permissions and symbolic links on servers (src-tauri/src/storage/perms.rs): SFTP, and FTP
 * servers that take SITE CHMOD. Connections without them (`caps.permissions`, `caps.links`) never
 * offer these.
 */
import { invoke } from "@tauri-apps/api/core";
import type { OpResult } from "../core/api";
import type { Entry, ObjInfo } from "../core/types";

/** "Apply to enclosed items": everything inside, or only the files or the folders. */
export type Recurse = "all" | "files" | "folders";

export const permsApi = {
  /**
   * Turns `set` bits on and `clear` bits off on each item (bits in neither stay as each item had
   * them). With `recurse`, what is inside the folders too (links aren't followed). Reports
   * `move-progress` with phase "permissions" under `opId`.
   */
  set: (profileId: string, bucket: string, items: Entry[], set: number, clear: number, recurse: Recurse | null, opId: string) =>
    invoke<OpResult>("set_permissions", {
      profileId,
      bucket,
      items: items.map((e) => ({ key: e.key, isDir: e.kind === "folder", mode: e.mode ?? null })),
      set,
      clear,
      recurse,
      opId,
    }),
  /** What a link finally points at, in the same root (a key ending with "/" for a folder). */
  resolveLink: (profileId: string, bucket: string, key: string) => invoke<ObjInfo>("resolve_link", { profileId, bucket, key }),
  /** A symbolic link at `key` to `target` (relative to the link's folder, or absolute on the server). */
  makeLink: (profileId: string, bucket: string, key: string, target: string) => invoke<void>("make_link", { profileId, bucket, key, target }),
};

/** `rw-r--r--` for 0o644, with s/S and t/T for the special bits, like `ls -l`. */
export function modeText(mode: number): string {
  let out = "";
  for (let i = 0; i < 9; i++) {
    const on = (mode & (1 << (8 - i))) !== 0;
    const special = i === 2 ? mode & 0o4000 : i === 5 ? mode & 0o2000 : i === 8 ? mode & 0o1000 : 0;
    if (special) out += i === 8 ? (on ? "t" : "T") : on ? "s" : "S";
    else out += on ? "rwx"[i % 3] : "-";
  }
  return out;
}

/** "644", or "4755" with special bits. */
export const modeOctal = (mode: number) => (mode & 0o7777).toString(8).padStart(3, "0");
