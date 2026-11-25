// "Group by" (src/browser/lib/grouping.ts): groups, their order, and the sort kept inside them. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { dateSlot, groupEntries } from "../../../src/browser/lib/grouping.ts";
import type { Entry } from "../../../src/core/types.ts";

const f = (name: string, size = 10, modified: number | null = null): Entry => ({ kind: "file", key: name, name, size, modified });
const dir = (name: string): Entry => ({ kind: "folder", key: `${name}/`, name, size: 0, modified: null });
const asc = { key: "name" as const, dir: "asc" as const };

test("not grouping leaves the list alone", () => {
  const list = [f("b"), f("a")];
  assert.deepEqual(groupEntries(list, "none", asc), { entries: list, groups: null });
});

test("by type: folders first, then extensions A to Z, the sort kept inside each", () => {
  const { entries, groups } = groupEntries([f("b.txt"), dir("x"), f("a.pdf"), f("a.txt"), f("README")], "type", asc);
  assert.deepEqual(groups?.map((g) => [g.label, g.start, g.count]), [["Folders", 0, 1], ["PDF", 1, 1], ["TXT", 2, 2], ["No extension", 4, 1]]);
  assert.deepEqual(entries.map((e) => e.name), ["x", "a.pdf", "b.txt", "a.txt", "README"]);
});

test("by size: smallest first, turned around when sorted largest first", () => {
  const list = [f("big", 2e9), f("tiny", 100), f("mid", 5e6)];
  assert.deepEqual(groupEntries(list, "size", asc).entries.map((e) => e.name), ["tiny", "mid", "big"]);
  assert.deepEqual(groupEntries(list, "size", { key: "size", dir: "desc" }).entries.map((e) => e.name), ["big", "mid", "tiny"]);
});

test("by name: letters, then digits and the rest", () => {
  const { groups } = groupEntries([f("apple"), f("Avocado"), f("2024.txt"), f("_x"), f("banana")], "name", asc);
  assert.deepEqual(groups?.map((g) => [g.label, g.count]), [["0–9", 1], ["#", 1], ["A", 2], ["B", 1]]);
});

test("dates: today, yesterday, the weeks, months and years before", () => {
  const now = new Date(2026, 10, 25, 12).getTime(); // a Wednesday
  const at = (y: number, m: number, d: number) => new Date(y, m, d, 10).getTime();
  assert.equal(dateSlot(at(2026, 10, 25), now).label, "Today");
  assert.equal(dateSlot(at(2026, 10, 24), now).label, "Yesterday");
  assert.equal(dateSlot(at(2026, 10, 23), now).label, "Earlier this week");
  assert.equal(dateSlot(at(2026, 10, 18), now).label, "Last week");
  assert.equal(dateSlot(at(2026, 10, 3), now).label, "Earlier this month");
  assert.equal(dateSlot(at(2026, 9, 3), now).label, "Last month");
  assert.equal(dateSlot(at(2026, 1, 3), now).label, "Earlier this year");
  assert.equal(dateSlot(at(2023, 1, 3), now).label, "2023");
  assert.equal(dateSlot(null, now).label, "No date");
  // newest first
  const { groups } = groupEntries([f("old", 1, at(2023, 1, 3)), f("new", 1, at(2026, 10, 25)), f("none")], "modified", asc, now);
  assert.deepEqual(groups?.map((g) => g.label), ["Today", "2023", "No date"]);
});
