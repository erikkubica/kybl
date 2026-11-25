// Heading ids for Markdown anchors (src/viewers/lib/slug.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { headingSlugger, htmlText } from "../../src/viewers/lib/slug.ts";

test("GitHub-style slugs", () => {
  const s = headingSlugger();
  assert.equal(s("Install"), "install");
  assert.equal(s("Getting Started!"), "getting-started");
  assert.equal(s("What's new in v2.0?"), "whats-new-in-v20");
  assert.equal(s("snake_case and kebab-case"), "snake_case-and-kebab-case");
  assert.equal(s("Über Café"), "über-café");
});

test("repeated headings get -1, -2", () => {
  const s = headingSlugger();
  assert.equal(s("Usage"), "usage");
  assert.equal(s("Usage"), "usage-1");
  assert.equal(s("Usage"), "usage-2");
  assert.equal(s("Usage 1"), "usage-1-1");
});

test("text of inline HTML", () => {
  assert.equal(htmlText("Use <code>a &amp; b</code> &lt;here&gt;"), "Use a & b <here>");
});
