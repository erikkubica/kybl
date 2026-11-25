// Folder compare: ETags count only where they are content hashes on both sides. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareFolders, etagsComparable } from "../../src/compare/compareFolders.ts";
import type { Entry } from "../../src/core/types.ts";

const T = Date.UTC(2026, 10, 20, 12, 0, 0);
const file = (name: string, etag: string | null, modified = T, size = 10) => ({ key: name, name, kind: "file", size, modified, etag }) as unknown as Entry;

test("only two non-Kybl S3 listings have comparable ETags", () => {
  assert.equal(etagsComparable({ kind: "s3", provider: "aws" }, { kind: "s3", provider: "hetzner" }), true);
  assert.equal(etagsComparable({ provider: "aws" }, { kind: "s3", provider: "r2" }), true);
  assert.equal(etagsComparable({ kind: "s3", provider: "kybl" }, { kind: "s3", provider: "kybl" }), false);
  assert.equal(etagsComparable({ kind: "webdav", provider: "webdav" }, { kind: "s3", provider: "aws" }), false);
  assert.equal(etagsComparable({ kind: "dropbox", provider: "dropbox" }, { kind: "dropbox", provider: "dropbox" }), false);
  assert.equal(etagsComparable(null, { kind: "s3", provider: "aws" }), false);
});

test("different ETags: differ only when comparable", () => {
  const l = [file("a.txt", "abc")];
  const r = [file("a.txt", "rev-xyz".replace("-", ""))];
  assert.equal(compareFolders(l, r, { etags: true }).same, 0);
  assert.equal(compareFolders(l, r, { etags: false }).same, 1);
  assert.equal(compareFolders(l, r).same, 1);
});

test("without ETags, size and time decide", () => {
  const d = compareFolders([file("a", "x", T + 60_000)], [file("a", "y", T)]);
  assert.deepEqual(d.leftNewer.map((e) => e.name), ["a"]);
  assert.equal(compareFolders([file("a", null, T, 10)], [file("a", null, T, 11)]).differ.length, 1);
});

test("multipart ETags are never compared", () => {
  assert.equal(compareFolders([file("a", "abc-2")], [file("a", "def-3")], { etags: true }).same, 1);
});
