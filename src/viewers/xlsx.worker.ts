/**
 * Reads Excel and OpenDocument spreadsheets off the main thread (a 30 MB workbook takes seconds
 * to parse). The workbook stays here; the page asks for one sheet's rows at a time.
 */
import { read, utils, type WorkBook } from "xlsx";
import { sheetCut, usedExtent } from "./gridShape";
import { refusalKind } from "./refused";
import { plainForSheetJS } from "./zipCheck";

export type XlsxRequest = { id: number; open: Uint8Array } | { id: number; sheet: string };
export type XlsxResponse =
  | { id: number; sheets: { name: string; hidden: boolean }[] }
  | { id: number; rows: string[][]; cut: { rows: number; cols: number } | null }
  | { id: number; error: true; refused?: "refused" | "damaged" };

let book: WorkBook | null = null;

const post = (m: XlsxResponse) => (self as unknown as Worker).postMessage(m);

/** Starts like an old Office compound file (a password-protected workbook, an .xls). */
function compound(b: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return b.length >= 8 && magic.every((m, i) => b[i] === m);
}

self.onmessage = async (ev: MessageEvent<XlsxRequest>) => {
  const req = ev.data;
  try {
    if ("open" in req) {
      book = null;
      // a few MB can inflate to GBs, and a worker out of memory takes the whole web view with it.
      // SheetJS unzips with its own code and reads different parts than JSZip does (entries that
      // claim 0 bytes, directory entries, data descriptors, duplicates), so it never sees the
      // uploaded zip: every part is inflated here under a cap and SheetJS gets a plain zip
      // rebuilt from those bytes. This holds for .xlsx and .ods alike; an old .xls isn't a zip.
      const plain = await plainForSheetJS(req.open);
      let bytes: Uint8Array;
      if (!("refused" in plain)) bytes = plain.bytes;
      else if (plain.refused !== "not a zip") return post({ id: req.id, error: true, refused: refusalKind(plain.refused, req.open) });
      // not a zip: a password-protected workbook or an old .xls is a compound file, which SheetJS
      // reads with code a small file can blow up to GBs (R9 S-4): left as "couldn't be read"
      // (it says password-protected). Plain text saved as .xlsx (CSV, HTML from a web export)
      // costs no more than its own size, so it still previews.
      else if (compound(req.open)) return post({ id: req.id, error: true });
      else bytes = req.open;
      book = read(bytes, { type: "array", dense: true, cellHTML: false, cellStyles: false, bookVBA: false });
      const b = book;
      post({ id: req.id, sheets: b.SheetNames.map((name, i) => ({ name, hidden: !!b.Workbook?.Sheets?.[i]?.Hidden })) });
      return;
    }
    const ws = book?.Sheets[req.sheet];
    if (!ws || !ws["!ref"]) return post({ id: req.id, rows: [], cut: null });
    // only what holds values, from A1 (so column letters and row numbers match Excel), and no
    // more than the caps: a declared range can run to XFD1048576
    const declared = utils.decode_range(ws["!ref"]);
    const used = ws["!data"] ? usedExtent(ws["!data"] as Parameters<typeof usedExtent>[0]) : declared.e;
    const last = { r: Math.min(used.r, declared.e.r), c: Math.min(used.c, declared.e.c) };
    if (last.r < 0 || last.c < 0) return post({ id: req.id, rows: [], cut: null });
    const e = sheetCut(last);
    const rows = utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "", blankrows: true, range: { s: { r: 0, c: 0 }, e } });
    const cut = e.r < last.r || e.c < last.c ? { rows: last.r + 1, cols: last.c + 1 } : null;
    post({ id: req.id, rows, cut });
  } catch {
    post({ id: req.id, error: true });
  }
};
