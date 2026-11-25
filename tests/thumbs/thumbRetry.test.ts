// Which failed thumbnails are asked for again (src/thumbs/thumbRetry.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryFailure } from "../../src/thumbs/thumbRetry.ts";

const MIN = 60_000;

test("the network coming back retries every failure", () => {
  assert.equal(retryFailure("online", 1000, false, 2000, MIN), true);
});

test("resuming retries offline failures and old ones, not one that just failed online", () => {
  assert.equal(retryFailure("resumed", 1000, true, 2000, MIN), true);
  assert.equal(retryFailure("resumed", 1000, false, 1000 + MIN, MIN), true);
  assert.equal(retryFailure("resumed", 1000, false, 2000, MIN), false);
});
