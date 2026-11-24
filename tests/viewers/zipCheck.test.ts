// Zip bomb check before the Office previews parse a file (src/viewers/zipCheck.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { zipTooBig } from "../../src/viewers/zipCheck.ts";

const caps = { part: 1 << 20, total: 2 << 20 };

async function zip(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [n, d] of Object.entries(files)) z.file(n, d);
  return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

test("an ordinary document passes", async () => {
  const z = await zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document>hello</w:document>".repeat(1000) });
  assert.equal(await zipTooBig(z, caps), null);
});

test("a part that inflates past the cap is refused", async () => {
  const z = await zip({ "xl/worksheets/sheet1.xml": new Uint8Array(3 << 20) });
  assert.ok(z.length < 64 * 1024, "small on disk");
  assert.match((await zipTooBig(z, caps)) ?? "", /too big|too far/);
});

test("many parts that together inflate past the cap are refused", async () => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 4; i++) files[`ppt/slides/slide${i}.xml`] = new Uint8Array(900 * 1024);
  assert.match((await zipTooBig(await zip(files), caps)) ?? "", /too far/);
});

test("headers that understate the size don't help: what inflates counts", async () => {
  const z = await zip({ "document.xml": new Uint8Array(3 << 20) }); // one entry: the first header is its own
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  // claim 10 bytes in the local header and in the directory
  dv.setUint32(22, 10, true);
  for (let i = z.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      const cd = dv.getUint32(i + 16, true);
      dv.setUint32(cd + 24, 10, true);
      break;
    }
  }
  assert.match((await zipTooBig(z, caps)) ?? "", /too far/);
});

test("a header that overstates the size is refused too (SheetJS allocates it)", async () => {
  const z = await zip({ "workbook.xml": "<workbook/>" });
  new DataView(z.buffer, z.byteOffset, z.byteLength).setUint32(22, 0x7fffffff, true);
  assert.match((await zipTooBig(z, caps)) ?? "", /too big/);
});

test("not a zip (an old .xls, a CSV): nothing to check", async () => {
  assert.equal(await zipTooBig(new TextEncoder().encode("a,b\n1,2\n"), caps), null);
  assert.equal(await zipTooBig(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), caps), null);
  // starts like a zip but has no directory: refused rather than guessed at
  assert.notEqual(await zipTooBig(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), caps), null);
});
