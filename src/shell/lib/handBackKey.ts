import { menuFromKey } from "../../desktop/lib/menuKeyWatch";

/** ⌘ on a Mac, Ctrl elsewhere */
const MAC_KEYS = /Mac/i.test(navigator.platform || navigator.userAgent);

/**
 * A menu-bar accelerator took a key that a `[data-own-keys]` element (a terminal) handles itself:
 * hand it back to that element as a keydown, as the palette does for ⌘K. True when handed back.
 */
export function handBackKey(key: string, code: string): boolean {
  const el = document.activeElement;
  // a click on the menu item isn't the key: it sizes the tiles
  if (!el?.closest?.("[data-own-keys]") || !menuFromKey()) return false;
  el.dispatchEvent(new KeyboardEvent("keydown", { key, code, metaKey: MAC_KEYS, ctrlKey: !MAC_KEYS, shiftKey: !MAC_KEYS, bubbles: true, cancelable: true }));
  return true;
}
