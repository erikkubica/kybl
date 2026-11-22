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

/** Inside the Tauri window on macOS the menu bar owns these shortcuts (they have accelerators). */
export const MENU_OWNS_SHORTCUTS = "__TAURI_INTERNALS__" in window && /Mac/i.test(navigator.userAgent);
