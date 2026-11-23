/**
 * A small fuzzy matcher for the command palette, after fzy: the query's characters must appear in
 * order; runs of them, and characters at the start of a word (after a space, "/", "-", "_", ".",
 * or a capital in camelCase) score higher, and gaps cost a little. Returns where they matched,
 * for highlighting. Allocation-light: one pair of rows reused between calls.
 */

const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const CONSECUTIVE = 1.0;
const BONUS_SLASH = 0.9;
const BONUS_WORD = 0.8;
const BONUS_CAPITAL = 0.7;
const BONUS_DOT = 0.6;
/** longer than this, a text is matched by substring only (the DP would be wasteful) */
const MAX_LEN = 256;

export type Match = { score: number; hits: number[] };

function bonusAt(text: string, i: number): number {
  if (i === 0) return BONUS_SLASH;
  const prev = text[i - 1];
  if (prev === "/" || prev === "\\") return BONUS_SLASH;
  if (prev === " " || prev === "-" || prev === "_" || prev === "·" || prev === "(" || prev === "@" || prev === ":") return BONUS_WORD;
  if (prev === ".") return BONUS_DOT;
  const c = text[i];
  if (c >= "A" && c <= "Z" && prev >= "a" && prev <= "z") return BONUS_CAPITAL;
  return 0;
}

/**
 * Scores `text` against `q` (already lowercased, no spaces), or null when it doesn't match.
 * Higher is better; a whole-text match gets a bonus so "settings" beats "settings page".
 */
export function fuzzy(q: string, text: string): Match | null {
  const n = q.length;
  const m = text.length;
  if (!n) return { score: 0, hits: [] };
  if (n > m) return null;
  const low = text.toLowerCase();
  // quick reject: every character in order
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (low.charCodeAt(j) === q.charCodeAt(k)) k++;
  if (k < n) return null;
  if (m > MAX_LEN) {
    const i = low.indexOf(q);
    if (i < 0) return { score: -1, hits: [] };
    return { score: n * CONSECUTIVE * 0.5 + bonusAt(text, i), hits: Array.from({ length: n }, (_, x) => i + x) };
  }
  if (n === m) return { score: n * CONSECUTIVE + 2, hits: Array.from({ length: n }, (_, x) => x) };

  // D[i][j]: best score with q[i] matched at text[j], ending a run; M[i][j]: best for q[0..i] in text[0..j]
  const D = new Float64Array(n * m);
  const M = new Float64Array(n * m);
  const bonus = new Float64Array(m);
  for (let j = 0; j < m; j++) bonus[j] = bonusAt(text, j);
  for (let i = 0; i < n; i++) {
    let prev = -Infinity;
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
    const qc = q.charCodeAt(i);
    for (let j = 0; j < m; j++) {
      const at = i * m + j;
      if (qc === low.charCodeAt(j)) {
        let s = -Infinity;
        if (i === 0) s = j * GAP_LEADING + bonus[j];
        else if (j > 0) s = Math.max(M[at - m - 1] + bonus[j], D[at - m - 1] + CONSECUTIVE);
        D[at] = s;
        prev = M[at] = Math.max(s, prev + gap);
      } else {
        D[at] = -Infinity;
        prev = M[at] = prev + gap;
      }
    }
  }
  const score = M[n * m - 1];
  if (score === -Infinity) return null;
  // walk back for the positions
  const hits = new Array<number>(n);
  let matchRequired = false;
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const at = i * m + j;
      if (D[at] !== -Infinity && (matchRequired || D[at] === M[at])) {
        matchRequired = i > 0 && j > 0 && M[at] === D[at - m - 1] + CONSECUTIVE;
        hits[i] = j--;
        break;
      }
    }
  }
  return { score, hits };
}

/** `w` as a whole in `text` (lowercase): more at the start of a word. Null when it isn't there. */
function contains(w: string, text: string): number | null {
  const i = text.indexOf(w);
  if (i < 0) return null;
  return w.length * 0.5 + (i === 0 || /[\s/_\-.@·:(›]/.test(text[i - 1]) ? 0.6 : 0);
}

/**
 * Matches a query of one or more words: each word must match the title (fuzzily) or, for less,
 * be found whole in `extra` (group, host, keywords: fuzzy there finds too much). Hits are the
 * title's only.
 */
export function matchWords(words: string[], title: string, extra?: string): Match | null {
  let score = 0;
  const hits: number[] = [];
  const low = extra?.toLowerCase();
  for (const w of words) {
    const t = fuzzy(w, title);
    const e = low ? contains(w, low) : null;
    if (!t && e == null) return null;
    // a word found in the title wins unless it only scraped through there
    if (t && (e == null || t.score >= e - 0.5)) {
      score += t.score;
      hits.push(...t.hits);
    } else score += e! - 0.6;
  }
  return { score, hits };
}

/** Splits text into plain and highlighted runs by the hit positions. */
export function runs(text: string, hits: number[]): { text: string; hit: boolean }[] {
  if (!hits.length) return [{ text, hit: false }];
  const set = new Set(hits);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
