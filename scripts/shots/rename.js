collapseTransfers();
await pick("photos/IMG_4101.jpg");
await pick("photos/IMG_4108.jpg", { shiftKey: true });
await press("F2");
await sleep(500);
return DIALOG;
