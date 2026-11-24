// What a connection error offers to fix, desktop and phone (src/connections/connTrouble.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { connTrouble } from "../../src/connections/connTrouble.ts";
import { keepsSavedSecret } from "../../src/connections/kinds.ts";
import type { Profile } from "../../src/types.ts";

test("an empty secret keeps the saved one only for the same key ID or account", () => {
  assert.equal(keepsSavedSecret("AKIA1", "AKIA1"), true);
  assert.equal(keepsSavedSecret("AKIA1", " AKIA1 "), true);
  assert.equal(keepsSavedSecret("AKIA1", "AKIA2"), false);
  assert.equal(keepsSavedSecret(undefined, "AKIA1"), false);
});

const net = { name: "nas", id: "p1", net: { host: "nas.lan" } } as unknown as Profile;
const s3 = { name: "s3", id: "p2" } as unknown as Profile;

test("plain FTP consent, from the detail line errSummary drops", () => {
  const e = "This server offered no encryption. If you know this server only speaks plain FTP, you can connect without encryption.\n\nftp-plain-unconfirmed";
  assert.deepEqual(connTrouble(net, e), { kind: "plain" });
});

test("a server's own certificate", () => {
  const e = "The certificate couldn't be checked.\n\ncert-untrusted AB:CD\nreason: self-signed\nhost: files.lan";
  const t = connTrouble(net, e);
  assert.equal(t?.kind, "cert");
  assert.equal(t?.kind === "cert" && t.host, "files.lan");
});

test("SFTP host key, new or changed", () => {
  assert.deepEqual(connTrouble(net, "Kybl hasn't connected to this server before.\n\nhost-key-unknown SHA256:abc"), { kind: "hostkey", ask: { kind: "unknown", host: "nas.lan", fp: "SHA256:abc" } });
  assert.deepEqual(connTrouble(net, "The server's identity changed.\n\nhost-key-changed SHA256:new expected SHA256:old"), {
    kind: "hostkey",
    ask: { kind: "changed", host: "nas.lan", now: "SHA256:new", saved: "SHA256:old" },
  });
});

test("nothing to fix: other errors, non-server connections, no error", () => {
  assert.equal(connTrouble(net, "Access denied"), null);
  assert.equal(connTrouble(s3, "ftp-plain-unconfirmed"), null);
  assert.equal(connTrouble(net, null), null);
});
