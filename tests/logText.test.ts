// The Activity log's words and what it keeps out (src/logText.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchDetail,
  batchEndLine,
  batchStartLine,
  batchSubject,
  classifyError,
  errorDetail,
  errorSentence,
  formatDuration,
  lastSegment,
  logAsText,
  redact,
  type BatchEnd,
} from "../src/logText.ts";
import { setByteUnits } from "../src/format.ts";

test("secrets never reach the log", () => {
  assert.equal(redact("ftp://erik:hunter2@ftp.example.sk/www"), "ftp://•••@ftp.example.sk/www");
  assert.equal(redact("https://token123@api.example.com/x"), "https://•••@api.example.com/x");
  const signed = redact("GET https://b.s3.amazonaws.com/k?X-Amz-Credential=AKIA%2F1&X-Amz-Signature=abcdef0123&x-id=GetObject");
  assert.ok(!signed.includes("abcdef0123") && !signed.includes("AKIA"), signed);
  assert.ok(signed.includes("x-id=GetObject"), signed);
  assert.ok(!redact("https://x.blob.core.windows.net/c?sv=2022&sig=Zm9vYmFy%3D").includes("Zm9vYmFy"));
  assert.equal(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.sig"), "Authorization: Bearer •••");
  assert.equal(redact("password=hunter2 user=erik"), "password=••• user=erik");
  assert.equal(redact('{"client_secret":"s3cr3t"}'), '{"client_secret":"•••"}');
  assert.equal(redact("refresh_token: 1//0gAbc"), "refresh_token: •••");
  assert.equal(redact("key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----\nok"), "key:\n[private key removed]\nok");
  // plain sentences stay as they are
  for (const s of ["Wrong user name or password.", "ftp.example.sk didn't answer in time.", "Downloaded “a.txt” from X to Downloads"]) assert.equal(redact(s), s);
});

test("errors are sorted into what the user can do about them", () => {
  const t = classifyError("ftp.example.sk didn't answer in time. Check the address and your internet connection.\n\nTimed out: no reply from ftp.example.sk within 20 s.");
  assert.equal(t.kind, "timeout");
  assert.equal(t.network, true);
  assert.equal(t.hint, "The server didn't answer. Check your network or VPN, then try again.");
  assert.equal(classifyError("operation timed out").kind, "timeout");
  assert.equal(classifyError("x refused the connection. Check the port.").kind, "refused");
  assert.equal(classifyError("Couldn't find ftp.nope.sk. Check the address.").kind, "dns");
  assert.equal(classifyError("Couldn't reach x. Check the address and your internet connection.").kind, "offline");
  assert.equal(classifyError("The connection to the server dropped. Try again.").kind, "offline");
  assert.equal(classifyError("Wrong user name or password.").kind, "auth");
  assert.equal(classifyError("The server's security certificate isn't trusted.").kind, "cert");
  assert.equal(classifyError("Access denied").kind, "denied");
  assert.equal(classifyError("Access denied").network, false);
  assert.equal(classifyError("Cancelled").kind, "cancelled");
  assert.equal(classifyError("Something odd").hint, null);
  assert.equal(classifyError(null).kind, "other");
});

test("an error splits into its sentence and its technical side", () => {
  assert.equal(errorSentence("Sentence.\n\nraw io error"), "Sentence.");
  assert.equal(errorDetail("Sentence.\n\nraw io error"), "raw io error");
  assert.equal(errorDetail(`Not trusted.\n\nkybl:${"a".repeat(32)} fp=AB:CD`), "fp=AB:CD");
  assert.equal(errorDetail("Only a sentence."), null);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(40), "0.1 s");
  assert.equal(formatDuration(1430), "1.4 s");
  assert.equal(formatDuration(12_400), "12 s");
  assert.equal(formatDuration(72_000), "1 min 12 s");
  assert.equal(formatDuration(120_000), "2 min");
  assert.equal(formatDuration(3_780_000), "1 h 3 min");
  assert.equal(formatDuration(-1), "");
});

test("a batch is named by what lands at the top", () => {
  assert.equal(batchSubject(["regina-lite/a.txt", "regina-lite/b/c.txt"]), "“regina-lite” (folder)");
  assert.equal(batchSubject(["photo.jpg"]), "“photo.jpg”");
  assert.equal(batchSubject(["a.txt", "b/c.txt", "d.txt"]), "“a.txt” and 2 more");
  assert.equal(lastSegment("/Users/me/Downloads"), "Downloads");
  assert.equal(lastSegment("photos/2024/"), "2024");
  assert.equal(lastSegment("C:\\Users\\me\\Downloads"), "Downloads");
});

test("one line when a batch starts, one when it ends", () => {
  setByteUnits(false);
  const info = { kind: "download" as const, subject: "“regina-lite” (folder)", conn: "psychozdravie.sk", place: "Downloads" };
  assert.equal(batchStartLine(info), "Started downloading “regina-lite” (folder) from psychozdravie.sk to Downloads");
  assert.equal(batchStartLine({ ...info, retry: true }), "Trying again: downloading “regina-lite” (folder) from psychozdravie.sk to Downloads");
  assert.equal(batchStartLine({ ...info, temp: true, subject: "“a.pdf”" }), "Started downloading “a.pdf” from psychozdravie.sk to open it");
  assert.equal(batchStartLine({ kind: "upload", subject: "“a.txt”", conn: "S3 (media)", place: "" }), "Started uploading “a.txt” to S3 (media)");
  assert.equal(batchStartLine({ kind: "upload", subject: "“a.txt”", conn: "X", place: "www" }), "Started uploading “a.txt” to “www” on X");
  assert.equal(batchStartLine({ kind: "compress", subject: "“Archive.zip”", conn: "X", place: "" }), "Started compressing into “Archive.zip” on X");

  const end: BatchEnd = { ...info, count: 12, done: 12, failed: 0, cancelled: 0, bytes: 3_400_000, ms: 72_000, errors: [] };
  assert.deepEqual(batchEndLine(end), { kind: "success", text: "Downloaded “regina-lite” (folder) from psychozdravie.sk to Downloads (12 files, 3.4 MB) in 1 min 12 s" });
  const some = batchEndLine({ ...end, done: 10, failed: 2, errors: ["a.txt: x didn't answer in time.\n\nTimed out"] });
  assert.equal(some.kind, "error");
  assert.equal(some.text, "Downloading “regina-lite” (folder) from psychozdravie.sk to Downloads finished with problems: 2 of 12 files failed (x didn't answer in time.)");
  const all = batchEndLine({ ...end, done: 0, failed: 12, errors: ["a.txt: Wrong user name or password."] });
  assert.equal(all.text, "Couldn't download “regina-lite” (folder) from psychozdravie.sk to Downloads: Wrong user name or password.");
  assert.deepEqual(batchEndLine({ ...end, done: 0, cancelled: 12 }), { kind: "info", text: "Stopped downloading “regina-lite” (folder) from psychozdravie.sk to Downloads" });
  assert.equal(
    batchEndLine({ kind: "compress", subject: "“Archive.zip”", conn: "X", place: "", count: 1, done: 1, failed: 0, cancelled: 0, bytes: 0, ms: 1430, errors: [] }).text,
    "Compressed into “Archive.zip” on X in 1.4 s",
  );

  const detail = batchDetail({ ...end, done: 10, failed: 2, errors: ["a.txt: Timed out\n\nraw"] }, [
    ["Connection", "psychozdravie.sk"],
    ["From", "/www/regina-lite"],
    ["To", null],
  ]);
  assert.equal(detail, "Connection: psychozdravie.sk\nFrom: /www/regina-lite\nFiles: 12 (10 done, 2 failed)\nSize: 3.4 MB\nTook: 1 min 12 s\n\nErrors (the first 1 of 2):\n• a.txt: Timed out — raw");
});

test("the copied log keeps details, indented", () => {
  const at = new Date(2026, 0, 2, 9, 5, 7).getTime();
  assert.equal(
    logAsText([
      { at, kind: "info", text: "Connecting to X…" },
      { at, kind: "error", text: "Couldn't connect to X: timed out", detail: "Connection: X\nError: timed out" },
    ]),
    "09:05:07        Connecting to X…\n09:05:07  ERROR Couldn't connect to X: timed out\n        Connection: X\n        Error: timed out",
  );
});
