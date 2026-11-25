import type { ViewerKind } from "./lib/registry";

/** What DocumentView hands every viewer. */
export type ViewerProps = {
  kind: ViewerKind;
  /** file name, for language detection and labels */
  name: string;
  /** the raw file */
  bytes: Uint8Array;
  /** the decoded text for text-like kinds (text, json, markdown, csv); null for the others */
  text: string | null;
  /** whether changes are allowed (text-like kinds only) */
  editable: boolean;
  /** "preview": small, read-only, in Quick Look or the details screen; "full": the whole window */
  mode: "preview" | "full";
  /**
   * Called on every change with a getter for the current text (lines joined with "\n").
   * A getter instead of the text, so a keystroke in a 5 MB file doesn't copy 5 MB.
   */
  onEdit?: (current: () => string) => void;
  /** ⌘S / Ctrl+S pressed inside the viewer */
  onSave?: () => void;
};
