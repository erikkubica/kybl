/** The two questions the editor may ask: what to do about a conflict, and about unsaved changes. */
import { useEffect, useRef, type ReactNode } from "react";
import { formatDateFull } from "../format";
import type { DocMeta } from "../api";

function Dialog({ title, children, actions, onCancel }: { title: string; children: ReactNode; actions: ReactNode; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button.btn-primary")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="dv-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dv-dialog" role="alertdialog" aria-modal="true" aria-label={title} ref={box}>
        <h2>{title}</h2>
        <div className="dv-dialog-body">{children}</div>
        <div className="dv-dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

export function ConflictDialog({
  name,
  current,
  dirty,
  busy,
  onReload,
  onOverwrite,
  onCopy,
  onCancel,
}: {
  name: string;
  /** what is there now; null when the file was deleted */
  current: DocMeta | null;
  /** whether there are changes to lose by reloading */
  dirty: boolean;
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
  onCopy: () => void;
  onCancel: () => void;
}) {
  if (!current) {
    return (
      <Dialog
        title="This file was deleted"
        onCancel={onCancel}
        actions={
          <>
            <button className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn" onClick={onCopy} disabled={busy}>
              Save as copy
            </button>
            <button className="btn btn-primary" onClick={onOverwrite} disabled={busy}>
              Save it again
            </button>
          </>
        }
      >
        <p>
          Someone deleted <strong>{name}</strong> while you had it open. Save it again to bring it back with your version.
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="This file changed somewhere else"
      onCancel={onCancel}
      actions={
        <>
          <button className="btn" onClick={onReload} disabled={busy}>
            {dirty ? "Discard mine and reload" : "Reload"}
          </button>
          <button className="btn" onClick={onOverwrite} disabled={busy}>
            Overwrite
          </button>
          <button className="btn btn-primary" onClick={onCopy} disabled={busy}>
            Save as copy
          </button>
        </>
      }
    >
      <p>
        <strong>{name}</strong> was saved by someone else{current.modified ? ` (${formatDateFull(current.modified)})` : ""} after you opened it.
      </p>
      <p>Overwrite replaces their version with yours. Save as copy keeps both.</p>
    </Dialog>
  );
}

export function UnsavedDialog({ name, busy, onSave, onDiscard, onCancel }: { name: string; busy: boolean; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  return (
    <Dialog
      title={`Save changes to “${name}”?`}
      onCancel={onCancel}
      actions={
        <>
          <button className="btn btn-danger-ghost" onClick={onDiscard} disabled={busy}>
            Don't save
          </button>
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <p>Your changes will be lost if you close without saving.</p>
    </Dialog>
  );
}
