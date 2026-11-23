// Compare's "no differences" note (src/viewers/eol.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { eolDifference } from "../../src/viewers/eol.ts";

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
