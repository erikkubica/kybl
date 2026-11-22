/**
 * Which in-app viewer (and editor) opens a file. This module is imported by the always-loaded
 * parts of the app (PreviewPane, the mobile viewer), so it holds only plain data and `import()`
 * calls: every viewer, CodeMirror, SheetJS and the rest load as their own chunks on first use.
 */
import { lazy } from "react";
import type { ComponentType } from "react";
import type { ViewerProps } from "./types";

export type ViewerKind = "text" | "markdown" | "csv" | "json" | "docx" | "xlsx" | "pptx" | "image";

export type ViewerInfo = {
  kind: ViewerKind;
  /** whether the full editor lets people change and save it (still subject to `editMaxBytes`) */
  canEdit: boolean;
  /** largest file this viewer opens at all */
  maxBytes: number;
  /** largest file it edits; bigger ones open read-only */
  editMaxBytes: number;
  /** the viewer component, as its own chunk */
  load: () => Promise<{ default: ComponentType<ViewerProps> }>;
};

const MB = 1000 * 1000;
/** Editing keeps the whole file in memory a few times over (text, undo history, bytes to save). */
export const EDIT_MAX = 5 * MB;

const CODE = [
  "txt", "log", "text", "yml", "yaml", "toml", "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "jsx",
  "ts", "tsx", "py", "rs", "go", "sh", "bash", "zsh", "sql", "ini", "env", "conf", "cfg", "properties", "java",
  "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "php", "rb", "lua", "pl", "r", "dart", "vue", "svelte",
  "gradle", "dockerfile", "makefile", "gitignore", "editorconfig", "srt", "vtt", "plist", "tf", "hcl", "nix", "proto",
  "graphql", "gql", "diff", "patch",
];
/** Whole-name matches for files without an extension. */
const CODE_NAMES = ["dockerfile", "makefile", "license", "readme", "procfile", "gemfile", "rakefile", "caddyfile", "jenkinsfile"];

const IMAGES = ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "ico"];

const text = () => import("./TextView");
const VIEWERS: Record<ViewerKind, Omit<ViewerInfo, "kind">> = {
  text: { canEdit: true, maxBytes: 20 * MB, editMaxBytes: EDIT_MAX, load: text },
  json: { canEdit: true, maxBytes: 20 * MB, editMaxBytes: EDIT_MAX, load: text },
  markdown: { canEdit: true, maxBytes: 10 * MB, editMaxBytes: EDIT_MAX, load: () => import("./MarkdownView") },
  csv: { canEdit: true, maxBytes: 50 * MB, editMaxBytes: EDIT_MAX, load: () => import("./CsvView") },
  docx: { canEdit: false, maxBytes: 30 * MB, editMaxBytes: 0, load: () => import("./DocxView") },
  xlsx: { canEdit: false, maxBytes: 30 * MB, editMaxBytes: 0, load: () => import("./XlsxView") },
  pptx: { canEdit: false, maxBytes: 100 * MB, editMaxBytes: 0, load: () => import("./PptxView") },
  image: { canEdit: false, maxBytes: 40 * MB, editMaxBytes: 0, load: () => import("./ImageView") },
};

function kindOf(name: string, contentType?: string | null): ViewerKind | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json" || ext === "jsonl" || ext === "ndjson" || ext === "geojson" || ext === "webmanifest") return "json";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xlsm" || ext === "xls" || ext === "ods") return "xlsx";
  if (ext === "pptx") return "pptx";
  if (IMAGES.includes(ext)) return "image";
  if (CODE.includes(ext)) return "text";
  if (!ext && CODE_NAMES.includes(lower.slice(lower.lastIndexOf("/") + 1))) return "text";
  // no telling extension: go by the stored content type
  const ct = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if (ct === "text/markdown") return "markdown";
  if (ct === "text/csv" || ct === "text/tab-separated-values") return "csv";
  if (ct === "application/json" || ct.endsWith("+json")) return "json";
  if (ct.startsWith("text/") || ct === "application/xml" || ct.endsWith("+xml") || ct === "application/yaml" || ct === "application/x-sh") return "text";
  if (IMAGES.some((i) => ct === `image/${i}`) || ct === "image/svg+xml") return "image";
  return null;
}

/**
 * The viewer for a file, or null when the app has none. `size` (bytes), when known, turns
 * `canEdit` off above the editing limit; files above `maxBytes` still get the info back so the
 * caller can say "too large" and offer "Open in another app".
 */
export function viewerFor(name: string, contentType?: string | null, size?: number): ViewerInfo | null {
  const kind = kindOf(name, contentType);
  if (!kind) return null;
  const v = VIEWERS[kind];
  const canEdit = v.canEdit && (size == null || size <= v.editMaxBytes);
  return { kind, ...v, canEdit };
}

/** Whether `viewerFor` would open this file in the app at its size. */
export function canView(name: string, size: number, contentType?: string | null): boolean {
  const v = viewerFor(name, contentType, size);
  return !!v && size <= v.maxBytes;
}

/**
 * The full document view as a lazy component, so mounting it costs the first-load bundle nothing:
 * `<Suspense fallback={…}><LazyDocumentView … /></Suspense>`.
 */
export const LazyDocumentView = lazy(() => import("./DocumentView"));
