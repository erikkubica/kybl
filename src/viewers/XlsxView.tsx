/**
 * Excel and OpenDocument spreadsheets, read-only: every sheet as a tab, cells as their formatted
 * values. SheetJS comes from its official CDN build (0.20.x): the npm copy is years old and has a
 * known prototype-pollution bug. Formulas are never evaluated; their cached results are shown.
 */
import { useEffect, useMemo, useState } from "react";
import { read, utils, type WorkBook } from "xlsx";
import { DataGrid } from "./DataGrid";
import { Note } from "./ui";
import type { ViewerProps } from "./types";

export default function XlsxView({ name, bytes, mode }: ViewerProps) {
  const [book, setBook] = useState<WorkBook | null>(null);
  const [error, setError] = useState(false);
  const [sheet, setSheet] = useState(0);

  useEffect(() => {
    // parsing a big workbook takes a moment; let the spinner paint first
    const t = setTimeout(() => {
      try {
        setBook(read(bytes, { type: "array", dense: true, cellHTML: false, cellStyles: false, bookVBA: false }));
      } catch {
        setError(true);
      }
    }, 30);
    return () => clearTimeout(t);
  }, [bytes]);

  const sheets = useMemo(() => {
    if (!book) return [];
    const all = book.SheetNames.map((n, i) => ({ name: n, i, hidden: !!book.Workbook?.Sheets?.[i]?.Hidden }));
    const shown = all.filter((s) => !s.hidden);
    return shown.length ? shown : all;
  }, [book]);

  const rows = useMemo(() => {
    const s = sheets[sheet];
    const ws = s && book?.Sheets[s.name];
    if (!ws || !ws["!ref"]) return [];
    const range = utils.decode_range(ws["!ref"]);
    // from A1, so column letters and row numbers match what Excel shows
    return utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "", blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } });
  }, [book, sheets, sheet]);

  if (error) return <Note icon="alert">This spreadsheet couldn't be read. It may be damaged or password-protected.</Note>;
  if (!book) return <Note spinner>Reading the spreadsheet…</Note>;
  return (
    <div className="dv-viewer dv-xlsx">
      {rows.length ? <DataGrid key={sheet} label={`${name}, ${sheets[sheet]?.name}`} rows={rows} /> : <Note icon="text">This sheet is empty.</Note>}
      {(sheets.length > 1 || mode === "full") && (
        <div className="dv-sheets" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button key={s.i} role="tab" aria-selected={i === sheet} className={i === sheet ? "on" : ""} onClick={() => setSheet(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
