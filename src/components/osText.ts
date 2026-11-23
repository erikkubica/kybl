/** Shortcut glyphs and tray wording in running text, for this system (see shortcutKeys.ts). */
import { IS_MAC } from "./pointer";
import { keysInText, trayName } from "./shortcutKeys";

/** "Settings (⌘,)" on a Mac, "Settings (Ctrl+,)" elsewhere. */
export const keys = (text: string) => keysInText(text, IS_MAC);
/** "menu bar" on a Mac, "system tray" elsewhere. */
export const TRAY = trayName(IS_MAC);
