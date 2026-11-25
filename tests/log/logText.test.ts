// The Activity log's words and what it keeps out (src/log/logText.ts). Run: pnpm test
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
} from "../../src/log/logText.ts";
import { setByteUnits } from "../../src/core/format.ts";

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
  // round 6 (S-5): upload sessions, Google and Azure signatures, AWS header signatures, cookies, JSON tokens, env names, trust tags
  const gone = (text: string, secret: string) => assert.ok(!redact(text).includes(secret), `${text} -> ${redact(text)}`);
  gone("PUT https://x.sharepoint.com/up?tempauth=eyJSECRET1&x=1", "SECRET1");
  gone("https://u.googleapis.com/upload?upload_id=SECRET2&n=1", "SECRET2");
  gone("https://s.storage.googleapis.com/o?X-Goog-Signature=SECRET3&X-Goog-Credential=SECRET4", "SECRET3");
  gone("https://s.storage.googleapis.com/o?X-Goog-Signature=SECRET3&X-Goog-Credential=SECRET4", "SECRET4");
  gone("Authorization: AWS4-HMAC-SHA256 Credential=AKIA/x, SignedHeaders=host, Signature=SECRET5", "SECRET5");
  gone("Cookie: sid=SECRET6; theme=dark", "SECRET6");
  gone('{"token":"SECRET7","ok":true}', "SECRET7");
  gone('{"SessionToken": "SECRET8"}', "SECRET8");
  gone("AWS_SECRET_ACCESS_KEY=SECRET9 AWS_REGION=eu", "SECRET9");
  assert.equal(redact("kybl:0123456789abcdef0123456789abcdef host-key-unknown"), "host-key-unknown");
  // round 7 (S-6): credential names by their shape, not a list
  gone("secret_key=SECRETA secretKey=SECRETB secret-key: SECRETC account_key=SECRETD", "SECRET");
  gone("DefaultEndpointsProtocol=https;AccountName=x;AccountKey=SECRETE==;EndpointSuffix=core.windows.net", "SECRETE");
  gone("aws_secret_access_key = SECRETF", "SECRETF");
  gone("X-Amz-Security-Token: SECRETG", "SECRETG");
  gone("x-amz-security-token: SECRETH", "SECRETH");
  for (const q of ["auth_token", "session_token", "oauth_token", "private_token", "secret_key"]) gone(`https://h/p?${q}=SECRETI&a=1`, "SECRETI");
  gone("Authorization: SharedKey acct:SECRETJ", "SECRETJ");
  gone("Authorization: Token SECRETK more", "SECRETK");
  assert.equal(redact("Authorization: Bearer eyJ.abc.def\nnext line"), "Authorization: Bearer •••\nnext line");
  assert.equal(redact("design=fine signal=ok max=5"), "design=fine signal=ok max=5");
  // a long run of letters stays cheap too
  const t1 = Date.now();
  redact("a".repeat(200_000) + "=1");
  redact("token".repeat(40_000));
  assert.ok(Date.now() - t1 < 500, "redact stays linear on one long word");
  // a long run of dots and letters is cheap to scan (S-6)
  const t0 = Date.now();
  redact("a.".repeat(60_000));
  assert.ok(Date.now() - t0 < 500, "redact stays linear");
  // plain sentences stay as they are
  for (const s of ["Wrong user name or password.", "ftp.example.sk didn't answer in time.", "Downloaded “a.txt” from X to Downloads"]) assert.equal(redact(s), s);
});

test("a credential is hidden whole: quoted values with spaces, escaped JSON, long and short names (R8 S-4)", () => {
  const gone = (text: string, ...secrets: string[]) => {
    const out = redact(text);
    for (const s of secrets) assert.ok(!out.includes(s), `${text} -> ${out}`);
  };
  gone('passphrase: "correct horse battery staple"', "correct", "horse", "battery", "staple");
  gone('{"password":"a b c d"}', "b c d", "a b");
  gone("password=ab,cd password2=x;y token=a&b=c", "cd", "y", "b=c");
  gone("password='it is a secret' next", "it is", "secret'");
  gone('PASSWORD=\\"abc123\\" rest', "abc123");
  gone('{\\"password\\":\\"abc123\\"}', "abc123");
  gone('{"password":"he said \\"hi\\" ok","user":"erik"}', "said", "hi", "ok");
  gone('password="never closed and runs on', "never", "runs");
  gone(`GOOGLE_APPLICATION_CREDENTIALS_SERVICE_ACCOUNT_PRIVATE_KEY=hunter2zz`, "hunter2zz");
  gone(`${"a".repeat(60)}_password=hunter2zz`, "hunter2zz");
  for (const t of ["pass=H1", "pw=H1", "pswd: H1", "PASS H1", "--password H1", "-p H1".replace("-p", "-pass"), "key=H1", '"key":"H1"', "authKey=H1", "sessionKey: H1", "session=H1", "sid=H1", "jwt=H1", "otp=H1", "credential=H1", "credentials=H1", "?sessionid=H1", "SESSION_ID=H1"]) gone(t, "H1");
  gone("-----begin private key-----\nBODY1\n-----end private key-----", "BODY1");
  // the credential is the only thing that goes
  assert.equal(redact('{"password":"a b","user":"erik"}'), '{"password":"•••","user":"erik"}');
  assert.equal(redact("password=hunter2 user=erik"), "password=••• user=erik");
  // names that only contain a short word are left alone
  for (const s of ["monkey=1 hotplug=on passport=ok keyboard=us", "id=1 pass-through=yes"]) assert.equal(redact(s), s);
  // and it stays linear on adversarial runs
  const t = Date.now();
  for (const s of ["password".repeat(30_000), `password${" ".repeat(200_000)}`, `password="${"\\".repeat(100_000)}`, `password=\\"${"a".repeat(200_000)}`, `${"secret_".repeat(30_000)}=x`, "key=".repeat(50_000), `"${"a ".repeat(100_000)}`]) redact(s);
  assert.ok(Date.now() - t < 2000, "redact stays linear");
});

test("a line of blanks without a line break is cleaned in linear time (R8 S-5)", async () => {
  const { logMessage, currentLog, clearLog } = await import("../../src/log/activityLog.ts");
  clearLog();
  const t = Date.now();
  logMessage("info", " ".repeat(200_000));
  logMessage("info", `a${" ".repeat(200_000)}b`);
  assert.ok(Date.now() - t < 1000, "no quadratic scan");
  logMessage("info", "one \n \n  two\r\n three  ");
  assert.equal(currentLog().at(-1)?.text, "one two three");
  clearLog();
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

test("the SECRET pattern is linear: a long run of SECRET words is redacted fast (R9 S-9)", () => {
  const t0 = Date.now();
  redact("SECRET".repeat(33333));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  // the pattern still hides an ordinary name and a long one
  assert.equal(redact("AWS_SECRET_ACCESS_KEY=abc123"), "AWS_SECRET_ACCESS_KEY=•••");
  assert.equal(redact("MY_APP_SECRET=abc123 other=1"), "MY_APP_SECRET=••• other=1");
});

test("the log redacts before it cuts, and a huge detail is capped before redaction (R9 S-9)", async () => {
  const { logMessage, currentLog, clearLog } = await import("../../src/log/activityLog.ts");
  clearLog();
  // a credential that straddles the 4000-character cut of the line is hidden whole
  logMessage("info", `${"a".repeat(3990)} https://alice:hunter2secret@host/x`);
  assert.ok(!currentLog()[0].text.includes("hunter2"), currentLog()[0].text.slice(-40));
  // a detail of 2 MB of SECRET words is handled fast
  const t0 = Date.now();
  logMessage("error", "Failed.", "SECRET".repeat(333_333));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  clearLog();
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
  const some = batchEndLine({ ...end, done: 10, failed: 2, errors: [{ name: "a.txt", message: "x didn't answer in time.\n\nTimed out" }] });
  assert.equal(some.kind, "error");
  assert.equal(some.text, "Downloading “regina-lite” (folder) from psychozdravie.sk to Downloads finished with problems: 2 of 12 files failed (x didn't answer in time.)");
  const all = batchEndLine({ ...end, done: 0, failed: 12, errors: [{ name: "a.txt", message: "Wrong user name or password." }] });
  // a name with ": " in it is no part of the message
  assert.equal(batchEndLine({ ...end, done: 0, failed: 1, errors: [{ name: "report: final.txt", message: "Access denied" }] }).text.endsWith(": Access denied"), true);
  assert.equal(all.text, "Couldn't download “regina-lite” (folder) from psychozdravie.sk to Downloads: Wrong user name or password.");
  assert.deepEqual(batchEndLine({ ...end, done: 0, cancelled: 12 }), { kind: "info", text: "Stopped downloading “regina-lite” (folder) from psychozdravie.sk to Downloads" });
  assert.equal(
    batchEndLine({ kind: "compress", subject: "“Archive.zip”", conn: "X", place: "", count: 1, done: 1, failed: 0, cancelled: 0, bytes: 0, ms: 1430, errors: [] }).text,
    "Compressed into “Archive.zip” on X in 1.4 s",
  );

  const detail = batchDetail({ ...end, done: 10, failed: 2, errors: [{ name: "a.txt", message: "Timed out\n\nraw" }] }, [
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
