// Which files are asked about before they open (src/desktop/runnable.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runsCode } from "../../src/desktop/runnable.ts";

test("programs, scripts, installers and shortcuts run code", () => {
  for (const n of ["Invoice.pdf.exe", "setup.MSI", "x.bat", "a.lnk", "run.command", "x.terminal", "Kybl.pkg", "tool.jar", "install.sh", "evil.desktop", "x.AppImage", "macro.docm", "trailing.exe. ", "a.hta"]) {
    assert.ok(runsCode(n), n);
  }
});

test("settings, connections and installers that change the machine are asked about", () => {
  for (const n of ["office.rdp", "corp.mobileconfig", "x.shortcut", "deck.ppsm", "addin.xll", "q.iqy", "x.slk", "app.appinstaller", "pkg.msix", "pkg.appx", "x.settingcontent-ms", "help.chm", "start.jnlp", "x.wsc", "x.sct", "x.psc1", "x.ps1xml", "dark.theme", "x.library-ms", "fix.diagcab", "db.accdb"]) {
    assert.ok(runsCode(n), n);
  }
  for (const n of ["slides.ppsx", "old.doc", "sheet.xls", "theme.css", "shortcuts.txt"]) {
    assert.ok(!runsCode(n), n);
  }
});

test("documents and media don't", () => {
  for (const n of ["report.pdf", "photo.jpg", "notes.md", "data.csv", "exe", "archive.zip", "film.mp4", "README", ".bashrc", "doc.docx"]) {
    assert.ok(!runsCode(n), n);
  }
});
