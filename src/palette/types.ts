/** What the command palette is handed by the shell each time it opens (see usePalette.tsx). */
import type { Pane } from "../browser/hooks/usePane";
import type { Loc, PaneId } from "../browser/types";
import type { SettingsPageId } from "../settings/SettingsPage";
import type { Favorite, Settings } from "../settings/settings";
import type { Profile } from "../core/types";
import type { Dir } from "../shell/lib/paneLayout";

export type PaletteHost = {
  /** the saved connections, then This Mac */
  profiles: Profile[];
  builtIn: (p: Profile) => boolean;
  /** connection ids opened lately, newest first (the sidebar's Recent) */
  recentConnections: string[];
  rootLabel: (profileId: string, bucket: string) => string;
  favorites: Favorite[];
  /** the active pane, and every pane on screen */
  active: Pane;
  panes: Pane[];
  /** how many panes are on screen, terminals included */
  paneCount: number;
  /** runs a menu / shortcut command by id (useShellCommands' route) */
  route: (id: string) => boolean;
  openConnection: (p: Profile, newPane: boolean) => void;
  openPlace: (loc: Loc, newPane: boolean, selectKey?: string) => void;
  openFavorite: (f: Favorite, newPane: boolean) => void;
  /** why the active pane can't split that way, or null */
  splitRefusal: (dir: Dir) => string | null;
  closeOtherPanes: () => void;
  equalizePanes: () => void;
  /** pairs of panes facing each other across a divider, with the active one: synchronized browsing */
  syncPartners: { id: PaneId; name: string; on: boolean }[];
  toggleSync: (other: PaneId) => void;
  workspaces: { id: string; name: string; active: boolean }[];
  switchWorkspace: (id: string) => void;
  showActivity: () => void;
  openSettings: (page?: SettingsPageId) => void;
  importConnections: () => void;
  undo: () => void;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  /** Settings is open: it closes before a pick runs */
  settingsOpen: boolean;
  closeSettings: () => void;
  toast: (kind: "success" | "error" | "info", text: string) => void;
};
