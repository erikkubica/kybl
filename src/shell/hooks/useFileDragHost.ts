import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast } from "../../ui/components/Dialogs";
import type { Pane } from "../../browser/hooks/usePane";
import type { DualContext } from "../components/dualActions";
import type { Entry, Profile } from "../../core/types";
import type { RefObject } from "react";
import type { PaneView, PaneId } from "../../browser/types";
import { dropPlace } from "../lib/recipes";
import { useFileDrag } from "./useFileDrag";
import { oneLayout, newId, nextName, type Workspace, type WorkspaceStore } from "../lib/workspaces";
import { useConnections } from "./useConnections";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";
import { useTransfers } from "../../transfers/hooks/useTransfers";

export interface UseFileDragHostDeps {
  DEFAULT_VIEW: PaneView;
  addWorkspace: (w: Workspace, after?: string, focus?: boolean, empty?: Set<PaneId>) => void;
  autoShowActivity: () => void;
  beginItemDrag: RefObject<((pane: PaneId, ev: React.MouseEvent, items: Entry[], onClick?: () => void) => void) | undefined>;
  conns: ReturnType<typeof useConnections>;
  dualCtx: RefObject<DualContext | null>;
  profiles: Profile[];
  slot: (id: PaneId) => Pane;
  switchWorkspace: (id: string) => void;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  transfers: ReturnType<typeof useTransfers>;
  ws: WorkspaceStore;
}

/** Items dragged from a list onto folders and panes, the sidebar, and other workspaces' tabs (dropped there, or resting there to open them). */
export function useFileDragHost(s: UseFileDragHostDeps) {
  // Items dragged from a list (useFileDrag): onto folders and panes, the sidebar, and other
  // workspaces (their tabs: dropped there, or resting there to open them and drop inside).
  /** A workspace not on screen: its name and the place of its last-used file pane (where a drop on its tab lands). */
  const wsDest = (id: string) => {
    const w = s.ws.list.find((x) => x.id === id);
    if (!w) return null;
    return { name: w.name, loc: dropPlace(w) };
  };
  const fileDrag = useFileDrag({
    activeWs: s.ws.active,
    slot: s.slot,
    profiles: s.profiles,
    rootLabel: s.conns.rootLabel,
    cross: () => s.dualCtx.current!,
    transfers: s.transfers,
    autoShowActivity: s.autoShowActivity,
    toast: s.toast,
    wsDest,
    switchWorkspace: s.switchWorkspace,
    newWorkspaceAt: (loc) => s.addWorkspace({ ...oneLayout({ loc, view: s.DEFAULT_VIEW }), id: newId(), name: nextName(s.ws.list), color: null, start: "restore", recipe: null }, undefined, false),
    // dropped on a terminal: their paths, typed in
    terminal: { target: s.term.dropTarget, drop: (pane, from, items) => void s.term.drop(pane, from, items) },
  });
  s.beginItemDrag.current = fileDrag.begin;
  return { wsDest, fileDrag };
}
