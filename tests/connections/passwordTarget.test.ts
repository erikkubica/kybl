// A saved server password only follows edits that keep its server and user name
// (src/connections/lib/kinds.ts passwordTarget, the form side of `password_target`). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { blobTarget, emptyNet, passwordTarget } from "../../src/connections/lib/kinds.ts";
import type { NetConfig } from "../../src/core/types.ts";

const net = (kind: "ftp" | "sftp" | "webdav", over: Partial<NetConfig>): NetConfig => ({ ...emptyNet(kind), ...over });

test("FTP and SFTP: server, port and user name are the password's identity", () => {
  const ftp = net("ftp", { host: "Files.Example.com", user: "alice", tls: "explicit" });
  const t = (n: NetConfig) => passwordTarget("ftp", n);
  assert.equal(t(ftp), t({ ...ftp, host: " files.example.com", port: 21, basePath: "/x" }));
  assert.notEqual(t(ftp), t({ ...ftp, host: "other.example.com" }));
  assert.notEqual(t(ftp), t({ ...ftp, user: "bob" }));
  assert.notEqual(t(ftp), t({ ...ftp, port: 2121 }));
  assert.equal(passwordTarget("sftp", net("sftp", { host: "h", user: "u", auth: "key" })), null, "a key only signs");
  assert.ok(passwordTarget("sftp", net("sftp", { host: "h", user: "u", auth: "password" })));
});

test("WebDAV: the address's server and the user name", () => {
  const dav = (url: string) => passwordTarget("webdav", net("webdav", { url, user: "u" }));
  assert.equal(dav("https://Cloud.example.com/remote.php/dav/"), dav("davs://cloud.example.com:443/other/"));
  assert.notEqual(dav("https://cloud.example.com/"), dav("https://evil.example.net/"));
  assert.notEqual(dav("https://cloud.example.com/"), dav("https://cloud.example.com:8443/"));
  // saved with host and port instead of an address
  assert.equal(passwordTarget("webdav", net("webdav", { host: "cloud.example.com", tls: "implicit", user: "u", url: null })), dav("https://cloud.example.com/"));
});

test("the transport and a port typed in the host count too (B3-6, S-4)", () => {
  const dav = (url: string) => passwordTarget("webdav", net("webdav", { url, user: "u" }));
  assert.notEqual(dav("https://cloud.example.com/"), dav("http://cloud.example.com/"));
  assert.notEqual(dav("https://cloud.example.com/"), dav("dav://cloud.example.com/"), "dav:// is plain http");
  assert.notEqual(dav("https://cloud.example.com/"), dav("ftp://cloud.example.com/"));
  const ftp = net("ftp", { host: "files.example.com", user: "a", tls: "explicit" });
  const t = (n: NetConfig) => passwordTarget("ftp", n);
  assert.notEqual(t(ftp), t({ ...ftp, tls: "none" }));
  assert.notEqual(t(ftp), t({ ...ftp, tls: "auto" }));
  assert.notEqual(t(ftp), t({ ...ftp, host: "files.example.com:2121" }));
  assert.equal(t({ ...ftp, host: "files.example.com:2121" }), t({ ...ftp, port: 2121 }));
});

test("an Azure SAS token or a Google key stays with its endpoint (S-3)", () => {
  const az = (account: string, endpoint: string) => blobTarget("azblob", { account, endpoint, container: "c" });
  assert.equal(az("acct", ""), az(" Acct", "https://acct.blob.core.windows.net/"));
  assert.notEqual(az("acct", ""), az("acct", "https://attacker.example"));
  assert.notEqual(az("acct", ""), az("acct", "http://acct.blob.core.windows.net"));
  assert.notEqual(az("acct", ""), az("other", ""));
  const gcs = (endpoint: string) => blobTarget("gcs", { account: "", endpoint, container: "b" });
  assert.equal(gcs(""), gcs("https://storage.googleapis.com/"));
  assert.notEqual(gcs(""), gcs("https://attacker.example"));
});
