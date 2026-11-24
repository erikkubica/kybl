// Root ids shown as names (src/connections/fixedRoots.ts, used by roots.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedRootName, rootIdLeaf } from "../../src/connections/fixedRoots.ts";

test("Drive and OneDrive roots have names before their roots are listed", () => {
  assert.equal(fixedRootName("gdrive", "root"), "My Drive");
  assert.equal(fixedRootName("gdrive", "shared-with-me"), "Shared with me");
  assert.equal(fixedRootName("onedrive", "me"), "OneDrive");
  // an S3 bucket called "root" is a bucket name; a shared drive needs listing
  assert.equal(fixedRootName("s3", "root"), undefined);
  assert.equal(fixedRootName(undefined, "root"), undefined);
  assert.equal(fixedRootName("gdrive", "0ABcd"), undefined);
});

test("a path id shows its last part", () => {
  assert.equal(rootIdLeaf("/Users/me/Documents"), "Documents");
  assert.equal(rootIdLeaf("C:\\Users\\me\\"), "me");
  assert.equal(rootIdLeaf("media-prod"), "media-prod");
  assert.equal(rootIdLeaf("/"), "/");
});
