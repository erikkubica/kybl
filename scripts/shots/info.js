collapseTransfers();
await pick("photos/IMG_4104.jpg");
const b = $('[data-pane="left"] button[aria-label*="nfo"]') ; if (b) b.click(); else await press("i", { metaKey: true });
await sleep(800);
