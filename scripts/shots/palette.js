collapseTransfers();
await press("k", { metaKey: true });
const i = $(".palette input"); if (i) typeInto(i, "sync");
await sleep(600);
