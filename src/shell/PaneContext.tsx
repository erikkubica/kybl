/**
 * The panes on screen and which one is active, for anything below the shell that acts on "the
 * current place" (menus, shortcuts, the sidebar; later the migration UI's entry points) without
 * being handed a pane.
 */
import { createContext, useContext } from "react";
import type { Pane } from "../browser/usePane";
import type { PaneId } from "../browser/types";

export type PaneApi = {
  left: Pane;
  right: Pane;
  /** the pane the keyboard, menus and sidebar act on (always the left one in single-pane mode) */
  active: Pane;
  /** the other pane, while two are on screen */
  other: Pane | null;
  dual: boolean;
  setActive: (id: PaneId) => void;
};

export const PaneContext = createContext<PaneApi | null>(null);

export function usePanes(): PaneApi {
  const p = useContext(PaneContext);
  if (!p) throw new Error("usePanes needs the AppShell");
  return p;
}
