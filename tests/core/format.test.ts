// Sizes, times and kinds (src/core/format.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { customLimitProblem, formatBytes, formatEta, kindLabel, mbpsInput, mbpsToKbps, parseMbps, plural, setByteUnits } from "../../src/core/format.ts";

test("a tiny speed limit stays a limit", () => {
  assert.equal(mbpsToKbps(0), 0);
  assert.equal(mbpsToKbps(0.0004), 1);
  assert.equal(mbpsToKbps(1), Math.round(1_000_000 / 1024));
});

test("sizes pick their unit after rounding", () => {
  setByteUnits(false);
  assert.equal(formatBytes(999), "999 B");
  // a speed is a fraction of bytes per second
  assert.equal(formatBytes(555.7011059505487), "556 B");
  assert.equal(formatBytes(999.7), "1.0 KB");
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

test("counts take the right number", () => {
  assert.equal(plural(1, "folder"), "1 folder");
  assert.equal(plural(0, "item"), "0 items");
  assert.equal(plural(1204, "file"), `${(1204).toLocaleString()} files`);
  assert.equal(plural(2, "copy", "copies"), "2 copies");
});

test("the custom limit field takes 0.001 to 10,000 MB/s and keeps 0.75 as typed", () => {
  assert.equal(customLimitProblem(""), null);
  assert.equal(customLimitProblem("0.75"), null);
  assert.equal(customLimitProblem("0,01"), null);
  assert.equal(customLimitProblem("10000"), null);
  assert.equal(customLimitProblem("0"), "Enter a number from 0.001 to 10,000.");
  assert.equal(customLimitProblem("20000"), "Enter a number from 0.001 to 10,000.");
  assert.equal(customLimitProblem("abc"), "Enter a number from 0.001 to 10,000.");
  // what Settings shows for 0.75 MB/s maps back to the same limit (no silent 0.7)
  const MBPS = 1_000_000 / 1024;
  assert.equal(mbpsInput(mbpsToKbps(0.75) / MBPS), "0.75");
  assert.equal(mbpsInput(mbpsToKbps(0.01) / MBPS), "0.01");
});

test("a custom speed limit survives being shown and saved again", () => {
  const MBPS = 1_000_000 / 1024;
  for (const mb of [0.04, 0.25, 2.5, 0.001, 12]) {
    const kib = Math.round(mb * MBPS);
    const again = parseMbps(mbpsInput(kib / MBPS));
    assert.equal(typeof again, "number");
    assert.equal(Math.round((again as number) * MBPS), kib);
  }
});
