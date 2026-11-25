// How a program, script or installer runs, by what it is and where (src/desktop/lib/runAs.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runChoices, type RunChoice } from "../../src/desktop/lib/runAs.ts";

const labels = (c: RunChoice[]) => c.map((x) => x.label);
const line = (c: RunChoice[], label: string, q: "posix" | "powershell" | "cmd" | "wsl" = "posix") => {
  const x = c.find((y) => y.label === label);
  assert.ok(x && x.how === "terminal", `${label} runs in a terminal`);
  return x.line(q);
};
const winPC = { local: true, os: "win" as const, terminal: true };
const mac = { local: true, os: "mac" as const, terminal: true };
const linux = { local: true, os: "linux" as const, terminal: true };
const server = { local: false, os: "mac" as const, terminal: true };

test("a Windows program on this PC: Run, as administrator, in the terminal for its shell", () => {
  const c = runChoices("Setup Tool.exe", winPC);
  assert.deepEqual(labels(c), ["Run", "Run as administrator", "Run in terminal"]);
  assert.deepEqual(c.slice(0, 2).map((x) => x.how), ["open", "elevate"]);
  assert.equal(line(c, "Run in terminal", "powershell"), "& '.\\Setup Tool.exe'");
  assert.equal(line(c, "Run in terminal", "cmd"), '"Setup Tool.exe"');
  assert.equal(line(c, "Run in terminal", "posix"), "'./Setup Tool.exe'");
  assert.equal(line(runChoices("build.bat", winPC), "Run in terminal", "powershell"), "& .\\build.bat");
});

test("installers and PowerShell scripts on Windows", () => {
  assert.deepEqual(labels(runChoices("app.msi", winPC)), ["Install", "Install as administrator"]);
  const ps = runChoices("fix.ps1", winPC);
  assert.deepEqual(labels(ps), ["Run in terminal", "Run as administrator"]);
  assert.equal(line(ps, "Run in terminal", "powershell"), "& .\\fix.ps1");
  assert.equal(line(ps, "Run in terminal", "cmd"), "powershell -NoLogo -File fix.ps1");
});

test("files for another system get nothing", () => {
  assert.deepEqual(runChoices("app.exe", mac), []);
  assert.deepEqual(runChoices("app.exe", server), []);
  assert.deepEqual(runChoices("tool.deb", mac), []);
  assert.deepEqual(runChoices("deploy.sh", winPC), []);
  assert.deepEqual(runChoices("notes.txt", linux), []);
});

test("a Unix script on Windows only where the terminal's shell can run it", () => {
  assert.deepEqual(labels(runChoices("deploy.sh", { ...winPC, winShell: "gitbash" })), ["Run in terminal", "Run as administrator"]);
});

test("scripts run by their reader, in the file's folder, sudo for administrator", () => {
  const c = runChoices("deploy.sh", server);
  assert.equal(line(c, "Run in terminal"), "bash ./deploy.sh");
  assert.equal(line(c, "Run as administrator"), "sudo bash ./deploy.sh");
  assert.equal(line(runChoices("-rf.py", mac), "Run in terminal"), "python3 ./-rf.py");
  assert.equal(line(runChoices("it's.sh", mac), "Run in terminal"), "bash './it'\\''s.sh'");
  // a shell that isn't a Unix one types nothing
  assert.equal(line(c, "Run in terminal", "powershell"), null);
});

test("self-running files are made executable first; packages go through the system's installer", () => {
  assert.equal(line(runChoices("Tool.AppImage", linux), "Run in terminal"), "chmod +x ./Tool.AppImage && ./Tool.AppImage");
  assert.equal(line(runChoices("setup.run", server), "Run as administrator"), "chmod +x ./setup.run && sudo ./setup.run");
  assert.equal(line(runChoices("tool.deb", linux), "Install in terminal"), "sudo apt install ./tool.deb");
  assert.match(line(runChoices("tool.rpm", server), "Install in terminal") ?? "", /^sudo "\$\(command -v dnf/);
});

test("nowhere to open a terminal: nothing but Windows' own Run", () => {
  assert.deepEqual(runChoices("deploy.sh", { ...server, terminal: false }), []);
  assert.deepEqual(labels(runChoices("app.exe", { ...winPC, terminal: false })), ["Run", "Run as administrator"]);
});
