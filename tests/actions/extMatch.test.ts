// Custom actions: which files an action's "Extensions" take (src/actions/lib/extMatch.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { extList, hasExt } from "../../src/actions/lib/extMatch.ts";

test("the box is split, dots dropped, lower-cased", () => {
  assert.deepEqual(extList("jpg, .PNG; tar.gz"), ["jpg", "png", "tar.gz"]);
  assert.deepEqual(extList("*.jpg, *.PNG *"), ["jpg", "png"]);
});

test("double extensions match; plain ones as before", () => {
  assert.equal(hasExt("backup.tar.gz", ["tar.gz"]), true);
  assert.equal(hasExt("notes.gz", ["tar.gz"]), false);
  assert.equal(hasExt("backup.tar.gz", ["gz"]), true);
  assert.equal(hasExt("Photo.JPG", ["jpg"]), true);
  assert.equal(hasExt("jpg", ["jpg"]), false);
  assert.equal(hasExt(".gz", ["gz"]), false);
  assert.equal(hasExt("archive.targz", ["gz"]), false);
});
