/**
 * Batch rename: turns a set of items and the rules from the Batch rename dialog into new names,
 * and says which of them can't be used (empty, "/", too long, the same name twice, or a name that
 * is already taken in that folder). Pure: no I/O, so the preview can run it on every keystroke
 * for thousands of items, and it can be tested on its own.
 *
 * Pattern variables:
 *   {name}  the name without its extension      {ext}   the extension, without the dot
 *   {n}     counter ({n:3} pads it to 3 digits)  {date}  modified date ({date:YYYY-MM-DD HH.mm})
 *   {size}  size ("2.4 MB")                      {folder} the folder the item is in
 *
 * The extension is added back on its own unless the pattern places {ext} itself, so
 * "Trip {n:3}" turns "IMG_1.JPG" into "Trip 001.JPG".
 */

export type BatchItem = { key: string; name: string; folder: boolean; modified: number | null; size: number };

export type CaseMode = "keep" | "lower" | "upper" | "title";
export type ExtMode = "keep" | "lower" | "upper" | "change" | "remove";
export type OrderMode = "view" | "name" | "date";

export type Rules = {
  mode: "pattern" | "replace";
  pattern: string;
  start: number;
  step: number;
  order: OrderMode;
  find: string;
  replace: string;
  regex: boolean;
  matchCase: boolean;
  case: CaseMode;
  ext: ExtMode;
  /** the new extension when `ext` is "change" (a leading dot is ignored) */
  extTo: string;
};

export const DEFAULT_RULES: Rules = {
  mode: "pattern",
  pattern: "{name} {n}",
  start: 1,
  step: 1,
  order: "view",
  find: "",
  replace: "",
  regex: false,
  matchCase: false,
  case: "keep",
  ext: "keep",
  extTo: "",
};

/** The variables the dialog offers as chips, in that order. */
export const VARIABLES: { token: string; label: string }[] = [
  { token: "{name}", label: "Original name" },
  { token: "{n}", label: "Counter" },
  { token: "{n:3}", label: "Counter, 3 digits (001)" },
  { token: "{date}", label: "Modified date (2026-11-23)" },
  { token: "{ext}", label: "Extension, placed yourself" },
  { token: "{folder}", label: "Folder name" },
  { token: "{size}", label: "Size (2.4 MB)" },
];

export type RowStatus = "ok" | "same" | "invalid" | "conflict";
export type PlanRow = { item: BatchItem; from: string; to: string; toKey: string; status: RowStatus; reason?: string };
export type Plan = {
  /** in counter order */
  rows: PlanRow[];
  /** what is wrong with the rules themselves (an unknown variable, a broken regex) */
  error: string | null;
  changed: number;
  same: number;
  problems: number;
};

export type PlanContext = {
  /** keys of everything else in the listing: names taken that the batch doesn't free */
  others: Iterable<string>;
  /** the root's name, for {folder} of items at the top */
  rootName?: string;
  /** names differing only in case are the same file (this computer's disk on macOS / Windows) */
  foldCase?: boolean;
};

/** Longest name most file systems take, in UTF-8 bytes. */
export const MAX_NAME_BYTES = 255;
/** S3's limit on a whole key, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 1024;

const bytes = (s: string) => new TextEncoder().encode(s).length;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** "photo.final.JPG" → ["photo.final", "JPG"]; folders and ".env" have no extension. */
export function splitName(name: string, folder: boolean): [string, string] {
  if (folder) return [name, ""];
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ""];
}

/** The folder an item is in ("photos/2024/" for "photos/2024/a.jpg"), "" at the top. */
export function parentOf(key: string): string {
  const k = key.endsWith("/") ? key.slice(0, -1) : key;
  return k.slice(0, k.lastIndexOf("/") + 1);
}

const pad = (n: number, width: number) => (n < 0 ? "-" : "") + String(Math.abs(n)).padStart(width, "0");

/** {date:FORMAT}: YYYY YY MM DD HH mm ss, in local time. */
export function formatDate(ms: number, format = "YYYY-MM-DD"): string {
  const d = new Date(ms);
  const parts: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1, 2),
    DD: pad(d.getDate(), 2),
    HH: pad(d.getHours(), 2),
    mm: pad(d.getMinutes(), 2),
    ss: pad(d.getSeconds(), 2),
  };
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => parts[t]);
}

function sizeLabel(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = -1;
  do {
    v /= 1000;
    i++;
  } while (v >= 1000 && i < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function applyCase(s: string, mode: CaseMode): string {
  switch (mode) {
    case "lower":
      return s.toLowerCase();
    case "upper":
      return s.toUpperCase();
    case "title":
      // the first letter of each word: after the start, a space, "_", "-", "." or a bracket
      return s.toLowerCase().replace(/(^|[\s_\-.([{])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
    default:
      return s;
  }
}

const VAR = /\{(\w+)(?::([^{}]*))?\}/g;
const KNOWN = new Set(["name", "ext", "n", "date", "size", "folder"]);

/** What is wrong with a pattern, or null. */
export function patternError(pattern: string): string | null {
  if (!pattern.trim()) return "Type a pattern";
  for (const m of pattern.matchAll(VAR)) {
    const [whole, v, arg] = m;
    if (!KNOWN.has(v)) return `Unknown variable ${whole}`;
    if (v === "n" && arg !== undefined && !/^\d{1,2}$/.test(arg)) return `${whole}: the number after “:” is how many digits, like {n:3}`;
  }
  return null;
}

/** Builds the find & replace function, or says why the regex is broken. */
function replacer(r: Rules): ((s: string) => string) | string {
  if (!r.find) return (s) => s;
  const flags = r.matchCase ? "g" : "gi";
  if (r.regex) {
    try {
      const re = new RegExp(r.find, flags + "u");
      return (s) => s.replace(re, r.replace);
    } catch (e) {
      return `Regular expression: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : String(e)}`;
    }
  }
  const re = new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  // plain text: "$1" in the replacement is just text
  return (s) => s.replace(re, () => r.replace);
}

// stands in for the extension while the case is changed, so "keep extension" survives UPPERCASE
const EXT_MARK = "";

/** Items in the order the counter numbers them. */
export function ordered(items: BatchItem[], order: OrderMode): BatchItem[] {
  if (order === "view") return items.slice();
  const list = items.slice();
  if (order === "name") return list.sort((a, b) => byName.compare(a.name, b.name));
  return list.sort((a, b) => (a.modified ?? 0) - (b.modified ?? 0) || byName.compare(a.name, b.name));
}

/** The new name of each item (in counter order), checked. */
export function planRenames(items: BatchItem[], rules: Rules, ctx: PlanContext): Plan {
  const list = ordered(items, rules.order);
  const fold = (s: string) => (ctx.foldCase ? s.toLowerCase() : s);
  let error: string | null = null;
  let rep: ((s: string) => string) | null = null;
  if (rules.mode === "pattern") error = patternError(rules.pattern);
  else {
    const f = replacer(rules);
    if (typeof f === "string") error = f;
    else rep = f;
  }
  const usesExt = rules.mode === "pattern" && /\{ext\}/.test(rules.pattern);
  const extTo = rules.extTo.trim().replace(/^\.+/, "");

  const rows: PlanRow[] = list.map((item, i) => {
    const [base, ext0] = splitName(item.name, item.folder);
    const ext = item.folder
      ? ""
      : rules.ext === "lower"
        ? ext0.toLowerCase()
        : rules.ext === "upper"
          ? ext0.toUpperCase()
          : rules.ext === "change"
            ? extTo || ext0
            : rules.ext === "remove"
              ? ""
              : ext0;
    let stem: string;
    if (error) stem = base;
    else if (rules.mode === "pattern") {
      const n = rules.start + i * rules.step;
      stem = rules.pattern.replace(VAR, (_, v: string, arg?: string) => {
        switch (v) {
          case "name":
            return base;
          case "ext":
            return EXT_MARK;
          case "n":
            return pad(n, arg ? Number(arg) : 0);
          case "date":
            return item.modified == null ? "" : formatDate(item.modified, arg || undefined);
          case "size":
            return item.folder ? "" : sizeLabel(item.size);
          case "folder": {
            const p = parentOf(item.key);
            return p ? p.slice(0, -1).split("/").pop()! : (ctx.rootName ?? "");
          }
          default:
            return _;
        }
      });
    } else stem = rep!(base);
    stem = applyCase(stem, rules.case);
    // a dot the user typed at the end ("Trip.") doesn't double up with the extension's
    const to = (usesExt ? stem.split(EXT_MARK).join(ext) : ext ? `${stem.replace(/\.$/, "")}.${ext}` : stem).trim();
    const parent = parentOf(item.key);
    const toKey = parent + to + (item.folder ? "/" : "");
    return { item, from: item.name, to, toKey, status: "ok" as RowStatus };
  });
  if (error) return { rows: rows.map((r) => ({ ...r, to: r.from, toKey: r.item.key, status: "same" })), error, changed: 0, same: rows.length, problems: 0 };

  // names that stay taken: everything outside the batch, and batch items that keep their name.
  // Compared without a folder's trailing "/": a file and a folder can't share a name on a disk.
  const strip = (k: string) => fold(k.endsWith("/") ? k.slice(0, -1) : k);
  const batchKeys = new Set(rows.map((r) => strip(r.item.key)));
  const taken = new Set<string>();
  for (const k of ctx.others) if (!batchKeys.has(strip(k))) taken.add(strip(k));
  for (const r of rows) if (r.to === r.from) taken.add(strip(r.item.key));
  const count = new Map<string, number>();
  for (const r of rows) if (r.to !== r.from) count.set(strip(r.toKey), (count.get(strip(r.toKey)) ?? 0) + 1);

  let changed = 0;
  let same = 0;
  let problems = 0;
  for (const r of rows) {
    const t = r.to;
    if (!t) Object.assign(r, { status: "invalid", reason: "Empty name" });
    else if (t.includes("/")) Object.assign(r, { status: "invalid", reason: "Contains “/”" });
    else if (t === "." || t === "..") Object.assign(r, { status: "invalid", reason: "Not a valid name" });
    else if (bytes(t) > MAX_NAME_BYTES || bytes(r.toKey) > MAX_KEY_BYTES) Object.assign(r, { status: "invalid", reason: "Too long" });
    else if (t === r.from) r.status = "same";
    else if ((count.get(strip(r.toKey)) ?? 0) > 1) Object.assign(r, { status: "conflict", reason: "Same new name as another item" });
    else if (taken.has(strip(r.toKey))) Object.assign(r, { status: "conflict", reason: "Name already taken here" });
    if (r.status === "same") same++;
    else if (r.status === "ok") changed++;
    else problems++;
  }
  return { rows, error: null, changed, same, problems };
}

export type Move = { from: string; to: string; isPrefix: boolean };

/**
 * Splits renames into two rounds so none overwrites another item of the batch. Swaps (a→b while
 * b→a), chains (a→b, b→c) and case-only changes on a case-blind disk go to a temporary name in
 * the first round; the second round puts everything in its final place. `temp(m, i)` names the
 * temporary key of the i-th move.
 */
export function renameRounds(moves: Move[], temp: (m: Move, i: number) => string, foldCase = false): { first: Move[]; second: Move[] } {
  const fold = (s: string) => (foldCase ? s.toLowerCase() : s);
  const targets = new Set(moves.map((m) => fold(m.to)));
  const first: Move[] = [];
  const second = moves.map((m, i) => {
    // another item of the batch goes where this one is: move this one out of the way first
    if (!targets.has(fold(m.from))) return m;
    const t = temp(m, i);
    first.push({ from: m.from, to: t, isPrefix: m.isPrefix });
    return { from: t, to: m.to, isPrefix: m.isPrefix };
  });
  return { first, second };
}
