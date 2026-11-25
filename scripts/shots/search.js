collapseTransfers();
await press("f", { metaKey: true });
const i = $('input[aria-label^="Filter this folder"]'); typeInto(i, "IMG_41");
key(i, "Enter");
await sleep(1500);
