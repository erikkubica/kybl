collapseTransfers();
await pick("config-old.yaml");
const el = await pick("config-new.yaml", { metaKey: true });
ctx(el); await sleep(500);
await menuItem("Compare");
await sleep(1000);
