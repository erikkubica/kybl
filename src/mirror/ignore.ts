/**
 * Exclude rules for Mirror, written like a .gitignore: one pattern per line, `#` comments,
 * `!pattern` takes a file back in, a trailing `/` matches folders only, a pattern with a `/`
 * before its end is anchored to the top of the mirrored folder (a leading `/` too), otherwise it
 * matches a name at any depth. `*` and `?` stay within one name, `**` crosses folders, `[a-z]`
 * is a set. As in git, nothing inside an excluded folder can be taken back in (the folder isn't
 * even listed).
 *
 * No imports: the tests run it with plain `node --test`.
 */

type Rule = { re: RegExp; negate: boolean; dirOnly: boolean; anchored: boolean };

export type Matcher = {
  /** `rel`: a path under the mirrored folder, without a trailing `/` */
  (rel: string, isDir: boolean): boolean;
  /** how many rules it has (blank lines and comments left out) */
  size: number;
};

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A glob as a regular expression body (see the header for what each character means). */
function globBody(g: string): string {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const atStart = i === 0 || g[i - 1] === "/";
        const next = g[i + 2];
        if (atStart && next === "/") {
          // "**/": no folders or any number of them
          re += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (atStart && next === undefined) {
          // "/**" at the end: everything inside
          re += ".*";
          i += 1;
          continue;
        }
        // "**" anywhere else is an ordinary "*"
        i += 1;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      let set = g.slice(i + 1, end);
      const neg = set[0] === "!" || set[0] === "^";
      if (neg) set = set.slice(1);
      re += `[${neg ? "^" : ""}${set.replace(/\\/g, "\\\\").replace(/]/g, "\\]")}]`;
      i = end;
    } else if (c === "\\" && i + 1 < g.length) re += escapeRe(g[++i]);
    else re += escapeRe(c);
  }
  return re;
}

function parseLine(raw: string): Rule | null {
  // trailing spaces don't count (unless escaped), leading ones do in git but never mean to
  let line = raw.replace(/(?<!\\)\s+$/, "").replace(/^\s+/, "");
  if (!line || line.startsWith("#")) return null;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.replace(/\/+$/, "");
  const anchored = line.includes("/");
  line = line.replace(/^\/+/, "");
  if (!line) return null;
  return { re: new RegExp(`^${globBody(line)}$`), negate, dirOnly, anchored };
}

/** The rules in `text` (newline-separated, as a .gitignore) or a list of patterns. */
export function parseRules(text: string | string[]): Rule[] {
  const lines = Array.isArray(text) ? text : text.split(/\r?\n/);
  return lines.map(parseLine).filter((r): r is Rule => r !== null);
}

/** Whether a single path (not its folders) is excluded by the last rule that matches it. */
function decide(rules: Rule[], path: string, name: string, isDir: boolean): boolean {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(r.anchored ? path : name)) out = !r.negate;
  }
  return out;
}

/**
 * A matcher for the patterns in `texts` (each a .gitignore's text or a list); later ones win over
 * earlier ones, as later lines do. A path is excluded when it is, or a folder above it is.
 */
export function makeMatcher(...texts: (string | string[])[]): Matcher {
  const rules = texts.flatMap((t) => parseRules(t));
  const memo = new Map<string, boolean>();
  const dirExcluded = (path: string): boolean => {
    let v = memo.get(path);
    if (v === undefined) {
      const cut = path.lastIndexOf("/");
      v = (cut > 0 && dirExcluded(path.slice(0, cut))) || decide(rules, path, path.slice(cut + 1), true);
      memo.set(path, v);
    }
    return v;
  };
  const m = ((rel: string, isDir: boolean) => {
    if (!rules.length) return false;
    const path = rel.replace(/^\/+|\/+$/g, "");
    if (!path) return false;
    if (isDir) return dirExcluded(path);
    const cut = path.lastIndexOf("/");
    if (cut > 0 && dirExcluded(path.slice(0, cut))) return true;
    return decide(rules, path, path.slice(cut + 1), false);
  }) as Matcher;
  m.size = rules.length;
  return m;
}

/** What a new mirror leaves out: version control, dependencies, system clutter, secrets. */
export const DEFAULT_EXCLUDES = [".git/", "node_modules/", ".DS_Store", "Thumbs.db", ".env"].join("\n");
