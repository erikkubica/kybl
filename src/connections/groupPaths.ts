/**
 * Group paths and the tree connections make of them. Pure (no framework, no storage), so the
 * organizing model (organize.ts) and its tests use it as it is; groups.ts re-exports it.
 */
import type { Profile } from "../types";

/** A group path as it is saved: folders trimmed, empty ones dropped; "" is the top level. */
export function normalizeGroup(raw: string | null | undefined): string {
  return (raw ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

export const groupOf = (p: Profile) => normalizeGroup(p.group);
/** The last folder of a path ("Acme" for "Clients/Acme"). */
export const groupName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** The group holding `path` ("" for a top-level group). */
export const parentGroup = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** `path` and every group above it, outermost first ("a", "a/b", "a/b/c"). */
export function groupChain(path: string): string[] {
  const parts = normalizeGroup(path).split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
/** The path as the sidebar writes it out ("Clients › Acme"). */
export const groupLabel = (path: string) => path.split("/").join(" › ");

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const byName = (a: string, b: string) => collator.compare(a, b);

/** Every group in use, those that only hold other groups too, in sidebar order. */
export function allGroups(profiles: Profile[]): string[] {
  const out = new Set<string>();
  for (const p of profiles) for (const g of groupChain(groupOf(p))) out.add(g);
  return [...out].sort((a, b) => byName(a.split("/").join("\u0000"), b.split("/").join("\u0000")));
}

export type GroupNode = {
  /** "" for the top level */
  path: string;
  name: string;
  groups: GroupNode[];
  items: Profile[];
  /** a by-type stand-in (organize.ts), not a folder anyone made: no menu, nothing drops on it */
  virtual?: boolean;
  /** connections in it and in every group inside it */
  count: number;
};

/**
 * The connections as a tree of groups. Top-level connections keep their saved order (This
 * Mac first, then the connections people add by hand); inside a group they go by name, as a folder of
 * imported sites reads best. Groups go by name, before the connections beside them.
 */
export function groupTree(profiles: Profile[], sortTop = false): GroupNode {
  const root: GroupNode = { path: "", name: "", groups: [], items: [], count: 0 };
  const nodes = new Map<string, GroupNode>([["", root]]);
  const node = (path: string): GroupNode => {
    let n = nodes.get(path);
    if (n) return n;
    n = { path, name: groupName(path), groups: [], items: [], count: 0 };
    nodes.set(path, n);
    node(parentGroup(path)).groups.push(n);
    return n;
  };
  for (const p of profiles) {
    const g = groupOf(p);
    node(g).items.push(p);
    for (const c of ["", ...groupChain(g)]) nodes.get(c)!.count++;
  }
  for (const n of nodes.values()) {
    n.groups.sort((a, b) => byName(a.name, b.name));
    if (n.path || sortTop) n.items.sort((a, b) => byName(a.name, b.name));
  }
  return root;
}

