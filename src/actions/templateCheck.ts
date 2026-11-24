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

/** Why the template can't be used, or null when it's fine. */
export function templateProblem(template: string): string | null {
  const stack: Ctx[] = [{ k: "plain" }];
  // the shell deletes every backslash + line break before it reads a word, so scan what it will
  // read: a placeholder after `>&\⏎   ` or `$\⏎'` is then judged where the shell puts it (R8 S-6).
  // An odd run of backslashes before the break; an even run is escaped backslashes and a real break.
  const t = template.replace(/(?<!\\)((?:\\\\)*)\\\n/g, "$1");
  const placeholderAt = (i: number) => PLACEHOLDERS.find((p) => t.startsWith(`{${p}}`, i));
  const wordStart = (i: number) => i === 0 || WORD_BREAK.has(t[i - 1]);
  // a here-document (`<<`, not bash's `<<<`) seen: its body is read like double quotes
  let heredoc = false;
  // something seen that shells read differently: what follows can't be proven
  let unsure = false;
  // in the word after `>&` or `<&` (bash 3.2 expands it once more): the stack depth there, and
  // whether the word has begun
  let dup: { depth: number; started: boolean } | null = null;
  // an expansion (`$…` or backticks) seen in a word after `>&` or `<&`: bash 3.2 expands that word
  // twice, so a variable holding a file name runs there (R8 S-3). Refused with a placeholder.
  let dupExpansion = false;
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
    if (dup && stack.length >= dup.depth && (c === "$" || c === "`")) dupExpansion = true;
    if (c === "\\" && ctx.k !== "single") {
      const w = placeholderAt(i + 1);
      if (w) return `{${w}} comes right after a backslash. Take the backslash away: it would undo Kybl's quoting of the file name.`;
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
  if (PLACEHOLDERS.some((p) => uses(t, p))) {
    if (dupExpansion) return codeWhy("an expansion after `>&` or `<&` (bash on macOS reads that word twice)");
    return evaluationProblem(t);
  }
  return null;
}

/** Mirror of `uses` in actions.rs: the placeholder's word, not the shell's `${word}`. */
function uses(t: string, word: string): boolean {
  const needle = `{${word}}`;
  for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + 1)) if (t[i - 1] !== "$") return true;
  return false;
}

const ARITH_WHY =
  "This template has a placeholder and also does arithmetic (`$(( ))`, `(( ))`, `$[ ]`, let, -eq and the like, declare -i, an array index). A shell reads a variable it is used with as code there, so a file name such as a[$(cmd)] would run as a command, even though the placeholder is quoted. Do the arithmetic in a script of your own, or take the placeholder out of this template.";
const EVAL_WHY =
  "This template has a placeholder and also eval, which runs text as code, so a file name could run as a command even though the placeholder is quoted. Take eval out of this template.";
const DECLARING = ["declare", "typeset", "local", "export", "readonly"];

/** The refusal for a construct that can read a variable's value as code. */
const codeWhy = (what: string) =>
  `This template has a placeholder and also ${what}. A file name could run code through it, even though the placeholder is quoted. Take it out of this template, or do that part in a script of your own.`;

/**
 * Builtins refused anywhere in a template that has a placeholder: each reads or runs a variable's
 * value as code (a name with a subscript, a handler, an expression), or sets what the shell
 * evaluates later. A false alarm costs a rewrite, a miss runs a file name.
 */
const BANNED_WORDS = ["read", "unset", "trap", "mapfile", "readarray", "compgen", "complete", "vared", "repeat"];
/** Builtins that read their operand as arithmetic in zsh or ksh: refused when given anything but `$?`, `$#` or `$$`. */
const NUMBER_BUILTINS = ["exit", "return", "break", "continue", "shift", "logout", "ulimit"];
/** Variables whose value the shell runs (every traced line, every prompt, the next shell). */
const RUNNING_VARS = ["PS4", "PROMPT_COMMAND", "BASH_ENV"];
/**
 * Variables the shell itself evaluates or runs when they are set (integer ones read the value as
 * arithmetic, so `a[$(cmd)]` runs; `ENV` is read by an interactive sh; the rest change how words
 * split or where commands come from). Assigning any of them is refused (R8 S-3).
 */
const SPECIAL_VARS = ["OPTIND", "OPTARG", "RANDOM", "SECONDS", "TMOUT", "LINENO", "SHLVL", "MAILCHECK", "ENV", "BASH_ENV", "PS4", "PROMPT_COMMAND", "IFS", "PATH"];

/** Mirror of `brace_problem` in actions.rs: what `${body}` is when it is not an allowed form; null when it is allowed. */
function braceProblem(body: string): string | null {
  const textOk = (x: string) => !/[{}()`"'\\\n]/.test(x);
  const other = "a `${ … }` this check can't prove plain";
  if (body.includes("${")) return "a nested `${ … ${ … } … }`";
  if (body.startsWith("!")) return "`${!name}` (indirect expansion, which evaluates the name it reads)";
  if (body.startsWith("(")) return "a zsh `${(flags)name}` (flags such as e or P evaluate the value)";
  const count = body.startsWith("#");
  const rest = count ? body.slice(1) : body;
  const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?$])/.exec(rest);
  if (!m) return count && rest === "" ? null : other;
  const name = m[0];
  const tail = rest.slice(name.length);
  if (tail === "") return null;
  if (tail === "[@]" || tail === "[*]") return /^[A-Za-z_]/.test(name) ? null : "a subscript on a number or symbol";
  if (tail.startsWith("[")) return "a subscript `${name[ … ]}` (evaluated as arithmetic)";
  if (count) return other;
  if (tail.startsWith(":")) {
    const w = tail.slice(1);
    if ("-=+?".includes(w[0] ?? "x")) return textOk(w.slice(1)) ? null : "a `${name:-word}` whose word holds quotes, brackets or braces";
    return "a substring `${name:offset}` (the offset is evaluated as arithmetic)";
  }
  for (const op of ["%%", "%", "##", "#"]) {
    if (tail.startsWith(op)) return textOk(tail.slice(op.length)) ? null : "a `${name%pattern}` whose pattern holds quotes, brackets or braces";
  }
  for (const op of ["//", "/"]) {
    if (tail.startsWith(op)) {
      const r = tail.slice(op.length);
      const cut = r.indexOf("/");
      if (cut >= 0 && textOk(r.slice(0, cut)) && textOk(r.slice(cut + 1)) && !r.slice(cut + 1).includes("/")) return null;
      return "a `${name/pattern/text}` this check can't prove plain";
    }
  }
  return other;
}

/**
 * Mirror of `evaluation_problem` in actions.rs. A template with a placeholder that can evaluate a
 * variable is refused whole: quoting only keeps the value one word, and a shell that later
 * evaluates a variable holding it reads it as code. An ALLOW-LIST for parameter expansion (see
 * `braceProblem`; anything else in `${ … }`, and any subscript but `[@]`/`[*]`, is refused), plus
 * refused outright: arithmetic, `eval`, `read`, `unset`, `trap`, `mapfile`/`readarray`,
 * `printf -v`, `test -v`, `exit $x` and kin, and `PS4`/`PROMPT_COMMAND`/`BASH_ENV`.
 */
function evaluationProblem(t: string): string | null {
  if (t.includes("((") || t.includes("$[")) return ARITH_WHY;
  // the words as the shell will see them: `r""ead` and `\read` are `read`
  const plain = t.replace(/['"\\]/g, "");
  for (const w of plain.split(/[ \t\n\f\r;&|()`<>{}$=]/)) {
    if (w === "eval") return EVAL_WHY;
    if (w === "let" || w === "integer" || w === "float" || NUMERIC_TESTS.includes(w)) return ARITH_WHY;
    if (BANNED_WORDS.includes(w)) return codeWhy(`\`${w}\`, which reads a variable's value as code or runs it`);
    if (RUNNING_VARS.includes(w)) return codeWhy(`\`${w}\`, which the shell runs as code`);
  }
  // `(` and backticks stay inside the words here, so an expansion given as a name shows
  for (const command of plain.split(/[;&|\n]/)) {
    const words = command.split(ASCII_WS).filter(Boolean);
    const has = (x: string) => words.includes(x);
    // a declaring builtin given a flag that makes the variable numeric or a name reference
    if (words.some((w) => DECLARING.includes(w))) {
      const flagged = (set: RegExp) => words.some((w) => w.startsWith("-") && !w.startsWith("--") && set.test(w));
      if (flagged(/[iFE]/)) return ARITH_WHY;
      if (flagged(/n/)) return codeWhy("`declare -n` (a name reference, which reads a variable's value as a name with a subscript)");
    }
    if ((has("printf") || has("print")) && has("-v")) return codeWhy("`printf -v`, which takes its variable name as code");
    if ((has("[") || has("[[") || has("test")) && (has("-v") || has("-R"))) return codeWhy("a `-v` or `-R` test, which takes its variable name as code");
    // the command word: the first after keywords, prefixes and `NAME=value` assignments
    // (`f() {` before it is a function header)
    const cmdAt = words.findIndex((w) => !LEAD.includes(w) && !isAssignment(w) && !w.endsWith("()"));
    // an assignment (`X=…`, `export X=…`, `for X in …`) to a variable the shell evaluates
    for (let k = 0; k < words.length; k++) {
      const eq = words[k].indexOf("=");
      const n = eq > 0 ? words[k].slice(0, eq).replace(/\+$/, "") : k > 0 && words[k - 1] === "for" ? words[k] : "";
      if (SPECIAL_VARS.includes(n)) return codeWhy(`an assignment to \`${n}\`, which the shell evaluates or runs`);
    }
    // a variable name given to a declaring builtin as an expansion: the shell reads a name with a
    // subscript (`a[$(cmd)]`) as code, so `declare "$v"=1` or `export "$v"` runs a file name in $v
    if (cmdAt >= 0 && NAME_BUILTINS.includes(words[cmdAt])) {
      const named = words.slice(cmdAt + 1).filter((w) => !/^[-+]/.test(w));
      if (named.some((w) => /[$`(]/.test(w.split("=")[0]))) return codeWhy(`an expansion as the variable name for \`${words[cmdAt]}\` (a name with a subscript runs as code)`);
    }
    // ksh reads a bare variable name as arithmetic too (`shift n`, `ulimit -n n`)
    if (cmdAt >= 0 && (words[cmdAt] === "shift" || words[cmdAt] === "ulimit")) {
      const literal = (w: string) => /^[0-9]*$/.test(w) || ["$?", "$#", "$$", "unlimited", "hard", "soft"].includes(w);
      if (words.slice(cmdAt + 1).some((w) => !w.startsWith("-") && !literal(w))) return codeWhy(`\`${words[cmdAt]}\` with a variable or expression (ksh reads it as arithmetic)`);
    }
    const at = words.findIndex((w) => NUMBER_BUILTINS.includes(w));
    if (at >= 0 && words.slice(at + 1).some((w) => w.includes("$") && !["$?", "$#", "$$"].includes(w))) {
      return codeWhy(`\`${words[at]}\` with a variable (zsh and ksh read it as arithmetic)`);
    }
  }
  const ident = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "$" && t[i + 1] === "{") {
      // up to the first `}`; one that is missing, or a body that isn't plain, is refused
      const close = t.indexOf("}", i + 2);
      if (close < 0) return codeWhy("a `${` with no closing `}`");
      const what = braceProblem(t.slice(i + 2, close));
      if (what) return codeWhy(what);
      i = close;
    } else if (t[i] === "[" && i > 0) {
      const prev = t[i - 1];
      const close = t.indexOf("]", i);
      const inner = t.slice(i + 1, close < 0 ? t.length : close);
      let k = i;
      while (k > 0 && ident(t[k - 1])) k--;
      // what the subscript hangs on: `$name[`, `${name}[`, `$1[`, `$@[` (zsh reads those as subscripts).
      // `${name[@]}` never gets here: its whole body was checked above.
      const onParam = (k < i && k > 0 && t[k - 1] === "$") || prev === "}" || (i > 1 && "@*#?$".includes(prev) && t[i - 2] === "$");
      if (onParam) return codeWhy("a subscript (`name[ … ]`, evaluated as arithmetic; only `${name[@]}` and `${name[*]}` are allowed)");
      if (k < i && !/[0-9]/.test(t[k]) && (/[$`()]/.test(inner) || /[A-Za-z_]/.test(inner))) return codeWhy("a subscript (`name[ … ]`, evaluated as arithmetic)");
    }
  }
  return null;
}

/** Builtins that read their operand as code (an arithmetic expression, `x[$(cmd)]`, a command); `exit` and kin in zsh, `shift` and `ulimit` in ksh, `repeat` and `vared` in zsh. */
const CODE_BUILTINS = ["let", "eval", "trap", "read", "unset", "compgen", "complete", "mapfile", "readarray", "exit", "return", "break", "continue", "shift", "logout", "repeat", "vared", "ulimit"];
/** Builtins whose operands are variable names, unless given as `name=value`. */
const NAME_BUILTINS = ["declare", "typeset", "local", "export", "readonly", "integer"];
/** Test operators that read both sides as numbers (ksh and `[[` evaluate them as arithmetic). */
const NUMERIC_TESTS = ["-eq", "-ne", "-lt", "-le", "-gt", "-ge"];
/** Words that come before the command word in a command line. */
const LEAD = ["!", "{", "time", "command", "builtin", "exec", "nohup", "then", "do", "else", "elif", "if", "while", "until"];
/** `NAME=value` as a command prefix. */
const isAssignment = (w: string) => {
  const e = w.indexOf("=");
  return e > 0 && /^[A-Za-z0-9_]+$/.test(w.slice(0, e));
};
const SEP = new Set([";", "&", "|", "\n", "(", ")", "`"]);
/** ASCII whitespace as Rust's `split_ascii_whitespace` sees it (not \v). */
const ASCII_WS = /[ \t\n\f\r]+/;

/** Mirror of `operand_problem` in actions.rs: why the placeholder at `at` goes where a builtin reads its value as code. */
function operandProblem(t: string, at: number): string | null {
  let start = at;
  while (start > 0 && !SEP.has(t[start - 1])) start--;
  let end = at;
  while (end < t.length && !SEP.has(t[end])) end++;
  // inside `[[ … ]]`, `&`, `|`, `(` and `)` group tests and don't end the command: one test
  const open = t.lastIndexOf("[[", at - 1);
  if (open >= 0 && open < at) {
    const word = (open === 0 || /[ \t\n\f\r]/.test(t[open - 1]) || SEP.has(t[open - 1])) && /[ \t\n\f\r]/.test(t[open + 2] ?? "x");
    if (word && !t.slice(open, at).includes("]]")) {
      start = open;
      const close = t.indexOf("]]", at);
      end = close < 0 ? t.length : close;
    }
  }
  const before = t.slice(start, at);
  const words = before.split(ASCII_WS).filter(Boolean);
  const glued = before.length > 0 && !/[ \t\n\f\r]$/.test(before);
  const cur = glued ? (words[words.length - 1] ?? "") : "";
  const done = glued ? words.slice(0, -1) : words;
  const prev = done[done.length - 1] ?? "";
  const cmd = done.find((w) => !LEAD.includes(w) && !isAssignment(w)) ?? "";
  const code = "goes where the shell reads the value as code (let, read, trap, eval, -eq, an array index…), and a file name could run there. Pass it as a plain argument instead.";
  if (CODE_BUILTINS.includes(cmd)) return code;
  if (NAME_BUILTINS.includes(cmd) && !cur.includes("=")) return code;
  if ((cmd === "printf" || cmd === "print") && prev === "-v") return code;
  if (cmd === "[[" || cmd === "[" || cmd === "test") {
    const all = t.slice(start, end).split(ASCII_WS);
    if (prev === "-v" || prev === "-R" || all.some((w) => NUMERIC_TESTS.includes(w))) return code;
  }
  const o = cur.lastIndexOf("[");
  if (o >= 0 && !cur.slice(o).includes("]")) return code;
  return null;
}
