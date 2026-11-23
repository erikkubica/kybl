/**
 * Which tiles of the grid view a rubber-band rectangle touches. The columns share the row's width
 * (`repeat(auto-fill, minmax(…, 1fr))`), so their width comes from the laid-out tracks, not the
 * tile size setting.
 */
import type { Box } from "./listNav";

export type GridGeometry = {
  cols: number;
  /** a column's drawn width, px */
  colW: number;
  colGap: number;
  /** a row's pitch (card height and row gap), px */
  rowH: number;
  cardH: number;
  /** the grid's padding: where the first tile starts */
  top: number;
  left: number;
};

/** The indexes of the tiles box `b` overlaps, row by row, out of `count`. */
export function gridHits(b: Box, g: GridGeometry, count: number): number[] {
  const out: number[] = [];
  if (g.rowH <= 0 || g.cols < 1) return out;
  const pitchX = g.colW + g.colGap;
  const r0 = Math.max(0, Math.floor((b.y0 - g.top) / g.rowH));
  const r1 = Math.floor((b.y1 - g.top) / g.rowH);
  for (let r = r0; r <= r1; r++) {
    const top = g.top + r * g.rowH;
    if (b.y1 < top || b.y0 > top + g.cardH) continue;
    for (let c = 0; c < g.cols; c++) {
      const left = g.left + c * pitchX;
      if (b.x1 < left || b.x0 > left + g.colW) continue;
      const i = r * g.cols + c;
      if (i < count) out.push(i);
    }
  }
  return out;
}

/** The first column's width from a resolved `grid-template-columns` ("146.4px 146.4px …"). */
export function trackWidth(template: string, fallback: number): number {
  const w = parseFloat(template.split(" ")[0] ?? "");
  return Number.isFinite(w) && w > 0 ? w : fallback;
}

/**
 * An arrow Up / Down step of `cols` (a grid row) from item `cur` out of `count` that has nowhere
 * to go, so the cursor stays put (as in Finder) instead of sliding to the first or last item:
 * up from the first row, or down from the last. Down into a shorter last row still lands on its
 * last item.
 */
export function rowStepBlocked(cur: number, delta: number, cols: number, count: number): boolean {
  if (cols < 2 || cur < 0 || Math.abs(delta) !== cols) return false;
  if (delta < 0) return cur + delta < 0;
  return Math.floor(cur / cols) >= Math.floor((count - 1) / cols);
}
