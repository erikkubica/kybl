/**
 * A read-only spreadsheet grid for CSV and Excel files. Only the rows and columns in view are in
 * the page, so a sheet with a million cells scrolls like one with fifty. Tapping a cell shows its
 * whole value underneath, where it can be selected and copied.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowed } from "../useWindowed";

const ROW = 28;
const NUM_W = 52;
const MIN_W = 56;
const MAX_W = 360;
const OVERSCAN_PX = 400;

/** A, B, …, Z, AA, AB, … */
export function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function DataGrid({ rows, header, firstRowNumber = 1, label }: { rows: string[][]; header?: string[] | null; firstRowNumber?: number; label: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [h, setH] = useState({ left: 0, width: 1200 });

  const cols = useMemo(() => Math.max(header?.length ?? 0, ...rows.slice(0, 2000).map((r) => r.length), 1), [rows, header]);
  // widths from the header and the first few hundred rows
  const widths = useMemo(() => {
    const w = new Array<number>(cols).fill(MIN_W);
    const sample = header ? [header, ...rows.slice(0, 300)] : rows.slice(0, 300);
    for (const r of sample) {
      for (let c = 0; c < cols; c++) {
        const len = (r[c] ?? "").length;
        if (len) w[c] = Math.max(w[c], Math.min(MAX_W, len * 7.9 + 20));
      }
    }
    return w;
  }, [rows, header, cols]);
  const offsets = useMemo(() => {
    const o = [0];
    for (const w of widths) o.push(o[o.length - 1] + w);
    return o;
  }, [widths]);
  const total = offsets[offsets.length - 1];

  const win = useWindowed({ scroller, count: rows.length, rowHeight: ROW, offset: ROW });

  // columns in view, the same way useWindowed does rows
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setH((v) => (v.left === el.scrollLeft && v.width === el.clientWidth ? v : { left: el.scrollLeft, width: el.clientWidth }));
    };
    const on = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", on);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  let c0 = 0;
  while (c0 < cols && offsets[c0 + 1] < h.left - NUM_W - OVERSCAN_PX) c0++;
  let c1 = c0;
  while (c1 < cols && offsets[c1] < h.left + h.width + OVERSCAN_PX) c1++;
  const visibleCols: number[] = [];
  for (let c = c0; c < c1; c++) visibleCols.push(c);
  const padLeft = offsets[c0];
  const padRight = total - offsets[c1];

  const cell = selected ? (rows[selected.r]?.[selected.c] ?? "") : null;

  return (
    <div className="dv-grid-wrap">
      <div className="dv-grid" ref={scroller} role="grid" aria-label={label} aria-rowcount={rows.length} aria-colcount={cols}>
        <div className="dv-grid-inner" style={{ width: NUM_W + total }}>
          <div className="dv-grid-row dv-grid-head" role="row" style={{ height: ROW }}>
            <div className="dv-grid-num" />
            <div style={{ width: padLeft, flex: "none" }} />
            {visibleCols.map((c) => (
              <div key={c} className="dv-grid-cell" role="columnheader" style={{ width: widths[c] }} title={header?.[c]}>
                {header ? (header[c] ?? "") : columnName(c)}
              </div>
            ))}
            <div style={{ width: padRight, flex: "none" }} />
          </div>
          <div style={{ height: win.padTop }} />
          {rows.slice(win.start, win.end).map((r, i) => {
            const ri = win.start + i;
            return (
              <div key={ri} className="dv-grid-row" role="row" style={{ height: ROW }}>
                <div className="dv-grid-num">{ri + firstRowNumber}</div>
                <div style={{ width: padLeft, flex: "none" }} />
                {visibleCols.map((c) => (
                  <div
                    key={c}
                    role="gridcell"
                    className={`dv-grid-cell ${selected?.r === ri && selected.c === c ? "sel" : ""} ${/^-?[\d.,]+%?$/.test(r[c] ?? "") ? "num" : ""}`}
                    style={{ width: widths[c] }}
                    onClick={() => setSelected({ r: ri, c })}
                  >
                    {r[c] ?? ""}
                  </div>
                ))}
                <div style={{ width: padRight, flex: "none" }} />
              </div>
            );
          })}
          <div style={{ height: win.padBottom }} />
        </div>
      </div>
      <div className="dv-grid-foot">
        {selected ? (
          <>
            <span className="dv-grid-ref">
              {header ? (header[selected.c] || columnName(selected.c)) : columnName(selected.c)}
              {header ? ` · row ${selected.r + firstRowNumber}` : selected.r + firstRowNumber}
            </span>
            <span className="dv-grid-value selectable">{cell || "Empty"}</span>
          </>
        ) : (
          <span className="dv-grid-hint">
            {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"} · {cols.toLocaleString()} {cols === 1 ? "column" : "columns"}
          </span>
        )}
      </div>
    </div>
  );
}
