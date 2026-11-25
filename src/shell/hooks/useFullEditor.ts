import { useState, useRef } from "react";
import { type PaneId } from "../../browser/types";
import { type Entry } from "../../core/types";
import { type DocumentHandle } from "../../viewers/components/DocumentView";
import { peekCaps } from "../../core/useCaps";
import { asExport } from "../../connections/lib/native";
import { viewerFor, canView } from "../../viewers/lib/registry";
import { type PaneEnv } from "../../browser/hooks/usePane";
import type { Late } from "../lib/late";

export interface UseFullEditorDeps {

  late: Late;
}

/** The document editor over everything: Open on a text, code, Markdown, CSV, JSON or Office file, and "Edit in Kybl". */
export function useFullEditor(s: UseFullEditorDeps) {
  // Open on a text, code, Markdown, CSV, JSON or Office file shows it here, over everything
  const [doc, setDoc] = useState<{ pane: PaneId; profileId: string; bucket: string; entry: Entry } | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const editor = useRef<DocumentHandle>(null);
  const canOpenDocument = (id: PaneId, e: Entry) => {
    const p = s.late.paneById(id);
    if (e.kind !== "file" || !p.profile || p.bucket == null) return false;
    // this computer's own files open in their own apps, where they are
    if (peekCaps(p.profile.id)?.localPaths) return false;
    // a Google Doc / Sheet / Slides opens as its Office export, read-only (DocumentView)
    const x = e.native ? asExport(e) : e;
    if (!x) return false;
    // (the stored content type too: "Edit in Kybl" offers files that only it marks as text)
    const v = viewerFor(x.name, x.mime ?? null, x.size);
    return !!v && v.kind !== "image" && canView(x.name, x.size, x.mime ?? null);
  };
  const openDocument = (id: PaneId, e: Entry) => {
    if (!canOpenDocument(id, e)) return false;
    const p = s.late.paneById(id);
    p.closeQuick();
    setDoc({ pane: id, profileId: p.profile!.id, bucket: p.bucket!, entry: e });
    return true;
  };
  const closeEditor = async () => (editor.current ? editor.current.requestClose() : true);

  /** a press on items starts the shell's drag of them (useFileDrag, further down) */
  const beginItemDrag = useRef<PaneEnv["beginItemDrag"]>(undefined);
  return { doc, setDoc, docRef, editor, canOpenDocument, openDocument, closeEditor, beginItemDrag };
}
