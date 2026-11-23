// Which files are asked about before they open (src/desktop/runnable.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runsCode } from "../../src/desktop/runnable.ts";

test("programs, scripts, installers and shortcuts run code", () => {
  for (const n of ["Invoice.pdf.exe", "setup.MSI", "x.bat", "a.lnk", "run.command", "x.terminal", "Kybl.pkg", "tool.jar", "install.sh", "evil.desktop", "x.AppImage", "macro.docm", "trailing.exe. ", "a.hta"]) {
    assert.ok(runsCode(n), n);
  }
});

test("documents and media don't", () => {
  for (const n of ["report.pdf", "photo.jpg", "notes.md", "data.csv", "exe", "archive.zip", "film.mp4", "README", ".bashrc", "doc.docx"]) {
    assert.ok(!runsCode(n), n);
  }
});
