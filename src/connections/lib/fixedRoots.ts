/** Root names that need no listing (pure, so tests can load it). Used by `roots.ts`. */
import type { ConnKind } from "../../core/types";

/** Roots whose ids are fixed per kind: the same names `list_roots` gives them. */
const FIXED_ROOTS: Partial<Record<ConnKind, Record<string, string>>> = {
  gdrive: { root: "My Drive", "shared-with-me": "Shared with me" },
  onedrive: { me: "OneDrive", "shared-with-me": "Shared with me" },
};

/** The name of a fixed root id of this kind ("root" on Google Drive is My Drive), or undefined. */
export function fixedRootName(kind: ConnKind | undefined, id: string): string | undefined {
  return kind ? FIXED_ROOTS[kind]?.[id] : undefined;
}

/** A root id with no known name, shortened for one line: the last part of a path, else the id. */
export function rootIdLeaf(id: string): string {
  return id.split(/[\\/]/).filter(Boolean).pop() ?? id;
}
