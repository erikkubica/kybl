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
