/**
 * Paths for typing into a terminal. Same rules as the backend (`shell_quote`, `cd_line` in
 * src-tauri/src/terminal/mod.rs and `quote` in actions.rs).
 */

/**
 * Control characters (C0, DEL, C1). Text typed or pasted into a terminal is input, not an
 * argument: a Ctrl-U or ESC in a name would act as a key (kill the line, end a bracketed paste),
 * so such names are never typed.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
export const typeable = (s: string) => !CONTROL.test(s);

// eslint-disable-next-line no-control-regex
const PASTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Clipboard text made safe to paste: every control character except tab and line breaks goes.
 * An ESC in copied text (invisible on a web page) could end the shell's bracketed paste early
 * (`ESC[201~`), and what follows would then run as typed keys.
 */
export const cleanPaste = (s: string) => s.replace(PASTE_CONTROL, "");

/**
 * Whether pasting `s` needs a yes first: it has a line break, and a shell without bracketed paste
 * would run each line as soon as it arrives (text hidden on a web page rides along in a copy, a
 * hidden "\ncurl … | sh\n" included). Asked every time by default: the terminal's
 * "bracketed paste is on" flag is set by whatever the shell's programs print (`cat` of a file
 * holding ESC[?2004h turns it on in sh), so it only counts when the user chose to trust it.
 */
export const pasteNeedsConfirm = (s: string, bracketed: boolean, trustBracketed = false) => /[\r\n]/.test(s) && !(trustBracketed && bracketed);

// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Pasted text for the confirm box: zero-width and text-direction characters shown as their code
 * (`<U+202E>`), so they can't hide or reorder what will be typed.
 */
export const pastePreview = (s: string) => s.replace(INVISIBLE, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}>`);

/**
 * `s` as one word for any shell (POSIX, fish, csh): as it is when plain, else in single quotes with
 * each quote and backslash written outside them (`'\''`, `'\\'`), so nothing between the quotes is
 * special anywhere (fish reads `\'` inside single quotes as a quote). Null when it holds a control
 * character (see `typeable`).
 */
export function shellQuote(s: string): string | null {
  if (!typeable(s)) return null;
  if (s && /^[A-Za-z0-9_\-./+:@%,=]+$/.test(s)) return s;
  return `'${s.replace(/['\\]/g, (c) => (c === "'" ? `'\\''` : `'\\\\'`))}'`;
}

/** A remote path for a shell: `base` from the backend ("/var/www", "~", "~/site") joined with `key`, the ~ left unquoted. Null: not typeable. */
export function remotePath(base: string, key: string): string | null {
  const k = key.replace(/\/+$/, "");
  if (base === "~" || base.startsWith("~/")) {
    const rel = [base.slice(2), k].filter(Boolean).join("/");
    if (!rel) return "~";
    const q = shellQuote(rel);
    return q == null ? null : `~/${q}`;
  }
  return shellQuote(k ? `${base.replace(/\/+$/, "")}/${k}` : base);
}
