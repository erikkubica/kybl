/**
 * The editor's side of the backend's `check_template` (src-tauri/src/actions.rs): a placeholder
 * inside the template's own quotes (`"{path}"`) or backticks is refused, because the value is
 * quoted already and inside other quotes that quoting doesn't hold (`"'$(cmd)'"` runs `cmd`).
 * Read the way sh reads it; `$( … )` starts a fresh, unquoted context even inside double quotes.
 */
const PLACEHOLDERS = ["path", "name", "ext", "stem", "paths", "dir"];

type Ctx = "plain" | "single" | "double" | "backtick" | { subst: number };

/** Why the template can't be used, or null when it's fine. */
export function templateProblem(template: string): string | null {
  const stack: Ctx[] = ["plain"];
  const placeholderAt = (i: number) => PLACEHOLDERS.find((p) => template.startsWith(`{${p}}`, i));
  // a here-document (`<<`, not bash's `<<<`) seen: its body is read like double quotes
  let heredoc = false;
  for (let i = 0; i < template.length; i++) {
    const ctx = stack[stack.length - 1];
    const c = template[i];
    if (c === "\\" && ctx !== "single") {
      const w = placeholderAt(i + 1);
      if (w) return `{${w}} comes right after a backslash. Take the backslash away: it would undo Kybl's quoting of the file name.`;
    }
    if ((ctx === "plain" || typeof ctx === "object") && template.startsWith("<<", i) && !template.startsWith("<<<", i) && template[i - 1] !== "<") heredoc = true;
    if (c === "{" && template[i - 1] !== "$") {
      const w = placeholderAt(i);
      if (w) {
        if (heredoc) return `{${w}} is in a command with a here-document (<<). Pass it as an argument instead: inside a here-document a file name could run as a command.`;
        if (ctx === "single" || ctx === "double")
          return `{${w}} is inside quotes. Take the quotes away around it: Kybl quotes every placeholder itself, and inside other quotes a file name could run as a command.`;
        if (stack.includes("backtick")) return `{${w}} is inside backticks. Use $( … ) instead: inside backticks a file name could run as a command.`;
      }
    }
    if (ctx === "single") {
      if (c === "'") stack.pop();
    } else if (ctx === "double") {
      if (c === "\\") i++;
      else if (c === '"') stack.pop();
      else if (c === "`") stack.push("backtick");
      else if (c === "$" && template[i + 1] === "(") {
        stack.push({ subst: 0 });
        i++;
      }
    } else if (ctx === "backtick") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
    } else {
      if (c === "\\") i++;
      else if (c === "'") stack.push("single");
      else if (c === '"') stack.push("double");
      else if (c === "`") stack.push("backtick");
      else if (c === "$" && template[i + 1] === "(") {
        stack.push({ subst: 0 });
        i++;
      } else if (typeof ctx === "object" && c === "(") ctx.subst++;
      else if (typeof ctx === "object" && c === ")") {
        if (ctx.subst === 0) stack.pop();
        else ctx.subst--;
      }
    }
  }
  return null;
}
