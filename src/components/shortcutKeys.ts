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

/** a run of modifiers and the key it goes with, inside running text ("Upload (⌘U, ⇧⌘N)", "⌘-click", "⌥ to copy") */
const IN_TEXT = /[⌃⌘⌥⇧]+(?:[⌫⌦↵←→↑↓−]|F\d{1,2}|Tab|Space|[A-Z0-9](?![a-z])|[[\]\\.,=+`/;'](?![A-Za-z]))?/g;

/**
 * Every shortcut written with Mac glyphs inside a sentence (a tooltip, a toast, a menu hint),
 * spelled for this system: "Paste with ⌘V" → "Paste with Ctrl+V", "⌘-click" → "Ctrl-click".
 */
export function keysIn(text: string, mac: boolean): string {
  if (mac || !text) return text;
  return text.replace(IN_TEXT, (m) => keyLabel(m, false));
}

const ARIA_KEYS: Record<string, string> = { "⌫": "Backspace", "⌦": "Delete", "↵": "Enter", "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown", "−": "-" };

/** One shortcut ("⇧⌘N") as `aria-keyshortcuts` wants it ("Shift+Meta+N"); undefined for anything else. */
export function ariaKeys(keys: string | undefined, mac: boolean): string | undefined {
  const m = keys && /^([⌃⌘⌥⇧]*)(.+)$/.exec(keys);
  if (!m || !/^([⌫⌦↵←→↑↓−]|F\d{1,2}|Tab|Space|.)$/.test(m[2])) return undefined;
  const names: Record<string, string> = { "⌃": "Control", "⌘": mac ? "Meta" : "Control", "⌥": "Alt", "⇧": "Shift" };
  const mods = [...new Set([...m[1]].map((c) => names[c]))];
  return [...mods, ARIA_KEYS[m[2]] ?? m[2]].join("+");
}
