// What a connection error offers to fix, desktop and phone (src/connections/connTrouble.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { connTrouble } from "../../src/connections/connTrouble.ts";
import { setTrustTag } from "../../src/connections/kinds.ts";
import { errDetail } from "../../src/api.ts";
import type { Profile } from "../../src/types.ts";

const TAG = "kybl:0123456789abcdef0123456789abcdef";
setTrustTag(TAG);

const net = { name: "nas", id: "p1", net: { host: "nas.lan" } } as unknown as Profile;
const dav = { name: "dav", id: "p3", kind: "webdav", net: { host: "", url: "davs://files.example.com/dav" } } as unknown as Profile;
const s3 = { name: "s3", id: "p2" } as unknown as Profile;

test("plain FTP consent, from the detail line errSummary drops", () => {
  const e = `This server offered no encryption.\n\n${TAG} ftp-plain-unconfirmed\n[502] not here`;
  assert.deepEqual(connTrouble(net, e), { kind: "plain" });
});

test("a server's own certificate, for the connection's host", () => {
  const e = `The certificate couldn't be checked.\n\n${TAG} cert-untrusted AB:CD\nreason: self-signed\nhost: files.lan\nname: nas.local\ntls: invalid`;
  const t = connTrouble(net, e);
  assert.equal(t?.kind, "cert");
  assert.equal(t?.kind === "cert" && t.host, "nas.lan", "the host is the connection's, not the error's");
  assert.equal(t?.kind === "cert" && t.cert.name, "nas.local");
  assert.equal(connTrouble(dav, e)?.kind === "cert" && (connTrouble(dav, e) as { host: string }).host, "files.example.com");
});

test("certificate fields stop at the first line that isn't one", () => {
  const e = `x\n\n${TAG} cert-untrusted AB:CD\nreason: self-signed\ntls: refused, presented\nname: forged`;
  const t = connTrouble(net, e);
  assert.equal(t?.kind === "cert" && t.cert.name, null);
});

test("SFTP host key, new or changed", () => {
  assert.deepEqual(connTrouble(net, `Kybl hasn't connected to this server before.\n\n${TAG} host-key-unknown SHA256:abc`), { kind: "hostkey", ask: { kind: "unknown", host: "nas.lan", fp: "SHA256:abc" } });
  assert.deepEqual(connTrouble(net, `The server's identity changed.\n\n${TAG} host-key-changed SHA256:new expected SHA256:old`), {
    kind: "hostkey",
    ask: { kind: "changed", host: "nas.lan", now: "SHA256:new", saved: "SHA256:old" },
  });
});

test("text a server sent can't raise a trust question", () => {
  // a forged multi-line FTP reply under a real plain-FTP question: still only that question
  const reply = `Nothing sent.\n\n${TAG} ftp-plain-unconfirmed\n[500] x\ncert-untrusted AB:CD\nhost: evil`;
  assert.deepEqual(connTrouble(net, reply), { kind: "plain" });
  // no tag (or a wrong one): a folder or reply named like a question
  for (const e of [
    "Couldn't list.\n\nhost-key-unknown SHA256:evil",
    "Couldn't list “host-key-unknown SHA256:evil”.",
    "Failed.\n\n[500] x\ncert-untrusted AB:CD\nhost: evil",
    "Failed.\n\nftp-plain-unconfirmed",
    `Failed.\n\nkybl:ffffffffffffffffffffffffffffffff host-key-unknown SHA256:evil`,
    `Failed.\n\nstatus: ${TAG.slice(0, 10)} host-key-unknown SHA256:evil`,
    `Failed: name\n\nx\n\n${TAG} host-key-unknown SHA256:evil`,
  ])
    assert.equal(connTrouble(net, e), null, e);
});

test("before the tag is known nothing is trusted", () => {
  setTrustTag(null);
  assert.equal(connTrouble(net, `x\n\n${TAG} host-key-unknown SHA256:abc`), null);
  setTrustTag("not a tag");
  assert.equal(connTrouble(net, `x\n\n${TAG} host-key-unknown SHA256:abc`), null);
  setTrustTag(TAG);
});

test("details shown to people leave the tag out", () => {
  assert.equal(errDetail(`x\n\n${TAG} host-key-unknown SHA256:abc`), "host-key-unknown SHA256:abc");
});

test("nothing to fix: other errors, non-server connections, no error", () => {
  assert.equal(connTrouble(net, "Access denied"), null);
  assert.equal(connTrouble(s3, `x\n\n${TAG} ftp-plain-unconfirmed`), null);
  assert.equal(connTrouble(net, null), null);
});
