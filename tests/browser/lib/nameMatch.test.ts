import { test } from "node:test";
import assert from "node:assert/strict";
import { nameMatcher, regexProblem } from "../../../src/browser/lib/nameMatch.ts";

test("text ignores case unless asked", () => {
  assert.equal(nameMatcher("REPORT", false, false)("q1-report.pdf"), true);
  assert.equal(nameMatcher("REPORT", true, false)("q1-report.pdf"), false);
});

test("regex, with or without case", () => {
  assert.equal(nameMatcher("^img_\\d+\\.jpe?g$", false, true)("IMG_0042.JPG"), true);
  assert.equal(nameMatcher("^img", true, true)("IMG_1.jpg"), false);
  assert.equal(nameMatcher("(unclosed", false, true)("anything"), false);
  assert.ok(regexProblem("(unclosed", true));
  assert.equal(regexProblem("(unclosed", false), null);
});
