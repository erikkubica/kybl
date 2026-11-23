/**
 * Where a JSON text goes wrong. JSON.parse says so in V8 ("… at position 120") but not in
 * JavaScriptCore (macOS, iOS: "JSON Parse error: Expected '}'"), so the place is found here.
 */

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** Offset of the first character that makes `text` invalid JSON (text.length: it ends early), or -1 when valid. */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && WS.has(text.charCodeAt(i))) i++;
  };
  const word = (w: string) => {
    for (let k = 0; k < w.length; k++, i++) if (text[i] !== w[k]) return false;
    return true;
  };
  const string = () => {
    i++; // the opening quote
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return true;
      }
      if (c < 0x20) return false;
      if (c === 0x5c) {
        i++;
        const e = text[i];
        if (e === "u") {
          for (let k = 1; k <= 4; k++) if (!/[0-9a-fA-F]/.test(text[i + k] ?? "")) return ((i += k), false);
          i += 5;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i++;
        else return false;
      } else i++;
    }
    return false;
  };
  const digits = () => {
    const s = i;
    while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
    return i > s;
  };
  const number = () => {
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (!digits()) return false;
    if (text[i] === ".") {
      i++;
      if (!digits()) return false;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!digits()) return false;
    }
    return true;
  };
  // containers on a stack, so deep nesting can't overflow the call stack
  const stack: ("{" | "[")[] = [];
  const value = (): boolean => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      stack.push(c);
      i++;
      ws();
      if (text[i] === (c === "{" ? "}" : "]")) {
        stack.pop();
        i++;
        return true;
      }
      return c === "[" ? true : key();
    }
    if (c === '"') return string();
    if (c === "t") return word("true");
    if (c === "f") return word("false");
    if (c === "n") return word("null");
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    return false;
  };
  const key = () => {
    ws();
    if (text[i] !== '"' || !string()) return false;
    ws();
    if (text[i] !== ":") return false;
    i++;
    return true;
  };
  let need = true; // a value is due
  for (;;) {
    if (need) {
      const before = stack.length;
      if (!value()) return Math.min(i, n);
      // an opened container that expects its first value
      if (stack.length > before) continue;
    }
    need = false;
    ws();
    if (!stack.length) return i < n ? i : -1;
    const top = stack[stack.length - 1];
    if (text[i] === ",") {
      i++;
      if (top === "{" && !key()) return Math.min(i, n);
      need = true;
    } else if (text[i] === (top === "{" ? "}" : "]")) {
      stack.pop();
      i++;
    } else return Math.min(i, n);
  }
}

/** "Unexpected token } in JSON at position 120" → "Line 7, column 3: Unexpected token }". */
export function describeJsonError(text: string, message: string, firstLine = 1): string {
  const at = jsonErrorOffset(text);
  const clean = message
    // V8: "… in JSON at position 12 (line 1 column 13)", "… after JSON at position 12 …"
    .replace(/ (in|after) JSON at position \d+.*$/s, (_m, w: string) => (w === "after" ? " after JSON" : ""))
    .replace(/ \(line \d+ column \d+\)/g, "")
    // V8 quotes the text, cut short with "..." on either side when it's long
    .replace(/,\s*(?:\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s, "")
    .replace(/^JSON Parse error: /, "")
    .trim();
  if (at < 0) return clean;
  const before = text.slice(0, at);
  const line = before.split("\n").length + firstLine - 1;
  const col = at - before.lastIndexOf("\n");
  return `Line ${line}, column ${col}: ${clean}`;
}
