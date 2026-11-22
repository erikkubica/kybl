/**
 * Routes keyboard shortcuts and menu-bar items (the native `menu` event) to the active pane, or
 * to the shell for app-wide ones. Nothing runs behind an open dialog, menu or preview, and
 * without a bucket on screen only connection-level actions make sense.
 */
import { useRef } from "react";
import { useShortcuts } from "../desktop/useShortcuts";
import type { Pane } from "../browser/usePane";

/** At most this often, a window coming back to the front reloads the folders on screen. */
const RESUME_REFRESH_MS = 15_000;

export function useShellCommands({
  active,
  visible,
  overlayUp,
  settingsOpen,
  openSettings,
  closeSettings,
  shell,
  free,
  dual,
}: {
  active: Pane;
  /** the panes on screen */
  visible: Pane[];
  overlayUp: () => boolean;
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  /** app-wide commands, run like the pane's own (they need a bucket on screen) */
  shell: Record<string, () => void>;
  /** commands that work without a bucket on screen; a function returning false = not handled */
  free: Record<string, () => boolean | void>;
  /** two panes on screen (the commander keys work) */
  dual: boolean;
}) {
  const commands: Record<string, () => void> = { ...active.actions.commands, ...shell };

  const route = (id: string): boolean => {
    // nothing opens behind a dialog, Settings included
    if (overlayUp()) return false;
    if (id === "settings") {
      openSettings();
      return true;
    }
    if (settingsOpen) {
      if (id === "new-connection") free[id]?.();
      return id === "new-connection";
    }
    if (id in free) return free[id]() !== false;
    const run = commands[id];
    if (!run || !active.bucket) {
      // without a bucket on screen only connection-level actions make sense
      if (id === "back" || id === "forward") run?.();
      return !!run;
    }
    run();
    return true;
  };

  // the window coming back to the front reloads the folders on screen, at most every so often
  const lastResume = useRef(0);
  useShortcuts({
    route,
    overlayUp,
    settingsOpen,
    closeSettings,
    hasSelection: active.sel.selectedEntries.length > 0,
    listShown: !!active.bucket,
    moveSelection: active.sel.moveSelection,
    listScope: () => document.querySelector(`[data-pane="${active.id}"]`),
    dual,
    onResume: () => {
      if (overlayUp() || Date.now() - lastResume.current < RESUME_REFRESH_MS) return;
      const due = visible.filter((p) => p.here && !p.ent.search && !p.ent.lst.loading);
      if (!due.length) return;
      lastResume.current = Date.now();
      for (const p of due) void p.ent.lst.refresh(p.here!);
    },
  });
  return route;
}
