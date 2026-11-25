import test from "node:test";
import assert from "node:assert/strict";
import { ago, connectionFacts, gitChips, gitCounts } from "../../src/browser/lib/infoFacts.ts";
import type { Profile } from "../../src/core/types.ts";

const base: Profile = { id: "x", name: "x", kind: "s3", provider: "aws", endpoint: "https://s3.eu.example.com", region: "eu-1", accessKeyId: "", pathStyle: false };

test("S3 says bucket, region and endpoint", () => {
  assert.deepEqual(connectionFacts(base, "media"), [
    { label: "Bucket", value: "media" },
    { label: "Region", value: "eu-1" },
    { label: "Endpoint", value: "s3.eu.example.com" },
  ]);
});

test("servers say host, protocol and user; TLS on or off", () => {
  const ftp: Profile = { ...base, kind: "ftp", net: { host: "ftp.acme.test", port: 0, user: "deploy", basePath: "", tls: "none", auth: "password" } };
  const f = connectionFacts(ftp, "");
  assert.equal(f[0].value, "ftp.acme.test");
  assert.equal(f[1].value, "FTP, TLS off");
  assert.equal(f[2].value, "deploy");
  const sftp: Profile = { ...ftp, kind: "sftp", net: { ...ftp.net!, port: 2222 } };
  assert.equal(connectionFacts(sftp, "")[0].value, "ftp.acme.test:2222");
  assert.match(connectionFacts({ ...ftp, net: { ...ftp.net!, tls: "explicit" } }, "")[1].value, /^FTPS, TLS on/);
});

test("a cloud drive says its account", () => {
  const g: Profile = { ...base, kind: "gdrive", cloud: { accountEmail: "me@example.com" } as Profile["cloud"] };
  assert.deepEqual(connectionFacts(g, "root"), [{ label: "Account", value: "me@example.com" }]);
});

test("git counts leave ignored paths out", () => {
  const c = gitCounts([
    { kind: "modified", staged: true, unstaged: true },
    { kind: "added", staged: true, unstaged: false },
    { kind: "untracked", staged: false, unstaged: false },
    { kind: "ignored", staged: false, unstaged: false },
    { kind: "conflicted", staged: false, unstaged: false },
  ]);
  assert.deepEqual(c, { changed: 2, staged: 2, untracked: 1 });
});

test("commit age reads plainly", () => {
  const now = 1_000_000 * 1000;
  assert.equal(ago(1_000_000 - 10, now), "just now");
  assert.equal(ago(1_000_000 - 60, now), "1 minute ago");
  assert.equal(ago(1_000_000 - 7200, now), "2 hours ago");
  assert.equal(ago(1_000_000 - 86400 * 3, now), "3 days ago");
});

test("this computer adds no fact of its own, and chips hide zeros", () => {
  assert.deepEqual(connectionFacts({ ...base, kind: "local" }, ""), []);
  assert.deepEqual(gitChips({ changed: 2, staged: 0, untracked: 3 }), ["2 changed", "3 untracked"]);
  assert.deepEqual(gitChips({ changed: 0, staged: 0, untracked: 0 }), []);
});
