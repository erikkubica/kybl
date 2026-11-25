import { EditorSheet } from "../../edit/components/EditorSheet";
import type { ReactNode } from "react";
import type { SaveRule } from "../../edit/lib/editStore";

/** The document editor full-window ("Open"), or in a sheet ("Edit in Kybl", src/edit). */
export function DocShell({ sheet, rule, children }: { sheet: boolean; rule?: SaveRule; children: ReactNode }) {
  return sheet ? <EditorSheet rule={rule}>{children}</EditorSheet> : <>{children}</>;
}
