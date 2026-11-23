// Time left in the Activity header (src/format.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEta } from "../../src/format.ts";

test("never 60 seconds in a minute", () => {
  assert.equal(formatEta(59.2), "1m 0s");
  assert.equal(formatEta(119.2), "2m 0s");
  assert.equal(formatEta(3599.5), "1h 0m");
});

test("plain values", () => {
  assert.equal(formatEta(0.3), "1s");
  assert.equal(formatEta(42), "42s");
  assert.equal(formatEta(61), "1m 1s");
  assert.equal(formatEta(3725), "1h 2m");
});

test("nothing to say", () => {
  assert.equal(formatEta(0), "");
  assert.equal(formatEta(-5), "");
  assert.equal(formatEta(Infinity), "");
  assert.equal(formatEta(NaN), "");
});
