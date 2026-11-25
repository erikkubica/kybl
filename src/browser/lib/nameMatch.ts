/**
 * How the filter and a name search match a name, as the backend does (storage/name_match.rs):
 * part of it, ignoring case unless `caseSensitive`; with `regex`, a regular expression. A pattern
 * that doesn't compile matches nothing.
 */
export function nameMatcher(query: string, caseSensitive: boolean, regex: boolean): (name: string) => boolean {
  if (regex) {
    try {
      const re = new RegExp(query, caseSensitive ? "u" : "iu");
      return (name) => re.test(name);
    } catch {
      return () => false;
    }
  }
  if (caseSensitive) return (name) => name.includes(query);
  const needle = query.toLowerCase();
  return (name) => name.toLowerCase().includes(needle);
}

/** Why `query` isn't a usable regular expression (null when it is, or when regex is off). */
export function regexProblem(query: string, regex: boolean): string | null {
  if (!regex || !query) return null;
  try {
    new RegExp(query, "u");
    return null;
  } catch (e) {
    // "Invalid regular expression: /(bad/u: Unterminated group" → "Unterminated group"
    return e instanceof Error ? e.message.replace(/^Invalid regular expression: (\/.*\/[a-z]*: )?/, "") : String(e);
  }
}
