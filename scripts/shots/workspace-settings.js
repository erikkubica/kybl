collapseTransfers();
const t = $(".ws-tab.on"); mouse(t, "dblclick"); await sleep(300);
const c = $(".ws-tab.on .ws-cog"); if (c) c.click(); else { ctx(t); await sleep(400); await menuItem("Settings"); }
await sleep(900);
