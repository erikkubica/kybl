collapseTransfers();
side("Servers")?.click(); await sleep(400);
ctx(side("media-prod")); await sleep(400); await menuItem("Add to favorites"); await sleep(300);
ctx(side("Desktop")); await sleep(400); await menuItem("Add to favorites"); await sleep(600);
await openServerRight();
