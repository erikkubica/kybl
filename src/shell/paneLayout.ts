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
/** below this a pane's header row falls apart (its buttons and the folder's name) */
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
 * Splits pane `id`: `dir` "row" puts `fresh` to its right, "col" below it; with `before`, to its
 * left or above it instead. The two share what the pane had.
 */
export function splitPane(n: PaneNode, id: PaneId, dir: Dir, fresh: PaneId, before = false): PaneNode {
  const go = (x: PaneNode): PaneNode => {
    if (x.t === "pane") return x.id === id ? { t: "split", dir, sizes: [0.5, 0.5], kids: before ? [leaf(fresh), x] : [x, leaf(fresh)] } : x;
    const i = x.kids.findIndex((k) => k.t === "pane" && k.id === id);
    if (i >= 0 && x.dir === dir) {
      // a neighbour in the same split: it takes half of this pane's share
      const at = before ? i : i + 1;
      const kids = [...x.kids.slice(0, at), leaf(fresh), ...x.kids.slice(at)];
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

// ---------------------------------------------------------------- rearranging panes

/** Where a pane dragged onto another lands: beside it on that side (the two share its room), or in its place ("center": the two swap). */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/** The tree with panes `a` and `b` in each other's places (every share stays where it was). */
export function swapPanes(n: PaneNode, a: PaneId, b: PaneId): PaneNode {
  if (n.t === "pane") return n.id === a ? leaf(b) : n.id === b ? leaf(a) : n;
  return { ...n, kids: n.kids.map((k) => swapPanes(k, a, b)) };
}

/**
 * Pane `id` taken out of its place (its split closing up behind it) and put beside pane `target`
 * on side `zone`, the two sharing what `target` had; "center" swaps the two. The number of panes
 * stays the same, so `MAX_PANES` never stands in the way; whether the result fits the window is
 * for the caller to check (`minSize`).
 */
export function movePane(n: PaneNode, id: PaneId, target: PaneId, zone: DropZone): PaneNode {
  if (id === target) return n;
  if (zone === "center") return swapPanes(n, id, target);
  const rest = closePane(n, id);
  if (!rest) return n;
  return splitPane(rest, target, zone === "left" || zone === "right" ? "row" : "col", id, zone === "left" || zone === "top");
}

/** The arrangement without the shares: two trees with the same shape lay their panes out the same way. */
export function shapeOf(n: PaneNode): string {
  return n.t === "pane" ? n.id : `${n.dir}(${n.kids.map(shapeOf).join(",")})`;
}

/** Child indexes from the root to pane `id`, or null when it isn't in the tree. */
function pathTo(n: PaneNode, id: PaneId): number[] | null {
  if (n.t === "pane") return n.id === id ? [] : null;
  for (let i = 0; i < n.kids.length; i++) {
    const p = pathTo(n.kids[i], id);
    if (p) return [i, ...p];
  }
  return null;
}

function nodeAt(n: PaneNode, path: number[]): PaneNode {
  return path.reduce((x, i) => (x.t === "split" ? x.kids[i] : x), n);
}

function replaceAt(n: PaneNode, path: number[], by: PaneNode): PaneNode {
  if (!path.length || n.t === "pane") return by;
  const [i, ...rest] = path;
  return { ...n, kids: n.kids.map((k, j) => (j === i ? replaceAt(k, rest, by) : k)) };
}

/**
 * Pane `id` one step that way, for the keyboard ("Move pane ▸ Left"): in a split running that way
 * it trades places with its neighbour (each keeps its share); inside a stack it steps out of the
 * stack to that side first. Null when it is at that edge of the window already.
 */
export function moveToward(n: PaneNode, id: PaneId, d: "left" | "right" | "up" | "down"): PaneNode | null {
  const dir: Dir = d === "left" || d === "right" ? "row" : "col";
  const fwd = d === "right" || d === "down";
  const path = pathTo(n, id);
  if (!path) return null;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const at = path.slice(0, depth);
    const s = nodeAt(n, at);
    if (s.t !== "split" || s.dir !== dir) continue;
    const k = path[depth];
    const kids = [...s.kids];
    const sizes = [...s.sizes];
    if (kids[k].t === "pane") {
      // beside its neighbour in this split: the two trade places
      const j = fwd ? k + 1 : k - 1;
      if (j < 0 || j >= kids.length) continue;
      [kids[k], kids[j]] = [kids[j], kids[k]];
      [sizes[k], sizes[j]] = [sizes[j], sizes[k]];
    } else {
      // in a stack: out of it, beside it on that side, with half of the stack's room
      const rest = closePane(kids[k], id);
      if (!rest) continue;
      const half = sizes[k] / 2;
      kids[k] = rest;
      sizes[k] = half;
      const i = fwd ? k + 1 : k;
      kids.splice(i, 0, leaf(id));
      sizes.splice(i, 0, half);
    }
    return tidy(replaceAt(n, at, { ...s, kids, sizes }));
  }
  return null;
}

/**
 * The tree with pane `id` added along the whole of its `side` edge ("right": a column down the
 * right of everything), taking an even share. Moving a pane into another workspace puts it there.
 */
export function dockEdge(n: PaneNode, id: PaneId, side: "right" | "bottom"): PaneNode {
  const dir: Dir = side === "right" ? "row" : "col";
  const m = n.t === "split" && n.dir === dir ? n.kids.length : 1;
  return tidy({ t: "split", dir, sizes: [m / (m + 1), 1 / (m + 1)], kids: [n, leaf(id)] });
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

type Side = "left" | "right" | "top" | "bottom";

type Span = { id: PaneId; from: number; to: number };

/**
 * Every pane of (sub)tree `n` that touches its `side` edge, with the stretch of the edge each
 * covers (`from`–`to`, 0 to 1), in order along the edge. A split side by side reaches a left or
 * right edge with only its first or last child; a split stacked along that edge reaches it with
 * every child, each over its share.
 */
export function edgeSpans(n: PaneNode, side: Side, from = 0, to = 1): Span[] {
  if (n.t === "pane") return [{ id: n.id, from, to }];
  const across = side === "left" || side === "right" ? n.dir === "row" : n.dir === "col";
  if (across) return edgeSpans(side === "left" || side === "top" ? n.kids[0] : n.kids[n.kids.length - 1], side, from, to);
  const len = to - from;
  let start = 0;
  return n.kids.flatMap((k, i) => {
    const s = n.sizes[i];
    const r = edgeSpans(k, side, from + start * len, from + (start + s) * len);
    start += s;
    return r;
  });
}

/** Two panes facing each other across a divider over the stretch `from`–`to` of it (0 to 1); `at` is its middle. */
export type Facing = { pair: [PaneId, PaneId]; from: number; to: number; at: number };

/** stretches shorter than this are rounding: panes meeting only at a corner do not face each other */
const TOUCH = 1e-4;

/**
 * The pairs of panes facing each other across the divider after child `i` of split `n`, in order
 * along it (top to bottom, left to right): each pane before the divider with each pane after it
 * that shares a stretch of the line with it. With a single pane on each side that is simply the
 * two of them over the whole divider. Each pair's link button goes at the middle of its stretch.
 */
export function facingPairs(n: Extract<PaneNode, { t: "split" }>, i: number): Facing[] {
  const row = n.dir === "row";
  const as = edgeSpans(n.kids[i], row ? "right" : "bottom");
  const bs = edgeSpans(n.kids[i + 1], row ? "left" : "top");
  const out: Facing[] = [];
  for (const a of as)
    for (const b of bs) {
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      if (to - from > TOUCH) out.push({ pair: [a.id, b.id], from, to, at: (from + to) / 2 });
    }
  return out;
}

/** Every facing pair in the tree, across every divider. */
export function allFacing(n: PaneNode): Facing[] {
  if (n.t === "pane") return [];
  return [...n.kids.slice(1).flatMap((_, i) => facingPairs(n, i)), ...n.kids.flatMap(allFacing)];
}

/** Every pair of panes facing each other across a divider: the pairs synchronized browsing can link. */
export function dividerPairs(n: PaneNode): [PaneId, PaneId][] {
  return allFacing(n).map((f) => f.pair);
}

// ---------------------------------------------------------------- synchronized browsing links

/** Two panes that follow each other into subfolders and back up. */
export type SyncLink = [PaneId, PaneId];
const LINKS_KEY = "s3b.panes.sync";

export const sameLink = (l: SyncLink, a: PaneId, b: PaneId) => (l[0] === a && l[1] === b) || (l[0] === b && l[1] === a);

/** The links with the one between `a` and `b` switched on or off. */
export function toggleLink(links: SyncLink[], a: PaneId, b: PaneId): SyncLink[] {
  return links.some((l) => sameLink(l, a, b)) ? links.filter((l) => !sameLink(l, a, b)) : [...links, [a, b]];
}

/**
 * The panes that move with pane `id`: everything linked to it, directly or through another link
 * (linking 1–2 and 2–3 moves all three together, as the lit dividers suggest).
 */
export function syncedWith(links: SyncLink[], id: PaneId): PaneId[] {
  const seen = new Set<PaneId>([id]);
  const todo = [id];
  while (todo.length) {
    const x = todo.pop()!;
    for (const [a, b] of links) {
      const y = a === x ? b : b === x ? a : null;
      if (y && !seen.has(y)) {
        seen.add(y);
        todo.push(y);
      }
    }
  }
  seen.delete(id);
  return [...seen];
}

/**
 * The links from last time. Before links, synchronized browsing was one switch for "the two
 * panes": with it on and two panes on screen, those two start out linked.
 */
export function loadLinks(tree: PaneNode, oldSwitch: boolean): SyncLink[] {
  try {
    const raw = LS.get(LINKS_KEY);
    if (raw) {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v))
        return v.filter((l): l is SyncLink => Array.isArray(l) && l.length === 2 && l.every((x) => PANE_IDS.includes(x)) && l[0] !== l[1]);
    }
  } catch {
    /* unreadable: start over below */
  }
  const ids = leaves(tree);
  return oldSwitch && ids.length === 2 ? [[ids[0], ids[1]]] : [];
}

export function saveLinks(links: SyncLink[]) {
  LS.set(LINKS_KEY, JSON.stringify(links));
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

/** A tree read back from storage (a saved workspace), or null when it doesn't hold together. */
export function parseTree(raw: unknown): PaneNode | null {
  const t = valid(raw, new Set());
  return t && leaves(t).length <= MAX_PANES ? t : null;
}

/** Links read back from storage: known slots, two different ones each. */
export function parseLinks(raw: unknown): SyncLink[] {
  return Array.isArray(raw)
    ? raw.filter((l): l is SyncLink => Array.isArray(l) && l.length === 2 && l.every((x) => PANE_IDS.includes(x)) && l[0] !== l[1])
    : [];
}

export function saveLayout(n: PaneNode) {
  LS.set(KEY, JSON.stringify(n));
}
