// The FTP / SFTP "Server" field splitting pasted URLs (src/connections/lib/serverHost.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDavUrl, splitServer } from "../../src/connections/lib/serverHost.ts";

test("a plain name stays as it is", () => {
  assert.deepEqual(splitServer(" nas.lan "), { host: "nas.lan" });
  assert.deepEqual(splitServer("192.168.1.5"), { host: "192.168.1.5" });
  assert.deepEqual(splitServer("fe80::1"), { host: "fe80::1" });
});

test("pasted URLs, host:port and user@host fill the other fields", () => {
  assert.deepEqual(splitServer("sftp://nas.lan"), { host: "nas.lan" });
  assert.deepEqual(splitServer("nas.lan:2222"), { host: "nas.lan", port: 2222 });
  assert.deepEqual(splitServer("me@nas.lan"), { host: "nas.lan", user: "me" });
  assert.deepEqual(splitServer("ftp://me:secret@ftp.example.com:2121/pub/files"), { host: "ftp.example.com", port: 2121, user: "me" });
  assert.deepEqual(splitServer("[2001:db8::1]:22"), { host: "2001:db8::1", port: 22 });
  assert.deepEqual(splitServer("nas.lan/"), { host: "nas.lan" });
});

test("what can't be a server says so", () => {
  assert.equal(splitServer(""), "Enter the server's name or address.");
  assert.equal(splitServer("my nas"), "Enter only the server's name or address, such as server.example.com.");
  assert.equal(splitServer("nas.lan:99999"), "Ports are numbers from 1 to 65535.");
  assert.equal(splitServer("nas.lan:ssh"), "Ports are numbers from 1 to 65535.");
  assert.equal(splitServer("sftp://"), "Enter only the server's name or address, such as server.example.com.");
});

test("a WebDAV address loses its user name and password, which are returned apart", () => {
  assert.deepEqual(splitDavUrl("https://alice:pw%40x@cloud.example.com/remote.php/dav/files/alice/"), {
    href: "https://cloud.example.com/remote.php/dav/files/alice/",
    user: "alice",
    password: "pw@x",
  });
  assert.deepEqual(splitDavUrl(" https://bob@host:5006 "), { href: "https://host:5006", user: "bob", password: undefined });
  // an @ in the path is not userinfo
  assert.deepEqual(splitDavUrl("https://host/files/a@b/"), { href: "https://host/files/a@b/" });
  assert.deepEqual(splitDavUrl("https://cloud.example.com"), { href: "https://cloud.example.com" });
});

test("a WebDAV address that can't be read as typed is refused, never changed to another host", () => {
  // an unencoded # or / in a password cuts the address short
  assert.match(splitDavUrl("https://alice:my#pass@host/dav/").error ?? "", /Password field/);
  assert.match(splitDavUrl("https://u:pa/ss@host/").error ?? "", /Password field/);
  // a backslash ends the host, as in a browser: nothing is taken for userinfo
  assert.deepEqual(splitDavUrl("https://host\\@evil.com/"), { href: "https://host\\@evil.com/" });
  // a port and an @ further on in the path are fine
  assert.deepEqual(splitDavUrl("https://host:5006/files/a@b/"), { href: "https://host:5006/files/a@b/" });
  assert.deepEqual(splitDavUrl("https://[::1]:8443/d?q=a@b"), { href: "https://[::1]:8443/d?q=a@b" });
});

test("another user in the address than in User name is an error and gives nothing to the vault", () => {
  const r = splitDavUrl("https://alice:secret@host/dav/", "bob");
  assert.match(r.error ?? "", /another user name/);
  assert.equal(r.password, undefined);
  assert.equal(r.user, undefined);
  // the same user, or none typed, is split as usual
  assert.equal(splitDavUrl("https://alice:secret@host/dav/", "alice").password, "secret");
  assert.equal(splitDavUrl("https://alice:secret@host/dav/", " ").password, "secret");
});
