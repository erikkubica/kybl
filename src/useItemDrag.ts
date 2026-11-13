/**
 * Pointer-driven drag of files/folders onto folders (rows, tiles, breadcrumb segments). Plain
 * mouse events rather than HTML5 drag-and-drop: the native webview drop handler (used for
 * Finder uploads) swallows HTML5 drags on some platforms, and this gives full control over the
 * ghost and hit-testing. Drop targets are any element with a `data-drop="<prefix>"` attribute.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isValidDest } from "./moving";
import type { Entry } from "./types";

export type DragState = {
  items: Entry[];
  x: number;
  y: number;
  /** destination prefix under the pointer, if it accepts the items */
  dest: string | null;
  copy: boolean;
};

const THRESHOLD = 5;
const SPRING_MS = 900;

export function useItemDrag({
  onDrop,
  onSpring,
}: {
  onDrop: (items: Entry[], dest: string, copy: boolean) => void;
  /** hovering a folder for a moment opens it (Finder's spring-loaded folders) */
  onSpring: (dest: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const cbs = useRef({ onDrop, onSpring });
  cbs.current = { onDrop, onSpring };
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const begin = useCallback((ev: React.MouseEvent, items: Entry[], onClick?: () => void) => {
    if (ev.button !== 0 || items.length === 0) return;
    cleanup.current?.();
    const sx = ev.clientX;
    const sy = ev.clientY;
    let active = false;
    let lit: HTMLElement | null = null;
    let dest: string | null = null;
    let copy = false;
    let springTimer = 0;
    let springFor: string | null = null;

    const light = (el: HTMLElement | null) => {
      if (lit === el) return;
      lit?.classList.remove("drop-target");
      lit = el;
      lit?.classList.add("drop-target");
    };

    const hit = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]") ?? null;
      const d = el?.getAttribute("data-drop");
      const ok = el && d != null && isValidDest(items, d);
      light(ok ? el : null);
      dest = ok ? d! : null;
      // spring-load folder rows/tiles (not breadcrumbs: those are one click away anyway)
      const springable = ok && el!.hasAttribute("data-spring") ? d! : null;
      if (springable !== springFor) {
        window.clearTimeout(springTimer);
        springFor = springable;
        if (springable != null)
          springTimer = window.setTimeout(() => {
            light(null);
            dest = null;
            setDrag((st) => (st ? { ...st, dest: null } : st));
            cbs.current.onSpring(springable);
          }, SPRING_MS);
      }
    };

    const move = (e: MouseEvent) => {
      if (!active) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < THRESHOLD) return;
        active = true;
        document.body.classList.add("dragging-items");
      }
      copy = e.altKey;
      hit(e.clientX, e.clientY);
      setDrag({ items, x: e.clientX, y: e.clientY, dest, copy });
    };
    const up = (e: MouseEvent) => {
      const wasActive = active;
      const d = dest;
      const c = e.altKey;
      end();
      if (!wasActive) onClick?.();
      else if (d != null) cbs.current.onDrop(items, d, c);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && active) {
        e.preventDefault();
        e.stopPropagation();
        end();
      } else if (e.key === "Alt" && active) {
        copy = e.type === "keydown";
        setDrag((s) => (s ? { ...s, copy } : s));
      }
    };
    const end = () => {
      window.clearTimeout(springTimer);
      light(null);
      document.body.classList.remove("dragging-items");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      cleanup.current = null;
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    cleanup.current = end;
  }, []);

  return { drag, begin };
}
