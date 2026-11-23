// Workspace recipes (src/shell/recipes.ts): saving a layout, opening it again. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureRecipe, freeName, matchesRecipe, openRecipe, startupLines, terminalPanes } from "../../src/shell/recipes.ts";
import type { Layout } from "../../src/shell/workspaces.ts";

const view = { view: "list" as const, sort: null, hidden: null, compact: null, tile: null };
const site = { profileId: "local", bucket: "/home/me", prefix: "Sites/acme/" };
const live = { profileId: "ftp1", bucket: "/", prefix: "public_html/" };
// left: This Mac, right: FTP, below left: a terminal (running), below that another
const layout: Layout = {
  tree: {
    t: "split",
    dir: "row",
    sizes: [50, 50],
    kids: [
      { t: "split", dir: "col", sizes: [60, 20, 20], kids: [{ t: "pane", id: "left" }, { t: "pane", id: "c" }, { t: "pane", id: "d" }] },
      { t: "pane", id: "right" },
    ],
  },
  links: [],
  recent: ["left", "right", "c", "d"],
  panes: {
    left: { loc: site, view, scroll: 120 },
    right: { loc: live, view: { ...view, view: "grid" } },
    c: { loc: null, view, term: { ...site, sid: "t-old", from: "left", follow: true } },
    d: { loc: null, view, term: { ...site, sid: "t-old2", from: "left" } },
  },
};
const names: Record<string, string> = { local: "This Mac", ftp1: "Acme live" };

test("a recipe keeps places, views and terminal folders, not sessions or scroll", () => {
  const r = captureRecipe(layout, (id) => names[id]);
  assert.deepEqual(r.panes.left, { loc: site, view, conn: "This Mac" });
  assert.equal(r.panes.right?.view.view, "grid");
  assert.equal(r.panes.right?.conn, "Acme live");
  assert.deepEqual(r.panes.c?.term, { ...site, from: "left", follow: true, key: "t-old" });
  assert.equal(r.panes.c?.term?.sid, undefined);
  assert.deepEqual(terminalPanes(r), ["c", "d"]);
  assert.ok(matchesRecipe(layout, r));
  // nothing shared with the layout it came from
  r.panes.left!.loc!.prefix = "x/";
  assert.equal(layout.panes.left?.loc?.prefix, "Sites/acme/");
});

test("updating a recipe keeps each terminal's startup commands", () => {
  const first = captureRecipe(layout, (id) => names[id]);
  first.panes.c!.startup = ["npm run dev"];
  first.panes.d!.startup = ["claude"];
  const moved: Layout = { ...layout, panes: { ...layout.panes, d: { loc: site, view } } };
  const again = captureRecipe(moved, (id) => names[id], first);
  assert.deepEqual(again.panes.c?.startup, ["npm run dev"]);
  // d is a file pane now: no commands
  assert.equal(again.panes.d?.startup, undefined);
  assert.ok(!matchesRecipe(moved, first));
});

test("opening a recipe makes fresh sessions with their startup lines", () => {
  const r = captureRecipe(layout, (id) => names[id]);
  r.panes.c!.startup = ["  npm run dev ", "", "echo ok"];
  let n = 0;
  const o = openRecipe(r, () => `s${++n}`, () => true);
  assert.equal(o.layout.panes.c?.term?.sid, "s1");
  assert.equal(o.layout.panes.d?.term?.sid, "s2");
  assert.deepEqual(o.startups, [["s1", ["npm run dev", "echo ok"]]]);
  assert.deepEqual(o.missing, {});
  assert.equal(o.layout.panes.c?.startup, undefined);
  assert.equal(o.layout.panes.left?.conn, undefined);
});

test("a pane whose connection is gone opens empty, named in a note", () => {
  const r = captureRecipe(layout, (id) => names[id]);
  const o = openRecipe(r, () => "s", (id) => id !== "ftp1");
  assert.deepEqual(o.missing, { right: "Acme live" });
  assert.deepEqual(o.layout.panes.right, { loc: null, view: { ...view, view: "grid" } });
  // not known yet (launch): nothing is missing
  assert.deepEqual(openRecipe(r, () => "s", null).missing, {});
});

test("startup commands follow the terminal, not its slot", () => {
  const first = captureRecipe(layout, (id) => names[id]);
  first.panes.c!.startup = ["npm run dev"];
  // opened again: the live terminals carry the recipe's keys under fresh sessions
  let n = 0;
  const o = openRecipe(first, () => `s${++n}`, () => true);
  assert.equal(o.layout.panes.c?.term?.key, "t-old");
  assert.deepEqual(captureRecipe(o.layout, (id) => names[id], first).panes.c?.startup, ["npm run dev"]);
  // that terminal closed and a new one opened in the same slot: nothing inherited
  const fresh: Layout = { ...o.layout, panes: { ...o.layout.panes, c: { loc: null, view, term: { ...site, sid: "t-new" } } } };
  const again = captureRecipe(fresh, (id) => names[id], first);
  assert.equal(again.panes.c?.startup, undefined);
  assert.equal(again.panes.c?.term?.key, "t-new");
  // the terminal moved to another slot keeps its commands
  const tree: Layout["tree"] = { t: "split", dir: "row", sizes: [50, 50], kids: [{ t: "pane", id: "left" }, { t: "pane", id: "right" }] };
  const moved: Layout = { tree, links: [], recent: ["left", "right"], panes: { left: o.layout.panes.left, right: o.layout.panes.c } };
  assert.deepEqual(captureRecipe(moved, (id) => names[id], first).panes.right?.startup, ["npm run dev"]);
});

test("recipes saved before keys: same slot and connection only", () => {
  const old: Layout = { ...layout, panes: { ...layout.panes, c: { loc: null, view, term: { ...site }, startup: ["make"] } } };
  const now: Layout = { ...layout, panes: { ...layout.panes, c: { loc: null, view, term: { ...site, prefix: "x/", sid: "t9" } } } };
  assert.deepEqual(captureRecipe(now, (id) => names[id], old).panes.c?.startup, ["make"]);
  const elsewhere: Layout = { ...layout, panes: { ...layout.panes, c: { loc: null, view, term: { profileId: "sftp9", bucket: "/", prefix: "", sid: "t9" } } } };
  assert.equal(captureRecipe(elsewhere, (id) => names[id], old).panes.c?.startup, undefined);
});

test("startup lines and names", () => {
  assert.deepEqual(startupLines([" a ", "", "  ", "b"]), ["a", "b"]);
  assert.deepEqual(startupLines(undefined), []);
  assert.equal(freeName(["Acme dev"], "Photos"), "Photos");
  assert.equal(freeName(["Acme dev", "acme dev 2"], "Acme dev"), "Acme dev 3");
});
