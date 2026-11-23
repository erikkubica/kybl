// Spreadsheet grid shape (src/viewers/gridShape.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnCount, usedExtent } from "../../src/viewers/gridShape.ts";

test("columns count every row, not just the first 2000", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => new Array(i === 4999 ? 12 : 10).fill("x"));
  assert.equal(columnCount(rows), 12);
  assert.equal(columnCount([], ["a", "b", "c"]), 3);
  assert.equal(columnCount([]), 1);
});

test("used extent ignores empty and stub cells past the data", () => {
  const data = [
    [{ t: "s", v: "a" }, { t: "n", v: 1 }],
    undefined,
    [undefined, undefined, { t: "s", v: "c" }, { t: "z" }, { t: "s", v: "" }],
    [{ t: "z" }],
  ];
  assert.deepEqual(usedExtent(data), { r: 2, c: 2 });
  assert.deepEqual(usedExtent([]), { r: -1, c: -1 });
  assert.deepEqual(usedExtent(undefined), { r: -1, c: -1 });
});
