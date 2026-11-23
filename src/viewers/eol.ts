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
