/** Pure: shortcut keys written with Mac glyphs, spelled for this system (no imports, so `node --test` can load it). */

const NAMES: Record<string, string> = { "⌃": "Ctrl", "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
const ORDER = ["Ctrl", "Alt", "Shift"];
const KEYS: Record<string, string> = { "⌫": "Backspace", "⌦": "Delete", "↵": "Enter" };

/**
 * "⌥⇧⌘[" stays as it is on a Mac; elsewhere it becomes "Ctrl+Alt+Shift+[" (the key handler takes
 * Ctrl wherever a Mac takes ⌘). A glyph inside words ("drop copies, ⌘ moves") becomes its name.
 */
export function keyLabel(keys: string, mac: boolean): string {
  if (mac) return keys;
  const lead = /^[⌃⌘⌥⇧]+/.exec(keys)?.[0] ?? "";
  const rest = [...keys.slice(lead.length)].map((c) => KEYS[c] ?? NAMES[c] ?? c).join("");
  const mods = [...new Set([...lead].map((c) => NAMES[c]))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!mods.length) return rest;
  // a lone modifier ("⌥" while dragging), or one before words ("⌘ click")
  if (!rest || rest.startsWith(" ")) return mods.join("+") + rest;
  return [...mods, rest].join("+");
}

/**
 * A row's keys for this system. On a Mac each key is its own cap (["⇧", "⌘", "N"]); elsewhere
 * modifiers join the key they go with ("Ctrl+Shift+N"), alternatives stay apart.
 */
export function spellKeys(keys: string[], mac: boolean): string[] {
  if (mac) return keys;
  const out: string[] = [];
  let mods = "";
  for (const k of keys) {
    if (/^[⌃⌘⌥⇧]$/.test(k)) mods += k;
    else {
      out.push(keyLabel(mods + k, false));
      mods = "";
    }
  }
  if (mods) out.push(keyLabel(mods, false));
  return out;
}

/**
 * Shortcuts inside a sentence or tooltip ("Settings (⌘,)", "⌘-click for …", "⌥ to copy") spelled
 * for this system: each run of modifier glyphs plus the key right after it goes through `keyLabel`.
 */
export function keysInText(text: string, mac: boolean): string {
  if (mac) return text;
  return text.replace(/[⌃⌘⌥⇧]+(?:[A-Za-z0-9]+\b|[^\sA-Za-z0-9-])?/g, (m) => keyLabel(m, false));
}

/** Where the app's tray icon lives: the menu bar on a Mac, the system tray elsewhere. */
export const trayName = (mac: boolean) => (mac ? "menu bar" : "system tray");
