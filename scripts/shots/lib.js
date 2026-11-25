// shared helpers, put in front of every shot script by cap.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const byText = (sel, text, root = document) => $$(sel, root).find((e) => e.textContent.trim().replace(/\s+/g, " ").includes(text));
const typeInto = (el, text) => {
  el.focus();
  const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
  set.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const key = (el, k, more = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...more }));
const ctx = (el) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 30, clientY: r.y + r.height / 2, button: 2 }));
};
const click = (el) => {
  if (!el) throw new Error("nothing to click");
  el.click();
};
const mouse = (el, type, more = {}) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.x + Math.min(30, r.width / 2), clientY: r.y + r.height / 2, button: 0, ...more }));
};
/** selects a file or folder by its key (as a click would; shift / meta add to the selection) */
const pick = async (k, more = {}) => {
  const el = $(`[data-key="${k}"]`) ?? $$("[data-key]").find((e) => e.dataset.key.endsWith(k));
  if (!el) throw new Error(`no ${k}`);
  mouse(el, "mousedown", more);
  mouse(el, "mouseup", more);
  mouse(el, "click", more);
  await sleep(150);
  return el;
};
const open2 = async (k) => {
  const el = await pick(k);
  mouse(el, "dblclick", { detail: 2 });
  await sleep(1200);
};
const menuItem = async (text) => {
  const it = byText('[role="menuitem"]', text);
  if (!it) throw new Error(`no menu item ${text}`);
  mouse(it, "mouseover");
  mouse(it, "mouseenter");
  it.click();
  await sleep(500);
  return it;
};
const hover = async (text) => {
  const it = byText('[role="menuitem"]', text);
  if (!it) throw new Error(`no menu item ${text}`);
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) it.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  await sleep(500);
};
const press = async (k, more = {}) => {
  key(document.activeElement ?? document.body, k, more);
  await sleep(600);
};
const DIALOG = '.modal-backdrop [role="dialog"]';
// the hero layout's right pane: the SFTP server (SSH connections only open terminals)
async function openServerRight(name = "Web server", pane = "right") {
  const inp = $(`[data-pane="${pane}"] input[placeholder^="Find a connection or favorite"]`);
  if (!inp) return;
  typeInto(inp, name);
  await sleep(300);
  key(inp, "Enter");
  await sleep(1200);
}

const side = (text) => byText(".side-item", text);
const collapseTransfers = () => { const t = $('.transfers [aria-expanded="true"]'); if (t) t.click(); };
const settingsPage = async (label) => {
  await press(",", { metaKey: true });
  await sleep(500);
  const b = byText(".settings-nav .side-item", label);
  if (!b) throw new Error(`no settings page ${label}`);
  b.click();
  await sleep(700);
};
const paneMenu = async (pane = "left") => {
  $(`[data-pane="${pane}"] .tb-more`).click();
  await sleep(500);
};
const waitFor = async (sel, ms = 4000) => {
  for (let t = 0; t < ms; t += 100) { const el = $(sel); if (el) return el; await sleep(100); }
  throw new Error(`never showed up: ${sel}`);
};
