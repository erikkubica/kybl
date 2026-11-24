/**
 * Reads Excel and OpenDocument spreadsheets off the main thread (a 30 MB workbook takes seconds
 * to parse). The workbook stays here; the page asks for one sheet's rows at a time.
 */
import { read, utils, type WorkBook } from "xlsx";
import { sheetCut, usedExtent } from "./gridShape";
import { zipTooBig } from "./zipCheck";

export type XlsxRequest = { id: number; open: Uint8Array } | { id: number; sheet: string };
export type XlsxResponse =
  | { id: number; sheets: { name: string; hidden: boolean }[] }
  | { id: number; rows: string[][]; cut: { rows: number; cols: number } | null }
  | { id: number; error: true };

let book: WorkBook | null = null;

const post = (m: XlsxResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<XlsxRequest>) => {
  const req = ev.data;
  try {
    if ("open" in req) {
      book = null;
      // a few MB can inflate to GBs, and a worker out of memory takes the whole web view with it:
      // refused before SheetJS inflates anything (it even allocates what a part's header claims).
      // SheetJS unzips with its own code, so this check inflates every part once through JSZip with
      // a cap, and only a plain zip layout (where both readers see the same parts) is let through.
      if (await zipTooBig(req.open)) return post({ id: req.id, error: true });
      book = read(req.open, { type: "array", dense: true, cellHTML: false, cellStyles: false, bookVBA: false });
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
