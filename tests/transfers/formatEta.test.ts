// Time left in the Activity header (src/core/format.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEta, parseMbps } from "../../src/core/format.ts";

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

test("custom speed limit: numbers, 0 for none, problems for the rest", () => {
  assert.equal(parseMbps("5"), 5);
  assert.equal(parseMbps("2,5"), 2.5);
  assert.equal(parseMbps(" 10 MB/s "), 10);
  assert.equal(parseMbps("0"), 0);
  assert.equal(typeof parseMbps("-3"), "string");
  assert.equal(typeof parseMbps("abc"), "string");
  assert.equal(typeof parseMbps("20000"), "string");
});
