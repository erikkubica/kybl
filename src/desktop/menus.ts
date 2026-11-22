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
 * Inside the real Tauri window on macOS the menu bar owns these shortcuts (they have
 * accelerators). `isTauri()` and not `__TAURI_INTERNALS__`: the browser dev mock fakes the latter.
 */
export const MENU_OWNS_SHORTCUTS = isTauri() && /Mac/i.test(navigator.userAgent);
