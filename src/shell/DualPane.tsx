/**
 * Two browser panes side by side with a draggable splitter (double-click resets it, arrow keys
 * nudge it). In a window too narrow for two lists side by side, the panes stack instead.
 * The split is kept between launches.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LS } from "../browser/types";
import { Icon, type IconName } from "../Icons";

const SPLIT_KEY = "s3b.split";
const MIN = 0.2;
const MAX = 0.8;
/** below this width (CSS px) the two panes stack */
const STACK_BELOW = 760;

const clamp = (r: number) => Math.min(MAX, Math.max(MIN, r));
function loadRatio(): number {
  const r = Number(LS.get(SPLIT_KEY));
  return r >= MIN && r <= MAX ? r : 0.5;
}

export function DualPane({
  left,
  right,
}: {
  left: (style: React.CSSProperties) => ReactNode;
  right: (style: React.CSSProperties) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(loadRatio);
  const [stacked, setStacked] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStacked(el.clientWidth < STACK_BELOW));
    ro.observe(el);
    setStacked(el.clientWidth < STACK_BELOW);
    return () => ro.disconnect();
  }, []);

  const save = (r: number) => LS.set(SPLIT_KEY, String(r));
  const startDrag = (ev: React.MouseEvent) => {
    const el = box.current;
    if (!el || ev.button !== 0) return;
    ev.preventDefault();
    const rect = el.getBoundingClientRect();
    let r = ratio;
    document.body.classList.add(stacked ? "resizing-row" : "resizing-col");
    const move = (e: MouseEvent) => {
      r = clamp(stacked ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width);
      setRatio(r);
    };
    const up = () => {
      document.body.classList.remove("resizing-col", "resizing-row");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      save(r);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const nudge = (d: number) => {
    const r = clamp(ratio + d);
    setRatio(r);
    save(r);
  };

  return (
    <div className={`dual ${stacked ? "stacked" : ""}`} ref={box}>
      {left({ flex: `${ratio} 1 0px` })}
      <div
        className="dual-split"
        role="separator"
        aria-orientation={stacked ? "horizontal" : "vertical"}
        aria-label="Resize the panes"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={MIN * 100}
        aria-valuemax={MAX * 100}
        tabIndex={0}
        title="Drag to resize · double-click to make both the same size"
        onMouseDown={startDrag}
        onDoubleClick={() => {
          setRatio(0.5);
          save(0.5);
        }}
        onKeyDown={(e) => {
          const back = stacked ? "ArrowUp" : "ArrowLeft";
          const fwd = stacked ? "ArrowDown" : "ArrowRight";
          if (e.key === back || e.key === fwd) {
            e.preventDefault();
            nudge(e.key === back ? -0.05 : 0.05);
          }
        }}
      />
      {right({ flex: `${1 - ratio} 1 0px` })}
    </div>
  );
}

/** A pane's dual-pane buttons, before its "…": this folder into the other pane, swap, compare, follow. */
export function DualTools({
  side,
  onToOther,
  onSwap,
  onCompare,
  syncBrowsing,
  onSyncBrowsing,
}: {
  side: "left" | "right";
  onToOther: () => void;
  onSwap: () => void;
  onCompare: () => void;
  syncBrowsing: boolean;
  onSyncBrowsing: () => void;
}) {
  const b = (icon: IconName, label: string, run: () => void, on?: boolean) => (
    <button type="button" className={`icon-btn ${on ? "on" : ""}`} onClick={run} title={label} aria-label={label} aria-pressed={on}>
      <Icon name={icon} />
    </button>
  );
  return (
    <>
      {side === "left" ? b("arrow-right", "Open this folder in the right pane too", onToOther) : b("arrow-left", "Open this folder in the left pane too", onToOther)}
      {b("swap", "Swap panes (⇧⌘S)", onSwap)}
      {b("columns", "Compare the two folders", onCompare)}
      {b("link", syncBrowsing ? "Synchronized browsing: on (both panes follow each other)" : "Synchronized browsing: off", onSyncBrowsing, syncBrowsing)}
    </>
  );
}
