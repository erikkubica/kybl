// Local names for remote files (src/desktop/paths.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeName, safeRelPath } from "../../src/desktop/paths.ts";

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
