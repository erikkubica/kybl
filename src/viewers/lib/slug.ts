/**
 * GitHub-style heading ids, so a README's `[Install](#install)` links find their heading: the
 * text in lower case, punctuation dropped, spaces as dashes; a repeated heading gets -1, -2, ...
 */
export function headingSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replace(/ /g, "-");
    let id = base;
    while (seen.has(id)) {
      const n = seen.get(base)! + 1;
      seen.set(base, n);
      id = `${base}-${n}`;
    }
    seen.set(id, 0);
    return id;
  };
}

/** The text of a bit of rendered inline HTML (tags dropped, the common entities decoded). */
export function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e]!);
}
