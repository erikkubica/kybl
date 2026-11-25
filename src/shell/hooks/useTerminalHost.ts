import type { ToastAction } from "../../desktop/components/fileOps";
import type { Pane } from "../../browser/hooks/usePane";
import type { ConnDialogAsk } from "../lib/types";
import type { Profile } from "../../core/types";
import type { Workspace, Layout, WorkspaceStore } from "../lib/workspaces";
import type { PaneId } from "../../browser/types";
import { leaves, equalize, type PaneNode, type Dir } from "../lib/paneLayout";
import { type MenuItem, type Toast } from "../../ui/components/Dialogs";
import { connectionMenuItems } from "../../connections/lib/organizeMenu";
import { canTerminal } from "../../terminal/api";
import { useEffect, type RefObject, type Dispatch, type SetStateAction } from "react";
import { inBackground } from "../lib/notifications";
import { useConnections } from "./useConnections";
import { useDialogs } from "./useDialogs";
import { useWorkspaceRecipes } from "./useWorkspaceRecipes";
import { useRecentConnections } from "../../connections/lib/groups";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";
import { useTransfers } from "../../transfers/hooks/useTransfers";

export interface UseTerminalHostDeps {
  duplicateWorkspace: (id: string) => void;
  activeId: PaneId;
  addWorkspace: (w: Workspace, after?: string, focus?: boolean, empty?: Set<PaneId>) => void;
  clearAllSizes: () => void;
  closeNow: (id: PaneId) => boolean;
  closeOthers: (id?: PaneId) => void;
  closeOthersNow: (id: PaneId) => void;
  connectIn: (id: PaneId, p: Profile, preferBucket?: string, startPrefix?: string) => Promise<void>;
  conns: ReturnType<typeof useConnections>;
  dialogs: ReturnType<typeof useDialogs>;
  fileId: PaneId;
  focusSoon: (id: PaneId) => number;
  ids: (PaneId)[];
  layoutOf: (id: string) => Layout;
  moveItems: (id: PaneId) => MenuItem[];
  newWorkspace: () => void;
  okToEndShells: (sids: (string | undefined)[], label: string) => Promise<boolean>;
  paneLater: RefObject<{ close: (_id: PaneId) => boolean; closeOthers: (_id: PaneId) => void; takeFromLive: (_id: PaneId) => void; }>;
  patchWorkspace: (id: string, patch: Partial<Pick<Workspace, "name" | "color" | "start" | "recipe">>) => void;
  profiles: Profile[];
  rec: ReturnType<typeof useWorkspaceRecipes>;
  recents: ReturnType<typeof useRecentConnections>;
  reloadIfShowing: (pid: string, b: string) => boolean;
  replaceWorkspace: (id: string, l: Layout, empty: Set<PaneId>) => void;
  setActiveId: (id: PaneId) => void;
  setConnDialog: (d: ConnDialogAsk | null) => void;
  setTree: Dispatch<SetStateAction<PaneNode>>;
  showFailed: () => void;
  sidsOf: (of: PaneId[]) => (string | undefined)[];
  slot: (id: PaneId) => Pane;
  split: (dir: Dir, id?: PaneId, before?: boolean, fill?: (fresh: PaneId) => void, anywhere?: boolean) => void;
  splitItems: (id: PaneId) => MenuItem[];
  takeFromLive: (id: PaneId) => void;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  transfers: ReturnType<typeof useTransfers>;
  treeRef: RefObject<PaneNode>;
  ws: WorkspaceStore;
}

/** Terminal panes: what they get from the shell (open a pane, close, follow the folder above, menus). */
export function useTerminalHost(s: UseTerminalHostDeps) {
  s.term.host.current = {
    profiles: s.profiles,
    slot: s.slot,
    ids: s.ids,
    activeId: s.activeId,
    fileId: s.fileId,
    splitBelow: (src, fill) => s.split("col", src, false, fill, true),
    splitAbove: (src, fill) => s.split("col", src, true, fill, true),
    // the header's split button: split this way or that, then what the panes menu has for the others
    panesItems: (id) => [
      ...s.splitItems(id).map((it): MenuItem => (it.type === "item" ? { ...it, label: `Split ${it.label.toLowerCase()}` } : it)),
      ...(leaves(s.treeRef.current).length > 1
        ? ([
            { type: "sep" },
            { type: "item", label: "Make panes the same size", onClick: () => s.setTree((t) => equalize(t)) },
            { type: "submenu", label: "Move pane", icon: "move", items: () => s.moveItems(id) },
            { type: "item", label: "Close other panes", onClick: () => s.closeOthers(id) },
          ] satisfies MenuItem[])
        : []),
    ],
    paneItems: (id) => [
      { type: "submenu", label: "Split", icon: "dual-pane", items: () => s.splitItems(id) },
      ...(leaves(s.treeRef.current).length > 1
        ? ([
            { type: "submenu", label: "Move pane", icon: "move", items: () => s.moveItems(id) },
            { type: "item", label: "Make panes the same size", onClick: () => s.setTree((t) => equalize(t)) },
            { type: "item", label: "Close other panes", onClick: () => s.closeOthers(id) },
          ] satisfies MenuItem[])
        : []),
    ],
    setActive: s.setActiveId,
    focus: s.focusSoon,
    // the terminal's own Close: asks first when a program runs in it
    close: (id) => void s.okToEndShells(s.sidsOf([id]), "Close terminal").then((ok) => ok && s.paneLater.current.takeFromLive(id)),
    menu: s.dialogs.menu,
    confirm: s.dialogs.confirm,
    toast: s.toast,
    rootLabel: s.conns.rootLabel,
    connMenu: (id, x, y, current, pick) =>
      s.dialogs.menu(x, y, [
        // every connection, as the file pane's menu: one that has a shell gets a terminal here, any
        // other turns this pane into its files
        ...connectionMenuItems(s.profiles, {
          recent: s.recents.recent,
          skipRecent: current,
          row: (p): MenuItem => ({
            type: "item",
            label: p.name,
            checked: p.id === current || undefined,
            // the shell here ends: asks first when a program runs in it
            onClick: () =>
              p.id !== current &&
              void s.okToEndShells(s.sidsOf([id]), "Switch connection").then((ok) => {
                if (!ok) return;
                if (canTerminal(p)) return pick(p.id);
                s.term.assign(id, undefined);
                s.setActiveId(id);
                void s.connectIn(id, p);
                s.focusSoon(id);
              }),
          }),
        }),
        { type: "sep" },
        { type: "item", label: "New connection…", icon: "plus", onClick: () => s.setConnDialog({ profile: null }) },
      ]),
  };
  s.paneLater.current = { close: s.closeNow, closeOthers: s.closeOthersNow, takeFromLive: s.takeFromLive };
  // a shell ends once no workspace has its pane any more
  useEffect(() => s.term.gc(s.ws), [s.term.terms, s.ws]); // eslint-disable-line react-hooks/exhaustive-deps
  s.rec.host.current = {
    ws: s.ws,
    layoutOf: s.layoutOf,
    profiles: s.profiles,
    rootLabel: s.conns.rootLabel,
    show: s.replaceWorkspace,
    add: (w, empty) => s.addWorkspace(w, undefined, true, empty),
    patch: s.patchWorkspace,
    newEmpty: s.newWorkspace,
    duplicate: () => s.duplicateWorkspace(s.ws.active),
    confirm: s.dialogs.confirm,
    menu: s.dialogs.menu,
    toast: s.toast,
  };

  // refresh listing once all uploads have finished
  useEffect(
    () =>
      s.transfers.onUploadsSettled((ok, bad, where) => {
        inBackground(() => {
          if (bad) s.toast("error", `${bad} ${bad === 1 ? "upload" : "uploads"} failed`, { label: "Show", run: s.showFailed });
          else if (ok) s.toast("success", `Uploaded ${ok} ${ok === 1 ? "file" : "files"}`);
        });
        if (ok) s.clearAllSizes();
        for (const w of where) if (s.reloadIfShowing(w.profileId, w.bucket)) break;
      }),
    [s.transfers, s.toast, s.reloadIfShowing, s.showFailed, s.clearAllSizes],
  );
  return {  };
}
