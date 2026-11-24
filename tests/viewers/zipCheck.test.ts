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

// S-2: files JSZip reads differently from a plain zip. Each holds a part that inflates past the cap.
const bomb = () => zip({ "word/document.xml": new Uint8Array(3 << 20) });
const eocdOf = (z: Uint8Array) => {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) return i;
  throw new Error("no end record");
};

test("a byte in front of the zip (JSZip shifts every offset) is refused, not taken for 'not a zip'", async () => {
  const z = await bomb();
  const prefixed = new Uint8Array(z.length + 1);
  prefixed[0] = 10;
  prefixed.set(z, 1);
  assert.notEqual(await zipTooBig(prefixed, caps), null);
  // and JSZip really does read it
  assert.ok((await JSZip.loadAsync(prefixed)).files["word/document.xml"]);
});

test("a ZIP64 trigger JSZip honours but the 32-bit directory doesn't mention is refused", async () => {
  const z = await bomb();
  new DataView(z.buffer, z.byteOffset, z.byteLength).setUint32(eocdOf(z) + 12, 0xffffffff, true);
  assert.notEqual(await zipTooBig(z, caps), null);
});

test("a zip comment, entries beyond the counted ones, and a gap before the end record are refused", async () => {
  const z = await bomb();
  const e = eocdOf(z);
  const commented = new Uint8Array(z.length + 4);
  commented.set(z);
  new DataView(commented.buffer).setUint16(e + 20, 4, true);
  assert.notEqual(await zipTooBig(commented, caps), null);
  const fewer = z.slice();
  new DataView(fewer.buffer).setUint16(e + 10, 0, true);
  assert.notEqual(await zipTooBig(fewer, caps), null);
  const gap = new Uint8Array(z.length + 3);
  gap.set(z.subarray(0, e));
  gap.set(z.subarray(e), e + 3);
  assert.notEqual(await zipTooBig(gap, caps), null);
});
