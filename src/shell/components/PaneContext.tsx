/**
 * The panes on screen and which one is active, for anything below the shell that acts on "the
 * current place" (menus, shortcuts, the sidebar; later the migration UI's entry points) without
 * being handed a pane.
 */
import { createContext, useContext } from "react";
import type { Pane } from "../../browser/hooks/usePane";
import type { PaneId } from "../../browser/types";

export type PaneApi = {
  /** the panes on screen, in reading order */
  panes: Pane[];
  /** the pane the keyboard, menus and sidebar act on (the only one in single-pane mode) */
  active: Pane;
  /** the pane the active one pairs with (F5 / F6, swap, compare), while several are on screen */
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
