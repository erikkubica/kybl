import type { Settings } from "../../settings/settings";
import type { Listing } from "../../browser/hooks/useListing";
import type { Pane } from "../../browser/hooks/usePane";
import type { Dir } from "./paneLayout";
import type { MenuItem } from "../../ui/components/Dialogs";
import type { Layout } from "./workspaces";
import type { RefObject } from "react";
import type { PaneId, Loc } from "../../browser/types";

/**
 * The shell's late-bound functions: what a part of the shell (src/shell/hooks) calls that is
 * made further down in AppShell. AppShell fills it at the end of every render, so a click or a
 * key always reaches the current one; nothing reads it while rendering.
 */
export interface Late {
  nameOf: (id: PaneId) => string;
  keepScrolls: () => void;
  lastTop: RefObject<Map<PaneId, { loc: Loc | null; top: number; }>>;
  layoutOf: (id: string) => Layout;
  moveItems: (id: PaneId) => MenuItem[];
  pendingScroll: RefObject<Map<PaneId, { loc: Loc; top: number; selected?: string[]; }>>;
  crampedRef: RefObject<boolean>;
  split: (dir: Dir, id?: PaneId, before?: boolean, fill?: (fresh: PaneId) => void, anywhere?: boolean) => void;
  splitItems: (id: PaneId) => MenuItem[];
  paneById: (id: PaneId) => Pane;
  keptListings: RefObject<Map<string, Listing>>;
  settingsRef: RefObject<Settings>;
}
