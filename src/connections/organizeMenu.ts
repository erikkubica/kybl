/**
 * The organizing model (organize.ts) as a context menu: Pinned and Recent first, a submenu per
 * group (menus open one level deep, so a nested group is a row with its whole path), then the
 * connections in no group. A search field on top finds a connection in any group and says which
 * group it is in beside it. Used by the pane's connection menu; the other lists draw the same
 * `Organized` their own way.
 */
import type { MenuItem } from "../components/Dialogs";
import type { Profile } from "../types";
import { findConnections } from "./groups";
import { holdingGroups, organize, type OrganizeOptions } from "./organize";

/** Rows a search lists at most: more than that is a reason to type a little more. */
const FOUND_MAX = 80;

export type ConnectionMenuOptions = OrganizeOptions & {
  /**
   * The row for a connection. `nested` is true inside a group's submenu and in search results,
   * where a row can't open a submenu of its own (a connection's buckets): it opens the connection.
   */
  row: (p: Profile, nested: boolean) => MenuItem;
};

export function connectionMenuItems(profiles: Profile[], o: ConnectionMenuOptions): MenuItem[] {
  const org = organize(profiles, o);
  const out: MenuItem[] = [];
  // the search field shows once the list is long enough to need it (the menu draws it)
  if (profiles.length > 8) {
    out.push({
      type: "search",
      find: (q) =>
        findConnections(profiles, q)
          .slice(0, FOUND_MAX)
          .map((f): MenuItem => ({ ...(o.row(f.p, true) as Extract<MenuItem, { type: "item" }>), detail: f.detail })),
    });
  }
  const section = (label: string, list: Profile[]) => {
    if (!list.length) return;
    if (out.length) out.push({ type: "sep" });
    out.push({ type: "label", label }, ...list.map((p) => o.row(p, false)));
  };
  section("Pinned", org.pinned);
  section("Recent", org.recent);
  const groups = holdingGroups(org.groups);
  const labelled = out.length > 0 && (groups.length > 0 || org.items.length > 0);
  if (labelled) out.push({ type: "sep" });
  for (const g of groups) {
    out.push({ type: "submenu", label: `${g.label} (${g.items.length})`, icon: "folder", items: () => g.items.map((p) => o.row(p, true)) });
  }
  out.push(...org.items.map((p) => o.row(p, false)));
  return out;
}
