/**
 * Files and folders dragged in from Finder / Explorer upload into the pane under the pointer
 * (the only pane, or with two panes the one the drop lands on). The webview reports the drag,
 * not the DOM, so the pane is found from the pointer position.
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PaneId } from "../browser/types";

export function useFinderDrop({
  target,
  onDrop,
}: {
  /** the pane at this point (CSS pixels) that accepts uploads, or null */
  target: (x: number | null, y: number | null) => PaneId | null;
  onDrop: (pane: PaneId, paths: string[]) => void;
}) {
  const [over, setOver] = useState<PaneId | null>(null);
  const cbs = useRef({ target, onDrop });
  cbs.current = { target, onDrop };

  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        // positions come in physical pixels
        const at = "position" in p && p.position ? [p.position.x / devicePixelRatio, p.position.y / devicePixelRatio] : [null, null];
        if (p.type === "enter" || p.type === "over") setOver(cbs.current.target(at[0], at[1]));
        else if (p.type === "leave") setOver(null);
        else if (p.type === "drop") {
          setOver(null);
          const pane = cbs.current.target(at[0], at[1]);
          if (pane) cbs.current.onDrop(pane, p.paths);
        }
      })
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  return over;
}
