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
import { REFUSED_TEXT } from "./refused";
import type { XlsxRequest, XlsxResponse } from "./xlsx.worker";
import type { ViewerProps } from "./types";

/** How long the worker may take for one request before it is ended. */
const WORKER_LIMIT_MS = 15_000;

type Sheet = { name: string; i: number };
type Rows = { rows: string[][]; cut: { rows: number; cols: number } | null };

export default function XlsxView({ name, bytes, mode }: ViewerProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [error, setError] = useState<"refused" | "failed" | null>(null);
  const [sheet, setSheet] = useState(0);
  const [data, setData] = useState<(Rows & { sheet: number }) | null>(null);
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const waiting = useRef(new Map<number, (m: XlsxResponse) => void>());

  const timers = useRef(new Set<number>());

  const ask = (req: { open: Uint8Array } | { sheet: string }, then: (m: XlsxResponse) => void) => {
    const w = worker.current;
    if (!w) return;
    const id = ++seq.current;
    // a file built to keep SheetJS busy for minutes would leave the spinner up for ever: past
    // the limit the worker is ended and the file is called too big (R9 S-3)
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      if (worker.current !== w) return;
      w.terminate();
      worker.current = null;
      waiting.current.clear();
      setError("refused");
    }, WORKER_LIMIT_MS);
    timers.current.add(timer);
    waiting.current.set(id, (m) => {
      window.clearTimeout(timer);
      timers.current.delete(timer);
      then(m);
    });
    w.postMessage({ ...req, id } satisfies XlsxRequest);
  };

  useEffect(() => {
    setSheets(null);
    setData(null);
    setError(null);
    setSheet(0);
    const w = new Worker(new URL("./xlsx.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    const pending = waiting.current;
    w.onmessage = (ev: MessageEvent<XlsxResponse>) => {
      const then = pending.get(ev.data.id);
      pending.delete(ev.data.id);
      then?.(ev.data);
    };
    w.onerror = () => setError("failed");
    ask({ open: bytes }, (m) => {
      if (!("sheets" in m)) return setError("refused" in m && m.refused ? "refused" : "failed");
      const all = m.sheets.map((s, i) => ({ ...s, i }));
      const shown = all.filter((s) => !s.hidden);
      setSheets(shown.length ? shown : all);
    });
    const running = timers.current;
    return () => {
      w.terminate();
      if (worker.current === w) worker.current = null;
      pending.clear();
      running.forEach((t) => window.clearTimeout(t));
      running.clear();
    };
  }, [bytes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = sheets?.[sheet];
    if (!s) return;
    let live = true;
    ask({ sheet: s.name }, (m) => {
      if (!live) return;
      if ("rows" in m) setData({ rows: m.rows, cut: m.cut, sheet });
      else setError("failed");
    });
    return () => {
      live = false;
    };
  }, [sheets, sheet]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Note icon="alert">{error === "refused" ? REFUSED_TEXT : "This spreadsheet couldn't be read. It may be damaged or password-protected."}</Note>;
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
