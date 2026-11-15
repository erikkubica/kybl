import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../Icons";

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
}: {
  bucket: string;
  parts: string[];
  onNavigate: (prefix: string) => void;
  /** narrow bars (phones): inside a folder the bucket shows as its icon only */
  compact?: boolean;
}) {
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
  }, [bucket, path, iconOnly]);

  const n = parts.length;
  let fold = 0; // how many leading folders hide behind "…"
  if (room > 0 && widths.length === n + 2) {
    const sum = (from: number) => widths.slice(from).reduce((a, b) => a + b, 0);
    const width = (f: number) => widths[0] + (f > 0 ? widths[1] : 0) + sum(2 + f);
    while (fold < n - 1 && width(fold) > room) fold++;
  }

  const prefixOf = (i: number) => parts.slice(0, i + 1).join("/") + "/";
  const sep = <Icon name="chevron" size={12} className="crumb-sep" />;

  return (
    <nav className="crumbs" aria-label="Path" data-tauri-drag-region ref={nav}>
      <div className="crumbs-ruler" ref={ruler} aria-hidden="true">
        <span className="crumb-wrap">
          <span className="crumb current">
            <Icon name="bucket" size={15} />
            {!iconOnly && <span className="crumb-label">{bucket}</span>}
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
        <button className={`crumb ${n === 0 ? "current" : ""}`} data-drop="" title={bucket} aria-label={bucket} onClick={() => onNavigate("")}>
          <Icon name="bucket" size={15} />
          {!iconOnly && <span className="crumb-label">{bucket}</span>}
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
            <button className={`crumb ${i === n - 1 ? "current" : ""}`} data-drop={prefixOf(i)} title={p} onClick={() => onNavigate(prefixOf(i))}>
              <span className="crumb-label">{p}</span>
            </button>
          </span>
        ),
      )}
    </nav>
  );
}
