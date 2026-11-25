/**
 * "Edit in Kybl": the document editor (src/viewers, CodeMirror, loaded on first use) in a sheet
 * over the browser, like Quick Look, with the save rule picked for this edit said under it.
 */
import type { ReactNode } from "react";
import { Icon } from "../../ui/components/Icons";
import type { SaveRule } from "../lib/editStore";
import "./edit.css";

export function EditorSheet({ rule, children }: { rule?: SaveRule; children: ReactNode }) {
  return (
    <div className="ed-backdrop">
      <div className="ed-sheet" role="dialog" aria-modal="true" aria-label="Editor">
        <div className="ed-sheet-body">{children}</div>
        {rule && (
          <div className="ed-rule">
            <Icon name={rule === "auto" ? "upload" : "check-circle"} size={13} />
            {rule === "auto" ? "Saving uploads your changes, whatever is on the server." : "Saving uploads only if the file on the server hasn't changed since you opened it."}
          </div>
        )}
      </div>
    </div>
  );
}
