// Menu-bar accelerators handed back as keydowns (src/desktop/menus.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { MENU_ACCELERATORS, menuKeydown } from "../../src/desktop/menus.ts";

test("letters, with and without Shift", () => {
  assert.deepEqual(pick(menuKeydown("duplicate")), { key: "d", code: "KeyD", metaKey: true, shiftKey: false, altKey: false });
  assert.deepEqual(pick(menuKeydown("swap-panes")), { key: "S", code: "KeyS", metaKey: true, shiftKey: true, altKey: false });
  assert.deepEqual(pick(menuKeydown("toggle-sidebar")), { key: "s", code: "KeyS", metaKey: true, shiftKey: false, altKey: true });
});

test("brackets, backslash, period, plus and minus", () => {
  assert.equal(menuKeydown("back")?.code, "BracketLeft");
  assert.equal(menuKeydown("forward")?.key, "]");
  assert.equal(menuKeydown("split-down")?.key, "|");
  assert.equal(menuKeydown("toggle-hidden")?.code, "Period");
  assert.equal(menuKeydown("tiles-bigger")?.code, "Equal");
  assert.equal(menuKeydown("tiles-smaller")?.key, "-");
});

test("every accelerator maps, click-only items don't", () => {
  for (const id of Object.keys(MENU_ACCELERATORS)) assert.ok(menuKeydown(id), id);
  assert.equal(menuKeydown("refresh"), null);
});

function pick(e: KeyboardEventInit | null) {
  assert.ok(e);
  return { key: e.key, code: e.code, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey };
}
