/**
 * Workspaces: named pane layouts the window switches between, like a browser's windows as tabs
 * ("Client work", "Backups", "Photos"). Each keeps its tree of splits, every pane's place and view
 * choices, its synchronized browsing links and which pane was active.
 *
 * The window has a fixed set of pane slots (usePane hooks can't come and go), so a workspace isn't
 * a set of live panes: it is a snapshot. The one on screen lives in the slots; switching takes a
 * snapshot of it and points the slots at the other one's places (listings are cached, so that is
 * quick). Transfers and jobs belong to the app, not to a workspace.
 *
 * Kept per device in localStorage, like the layout before it. A first launch with workspaces
 * makes "Default workspace" out of the layout, links and panes of last time, so nothing is lost.
 * Everything here is pure apart from load / save.
 */
import { LS, PANE_IDS, paneKeys, type Loc, type PaneId, type PaneView } from "../browser/types";
import { leaf, leaves, parseLinks, parseTree, type PaneNode, type SyncLink } from "./paneLayout";
import { parseTermPlace, type TermPlace } from "../terminal/api";

const KEY = "s3b.workspaces";

/** One pane of a workspace: where it is and how it shows it. */
export type PaneSnap = {
  /** the place, or null for a pane with no folder open */
  loc: Loc | null;
  view: PaneView;
  /** how far down its list was (not kept between launches) */
  scroll?: number;
  /** a terminal pane (src/terminal) in this folder; `loc` is null then */
  term?: TermPlace;
};

/** What a workspace shows: the part a switch takes in and gives back. */
export type Layout = {
  tree: PaneNode;
  links: SyncLink[];
  /** its panes by when they were last active, the active one first */
  recent: PaneId[];
  panes: Partial<Record<PaneId, PaneSnap>>;
};

export type StartMode = "restore" | "saved";

export type Workspace = Layout & {
  id: string;
  name: string;
  /** a dot on its tab (WS_COLORS), or none */
  color: string | null;
  /** when Kybl opens: where it was left, or always at the folders saved in `saved` */
  start: StartMode;
  saved: Layout | null;
};

export type WorkspaceStore = { list: Workspace[]; active: string };

/** The colours a workspace can wear: as strong in the dark as in the light. */
export const WS_COLORS: { id: string; label: string; value: string }[] = [
  { id: "red", label: "Red", value: "#e5484d" },
  { id: "orange", label: "Orange", value: "#f07c2a" },
  { id: "yellow", label: "Yellow", value: "#e6b012" },
  { id: "green", label: "Green", value: "#30a46c" },
  { id: "teal", label: "Teal", value: "#12a594" },
  { id: "blue", label: "Blue", value: "#3e7bfa" },
  { id: "purple", label: "Purple", value: "#8e4ec6" },
  { id: "pink", label: "Pink", value: "#d6409f" },
  { id: "gray", label: "Gray", value: "#8b8d98" },
];
export const colorValue = (id: string | null) => WS_COLORS.find((c) => c.id === id)?.value ?? null;

export const DEFAULT_NAME = "Default workspace";

export const newId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** "Workspace 2", "Workspace 3"…: the lowest number not taken. */
export function nextName(list: Workspace[]): string {
  const taken = new Set(list.map((w) => w.name.toLowerCase()));
  for (let n = 2; ; n++) if (!taken.has(`workspace ${n}`)) return `Workspace ${n}`;
}

/** "Photos copy", "Photos copy 2"… */
export function copyName(list: Workspace[], name: string): string {
  const taken = new Set(list.map((w) => w.name.toLowerCase()));
  const base = `${name} copy`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** A workspace of one pane at `snap` (a new workspace opens where the active pane is). */
export function oneLayout(snap: PaneSnap | null): Layout {
  return { tree: leaf("left"), links: [], recent: ["left"], panes: snap ? { left: { ...snap, scroll: undefined } } : {} };
}

/** A deep copy (duplicating, saving the start): nothing shared with the one on screen. */
export function copyLayout(l: Layout): Layout {
  const c = JSON.parse(JSON.stringify({ ...l, panes: stripScroll(l.panes) })) as Layout;
  // a copy's terminals start shells of their own
  for (const p of Object.values(c.panes)) if (p?.term) delete p.term.sid;
  return c;
}

function stripScroll(panes: Layout["panes"]): Layout["panes"] {
  const out: Layout["panes"] = {};
  for (const id of PANE_IDS) {
    const p = panes[id];
    if (p) out[id] = { loc: p.loc, view: p.view, ...(p.term ? { term: p.term } : {}) };
  }
  return out;
}

/** Moves the workspace at `from` to index `to`. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, x);
  return next;
}

/** How many panes a layout has (closing one of several asks first). */
export const paneCount = (l: Layout) => leaves(l.tree).length;

// ---------------------------------------------------------------- storage

const isLoc = (v: unknown): v is Loc => {
  const x = v as Loc | null;
  return !!x && typeof x === "object" && typeof x.profileId === "string" && typeof x.bucket === "string" && typeof x.prefix === "string";
};

function parseView(v: unknown): PaneView {
  const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const sort = x.sort as PaneView["sort"];
  return {
    view: x.view === "grid" ? "grid" : "list",
    sort: sort && typeof sort === "object" && typeof sort.by === "string" ? { by: sort.by, desc: !!sort.desc } : null,
    hidden: typeof x.hidden === "boolean" ? x.hidden : null,
    compact: typeof x.compact === "boolean" ? x.compact : null,
    tile: typeof x.tile === "number" && x.tile > 0 ? x.tile : null,
  };
}

function parseLayout(v: unknown): Layout | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const tree = parseTree(x.tree);
  if (!tree) return null;
  const ids = leaves(tree);
  const panes: Layout["panes"] = {};
  const rawPanes = (x.panes && typeof x.panes === "object" ? x.panes : {}) as Record<string, unknown>;
  for (const id of ids) {
    const p = rawPanes[id] as Record<string, unknown> | undefined;
    if (p && typeof p === "object") {
      const term = parseTermPlace(p.term);
      panes[id] = { loc: isLoc(p.loc) && !term ? p.loc : null, view: parseView(p.view), ...(term ? { term } : {}) };
    }
  }
  const recent = Array.isArray(x.recent) ? (x.recent as PaneId[]).filter((id) => ids.includes(id)) : [];
  return {
    tree,
    links: parseLinks(x.links),
    recent: [...recent, ...ids.filter((id) => !recent.includes(id))],
    // (a "details" field saved by older versions, for the details panel since folded into
    // Quick Look's Get Info, is left behind here)
    panes,
  };
}

function parseWorkspace(v: unknown): Workspace | null {
  const l = parseLayout(v);
  if (!l) return null;
  const x = v as Record<string, unknown>;
  const name = typeof x.name === "string" && x.name.trim() ? x.name.trim().slice(0, 80) : DEFAULT_NAME;
  return {
    ...l,
    id: typeof x.id === "string" && x.id ? x.id : newId(),
    name,
    color: typeof x.color === "string" && WS_COLORS.some((c) => c.id === x.color) ? x.color : null,
    start: x.start === "saved" ? "saved" : "restore",
    saved: parseLayout(x.saved),
  };
}

/** What a slot shows now, by its own keys (paneKeys): an old layout's panes, on the first launch with workspaces. */
export function readSlot(id: PaneId): PaneSnap {
  const k = paneKeys(id);
  const json = (key: string): unknown => {
    const raw = LS.get(key);
    if (raw == null || raw === "") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const loc = json(k.last);
  return { loc: isLoc(loc) ? loc : null, view: parseView({ view: LS.get(k.view), sort: json(k.sort), hidden: json(k.hidden), compact: json(k.compact), tile: json(k.tile) }) };
}

/** Puts a workspace's pane into its slot's keys, so the slot opens there (a launch). */
export function writeSlot(id: PaneId, s: PaneSnap | undefined) {
  const k = paneKeys(id);
  const v = s?.view;
  LS.set(k.last, JSON.stringify(s?.loc ?? null));
  LS.set(k.view, v?.view ?? "list");
  LS.set(k.sort, v?.sort ? JSON.stringify(v.sort) : "");
  LS.set(k.hidden, v?.hidden != null ? JSON.stringify(v.hidden) : "");
  LS.set(k.compact, v?.compact != null ? JSON.stringify(v.compact) : "");
  LS.set(k.tile, v?.tile != null ? JSON.stringify(v.tile) : "");
}

/**
 * The workspaces from last time; on the first launch with workspaces, "Default workspace" made of
 * the layout as it was (`old`), with each of its panes where its slot was.
 */
export function loadWorkspaces(old: () => Omit<Layout, "panes">): WorkspaceStore {
  try {
    const raw = LS.get(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { list?: unknown; active?: unknown };
      const list = (Array.isArray(v.list) ? v.list : []).map(parseWorkspace).filter((w): w is Workspace => !!w);
      // the same id twice (a hand-edited file): the later one gets its own
      const seen = new Set<string>();
      for (const w of list) {
        if (seen.has(w.id)) w.id = newId();
        seen.add(w.id);
      }
      if (list.length) return { list, active: list.some((w) => w.id === v.active) ? (v.active as string) : list[0].id };
    }
  } catch {
    /* unreadable: start over from the old layout below */
  }
  const l = old();
  const panes: Layout["panes"] = {};
  for (const id of leaves(l.tree)) panes[id] = readSlot(id);
  const w: Workspace = { ...l, panes, id: newId(), name: DEFAULT_NAME, color: null, start: "restore", saved: null };
  return { list: [w], active: w.id };
}

export function saveWorkspaces(s: WorkspaceStore) {
  LS.set(KEY, JSON.stringify({ active: s.active, list: s.list.map((w) => ({ ...w, panes: stripScroll(w.panes) })) }));
}
