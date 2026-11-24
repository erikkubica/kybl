// Keys as paths under a local folder (src/desktop/paths.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainRelPath, safeRelPath } from "../../src/desktop/paths.ts";

test("a synced copy's path never climbs out of the synced folder", () => {
  for (const r of ["a.txt", "docs/report.pdf", "..name/x..y", "photo: 1.jpg", ".hidden/.env"]) assert.ok(plainRelPath(r), r);
  for (const r of ["", "docs/../../../../Users/me/.ssh/id_rsa", "..", "./a", "a//b", "a\\..\\b", "C:/x", "a/c:", "x\0y"]) assert.ok(!plainRelPath(r), r);
});

test("downloads clean keys up instead", () => {
  assert.equal(safeRelPath("x/../../.zshrc"), "x/.zshrc");
});
