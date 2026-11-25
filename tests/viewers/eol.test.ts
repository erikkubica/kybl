// Compare's "no differences" note (src/viewers/lib/eol.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { eolDifference, noDifferenceNote } from "../../src/viewers/lib/eol.ts";

test("with whitespace ignored, line endings are still named when they are the reason", () => {
  assert.equal(noDifferenceNote("a\r\nb\r\n", "a\nb\n", ["a", "b"], ["a", "b"]), "They differ only in line endings (CRLF and LF).");
  assert.equal(noDifferenceNote("a\n", "a", ["a"], ["a"]), "One ends with a line break and the other doesn't.");
  assert.equal(noDifferenceNote("a  b\n", "a b\n", ["a  b"], ["a b"]), "They differ only in spaces and tabs.");
  assert.equal(noDifferenceNote("a  b\r\n", "a b\n", ["a  b"], ["a b"]), "They differ only in spaces, tabs and line endings.");
});

test("line ending kinds", () => {
  assert.equal(eolDifference("a\r\nb\r\n", "a\nb\n"), "They differ only in line endings (CRLF and LF).");
});

test("one side without a final line break never says null", () => {
  assert.equal(eolDifference("a\n", "a"), "One ends with a line break and the other doesn't.");
  assert.equal(eolDifference("a\nb", "a\nb\n"), "One ends with a line break and the other doesn't.");
});

test("anything else", () => {
  assert.equal(eolDifference("a\r\nb\n", "a\nb\r\n"), "They differ only in how lines end.");
});
