import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Keeps its children on screen for a moment after `show` turns false, marked `m-leaving`, so
 * screens and sheets can animate out instead of vanishing.
 */
export function Presence({ show, children, ms = 220 }: { show: boolean; children: ReactNode; ms?: number }) {
  const [mounted, setMounted] = useState(show);
  const last = useRef<ReactNode>(children);
  if (show) last.current = children;
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [show, ms]);
  if (!show && !mounted) return null;
  return <div className={`m-presence ${show ? "" : "m-leaving"}`}>{show ? children : last.current}</div>;
}

/** Tablets and landscape phones wide enough for a sidebar next to the files. */
export function useWide(min = 900) {
  const q = `(min-width: ${min}px)`;
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
