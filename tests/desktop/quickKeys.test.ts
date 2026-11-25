// Quick Look holds back the list's own keys while it is up (src/desktop/lib/quickKeys.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { listKeyHeldByPreview } from "../../src/desktop/lib/quickKeys.ts";

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });

test("keys that would move or clear the selection under the preview are held", () => {
  for (const key of ["Home", "End", "PageUp", "PageDown", "a", "Z", "3", "."]) assert.equal(listKeyHeldByPreview(k(key)), true, key);
});

test("shortcuts and other keys still reach the app", () => {
  assert.equal(listKeyHeldByPreview(k("a", { metaKey: true })), false);
  assert.equal(listKeyHeldByPreview(k("Backspace", { metaKey: true })), false);
  assert.equal(listKeyHeldByPreview(k("Home", { ctrlKey: true })), false);
  assert.equal(listKeyHeldByPreview(k("Tab")), false);
  assert.equal(listKeyHeldByPreview(k("F2")), false);
  assert.equal(listKeyHeldByPreview(k("å", { altKey: true })), false);
});
