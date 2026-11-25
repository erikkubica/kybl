import test from "node:test";
import assert from "node:assert/strict";
import { holdingGroups, moveInto, organize, togglePins, typeOf } from "../../src/connections/lib/organize.ts";
import type { Profile } from "../../src/core/types.ts";

const p = (id: string, extra: Partial<Profile> = {}): Profile => ({
  id,
  name: id,
  kind: "s3",
  provider: "aws",
  endpoint: "",
  region: "",
  accessKeyId: "",
  pathStyle: false,
  ...extra,
});
const ftp = (id: string, extra: Partial<Profile> = {}) => p(id, { kind: "ftp", provider: "ftp", ...extra });
const many = (n: number, tag = "") => Array.from({ length: n }, (_, i) => ftp(`site ${String(i).padStart(3, "0")}${tag}`));

test("pinned connections come first, by name, and stay in their group too", () => {
  const list = [p("b", { pinned: true, group: "Work" }), p("a", { pinned: true }), p("c")];
  const o = organize(list);
  assert.deepEqual(o.pinned.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(o.groups[0].items.map((x) => x.id), ["b"]);
});

test("groups nest by slash and ungrouped connections go by name", () => {
  const o = organize([p("z"), p("a"), p("m", { group: "Clients/Acme" })]);
  assert.deepEqual(o.items.map((x) => x.id), ["a", "z"]);
  assert.equal(o.groups[0].name, "Clients");
  assert.equal(o.groups[0].groups[0].path, "Clients/Acme");
  assert.equal(o.groups[0].count, 1);
  assert.deepEqual(holdingGroups(o.groups).map((g) => g.label), ["Clients › Acme"]);
});

test("more than 15 ungrouped connections are sorted by type; 15 are not", () => {
  assert.equal(organize(many(15)).byType, false);
  const list = [...many(10), ...many(5, "b"), p("bucket"), p("d", { kind: "gdrive", provider: "gdrive" })];
  const o = organize(list);
  assert.equal(o.byType, true);
  assert.deepEqual(o.groups.map((g) => g.name), ["Servers", "Cloud drives", "Object storage"]);
  assert.equal(o.groups[0].count, 15);
  assert.ok(o.groups.every((g) => g.byType));
  assert.equal(o.items.length, 0);
  assert.equal(typeOf(p("x")).label, "Object storage");
});

test("the device stays at the top level while the rest is sorted by type", () => {
  const mac = p("local", { kind: "local", provider: "local" });
  const o = organize([mac, ...many(20)]);
  assert.deepEqual(o.items.map((x) => x.id), ["local"]);
  assert.equal(o.groups[0].count, 20);
});

test("recent: the last five opened, not pinned, only for long lists", () => {
  const list = [...many(12), p("pin", { pinned: true })];
  const ids = list.map((x) => x.id);
  const o = organize(list, { recent: ["pin", ...ids.slice(0, 8), "gone"], skipRecent: ids[0] });
  assert.deepEqual(o.recent.map((x) => x.id), ids.slice(1, 6));
  assert.equal(organize(many(5), { recent: ["site 001"] }).recent.length, 0);
});

test("500 connections organize quickly", () => {
  const list = Array.from({ length: 500 }, (_, i) => ftp(`c${i}`, { group: i % 3 === 0 ? `g${i % 17}/s${i % 5}` : null }));
  const t = performance.now();
  const o = organize(list, { recent: ["c1", "c2"] });
  assert.ok(performance.now() - t < 200);
  assert.equal(o.groups.reduce((n, g) => n + (g.byType ? g.count : g.count), 0), list.length);
});

test("moving and pinning only change what needs to", () => {
  const list = [p("a", { group: "X" }), p("b"), p("c", { pinned: true }), p("local", { kind: "local" })];
  assert.deepEqual(moveInto(list, ["a", "b", "local"], "X"), { b: "X" });
  assert.deepEqual(moveInto(list, ["a"], ""), { a: "" });
  assert.deepEqual(togglePins(list, ["a", "b"]), { a: true, b: true });
  assert.deepEqual(togglePins(list, ["c"]), { c: false });
  assert.deepEqual(togglePins(list, ["c", "a"]), { c: true, a: true });
});
