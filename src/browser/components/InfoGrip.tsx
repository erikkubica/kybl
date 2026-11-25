/**
 * The info panel's left edge: drag it to make the panel wider or narrower (double-click: back to
 * the default; arrow keys while it has focus). The width is the pane's own, kept with its other
 * view choices (usePane `infoW`), and never more than half the pane, so the list keeps its room.
 */
import { useRef, useState } from "react";

export const INFO_W = 248;
const INFO_MIN = 200;

export function InfoGrip({ width, onWidth }: { width: number | null; onWidth: (w: number | null) => void }) {
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /** half of what the list and the panel share: the most the panel may take */
  const max = () => (ref.current?.parentElement?.parentElement?.getBoundingClientRect().width ?? 800) / 2;
  const clamp = (w: number) => Math.round(Math.max(INFO_MIN, Math.min(max(), w)));

  const start = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = ref.current?.parentElement?.getBoundingClientRect().width ?? width ?? INFO_W;
    setOn(true);
    document.body.classList.add("info-resizing");
    // the panel sits right of its edge: dragging left makes it wider
    const move = (e: PointerEvent) => onWidth(clamp(startW - (e.clientX - startX)));
    const up = () => {
      setOn(false);
      document.body.classList.remove("info-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const key = (ev: React.KeyboardEvent) => {
    const d = ev.key === "ArrowLeft" ? 16 : ev.key === "ArrowRight" ? -16 : 0;
    if (!d) return;
    ev.preventDefault();
    onWidth(clamp((width ?? INFO_W) + d));
  };

  return (
    <div
      ref={ref}
      className={`info-grip ${on ? "on" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Info panel width"
      aria-valuenow={width ?? INFO_W}
      tabIndex={0}
      title="Drag to resize · double-click for the default width"
      onPointerDown={start}
      onDoubleClick={() => onWidth(null)}
      onKeyDown={key}
    />
  );
}
