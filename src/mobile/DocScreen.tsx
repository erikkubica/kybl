/**
 * A document full screen on the phone (text, code, Markdown, CSV, Word, Excel, slides): the
 * shared DocumentView, inline in the app's own layer stack so sheets, dialogs and toasts stack
 * with it. Back (button, gesture, edge swipe) goes through `requestClose` on the handle, which
 * asks about unsaved changes first.
 */
import { Suspense, type Ref } from "react";
import { LazyDocumentView } from "../viewers/registry";
import type { DocumentHandle } from "../viewers/DocumentView";
import type { Entry } from "../types";

export function DocScreen({
  handle,
  profileId,
  bucket,
  entry,
  onClose,
  onSaved,
  onOpenExternal,
}: {
  handle: Ref<DocumentHandle>;
  profileId: string;
  bucket: string;
  entry: Entry;
  onClose: () => void;
  onSaved: (s: { key: string; asCopy: boolean }) => void;
  onOpenExternal: (e: Entry) => void;
}) {
  return (
    <section className="m-screen m-overlay m-doc">
      <Suspense
        fallback={
          <div className="m-doc-wait" role="status" aria-label="Opening">
            <span className="spinner" />
          </div>
        }
      >
        <LazyDocumentView
          ref={handle}
          inline
          profileId={profileId}
          bucket={bucket}
          entry={entry}
          mode="full"
          onClose={onClose}
          onSaved={onSaved}
          onOpenExternal={onOpenExternal}
        />
      </Suspense>
    </section>
  );
}
