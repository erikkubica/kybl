/**
 * Google Docs, Sheets and Slides have no bytes of their own: Drive exports them. The backend
 * reads `key + "." + ext` as that export (the first one is the Office format), so a download of
 * "Budget 2026" becomes "Budget 2026.xlsx", and "Download as PDF" asks for "Budget 2026.pdf".
 * Google Forms and Sites list with no exports at all and can't be downloaded.
 */
import type { Entry } from "../types";

/** A native Google file, as the export it downloads as (`ext`: the first export when omitted). Null: no export. */
export function asExport(e: Entry, ext?: string): Entry | null {
  const ex = e.native?.exports;
  if (!ex) return e;
  const pick = ext ? ex.find((x) => x.ext === ext) : ex[0];
  if (!pick) return null;
  return { ...e, key: `${e.key}.${pick.ext}`, name: `${e.name}.${pick.ext}`, native: undefined };
}

/** The files of a selection as what they download as; `skipped` counts the ones Drive can't export. */
export function exportable(list: Entry[]): { list: Entry[]; skipped: number } {
  const out: Entry[] = [];
  let skipped = 0;
  for (const e of list) {
    const x = asExport(e);
    if (x) out.push(x);
    else skipped++;
  }
  return { list: out, skipped };
}

export const NO_EXPORT = "Google Forms and Sites can't be downloaded. Open them in Google Drive instead.";
