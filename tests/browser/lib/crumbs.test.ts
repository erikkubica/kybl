// A pane's path (src/browser/lib/crumbs.ts): one list of steps for every kind of place, and how many fold into "…". Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { folderCrumbs, foldCount, placeCrumbs, type CrumbPlace } from "../../../src/browser/lib/crumbs.ts";

const trail: string[] = [];
const base = (over: Partial<CrumbPlace>): CrumbPlace => ({
  connection: "This Mac",
  single: false,
  root: "/Users/demo",
  rootLabel: "Home",
  prefix: "Downloads/photos/",
  toConnection: () => trail.push("roots"),
  toPrefix: (p) => trail.push(`at:${p}`),
  drops: true,
  ...over,
});
const labels = (c: { label: string }[]) => c.map((x) => x.label);

test("a connection with roots: connection › root › folders, each going to its own place", () => {
  trail.length = 0;
  const c = placeCrumbs(base({}));
  assert.deepEqual(labels(c), ["This Mac", "Home", "Downloads", "photos"]);
  c.forEach((x) => x.go?.());
  assert.deepEqual(trail, ["roots", "at:", "at:Downloads/", "at:Downloads/photos/"]);
  assert.deepEqual(c.map((x) => x.drop), [undefined, "", "Downloads/", "Downloads/photos/"]);
});

test("at the connection's top only its name shows, and it isn't a link to itself", () => {
  const c = placeCrumbs(base({ root: null, prefix: "", toConnection: undefined }));
  assert.deepEqual(labels(c), ["This Mac"]);
  assert.equal(c[0].go, undefined);
});

test("one root: the connection's name is its top", () => {
  trail.length = 0;
  const c = placeCrumbs(base({ connection: "Web server", single: true, root: "/", prefix: "var/www/" }));
  assert.deepEqual(labels(c), ["Web server", "var", "www"]);
  c[0].go?.();
  assert.deepEqual(trail, ["at:"]);
  assert.equal(c[0].drop, "");
});

test("no drops where the place isn't the pane's own", () => {
  const c = placeCrumbs(base({ drops: false }));
  assert.ok(c.every((x) => x.drop === undefined));
  assert.ok(folderCrumbs("a/b/", () => {}).every((x) => x.drop === undefined));
});

test("folding: nothing while it fits, then from the root side, keeping the first and the last", () => {
  const w = [80, 60, 70, 90, 100]; // conn, root, a, b, current
  assert.equal(foldCount(w, 30, 1000), 0);
  assert.equal(foldCount(w, 30, 400), 0); // 400 exactly
  assert.equal(foldCount(w, 30, 399), 1); // conn … a b current = 80+30+70+90+100 = 370
  assert.equal(foldCount(w, 30, 300), 2); // conn … b current = 300
  assert.equal(foldCount(w, 30, 100), 3); // never the last: conn … current
  assert.equal(foldCount([80, 100], 30, 10), 0);
});
