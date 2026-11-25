collapseTransfers();
const el = await pick("Sites/acme/");
ctx(el); await sleep(500);
await hover("Keep & sync");
await menuItem("Mirror to");
await sleep(900);
// with no destination yet the folder list may already be open
await sleep(400);
if (!$(".mirror-pop")) byText(`${DIALOG} button`, "Choose").click();
const q = await waitFor(".mirror-pop input");
await sleep(600);
typeInto(q, "Acme");
// the first click opens the connection, the second picks its start folder
(await waitFor(".mirror-pop .jobs-tree-row.conn")).click(); await sleep(1200);
(await waitFor(".mirror-pop .jobs-tree-row.conn")).click(); await sleep(600);
byText(".mirror-pop button", "Done").click(); await sleep(2500);
byText(`${DIALOG} button`, "Options")?.click(); await sleep(600);
return DIALOG;
