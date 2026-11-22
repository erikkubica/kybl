/**
 * App preferences. Stored in localStorage, applied to the document as data attributes
 * (theme / accent / font) that styles.css keys off, inline custom properties for the colour
 * scheme, plus native webview zoom for text size.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setAbsoluteDates, setByteUnits } from "./format";
import { setAppImageMode, type ImageMode } from "./imageMode";
import { SCHEME_VAR_NAMES, paletteVars, schemeById, type SchemeId } from "./schemes";

export type Theme = "system" | "light" | "dark";
export type Accent = "scheme" | "blue" | "purple" | "pink" | "orange" | "green" | "graphite";
export type FontChoice = "system" | "rounded" | "serif" | "mono";

export type Settings = {
  theme: Theme;
  /** surface palette (backgrounds, borders, text) for both light and dark */
  scheme: SchemeId;
  /** "scheme" = use the colour scheme's own accent */
  accent: Accent;
  font: FontChoice;
  /** interface zoom factor, 1 = default */
  scale: number;
  /** folders listed before files, whatever the sort */
  foldersFirst: boolean;
  /** 1 KiB = 1024 B instead of 1 KB = 1000 B */
  binaryUnits: boolean;
  /** lifetime of links made with the quick "Copy link" actions, in seconds */
  linkExpiry: number;
  /** always show full dates instead of "Today, 14:32" */
  absoluteDates: boolean;
  /** reopen the last connection, bucket and folder on launch */
  restoreLast: boolean;
  /** ask before deleting objects */
  confirmDelete: boolean;
  /** open the transfers panel when a transfer starts */
  autoOpenTransfers: boolean;
  /**
   * photos in lists and grids: file icons, ThumbHash placeholders only, or placeholders then
   * thumbnails (each one a download the first time). Connections can keep their own (imageMode.ts)
   */
  imageMode: ImageMode;
  /** desktop: ask where to save downloads; false = straight into the Downloads folder */
  downloadAsk: boolean;
  /** pinned places, shown in the sidebar (desktop) and on the home screen (phones) */
  favorites: Favorite[];
  /** list columns shown on desktop, in order (Name is always first) */
  columns: ColumnId[];
  /** last sort, restored on launch */
  sort: { by: "name" | "size" | "modified" | "kind"; desc: boolean };
  /** desktop grid tile size in px (96..320) */
  tileSize: number;
  /** phones: ask for Face ID / fingerprint when Kybl opens or comes back after a minute away */
  appLock: boolean;
  /** desktop: one browser pane, or two side by side (dual pane, like a commander) */
  layout: "single" | "dual";
  /** dual pane: opening a subfolder (or going up) in one pane does the same in the other when it can */
  syncBrowsing: boolean;
  /** files and folders whose name starts with "." show in panes of this computer's disk */
  showHiddenFiles: boolean;
  /** desktop: the connections sidebar folded away (⌥⌘S, or its button by the window controls) */
  sidebarHidden: boolean;
};

export type Favorite = { profileId: string; bucket: string; prefix: string; name: string };
export type ColumnId = "size" | "modified" | "kind" | "storageClass" | "etag";

export const DEFAULTS: Settings = {
  theme: "system",
  scheme: "kybl",
  accent: "scheme",
  font: "system",
  scale: 1,
  foldersFirst: true,
  binaryUnits: false,
  linkExpiry: 86400,
  absoluteDates: false,
  restoreLast: true,
  confirmDelete: true,
  autoOpenTransfers: true,
  imageMode: "placeholders",
  downloadAsk: true,
  favorites: [],
  columns: ["size", "modified", "kind"],
  sort: { by: "name", desc: false },
  tileSize: 160,
  appLock: false,
  layout: "single",
  syncBrowsing: false,
  showHiddenFiles: false,
  sidebarHidden: false,
};

export const ACCENTS: { id: Exclude<Accent, "scheme">; label: string; color: string }[] = [
  { id: "blue", label: "Blue", color: "#2c6bf2" },
  { id: "purple", label: "Purple", color: "#6d4fe0" },
  { id: "pink", label: "Pink", color: "#d93b7a" },
  { id: "orange", label: "Orange", color: "#dc6a17" },
  { id: "green", label: "Green", color: "#1f8f4e" },
  { id: "graphite", label: "Graphite", color: "#5c616d" },
];

export const SCALES = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Large" },
  { value: 1.25, label: "Larger" },
];

export const EXPIRIES = [
  { secs: 3600, label: "1 hour" },
  { secs: 86400, label: "24 hours" },
  { secs: 7 * 86400, label: "7 days" },
];

export function expiryLabel(secs: number): string {
  return EXPIRIES.find((e) => e.secs === secs)?.label ?? `${Math.round(secs / 3600)} hours`;
}

const KEY = "s3b.settings";
const BRAND_KEY = "s3b.brandScheme";

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const s: Settings = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
    // the old on/off thumbnails switch: on keeps thumbnails, off gets placeholders (no downloads)
    const old = (s as Settings & { listThumbs?: boolean }).listThumbs;
    if (typeof old === "boolean") {
      if (!saved.imageMode) s.imageMode = old ? "full" : "placeholders";
      delete (s as Settings & { listThumbs?: boolean }).listThumbs;
    }
    if (!["off", "placeholders", "full"].includes(s.imageMode)) s.imageMode = DEFAULTS.imageMode;
    // one-time: installs from before the Kybl scheme existed move to it if they never picked a look
    if (!localStorage.getItem(BRAND_KEY)) {
      localStorage.setItem(BRAND_KEY, "1");
      if (s.scheme === "default" && s.accent === "scheme") s.scheme = "kybl";
    }
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
let current: Settings = { ...DEFAULTS };
let lastScale = 1;

export function isDark(s: Settings = current): boolean {
  return s.theme === "dark" || (s.theme === "system" && systemDark.matches);
}

function applyTheme() {
  const root = document.documentElement;
  const dark = isDark();
  root.dataset.theme = dark ? "dark" : "light";
  // colour scheme: inline custom properties win over the stylesheet defaults
  for (const name of SCHEME_VAR_NAMES) root.style.removeProperty(name);
  const ownAccent = current.accent === "scheme";
  if (current.scheme !== "default") {
    const scheme = schemeById(current.scheme);
    const vars = paletteVars(dark ? scheme.dark : scheme.light, ownAccent);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  }
}

// follow the OS while the theme is set to "System"
systemDark.addEventListener("change", applyTheme);

/** Pushes the settings into the document (and the native window where that applies). */
export function applySettings(s: Settings) {
  current = s;
  const root = document.documentElement;
  root.dataset.accent = s.accent;
  applyTheme();
  root.dataset.font = s.font;
  setByteUnits(s.binaryUnits);
  setAbsoluteDates(s.absoluteDates);
  setAppImageMode(s.imageMode);

  if ("__TAURI_INTERNALS__" in window) {
    // native title bar / menus follow the chosen theme; null = follow the OS
    getCurrentWindow()
      .setTheme(s.theme === "system" ? null : s.theme)
      .catch(() => {});
    if (s.scale !== lastScale) {
      lastScale = s.scale;
      getCurrentWebview()
        .setZoom(s.scale)
        .catch(() => {});
    }
  } else if (s.scale !== lastScale) {
    // browser dev mode: approximate the native zoom
    lastScale = s.scale;
    root.style.fontSize = "";
    (root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(s.scale);
  }
}
