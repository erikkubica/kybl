// Sizes, times and kinds (src/format.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatEta, kindLabel, setByteUnits } from "../src/format.ts";

test("sizes pick their unit after rounding", () => {
  setByteUnits(false);
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1500), "1.5 KB");
  assert.equal(formatBytes(99_950), "100 KB");
  assert.equal(formatBytes(999_950), "1.0 MB");
  assert.equal(formatBytes(999_499), "999 KB");
  assert.equal(formatBytes(2_500_000_000), "2.5 GB");
  setByteUnits(true);
  assert.equal(formatBytes(1024 * 1024 - 10), "1.0 MiB");
  setByteUnits(false);
});

test("times never show 60 seconds", () => {
  assert.equal(formatEta(119.2), "2m 0s");
  assert.equal(formatEta(59.5), "1m 0s");
  assert.equal(formatEta(75), "1m 15s");
  assert.equal(formatEta(12.1), "13s");
  assert.equal(formatEta(3725), "1h 2m");
  assert.equal(formatEta(0), "");
});

test("names without an extension and dotfiles are plain files", () => {
  assert.equal(kindLabel("README", false), "File");
  assert.equal(kindLabel(".env", false), "File");
  assert.equal(kindLabel("photos", true), "Folder");
});
