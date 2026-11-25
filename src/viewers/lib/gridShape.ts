/** Pure helpers for the spreadsheet grid (DataGrid) and the Excel reader (xlsx.worker). */

/** The widest row (or the header), at least 1. A plain loop: no spread of a million arguments. */
export function columnCount(rows: readonly (readonly unknown[])[], header?: readonly unknown[] | null): number {
  let n = Math.max(header?.length ?? 0, 1);
  for (const r of rows) if (r.length > n) n = r.length;
  return n;
}

type DenseCell = { t?: string; v?: unknown; w?: string } | null | undefined;

/**
 * The last row and column that hold a value, in a dense SheetJS sheet's `!data` (-1 when none).
 * A sheet's declared range (`!ref`) can run far past its data (a styled column, an export that
 * touched XFD1048576); this is what is really there.
 */
export function usedExtent(data: readonly (readonly DenseCell[] | null | undefined)[] | undefined): { r: number; c: number } {
  let r = -1;
  let c = -1;
  if (!data) return { r, c };
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;
    for (let j = row.length - 1; j >= 0; j--) {
      const cell = row[j];
      if (!cell || cell.t === "z" || ((cell.v === undefined || cell.v === "") && !cell.w)) continue;
      r = i;
      if (j > c) c = j;
      break;
    }
  }
  return { r, c };
}

/** At most this many rows, columns and cells of a sheet are sent to the page. */
export const XLSX_MAX_ROWS = 200_000;
export const XLSX_MAX_COLS = 1_000;
export const XLSX_MAX_CELLS = 2_000_000;

/**
 * The last row and column to read of a sheet whose data ends at `last`: columns capped first,
 * then rows cut so the total stays under the cell cap (each cell is one string in the worker,
 * cloned again to the page, so 200k x 1,000 would be 200M strings).
 */
export function sheetCut(last: { r: number; c: number }): { r: number; c: number } {
  const c = Math.min(last.c, XLSX_MAX_COLS - 1);
  const rowsFit = Math.max(1, Math.floor(XLSX_MAX_CELLS / (c + 1)));
  return { r: Math.min(last.r, XLSX_MAX_ROWS - 1, rowsFit - 1), c };
}

/** The "only the first …" note for a cut sheet, naming only the axes that were cut. */
export function cutNote(shown: { rows: number; cols: number }, total: { rows: number; cols: number } | null): string | undefined {
  if (!total) return undefined;
  const parts: string[] = [];
  if (total.rows > shown.rows) parts.push(`${shown.rows.toLocaleString()} of ${total.rows.toLocaleString()} rows`);
  if (total.cols > shown.cols) parts.push(`${shown.cols.toLocaleString()} of ${total.cols.toLocaleString()} columns`);
  return parts.length ? `only the first ${parts.join(" and ")}` : undefined;
}
