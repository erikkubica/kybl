// Zip bomb check before the Office previews parse a file (src/viewers/zipCheck.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { openCapped, readCapped, zipTooBig } from "../../src/viewers/zipCheck.ts";

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

// R7 S-1: the end record can be further than 64 KB from the end; JSZip still finds it.
test("a zip with junk in front and 70 000 bytes after the end record is refused (S-1)", async () => {
  const z = await bomb();
  const odd = new Uint8Array(1 + z.length + 70000);
  odd[0] = 10;
  odd.set(z, 1);
  assert.notEqual(await zipTooBig(odd, caps), null);
  assert.ok((await JSZip.loadAsync(odd)).files["word/document.xml"], "JSZip really reads it");
  // an old .xls / a big CSV with no end record anywhere is still just "not a zip"
  assert.equal(await zipTooBig(new Uint8Array(200000).fill(65), caps), null);
});

// R7 S-2: a repeated ZIP64 extra field (JSZip: the last wins; the first would say "10 bytes").
test("an entry with two ZIP64 extra fields, or one nobody asked for, is refused (S-2)", async () => {
  const z = await bomb();
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const e = eocdOf(z);
  const cd = dv.getUint32(e + 16, true);
  const nameLen = dv.getUint16(cd + 28, true);
  const rebuilt = (extra: Uint8Array, mark: boolean) => {
    const head = z.slice(0, cd + 46 + nameLen);
    const tail = z.slice(cd + 46 + nameLen, e);
    const end = z.slice(e);
    const out = new Uint8Array(head.length + extra.length + tail.length + end.length);
    out.set(head);
    out.set(extra, head.length);
    out.set(tail, head.length + extra.length);
    out.set(end, head.length + extra.length + tail.length);
    const o = new DataView(out.buffer);
    o.setUint16(cd + 30, extra.length, true);
    o.setUint32(out.length - 22 + 12, dv.getUint32(e + 12, true) + extra.length, true);
    if (mark) (o.setUint32(cd + 20, 0xffffffff, true), o.setUint32(cd + 24, 0xffffffff, true));
    return out;
  };
  const field = (a: number, b: number) => {
    const f = new Uint8Array(20);
    const d = new DataView(f.buffer);
    d.setUint16(0, 1, true);
    d.setUint16(2, 16, true);
    d.setUint32(4, a, true);
    d.setUint32(12, b, true);
    return f;
  };
  const two = new Uint8Array(40);
  two.set(field(10, 10));
  two.set(field(3 << 20, 100), 20);
  assert.equal(await zipTooBig(rebuilt(two, true), caps), "unusual zip layout");
  assert.equal(await zipTooBig(rebuilt(field(5, 5), false), caps), "unusual zip layout");
});

// R7: the cap is enforced while inflating, not only read from headers.
test("readCapped stops a part at the cap and counts every byte it makes", async () => {
  const z = await JSZip.loadAsync(await zip({ "a.xml": new Uint8Array(3 << 20), "b.xml": "<b/>" }));
  await assert.rejects(readCapped(z.file("a.xml")!, { left: 10 << 20 }, 1 << 20), /too far/);
  assert.equal((await readCapped(z.file("b.xml")!, { left: 10 << 20 })).length, 4);
  // one budget for the whole file: two parts that each fit but together don't
  const two = await JSZip.loadAsync(await zip({ "a.xml": new Uint8Array(900 << 10), "b.xml": new Uint8Array(900 << 10) }));
  const budget = { left: 1 << 20 };
  await readCapped(two.file("a.xml")!, budget);
  await assert.rejects(readCapped(two.file("b.xml")!, budget), /too far/);
});

// Ordinary Office files, made the way Word, Excel and PowerPoint lay them out, still preview.
test("real docx, xlsx and pptx files pass, and open through the capped reader", async () => {
  const docx = await zip({
    "[Content_Types].xml": "<Types/>",
    "_rels/.rels": "<Relationships/>",
    "word/document.xml": "<w:document><w:body>" + "<w:p><w:r><w:t>hello</w:t></w:r></w:p>".repeat(5000) + "</w:body></w:document>",
    "word/media/image1.png": new Uint8Array(50000).map((_, i) => (i * 7) & 255),
  });
  assert.equal(await zipTooBig(docx), null);
  assert.match((await (await openCapped(docx)).text("word/document.xml")) ?? "", /hello/);

  const book = { SheetNames: ["S"], Sheets: { S: XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]) } };
  const xlsx = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  assert.equal(await zipTooBig(xlsx), null);
  assert.equal(XLSX.read(xlsx, { type: "array" }).SheetNames[0], "S");

  const pptx = await zip({ "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p:presentation/>", "ppt/slides/slide1.xml": "<p:sld/>", "docProps/thumbnail.jpeg": new Uint8Array(2000).fill(7) });
  assert.equal(await zipTooBig(pptx), null);
  const opened = await openCapped(pptx);
  assert.deepEqual([opened.has("ppt/slides/slide1.xml"), opened.has("nope")], [true, false]);
  assert.equal((await opened.bytes("docProps/thumbnail.jpeg"))?.length, 2000);
});
