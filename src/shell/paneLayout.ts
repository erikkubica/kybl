/**
 * The arrangement of the browser panes: a tree of splits, like editor groups in a code editor.
 * A leaf is a pane slot; a split lays its children out side by side ("row") or one above the
 * other ("col"), each taking a share (`sizes`, adding up to 1) of the room. Splits in the same
 * direction are kept flat (three panes side by side are one row of three, not a row in a row), so
 * a divider always sits between two neighbours of one split.
 *
 * Everything here is pure: the shell keeps the tree in state and draws it with SplitLayout.
 */
import { LS, PANE_IDS, type PaneId } from "../browser/types";

export type Dir = "row" | "col";
export type PaneNode = { t: "pane"; id: PaneId } | { t: "split"; dir: Dir; sizes: number[]; kids: PaneNode[] };

/** more than this and each pane gets too little room to be of use */
export const MAX_PANES = 6;
/** below this a pane's two header rows fall apart (the path, the toolbar's buttons) */
export const MIN_W = 340;
/** below this the list shows hardly a row under the header rows */
export const MIN_H = 220;
/** a divider's own width (its grab area reaches further, drawn over the panes) */
export const DIVIDER = 1;

const KEY = "s3b.panes";
/** the dual pane's splitter, before split layouts */
const OLD_SPLIT_KEY = "s3b.split";

export const leaf = (id: PaneId): PaneNode => ({ t: "pane", id });

/** The panes in reading order (left to right, top to bottom). */
export function leaves(n: PaneNode): PaneId[] {
  return n.t === "pane" ? [n.id] : n.kids.flatMap(leaves);
}

/** The least room a (sub)tree needs, dividers included. */
export function minSize(n: PaneNode): { w: number; h: number } {
  if (n.t === "pane") return { w: MIN_W, h: MIN_H };
  const ms = n.kids.map(minSize);
  const gaps = DIVIDER * (n.kids.length - 1);
  return n.dir === "row"
    ? { w: ms.reduce((a, m) => a + m.w, 0) + gaps, h: Math.max(...ms.map((m) => m.h)) }
    : { w: Math.max(...ms.map((m) => m.w)), h: ms.reduce((a, m) => a + m.h, 0) + gaps };
}

/** Same-direction splits merged, one-child splits gone, shares adding up to 1. */
function tidy(n: PaneNode): PaneNode {
  if (n.t === "pane") return n;
  const kids: PaneNode[] = [];
  const sizes: number[] = [];
  n.kids.forEach((k0, i) => {
    const k = tidy(k0);
    const s = n.sizes[i] ?? 0;
    if (k.t === "split" && k.dir === n.dir) {
      k.kids.forEach((kk, j) => {
        kids.push(kk);
        sizes.push(s * k.sizes[j]);
      });
    } else {
      kids.push(k);
      sizes.push(s);
    }
  });
  if (kids.length === 1) return kids[0];
  const sum = sizes.reduce((a, b) => a + b, 0);
  return { t: "split", dir: n.dir, kids, sizes: sizes.map((s) => (sum > 0 ? s / sum : 1 / kids.length)) };
}

/**
 * Splits pane `id`: `dir` "row" puts `fresh` to its right, "col" below it. The two share what
 * the pane had.
 */
export function splitPane(n: PaneNode, id: PaneId, dir: Dir, fresh: PaneId): PaneNode {
  const go = (x: PaneNode): PaneNode => {
    if (x.t === "pane") return x.id === id ? { t: "split", dir, sizes: [0.5, 0.5], kids: [x, leaf(fresh)] } : x;
    const i = x.kids.findIndex((k) => k.t === "pane" && k.id === id);
    if (i >= 0 && x.dir === dir) {
      // a neighbour in the same split: it takes half of this pane's share
      const kids = [...x.kids.slice(0, i + 1), leaf(fresh), ...x.kids.slice(i + 1)];
      const half = x.sizes[i] / 2;
      const sizes = [...x.sizes.slice(0, i), half, half, ...x.sizes.slice(i + 1)];
      return { ...x, kids, sizes };
    }
    return { ...x, kids: x.kids.map(go) };
  };
  return tidy(go(n));
}

/** The tree without pane `id`; its share goes to its neighbours. Null when it was the only one. */
export function closePane(n: PaneNode, id: PaneId): PaneNode | null {
  if (n.t === "pane") return n.id === id ? null : n;
  const kids: PaneNode[] = [];
  const sizes: number[] = [];
  n.kids.forEach((k, i) => {
    const r = closePane(k, id);
    if (r) {
      kids.push(r);
      sizes.push(n.sizes[i]);
    }
  });
  if (!kids.length) return null;
  return tidy({ ...n, kids, sizes });
}

/** Sets the shares of the split at `path` (child indexes from the root). */
export function setSizes(n: PaneNode, path: number[], sizes: number[]): PaneNode {
  if (n.t === "pane") return n;
  if (!path.length) return { ...n, sizes };
  const [i, ...rest] = path;
  return { ...n, kids: n.kids.map((k, j) => (j === i ? setSizes(k, rest, sizes) : k)) };
}

/** Every split shares its room evenly (`path` limits it to one split and what is inside it). */
export function equalize(n: PaneNode, path: number[] = []): PaneNode {
  if (n.t === "pane") return n;
  if (path.length) {
    const [i, ...rest] = path;
    return { ...n, kids: n.kids.map((k, j) => (j === i ? equalize(k, rest) : k)) };
  }
  return { ...n, sizes: n.kids.map(() => 1 / n.kids.length), kids: n.kids.map((k) => equalize(k)) };
}

/**
 * The shares as drawn in a box of `w` × `h` px: a child below its least size takes room from the
 * siblings that have more than they need. Only for drawing; the saved shares stay as they were,
 * so making the window smaller and then bigger again gives back the same layout.
 */
export function fit(n: PaneNode, w: number, h: number): PaneNode {
  if (n.t === "pane") return n;
  const row = n.dir === "row";
  const room = Math.max(0, (row ? w : h) - DIVIDER * (n.kids.length - 1));
  const mins = n.kids.map((k) => (row ? minSize(k).w : minSize(k).h));
  const px = n.sizes.map((s) => s * room);
  if (mins.reduce((a, b) => a + b, 0) <= room) {
    let short = 0;
    for (let i = 0; i < px.length; i++) if (px[i] < mins[i]) (short += mins[i] - px[i]), (px[i] = mins[i]);
    if (short > 0) {
      const spare = px.reduce((a, p, i) => a + Math.max(0, p - mins[i]), 0);
      for (let i = 0; i < px.length; i++) if (px[i] > mins[i]) px[i] -= (short * (px[i] - mins[i])) / spare;
    }
  }
  const sizes = room > 0 ? px.map((p) => p / room) : n.sizes;
  return { ...n, sizes, kids: n.kids.map((k, i) => (row ? fit(k, px[i], h) : fit(k, w, px[i]))) };
}

/**
 * Where pane `b` is seen from pane `a`, by the split that holds them both: "right" / "left" in a
 * row, "down" / "up" in a column.
 */
export function relation(n: PaneNode, a: PaneId, b: PaneId): "left" | "right" | "up" | "down" | null {
  if (n.t === "pane") return null;
  const ia = n.kids.findIndex((k) => leaves(k).includes(a));
  const ib = n.kids.findIndex((k) => leaves(k).includes(b));
  if (ia < 0 || ib < 0) return null;
  if (ia === ib) return relation(n.kids[ia], a, b);
  return n.dir === "row" ? (ib > ia ? "right" : "left") : ib > ia ? "down" : "up";
}

/** A free slot for a new pane. */
export function freeSlot(n: PaneNode): PaneId | null {
  const used = new Set(leaves(n));
  return PANE_IDS.find((id) => !used.has(id)) ?? null;
}

/** A tree read back from storage: only known slots, each once, and sensible shares. */
function valid(n: unknown, seen: Set<string>, depth = 0): PaneNode | null {
  if (!n || typeof n !== "object" || depth > 8) return null;
  const x = n as Record<string, unknown>;
  if (x.t === "pane") {
    const id = x.id as PaneId;
    if (!PANE_IDS.includes(id) || seen.has(id)) return null;
    seen.add(id);
    return leaf(id);
  }
  if (x.t !== "split" || (x.dir !== "row" && x.dir !== "col") || !Array.isArray(x.kids) || !Array.isArray(x.sizes)) return null;
  if (x.kids.length < 1 || x.kids.length !== x.sizes.length) return null;
  const kids = x.kids.map((k) => valid(k, seen, depth + 1));
  if (kids.some((k) => !k)) return null;
  const sizes = (x.sizes as unknown[]).map((s) => (typeof s === "number" && s > 0 && s < 1.0001 ? s : 1 / kids.length));
  return tidy({ t: "split", dir: x.dir, kids: kids as PaneNode[], sizes });
}

/**
 * The layout from last time. A first launch with split layouts takes over the old setting: two
 * panes side by side at the old splitter's position, or the one pane.
 */
export function loadLayout(oldLayout: "single" | "dual"): PaneNode {
  try {
    const raw = LS.get(KEY);
    if (raw) {
      const t = valid(JSON.parse(raw), new Set());
      if (t && leaves(t).length <= MAX_PANES) return t;
    }
  } catch {
    /* unreadable: start over below */
  }
  if (oldLayout !== "dual") return leaf("left");
  const r = Number(LS.get(OLD_SPLIT_KEY));
  const ratio = r >= 0.2 && r <= 0.8 ? r : 0.5;
  return { t: "split", dir: "row", sizes: [ratio, 1 - ratio], kids: [leaf("left"), leaf("right")] };
}

export function saveLayout(n: PaneNode) {
  LS.set(KEY, JSON.stringify(n));
}
