/**
 * Excel and OpenDocument spreadsheets, read-only: every sheet as a tab, cells as their formatted
 * values. SheetJS comes from its official CDN build (0.20.x): the npm copy is years old and has a
 * known prototype-pollution bug. Formulas are never evaluated; their cached results are shown.
 * The workbook is parsed in a worker (xlsx.worker.ts), so a big one doesn't freeze the window.
 */
import { useEffect, useRef, useState } from "react";
import { DataGrid } from "./DataGrid";
import { columnCount, cutNote } from "./gridShape";
import { Note } from "./ui";
import type { XlsxRequest, XlsxResponse } from "./xlsx.worker";
import type { ViewerProps } from "./types";

type Sheet = { name: string; i: number };
type Rows = { rows: string[][]; cut: { rows: number; cols: number } | null };

export default function XlsxView({ name, bytes, mode }: ViewerProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [error, setError] = useState(false);
  const [sheet, setSheet] = useState(0);
  const [data, setData] = useState<(Rows & { sheet: number }) | null>(null);
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const waiting = useRef(new Map<number, (m: XlsxResponse) => void>());

  const ask = (req: { open: Uint8Array } | { sheet: string }, then: (m: XlsxResponse) => void) => {
    const w = worker.current;
    if (!w) return;
    const id = ++seq.current;
    waiting.current.set(id, then);
    w.postMessage({ ...req, id } satisfies XlsxRequest);
  };

  useEffect(() => {
    setSheets(null);
    setData(null);
    setError(false);
    setSheet(0);
    const w = new Worker(new URL("./xlsx.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    const pending = waiting.current;
    w.onmessage = (ev: MessageEvent<XlsxResponse>) => {
      const then = pending.get(ev.data.id);
      pending.delete(ev.data.id);
      then?.(ev.data);
    };
    w.onerror = () => setError(true);
    ask({ open: bytes }, (m) => {
      if (!("sheets" in m)) return setError(true);
      const all = m.sheets.map((s, i) => ({ ...s, i }));
      const shown = all.filter((s) => !s.hidden);
      setSheets(shown.length ? shown : all);
    });
    return () => {
      w.terminate();
      if (worker.current === w) worker.current = null;
      pending.clear();
    };
  }, [bytes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = sheets?.[sheet];
    if (!s) return;
    let live = true;
    ask({ sheet: s.name }, (m) => {
      if (!live) return;
      if ("rows" in m) setData({ rows: m.rows, cut: m.cut, sheet });
      else setError(true);
    });
    return () => {
      live = false;
    };
  }, [sheets, sheet]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Note icon="alert">This spreadsheet couldn't be read. It may be damaged or password-protected.</Note>;
  if (!sheets) return <Note spinner>Reading the spreadsheet…</Note>;
  if (!sheets.length) return <Note icon="text">This workbook has no sheets.</Note>;
  const rows = data?.sheet === sheet ? data : null;
  const cut = rows?.cut;
  const note = rows && cut ? cutNote({ rows: rows.rows.length, cols: columnCount(rows.rows) }, cut) : undefined;
  return (
    <div className="dv-viewer dv-xlsx">
      {!rows ? (
        <Note spinner>Reading the sheet…</Note>
      ) : rows.rows.length ? (
        <DataGrid key={sheet} label={`${name}, ${sheets[sheet]?.name}`} rows={rows.rows} note={note} />
      ) : (
        <Note icon="text">This sheet is empty.</Note>
      )}
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
