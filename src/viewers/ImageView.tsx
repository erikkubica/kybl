/**
 * Images with zoom: fit to the window, actual size, buttons, ⌘/Ctrl + scroll, pinch on touch
 * screens, double-click or double-tap to switch between fit and actual size. SVGs are shown
 * through <img>, which never runs scripts inside them.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ToolButton } from "./ui";
import type { ViewerProps } from "./types";
import { releaseOnUnmount } from "../releaseMedia";

const TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
};
const MIN = 0.05;
const MAX = 16;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

export default function ImageView({ name, bytes, mode }: ViewerProps) {
  const full = mode === "full";
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  /** null = fit to the window */
  const [scale, setScale] = useState<number | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const type = TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "";
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], type ? { type } : {}));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, name]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = natural && box.w ? Math.min(1, (box.w - 24) / natural.w, (box.h - 24) / natural.h) : 1;
  const s = scale ?? fit;

  /** zoom to `next`, keeping the point under (cx, cy) where it is */
  const zoomTo = (next: number, cx?: number, cy?: number) => {
    const el = stage.current;
    next = clamp(next);
    if (!el) return setScale(next);
    const r = el.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - r.left;
    const py = (cy ?? r.top + r.height / 2) - r.top;
    const ratio = next / s;
    const left = (el.scrollLeft + px) * ratio - px;
    const top = (el.scrollTop + py) * ratio - py;
    setScale(next);
    requestAnimationFrame(() => {
      el.scrollLeft = left;
      el.scrollTop = top;
    });
  };

  // ⌘/Ctrl + wheel (and trackpad pinch, which arrives as ctrl + wheel)
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(s * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // two-finger pinch on touch screens; one finger scrolls natively
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; s0: number } | null>(null);
  const lastTap = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      pinch.current = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s };
    } else {
      const now = performance.now();
      if (now - lastTap.current < 300) toggle(e.clientX, e.clientY);
      lastTap.current = now;
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      zoomTo(pinch.current.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.d0), (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
  };
  const toggle = (cx?: number, cy?: number) => (scale === null || Math.abs(s - fit) < 0.01 ? zoomTo(fit < 1 ? 1 : Math.min(MAX, fit * 2), cx, cy) : setScale(null));

  return (
    <div className="dv-viewer dv-image">
      {full && (
        <div className="dv-tools">
          <ToolButton label="Fit" pressed={scale === null} onClick={() => setScale(null)} />
          <ToolButton label="Actual size" pressed={scale === 1} onClick={() => zoomTo(1)} />
          <ToolButton label="Zoom out" onClick={() => zoomTo(s / 1.25)} title="Zoom out (⌘−)" />
          <span className="dv-zoom">{Math.round(s * 100)}%</span>
          <ToolButton label="Zoom in" onClick={() => zoomTo(s * 1.25)} title="Zoom in (⌘+)" />
          {natural && (
            <span className="dv-status">
              {natural.w} × {natural.h}
            </span>
          )}
        </div>
      )}
      <div
        ref={stage}
        className={`dv-image-stage ${s > fit + 0.001 ? "zoomed" : ""}`}
        onDoubleClick={(e) => full && toggle(e.clientX, e.clientY)}
        onPointerDown={full ? onDown : undefined}
        onPointerMove={full ? onMove : undefined}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {failed ? (
          <p className="dv-image-failed">This image couldn't be shown.</p>
        ) : (
          url && (
            <img
              ref={releaseOnUnmount}
              src={url}
              alt={name}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })}
              onError={() => setFailed(true)}
              style={natural ? { width: natural.w * s, height: natural.h * s } : { visibility: "hidden" }}
            />
          )
        )}
      </div>
    </div>
  );
}
