/**
 * Workspace recipes: a layout saved to be opened again in one go ("Acme dev": This Mac's site
 * folder on the left, the live server on the right, a terminal below running `npm run dev`).
 * A recipe keeps the tree of splits, each pane's place and view, and each terminal's folder with
 * the commands it types once its shell is up.
 *
 * A workspace keeps going where it was left, as always; its recipe is what "Reset to recipe"
 * brings back and what "+" (and ⌘K) open a new workspace from. One set to open from its recipe
 * starts there when Kybl opens, terminals and their startup commands included.
 *
 * Recipes are kept per device (useRecipes.ts), apart from the workspaces, so closing a workspace
 * doesn't lose its recipe. Everything here is pure (the tests run it under node).
 */
import type { Loc, PaneId } from "../../browser/types";
import type { PaneNode } from "./paneLayout";
import type { Layout, PaneSnap } from "./workspaces";
import type { TermPlace } from "../../terminal/api";

export type Recipe = { id: string; name: string; color: string | null; layout: Layout };

export const recipeId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const ids = (n: PaneNode): PaneId[] => (n.t === "pane" ? [n.id] : n.kids.flatMap(ids));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * The recipe of layout `l`: its splits, its panes' places and views, its terminals' folders, and
 * the connections' names (said if one is gone later). A terminal keeps the startup commands it
 * had in `prev` (the recipe being updated) when it is the same terminal: matched by its `key`
 * (given when the recipe opened it, or its session when it was first saved), not by its slot, so
 * a new terminal in an old one's place doesn't inherit what the old one ran.
 */
export function captureRecipe(l: Layout, connName: (profileId: string) => string | undefined, prev?: Layout | null): Layout {
  const panes: Layout["panes"] = {};
  const before = (id: PaneId, t: TermPlace): PaneSnap | undefined => {
    if (!prev) return undefined;
    const k = t.key ?? t.sid;
    if (k) for (const p of Object.values(prev.panes)) if (p?.term?.key === k) return p;
    // recipes saved before terminals had a key: the same slot and connection, neither keyed
    const old = prev.panes[id];
    return !t.key && old?.term && !old.term.key && old.term.profileId === t.profileId && old.term.bucket === t.bucket ? old : undefined;
  };
  for (const id of ids(l.tree)) {
    const p = l.panes[id];
    if (!p) continue;
    const t = p.term;
    const profileId = t?.profileId ?? p.loc?.profileId;
    const conn = profileId ? connName(profileId) : undefined;
    const startup = t ? before(id, t)?.startup : undefined;
    const key = t ? (t.key ?? t.sid) : undefined;
    const term = t ? { profileId: t.profileId, bucket: t.bucket, prefix: t.prefix, ...(t.from ? { from: t.from } : {}), ...(t.follow ? { follow: true } : {}), ...(key ? { key } : {}) } : null;
    panes[id] = {
      loc: t || !p.loc ? null : { profileId: p.loc.profileId, bucket: p.loc.bucket, prefix: p.loc.prefix },
      view: clone(p.view),
      ...(term ? { term } : {}),
      ...(startup?.length ? { startup: [...startup] } : {}),
      ...(conn ? { conn } : {}),
    };
  }
  return { tree: clone(l.tree), links: clone(l.links), recent: [...l.recent], panes };
}

/** The lines a terminal types: trimmed, blank ones left out. */
export const startupLines = (lines: string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter(Boolean);

export type OpenedRecipe = {
  layout: Layout;
  /** panes whose connection isn't on this device: its name, for the note the empty pane shows */
  missing: Partial<Record<PaneId, string>>;
  /** each terminal's new session, with the lines it types once its shell is up */
  startups: [string, string[]][];
};

/**
 * A recipe as a layout to show: each terminal a fresh session (`sid` makes one) with its startup
 * lines, and each pane whose connection `known` doesn't know empty (null: not known yet, as on
 * launch before the connections are read; the shell checks once they are).
 */
export function openRecipe(r: Layout, sid: () => string, known: ((profileId: string) => boolean) | null): OpenedRecipe {
  const missing: OpenedRecipe["missing"] = {};
  const startups: OpenedRecipe["startups"] = [];
  const panes: Layout["panes"] = {};
  for (const id of ids(r.tree)) {
    const p = r.panes[id];
    if (!p) continue;
    const profileId = p.term?.profileId ?? p.loc?.profileId;
    if (profileId && known && !known(profileId)) {
      missing[id] = p.conn || "A connection";
      panes[id] = { loc: null, view: clone(p.view) };
      continue;
    }
    const snap: PaneSnap = { loc: p.loc ? { ...p.loc } : null, view: clone(p.view) };
    if (p.term) {
      const s = sid();
      snap.term = { ...p.term, sid: s };
      const lines = startupLines(p.startup);
      if (lines.length) startups.push([s, lines]);
    }
    panes[id] = snap;
  }
  return { layout: { tree: clone(r.tree), links: clone(r.links), recent: [...r.recent], panes }, missing, startups };
}

/** The panes of a layout that are terminals, in the order they sit. */
export const terminalPanes = (l: Layout): PaneId[] => ids(l.tree).filter((id) => !!l.panes[id]?.term);

/**
 * Where files dropped on a workspace's tab land: its most recently active file pane with a folder
 * open (a terminal pane has no folder of its own), else null.
 */
export function dropPlace(l: Layout): Loc | null {
  const ls = ids(l.tree);
  const order = [...l.recent.filter((id) => ls.includes(id)), ...ls];
  for (const id of order) {
    const p = l.panes[id];
    if (p && !p.term && p.loc) return p.loc;
  }
  return null;
}

/** What a recipe compares on: splits, links, and each pane's place, view and terminal folder. */
function shape(l: Layout) {
  return JSON.stringify([
    l.tree,
    l.links,
    ids(l.tree).map((id) => {
      const p = l.panes[id];
      const t = p?.term;
      const loc = p?.loc;
      return [loc ? [loc.profileId, loc.bucket, loc.prefix] : null, p?.view ?? null, t ? [t.profileId, t.bucket, t.prefix, !!t.follow] : null];
    }),
  ]);
}

/** Whether layout `l` is what recipe `r` opens (nothing for "Update recipe" to take in). */
export const matchesRecipe = (l: Layout, r: Layout) => shape(l) === shape(r);

/** `base`, or "base 2", "base 3"… when a name in `taken` has it already. */
export function freeName(taken: string[], base: string): string {
  const t = new Set(taken.map((n) => n.toLowerCase()));
  if (!t.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!t.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Just the layout of `l` (a whole workspace carries its name, color and start mode too): what an Undo puts back. */
export function layoutOnly(l: Layout): Layout {
  return { tree: l.tree, links: l.links, recent: l.recent, panes: l.panes };
}
