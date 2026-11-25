// Mirror's exclude rules (src/mirror/lib/ignore.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EXCLUDES, makeMatcher } from "../../src/mirror/lib/ignore.ts";

test("names match at any depth, folders only with a trailing slash", () => {
  const m = makeMatcher(DEFAULT_EXCLUDES);
  assert.equal(m(".git", true), true);
  assert.equal(m(".git/HEAD", false), true, "inside an excluded folder");
  assert.equal(m("packages/app/node_modules/react/index.js", false), true);
  assert.equal(m("a/b/.DS_Store", false), true);
  assert.equal(m(".env", false), true);
  assert.equal(m(".env.example", false), false);
  assert.equal(m("node_modules", false), false, "a file called node_modules isn't a folder");
  assert.equal(m("src/index.js", false), false);
});

test("anchored patterns, globs, sets and globstars", () => {
  const m = makeMatcher(["/dist", "docs/*.bak", "**/cache/**", "*.log", "img/[ab]?.png", "build/"]);
  assert.equal(m("dist", true), true);
  assert.equal(m("dist/app.js", false), true);
  assert.equal(m("src/dist/x", false), false, "a leading slash anchors to the top");
  assert.equal(m("docs/a.bak", false), true);
  assert.equal(m("docs/sub/a.bak", false), false, "* stays within one name");
  assert.equal(m("x/y/cache/z/1.bin", false), true);
  assert.equal(m("cache/1.bin", false), true, "**/ also matches no folders");
  assert.equal(m("logs/today.log", false), true);
  assert.equal(m("img/a1.png", false), true);
  assert.equal(m("img/c1.png", false), false);
  assert.equal(m("img/ab1.png", false), false);
  assert.equal(m("deep/build", true), true, "an unanchored folder pattern matches at any depth");
});

test("negation takes a file back in, but not out of an excluded folder", () => {
  const m = makeMatcher("*.log\n!keep.log\nsecret/\n!secret/ok.txt\n# comment\n\n");
  assert.equal(m("a.log", false), true);
  assert.equal(m("x/keep.log", false), false);
  assert.equal(m("secret/ok.txt", false), true, "git can't re-include inside an excluded folder");
  assert.equal(m.size, 4);
});

test("later texts win, escapes and blank rules", () => {
  const m = makeMatcher(DEFAULT_EXCLUDES, "!.env", "\\#notes.txt");
  assert.equal(m(".env", false), false, "the folder's .gitignore can take a default back");
  assert.equal(m("#notes.txt", false), true);
  assert.equal(makeMatcher("", "   ", "#x")("anything", false), false);
});
