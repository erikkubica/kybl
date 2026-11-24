/** Shortcut glyphs and tray wording for this system (see shortcutKeys.ts). */
import { IS_MAC } from "./pointer";
import { ariaKeys, keyLabel, keysInText, trayName } from "./shortcutKeys";

/** A sentence with shortcuts in it: "Settings (⌘,)" on a Mac, "Settings (Ctrl+,)" elsewhere. */
export const keys = (text: string) => keysInText(text, IS_MAC);
/** One shortcut ("⇧⌘N"), spelled for this system. */
export const key = (k: string) => keyLabel(k, IS_MAC);
/** One shortcut for `aria-keyshortcuts`. */
export const ariaKey = (k: string | undefined) => ariaKeys(k, IS_MAC);
/** "menu bar" on a Mac, "system tray" elsewhere. */
export const TRAY = trayName(IS_MAC);
