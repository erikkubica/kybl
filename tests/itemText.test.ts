// How items are written per kind of connection: clipboard text, Delete wording, Go to folder. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKind, deleteWording, goToText, isAbsolutePath, itemAddress, joinLocal, resolveLocalPath } from "../src/itemText.ts";

test("address kind: S3 buckets, this computer, everything else", () => {
  assert.equal(addressKind({ roots: "buckets", kind: "s3" }), "s3");
  assert.equal(addressKind({ kind: "s3" }), "s3");
  assert.equal(addressKind({}), "s3");
  assert.equal(addressKind({ roots: "drives", localPaths: true, kind: "local" }), "local");
  assert.equal(addressKind({ kind: "local" }), "local");
  assert.equal(addressKind({ roots: "single", kind: "sftp" }), "other");
  assert.equal(addressKind({ roots: "drives", kind: "gdrive" }), "other");
  assert.equal(addressKind({ kind: "dropbox" }), "other");
});

test("clipboard text: s3:// only on S3, full paths on this computer", () => {
  assert.equal(itemAddress("s3", "photos", "2026/a.jpg"), "s3://photos/2026/a.jpg");
  assert.equal(itemAddress("local", "/Users/me", "Desktop/a.txt"), "/Users/me/Desktop/a.txt");
  assert.equal(itemAddress("local", "/", "etc/hosts"), "/etc/hosts");
  assert.equal(itemAddress("local", "C:\\Users\\me", "Desktop/a.txt"), "C:\\Users\\me\\Desktop\\a.txt");
  assert.equal(itemAddress("local", "/Users/me", "Pictures/"), "/Users/me/Pictures");
  assert.equal(itemAddress("other", "", "www/index.html"), "/www/index.html");
  assert.equal(itemAddress("other", "0AbCdriveid", "Reports/q1.pdf", "My Drive"), "My Drive/Reports/q1.pdf");
  assert.equal(joinLocal("/Users/me", ""), "/Users/me");
});

test("delete wording: a trash says so and isn't red", () => {
  const drive = deleteWording({ what: "“a.txt”", count: 1, folders: false, trash: true, local: false });
  assert.equal(drive.title, "Move “a.txt” to the Trash?");
  assert.equal(drive.label, "Move to Trash");
  assert.equal(drive.danger, false);
  assert.match(drive.text, /restore it from the trash of this drive/);
  const pc = deleteWording({ what: "3 items", count: 3, folders: true, trash: true, local: true, windows: true });
  assert.equal(pc.label, "Move to Recycle Bin");
  assert.match(pc.text, /^Folders go with everything inside them\. You can restore them from the Recycle Bin\.$/);
  const sftp = deleteWording({ what: "“a.txt”", count: 1, folders: false, trash: false, local: false });
  assert.equal(sftp.title, "Delete “a.txt”?");
  assert.equal(sftp.danger, true);
  assert.doesNotMatch(sftp.text, /bucket/);
});

test("go to folder: words per kind", () => {
  assert.match(goToText("s3", "photos", "2026/", "photos").hint, /s3:\/\//);
  assert.equal(goToText("s3", "photos", "2026/", "photos").initial, "/2026/");
  const sftp = goToText("other", "", "www/", "web1");
  assert.doesNotMatch(sftp.hint + sftp.placeholder, /s3|bucket/i);
  assert.match(sftp.hint, /web1/);
  const disk = goToText("local", "/Users/me", "Pictures/", "Home");
  assert.equal(disk.initial, "/Users/me/Pictures");
  assert.doesNotMatch(disk.hint + disk.placeholder, /s3|bucket/i);
});

test("an absolute path on this computer lands in the closest root holding it", () => {
  const roots = ["/", "/Users/me", "/Users/me/Documents"];
  assert.deepEqual(resolveLocalPath("/Users/me/Pictures/2026", roots), { root: "/Users/me", prefix: "Pictures/2026" });
  assert.deepEqual(resolveLocalPath("/Users/me/Documents/", roots), { root: "/Users/me/Documents", prefix: "" });
  assert.deepEqual(resolveLocalPath("/etc", roots), { root: "/", prefix: "etc" });
  assert.equal(resolveLocalPath("/opt/x", ["/Users/me"]), null);
  assert.deepEqual(resolveLocalPath("c:\\users\\me\\Desktop", ["C:\\Users\\me"]), { root: "C:\\Users\\me", prefix: "Desktop" });
  assert.ok(isAbsolutePath("/Users"));
  assert.ok(isAbsolutePath("C:\\x"));
  assert.ok(!isAbsolutePath("photos/2026"));
});
