/**
 * Browser dev mode only (loaded by devMock.ts): a pretend `doc_open` / `doc_save` with sample
 * files of every kind the viewers handle, so the editor can be designed with plain `pnpm dev`.
 * Saves are kept in memory and checked like the real backend does, conflicts included.
 */
import JSZip from "jszip";
import type { DocMeta, DocPrecondition } from "../../core/api";

type Stored = { bytes: Uint8Array; meta: DocMeta };
const files = new Map<string, Stored>();
let counter = 1;

const enc = (s: string) => new TextEncoder().encode(s);

function meta(bytes: Uint8Array, contentType: string): DocMeta {
  return { etag: `mock${(counter++).toString(16).padStart(6, "0")}`, size: bytes.length, modified: Date.now(), contentType, version: null };
}

const MARKDOWN = `# Kybl notes

A **Markdown** file with the usual bits: *emphasis*, \`code\`, [a link](https://kybl.app) and a list.

- Buckets are folders at the top
- Keys ending in \`/\` are folders
  - nested item

## A table

| Provider | Region | Conditional PUT |
|---|---|---|
| AWS | eu-central-1 | yes |
| Hetzner | nbg1 | compare |

> Quotes look like this.

\`\`\`json
{ "hello": "world", "n": 42 }
\`\`\`

<img src=x onerror="alert('this must never run')">
<script>alert("nor this")</script>

1. First
2. Second
`;

const JSON_TEXT = `{
  "name": "kybl",
  "version": "0.3.2",
  "features": ["editor", "viewer", "conflicts"],
  "limits": { "editMB": 5, "csvMB": 50 },
  "nested": { "deep": { "deeper": [1, 2, 3, null, true] } }
}
`;

function csv(rows: number): string {
  const lines = ["sku,product,warehouse,quantity,price,updated"];
  const products = ["Pho bowl", "Banh mi", "Coffee, iced", "Spring rolls", 'The "special"', "Che ba mau"];
  for (let i = 1; i <= rows; i++) {
    const p = products[i % products.length];
    const quoted = /[,"]/.test(p) ? `"${p.replace(/"/g, '""')}"` : p;
    lines.push(`SKU-${String(i).padStart(5, "0")},${quoted},${["HAN", "SGN", "DAD"][i % 3]},${(i * 37) % 500},${((i * 13) % 900) / 10 + 1},2026-11-${String((i % 28) + 1).padStart(2, "0")}`);
  }
  return lines.join("\r\n") + "\r\n";
}

const CODE = `// A TypeScript sample, with Windows line endings and a BOM to keep
export function greet(name: string): string {
  const when = new Date().getHours() < 12 ? "morning" : "day";
  return \`Good \${when}, \${name}!\`;
}
`;

const YAML = `# docker-compose style
services:
  app:
    image: ghcr.io/kybl/app:0.3.2
    ports: ["8080:80"]
    environment:
      LOG_LEVEL: info
      FEATURE_EDITOR: true
`;

async function docx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert('no')" TargetMode="External"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://kybl.app" TargetMode="External"/></Relationships>`,
  );
  const p = (text: string, opts = "") => `<w:p>${opts ? `<w:pPr>${opts}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const body =
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="48"/></w:rPr><w:t>Quarterly report</w:t></w:r></w:p>` +
    p("This is a tiny Word document made in the browser to try the viewer.") +
    `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">Italic, </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="C0392B"/></w:rPr><w:t xml:space="preserve">bold red, </w:t></w:r><w:hyperlink r:id="rId10"><w:r><w:rPr><w:u w:val="single"/><w:color w:val="2C6BF2"/></w:rPr><w:t>a safe link</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>a javascript: link that does nothing</w:t></w:r></w:hyperlink></w:p>` +
    `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>` +
    ["Region|Revenue", "Hanoi|1,240", "Saigon|2,010"].map((r) => `<w:tr>${r.split("|").map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("") +
    `</w:tbl>` +
    Array.from({ length: 30 }, (_, i) => p(`Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`)).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

async function xlsx(): Promise<Uint8Array> {
  const X = await import("xlsx");
  const wb = X.utils.book_new();
  const sales = [["Month", "Hanoi", "Saigon", "Da Nang", "Total"]];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (const [i, m] of months.entries()) sales.push([m, String(100 + i * 7), String(180 + i * 11), String(60 + i * 3), String(340 + i * 21)]);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(sales), "Sales");
  const big = Array.from({ length: 5000 }, (_, r) => Array.from({ length: 40 }, (_, c) => (c === 0 ? `Row ${r + 1}` : (r * 31 + c * 17) % 1000)));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(big), "Big sheet");
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([]), "Empty");
  return new Uint8Array(X.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

async function pptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  const P = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const slides = [
    ["Kybl phase 2", ["Documents open in the app", "Editing with conflict checks"]],
    ["What ships", ["Text and code editor", "Markdown with preview", "CSV, Excel and Word viewers", "Slide outline"]],
    ["", ["A slide without a title", "Second line"]],
  ] as const;
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
  );
  slides.forEach(([title, lines], i) => {
    const titleSp = title ? `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` : "";
    const bodySp = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${lines.map((l, j) => `<a:p><a:pPr lvl="${j > 1 ? 1 : 0}"/><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>${titleSp}${bodySp}</p:spTree></p:cSld></p:sld>`);
  });
  return zip.generateAsync({ type: "uint8array" });
}

function image(): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#ffc93c"/><stop offset="1" stop-color="#e0243c"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><circle cx="800" cy="500" r="300" fill="#fff" opacity=".35"/><text x="800" y="530" font-family="sans-serif" font-size="96" text-anchor="middle" fill="#1e1a1a">Kybl</text><script>alert("svg scripts never run in img")</script></svg>`;
  return enc(svg);
}

async function sample(key: string): Promise<Stored> {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  let bytes: Uint8Array;
  let type = "text/plain";
  switch (ext) {
    case "md":
      bytes = enc(MARKDOWN);
      type = "text/markdown";
      break;
    case "json":
      bytes = enc(JSON_TEXT);
      type = "application/json";
      break;
    case "csv":
      bytes = enc(csv(key.includes("big") ? 200_000 : 800));
      type = "text/csv";
      break;
    case "ts":
      bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(CODE.replace(/\n/g, "\r\n"))]);
      type = "text/typescript";
      break;
    case "yml":
    case "yaml":
      bytes = enc(YAML);
      type = "application/yaml";
      break;
    case "docx":
      bytes = await docx();
      type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      break;
    case "xlsx":
      bytes = await xlsx();
      type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      break;
    case "pptx":
      bytes = await pptx();
      type = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      break;
    case "svg":
    case "png":
    case "jpg":
      bytes = image();
      type = "image/svg+xml";
      break;
    case "log":
      // Latin-1 bytes that aren't valid UTF-8: opens read-only
      bytes = new Uint8Array([...enc("caf"), 0xe9, ...enc(" cr"), 0xe8, ...enc("me br"), 0xfb, ...enc("l"), 0xe9, 0x0a]);
      break;
    default:
      bytes = enc(`Notes for ${key}\n\nPlain text, editable.\n`);
  }
  return { bytes, meta: meta(bytes, type) };
}

function frame(m: DocMeta, bytes: Uint8Array): ArrayBuffer {
  const json = enc(JSON.stringify(m));
  const out = new Uint8Array(4 + json.length + bytes.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(bytes, 4 + json.length);
  return out.buffer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pretends someone else saved `key` (for trying the conflict dialog). */
export function touch(key: string) {
  const f = files.get(key);
  if (f) files.set(key, { bytes: f.bytes, meta: { ...meta(f.bytes, f.meta.contentType ?? "text/plain"), size: f.bytes.length } });
}
/** Pretends someone deleted `key`. */
export function remove(key: string) {
  files.set(key, { bytes: new Uint8Array(), meta: { etag: null, size: -1, modified: null, contentType: null, version: null } });
}

export async function handleDoc(cmd: string, args: unknown, options?: { headers?: Record<string, string> }): Promise<unknown> {
  await sleep(250);
  if (cmd === "doc_open") {
    const a = args as { path: string; maxBytes: number };
    let f = files.get(a.path);
    if (!f || f.meta.size < 0) {
      f = await sample(a.path);
      files.set(a.path, f);
    }
    if (f.bytes.length > a.maxBytes) throw "This file is too large to open here. Download it to open it in another app.";
    return frame(f.meta, f.bytes);
  }
  // doc_save
  const h = options?.headers ?? {};
  const key = decodeURIComponent(h["x-kybl-path"] ?? "");
  const expect = JSON.parse(decodeURIComponent(h["x-kybl-expect"] ?? "{}")) as DocPrecondition;
  const bytes = new Uint8Array(args as Uint8Array);
  const now = files.get(key);
  const exists = !!now && now.meta.size >= 0;
  const conflict = (m: DocMeta | null) => {
    throw `CONFLICT\n\n${JSON.stringify(m)}`;
  };
  if (expect.kind === "match" && (!exists || now!.meta.etag !== expect.etag)) conflict(exists ? now!.meta : null);
  if (expect.kind === "absent" && exists) conflict(now!.meta);
  if (key.includes("readonly-bucket")) throw "Access denied. This key isn't allowed to do that.\n\nAccessDenied: s3:PutObject";
  const contentType = (exists ? now!.meta.contentType : null) ?? "text/plain";
  const m = meta(bytes, contentType);
  files.set(key, { bytes, meta: m });
  console.info(`[devMock] saved ${key}: ${bytes.length} bytes`, new TextDecoder().decode(bytes.slice(0, 120)));
  return m;
}
