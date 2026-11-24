import type { Entry } from "./types";

/** "1 folder", "1,204 folders": a count with its noun in the right number. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * A typed speed limit in MB/s ("5", "2,5", "0" for no limit), or what is wrong with it. Above
 * 10 000 MB/s is no real limit, so it is turned down rather than taken as "none".
 */
export function parseMbps(text: string): number | string {
  const t = text.trim().replace(/\s*mb\/?s$/i, "").replace(",", ".");
  const mb = t === "" ? NaN : Number(t);
  if (!Number.isFinite(mb) || mb < 0) return "Enter a number of MB/s, or 0 for no limit.";
  if (mb > 10_000) return "At most 10,000 MB/s.";
  return mb;
}

/**
 * What is wrong with a typed custom limit (Settings' "Custom" field, where "Unlimited" is its own
 * choice), or null. Empty is not a problem: nothing is applied yet.
 */
export function customLimitProblem(text: string): string | null {
  if (!text.trim()) return null;
  const mb = parseMbps(text);
  if (typeof mb === "string" || mb === 0) return "Enter a number from 0.001 to 10,000.";
  return null;
}

/** A typed limit in MB/s as the backend's KiB/s: 0 is "none", anything else at least 1 KB/s (never rounded to "none"). */
export const mbpsToKbps = (mb: number) => (mb === 0 ? 0 : Math.max(1, Math.round((mb * 1_000_000) / 1024)));

/** A limit in MB/s as the custom-limit field shows it: precise to 1 KB/s, so it survives a re-save. */
export const mbpsInput = (mb: number) => String(Math.round(mb * 1000) / 1000);

let binaryUnits = false;

/** Switches every size in the app between decimal (KB = 1000 B) and binary (KiB = 1024 B). */
export function setByteUnits(binary: boolean) {
  binaryUnits = binary;
}

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const base = binaryUnits ? 1024 : 1000;
  // a rate (bytes per second) is a fraction: whole bytes only
  if (Math.round(n) < base) return `${Math.round(n)} B`;
  const units = binaryUnits ? ["KiB", "MiB", "GiB", "TiB", "PiB"] : ["KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = -1;
  do {
    v /= base;
    i++;
  } while (v >= base && i < units.length - 1);
  // the unit is picked on the rounded figure: 999.95 KB is "1.0 MB", 99.95 KB "100 KB"
  const show = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(digits));
  let s = show(v);
  if (v < 100 && parseFloat(s) >= 100) s = v.toFixed(0);
  if (parseFloat(s) >= base && i < units.length - 1) {
    v /= base;
    i++;
    s = show(v);
  }
  return `${s} ${units[i]}`;
}

/** Full, unambiguous timestamp (tooltips, file info). */
export function formatDateFull(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact timestamp for lists: "Today, 14:32", "Yesterday, 09:10", "Nov 4, 14:32", "Nov 2, 2025". */
let absoluteDates = false;

/** Lists show full timestamps instead of "Today, 14:32". */
export function setAbsoluteDates(on: boolean) {
  absoluteDates = on;
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (absoluteDates) return formatDateFull(ms);
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatSpeed(bps: number): string {
  return bps > 0 ? `${formatBytes(bps)}/s` : "";
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  // whole seconds first, so rounding up can't print "60s" or "1m 60s"
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export type FileClass =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "archive"
  | "doc"
  | "other";

const IMAGE = ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "ico", "heic", "heif", "tif", "tiff"];
const VIDEO = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "mts", "m2ts", "3gp", "mpg", "mpeg", "wmv"];
const AUDIO = ["mp3", "m4a", "wav", "flac", "ogg", "aac", "opus"];
const TEXT = [
  "txt", "md", "json", "csv", "log", "yml", "yaml", "toml", "xml", "html", "css", "js", "ts", "tsx",
  "jsx", "py", "rs", "go", "sh", "sql", "ini", "env", "conf", "cfg", "tsv", "mjs", "cjs", "jsonl",
];
const ARCHIVE = ["zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz", "dmg", "iso"];
const DOC = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "pages", "numbers", "key"];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function classify(name: string): FileClass {
  const e = extOf(name);
  if (IMAGE.includes(e)) return "image";
  if (VIDEO.includes(e)) return "video";
  if (AUDIO.includes(e)) return "audio";
  if (e === "pdf") return "pdf";
  if (TEXT.includes(e)) return "text";
  if (ARCHIVE.includes(e)) return "archive";
  if (DOC.includes(e)) return "doc";
  return "other";
}

const KIND_NAMES: Record<string, string> = {
  md: "Markdown",
  txt: "Plain text",
  log: "Log file",
  json: "JSON",
  jsonl: "JSON Lines",
  csv: "CSV",
  tsv: "TSV",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  jsx: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  sh: "Shell script",
  sql: "SQL",
  pdf: "PDF document",
  dmg: "Disk image",
  iso: "Disk image",
};

/** Human label for the "Kind" column, e.g. "JPG image", "PDF document", "Folder". */
export function kindLabel(name: string, isFolder: boolean): string {
  if (isFolder) return "Folder";
  const e = extOf(name);
  if (!e) return "File";
  if (KIND_NAMES[e]) return KIND_NAMES[e];
  const E = e.toUpperCase();
  switch (classify(name)) {
    case "image":
      return `${E} image`;
    case "video":
      return `${E} video`;
    case "audio":
      return `${E} audio`;
    case "archive":
      return `${E} archive`;
    case "doc":
      return `${E} document`;
    default:
      return `${E} file`;
  }
}

/** Google's own file types, by the part after "application/vnd.google-apps.". */
const GOOGLE_KINDS: Record<string, string> = {
  document: "Google Docs",
  spreadsheet: "Google Sheets",
  presentation: "Google Slides",
  drawing: "Google Drawings",
  form: "Google Forms",
  site: "Google Sites",
  script: "Apps Script",
  jam: "Jamboard",
  map: "Google My Maps",
};
/** When the listing carries no type: the first export tells Docs, Sheets and Slides apart. */
const GOOGLE_BY_EXPORT: Record<string, string> = { docx: "Google Docs", xlsx: "Google Sheets", pptx: "Google Slides" };

type Sized = Pick<Entry, "kind" | "name" | "size" | "native" | "mime">;

/**
 * Whether the entry has a size of its own. Google Docs, Sheets and Slides don't: Drive makes the
 * file when it's downloaded, so they show "—" and count for nothing in totals.
 */
export const hasSize = (e: Pick<Entry, "kind" | "native">) => e.kind === "file" && !e.native;

/** A file's size for display: "—" for Google Docs and friends (see `hasSize`). */
export const entrySize = (e: Sized) => (e.native ? "—" : formatBytes(e.size));

/** Bytes a list of entries adds up to, files only and leaving out Google Docs and friends. */
export const sumSizes = (list: Sized[]) => list.reduce((s, e) => s + (hasSize(e) ? e.size : 0), 0);

/** The Kind column: "Google Sheets" for a native Google file, else what the name says (`kindLabel`). */
export function entryKind(e: Sized): string {
  if (e.kind === "file" && e.native) {
    const sub = e.mime?.startsWith("application/vnd.google-apps.") ? e.mime.slice("application/vnd.google-apps.".length) : "";
    return GOOGLE_KINDS[sub] ?? GOOGLE_BY_EXPORT[e.native.exports[0]?.ext ?? ""] ?? "Google Drive file";
  }
  return kindLabel(e.name, e.kind === "folder");
}

/**
 * Apple's WebKit (iPhone, iPad, and the Mac's web view) shows HEIC/HEIF photos itself since
 * Safari 17; other web views can't. The platform check keeps Chrome-based views out (they claim
 * "Macintosh" too), and `font-size-adjust` shipped in the same WebKit release as HEIC images, so
 * it stands in for a version check (web view user agents don't carry the OS version on a Mac).
 */
export const HEIC_IN_WEBVIEW: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod|Macintosh/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android|Firefox/.test(ua);
  try {
    return apple && typeof CSS !== "undefined" && CSS.supports("font-size-adjust", "0.5");
  } catch {
    return false;
  }
})();

export const isHeic = (name: string) => {
  const e = extOf(name);
  return e === "heic" || e === "heif";
};

/** Browsers/webviews can display these image types natively. */
export function isWebImage(name: string): boolean {
  if (isHeic(name)) return HEIC_IN_WEBVIEW;
  return ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "ico"].includes(extOf(name));
}

/**
 * Videos this web view can't play at all, so the app offers "Open in…" straight away instead of
 * a dead player. Apple's WebKit plays mp4/mov/m4v (and webm on recent versions); Android's
 * Chromium also plays mkv and 3gp. Anything else that fails still gets the fallback once the
 * player reports an error.
 */
export function isPlayableVideo(name: string): boolean {
  const e = extOf(name);
  if (["avi", "wmv", "mpg", "mpeg", "mts", "m2ts"].includes(e)) return false;
  if (e === "mkv" || e === "3gp") return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  return true;
}

export function baseName(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function parentPrefix(prefix: string): string {
  if (!prefix) return "";
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i + 1);
}
