// When a video that fails to play is offered Try again or another app (src/mobile/lib/viewerRetry.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { videoErrorStep } from "../../src/mobile/lib/viewerRetry.ts";

test("a first failure (network, expired link) offers Try again, not another app", () => {
  assert.equal(videoErrorStep(1), "retry");
});

test("failing again after Try again falls back to another app", () => {
  assert.equal(videoErrorStep(2), "fallback");
  assert.equal(videoErrorStep(3), "fallback");
});
