/**
 * The editor's side of the backend's `check_template` (src-tauri/src/actions.rs), kept in step
 * with it by tests/actions/template-vectors.json. A placeholder's value is single-quoted already,
 * and that only keeps it one plain word where the shell reads commands: outside every quote, or
 * inside `$( … )` (a fresh context, even inside double quotes). Anywhere else (quotes, `$'…'`,
 * backticks, `${ … }`, arithmetic, a here-document, a comment, or after a part shells read
 * differently) the placeholder is refused: an allow-list, not a list of known bad spots.
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
  for (let i = 0; i < t.length; i++) {
    const ctx = stack[stack.length - 1];
    const c = t[i];
    const code = ctx.k === "plain" || ctx.k === "subst";
    if (c === "\\" && ctx.k !== "single") {
      const w = placeholderAt(i + 1);
      if (w) return `{${w}} comes right after a backslash. Take the backslash away: it would undo Kybl's quoting of the file name.`;
    }
    if (code && t.startsWith("<<", i) && !t.startsWith("<<<", i) && t[i - 1] !== "<") heredoc = true;
    if (code && c === "#") {
      if (wordStart(i)) {
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
    if (ctx.k === "subst" && wordStart(i) && t.startsWith("case", i) && (i + 4 >= t.length || /\s/.test(t[i + 4]))) unsure = true;
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
        if (unsure) return `{${w}} comes after a part shells read differently (a # inside a word, or case inside $( … )). Put it before that part, or rewrite it.`;
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
    if (ctx.k === "single") {
      if (c === "'") stack.pop();
    } else if (ctx.k === "ansic" || ctx.k === "backtick") {
      if (c === "\\") i++;
      else if ((c === "'" && ctx.k === "ansic") || (c === "`" && ctx.k === "backtick")) stack.pop();
    } else if (ctx.k === "double") {
      if (c === "\\") i++;
      else if (c === '"') stack.pop();
      else {
        const o = opens(true);
        if (o) {
          stack.push(o[0]);
          i += o[1] - 1;
        }
      }
    } else {
      const o = c === "\\" ? null : opens(false);
      if (c === "\\") i++;
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
