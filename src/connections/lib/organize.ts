/**
 * How connections are organized wherever they are listed: the pane's connection menu, the
 * sidebar, the destination pickers, the command palette and the phone's list. One model, so a
 * list with hundreds of connections reads the same everywhere:
 *
 *   Pinned          the connections marked with a pin, by name
 *   Recent          the last few opened (only once the list is long enough to need it)
 *   groups          folders (nested with "/"), then the connections that are in no group
 *   by type         with many connections outside any group: Servers, Cloud drives and Object
 *                   storage stand in for the one long flat list
 *
 * Finding stays separate (`findConnections` in groups.ts) and looks in every group; a match
 * shows its group path next to it. This file is pure: the views draw what it returns.
 */
import { GROUPS, kindInfo, pickOf } from "./kinds.ts";
import { byName, groupLabel, groupName, groupOf, groupTree, type GroupNode } from "./groupPaths.ts";
import type { Profile } from "../../core/types";

/** More connections than this outside any group are sorted by type. */
export const TYPE_FALLBACK_MIN = 15;
/** How many recent connections are listed. */
export const RECENT_COUNT = 5;
/** Under this many connections everything fits on screen: no Recent section. */
export const RECENT_AFTER = 10;

export type OrgGroup = {
  /** unique among the groups of one list: the path, or `type:<id>` for a by-type group */
  key: string;
  /** the saved group path ("" for a by-type group, which is no folder anyone made) */
  path: string;
  /** what the row says: the folder's name, or the type */
  name: string;
  /** a by-type group: it can't be renamed, deleted or dropped onto */
  byType: boolean;
  /** connections in it and in every group inside it */
  count: number;
  groups: OrgGroup[];
  items: Profile[];
};

export type Organized = {
  pinned: Profile[];
  recent: Profile[];
  /** the top level: groups first, as folders come before files */
  groups: OrgGroup[];
  /** connections in no group (empty while by-type groups stand in for them) */
  items: Profile[];
  /** the ungrouped connections went into by-type groups */
  byType: boolean;
};

export type OrganizeOptions = {
  /** ids of the connections opened last, newest first */
  recent?: string[];
  /** a connection that stays out of Recent (the one on screen) */
  skipRecent?: string | null;
  /** how many ungrouped connections it takes to sort them by type */
  typeMin?: number;
  recentAfter?: number;
};

/** This computer's own entry: always first and never filed anywhere (it is built in). */
export const isDevice = (p: Profile) => p.kind === "local" || p.id === "local";

/** The type a connection is sorted under when there are many: Servers, Cloud drives, Object storage. */
export function typeOf(p: Profile): { id: string; label: string } {
  const g = kindInfo(pickOf(p)).group;
  return { id: g, label: GROUPS.find((x) => x.id === g)?.label ?? "Other" };
}

/** Servers first, then drives, then storage: the order the picker shows them in. */
export const TYPE_ORDER = ["servers", "drives", "storage"];

function toGroup(n: GroupNode): OrgGroup {
  return { key: n.path, path: n.path, name: n.name, byType: false, count: n.count, groups: n.groups.map(toGroup), items: n.items };
}

export function organize(profiles: Profile[], opts: OrganizeOptions = {}): Organized {
  const tree = groupTree(profiles, true);
  const device = tree.items.filter(isDevice);
  const loose = tree.items.filter((p) => !isDevice(p));
  const groups = tree.groups.map(toGroup);

  const byType = loose.length > (opts.typeMin ?? TYPE_FALLBACK_MIN);
  let items = [...device, ...loose];
  if (byType) {
    const by = new Map<string, Profile[]>();
    for (const p of loose) {
      const id = typeOf(p).id;
      by.set(id, [...(by.get(id) ?? []), p]);
    }
    for (const id of TYPE_ORDER) {
      const list = by.get(id);
      if (!list) continue;
      groups.push({ key: `type:${id}`, path: "", name: typeOf(list[0]).label, byType: true, count: list.length, groups: [], items: list });
    }
    items = device;
  }

  const pinned = profiles.filter((p) => p.pinned && !isDevice(p)).sort((a, b) => byName(a.name, b.name));
  const pinnedIds = new Set(pinned.map((p) => p.id));
  const known = new Map(profiles.map((p) => [p.id, p]));
  const recent =
    profiles.length > (opts.recentAfter ?? RECENT_AFTER)
      ? (opts.recent ?? [])
          .filter((id) => id !== opts.skipRecent && !pinnedIds.has(id))
          .map((id) => known.get(id))
          .filter((p): p is Profile => !!p && !isDevice(p))
          .slice(0, RECENT_COUNT)
      : [];
  return { pinned, recent, groups, items, byType };
}

/**
 * Every group that holds connections of its own, by its whole path ("Clients › Acme"), for the
 * places that draw one level only: menus open one submenu deep, so a nested group is a row of
 * its own there instead of a folder inside a folder.
 */
export function holdingGroups(groups: OrgGroup[]): { key: string; label: string; items: Profile[] }[] {
  const out: { key: string; label: string; items: Profile[] }[] = [];
  const walk = (list: OrgGroup[]) => {
    for (const g of list) {
      if (g.items.length) out.push({ key: g.key, label: g.byType ? g.name : groupLabel(g.path), items: g.items });
      walk(g.groups);
    }
  };
  walk(groups);
  return out;
}

/** The dim text beside a connection in a flat list: the group it is filed under, if any. */
export const groupHint = (p: Profile) => {
  const g = groupOf(p);
  return g ? groupLabel(g) : "";
};

/** The group's own last folder, for places that already show the parents. */
export const folderName = groupName;

/**
 * Group changes for moving `ids` into `to` ("" = the top level), as `api.setProfileGroups` takes
 * them. Connections already there are left out; the device's own entry is never filed.
 */
export function moveInto(profiles: Profile[], ids: Iterable<string>, to: string): Record<string, string> {
  const want = new Set(ids);
  const out: Record<string, string> = {};
  for (const p of profiles) if (want.has(p.id) && !isDevice(p) && groupOf(p) !== to) out[p.id] = to;
  return out;
}

/** The pin changes for `ids`: all pinned, or (when every one already is) all unpinned. */
export function togglePins(profiles: Profile[], ids: Iterable<string>): Record<string, boolean> {
  const mine = profiles.filter((p) => new Set(ids).has(p.id) && !isDevice(p));
  const allPinned = mine.length > 0 && mine.every((p) => p.pinned);
  return Object.fromEntries(mine.map((p) => [p.id, !allPinned]));
}

/** The keys of the groups on the way to connection `id` (outermost first), for folding them open. */
export function groupKeysHolding(groups: OrgGroup[], id: string): string[] {
  for (const g of groups) {
    if (g.items.some((p) => p.id === id)) return [g.key];
    const inner = groupKeysHolding(g.groups, id);
    if (inner.length) return [g.key, ...inner];
  }
  return [];
}
