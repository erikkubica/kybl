/**
 * A pane's path as one list of steps, the same for every kind of place: the connection, its root
 * when it has several (a bucket, a drive, a folder of this computer), then the folders down to the
 * one on screen. A connection with a single root (an FTP or SFTP server, Dropbox…) has that root
 * as its top, so its name is the root's step too. An archive opened like a folder continues the
 * path of the place it is in: … › Downloads › site-backup.zip › site-backup.
 *
 * PathBar draws these steps fitted to the room it has; its menus list them too.
 */
import type { IconName } from "../../ui/components/Icons";

export type Crumb = {
  label: string;
  /** shown in the menus that list the steps (and on a phone's first step) */
  icon?: IconName;
  /** where a click goes; absent: plain text (the connection's top while it is on screen) */
  go?: () => void;
  /** a drop target in the pane's own root: that prefix ("" its top) */
  drop?: string;
  /** a note rather than a place ("Connecting…") */
  muted?: boolean;
};

export type CrumbPlace = {
  /** the connection's name */
  connection: string;
  /** one root only: the connection's name stands for its top */
  single: boolean;
  /** the root on screen; null at the connection's top (its roots are listed) */
  root: string | null;
  rootLabel?: string;
  rootIcon?: IconName;
  prefix: string;
  /** the connection's roots (absent with a single root) */
  toConnection?: () => void;
  /** a folder of this root ("" its top) */
  toPrefix: (prefix: string) => void;
  /** the steps take drops (the pane's own place, not read-only) */
  drops?: boolean;
};

/** "a/b/c/" → ["a", "b", "c"] */
export const prefixParts = (prefix: string) => prefix.split("/").filter(Boolean);

/** The folders of `prefix`, each going to itself. */
export function folderCrumbs(prefix: string, toPrefix: (prefix: string) => void, drops = false): Crumb[] {
  const parts = prefixParts(prefix);
  return parts.map((label, i) => {
    const at = parts.slice(0, i + 1).join("/") + "/";
    return { label, icon: "folder", go: () => toPrefix(at), drop: drops ? at : undefined };
  });
}

/** Connection › root › folders, for a place on a connection. */
export function placeCrumbs(p: CrumbPlace): Crumb[] {
  const open = p.root != null;
  if (p.single)
    return [
      { label: p.connection, icon: p.rootIcon ?? "server", go: open ? () => p.toPrefix("") : undefined, drop: open && p.drops ? "" : undefined },
      ...(open ? folderCrumbs(p.prefix, p.toPrefix, p.drops) : []),
    ];
  const conn: Crumb = { label: p.connection, icon: "link", go: p.toConnection };
  if (!open) return [conn];
  return [
    conn,
    { label: p.rootLabel ?? p.root ?? "", icon: p.rootIcon ?? "bucket", go: () => p.toPrefix(""), drop: p.drops ? "" : undefined },
    ...folderCrumbs(p.prefix, p.toPrefix, p.drops),
  ];
}

/**
 * How many steps after the first fold into "…" so the rest fits in `room`. `widths` are each
 * step's width with its separator, the first's without, and `more` that of the "…" step. The first
 * and the last step always show; when even first › … › last doesn't fit, all between fold and the
 * names give way (CSS) instead.
 */
export function foldCount(widths: number[], more: number, room: number): number {
  const n = widths.length;
  if (n <= 2 || room <= 0) return 0;
  const total = (fold: number) => widths[0] + (fold > 0 ? more : 0) + widths.slice(1 + fold).reduce((a, b) => a + b, 0);
  let fold = 0;
  while (fold < n - 2 && total(fold) > room) fold++;
  return fold;
}
