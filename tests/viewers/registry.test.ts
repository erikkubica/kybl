// Which viewer opens a file (src/viewers/lib/registry.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerFor } from "../../src/viewers/lib/registry.ts";

const kind = (name: string, ct?: string) => viewerFor(name, ct)?.kind ?? null;

test("dotfiles open as text, whatever their content type", () => {
  for (const n of [".env", ".gitignore", ".editorconfig", ".env.local", ".bashrc", ".npmrc", "site/.htaccess", "app/.env"]) {
    assert.equal(kind(n, "application/octet-stream"), "text", n);
  }
});

test("extensions and whole names still work", () => {
  assert.equal(kind("README.md"), "markdown");
  assert.equal(kind(".prettierrc.json"), "json");
  assert.equal(kind("Dockerfile"), "text");
  assert.equal(kind("dir/Makefile"), "text");
  assert.equal(kind("photo.JPG"), "image");
  assert.equal(kind(".DS_Store"), null);
  assert.equal(kind("archive.zip"), null);
});
