import type { WorkspaceStore } from "../lib/workspaces";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast } from "../../ui/components/Dialogs";
import type { SettingsPageId } from "../../settings/SettingsPage";
import type { Favorite, Settings } from "../../settings/settings";
import type { Profile } from "../../core/types";
import type { Pane } from "../../browser/hooks/usePane";
import { useRef, type RefObject, type Dispatch, type SetStateAction } from "react";
import { type PaneId, THIS_MAC } from "../../browser/types";
import { usePalette } from "../../palette/hooks/usePalette";
import { isShellConn } from "../../connections/lib/kinds";
import { equalize, relation, type Facing, type PaneNode, type Dir } from "../lib/paneLayout";
import { useConnections } from "./useConnections";
import { useRecentConnections } from "../../connections/lib/groups";
import { useShellCommands } from "./useShellCommands";
import type { Late } from "../lib/late";

export interface UsePaletteHostDeps {
  active: Pane;
  activeId: PaneId;
  closeOthers: (id?: PaneId) => void;
  connectIn: (id: PaneId, p: Profile, preferBucket?: string, startPrefix?: string) => Promise<void>;
  conns: ReturnType<typeof useConnections>;
  facing: Facing[];
  ids: (PaneId)[];
  isLinked: (a: PaneId, b: PaneId) => boolean;
  openConnection: (p: Profile) => void;
  openFavorite: (f: Favorite) => void;
  openHere: (run: (pane: Pane) => void) => void;
  openSettings: (page?: SettingsPageId) => void;
  openShell: (p: Profile, another?: boolean) => void;
  overlayUp: () => boolean;
  panesRef: RefObject<Pane[]>;
  profiles: Profile[];
  recents: ReturnType<typeof useRecentConnections>;
  route: ReturnType<typeof useShellCommands>;
  setImportOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setTree: Dispatch<SetStateAction<PaneNode>>;
  settings: Settings;
  settingsOpen: boolean;
  showActivityPanel: () => void;
  slot: (id: PaneId) => Pane;
  split: (dir: Dir, id?: PaneId, before?: boolean, fill?: (fresh: PaneId) => void, anywhere?: boolean) => void;
  splitRefusal: (dir: Dir, id: PaneId) => string | null;
  switchWorkspace: (id: string) => void;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  toggleSync: (a: PaneId, b: PaneId) => void;
  tree: PaneNode;
  undo: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  ws: WorkspaceStore;
  late: Late;
}

/** The command palette (⌘K): what it lists and what picking an item does. */
export function usePaletteHost(s: UsePaletteHostDeps) {
  const routeRef = useRef(s.route);
  routeRef.current = s.route;
  /** ⌘↵ in the palette: a new pane to the right, opened at `fill`'s place */
  const inNewPane = (fill: (fresh: PaneId) => void) => {
    s.split("row", s.activeId, false, fill, true);
  };
  const palette = usePalette({
    here: s.active.here,
    blocked: s.overlayUp,
    host: () => ({
      profiles: s.profiles,
      builtIn: (p) => p.id === THIS_MAC.id,
      recentConnections: s.recents.recent,
      rootLabel: s.conns.rootLabel,
      favorites: s.settings.favorites,
      active: s.active,
      panes: s.panesRef.current,
      paneCount: s.ids.length,
      route: (id) => routeRef.current(id),
      openConnection: (p, newPane) => (isShellConn(p) ? s.openShell(p, newPane) : newPane ? inNewPane((fresh) => void s.connectIn(fresh, p)) : s.openConnection(p)),
      openPlace: (loc, newPane, selectKey) => {
        const p = s.profiles.find((x) => x.id === loc.profileId);
        if (!p) return s.toast("error", "That connection no longer exists.");
        void s.conns.loadBuckets(p);
        if (newPane) return inNewPane((fresh) => s.slot(fresh).go(p, loc.bucket, loc.prefix, { selectKey }));
        s.openHere((pane) => pane.go(p, loc.bucket, loc.prefix, { selectKey }));
      },
      openFavorite: (f, newPane) => {
        const p = s.profiles.find((x) => x.id === f.profileId);
        if (newPane && p) inNewPane((fresh) => s.slot(fresh).go(p, f.bucket, f.prefix));
        else s.openFavorite(f);
      },
      splitRefusal: (dir) => s.splitRefusal(dir, s.activeId),
      closeOtherPanes: () => s.closeOthers(),
      equalizePanes: () => s.setTree((t) => equalize(t)),
      syncPartners: s.facing
        .filter(({ pair: [a, b] }) => a === s.activeId || b === s.activeId)
        .map(({ pair: [a, b] }) => {
          const id = a === s.activeId ? b : a;
          const dir = relation(s.tree, s.activeId, id);
          return { id, name: dir ? `the pane ${dir === "up" ? "above" : dir === "down" ? "below" : `to the ${dir}`}` : s.late.nameOf(id), on: s.isLinked(s.activeId, id) };
        }),
      toggleSync: (id) => s.toggleSync(s.activeId, id),
      workspaces: s.ws.list.map((w) => ({ id: w.id, name: w.name, active: w.id === s.ws.active })),
      switchWorkspace: s.switchWorkspace,
      showActivity: s.showActivityPanel,
      openSettings: s.openSettings,
      importConnections: () => s.setImportOpen(true),
      undo: s.undo,
      settings: s.settings,
      updateSettings: s.updateSettings,
      settingsOpen: s.settingsOpen,
      closeSettings: () => s.setSettingsOpen(false),
      toast: (k, t) => s.toast(k, t),
    }),
  });
  return { palette };
}
