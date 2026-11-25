// Keys as paths under a local folder, and local names for remote files (src/desktop/lib/paths.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainRelPath, safeName, safeRelPath } from "../../src/desktop/lib/paths.ts";

test("a synced copy's path never climbs out of the synced folder", () => {
  for (const r of ["a.txt", "docs/report.pdf", "..name/x..y", "photo: 1.jpg", ".hidden/.env"]) assert.ok(plainRelPath(r), r);
  for (const r of ["", "docs/../../../../Users/me/.ssh/id_rsa", "..", "./a", "a//b", "a\\..\\b", "C:/x", "a/c:", "x\0y"]) assert.ok(!plainRelPath(r), r);
});

test("downloads clean keys up instead", () => {
  assert.equal(safeRelPath("x/../../.zshrc"), "x/.zshrc");
});

test("a single file's name is one file name, never a path", () => {
  // a backslash in a bucket / FTP / SFTP name must not step into a (maybe linked) local folder
  assert.equal(safeName("Documents\\evil.docx"), "evil.docx");
  assert.equal(safeName("a/b/c.txt"), "c.txt");
  assert.equal(safeName(".."), "");
  assert.equal(safeName("x.exe\\.."), "x.exe");
  assert.equal(safeName("re:port?.pdf"), "re_port_.pdf");
  assert.equal(safeName("plain.txt"), "plain.txt");
  // a folder download keeps the path below the picked folder (checked for links by `base`)
  assert.equal(safeRelPath("sub\\x.txt"), "sub/x.txt");
});
