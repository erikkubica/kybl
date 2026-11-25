// Links handed to the system browser or mail app (src/core/openLink.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeLink } from "../../src/core/openLink.ts";

test("only web and mail links pass", () => {
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "tel:123", "smb://host/share", "ms-settings:", "vbscript:x", "docs/readme.md", "#top", "", "http://"]) {
    assert.equal(safeLink(bad), null, bad);
  }
  assert.equal(safeLink("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(safeLink("HTTP://Example.COM"), "http://example.com/");
  assert.equal(safeLink("mailto:someone@example.com"), "mailto:someone@example.com");
});

test("what is opened is the parsed URL: quotes, spaces and controls come out encoded", () => {
  const out = safeLink('https://a.example/x "--some-flag" <b>');
  assert.equal(out, "https://a.example/x%20%22--some-flag%22%20%3Cb%3E");
  assert.equal(safeLink("https://a.example/a\tb\nc"), "https://a.example/abc");
  for (const s of ["https://a.example/x\" & calc", "mailto:a@b.example?subject=a b\"c"]) {
    const u = safeLink(s);
    assert.ok(u && !/[\s"<>]/.test(u), `${s} -> ${u}`);
  }
});
