// usage: node cap.mjs <out.png> <light|dark> <seed.json|-> [after.js]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [out, scheme, seedFile, afterFile, w = "1200", h = "750"] = process.argv.slice(2);
const seed = seedFile && seedFile !== "-" ? readFileSync(seedFile, "utf8") : "{}";
const after = afterFile ? readFileSync(afterFile, "utf8") : "";
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "kc-"))}`,
  "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pg = t.find((x) => x.type === "page");
    if (pg) { ws = pg.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(200);
}
const sock = new WebSocket(ws);
await new Promise((r) => (sock.onopen = r));
let id = 0; const wait = new Map();
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: +(process.env.DPR || 2), mobile: false });
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `try { if (!sessionStorage.seeded) { localStorage.clear(); const s = ${seed}; for (const k in s) localStorage.setItem(k, typeof s[k] === "string" ? s[k] : JSON.stringify(s[k])); sessionStorage.seeded = 1; } } catch (e) {}` });
await cdp("Page.navigate", { url: process.env.URL || "http://localhost:1420/?shots" });
await sleep(4000);
let clip;
if (after) {
  const r = await cdp("Runtime.evaluate", { expression: `(async () => { ${after} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  await sleep(1500);
  // the script may name an element to crop to (it is measured after the wait)
  const v = r.result?.result?.value;
  if (typeof v === "string") {
    const m = await cdp("Runtime.evaluate", { expression: `(() => { const r = document.querySelector(${JSON.stringify(v)}).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`, returnByValue: true });
    const [x, y, width, height] = m.result.result.value;
    clip = { x, y, width, height, scale: 1 };
  }
}
const shot = await cdp("Page.captureScreenshot", clip ? { format: "png", clip, captureBeyondViewport: true } : { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
sock.close(); chrome.kill();
console.log("saved", out);
