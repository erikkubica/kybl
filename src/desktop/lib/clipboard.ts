/**
 * Items copied or cut with ⌘C / ⌘X, waiting to be pasted with ⌘V into another folder, bucket or
 * connection. Kept in memory: S3 objects can't go on the system clipboard as files.
 */
import type { Entry } from "../../core/types";

export type ItemClip = { mode: "copy" | "cut"; profileId: string; bucket: string; items: Entry[] };

let clip: ItemClip | null = null;

export const itemClipboard = {
  get: () => clip,
  set(c: ItemClip) {
    clip = c;
  },
  clear() {
    clip = null;
  },
};
