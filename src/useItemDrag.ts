/**
 * Pointer-driven drag of files/folders onto folders (rows, tiles, breadcrumb segments). Plain
 * mouse events rather than HTML5 drag-and-drop: the native webview drop handler (used for
 * Finder uploads) swallows HTML5 drags on some platforms, and this gives full control over the
 * ghost and hit-testing. Drop targets are any element with a `data-drop="<prefix>"` attribute, and
 * sidebar buckets marked `data-drop-bucket="<bucket>" data-drop-profile="<connection id>"` (the
 * items land at that bucket's top level). Between buckets a drop copies, like Finder between
 * disks; hold ⌘ to move instead. Within a bucket it moves; hold ⌥ to copy.
 *
 * Dual pane: every pane's root carries `data-pane="<id>"` and `data-drop-pane`. A drop on a folder,
 * breadcrumb or empty space of ANOTHER pane goes to that pane's place (`paneTarget` decides and
 * names it), and copies like a drop into another bucket (⌘ moves).
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
  /** destination bucket when it is another bucket of the connection (a sidebar bucket) */
  bucket: string | null;
  /** the other pane the items would land in, and how to name that place */
  pane: string | null;
  label: string | null;
  copy: boolean;
};

const THRESHOLD = 5;
const SPRING_MS = 900;

export function useItemDrag<P extends string = string>({
  paneId,
  onDrop,
  onSpring,
  bucketTarget,
  paneTarget,
}: {
  /** the pane the drag starts in (dual pane) */
  paneId?: P;
  onDrop: (items: Entry[], dest: string, copy: boolean, destBucket: string | null, pane: P | null) => void;
  /** hovering a folder for a moment opens it (Finder's spring-loaded folders) */
  onSpring: (dest: string) => void;
  /**
   * Whether a sidebar bucket accepts the items: null = no, "same" = the bucket they are in (a
   * move to its top level), "other" = another bucket of the same connection.
   */
  bucketTarget?: (profileId: string, bucket: string) => "same" | "other" | null;
  /**
   * Whether another pane accepts the items at `dest` (a folder there; null = the folder it
   * shows), and the label of that place; null = no.
   */
  paneTarget?: (pane: P, dest: string | null, items: Entry[]) => { dest: string; label: string } | null;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const cbs = useRef({ paneId, onDrop, onSpring, bucketTarget, paneTarget });
  cbs.current = { paneId, onDrop, onSpring, bucketTarget, paneTarget };
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
    let destBucket: string | null = null;
    let destPane: P | null = null;
    let label: string | null = null;
    let alt = false;
    let meta = false;
    let springTimer = 0;
    let springFor: string | null = null;
    const isCopy = () => (destBucket != null || destPane != null ? !meta : alt);

    const light = (el: HTMLElement | null) => {
      if (lit === el) return;
      lit?.classList.remove("drop-target");
      lit = el;
      lit?.classList.add("drop-target");
    };

    const hit = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop], [data-drop-bucket], [data-drop-pane]") ?? null;
      let d = el?.getAttribute("data-drop") ?? null;
      destBucket = null;
      destPane = null;
      label = null;
      const pane = (el?.closest("[data-pane]")?.getAttribute("data-pane") ?? null) as P | null;
      let ok = false;
      if (el && pane && cbs.current.paneId && pane !== cbs.current.paneId) {
        // a place in the other pane
        const t = d != null || el.hasAttribute("data-drop-pane") ? cbs.current.paneTarget?.(pane, d, items) : null;
        if (t) {
          d = t.dest;
          destPane = pane;
          label = t.label;
          ok = true;
        }
      } else if (el && (d != null || !el.hasAttribute("data-drop-pane"))) {
        if (d == null) {
          const kind = cbs.current.bucketTarget?.(el.getAttribute("data-drop-profile") ?? "", el.getAttribute("data-drop-bucket") ?? "") ?? null;
          if (kind) d = "";
          if (kind === "other") destBucket = el.getAttribute("data-drop-bucket");
        }
        ok = d != null && (destBucket != null || isValidDest(items, d));
      }
      light(ok ? el : null);
      dest = ok ? d : null;
      if (!ok) {
        destBucket = null;
        destPane = null;
        label = null;
      }
      // spring-load folder rows/tiles (not breadcrumbs: those are one click away anyway)
      const springable = ok && !destPane && el!.hasAttribute("data-spring") ? d : null;
      if (springable !== springFor) {
        window.clearTimeout(springTimer);
        springFor = springable;
        if (springable != null)
          springTimer = window.setTimeout(() => {
            light(null);
            dest = null;
            destBucket = null;
            setDrag((st) => (st ? { ...st, dest: null, bucket: null, pane: null, label: null } : st));
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
      alt = e.altKey;
      meta = e.metaKey;
      hit(e.clientX, e.clientY);
      setDrag({ items, x: e.clientX, y: e.clientY, dest, bucket: destBucket, pane: destPane, label, copy: isCopy() });
    };
    const up = (e: MouseEvent) => {
      const wasActive = active;
      const d = dest;
      const b = destBucket;
      const p = destPane;
      alt = e.altKey;
      meta = e.metaKey;
      const c = isCopy();
      end();
      if (!wasActive) onClick?.();
      else if (d != null) cbs.current.onDrop(items, d, c, b, p);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && active) {
        e.preventDefault();
        e.stopPropagation();
        end();
      } else if ((e.key === "Alt" || e.key === "Meta") && active) {
        if (e.key === "Alt") alt = e.type === "keydown";
        else meta = e.type === "keydown";
        const copy = isCopy();
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
