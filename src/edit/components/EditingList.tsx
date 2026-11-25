/**
 * "Editing (n)" in the Activity panel's header: the files being edited in another app, how their
 * last save went, and Stop editing (which deletes the copy on this computer).
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../ui/components/Icons";
import { askAgain, editApi, useEditSessions, type EditSession } from "../lib/editStore";
import "./edit.css";

const formatTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stateOf(s: EditSession): { text: string; tone: "" | "ok" | "warn" | "bad" } {
  switch (s.phase) {
    case "uploading":
      return { text: "Uploading…", tone: "" };
    case "uploaded":
      return { text: s.lastUpload ? `Uploaded ${formatTime(s.lastUpload)}` : "Uploaded", tone: "ok" };
    case "conflict":
      return { text: s.server ? "Changed on the server" : "Deleted on the server", tone: "warn" };
    case "error":
      return { text: "Upload failed", tone: "bad" };
    default:
      return { text: "Waiting for a save", tone: "" };
  }
}

export function EditingChip({
  connectionName,
  onStop,
  onReopen,
  onReveal,
}: {
  connectionName: (profileId: string) => string;
  /** asks first when the copy has changes the server doesn't have */
  onStop: (list: EditSession[]) => void;
  onReopen: (s: EditSession) => void;
  onReveal: (s: EditSession) => void;
}) {
  const list = useEditSessions();
  const [open, setOpen] = useState(false);
  // fixed above the chip, kept inside the window (the chip can sit anywhere in the panel's header)
  const [at, setAt] = useState<React.CSSProperties>({});
  const toggle = (btn: HTMLElement) => {
    if (!open) {
      const r = btn.getBoundingClientRect();
      const w = Math.min(460, window.innerWidth - 32);
      setAt({ position: "fixed", bottom: window.innerHeight - r.top + 8, left: Math.max(16, Math.min(r.right - w, window.innerWidth - w - 16)), width: w });
    }
    setOpen(!open);
  };
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // a dialog opened from here ("Stop editing?", a conflict) sits on top: its Esc, not ours
        if (document.querySelector(".modal-backdrop")) return;
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  useEffect(() => {
    if (!list.length) setOpen(false);
  }, [list.length]);
  if (!list.length) return null;
  const attention = list.some((s) => s.phase === "conflict" || s.phase === "error");
  const busy = list.some((s) => s.phase === "uploading");
  return (
    <div className="ed-chip-wrap" ref={box} onClick={(e) => e.stopPropagation()}>
      <button className={`ed-chip ${open ? "on" : ""}`} onClick={(e) => toggle(e.currentTarget)} aria-expanded={open} title="Files you're editing in other apps">
        {busy ? <span className="spinner" /> : <Icon name="edit" size={12} />}
        Editing
        <span className={`pill ${attention ? "warn" : ""}`}>{list.length}</span>
      </button>
      {open && (
        <div className="ed-pop" style={at} role="dialog" aria-label="Files being edited">
          <div className="ed-pop-head">
            <strong>Editing</strong>
            <span className="ed-dim">Saving a file uploads it</span>
          </div>
          <ul className="ed-rows">
            {list.map((s) => {
              const st = stateOf(s);
              return (
                <li key={s.id} className="ed-row">
                  <div className="ed-row-main">
                    <span className="ed-name" title={s.key}>
                      {s.name}
                    </span>
                    <span className="ed-sub">
                      {connectionName(s.profileId)} · {s.rule === "auto" ? "uploads every save" : "uploads if unchanged on the server"}
                    </span>
                  </div>
                  <span className={`ed-state ${st.tone}`} title={s.error ?? undefined}>
                    {st.text}
                  </span>
                  <div className="ed-row-acts">
                    {s.phase === "conflict" && (
                      <button className="btn btn-sm" onClick={() => askAgain(s.id)}>
                        Resolve…
                      </button>
                    )}
                    {s.phase === "error" && (
                      <button className="btn btn-sm" onClick={() => void editApi.retry(s.id).catch(() => {})}>
                        Retry
                      </button>
                    )}
                    <button className="icon-btn" onClick={() => onReopen(s)} title="Open it again" aria-label={`Open ${s.name} again`}>
                      <Icon name="external" size={14} />
                    </button>
                    <button className="icon-btn" onClick={() => onReveal(s)} title="Show the copy on this computer" aria-label={`Show the copy of ${s.name}`}>
                      <Icon name="reveal" size={14} />
                    </button>
                    <button className="icon-btn" onClick={() => onStop([s])} title="Stop editing (deletes the copy on this computer)" aria-label={`Stop editing ${s.name}`}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {list.length > 1 && (
            <div className="ed-pop-foot">
              <button className="btn btn-sm" onClick={() => onStop(list)}>
                Stop editing all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
