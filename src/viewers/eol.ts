/** Line endings, for Compare (DiffView). */
export type Eol = "CRLF" | "CR" | "LF";

export const eolOf = (t: string): Eol | null => (t.includes("\r\n") ? "CRLF" : t.includes("\r") ? "CR" : t.includes("\n") ? "LF" : null);

const endsWithBreak = (t: string) => /[\r\n]$/.test(t);

/** Why two texts with the same lines aren't the same text (spaces aside). */
export function eolDifference(a: string, b: string): string {
  const [ea, eb] = [eolOf(a), eolOf(b)];
  if (ea && eb && ea !== eb) return `They differ only in line endings (${ea} and ${eb}).`;
  if (endsWithBreak(a) !== endsWithBreak(b)) return "One ends with a line break and the other doesn't.";
  return "They differ only in how lines end.";
}

/**
 * The note under "No differences" when the texts aren't identical. `a` / `b` are their lines
 * (without line breaks). With whitespace ignored the lines may still differ in spaces; when they
 * don't, the line endings are the real reason.
 */
export function noDifferenceNote(ta: string, tb: string, a: readonly string[], b: readonly string[]): string {
  const sameLines = a.length === b.length && a.every((l, i) => l === b[i]);
  if (sameLines) return eolDifference(ta, tb);
  const [ea, eb] = [eolOf(ta), eolOf(tb)];
  if ((ea && eb && ea !== eb) || endsWithBreak(ta) !== endsWithBreak(tb)) return "They differ only in spaces, tabs and line endings.";
  return "They differ only in spaces and tabs.";
}
