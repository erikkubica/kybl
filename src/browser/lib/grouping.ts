/**
 * "Group by" for a pane's list and grid: the sorted entries put into headed groups, the way
 * Explorer and Finder do it. The order inside a group stays the sort's; the groups come in their
 * natural order (A to Z, smallest first, newest first), turned around when the list is sorted the
 * other way by the same thing. Pure (no React), so `node --test` can load it.
 */
import { entryKind, extOf } from "../../core/format.ts";
import type { Entry } from "../../core/types";
import type { GroupBy, SortBy } from "../../settings/settings";

export type Group = { key: string; label: string; /** index of its first entry */ start: number; count: number };
export type Grouped = { entries: Entry[]; groups: Group[] | null };

const DAY = 86_400_000;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The group an entry falls in: a sort rank and the heading. */
type Slot = { rank: number | string; label: string };

const SIZES: [number, string][] = [
  [0, "Empty"],
  [16 * 1024, "Tiny (up to 16 KB)"],
  [1024 * 1024, "Small (16 KB – 1 MB)"],
  [128 * 1024 * 1024, "Medium (1 – 128 MB)"],
  [1024 * 1024 * 1024, "Large (128 MB – 1 GB)"],
  [4 * 1024 * 1024 * 1024, "Huge (1 – 4 GB)"],
];

/** Today, Yesterday, Earlier this week, Last week, Earlier this month, Last month, Earlier this year, then each year. */
export function dateSlot(t: number | null | undefined, now: number): Slot {
  if (!t) return { rank: Number.MAX_SAFE_INTEGER, label: "No date" };
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // weeks start on Monday
  const weekStart = today - ((d.getDay() + 6) % 7) * DAY;
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const lastMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  const yearStart = new Date(d.getFullYear(), 0, 1).getTime();
  if (t >= today + DAY) return { rank: 0, label: "Later" };
  if (t >= today) return { rank: 1, label: "Today" };
  if (t >= today - DAY) return { rank: 2, label: "Yesterday" };
  if (t >= weekStart) return { rank: 3, label: "Earlier this week" };
  if (t >= weekStart - 7 * DAY) return { rank: 4, label: "Last week" };
  if (t >= monthStart) return { rank: 5, label: "Earlier this month" };
  if (t >= lastMonthStart) return { rank: 6, label: "Last month" };
  if (t >= yearStart) return { rank: 7, label: "Earlier this year" };
  const y = new Date(t).getFullYear();
  // older years, newest first
  return { rank: 10_000 - y + 10, label: String(y) };
}

function slotOf(e: Entry, by: GroupBy, now: number): Slot {
  switch (by) {
    case "name": {
      const c = e.name.trim().charAt(0).toLocaleUpperCase();
      if (/\p{L}/u.test(c)) return { rank: c, label: c };
      if (/\d/.test(c)) return { rank: "\u0000", label: "0–9" };
      return { rank: "\u0001", label: "#" };
    }
    case "kind":
      return e.kind === "folder" ? { rank: "", label: "Folders" } : { rank: ` ${entryKind(e)}`, label: entryKind(e) };
    case "type": {
      if (e.kind === "folder") return { rank: "", label: "Folders" };
      const x = extOf(e.name);
      return x ? { rank: ` ${x}`, label: x.toUpperCase() } : { rank: "~", label: "No extension" };
    }
    case "size": {
      if (e.kind === "folder") return { rank: -1, label: "Folders" };
      const i = SIZES.findIndex(([max]) => e.size <= max);
      return i < 0 ? { rank: SIZES.length, label: "Gigantic (over 4 GB)" } : { rank: i, label: SIZES[i][1] };
    }
    case "modified":
      return dateSlot(e.modified, now);
    case "created":
      return dateSlot(e.created, now);
    default:
      return { rank: 0, label: "" };
  }
}

/** Does `sort` run the other way from a grouping's natural order (so its groups turn around)? */
const reversed = (by: GroupBy, sort: { key: SortBy; dir: "asc" | "desc" }) => {
  if (by === "modified" || by === "created") return sort.key === by && sort.dir === "asc";
  return sort.key === by && sort.dir === "desc";
};

/**
 * `entries` (already sorted) in groups. Folders-first lists keep folders' own groups ahead only
 * where the grouping makes them a group (Kind, Type, Size); by name or date they mix in.
 */
export function groupEntries(entries: Entry[], by: GroupBy, sort: { key: SortBy; dir: "asc" | "desc" }, now = Date.now()): Grouped {
  if (by === "none" || entries.length === 0) return { entries, groups: null };
  const slots = entries.map((e) => slotOf(e, by, now));
  const flip = reversed(by, sort) ? -1 : 1;
  const cmp = (a: Slot, b: Slot) => {
    // folders' own group (Kind, Type, Size) stays first whichever way
    const fa = a.label === "Folders",
      fb = b.label === "Folders";
    if (fa !== fb) return fa ? -1 : 1;
    const r = typeof a.rank === "number" && typeof b.rank === "number" ? a.rank - b.rank : byName.compare(String(a.rank), String(b.rank));
    return r * flip;
  };
  // stable: inside a group the sort's order holds
  const order = entries.map((_, i) => i).sort((i, j) => cmp(slots[i], slots[j]) || i - j);
  const out: Entry[] = [];
  const groups: Group[] = [];
  for (const i of order) {
    const s = slots[i];
    const last = groups[groups.length - 1];
    if (last && last.label === s.label) last.count++;
    else groups.push({ key: `${by}:${s.label}`, label: s.label, start: out.length, count: 1 });
    out.push(entries[i]);
  }
  return { entries: out, groups };
}
