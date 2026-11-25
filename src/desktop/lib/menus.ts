import { isTauri } from "@tauri-apps/api/core";
import type { MenuItem } from "../../ui/components/Dialogs";

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
 * The menu items that have an accelerator in the macOS menu bar (src-tauri/src/app/menu.rs), by
 * command id. Keep in step with app/menu.rs. The other menu items (refresh, search, go-up, delete,
 * rename, new-connection) are click-only there, so their keys are always handled here.
 *
 * View menu pane items: "split-right", "split-down", "swap-panes" and "toggle-hidden" have
 * accelerators; "close-pane", "switch-pane", "same-folder", "compare-folders", "pane-copy" and
 * "pane-move" are click-only (⌘W stays with the window's Close, which the page takes first while
 * several panes are open; Tab, F5 and F6 stay with the page).
 *
 * Window menu workspace items: "new-workspace" (⌘T), "prev-workspace" (⇧⌘[) and "next-workspace"
 * (⇧⌘]) have accelerators but are left out here on purpose: the page handles those keys too, so
 * if the menu can't match a shifted bracket the press still lands (useShortcuts.ts).
 */
export const MENU_ACCELERATORS: Record<string, string> = {
  "new-folder": "⇧⌘N",
  "new-file": "⌥⌘N",
  "upload-files": "⌘U",
  "upload-folder": "⇧⌘U",
  download: "⇧⌘D",
  "get-info": "⌘I",
  edit: "⌘E",
  duplicate: "⌘D",
  back: "⌘[",
  forward: "⌘]",
  "go-to": "⇧⌘G",
  settings: "⌘,",
  "split-right": "⌘\\",
  "split-down": "⇧⌘\\",
  "swap-panes": "⇧⌘S",
  "toggle-hidden": "⇧⌘.",
  "toggle-sidebar": "⌥⌘S",
  "filter-connections": "⌥⌘F",
  "tiles-bigger": "⌘+",
  "tiles-smaller": "⌘−",
};

/**
 * How long after ⌘ was last down (pressed or released) a `menu` event still counts as its
 * accelerator: the event can arrive just after a quick ⌘ release. Picking a menu-bar item with the
 * mouse takes far longer than this after letting go of ⌘, so a click is never taken for a key.
 */
export const MENU_KEY_WINDOW_MS = 300;

/**
 * Whether a `menu` event came from its accelerator key rather than a click on the menu bar: both
 * arrive the same way, but ⌘ itself still reaches the page (held now, or let go just before).
 */
export function menuByKey(cmdHeld: boolean, lastCmd: number, now: number): boolean {
  return cmdHeld || now - lastCmd < MENU_KEY_WINDOW_MS;
}

/** [key, code, key with Shift] for the accelerators that aren't letters */
const KEYS: Record<string, [string, string, string]> = {
  "[": ["[", "BracketLeft", "{"],
  "]": ["]", "BracketRight", "}"],
  "\\": ["\\", "Backslash", "|"],
  ".": [".", "Period", ">"],
  ",": [",", "Comma", "<"],
  "+": ["=", "Equal", "+"],
  "−": ["-", "Minus", "_"],
};

/**
 * The keydown a menu item's accelerator stands for (⌘ as metaKey), or null when it has none. The
 * menu bar takes these keys before the page; this hands one back to whatever has the keyboard
 * (the full editor, Quick Look) as a synthetic keydown.
 */
export function menuKeydown(id: string): KeyboardEventInit | null {
  const acc = MENU_ACCELERATORS[id];
  if (!acc) return null;
  const shiftKey = acc.includes("⇧");
  const altKey = acc.includes("⌥");
  const last = acc[acc.length - 1];
  let key: string;
  let code: string;
  if (/^[A-Z]$/.test(last)) {
    key = shiftKey ? last : last.toLowerCase();
    code = `Key${last}`;
  } else {
    const k = KEYS[last];
    if (!k) return null;
    key = shiftKey ? k[2] : k[0];
    code = k[1];
  }
  return { key, code, metaKey: true, shiftKey, altKey, bubbles: true, cancelable: true };
}
