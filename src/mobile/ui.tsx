import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Keeps its children on screen for a moment after `show` turns false, marked `m-leaving`, so
 * screens and sheets can animate out instead of vanishing.
 */
export function Presence({ show, children, ms = 220, layer, z }: { show: boolean; children: ReactNode; ms?: number; layer?: string; z?: number }) {
  const [mounted, setMounted] = useState(show);
  const last = useRef<ReactNode>(children);
  // a closing layer keeps its place in the stack while it animates out
  const lastZ = useRef(z);
  if (show) {
    last.current = children;
    lastZ.current = z;
  }
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [show, ms]);
  if (!show && !mounted) return null;
  return (
    // leaving: its buttons still hold the handlers of the open layer, so they must not take input
    // (a double tap would run an action twice, or go back two levels)
    <div className={`m-presence ${show ? "" : "m-leaving"}`} inert={!show} aria-hidden={!show || undefined} data-layer={layer} style={lastZ.current == null ? undefined : ({ "--m-z": lastZ.current } as React.CSSProperties)}>
      {show ? children : last.current}
    </div>
  );
}

/** A layer without an exit animation (dialogs): its place in the stack, as `--m-z`. */
export function Layer({ id, z, children }: { id: string; z: number; children: ReactNode }) {
  return (
    <div className="m-presence" data-layer={id} style={{ "--m-z": z } as React.CSSProperties}>
      {children}
    </div>
  );
}

/**
 * Tablets: wide enough for a sidebar next to the files, and tall enough for it to be useful. The
 * height keeps big phones on the phone layout when turned sideways (a Pro Max is ~930 pt wide
 * but only ~430 pt tall in landscape).
 */
export function useWide(minWidth = 900, minHeight = 600) {
  const q = `(min-width: ${minWidth}px) and (min-height: ${minHeight}px)`;
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return wide;
}

/**
 * Large-title headers: true once the big title has scrolled under the bar, which then shows the
 * small title and its background.
 */
export function useCollapsed<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest(".m-scroll");
    const io = new IntersectionObserver(([x]) => setCollapsed(!x.isIntersecting), {
      root,
      // the bar covers the top of the scroller
      rootMargin: "0px 0px 0px 0px",
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [dep]);
  return [ref, collapsed] as const;
}
