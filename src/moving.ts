import { parentPrefix } from "./format";
import type { Entry } from "./types";

/** Prefix an entry currently lives in. */
export function entryParent(e: Entry): string {
  return e.kind === "folder" ? parentPrefix(e.key) : e.key.slice(0, e.key.lastIndexOf("/") + 1);
}

/** Key the entry gets when moved/copied into `dest`. */
export function destKey(e: Entry, dest: string): string {
  return e.kind === "folder" ? `${dest}${e.name}/` : `${dest}${e.name}`;
}

/** True when at least one item would actually go somewhere and no folder lands inside itself. */
export function isValidDest(items: Entry[], dest: string): boolean {
  if (items.some((e) => e.kind === "folder" && dest.startsWith(e.key))) return false;
  return items.some((e) => entryParent(e) !== dest);
}

/** Short label for a destination prefix ("photos", or the bucket name at the root). */
export function destLabel(dest: string, bucket: string): string {
  const parts = dest.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : bucket;
}
