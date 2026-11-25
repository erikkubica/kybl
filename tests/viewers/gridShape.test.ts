// Spreadsheet grid shape (src/viewers/lib/gridShape.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnCount, usedExtent } from "../../src/viewers/lib/gridShape.ts";

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

test("a sheet is cut to the cell cap, not just per axis", async () => {
  const { sheetCut, XLSX_MAX_CELLS, XLSX_MAX_ROWS, XLSX_MAX_COLS } = await import("../../src/viewers/lib/gridShape.ts");
  // small sheets stay whole
  assert.deepEqual(sheetCut({ r: 99, c: 9 }), { r: 99, c: 9 });
  // 150k rows x 60 columns (9M cells): rows cut so rows x cols stays under the cap
  const wide = sheetCut({ r: 149_999, c: 59 });
  assert.equal(wide.c, 59);
  assert.ok((wide.r + 1) * (wide.c + 1) <= XLSX_MAX_CELLS);
  assert.equal(wide.r + 1, Math.floor(XLSX_MAX_CELLS / 60));
  // the worst case: both axes at their caps
  const worst = sheetCut({ r: 1_048_575, c: 16_383 });
  assert.equal(worst.c, XLSX_MAX_COLS - 1);
  assert.ok((worst.r + 1) * (worst.c + 1) <= XLSX_MAX_CELLS);
  // narrow and tall: the row cap still holds
  assert.equal(sheetCut({ r: 500_000, c: 2 }).r, XLSX_MAX_ROWS - 1);
});

test("the cut note names only the axes that were cut", async () => {
  const { cutNote } = await import("../../src/viewers/lib/gridShape.ts");
  assert.equal(cutNote({ rows: 5, cols: 1000 }, null), undefined);
  assert.equal(cutNote({ rows: 5, cols: 1000 }, { rows: 5, cols: 1200 }), `only the first ${(1000).toLocaleString()} of ${(1200).toLocaleString()} columns`);
  assert.equal(cutNote({ rows: 2000, cols: 3 }, { rows: 9000, cols: 3 }), `only the first ${(2000).toLocaleString()} of ${(9000).toLocaleString()} rows`);
  assert.match(cutNote({ rows: 2000, cols: 1000 }, { rows: 9000, cols: 1200 }) ?? "", /rows and .* columns$/);
});
