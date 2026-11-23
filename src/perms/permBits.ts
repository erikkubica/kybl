/** Pure: the permission grid's bits and their "644" text (no imports, so `node --test` can load it). */

/** One box per bit, owner read first; null: mixed in the selection (or not known). */
export type Bit = boolean | null;

export const bitOf = (i: number) => 1 << (8 - i);

/** The grid for a selection of modes (undefined: not known). */
export function startBits(modes: (number | undefined)[]): Bit[] {
  return Array.from({ length: 9 }, (_, i) => {
    const on = modes.map((m) => (m === undefined ? null : (m & bitOf(i)) !== 0));
    if (on.some((v) => v === null)) return null;
    return on.every(Boolean) ? true : on.some(Boolean) ? null : false;
  });
}

/** "644", with an "x" where a triad has a mixed box. */
export const digits = (bits: Bit[]) =>
  [0, 1, 2]
    .map((t) => {
      const tri = bits.slice(t * 3, t * 3 + 3);
      return tri.some((b) => b === null) ? "x" : String(tri.reduce((n, b, j) => n + (b ? 4 >> j : 0), 0));
    })
    .join("");

/**
 * The grid for typed text ("6x4"), or null while it isn't three digits. An "x" means "as each item
 * has it": that triad goes back to the selection's own bits (`initial`), not to whatever was typed
 * before.
 */
export function bitsFromText(text: string, initial: Bit[]): Bit[] | null {
  if (!/^[0-7x]{3}$/i.test(text)) return null;
  return [...text.toLowerCase()].flatMap((d, t) => (d === "x" ? initial.slice(t * 3, t * 3 + 3) : [0, 1, 2].map((j) => (Number(d) & (4 >> j)) !== 0)));
}
