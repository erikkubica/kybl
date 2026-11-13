/**
 * Colour schemes: a full surface palette (backgrounds, borders, text) plus a default accent,
 * each with a light and a dark variant. "kybl" is the brand scheme and the default; "default"
 * (shown as Classic) is whatever styles.css defines.
 * Applied by settings.ts as CSS custom properties on <html>, so the picker previews and the
 * real UI always use the same numbers.
 */
export type SchemeId = "kybl" | "default" | "graphite" | "midnight" | "nord" | "solarized" | "ember" | "grape";

export type Palette = {
  bg: string;
  raised: string;
  panel: string;
  sidebar: string;
  field: string;
  border: string;
  borderStrong: string;
  text: string;
  dim: string;
  faint: string;
  /** accent as text / icon colour */
  accent: string;
  /** accent as a filled button background (white text on top) */
  accentSolid: string;
  /** folder icon colours: line icon, back flap, front flap. Unset = the stylesheet's blue. */
  folder?: [string, string, string];
};

export type Scheme = { id: SchemeId; label: string; light: Palette; dark: Palette };

export const SCHEMES: Scheme[] = [
  {
    // the brand: enamel red, cast-iron text, warm greys, beach-pail yellow folders
    id: "kybl",
    label: "Kybl",
    light: { bg: "#ffffff", raised: "#ffffff", panel: "#f8f6f5", sidebar: "#f3f0ee", field: "#ffffff", border: "#e9e4e1", borderStrong: "#d6cfcb", text: "#1e1a1a", dim: "#6b6462", faint: "#a09896", accent: "#c93118", accentSolid: "#d9381f", folder: ["#d99a16", "#eaa91c", "#ffcf4d"] },
    dark: { bg: "#171414", raised: "#242020", panel: "#1d1a1a", sidebar: "#110f0f", field: "#1f1c1c", border: "#2e2928", borderStrong: "#413a39", text: "#f1ecea", dim: "#aaa19e", faint: "#776e6b", accent: "#ff7a5c", accentSolid: "#d9381f", folder: ["#f0b530", "#d99a16", "#f7c644"] },
  },
  {
    id: "default",
    label: "Classic",
    light: { bg: "#ffffff", raised: "#ffffff", panel: "#f7f7f9", sidebar: "#f2f2f5", field: "#ffffff", border: "#e6e6eb", borderStrong: "#d2d3db", text: "#17181c", dim: "#60636e", faint: "#9497a3", accent: "#2c6bf2", accentSolid: "#2c6bf2" },
    dark: { bg: "#17181b", raised: "#222328", panel: "#1c1d21", sidebar: "#111214", field: "#1d1e23", border: "#2a2b31", borderStrong: "#3a3c44", text: "#ececf1", dim: "#a0a3ae", faint: "#6d707b", accent: "#7aa2ff", accentSolid: "#3a70f2" },
  },
  {
    id: "graphite",
    label: "Graphite",
    light: { bg: "#ffffff", raised: "#ffffff", panel: "#f6f6f6", sidebar: "#efefef", field: "#ffffff", border: "#e4e4e4", borderStrong: "#cfcfcf", text: "#1a1a1a", dim: "#5f5f5f", faint: "#969696", accent: "#3a3a3a", accentSolid: "#3d3d3d" },
    dark: { bg: "#1b1b1b", raised: "#272727", panel: "#202020", sidebar: "#131313", field: "#222222", border: "#2f2f2f", borderStrong: "#414141", text: "#ededed", dim: "#a6a6a6", faint: "#717171", accent: "#d6d6d6", accentSolid: "#5a5a5a" },
  },
  {
    id: "midnight",
    label: "Midnight",
    light: { bg: "#fbfcff", raised: "#ffffff", panel: "#f3f6fc", sidebar: "#eaeff9", field: "#ffffff", border: "#dde4f1", borderStrong: "#c6d0e3", text: "#121a2c", dim: "#525e7a", faint: "#8791a9", accent: "#3d68ee", accentSolid: "#3d68ee" },
    dark: { bg: "#0f1420", raised: "#1a2233", panel: "#131a28", sidebar: "#0a0e17", field: "#141b2a", border: "#222c41", borderStrong: "#33405c", text: "#e3e8f4", dim: "#97a3bb", faint: "#606c87", accent: "#84a6ff", accentSolid: "#3f6cf0" },
  },
  {
    id: "nord",
    label: "Nord",
    light: { bg: "#f9fafc", raised: "#ffffff", panel: "#eef1f6", sidebar: "#e5e9f0", field: "#ffffff", border: "#d8dee9", borderStrong: "#c0c9d9", text: "#2e3440", dim: "#4c566a", faint: "#7b879c", accent: "#4f76a3", accentSolid: "#5477a6" },
    dark: { bg: "#2e3440", raised: "#3b4252", panel: "#323846", sidebar: "#272c36", field: "#353c4a", border: "#414a5b", borderStrong: "#535e73", text: "#eceff4", dim: "#c2cad9", faint: "#8a94a8", accent: "#88c0d0", accentSolid: "#5e81ac" },
  },
  {
    id: "solarized",
    label: "Solarized",
    light: { bg: "#fdf6e3", raised: "#fffbf0", panel: "#f6efdb", sidebar: "#eee8d5", field: "#fffbf0", border: "#e3dbc3", borderStrong: "#d0c7ab", text: "#2c464e", dim: "#566c74", faint: "#93a1a1", accent: "#1f7fc4", accentSolid: "#268bd2" },
    dark: { bg: "#002b36", raised: "#0a3f4c", panel: "#06323e", sidebar: "#00222b", field: "#073642", border: "#0f4756", borderStrong: "#1c5a6b", text: "#dee7e4", dim: "#93a1a1", faint: "#637b82", accent: "#56b6ee", accentSolid: "#268bd2" },
  },
  {
    id: "ember",
    label: "Ember",
    light: { bg: "#fffaf5", raised: "#ffffff", panel: "#faf2ea", sidebar: "#f4eae1", field: "#ffffff", border: "#eaded2", borderStrong: "#d8c9b9", text: "#2a211c", dim: "#6b5c52", faint: "#a2938a", accent: "#bf4f27", accentSolid: "#c9582f" },
    dark: { bg: "#1d1a19", raised: "#2b2725", panel: "#23201e", sidebar: "#151312", field: "#252120", border: "#35302d", borderStrong: "#48413d", text: "#f0e9e4", dim: "#b2a69f", faint: "#7b716b", accent: "#f39468", accentSolid: "#c9582f" },
  },
  {
    id: "grape",
    label: "Grape",
    light: { bg: "#fdfcff", raised: "#ffffff", panel: "#f6f4fd", sidebar: "#efecfa", field: "#ffffff", border: "#e3dff2", borderStrong: "#cdc6e5", text: "#1d1830", dim: "#5c5578", faint: "#938cab", accent: "#6a4de0", accentSolid: "#6d4fe0" },
    dark: { bg: "#1c1a2b", raised: "#2b2742", panel: "#221f35", sidebar: "#151323", field: "#242138", border: "#353057", borderStrong: "#494272", text: "#ece9f8", dim: "#aaa4c7", faint: "#736d94", accent: "#b9a0ff", accentSolid: "#7355ea" },
  },
];

export function schemeById(id: string): Scheme {
  return SCHEMES.find((s) => s.id === id) ?? SCHEMES[0];
}

/** CSS custom properties for one palette. `withAccent` = also apply the scheme's own accent. */
export function paletteVars(p: Palette, withAccent: boolean): Record<string, string> {
  const vars: Record<string, string> = {
    "--bg": p.bg,
    "--raised": p.raised,
    "--panel": p.panel,
    "--sidebar": p.sidebar,
    "--field": p.field,
    "--border": p.border,
    "--border-strong": p.borderStrong,
    "--text": p.text,
    "--dim": p.dim,
    "--faint": p.faint,
    "--paper": p.raised,
    "--paper-edge": p.borderStrong,
    "--paper-fold": p.border,
  };
  if (p.folder) {
    vars["--c-folder"] = p.folder[0];
    vars["--folder-back"] = p.folder[1];
    vars["--folder-front"] = p.folder[2];
  }
  if (withAccent) {
    vars["--accent"] = p.accent;
    vars["--accent-solid"] = p.accentSolid;
    vars["--accent-solid-hover"] = `color-mix(in srgb, ${p.accentSolid} 88%, white)`;
    vars["--accent-soft"] = `color-mix(in srgb, ${p.accent} 15%, transparent)`;
    vars["--accent-ring"] = `color-mix(in srgb, ${p.accent} 34%, transparent)`;
  }
  return vars;
}

/** Every property a scheme may set, so switching schemes can clear the previous one. */
export const SCHEME_VAR_NAMES = Object.keys(paletteVars(SCHEMES[0].light, true));
