// Mirror's plan (src/mirror/plan.ts): new, changed, gone, excluded, FTP times. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { caseInsensitiveKind, compareFiles, defaultTolerance, detectOffset, foldersOverlap, groupByFolder, planIsEmpty, planMirror, type Listing, type MFile, type PlanOptions } from "../../src/mirror/plan.ts";

const T = Date.UTC(2026, 10, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const f = (size: number, mtime: number | null = T, md5?: string): MFile => ({ size, mtime, md5 });
const listing = (files: Record<string, MFile>, dirs: string[] = [], excluded = 0): Listing => ({ files: new Map(Object.entries(files)), dirs: new Set(dirs), excluded });
const opts = (o: Partial<PlanOptions> = {}): PlanOptions => ({ deleteExtra: false, compare: "time", toleranceMs: 2000, ...o });
const rels = (xs: { rel: string }[]) => xs.map((x) => x.rel);

test("a link keeps its own name in the Skip list on a case-insensitive destination", () => {
  const src: Listing = { ...listing({ "a.txt": f(1) }), links: new Set(["Photos"]) };
  const p = planMirror(src, listing({}), opts({ caseInsensitive: true }));
  assert.deepEqual(rels(p.links), ["Photos"]);
});

test("a link's name is listed once, also when the other side has a file of that name", () => {
  const src: Listing = { ...listing({ "a.txt": f(1) }), links: new Set(["x", "dir/"]) };
  const dst = listing({ x: f(5), "dir/inner.txt": f(2), "a.txt": f(1) }, ["dir/"]);
  const p = planMirror(src, dst, opts({ deleteExtra: true }));
  assert.deepEqual(rels(p.links).sort(), ["dir", "dir/inner.txt", "x"]);
  assert.deepEqual(rels(p.remove), [], "nothing at or below a link is deleted");
});

test("new, changed, same and gone", () => {
  const src = listing({ "index.html": f(10), "about.html": f(20, T + 10 * MIN), "css/site.css": f(5), "js/app.js": f(7), "new.txt": f(3) }, ["css/", "js/", "empty/"]);
  const dst = listing({ "index.html": f(10), "about.html": f(20), "css/site.css": f(6), "js/app.js": f(7, T + HOUR), "old.html": f(9), "img/a.png": f(100) }, ["css/", "js/", "img/"]);
  const p = planMirror(src, dst, opts());
  assert.deepEqual(rels(p.upload), ["about.html", "css/site.css", "new.txt"]);
  assert.deepEqual(p.upload.map((c) => c.why), ["changed", "changed", "new"]);
  assert.equal(p.upload[0].note, "newer here");
  assert.equal(p.upload[1].note, "another size");
  assert.equal(p.same, 2, "a destination copy newer than the source is the same file");
  assert.deepEqual(p.mkdirs, ["empty/"]);
  assert.deepEqual(rels(p.remove), [], "nothing is deleted unless asked");
  assert.deepEqual(rels(p.kept), ["img/a.png", "old.html"]);
  assert.equal(p.uploadBytes, 28);

  const del = planMirror(src, dst, opts({ deleteExtra: true }));
  assert.deepEqual(rels(del.remove), ["img/a.png", "old.html"]);
  assert.deepEqual(del.removeDirs, ["img/"]);
  assert.equal(del.removeBytes, 109);
  assert.deepEqual(rels(del.kept), []);
});

test("folders: parents first to make, deepest first to delete", () => {
  const src = listing({}, ["a/", "a/b/", "a/b/c/", "z/"]);
  const dst = listing({}, ["q/", "q/r/", "q/r/s/"]);
  const p = planMirror(src, dst, opts({ deleteExtra: true }));
  assert.deepEqual(p.mkdirs, ["a/", "z/", "a/b/", "a/b/c/"]);
  assert.deepEqual(p.removeDirs, ["q/r/s/", "q/r/", "q/"]);
  assert.equal(planIsEmpty(planMirror(src, src, opts())), true);
});

test("FTP's minute-precision times are within the tolerance", () => {
  assert.equal(defaultTolerance(["local", "ftp"]), 61_000);
  assert.equal(defaultTolerance(["local", "sftp"]), 2000);
  const src = listing({ "a.txt": f(1, T + 45_000), "b.txt": f(1, T + 5 * MIN) });
  // the server rounded a.txt's time down to the minute
  const dst = listing({ "a.txt": f(1, T), "b.txt": f(1, T) });
  assert.deepEqual(rels(planMirror(src, dst, opts({ toleranceMs: 2000 })).upload), ["a.txt", "b.txt"]);
  assert.deepEqual(rels(planMirror(src, dst, opts({ toleranceMs: defaultTolerance(["ftp"]) })).upload), ["b.txt"]);
});

test("a server listing in another time zone is spotted and allowed for", () => {
  const files: Record<string, MFile> = {};
  const shifted: Record<string, MFile> = {};
  for (let i = 0; i < 6; i++) {
    files[`f${i}.txt`] = f(100 + i, T - i * HOUR);
    // the same times, listed as if 2 hours earlier (LIST in UTC-2 read as UTC), minutes only
    shifted[`f${i}.txt`] = f(100 + i, T - i * HOUR - 2 * HOUR + 30_000);
  }
  // one file really was edited after it was uploaded
  files["f0.txt"] = f(100, T + 3 * HOUR);
  const p = planMirror(listing(files), listing(shifted), opts({ toleranceMs: 61_000 }));
  assert.equal(p.offsetMs, -2 * HOUR);
  assert.deepEqual(rels(p.upload), ["f0.txt"]);
  // without a consistent shift nothing is assumed
  assert.equal(detectOffset([[f(1, T), f(1, T + HOUR)], [f(2, T), f(2, T)], [f(3, T), f(3, T + 3 * HOUR)]], 2000), 0);
});

test("S3 keeps upload times: a file is changed only when edited after its upload", () => {
  const src = listing({ "edited.css": f(50, T + 2 * HOUR), "untouched.css": f(50, T - 5 * HOUR) });
  const dst = listing({ "edited.css": f(50, T), "untouched.css": f(50, T) });
  assert.deepEqual(rels(planMirror(src, dst, opts()).upload), ["edited.css"]);
  // size only: same size is the same file
  assert.deepEqual(rels(planMirror(src, dst, opts({ compare: "size" })).upload), []);
});

test("checksums decide where both sides know them, times elsewhere", () => {
  const src = listing({ "same.bin": f(4, T + HOUR, "aa"), "diff.bin": f(4, T - HOUR, "AA"), "nohash.bin": f(4, T + HOUR) });
  const dst = listing({ "same.bin": f(4, T, "AA"), "diff.bin": f(4, T, "bb"), "nohash.bin": f(4, T, "cc") });
  const p = planMirror(src, dst, opts({ compare: "checksum" }));
  assert.deepEqual(rels(p.upload), ["diff.bin", "nohash.bin"]);
  assert.equal(p.upload[0].note, "different content");
  assert.equal(p.checksummed, 2);
  assert.equal(compareFiles(f(4, null, "x"), f(5, null, "x"), opts({ compare: "checksum" })).changed, true, "another size is changed whatever the hash");
});

test("a file and a folder of one name block each other; letter case never deletes", () => {
  const src = listing({ docs: f(1), "logo.png": f(3) }, ["assets/"]);
  const dst = listing({ assets: f(2), "Logo.png": f(3), "docs/readme.md": f(4) }, ["docs/"]);
  const p = planMirror(src, dst, opts({ deleteExtra: true }));
  assert.deepEqual(rels(p.blocked).sort(), ["assets/", "docs"]);
  assert.deepEqual(rels(p.upload), ["logo.png"]);
  assert.deepEqual(p.mkdirs, []);
  assert.ok(!rels(p.remove).includes("Logo.png"), "where case doesn't count, Logo.png is the file just copied");
  assert.deepEqual(rels(p.kept), ["Logo.png"]);
  assert.deepEqual(p.removeDirs, [], "the blocked folder isn't deleted");
});

test("a destination that ignores letter case: matched in any case, nothing it holds is deleted, clashing source names are refused", () => {
  const src = listing({ "photo.jpg": f(3), "docs/a.txt": f(1), "A.txt": f(2), "a.txt": f(5), "new.txt": f(4) }, ["docs/", "img/"]);
  const dst = listing({ "Photo.jpg": f(3), "Docs/a.txt": f(1), "Docs/old.txt": f(6), "gone.txt": f(7) }, ["Docs/", "IMG/", "Stale/"]);
  const p = planMirror(src, dst, opts({ deleteExtra: true, caseInsensitive: true }));
  assert.deepEqual(rels(p.upload), ["A.txt", "new.txt"], "Photo.jpg and Docs/a.txt are the same files");
  assert.deepEqual(rels(p.unchanged), ["docs/a.txt", "photo.jpg"]);
  assert.deepEqual(p.mkdirs, [], "Docs/ and IMG/ are already there");
  assert.deepEqual(rels(p.blocked), ["a.txt"], "a.txt would land on A.txt");
  assert.deepEqual(rels(p.remove), ["Docs/old.txt", "gone.txt"]);
  assert.deepEqual(p.removeDirs, ["Stale/"], "Docs/ and IMG/ are the source's folders");
  assert.ok(!rels(p.remove).some((r) => ["Photo.jpg", "Docs/a.txt", "A.txt", "a.txt"].includes(r)));

  // where case counts both names are mirrored, and a case variant still isn't deleted
  const cs = planMirror(src, dst, opts({ deleteExtra: true }));
  assert.deepEqual(rels(cs.blocked), []);
  assert.ok(rels(cs.upload).includes("a.txt") && rels(cs.upload).includes("photo.jpg"));
  assert.ok(!rels(cs.remove).includes("Photo.jpg") && !cs.removeDirs.includes("Docs/"));

  assert.ok(caseInsensitiveKind("local", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"));
  assert.ok(caseInsensitiveKind("local", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"));
  assert.ok(!caseInsensitiveKind("local", "Mozilla/5.0 (X11; Linux x86_64)"));
  assert.ok(caseInsensitiveKind("dropbox", "Linux") && caseInsensitiveKind("box", "") && caseInsensitiveKind("onedrive", ""));
  assert.ok(!caseInsensitiveKind("s3", "Macintosh") && !caseInsensitiveKind("gdrive", "Windows"));
});

test("excluded counts come through, and changes group by folder", () => {
  const p = planMirror(listing({ "a/1": f(1), "a/2": f(2), "b/3": f(3), top: f(4) }, ["a/", "b/"], 7), listing({}, [], 2), opts());
  assert.equal(p.excluded, 9);
  const g = groupByFolder(p.upload);
  assert.deepEqual(g.map((x) => [x.dir, x.items.length, x.bytes]), [["", 1, 4], ["a/", 2, 3], ["b/", 1, 3]]);
});

test("folders inside each other are caught, Windows roots included", () => {
  const at = (profileId: string, root: string, dir: string) => ({ profileId, root, dir });
  const L = (root: string, dir: string) => at("local", root, dir);
  assert.equal(foldersOverlap(at("a", "r", "site/"), at("a", "r", "out/"), false), false);
  assert.equal(foldersOverlap(at("a", "r", "site/"), at("a", "r", "site/out/"), false), true);
  assert.equal(foldersOverlap(at("a", "r", "site/"), at("a", "q", ""), false), false);
  assert.equal(foldersOverlap(L("/home/me", "Sites/"), L("/home/me/Sites", "acme/"), false), true);
  assert.equal(foldersOverlap(L("/home/me", "Sites/acme/"), L("/home/me/Sites", "acme-live/"), false), false);
  assert.equal(foldersOverlap(L("/home/me/Sites", ""), L("/home/me/Sites2", ""), false), false);
  assert.equal(foldersOverlap(L("/home/me/a", ""), L("/home/me/A", ""), false), false, "case counts on Linux");
  assert.equal(foldersOverlap(L("/Users/me/a", ""), L("/Users/me/A/x", ""), true), true, "not on macOS");
  // B4-1: backslash roots, slash folders below them
  assert.equal(foldersOverlap(L("C:\\Users\\me", "Sites/"), L("C:\\Users\\me\\Sites", "out/"), false), true);
  assert.equal(foldersOverlap(L("C:\\Users\\me\\Sites", ""), L("C:\\Users\\me", "Sites/out/"), false), true);
  assert.equal(foldersOverlap(L("C:\\Users\\me", "Sites/"), L("c:\\users\\ME\\sites", ""), false), true);
  assert.equal(foldersOverlap(L("C:\\", ""), L("C:\\Data", ""), false), true);
  assert.equal(foldersOverlap(L("C:\\Users\\me", "Sites/"), L("C:\\Users\\me\\Sites2", ""), false), false);
  assert.equal(foldersOverlap(L("C:\\Users\\me", ""), L("D:\\Users\\me", ""), false), false);
});
