/**
 * How the sidebar's sections are ordered and which are folded shut, kept per device. Each section
 * header has a menu to change its order: favorites as added or by name, this computer's folders
 * as the system lists them or by name, groups by name or size, connections by name, type or when
 * they were last opened. Pinned connections stay first whatever the order.
 */
import { useState } from "react";
import type { Profile } from "../core/types";
import type { Favorite } from "../settings/settings";
import type { GroupNode } from "../connections/lib/groups";
import { byName } from "../connections/lib/groups";
import { TYPE_ORDER, typeOf } from "../connections/lib/organize";
import { LS } from "../browser/types";

export type SideSort = {
  favorites: "added" | "name";
  device: "system" | "name";
  groups: "name" | "name-desc" | "count";
  connections: "name" | "type" | "recent";
};
export type SideSection = "favorites" | "device" | "groups" | "connections";

const SORT_KEY = "kybl.sidebar.sort";
const FOLDED_KEY = "kybl.sidebar.folded";
const DEFAULT_SORT: SideSort = { favorites: "added", device: "system", groups: "name", connections: "name" };

/** Each section's choices, in menu order. */
export const SORT_CHOICES: { [K in SideSection]: { value: SideSort[K]; label: string }[] } = {
  favorites: [
    { value: "added", label: "As added" },
    { value: "name", label: "Name" },
  ],
  device: [
    { value: "system", label: "As the system lists them" },
    { value: "name", label: "Name" },
  ],
  groups: [
    { value: "name", label: "Name (A–Z)" },
    { value: "name-desc", label: "Name (Z–A)" },
    { value: "count", label: "Most connections" },
  ],
  connections: [
    { value: "name", label: "Name" },
    { value: "type", label: "Type" },
    { value: "recent", label: "Last opened" },
  ],
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(LS.get(key) ?? "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function useSideSort() {
  const [sort, setSort] = useState<SideSort>(() => {
    const v = load<Partial<SideSort>>(SORT_KEY, {});
    // only choices that still exist
    const pick = <K extends SideSection>(k: K): SideSort[K] => (SORT_CHOICES[k].some((c) => c.value === v[k]) ? (v[k] as SideSort[K]) : DEFAULT_SORT[k]);
    return { favorites: pick("favorites"), device: pick("device"), groups: pick("groups"), connections: pick("connections") };
  });
  const [folded, setFolded] = useState<Set<SideSection>>(() => {
    const v = load<unknown>(FOLDED_KEY, []);
    return new Set(Array.isArray(v) ? (v.filter((x) => typeof x === "string") as SideSection[]) : []);
  });
  const set = <K extends SideSection>(k: K, v: SideSort[K]) =>
    setSort((cur) => {
      const next = { ...cur, [k]: v };
      LS.set(SORT_KEY, JSON.stringify(next));
      return next;
    });
  const fold = (k: SideSection) =>
    setFolded((cur) => {
      const next = new Set(cur);
      if (!next.delete(k)) next.add(k);
      LS.set(FOLDED_KEY, JSON.stringify([...next]));
      return next;
    });
  return { sort, set, folded, fold };
}

export function sortFavorites(list: Favorite[], by: SideSort["favorites"]): Favorite[] {
  return by === "name" ? [...list].sort((a, b) => byName(a.name, b.name)) : list;
}

/** Connections in this order, pinned ones first. `recent` is ids opened last, newest first. */
export function sortConnections(list: Profile[], by: SideSort["connections"], recent: string[]): Profile[] {
  const typeRank = (p: Profile) => TYPE_ORDER.indexOf(typeOf(p).id);
  const seen = (p: Profile) => {
    const i = recent.indexOf(p.id);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  return [...list].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (by === "type" ? typeRank(a) - typeRank(b) : 0) ||
      (by === "recent" ? seen(a) - seen(b) : 0) ||
      byName(a.name, b.name),
  );
}

/** A group tree with its groups and connections (at every level) in these orders. */
export function sortTree(node: GroupNode, groups: SideSort["groups"], conns: SideSort["connections"], recent: string[]): GroupNode {
  const sub = node.groups.map((g) => sortTree(g, groups, conns, recent));
  sub.sort((a, b) => (groups === "count" ? b.count - a.count : 0) || (groups === "name-desc" ? byName(b.name, a.name) : byName(a.name, b.name)));
  return { ...node, groups: sub, items: sortConnections(node.items, conns, recent) };
}
