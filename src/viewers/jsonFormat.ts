/**
 * JSON "Format" without a parse/stringify round trip: the text is re-indented token by token, so
 * number literals (big integers, `1.50`, `1e5`), key order and duplicate keys stay exactly as
 * written. Only whitespace outside strings changes. The caller checks validity (JSON.parse) first.
 */

/** Re-indents valid JSON. `indent` is a number of spaces or "\t". */
export function formatJson(src: string, indent: string | number = 2): string {
  const unit = typeof indent === "number" ? " ".repeat(indent) : indent;
  return reflow(src, unit);
}

/** The same value on one line with no extra whitespace (JSON Lines "Tidy lines"). */
export function compactJson(src: string): string {
  return reflow(src, null);
}

const WS = new Set([" ", "\t", "\n", "\r"]);
const STOP = new Set([" ", "\t", "\n", "\r", ",", ":", "{", "}", "[", "]", '"']);

function reflow(src: string, unit: string | null): string {
  let out = "";
  let depth = 0;
  const nl = () => (unit === null ? "" : "\n" + unit.repeat(depth));
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      // an empty container stays `{}` / `[]`
      let j = i + 1;
      while (j < n && WS.has(src[j])) j++;
      if (src[j] === (c === "{" ? "}" : "]")) {
        out += c + src[j];
        i = j + 1;
        continue;
      }
      depth++;
      out += c + nl();
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      depth = Math.max(0, depth - 1);
      out += nl() + c;
      i++;
      continue;
    }
    if (c === ",") {
      out += "," + nl();
      i++;
      continue;
    }
    if (c === ":") {
      out += unit === null ? ":" : ": ";
      i++;
      continue;
    }
    // numbers, true/false/null: copy the literal exactly as written
    let j = i;
    while (j < n && !STOP.has(src[j])) j++;
    out += src.slice(i, j);
    i = j;
  }
  return out;
}
