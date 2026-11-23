// Mirror's listing (src/mirror/listing.ts): links are never gone into, and a destination is only
// "not there yet" when its parent lists to the end without it. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { folderMissing, walkWith, type Lister } from "../../src/mirror/listing.ts";
import { makeMatcher } from "../../src/mirror/ignore.ts";
import { planMirror, type Listing } from "../../src/mirror/plan.ts";
import type { ListResult, ObjInfo } from "../../src/types.ts";

const obj = (key: string, size = 1, extra: Partial<ObjInfo> = {}): ObjInfo => ({ key, size, modified: 1000, etag: null, storageClass: null, ...extra });
const page = (folders: string[], objects: ObjInfo[], extra: Partial<ListResult> = {}): ListResult => ({ folders, objects, nextToken: null, ...extra });
const tree = (pages: Record<string, ListResult>): Lister => async (prefix) => {
  const p = pages[prefix];
  if (!p) throw new Error(`listed ${prefix}`);
  return p;
};
const at = (dir: string) => ({ profileId: "sftp", root: "", dir });
const none = makeMatcher([]);

test("an SFTP folder link is noted, not gone into (B4-1)", async () => {
  const list = tree({
    "public_html/": page(["public_html/css/", "public_html/uploads/"], [obj("public_html/index.html")], {
      folderInfo: [obj("public_html/uploads/", 0, { link: "/srv/shared/uploads" })],
    }),
    "public_html/css/": page([], [obj("public_html/css/site.css")]),
    // listing it would throw: the walk must never ask
  });
  const l = await walkWith(list, at("public_html/"), null, none);
  assert.deepEqual([...l.files.keys()].sort(), ["css/site.css", "index.html"]);
  assert.deepEqual([...l.dirs], ["css/"]);
  assert.deepEqual([...(l.links ?? [])], ["uploads/"]);
});

test("links listed as files (this computer, SFTP file links) are noted, not copied", async () => {
  const list = tree({ "": page([], [obj("readme.md"), obj("config.json", 40, { link: "../../.aws/credentials" }), obj("Documents", 0, { link: "/Users/me/Documents" })]) });
  const l = await walkWith(list, at(""), null, none);
  assert.deepEqual([...l.files.keys()], ["readme.md"]);
  assert.deepEqual([...(l.links ?? [])].sort(), ["Documents", "config.json"]);
});

test("also delete never reaches behind a destination link, and source content isn't written through one", () => {
  const src: Listing = { files: new Map([["index.html", { size: 1, mtime: 1000 }], ["uploads/new.jpg", { size: 5, mtime: 1000 }]]), dirs: new Set(["uploads/"]), excluded: 0 };
  const dst: Listing = {
    files: new Map([["index.html", { size: 1, mtime: 1000 }], ["uploads/a.jpg", { size: 9, mtime: 1000 }], ["old.html", { size: 2, mtime: 1000 }]]),
    dirs: new Set(),
    excluded: 0,
    links: new Set(["uploads/", "notes.txt"]),
  };
  const p = planMirror(src, dst, { deleteExtra: true, compare: "time", toleranceMs: 2000 });
  assert.deepEqual(p.remove.map((r) => r.rel), ["old.html"], "only what's outside any link");
  assert.deepEqual(p.removeDirs, []);
  assert.deepEqual(p.upload.map((u) => u.rel), [], "nothing is copied into the linked folder");
  assert.deepEqual(p.mkdirs, []);
  assert.ok(p.links.some((l) => l.rel === "uploads" && /destination/.test(l.note ?? "")));
  assert.ok(p.links.some((l) => l.rel === "uploads/new.jpg"));

  // a link at the source: the destination's real folder of that name is left alone too
  const s2: Listing = { files: new Map(), dirs: new Set(), excluded: 0, links: new Set(["shared"]) };
  const d2: Listing = { files: new Map([["shared/x.txt", { size: 1, mtime: 1 }]]), dirs: new Set(["shared/"]), excluded: 0 };
  const p2 = planMirror(s2, d2, { deleteExtra: true, compare: "time", toleranceMs: 2000 });
  assert.deepEqual([p2.remove.length, p2.removeDirs.length], [0, 0]);
});

test("a destination is missing only when its parent lists to the end without it (F4-1)", async () => {
  const pages: Record<string, ListResult[]> = {
    "bucket-top/": [page([], [obj("bucket-top/a")], { nextToken: "2" }), page(["bucket-top/site/"], [])],
  };
  const list: Lister = async (prefix, token) => pages[prefix][token ? Number(token) - 1 : 0];
  assert.equal(await folderMissing(list, at("bucket-top/site/")), false, "found on page 2");
  assert.equal(await folderMissing(list, at("bucket-top/other/")), true, "not on any page");
  const failing: Lister = async () => {
    throw new Error("timeout");
  };
  assert.equal(await folderMissing(failing, at("bucket-top/site/")), false, "an unknown is never missing");
  assert.equal(await folderMissing(list, at("")), false, "the top always is");
});
