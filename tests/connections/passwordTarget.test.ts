// A saved server password only follows edits that keep its server and user name
// (src/connections/kinds.ts passwordTarget, the form side of `password_target`). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyNet, passwordTarget } from "../../src/connections/kinds.ts";
import type { NetConfig } from "../../src/types.ts";

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
