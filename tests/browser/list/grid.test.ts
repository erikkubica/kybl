// Grid view maths (src/browser/components/list/gridHit.ts): rubber-band hits and arrow steps. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridHits, rowStepBlocked, trackWidth } from "../../../src/browser/components/list/gridHit.ts";

// 5 columns of 146px with 10px gaps (a pane ~800px wide at tile size 160), rows of 200px
const g = { cols: 5, colW: 146, colGap: 10, rowH: 200, cardH: 190, top: 12, left: 12 };

test("a rectangle over columns 2 and 3 selects exactly those", () => {
  // column c spans 12 + c*156 .. +146: column 1 is 168..314, column 2 is 324..470
  assert.deepEqual(gridHits({ x0: 320, y0: 20, x1: 340, y1: 30 }, g, 20), [2]);
  assert.deepEqual(gridHits({ x0: 200, y0: 20, x1: 400, y1: 30 }, g, 20), [1, 2]);
});

test("the last column is reachable", () => {
  // column 4 starts at 12 + 4*156 = 636 (a fixed pitch of tile+gap put it at 692)
  assert.deepEqual(gridHits({ x0: 640, y0: 20, x1: 660, y1: 230 }, g, 20), [4, 9]);
});

test("gaps and missing items select nothing", () => {
  assert.deepEqual(gridHits({ x0: 159, y0: 20, x1: 166, y1: 30 }, g, 20), []);
  assert.deepEqual(gridHits({ x0: 12, y0: 205, x1: 600, y1: 210 }, g, 20), []);
  assert.deepEqual(gridHits({ x0: 12, y0: 420, x1: 800, y1: 430 }, g, 12), [10, 11]);
});

test("track width comes from the resolved template", () => {
  assert.equal(trackWidth("146.4px 146.4px 146.4px", 160), 146.4);
  assert.equal(trackWidth("none", 160), 160);
});

test("arrow up on the first row and down on the last stay put", () => {
  // 10 items, 5 columns: rows 0-4 and 5-9
  assert.equal(rowStepBlocked(3, -5, 5, 10), true);
  assert.equal(rowStepBlocked(5, 5, 5, 10), true);
  assert.equal(rowStepBlocked(8, -5, 5, 10), false);
  assert.equal(rowStepBlocked(2, 5, 5, 10), false);
});

test("down into a shorter last row still moves, and lists and page keys are untouched", () => {
  // 7 items: the last row holds 5 and 6; from 3 the step lands on the last item
  assert.equal(rowStepBlocked(3, 5, 5, 7), false);
  assert.equal(rowStepBlocked(5, 5, 5, 7), true);
  assert.equal(rowStepBlocked(0, -1, 1, 10), false);
  assert.equal(rowStepBlocked(0, -20, 5, 10), false);
});
