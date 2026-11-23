// Settings › Keyboard shortcuts: Mac glyphs spelled for Windows and Linux. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { ariaKeys, keyLabel, keysIn, spellKeys } from "../../src/components/shortcutKeys.ts";

test("shortcuts inside sentences: tooltips, toasts, menu hints", () => {
  assert.equal(keysIn("Upload or create (⌘U, ⇧⌘N)", true), "Upload or create (⌘U, ⇧⌘N)");
  assert.equal(keysIn("Upload or create (⌘U, ⇧⌘N)", false), "Upload or create (Ctrl+U, Ctrl+Shift+N)");
  assert.equal(keysIn("Copied “a”. Paste with ⌘V in another folder.", false), "Copied “a”. Paste with Ctrl+V in another folder.");
  assert.equal(keysIn("right-click or ⌘-click for the enclosing folders", false), "right-click or Ctrl-click for the enclosing folders");
  assert.equal(keysIn("Move to photos · ⌥ to copy", false), "Move to photos · Alt to copy");
  assert.equal(keysIn("Settings (⌘,)", false), "Settings (Ctrl+,)");
  assert.equal(keysIn("Enclosing folder (⌘↑)", false), "Enclosing folder (Ctrl+↑)");
  assert.equal(keysIn("⌘⌫", false), "Ctrl+Backspace");
  assert.equal(keysIn("Zoom out (⌘−)", false), "Zoom out (Ctrl+−)");
  assert.equal(keysIn("⌃`", false), "Ctrl+`");
  assert.equal(keysIn("Previous change (⇧F7 or p)", false), "Previous change (Shift+F7 or p)");
  assert.equal(keysIn("F2", false), "F2");
});

test("aria-keyshortcuts", () => {
  assert.equal(ariaKeys("⇧⌘N", true), "Shift+Meta+N");
  assert.equal(ariaKeys("⇧⌘N", false), "Shift+Control+N");
  assert.equal(ariaKeys("⌘⌫", false), "Control+Backspace");
  assert.equal(ariaKeys("F2", false), "F2");
  assert.equal(ariaKeys(undefined, false), undefined);
  assert.equal(ariaKeys("3 items", false), undefined);
});

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
