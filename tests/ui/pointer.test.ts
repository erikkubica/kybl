// Pointer facts for the lists and the grid (src/ui/lib/pointer.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isContextPress, onScrollbar } from "../../src/ui/lib/pointer.ts";

test("Ctrl+click is a right-click on a Mac only", () => {
  const press = (button: number, ctrlKey = false, metaKey = false) => ({ button, ctrlKey, metaKey });
  assert.equal(isContextPress(press(2), false), true);
  assert.equal(isContextPress(press(2), true), true);
  assert.equal(isContextPress(press(0, true), true), true);
  // elsewhere Ctrl+click toggles, as ⌘ does on a Mac
  assert.equal(isContextPress(press(0, true), false), false);
  // ⌘ with Ctrl on a Mac stays a toggle; a plain click is a click
  assert.equal(isContextPress(press(0, true, true), true), false);
  assert.equal(isContextPress(press(0), true), false);
});

test("a press on the scrollbar or its gutter is told apart from the content", () => {
  // 400×300 box at (100, 50), a 10px vertical scrollbar: content 390 wide
  const rect = { left: 100, top: 50 };
  const el = { clientLeft: 0, clientTop: 0, clientWidth: 390, clientHeight: 300 };
  assert.equal(onScrollbar(300, 100, rect, el), false);
  assert.equal(onScrollbar(489, 100, rect, el), false);
  assert.equal(onScrollbar(490, 100, rect, el), true);
  assert.equal(onScrollbar(499, 349, rect, el), true);
  // a horizontal scrollbar along the bottom
  assert.equal(onScrollbar(300, 345, rect, { ...el, clientHeight: 290 }), true);
  // a border is not content either side
  assert.equal(onScrollbar(101, 100, rect, { ...el, clientLeft: 1, clientWidth: 388 }), false);
});
