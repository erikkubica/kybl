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
 * hidden "\ncurl … | sh\n" included). Asked every time unless the user said not to for this one
 * terminal (`trusted`, per running shell) and its shell has bracketed paste on. Program output can
 * set that flag (`cat` of a file holding ESC[?2004h), so on its own it never skips the question;
 * it only narrows the user's own choice. A very big paste is always asked about.
 */
export const pasteNeedsConfirm = (s: string, bracketed: boolean, trusted = false) =>
  s.length > PASTE_ASK_ALWAYS || (/[\r\n]/.test(s) && !(trusted && bracketed));

/** Pastes longer than this (characters) are asked about even on one line; longer than the cap, refused. */
export const PASTE_ASK_ALWAYS = 1_000_000;
export const PASTE_MAX = 16_000_000;

/**
 * Characters that don't show, or that change how the text around them looks, marked in the paste
 * question as `<U+…>`: every format character (Cf: zero-width, bidi controls and marks such as
 * U+061C, soft hyphen, tag characters U+E0000–E007F), line and paragraph separators (a browser
 * breaks the line there, a shell doesn't), the Hangul fillers, the grapheme joiner and the
 * variation selectors that aren't the emoji ones.
 */
const INVISIBLE = /[\p{Cf}\u2028\u2029\u034F\u115F\u1160\u17B4\u17B5\u3164\uFFA0\uFE00-\uFE0D\u{E0100}-\u{E01EF}]/gu;
const code = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Pasted text as the confirm box shows it: invisible and direction characters as their code
 * (`<U+202E>`), so they can't hide or reorder what will be typed, and every line break (a lone CR
 * too, which the terminal sends as Enter) as a line break, so the lines seen are the lines run.
 */
export const pastePreview = (s: string) => s.replace(/\r\n?/g, "\n").replace(INVISIBLE, (c) => `<${code(c)}>`);

/** Lines the terminal gets: CRLF, CR and LF each end one; breaks at the very end don't start another. */
export function pasteLines(s: string): number {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
  let n = 1;
  for (let i = 0; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13) {
      n++;
      if (s.charCodeAt(i + 1) === 10) i++;
    }
  }
  return n;
}

/** What the paste question shows: the start and end of a big paste, with what's left out counted. */
export type PasteView = {
  /** the whole text when small; else its start */
  head: string;
  /** the end of a big paste ("" when small) */
  tail: string;
  /** characters and line breaks between head and tail, not shown */
  cutChars: number;
  cutLines: number;
  /** lines in the whole paste */
  lines: number;
  /** invisible characters anywhere in the text, shown or not: [code, how many], most first */
  hidden: [string, number][];
};

const HEAD = 48 * 1024;
const TAIL = 16 * 1024;
/** a cut that doesn't split a surrogate pair or a CRLF */
const safeCut = (s: string, i: number) => (i > 0 && i < s.length && (/[\uDC00-\uDFFF]/.test(s[i]) || (s[i] === "\n" && s[i - 1] === "\r")) ? i - 1 : i);

/** The paste question's view of `s` (already cleaned): bounded however long `s` is, every invisible character counted. */
export function pasteView(s: string): PasteView {
  const counts = new Map<string, number>();
  for (const m of s.matchAll(INVISIBLE)) {
    const k = code(m[0]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const hidden = [...counts].sort((a, b) => b[1] - a[1]);
  const lines = pasteLines(s);
  if (s.length <= HEAD + TAIL) return { head: pastePreview(s), tail: "", cutChars: 0, cutLines: 0, lines, hidden };
  const a = safeCut(s, HEAD);
  const b = safeCut(s, s.length - TAIL);
  const mid = s.slice(a, b);
  let cutLines = 0;
  for (let i = 0; i < mid.length; i++) {
    const c = mid.charCodeAt(i);
    if (c === 10 || (c === 13 && mid.charCodeAt(i + 1) !== 10)) cutLines++;
  }
  return { head: pastePreview(s.slice(0, a)), tail: pastePreview(s.slice(b)), cutChars: b - a, cutLines, lines, hidden };
}

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

/** How a shell on this computer wants a path typed (the backend says, `terminal_open`). */
export type Quoting = "posix" | "powershell" | "cmd" | "wsl";

/**
 * A Windows path as WSL sees it: `C:\a\b` is `/mnt/c/a/b`, `\\wsl$\Ubuntu\home` is `/home`; null
 * for one it can't reach that way (a network share, a drive-relative `C:foo`).
 */
export function wslPath(p: string): string | null {
  const own = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/][^\\/]+(.*)$/i.exec(p);
  if (own) return own[1].replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const m = /^([A-Za-z]):(?:[\\/]+(.*))?$/.exec(p);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${(m[2] ?? "").replace(/\\/g, "/")}`.replace(/\/+$/, "");
}

/**
 * Path `s` as one word for shell kind `q`: POSIX shells and Git Bash as `shellQuote`; PowerShell in
 * single quotes with each quote doubled (the curly ones end a string there too); Command Prompt in
 * double quotes (a name with `%` would expand there, so it is refused); WSL as its /mnt path. Null:
 * not typeable.
 */
export function quoteAs(q: Quoting, s: string): string | null {
  if (!typeable(s)) return null;
  if (q === "powershell") return /^[A-Za-z0-9_\-.\\/:]+$/.test(s) ? s : `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
  if (q === "cmd") return s.includes("%") || s.includes('"') ? null : /^[A-Za-z0-9_\-.\\/:]+$/.test(s) ? s : `"${s}"`;
  if (q === "wsl") {
    const w = wslPath(s);
    return w == null ? null : shellQuote(w);
  }
  return shellQuote(s);
}

/** The line that goes to folder `quoted` in shell kind `q` (a leading space keeps it out of a POSIX history). */
export function cdLine(q: Quoting, quoted: string): string {
  if (q === "powershell") return ` Set-Location -LiteralPath ${quoted}\r`;
  if (q === "cmd") return ` cd /d ${quoted}\r`;
  return ` cd ${quoted}\r`;
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
