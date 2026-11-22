import { useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../Icons";

/**
 * The path, fitted to the room it has. The bucket and the current folder always show; when the
 * whole path does not fit, the folders in between fold into "…" starting from the top, so the ones
 * nearest the current folder stay longest. Only when bucket › … › current is still too wide does the
 * current folder's name get cut short.
 *
 * Every crumb is measured once in a hidden copy (per path), and the fold is worked out from those
 * widths and the width of the bar, so resizing the window never needs another layout pass.
 */
export function Breadcrumbs({
  bucket,
  parts,
  onNavigate,
  compact = false,
  label = bucket,
  icon = "bucket",
  onGoTo,
}: {
  bucket: string;
  /** the root's icon (connections/roots.ts `rootIcon`): a bucket, a drive, a folder, a server */
  icon?: IconName;
  /** what the root is called on screen, when that isn't its id (this computer's folders) */
  label?: string;
  parts: string[];
  onNavigate: (prefix: string) => void;
  /** narrow bars (phones): inside a folder the bucket shows as its icon only */
  compact?: boolean;
  /**
   * Click the current folder's name (or press ⇧⌘G) to type a path; Return goes there (same rules
   * as Go to folder), Escape or clicking away cancels. The empty part of the bar stays the
   * window's drag area.
   */
  onGoTo?: (path: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const editInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (editing != null) editInput.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing != null]);
  // ⇧⌘G (Go to folder) opens the bar of the pane it is sent to
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el || !onGoTo) return;
    const open = () => setEditing("/" + parts.map((p) => p + "/").join(""));
    el.addEventListener("kybl-edit-path", open);
    return () => el.removeEventListener("kybl-edit-path", open);
  });
  const nav = useRef<HTMLElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  // [bucket, "…", ...parts], each with its separator
  const [widths, setWidths] = useState<number[]>([]);

  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    setRoom(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const path = parts.join("/");
  const iconOnly = compact && parts.length > 0;
  useLayoutEffect(() => {
    const el = ruler.current;
    if (el) setWidths([...el.children].map((c) => c.getBoundingClientRect().width));
  }, [label, path, iconOnly]);

  const n = parts.length;
  let fold = 0; // how many leading folders hide behind "…"
  if (room > 0 && widths.length === n + 2) {
    const sum = (from: number) => widths.slice(from).reduce((a, b) => a + b, 0);
    const width = (f: number) => widths[0] + (f > 0 ? widths[1] : 0) + sum(2 + f);
    while (fold < n - 1 && width(fold) > room) fold++;
  }

  const prefixOf = (i: number) => parts.slice(0, i + 1).join("/") + "/";
  const startEdit = () => setEditing("/" + parts.map((p) => p + "/").join(""));
  // the folder you're in: a click types a path (going to it again would do nothing)
  const here = (go: () => void) => (onGoTo ? startEdit : go);
  const hereTitle = (name: string) => (onGoTo ? `${name} · click to type a path (⇧⌘G)` : name);
  const sep = <Icon name="chevron" size={12} className="crumb-sep" />;

  if (editing != null && onGoTo)
    return (
      <nav className="crumbs editing" aria-label="Path" ref={nav}>
        <Icon name={icon} size={15} />
        <input
          ref={editInput}
          className="crumbs-input"
          value={editing}
          aria-label={`Path in ${label}`}
          placeholder="/photos/2026 or s3://bucket/photos"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => setEditing(e.target.value)}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const v = editing.trim();
              setEditing(null);
              if (v) onGoTo(v);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(null);
            }
          }}
        />
      </nav>
    );

  return (
    <nav className={`crumbs ${onGoTo ? "can-edit" : ""}`} aria-label="Path" data-tauri-drag-region ref={nav}>
      <div className="crumbs-ruler" ref={ruler} aria-hidden="true">
        <span className="crumb-wrap">
          <span className="crumb current">
            <Icon name={icon} size={15} />
            {!iconOnly && <span className="crumb-label">{label}</span>}
          </span>
        </span>
        <span className="crumb-wrap">
          {sep}
          <span className="crumb">…</span>
        </span>
        {parts.map((p, i) => (
          <span key={i} className="crumb-wrap">
            {sep}
            <span className="crumb current">
              <span className="crumb-label">{p}</span>
            </span>
          </span>
        ))}
      </div>

      <span className={`crumb-wrap crumb-root ${iconOnly ? "icon-only" : ""}`}>
        <button
          className={`crumb ${n === 0 ? "current" : ""}`}
          data-drop=""
          title={n === 0 ? hereTitle(label) : label}
          aria-label={label}
          onClick={n === 0 ? here(() => onNavigate("")) : () => onNavigate("")}
        >
          <Icon name={icon} size={15} />
          {!iconOnly && <span className="crumb-label">{label}</span>}
        </button>
      </span>
      {fold > 0 && (
        <span className="crumb-wrap">
          {sep}
          <button className="crumb" data-drop={prefixOf(fold - 1)} title={"/" + parts.slice(0, fold).join("/")} onClick={() => onNavigate(prefixOf(fold - 1))}>
            …
          </button>
        </span>
      )}
      {parts.map((p, i) =>
        i < fold ? null : (
          <span key={i} className={`crumb-wrap ${i === n - 1 ? "crumb-here" : ""}`}>
            {sep}
            <button
              className={`crumb ${i === n - 1 ? "current" : ""}`}
              data-drop={prefixOf(i)}
              title={i === n - 1 ? hereTitle(p) : p}
              onClick={i === n - 1 ? here(() => onNavigate(prefixOf(i))) : () => onNavigate(prefixOf(i))}
            >
              <span className="crumb-label">{p}</span>
            </button>
          </span>
        ),
      )}
    </nav>
  );
}
