/** Which files Kybl's own editor edits (kept apart so the info column can ask without loading the edit flow). */
import { viewerFor } from "../../viewers/lib/registry";
import type { Entry } from "../../core/types";

/** Text, code, JSON, Markdown and CSV, not Google Docs. */
export function editableInKybl(e: Entry): boolean {
  if (e.kind !== "file" || e.native) return false;
  const v = viewerFor(e.name, e.mime ?? null);
  return !!v && v.editMaxBytes > 0;
}
