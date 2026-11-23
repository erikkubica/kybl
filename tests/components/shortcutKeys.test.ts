// Settings › Keyboard shortcuts: Mac glyphs spelled for Windows and Linux. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyLabel, spellKeys } from "../../src/components/shortcutKeys.ts";

test("a Mac keeps its glyphs", () => {
  assert.deepEqual(spellKeys(["⇧", "⌘", "N"], true), ["⇧", "⌘", "N"]);
  assert.equal(keyLabel("⌥⇧⌘[", true), "⌥⇧⌘[");
});

test("elsewhere: Ctrl, Alt, Shift in the usual order, joined to the key", () => {
  assert.deepEqual(spellKeys(["⇧", "⌘", "N"], false), ["Ctrl+Shift+N"]);
  assert.deepEqual(spellKeys(["⌘C", "⌘X", "⌘V"], false), ["Ctrl+C", "Ctrl+X", "Ctrl+V"]);
  assert.deepEqual(spellKeys(["⌘↵", "Tab"], false), ["Ctrl+Enter", "Tab"]);
  assert.deepEqual(spellKeys(["⌘⌫", "⌦"], false), ["Ctrl+Backspace", "Delete"]);
  assert.equal(keyLabel("⌥⇧⌘[", false), "Ctrl+Alt+Shift+[");
  assert.equal(keyLabel("⌃⇧Tab", false), "Ctrl+Shift+Tab");
  assert.equal(keyLabel("⌥⌘1…8", false), "Ctrl+Alt+1…8");
});

test("lone modifiers and words", () => {
  assert.deepEqual(spellKeys(["⌥"], false), ["Alt"]);
  assert.deepEqual(spellKeys(["⇧", "click"], false), ["Shift+click"]);
  assert.deepEqual(spellKeys(["drop copies, ⌘ moves"], false), ["drop copies, Ctrl moves"]);
  assert.deepEqual(spellKeys(["F5", "F6"], false), ["F5", "F6"]);
});
