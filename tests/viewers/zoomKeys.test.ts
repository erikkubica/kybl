// Image viewer zoom keys (src/viewers/zoomKeys.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { zoomKey } from "../../src/viewers/zoomKeys.ts";

const k = (key: string, code: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = { metaKey: true }) =>
  zoomKey({ key, code, metaKey: false, ctrlKey: false, altKey: false, ...mods });

test("⌘ or Ctrl with + / = / − / 0", () => {
  assert.equal(k("=", "Equal"), "in");
  assert.equal(k("+", "Equal", { ctrlKey: true }), "in");
  assert.equal(k("-", "Minus"), "out");
  assert.equal(k("0", "Digit0", { ctrlKey: true }), "fit");
});

test("no modifier, Option, or other keys do nothing", () => {
  assert.equal(k("=", "Equal", {}), null);
  assert.equal(k("=", "Equal", { metaKey: true, altKey: true }), null);
  assert.equal(k("s", "KeyS"), null);
});
