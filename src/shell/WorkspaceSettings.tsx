/**
 * A workspace's settings, in a popover under its tab (the tab's cog, or "Settings…" in its menu):
 * its name, a colour for its tab, where it opens when Kybl starts, and Duplicate / Close.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../Icons";
import { WS_COLORS, type StartMode } from "./workspaces";

export type WorkspaceSettingsProps = {
  name: string;
  color: string | null;
  start: StartMode;
  /** what "At these folders" opens, in a few words ("2 panes · Photos, Downloads"), or null before it was saved */
  savedSummary: string | null;
  /** what is open now, in the same few words */
  nowSummary: string;
  /** the saved folders are the ones open now (nothing to take over) */
  savedIsNow: boolean;
  canClose: boolean;
  anchor: DOMRect;
  onRename: (name: string) => void;
  onColor: (color: string | null) => void;
  onStart: (mode: StartMode) => void;
  /** "Use the folders open now": the workspace's start becomes what it shows */
  onSaveStart: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  onDismiss: () => void;
};

const WIDTH = 300;

export function WorkspaceSettings(p: WorkspaceSettingsProps) {
  const box = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(p.name);
  const nameRef = useRef(name);
  nameRef.current = name;
  const dismiss = useRef(p.onDismiss);
  dismiss.current = p.onDismiss;
  const rename = useRef(p.onRename);
  rename.current = p.onRename;
  const left = Math.max(8, Math.min(window.innerWidth - WIDTH - 8, p.anchor.left));
  const top = p.anchor.bottom + 6;

  // a name typed and then left (a click elsewhere, Escape) is kept
  const commit = () => {
    const n = nameRef.current.trim();
    if (n && n !== p.name) rename.current(n);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (box.current?.contains(t) || t.closest?.(".ws-cog, .ctx-menu")) return;
      commitRef.current();
      dismiss.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      commitRef.current();
      dismiss.current();
    };
    const away = () => {
      commitRef.current();
      dismiss.current();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", away);
    };
  }, []);
  // the name field takes the keyboard when it opens
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  return (
    <div className="ws-pop" ref={box} role="dialog" aria-label="Workspace settings" style={{ left, top, width: WIDTH }}>
      <label className="field ws-pop-name">
        <span>Name</span>
        <input
          value={name}
          maxLength={80}
          spellCheck={false}
          autoCorrect="off"
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>

      <div className="ws-pop-label">Color</div>
      <div className="ws-colors" role="radiogroup" aria-label="Color">
        <button
          type="button"
          role="radio"
          aria-checked={!p.color}
          className={`ws-swatch none ${!p.color ? "on" : ""}`}
          title="No color"
          aria-label="No color"
          onClick={() => p.onColor(null)}
        />
        {WS_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={p.color === c.id}
            className={`ws-swatch ${p.color === c.id ? "on" : ""}`}
            style={{ background: c.value }}
            title={c.label}
            aria-label={c.label}
            onClick={() => p.onColor(c.id)}
          />
        ))}
      </div>

      <div className="ws-pop-label">When Kybl opens</div>
      <div className="ws-start" role="radiogroup" aria-label="When Kybl opens">
        <button type="button" role="radio" aria-checked={p.start === "restore"} className={`ws-choice ${p.start === "restore" ? "on" : ""}`} onClick={() => p.onStart("restore")}>
          <span className="ws-radio" aria-hidden />
          <span>
            <b>Where I left off</b>
            <small>The folders this workspace showed last</small>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={p.start === "saved"} className={`ws-choice ${p.start === "saved" ? "on" : ""}`} onClick={() => p.onStart("saved")}>
          <span className="ws-radio" aria-hidden />
          <span>
            <b>Always at these folders</b>
            <small>{p.savedSummary ?? p.nowSummary}</small>
          </span>
        </button>
        {p.start === "saved" && (
          <button type="button" className="btn btn-sm ws-save-start" onClick={p.onSaveStart} disabled={p.savedIsNow} title={p.savedIsNow ? "These are the folders open now" : `Now open: ${p.nowSummary}`}>
            <Icon name="refresh" size={12} />
            Use the folders open now
          </button>
        )}
      </div>

      <div className="ws-pop-foot">
        <button type="button" className="btn btn-sm" onClick={p.onDuplicate}>
          <Icon name="copy" size={12} />
          Duplicate
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger-ghost"
          onClick={p.onClose}
          disabled={!p.canClose}
          title={p.canClose ? undefined : "There is always at least one workspace"}
        >
          Close workspace
        </button>
      </div>
    </div>
  );
}
