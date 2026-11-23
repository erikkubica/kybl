/**
 * "Import connections" from other apps (src-tauri/src/import). The page only ever sees a preview
 * without passwords; importing hands the backend the chosen ids, and it reads the file again and
 * stores the secrets in the vault itself.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ConnKind, Profile } from "../types";

export type ImportSource = {
  id: string;
  name: string;
  /** the app's file was found on this computer */
  detected: boolean;
  /** where it was found, or where it usually is */
  path: string | null;
  filterName: string;
  extensions: string[];
};

export type SiteAuth = "password" | "anonymous" | "missing" | "keyFile" | "agent" | "encrypted";

export type ImportSite = {
  id: string;
  name: string;
  /** the other app's folders, outermost first */
  folder: string[];
  /** null: Kybl can't open it (`skip` says why) */
  kind: ConnKind | null;
  /** the other app's name for the protocol, for the badge */
  protocol: string;
  host: string;
  port: number;
  user: string;
  startDir: string;
  tls: "none" | "explicit" | "implicit" | "auto";
  auth: SiteAuth;
  notes: string[];
  skip: string | null;
  hasPassword: boolean;
  /** imports, but can't sign in until someone adds a password or key */
  needsSecret: boolean;
  /** the name of the Kybl connection it matches (same kind, server, port and user) */
  duplicateOf: string | null;
};

export type ImportPreview = { source: string; path: string; sites: ImportSite[]; hints: string[] };

export type ImportOutcome = {
  imported: Profile[];
  skipped: { name: string; reason: string }[];
  /** imported, but can't sign in until a password or key is added */
  needsSecret: string[];
};

export const importApi = {
  sources: () => invoke<ImportSource[]>("import_sources"),
  preview: (source: string, path: string | null) => invoke<ImportPreview>("import_preview", { source, path }),
  apply: (source: string, path: string | null, ids: string[]) => invoke<ImportOutcome>("import_apply", { source, path, ids }),
};

/** The look of each app in the source list: a monogram on the app's colour, never its logo. */
export const SOURCE_LOOK: Record<string, { mono: string; color: string }> = {
  filezilla: { mono: "FZ", color: "#b8160f" },
};
