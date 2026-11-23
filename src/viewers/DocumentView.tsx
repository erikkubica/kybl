/**
 * Opens a file in the right in-app viewer, and for text-like files lets people edit and save it.
 *
 * - mode "preview": Quick Look and the phone's details screen. Read-only, compact, a smaller download limit.
 * - mode "full": the whole window (desktop modal or phone screen). Editing, ⌘S / Ctrl+S, conflict
 *   handling (Reload / Overwrite / Save as copy) and an unsaved-changes question on close.
 *
 * See INTEGRATION.md for how the app mounts it.
 */
import { Suspense, lazy, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { api, DocConflict, docSave, errMessage, errSummary, expectMeta, type DocMeta, type DocPrecondition } from "../api";
import { Icon } from "../Icons";
import { formatBytes } from "../format";
import type { Entry } from "../types";
import { EDIT_MAX, viewerFor } from "./registry";
import { asExport, driveUrl } from "../connections/native";
import { encodeText } from "./text";
import { isArchiveId } from "../archive/archive";
import { useDocument } from "./useDocument";
import { ConflictDialog, UnsavedDialog } from "./ConflictDialog";
import { Note } from "./ui";
import type { ViewerProps } from "./types";
import "./viewers.css";

export type DocumentHandle = {
  /** Asks about unsaved changes first; resolves true when the view closed (onClose was called). */
  requestClose: () => Promise<boolean>;
  isDirty: () => boolean;
  /** Saves now; resolves true when saved. */
  save: () => Promise<boolean>;
};

export type DocumentViewProps = {
  profileId: string;
  bucket: string;
  entry: Entry;
  mode: "preview" | "full";
  /** full mode: the close button, Escape, and "Don't save" end here */
  onClose?: () => void;
  /** after every successful save; `key` differs from the entry's after "Save as copy" */
  onSaved?: (saved: { key: string; meta: DocMeta; asCopy: boolean }) => void;
  /** "Open in another app" (download, then the system's default app); shown when given */
  onOpenExternal?: (entry: Entry) => void;
  /** preview mode: an "Open" button that should show this file in full mode */
  onOpenFull?: (entry: Entry) => void;
  /** full mode: fill the parent instead of covering the whole window */
  inline?: boolean;
  /** "auto": ⌘S overwrites whatever is there; default: only if it's still the version opened */
  saveRule?: "auto" | "ifUnchanged";
  ref?: Ref<DocumentHandle>;
};

const baseName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

/** "notes.md" → "notes (copy).md", "notes (copy 2).md", … */
export function copyKey(key: string, n: number): string {
  const slash = key.lastIndexOf("/") + 1;
  const name = key.slice(slash);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${key.slice(0, slash)}${stem} (copy${n > 1 ? ` ${n}` : ""})${ext}`;
}

/**
 * Every open document with unsaved changes, so quitting the app can ask first (quit.rs). Each
 * view adds a token while dirty; the count goes to the backend whenever it changes.
 */
const unsavedDocs = new Set<object>();
function markUnsaved(token: object, dirty: boolean) {
  const before = unsavedDocs.size;
  if (dirty) unsavedDocs.add(token);
  else unsavedDocs.delete(token);
  if (unsavedDocs.size !== before) void api.setUnsavedDocuments(unsavedDocs.size);
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** the Mac app's window buttons float over the top-left corner of the page */
const macWindow = /Macintosh|Mac OS X/.test(navigator.userAgent) && !window.matchMedia("(pointer: coarse)").matches;

export default function DocumentView({ profileId, bucket, entry: given, mode, onClose, onSaved, onOpenExternal, onOpenFull, inline, saveRule, ref }: DocumentViewProps) {
  const full = mode === "full";
  // Google Docs, Sheets and Slides have no bytes of their own: show their Office export, read-only
  // (saving it would make a new .docx next to the original, not change the Google file)
  const native = given.native;
  const entry = useMemo(() => (given.native ? (asExport(given) ?? given) : given), [given]);
  // where saves go (changes after "Save as copy") and what was last read from storage
  const [target, setTarget] = useState(entry.key);
  const [source, setSource] = useState(entry.key);
  useEffect(() => {
    setTarget(entry.key);
    setSource(entry.key);
  }, [entry.key]);

  const name = native ? given.name : baseName(target);
  // after "Save as copy" the actions act on the copy
  const current: Entry = target === entry.key ? given : { ...entry, key: target, name, size: 0 };
  const info = useMemo(() => viewerFor(entry.name, null, entry.size), [entry.name, entry.size]);
  const { state, reload, saved } = useDocument(profileId, bucket, source, source === entry.key ? entry.size : 0, info, mode);

  const [loadId, setLoadId] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: DocMeta | null } | null>(null);
  const [asking, setAsking] = useState(false);
  // where the keyboard was before "Save changes?" or the conflict question opened: focus goes back
  // there when it closes (Cancel), so typing carries on in the editor
  const lastFocus = useRef<HTMLElement | null>(null);
  const questionUp = asking || !!conflict;
  useEffect(() => {
    if (questionUp) return;
    const el = lastFocus.current;
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }, [questionUp]);

  const getText = useRef<(() => string) | null>(null);
  const original = useRef<string>("");
  const rev = useRef(0);
  const cleanTimer = useRef(0);
  const closeAnswer = useRef<((closed: boolean) => void) | null>(null);
  // one save at a time (⌘S can arrive from the editor and the window in the same keystroke)
  const inFlight = useRef(false);

  const ready = state.status === "ready" ? state : null;
  const textDoc = ready?.text ?? null;
  // a file inside an opened archive is read-only (the archive opens like a folder)
  const archived = isArchiveId(profileId);
  const editable = full && !native && !archived && !!info?.canEdit && !!textDoc && !textDoc.lossy && (ready?.bytes.length ?? 0) <= info.editMaxBytes;

  // a fresh load starts clean
  useEffect(() => {
    if (!ready) return;
    original.current = (ready.text?.text ?? "").replace(/\r\n?/g, "\n");
    getText.current = null;
    rev.current = 0;
    setDirty(false);
    setLoadId((n) => n + 1);
    // only when new bytes arrive, not when a save updates the metadata
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready?.bytes]);

  useEffect(() => () => clearTimeout(cleanTimer.current), []);

  // quitting the app asks while this view holds unsaved changes
  const unsavedToken = useRef({});
  useEffect(() => {
    const token = unsavedToken.current;
    markUnsaved(token, dirty);
    return () => markUnsaved(token, false);
  }, [dirty]);

  const onEdit = useCallback((current: () => string) => {
    getText.current = current;
    rev.current++;
    setDirty(true);
    setFlash(null);
    // undoing back to what was opened (or last saved) makes the file clean again
    clearTimeout(cleanTimer.current);
    cleanTimer.current = window.setTimeout(() => {
      if (getText.current && getText.current() === original.current) setDirty(false);
    }, 400);
  }, []);

  /** Saves to `key` under `expect`. Resolves true when saved; conflicts open the dialog. */
  const saveAs = useCallback(
    async (key: string, expect: DocPrecondition, asCopy = false): Promise<boolean> => {
      if (!ready || !textDoc || inFlight.current) return false;
      // unedited (e.g. "Save as copy" right after opening): the text as opened
      const text = getText.current ? getText.current() : original.current;
      const startRev = rev.current;
      inFlight.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        const meta = await docSave(profileId, bucket, key, encodeText(text, textDoc), expect);
        saved(meta);
        original.current = text;
        if (rev.current === startRev) setDirty(false);
        setTarget(key);
        setConflict(null);
        setFlash(meta.warning ?? (asCopy ? `Saved as ${baseName(key)}` : "Saved"));
        onSaved?.({ key, meta, asCopy });
        return true;
      } catch (e) {
        if (e instanceof DocConflict) {
          if (asCopy && e.current) throw e; // the copy's name is taken: the caller tries the next one
          setConflict({ current: e.current });
        } else {
          setSaveError(errSummary(errMessage(e)));
        }
        return false;
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    },
    [ready, textDoc, profileId, bucket, saved, onSaved],
  );

  const save = useCallback(async () => {
    if (!ready || !editable || saving) return false;
    if (!dirty) return true;
    return saveAs(target, saveRule === "auto" ? { kind: "any" } : expectMeta(ready.meta));
  }, [ready, editable, saving, dirty, saveAs, target, saveRule]);

  const saveCopy = useCallback(async () => {
    for (let n = 1; n <= 50; n++) {
      try {
        return await saveAs(copyKey(target, n), { kind: "absent", headersFrom: target }, true);
      } catch (e) {
        if (!(e instanceof DocConflict)) throw e;
      }
    }
    setSaveError("Couldn't find a free name for the copy.");
    return false;
  }, [saveAs, target]);

  const finishClose = useCallback(
    (closed: boolean) => {
      setAsking(false);
      closeAnswer.current?.(closed);
      closeAnswer.current = null;
      if (closed) onClose?.();
    },
    [onClose],
  );

  const requestClose = useCallback((): Promise<boolean> => {
    // a second close request (the phone's back gesture) while a question is open dismisses it
    if (asking) {
      finishClose(false);
      return Promise.resolve(false);
    }
    if (conflict) {
      setConflict(null);
      return Promise.resolve(false);
    }
    if (!dirty) {
      onClose?.();
      return Promise.resolve(true);
    }
    setAsking(true);
    return new Promise<boolean>((resolve) => {
      closeAnswer.current?.(false);
      closeAnswer.current = resolve;
    });
  }, [dirty, onClose, asking, conflict, finishClose]);

  useImperativeHandle(ref, () => ({ requestClose, isDirty: () => dirty, save }), [requestClose, dirty, save]);

  // ⌘S / Ctrl+S anywhere in the full view, Escape to close
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        // already handled by the editor's own ⌘S
        if (e.defaultPrevented && !e.shiftKey) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (editable) void saveCopy();
        } else void save();
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "w") {
        // ⌘W closes the document (asking about unsaved changes), not the app's window
        e.preventDefault();
        if (!conflict && !asking) void requestClose();
      } else if (e.key === "Escape" && !e.defaultPrevented && !conflict && !asking) {
        e.preventDefault();
        void requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, save, saveCopy, editable, requestClose, conflict, asking]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const Viewer = useMemo(() => (info ? lazy(info.load) : null), [info]);

  // ---------------------------------------------------------------- body
  let body: React.ReactNode;
  if (!info || !Viewer) {
    body = <Note icon="file">There's no preview for this kind of file.</Note>;
  } else if (state.status === "loading") {
    body = <Note spinner />;
  } else if (state.status === "too-large") {
    body = (
      <Note icon="file">
        <p>
          This file is {formatBytes(entry.size)}. Files up to {formatBytes(state.limit)} open {full ? "here" : "in the preview"}.
        </p>
        <div className="dv-note-actions">
          {!full && onOpenFull && state.limit < info.maxBytes && entry.size <= info.maxBytes && (
            <button className="btn btn-sm" onClick={() => onOpenFull(given)}>
              Open
            </button>
          )}
          {onOpenExternal && (
            <button className="btn btn-sm" onClick={() => onOpenExternal(given)}>
              Open in another app
            </button>
          )}
        </div>
      </Note>
    );
  } else if (state.status === "error") {
    body = (
      <Note icon="alert">
        <p>{errSummary(state.message)}</p>
        <div className="dv-note-actions">
          <button className="btn btn-sm" onClick={reload}>
            Try again
          </button>
        </div>
      </Note>
    );
  } else {
    const props: ViewerProps = {
      kind: info.kind,
      name: entry.name,
      bytes: state.bytes,
      text: state.text?.text ?? null,
      editable,
      mode,
      onEdit,
      onSave: () => void save(),
    };
    body = (
      <Suspense fallback={<Note spinner />}>
        <Viewer key={loadId} {...props} />
      </Suspense>
    );
  }

  // why a text file is read-only, when it is
  let readOnlyWhy: string | null = null;
  if (full && ready && archived && textDoc) readOnlyWhy = "Inside an archive, so it opens read-only. Extract it to edit.";
  else if (full && ready && native?.exports[0]) {
    const label = native.exports[0].label;
    readOnlyWhy = `Shown read-only, as ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}. Edit it in Google Drive.`;
  } else if (full && ready && textDoc && info?.canEdit === false && info.editMaxBytes > 0) readOnlyWhy = `Files over ${formatBytes(EDIT_MAX)} open read-only.`;
  else if (full && ready && textDoc?.lossy) readOnlyWhy = "This file isn't UTF-8 text, so it opens read-only to keep it intact.";
  else if (full && ready && textDoc && info && ready.bytes.length > info.editMaxBytes && info.editMaxBytes > 0) readOnlyWhy = `Files over ${formatBytes(info.editMaxBytes)} open read-only.`;

  // a native Google file opens in Drive in the browser, where it can be edited
  const gdriveUrl = native ? driveUrl(given) : null;
  const status = saving ? "Saving…" : saveError ? null : flash ? flash : dirty ? "Edited" : editable || !ready ? null : "Read only";
  const saveKey = isMac ? "⌘S" : "Ctrl+S";

  return (
    <div
      className={`dv ${full ? "dv-full" : "dv-preview"} ${inline ? "inline" : ""} ${full && macWindow && !inline ? "mac" : ""}`}
      onFocusCapture={(e) => {
        const t = e.target as HTMLElement;
        if (!t.closest(".dv-dialog-backdrop, .modal-backdrop")) lastFocus.current = t;
      }}
    >
      {full && (
        <header className="dv-bar" data-tauri-drag-region>
          <button className="dv-icon" onClick={() => void requestClose()} aria-label="Close" title="Close (Esc)">
            <Icon name="x" size={18} />
          </button>
          <div className="dv-title">
            <span className="dv-name selectable" title={target}>
              {dirty && <span className="dv-dot" aria-label="Unsaved changes" />}
              {name}
            </span>
            {status && <span className={`dv-sub ${flash ? "ok" : ""}`}>{status}</span>}
          </div>
          {onOpenExternal && (
            <button className="btn dv-ext" onClick={() => onOpenExternal(current)} title="Open in another app">
              <Icon name="reveal" size={15} />
              <span>Open in another app</span>
            </button>
          )}
          {editable && (
            <button className="btn btn-primary dv-save" onClick={() => void save()} disabled={!dirty || saving} title={`Save (${saveKey})`}>
              {saving ? <span className="spinner" /> : null}
              Save
            </button>
          )}
        </header>
      )}
      {readOnlyWhy && (
        <div className="dv-banner">
          <span>{readOnlyWhy}</span>
          {native && gdriveUrl && (
            <button className="btn btn-sm" onClick={() => void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(gdriveUrl)).catch(() => window.open(gdriveUrl, "_blank", "noopener"))}>
              <Icon name="external" size={13} /> Open in Google Drive
            </button>
          )}
        </div>
      )}
      {saveError && (
        <div className="dv-banner bad" role="alert">
          <span>Couldn't save. {saveError}</span>
          <button className="btn btn-sm" onClick={() => void save()}>
            Try again
          </button>
          <button className="dv-icon" onClick={() => setSaveError(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <div className="dv-body">{body}</div>
      {!full && onOpenFull && ready && (
        <button className="btn btn-sm dv-open-full" onClick={() => onOpenFull(given)} title={info?.canEdit && !native ? "Open to edit" : "Open"}>
          {info?.canEdit && !native ? "Edit" : "Open"}
        </button>
      )}
      {conflict && (
        <ConflictDialog
          name={name}
          current={conflict.current}
          dirty={dirty}
          busy={saving}
          onCancel={() => setConflict(null)}
          onOverwrite={() => void saveAs(target, { kind: "any" })}
          onCopy={() => void saveCopy()}
          onReload={() => {
            setConflict(null);
            setSource(target);
            reload();
          }}
        />
      )}
      {asking && (
        <UnsavedDialog
          name={name}
          busy={saving}
          onCancel={() => finishClose(false)}
          onDiscard={() => finishClose(true)}
          onSave={async () => {
            // a failed save (or a conflict, which opens its own question) keeps the view open
            finishClose(await save());
          }}
        />
      )}
    </div>
  );
}
