import { isTauri } from "@tauri-apps/api/core";
import type { MenuItem } from "../components/Dialogs";

/**
 * Builds a context menu from a list that may hold `false`/null for items that don't apply, and
 * drops separators that would end up first, last or next to each other.
 */
export function tidyMenu(items: (MenuItem | false | null | undefined)[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it.type === "sep" && (out.length === 0 || out[out.length - 1].type === "sep")) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === "sep") out.pop();
  return out;
}

/**
 * Inside the real Tauri window on macOS the menu bar owns the shortcuts in MENU_ACCELERATORS: the
 * keys arrive as the `menu` event, never as a keydown. `isTauri()` and not `__TAURI_INTERNALS__`:
 * the browser dev mock fakes the latter.
 */
export const MENU_OWNS_SHORTCUTS = isTauri() && /Mac/i.test(navigator.userAgent);

/**
 * The menu items that have an accelerator in the macOS menu bar (src-tauri/src/menu.rs), by
 * command id. Keep in step with menu.rs. The other menu items (refresh, search, go-up, delete,
 * rename, new-connection) are click-only there, so their keys are always handled here.
 *
 * Dual pane ids for a future View menu item in menu.rs (all handled by the frontend today):
 * "toggle-dual" (⌘\), "swap-panes" (⇧⌘S), "same-folder", "compare-folders", "pane-copy" (F5),
 * "pane-move" (F6), "switch-pane" (Tab). Give "toggle-dual" an accelerator here once menu.rs has it.
 * "toggle-hidden" (⇧⌘.) shows or hides dotfiles in This Mac's panes (a View menu item later).
 */
export const MENU_ACCELERATORS: Record<string, string> = {
  "new-folder": "⇧⌘N",
  "upload-files": "⌘U",
  "upload-folder": "⇧⌘U",
  download: "⇧⌘D",
  "get-info": "⌘I",
  back: "⌘[",
  forward: "⌘]",
  "go-to": "⇧⌘G",
  settings: "⌘,",
};
