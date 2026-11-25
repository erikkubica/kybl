const tap = (t) => {
  const el = $$("button, a, [role=button], li, div").reverse().find((e) => e.textContent.trim() === t);
  if (!el) throw new Error(`no ${t}`);
  el.click();
};
tap("media-prod");
await sleep(1500);
tap("photosFolder");
await sleep(2000);
const hit = $$("button, [role=button], li, div").reverse().find((e) => e.textContent.trim().startsWith("IMG_4103.jpg"));
if (!hit) throw new Error("no photo");
hit.click();
await sleep(1500);
