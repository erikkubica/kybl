/** Shortcut glyphs for this system (Mac glyphs on a Mac, Ctrl+… elsewhere). */
import { IS_MAC } from "./pointer";
import { ariaKeys, keyLabel, keysIn } from "./shortcutKeys";

/** A sentence with shortcuts in it ("Show info (⌘I)"), spelled for this system. */
export const k = (text: string) => keysIn(text, IS_MAC);
/** One shortcut ("⇧⌘N"), spelled for this system. */
export const key = (keys: string) => keyLabel(keys, IS_MAC);
/** One shortcut for `aria-keyshortcuts`. */
export const ariaKey = (keys: string | undefined) => ariaKeys(keys, IS_MAC);
