/**
 * The text diff viewer's entry point. Small and safe to import anywhere: the viewer itself, its
 * algorithm and CSS load as their own chunk on first use (DiffView.tsx).
 *
 * ```ts
 * import { openDiff } from "../viewers/diff";
 * openDiff({ profileId, bucket, key }, { profileId: other, bucket: b2, key: k2 });     // two files
 * openDiff({ text: mine, name: "notes.md", label: "Your version" }, { profileId, bucket, key, label: "On the server" });
 * ```
 */
import { viewerFor } from "./registry";

/** One side: a file of any connection (fetched), or text already in hand. */
export type DiffSide =
  | { profileId: string; bucket: string; key: string; name?: string; label?: string }
  | { text: string; name: string; label?: string };

/** Largest file compared (each side); bigger ones get a message instead. */
export const DIFF_MAX_BYTES = 8 * 1000 * 1000;

/** Whether a file looks like text the diff can show (by name, and size when known). */
export function canDiff(e: { name: string; size?: number; kind?: string }): boolean {
  if (e.kind === "folder") return false;
  const v = viewerFor(e.name);
  // text, code, JSON, Markdown, CSV; files without a known type are tried too (the viewer says
  // when one turns out to be binary)
  const texty = !v || v.kind === "text" || v.kind === "json" || v.kind === "markdown" || v.kind === "csv";
  return texty && !/\.(zip|gz|tgz|tar|7z|rar|pdf|png|jpe?g|gif|webp|heic|mp[34]|mov|mkv|wav|dmg|exe|iso|bin)$/i.test(e.name);
}

let closeCurrent: (() => void) | null = null;

/**
 * Opens the diff of two texts over the window (Esc closes it). Another call replaces the one open.
 * Resolves once the viewer is on screen.
 */
export async function openDiff(left: DiffSide, right: DiffSide, opts: { title?: string } = {}): Promise<void> {
  closeCurrent?.();
  const { mountDiff } = await import("./DiffView");
  closeCurrent = mountDiff(left, right, opts, () => {
    closeCurrent = null;
  });
}

/** Whether the diff viewer is up (it owns the keyboard then). */
export const diffOpen = () => !!closeCurrent;

// ------------------------------------------------------------ comparing across panes
type Picked = { profileId: string; bucket: string; key: string; name: string; size: number; modified: number | null; where: string };
const picks = new Map<string, Picked | null>();

/** A pane says which single file it has selected (null: none, or several), for "Compare with…". */
export function notePanePick(paneId: string, pick: Picked | null) {
  picks.set(paneId, pick);
}

/** The single file selected in another pane, if exactly one other pane has one. */
export function otherPanePick(paneId: string): Picked | null {
  const others = [...picks.entries()].filter(([id, p]) => id !== paneId && p);
  return others.length === 1 ? others[0][1] : null;
}
