/** Loads a document for DocumentView: bytes and metadata in one read, text decoded when it is text. */
import { useCallback, useEffect, useState } from "react";
import { docOpen, errMessage, type DocMeta } from "../../core/api";
import { decodeText, type TextDoc } from "../lib/text";
import type { ViewerInfo, ViewerKind } from "../lib/registry";

export const TEXT_KINDS: ViewerKind[] = ["text", "json", "markdown", "csv"];

/** The side-panel preview downloads less than the full view would. */
const MB = 1000 * 1000;
export const PREVIEW_MAX: Record<ViewerKind, number> = {
  text: 2 * MB,
  json: 2 * MB,
  markdown: 2 * MB,
  csv: 10 * MB,
  docx: 15 * MB,
  xlsx: 15 * MB,
  pptx: 30 * MB,
  image: 25 * MB,
};

export type DocState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "too-large"; limit: number }
  | { status: "ready"; meta: DocMeta; bytes: Uint8Array; text: TextDoc | null };

export function limitFor(info: ViewerInfo, mode: "preview" | "full"): number {
  return mode === "preview" ? Math.min(info.maxBytes, PREVIEW_MAX[info.kind]) : info.maxBytes;
}

export function useDocument(profileId: string, bucket: string, key: string, size: number, info: ViewerInfo | null, mode: "preview" | "full") {
  const [state, setState] = useState<DocState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const limit = info ? limitFor(info, mode) : 0;
  const kind = info?.kind;

  useEffect(() => {
    if (!kind) return;
    if (size > limit) {
      setState({ status: "too-large", limit });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    docOpen(profileId, bucket, key, limit)
      .then(({ meta, bytes }) => {
        if (!live) return;
        const text = TEXT_KINDS.includes(kind) ? decodeText(bytes) : null;
        setState({ status: "ready", meta, bytes, text });
      })
      .catch((e) => {
        if (!live) return;
        const message = errMessage(e);
        // the size in the listing can be stale; the backend has the final word
        setState(/too large/i.test(message) ? { status: "too-large", limit } : { status: "error", message });
      });
    return () => {
      live = false;
    };
  }, [profileId, bucket, key, size, limit, kind, nonce]);

  /** Reads the file again (after "Reload" in a conflict, or "Try again"). */
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /** After a save: the new metadata, without downloading again. */
  const saved = useCallback((meta: DocMeta) => setState((s) => (s.status === "ready" ? { ...s, meta } : s)), []);
  return { state, reload, saved };
}
