// The FTP / SFTP "Server" field splitting pasted URLs (src/connections/serverHost.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitServer } from "../../src/connections/serverHost.ts";

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
