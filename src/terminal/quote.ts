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
