const tap = (t) => {
  const el = $$("button, a, [role=button], li, div").reverse().find((e) => e.textContent.trim() === t);
  if (!el) throw new Error(`no ${t}`);
  el.click();
};
tap("media-prod");
await sleep(1500);
tap("photosFolder");
await sleep(2000);
const grid = $$("button").find((b) => /grid|icons/i.test(b.getAttribute("aria-label") ?? b.title ?? ""));
if (grid) {
  grid.click();
  await sleep(1200);
}
