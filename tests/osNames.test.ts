// What each system calls its computer, file manager and trash (src/osNames.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteLabel, osNames, osOf, terminalsWhere, trashName } from "../src/osNames.ts";

test("osOf: the system a user agent names", () => {
  assert.equal(osOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"), "mac");
  assert.equal(osOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"), "win");
  assert.equal(osOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"), "linux");
  // navigator.platform values too
  assert.equal(osOf("MacIntel"), "mac");
  assert.equal(osOf("Win32"), "win");
  assert.equal(osOf("Linux x86_64"), "linux");
});

test("osNames: no Mac words off the Mac", () => {
  assert.deepEqual(osNames("mac"), { device: "This Mac", here: "this Mac", fileManager: "Finder", showInFiles: "Show in Finder", keychain: "the Keychain", trash: "Trash" });
  for (const os of ["win", "linux"] as const) {
    const n = osNames(os);
    assert.ok(!Object.values(n).some((v) => /Mac|Finder|Keychain/.test(v)), os);
    assert.equal(n.here, n.device[0].toLowerCase() + n.device.slice(1));
  }
  assert.equal(osNames("win").device, "This PC");
  assert.equal(osNames("win").trash, "Recycle Bin");
  assert.equal(osNames("win").showInFiles, "Show in Explorer");
  assert.equal(osNames("linux").device, "This computer");
  assert.equal(osNames("linux").showInFiles, "Show in Files");
});

test("trash and delete labels: the system's bin only for files on its disk", () => {
  assert.equal(trashName(true, "win"), "Recycle Bin");
  assert.equal(trashName(false, "win"), "Trash");
  assert.equal(trashName(true, "mac"), "Trash");
  assert.equal(deleteLabel(true, true, "win"), "Move to Recycle Bin");
  assert.equal(deleteLabel(true, false, "win"), "Move to Trash");
  assert.equal(deleteLabel(false, true, "win"), "Delete");
});

test("terminal refusal: never names the computer where terminals can't open", () => {
  assert.equal(terminalsWhere("win"), "Terminals open on SSH and SFTP connections");
  assert.equal(terminalsWhere("mac"), "Terminals open on This Mac and on SSH and SFTP connections");
  assert.equal(terminalsWhere("linux"), "Terminals open on This computer and on SSH and SFTP connections");
});
