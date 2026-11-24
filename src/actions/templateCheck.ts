/**
 * The editor's side of the backend's `check_template` (src-tauri/src/actions.rs), kept in step
 * with it by tests/actions/template-vectors.json. A placeholder's value is single-quoted already,
 * and that only keeps it one plain word where the shell reads commands: outside every quote, or
 * inside `$( … )` (a fresh context, even inside double quotes). Anywhere else (quotes, `$'…'`,
 * backticks, `${ … }`, arithmetic, a here-document, a comment, the word after `>&`/`<&`, what a
 * builtin reads as code, or after a part shells read differently) the placeholder is refused: an
 * allow-list, not a list of known bad spots.
 */
const PLACEHOLDERS = ["path", "name", "ext", "stem", "paths", "dir"];

type Ctx =
  | { k: "plain" }
  | { k: "single" }
  | { k: "double" }
  | { k: "ansic" }
  | { k: "backtick" }
  /** `$( … )`, `${ … }`, `$(( … ))`/`(( … ))`, `$[ … ]` with how many of their brackets are open */
  | { k: "subst" | "brace" | "arith" | "arithsq"; n: number };

const WORD_BREAK = new Set([" ", "\t", "\n", "\r", ";", "&", "|", "(", ")", "<", ">"]);
const DUP_END = new Set(["\n", "\r", ";", "&", "|", "(", ")", "<", ">"]);
const SPECIAL = "$#?!-@*0123456789";
const blank = (c: string | undefined) => c === " " || c === "\t" || c === "\n";

/** Why the template can't be used, or null when it's fine. */
export function templateProblem(template: string): string | null {
  const stack: Ctx[] = [{ k: "plain" }];
  const t = template;
  const placeholderAt = (i: number) => PLACEHOLDERS.find((p) => t.startsWith(`{${p}}`, i));
  const wordStart = (i: number) => i === 0 || WORD_BREAK.has(t[i - 1]);
  // a here-document (`<<`, not bash's `<<<`) seen: its body is read like double quotes
  let heredoc = false;
  // something seen that shells read differently: what follows can't be proven
  let unsure = false;
  // in the word after `>&` or `<&` (bash 3.2 expands it once more): the stack depth there, and
  // whether the word has begun
  let dup: { depth: number; started: boolean } | null = null;
  for (let i = 0; i < t.length; i++) {
    const ctx = stack[stack.length - 1];
    const c = t[i];
    const code = ctx.k === "plain" || ctx.k === "subst";
    if (dup) {
      if (stack.length < dup.depth || (stack.length === dup.depth && DUP_END.has(c))) dup = null;
      else if (stack.length === dup.depth && (c === " " || c === "\t")) {
        if (dup.started) dup = null;
      } else dup.started = true;
    }
    if (c === "\\" && ctx.k !== "single") {
      const w = placeholderAt(i + 1);
      if (w) return `{${w}} comes right after a backslash. Take the backslash away: it would undo Kybl's quoting of the file name.`;
      // a line continuation inside a word joins two pieces the scan reads apart (`$\⏎'`)
      if (t[i + 1] === "\n" && i > 0 && !blank(t[i - 1]) && i + 2 < t.length && !blank(t[i + 2])) unsure = true;
      // dash and ash end `$'…'` at `\'` (no ANSI-C quoting there)
      if (ctx.k === "ansic" && t[i + 1] === "'") unsure = true;
    }
    // bash 3.2 ends `$( … )` at the first `)` of a `${ … }` in it
    if (c === ")") {
      const s = stack.findIndex((x) => x.k === "subst");
      if (s >= 0 && stack.slice(s).some((x) => x.k === "brace")) unsure = true;
    }
    if (code && t.startsWith("<<", i) && !t.startsWith("<<<", i) && t[i - 1] !== "<") heredoc = true;
    if (code && (c === ">" || c === "<") && t[i + 1] === "&") {
      dup = { depth: stack.length, started: false };
      i += 1;
      continue;
    }
    if (code && c === "#") {
      if (wordStart(i)) {
        // bash 3.2 finds the end of `$( … )` by counting parentheses, comments included
        if (stack.some((x) => x.k === "subst")) unsure = true;
        // a comment, to the end of the line: a value with a line break would end it
        let end = t.indexOf("\n", i);
        if (end < 0) end = t.length;
        for (let j = i; j < end; j++) {
          const w = t[j] === "{" ? placeholderAt(j) : undefined;
          if (w) return `{${w}} is in a comment (after #). Take it out of the comment.`;
        }
        i = end - 1;
        continue;
      }
      // csh reads a `#` inside a word as a comment too, sh doesn't (`$#` is a variable)
      if (t[i - 1] !== "$") unsure = true;
    }
    // `case` patterns end in a lone `)`, which would seem to close the `$( … )`
    if (ctx.k === "subst" && wordStart(i) && t.startsWith("case", i) && (i + 4 >= t.length || /[ \t\n\r\f]/.test(t[i + 4]))) unsure = true;
    if (c === "{" && t[i - 1] !== "$") {
      const w = placeholderAt(i);
      if (w) {
        if (heredoc) return `{${w}} is in a command with a here-document (<<). Pass it as an argument instead: inside a here-document a file name could run as a command.`;
        if (ctx.k === "single" || ctx.k === "double" || ctx.k === "ansic")
          return `{${w}} is inside quotes. Take the quotes away around it: Kybl quotes every placeholder itself, and inside other quotes a file name could run as a command.`;
        if (stack.some((s) => s.k === "backtick")) return `{${w}} is inside backticks. Use $( … ) instead: inside backticks a file name could run as a command.`;
        if (stack.some((s) => s.k === "brace")) return `{${w}} is inside \${ … }. Use it outside: in there Kybl's quoting of the file name doesn't hold.`;
        if (stack.some((s) => s.k === "arith" || s.k === "arithsq"))
          return `{${w}} is inside arithmetic ($(( … )) or (( … ))). Use it outside: in there a file name could run as a command.`;
        if (dup) return `{${w}} comes after >& or <&. Use > or < there instead: after >& some shells (bash on macOS) read the file name again as code.`;
        if (unsure)
          return `{${w}} comes after a part shells read differently (a # inside a word, case or a comment inside $( … ), a line break inside a word…). Put it before that part, or rewrite it.`;
        const why = operandProblem(t, i);
        if (why) return `{${w}} ${why}`;
      }
    }
    // a construct that opens here, and how many characters start it
    const opens = (double: boolean): [Ctx, number] | null => {
      const n1 = t[i + 1];
      if (c === "'" && !double) return [{ k: "single" }, 1];
      if (c === '"' && !double) return [{ k: "double" }, 1];
      if (c === "`") return [{ k: "backtick" }, 1];
      if (c === "$" && n1 === "'" && !double) return [{ k: "ansic" }, 2];
      if (c === "$" && n1 === "(" && t[i + 2] === "(") return [{ k: "arith", n: 0 }, 3];
      if (c === "$" && n1 === "(") return [{ k: "subst", n: 0 }, 2];
      if (c === "$" && n1 === "{") return [{ k: "brace", n: 0 }, 2];
      if (c === "$" && n1 === "[") return [{ k: "arithsq", n: 0 }, 2];
      if (c === "(" && n1 === "(" && code) return [{ k: "arith", n: 0 }, 2];
      return null;
    };
    // `$$`, `$#`, `$?`, `$1`…: a whole parameter, so a `$(` or `$'` right after it is not one
    const special = c === "$" && i + 1 < t.length && SPECIAL.includes(t[i + 1]);
    if (ctx.k === "single") {
      if (c === "'") stack.pop();
    } else if (ctx.k === "ansic" || ctx.k === "backtick") {
      if (c === "\\") i++;
      else if ((c === "'" && ctx.k === "ansic") || (c === "`" && ctx.k === "backtick")) stack.pop();
    } else if (ctx.k === "double") {
      if (c === "\\") i++;
      else if (c === '"') stack.pop();
      else if (special) i++;
      else {
        const o = opens(true);
        if (o) {
          stack.push(o[0]);
          i += o[1] - 1;
        }
      }
    } else {
      const o = c === "\\" || special ? null : opens(false);
      if (c === "\\" || special) i++;
      else if (o) {
        stack.push(o[0]);
        i += o[1] - 1;
      } else if (ctx.k !== "plain") {
        const [open, close] = ctx.k === "subst" || ctx.k === "arith" ? ["(", ")"] : ctx.k === "brace" ? ["{", "}"] : ["[", "]"];
        if (c === open) ctx.n++;
        else if (c === close && ctx.n > 0) ctx.n--;
        else if (c === close) {
          stack.pop();
          if (ctx.k === "arith") {
            // `))` ends it; a lone `)` means the shell may have read `$( (…) )`
            if (t[i + 1] === ")") i++;
            else unsure = true;
          }
        }
      }
    }
  }
  return null;
}

/** Builtins that read their operand as code (an arithmetic expression, `x[$(cmd)]`, a command). */
const CODE_BUILTINS = ["let", "eval", "trap", "read", "unset", "compgen", "complete", "mapfile", "readarray"];
/** Builtins whose operands are variable names, unless given as `name=value`. */
const NAME_BUILTINS = ["declare", "typeset", "local", "export", "readonly", "integer"];
/** Test operators that read both sides as numbers (ksh and `[[` evaluate them as arithmetic). */
const NUMERIC_TESTS = ["-eq", "-ne", "-lt", "-le", "-gt", "-ge"];
const LEAD = ["!", "{", "time", "command", "builtin", "exec", "nohup", "then", "do", "else", "elif", "if", "while", "until"];
const SEP = new Set([";", "&", "|", "\n", "(", ")", "`"]);
/** ASCII whitespace as Rust's `split_ascii_whitespace` sees it (not \v). */
const ASCII_WS = /[ \t\n\f\r]+/;

/** Mirror of `operand_problem` in actions.rs: why the placeholder at `at` goes where a builtin reads its value as code. */
function operandProblem(t: string, at: number): string | null {
  let start = at;
  while (start > 0 && !SEP.has(t[start - 1])) start--;
  let end = at;
  while (end < t.length && !SEP.has(t[end])) end++;
  const before = t.slice(start, at);
  const words = before.split(ASCII_WS).filter(Boolean);
  const glued = before.length > 0 && !/[ \t\n\f\r]$/.test(before);
  const cur = glued ? (words[words.length - 1] ?? "") : "";
  const done = glued ? words.slice(0, -1) : words;
  const prev = done[done.length - 1] ?? "";
  const assignment = (w: string) => {
    const e = w.indexOf("=");
    return e > 0 && /^[A-Za-z0-9_]+$/.test(w.slice(0, e));
  };
  const cmd = done.find((w) => !LEAD.includes(w) && !assignment(w)) ?? "";
  const code = "goes where the shell reads the value as code (let, read, trap, eval, -eq, an array index…), and a file name could run there. Pass it as a plain argument instead.";
  if (CODE_BUILTINS.includes(cmd)) return code;
  if (NAME_BUILTINS.includes(cmd) && !cur.includes("=")) return code;
  if (cmd === "printf" && prev === "-v") return code;
  if (cmd === "[[" || cmd === "[" || cmd === "test") {
    const all = t.slice(start, end).split(ASCII_WS);
    if (prev === "-v" || prev === "-R" || all.some((w) => NUMERIC_TESTS.includes(w))) return code;
  }
  const o = cur.lastIndexOf("[");
  if (o >= 0 && !cur.slice(o).includes("]")) return code;
  return null;
}
