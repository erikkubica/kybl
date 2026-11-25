import type { usePanesHost } from "./usePanesHost";
import type { ConnDialogAsk } from "../lib/types";
import type { WorkspaceStore } from "../lib/workspaces";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast } from "../../ui/components/Dialogs";
import type { Dir } from "../lib/paneLayout";
import type { SettingsPageId } from "../../settings/SettingsPage";
import type { SaveRule } from "../../edit/lib/editStore";
import type { Entry, Profile } from "../../core/types";
import type { PaneId } from "../../browser/types";
import type { RefObject, Dispatch, SetStateAction } from "react";
import type { Pane } from "../../browser/hooks/usePane";
import { undoStack } from "../../desktop/lib/undo";
import { useShellCommands } from "./useShellCommands";
import { TILE_MAX, TILE_MIN } from "../../browser/components/Toolbar";
import { useDialogs } from "./useDialogs";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";
import { handBackKey } from "../lib/handBackKey";

export interface UseCommandsHostDeps {
  active: Pane;
  allPanes: RefObject<Pane[]>;
  close: (id?: PaneId) => boolean;
  closeEditor: () => Promise<boolean>;
  closeOthers: (id?: PaneId) => void;
  closeWorkspace: (id: string) => Promise<void>;
  connDialog: ConnDialogAsk | null;
  dialogs: ReturnType<typeof useDialogs>;
  docRef: RefObject<{ pane: PaneId; profileId: string; bucket: string; entry: Entry; rule?: SaveRule; sheet?: boolean; } | null>;
  dual: boolean;
  dualPane: ReturnType<typeof usePanesHost>["dualPane"];
  findConnection: () => void;
  focusToward: (d: "left" | "right" | "up" | "down") => boolean;
  importOpen: boolean;
  jumpWorkspace: (n: number) => void;
  kyblDialog: { existing: Profile | null; reconnect?: boolean; } | null;
  moveActiveWorkspace: (d: number) => void;
  newWorkspace: () => void;
  openSettings: (page?: SettingsPageId) => void;
  openWsSettings: (id: string) => void;
  panesRef: RefObject<Pane[]>;
  setConnDialog: (d: ConnDialogAsk | null) => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setWsEditing: Dispatch<SetStateAction<string | null>>;
  settingsOpen: boolean;
  split: (dir: Dir, id?: PaneId, before?: boolean, fill?: (fresh: PaneId) => void, anywhere?: boolean) => void;
  stepWorkspace: (d: number) => false | undefined;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  toggleSidebar: () => void;
  ws: WorkspaceStore;
}

/** The commands the keyboard and the menu bar run (undo, panes, workspaces, sidebar), routed to the active pane, and whether an overlay has the keyboard. */
export function useCommandsHost(s: UseCommandsHostDeps) {
  const undo = () => {
    const u = undoStack.pop();
    if (!u) {
      s.toast("info", "Nothing to undo");
      return;
    }
    s.toast("info", `Undoing the ${u.label}…`);
    void undoStack.runQueued(u);
  };

  /** A dialog, menu or preview is up: it owns the keyboard, and actions must not run behind it. */
  const overlayUp = () =>
    !!s.docRef.current ||
    s.dialogs.isOpen() ||
    !!(s.connDialog || s.kyblDialog || s.importOpen || s.allPanes.current.some((p) => p.quick)) ||
    !!document.querySelector(".modal-backdrop, .ctx-menu, .ql-backdrop, .ws-pop, .palette-backdrop");

  const route = useShellCommands({
    active: s.active,
    visible: s.panesRef.current,
    overlayUp,
    settingsOpen: s.settingsOpen,
    openSettings: () => s.openSettings(),
    closeSettings: () => s.setSettingsOpen(false),
    shell: {
      undo,
    },
    free: {
      "new-connection": () => s.setConnDialog({ profile: null }),
      "toggle-sidebar": s.toggleSidebar,
      "filter-connections": s.findConnection,
      // grid view: ⌘+ / ⌘− (and a pinch) size the tiles, as Finder's icon view
      // (a terminal has the keyboard: the menu bar took its ⌘+ / ⌘−, so it gets them back as keys)
      "tiles-bigger": () => handBackKey("=", "Equal") || (s.active.view === "grid" ? s.active.setTile(Math.min(TILE_MAX, s.active.tile + 24)) : false),
      "tiles-smaller": () => handBackKey("-", "Minus") || (s.active.view === "grid" ? s.active.setTile(Math.max(TILE_MIN, s.active.tile - 24)) : false),
      "toggle-compact": () => s.active.setCompact(!s.active.compact),
      ...s.dualPane.commands,
      "split-right": () => s.split("row"),
      "split-down": () => s.split("col"),
      "close-pane": () => s.close(),
      "toggle-terminal": () => s.term.toggle(),
      // the dual pane's old toggle, for anything still sending it
      "toggle-dual": () => (s.dual ? s.closeOthers() : s.split("row")),
      "focus-left": () => s.focusToward("left"),
      "focus-right": () => s.focusToward("right"),
      "focus-up": () => s.focusToward("up"),
      "focus-down": () => s.focusToward("down"),
      // workspaces
      "new-workspace": s.newWorkspace,
      "next-workspace": () => s.stepWorkspace(1),
      "prev-workspace": () => s.stepWorkspace(-1),
      "move-workspace-left": () => s.moveActiveWorkspace(-1),
      "move-workspace-right": () => s.moveActiveWorkspace(1),
      "rename-workspace": () => s.setWsEditing(s.ws.active),
      "workspace-settings": () => s.openWsSettings(s.ws.active),
      "close-workspace": () => (s.ws.list.length > 1 ? void s.closeWorkspace(s.ws.active) : false),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`workspace-${n}`, () => s.jumpWorkspace(n)])),
    },
    dual: s.dual,
    editorOpen: () => !!s.docRef.current,
    closeEditor: s.closeEditor,
  });
  return { undo, overlayUp, route };
}
