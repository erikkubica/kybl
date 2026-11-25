// Which files are asked about before they open (src/desktop/lib/runnable.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksFirst, localName, openerOf, runsCode } from "../../src/desktop/lib/runnable.ts";

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

test("types that run on open on some systems", () => {
  for (const n of ["x.pyz", "x.pyzw", "x.pyc", "x.pyo", "x.jsx", "x.jsxbin", "x.saver", "x.service", "x.msh", "x.mshxml", "x.shs", "x.inf", "x.job"]) {
    assert.ok(runsCode(n), n);
  }
});

// The guard gets the remote name; the file that opens has its local name. Both count.
test("names that change on the way to disk are judged by both", () => {
  assert.equal(localName("payload.exe\\"), "payload.exe");
  assert.equal(localName("x.exe\\.."), "x.exe");
  assert.equal(localName("a/b/../run.command/"), "run.command");
  for (const n of ["payload.exe\\", "x.exe\\..", "x.terminal\\", "x.fileloc\\", "x.pkg\\.", "x.exe\\.\\"]) {
    assert.ok(!runsCode(n), `${n} alone would slip through`);
    assert.ok(asksFirst(n, "default"), n);
    assert.ok(asksFirst(n, "editor"), `${n}: not a script, so asked whatever the app`);
  }
});

test("trailing dots and spaces, case and right-to-left override don't hide the type", () => {
  for (const n of ["setup.exe.", "setup.exe . .", "SETUP.EXE", "Run.Command", "invoice\u202Etxt.exe", "photo\u202Egpj.sh"]) {
    assert.ok(asksFirst(n, "default"), JSON.stringify(n));
  }
  // the override only changes how the name looks: this one is a .txt
  assert.ok(!asksFirst("notes\u202Eexe.txt", "default"));
});

test("a long name is judged by its real (last) extension", () => {
  // files/edit.rs keeps the extension when it shortens a name (segments_keep_the_extension), so the copy is a .txt too
  assert.ok(!asksFirst(`${"A".repeat(116)}.exe.txt`, "default"));
  assert.ok(asksFirst(`${"A".repeat(300)}.txt.exe`, "default"));
});

test("a script going to a known text editor isn't asked about", () => {
  for (const n of ["deploy.sh", "app.js", "index.php", "tool.py", "x.ps1", "run.bat", "a.rb", "b.pl", "x.command", "fix.reg"]) {
    assert.ok(asksFirst(n, "default"), `${n} in its default app`);
    assert.ok(asksFirst(n, "other"), `${n} in any other app`);
    assert.ok(!asksFirst(n, "editor"), `${n} in an editor`);
  }
  // programs, installers, macro documents: the picked app is the one that runs them
  for (const n of ["setup.exe", "Kybl.pkg", "x.dmg", "macro.docm", "corp.mobileconfig", "tool.jar", "x.app", "x.pyc", "x.scpt"]) {
    assert.ok(asksFirst(n, "editor"), n);
  }
});

test("only known text editors count as editors", () => {
  assert.equal(openerOf(undefined, false), "default");
  assert.equal(openerOf(null, false), "default");
  assert.equal(openerOf("", false), "default");
  assert.equal(openerOf("/Applications/Preview.app", true), "default");
  // an editor that is the type's default only shows it too
  assert.equal(openerOf("/Applications/Visual Studio Code.app", true), "editor");
  const editors = [
    "/Applications/Visual Studio Code.app",
    "/Applications/Sublime Text.app",
    "/System/Applications/TextEdit.app",
    "/Applications/BBEdit.app",
    "C:\\Program Files\\Notepad++\\notepad++.exe",
    "/Applications/Xcode.app",
    "/Applications/Zed.app",
    "/Applications/Nova.app",
    "/Applications/CotEditor.app",
    "/Applications/PyCharm Community Edition.app",
    "/Applications/IntelliJ IDEA CE.app",
    "org.gnome.TextEditor.desktop",
    "org.kde.kate.desktop",
    "/Applications/Cursor.app/",
  ];
  for (const p of editors) assert.equal(openerOf(p, false), "editor", p);
  // apps that run what they open, or might: asked about
  const others = [
    "/System/Applications/Utilities/Terminal.app",
    "/Applications/iTerm.app",
    "/Applications/Rio.app",
    "/Applications/WaveTerm.app",
    "/Applications/Termius.app",
    "/Applications/Python 3.12/Python Launcher 3.app",
    "/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app",
    "/Applications/Adobe Illustrator 2026/Adobe Illustrator.app",
    "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app",
    "/Applications/CrossOver.app",
    "/Applications/Whisky.app",
    "/Applications/Wine Stable.app",
    "/Applications/Parallels Desktop.app",
    "/System/Library/CoreServices/Finder.app",
    "/System/Library/CoreServices/Installer.app",
    "/usr/bin/node",
    "C:\\Windows\\System32\\wscript.exe",
    "/Applications/Not Code.app",
    "/Applications/Codex.app",
  ];
  for (const p of others) assert.equal(openerOf(p, false), "other", p);
});

test("automation imports, VPN profiles, VM bundles and saved searches are asked about", () => {
  for (const n of ["x.search-ms", "x.scptd", "x.kmmacros", "x.alfredworkflow", "x.bttpreset", "corp.tblk", "corp.ovpn", "win.vmwarevm", "win.vmx", "win.pvm", "x.slp", "x.osax"]) {
    assert.ok(runsCode(n), n);
    assert.ok(asksFirst(n, "editor"), `${n}: not a plain script`);
  }
});
