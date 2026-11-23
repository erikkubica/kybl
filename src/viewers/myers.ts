/**
 * A compact Myers diff (E. Myers, "An O(ND) Difference Algorithm", 1986), linear-space version:
 * the middle snake splits the problem in two, as in diff-match-patch's bisect. Works on arrays of
 * token ids (lines or words), after trimming the common start and end. A deadline keeps huge,
 * very different inputs responsive: past it, what's left is reported as removed + added (still a
 * correct diff, just not a minimal one).
 */

/** 0: same, 1: only in a (removed), 2: only in b (added). */
export type Op = 0 | 1 | 2;
/** `n` tokens from a[a] (same, removed) and/or b[b] (same, added). */
export type Edit = { op: Op; a: number; b: number; n: number };

export function diffIds(a: ArrayLike<number>, b: ArrayLike<number>, timeoutMs = 2000): Edit[] {
  const out: Edit[] = [];
  const deadline = performance.now() + timeoutMs;
  const push = (op: Op, ai: number, bi: number, n: number) => {
    if (n <= 0) return;
    const last = out[out.length - 1];
    if (last && last.op === op && last.a + (op === 2 ? 0 : last.n) === ai && last.b + (op === 1 ? 0 : last.n) === bi) last.n += n;
    else out.push({ op, a: ai, b: bi, n });
  };

  const main = (aLo: number, aHi: number, bLo: number, bHi: number) => {
    let pre = 0;
    while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre++;
    push(0, aLo, bLo, pre);
    aLo += pre;
    bLo += pre;
    let suf = 0;
    while (aHi - suf > aLo && bHi - suf > bLo && a[aHi - suf - 1] === b[bHi - suf - 1]) suf++;
    aHi -= suf;
    bHi -= suf;
    if (aLo === aHi) push(2, aLo, bLo, bHi - bLo);
    else if (bLo === bHi) push(1, aLo, bLo, aHi - aLo);
    else bisect(aLo, aHi, bLo, bHi);
    push(0, aHi, bHi, suf);
  };

  const bisect = (aLo: number, aHi: number, bLo: number, bHi: number) => {
    const n = aHi - aLo;
    const m = bHi - bLo;
    const max = Math.ceil((n + m) / 2);
    const off = max;
    const len = 2 * max + 2;
    const v1 = new Int32Array(len).fill(-1);
    const v2 = new Int32Array(len).fill(-1);
    v1[off + 1] = 0;
    v2[off + 1] = 0;
    const delta = n - m;
    const front = (delta & 1) !== 0;
    let k1s = 0;
    let k1e = 0;
    let k2s = 0;
    let k2e = 0;
    for (let d = 0; d < max; d++) {
      if ((d & 15) === 0 && performance.now() > deadline) break;
      for (let k1 = -d + k1s; k1 <= d - k1e; k1 += 2) {
        const i = off + k1;
        let x1 = k1 === -d || (k1 !== d && v1[i - 1] < v1[i + 1]) ? v1[i + 1] : v1[i - 1] + 1;
        let y1 = x1 - k1;
        while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
          x1++;
          y1++;
        }
        v1[i] = x1;
        if (x1 > n) k1e += 2;
        else if (y1 > m) k1s += 2;
        else if (front) {
          const j = off + delta - k1;
          if (j >= 0 && j < len && v2[j] !== -1 && x1 >= n - v2[j]) {
            main(aLo, aLo + x1, bLo, bLo + y1);
            main(aLo + x1, aHi, bLo + y1, bHi);
            return;
          }
        }
      }
      for (let k2 = -d + k2s; k2 <= d - k2e; k2 += 2) {
        const i = off + k2;
        let x2 = k2 === -d || (k2 !== d && v2[i - 1] < v2[i + 1]) ? v2[i + 1] : v2[i - 1] + 1;
        let y2 = x2 - k2;
        while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
          x2++;
          y2++;
        }
        v2[i] = x2;
        if (x2 > n) k2e += 2;
        else if (y2 > m) k2s += 2;
        else if (!front) {
          const j = off + delta - k2;
          if (j >= 0 && j < len && v1[j] !== -1) {
            const x1 = v1[j];
            const y1 = off + x1 - j;
            if (x1 >= n - x2) {
              main(aLo, aLo + x1, bLo, bLo + y1);
              main(aLo + x1, aHi, bLo + y1, bHi);
              return;
            }
          }
        }
      }
    }
    // out of time (or no overlap): all of it changed
    push(1, aLo, bLo, n);
    push(2, aHi, bLo, m);
  };

  main(0, a.length, 0, b.length);
  return out;
}

/** Ids for tokens: equal strings get equal numbers (shared across both sides). */
export function tokenIds(a: string[], b: string[], normalize?: (s: string) => string): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const map = (xs: string[]) => {
    const out = new Int32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const k = normalize ? normalize(xs[i]) : xs[i];
      let id = ids.get(k);
      if (id === undefined) ids.set(k, (id = ids.size));
      out[i] = id;
    }
    return out;
  };
  return [map(a), map(b)];
}

/** Words, runs of spaces and single punctuation marks: what changed-word highlighting compares. */
export function words(line: string): string[] {
  return line.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/** A line split in pieces: `on` marks the changed ones. */
export type Piece = { text: string; on: boolean };

/** Changed-word highlighting of a removed line `a` against its added counterpart `b`. */
export function wordDiff(a: string, b: string): [Piece[], Piece[]] {
  if (a.length > 2000 || b.length > 2000) return [[{ text: a, on: true }], [{ text: b, on: true }]];
  const wa = words(a);
  const wb = words(b);
  const [ia, ib] = tokenIds(wa, wb);
  const left: Piece[] = [];
  const right: Piece[] = [];
  const add = (into: Piece[], text: string, on: boolean) => {
    const last = into[into.length - 1];
    if (last && last.on === on) last.text += text;
    else into.push({ text, on });
  };
  for (const e of diffIds(ia, ib, 50)) {
    if (e.op !== 2) for (let i = 0; i < e.n; i++) add(left, wa[e.a + i], e.op === 1);
    if (e.op !== 1) for (let i = 0; i < e.n; i++) add(right, wb[e.b + i], e.op === 2);
  }
  // mostly different: highlighting every other word helps nobody, mark the whole line
  const changed = (ps: Piece[]) => ps.reduce((s, p) => s + (p.on ? p.text.trim().length : 0), 0);
  if (changed(left) > a.trim().length * 0.7 && changed(right) > b.trim().length * 0.7) return [[{ text: a, on: false }], [{ text: b, on: false }]];
  return [left, right];
}

/** One row of the side-by-side view (an inline view shows the same rows one side after the other). */
export type Row =
  | { t: "same"; a: number; b: number }
  | { t: "del"; a: number }
  | { t: "add"; b: number }
  | { t: "chg"; a: number; b: number };

/** Rows from a line diff: removed and added lines of one change are paired up as changed lines. */
export function toRows(edits: Edit[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (e.op === 0) {
      for (let k = 0; k < e.n; k++) rows.push({ t: "same", a: e.a + k, b: e.b + k });
      continue;
    }
    // a run of removals and additions between two equal runs
    let dels: number[] = [];
    let adds: number[] = [];
    let j = i;
    for (; j < edits.length && edits[j].op !== 0; j++) {
      const x = edits[j];
      for (let k = 0; k < x.n; k++) (x.op === 1 ? dels : adds).push(x.op === 1 ? x.a + k : x.b + k);
    }
    i = j - 1;
    const both = Math.min(dels.length, adds.length);
    for (let k = 0; k < both; k++) rows.push({ t: "chg", a: dels[k], b: adds[k] });
    for (let k = both; k < dels.length; k++) rows.push({ t: "del", a: dels[k] });
    for (let k = both; k < adds.length; k++) rows.push({ t: "add", b: adds[k] });
    dels = [];
    adds = [];
  }
  return rows;
}
