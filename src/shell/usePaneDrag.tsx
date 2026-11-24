/**
 * Rearranging panes by dragging one by the empty part of its header, as editor groups dock in a
 * code editor. Past a few pixels the pane lifts: a small ghost (its badge and folder name) follows
 * the pointer and the pane dims. Over another pane, an overlay shows where it would land: a half
 * at an edge docks it there (that pane splits that way), the middle swaps the two. Near the outer
 * edge of all the panes, a band docks it along that whole side (full width at the bottom, full
 * height at a side), the way a code editor's panel docks. A zone that
 * would leave the panes too little room shows as refused; one that changes nothing isn't offered.
 *
 * Over a workspace's tab: letting go there moves the pane into that workspace, and resting on the
 * tab for a moment opens that workspace (WorkspaceBar `springLoader`) with the drag still going,
 * to drop the pane into its layout. What a drop does is the shell's business (`check`, `onDrop`,
 * `onToWorkspace`); this only tracks the pointer and draws.
 *
 * The pointer is captured by the document's body once the drag starts, so it survives the panes
 * re-rendering (or a workspace switching) under it. The drag ends on release, and also when a
 * move arrives with no button down or the capture is lost: a release the web view never passed
 * on cancels rather than dropping wherever the pointer is by then. Escape cancels.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PaneId } from "../browser/types";
import { ProviderBadge } from "../components/Sidebar";
import type { DropZone } from "./paneLayout";
import { springLoader, wsTabAt, type TabDropTarget } from "./WorkspaceBar";

/** past this the press is a drag, not a click */
const DRAG_START = 5;
/** how far into a pane its edge zones reach, as a share of its width or height */
const EDGE = 0.3;
/** the overlay sits this far inside the pane */
const INSET = 4;
/** how close to the outer edge of all the panes the pointer docks along that whole side */
const OUTER_BAND = 28;
/** the share of the panes' area the outer zone shows */
const OUTER_SHARE = 0.3;

/** A drop target: a pane, or "outer" (the outer edge of all the panes; the zone is the side). */
export type DropTarget = PaneId | "outer";

type Box = { left: number; top: number; width: number; height: number };
type Hover = { kind: "pane"; target: DropTarget; zone: DropZone; ok: boolean; why?: string; box: Box } | { kind: "ws"; id: string; ok: boolean | null };

type Drag = {
  id: PaneId;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  /**
   * The outer edges are offered only once the pointer has been away from them: a pane lifted by
   * its header starts inside the top band, and mustn't offer "full width at the top" at once
   */
  outerArmed: boolean;
  /** what the ghost shows, read when the drag began (the slot may show another pane after a workspace switch) */
  ghost: { provider?: string; name: string };
  hover: Hover | null;
  spring: ReturnType<typeof springLoader>;
  off: () => void;
};

/** What dropping pane `id` on pane `target`'s `zone` would do: "ok", why it can't (drawn refused), or null (nothing: not offered). */
export type DropCheck = "ok" | { why: string } | null;

export type PaneDragOptions = {
  /** panes can be dragged now */
  enabled: boolean;
  /** the workspace on screen (its own tab is no drop target) */
  activeWs: string;
  /** what the ghost shows */
  ghost: (id: PaneId) => { provider?: string; name: string };
  /** whether the middle of a pane is a zone (swapping); not for a pane brought from another workspace */
  centre: (id: PaneId) => boolean;
  check: (id: PaneId, target: DropTarget, zone: DropZone) => DropCheck;
  onDrop: (id: PaneId, target: DropTarget, zone: DropZone) => void;
  /** whether letting go on that workspace's tab moves the pane there (null: that tab only opens) */
  canToWorkspace: (id: PaneId, ws: string) => boolean | null;
  /** let go on a tab that can take it (`canToWorkspace` true or false: the shell says why not) */
  onToWorkspace: (id: PaneId, ws: string) => void;
  /** resting on a tab: show that workspace (the drag goes on) */
  onSpring: (id: PaneId, ws: string) => void;
  /** a drag began (past the threshold) and ended, dropped or not */
  onStart?: (id: PaneId) => void;
  onEnd?: () => void;
};

const zoneBox = (r: DOMRect, z: DropZone): Box => {
  const w = z === "left" || z === "right" ? r.width / 2 : r.width;
  const h = z === "top" || z === "bottom" ? r.height / 2 : r.height;
  const left = z === "right" ? r.left + r.width / 2 : r.left;
  const top = z === "bottom" ? r.top + r.height / 2 : r.top;
  return { left: left + INSET, top: top + INSET, width: w - 2 * INSET, height: h - 2 * INSET };
};

/** The zone of pane box `r` under the point: the nearest edge within its band, else the middle (or, without one, the nearest edge). */
const zoneAt = (r: DOMRect, x: number, y: number, centre: boolean): DropZone => {
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  const near: [DropZone, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  near.sort((a, b) => a[1] - b[1]);
  return near[0][1] < EDGE || !centre ? near[0][0] : "center";
};

/** The outer edge of all the panes under the point, within its band: the side and the zone drawn. */
const outerAt = (x: number, y: number): { side: Exclude<DropZone, "center">; box: Box } | null => {
  const r = document.querySelector(".splits")?.getBoundingClientRect();
  if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  const near: [Exclude<DropZone, "center">, number][] = [
    ["left", x - r.left],
    ["right", r.right - x],
    ["top", y - r.top],
    ["bottom", r.bottom - y],
  ];
  near.sort((a, b) => a[1] - b[1]);
  const [side, dist] = near[0];
  if (dist > OUTER_BAND) return null;
  const w = side === "left" || side === "right" ? r.width * OUTER_SHARE : r.width;
  const h = side === "top" || side === "bottom" ? r.height * OUTER_SHARE : r.height;
  const left = side === "right" ? r.right - w : r.left;
  const top = side === "bottom" ? r.bottom - h : r.top;
  return { side, box: { left: left + INSET, top: top + INSET, width: w - 2 * INSET, height: h - 2 * INSET } };
};

const sameHover = (a: Hover | null, b: Hover | null) => {
  if (!a || !b) return a === b;
  if (a.kind === "ws" || b.kind === "ws") return a.kind === "ws" && b.kind === "ws" && a.id === b.id && a.ok === b.ok;
  return a.target === b.target && a.zone === b.zone && a.ok === b.ok && a.box.left === b.box.left && a.box.top === b.box.top;
};

export function usePaneDrag(o: PaneDragOptions) {
  const opts = useRef(o);
  opts.current = o;
  const drag = useRef<Drag | null>(null);
  const ghostEl = useRef<HTMLDivElement>(null);
  /** the pane lifted, where it would land, and the tab springing */
  const [live, setLive] = useState<{ id: PaneId; hover: Hover | null; spring: string | null } | null>(null);
  /** after a drop, the overlay fades out where the pane landed */
  const [leaving, setLeaving] = useState<Box | null>(null);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), 200);
    return () => window.clearTimeout(t);
  }, [leaving]);
  // gone mid-drag (the shell unmounting): nothing left behind on the body
  useEffect(() => () => end(false), []);

  /** What dropping at (x, y) would do. */
  const hoverAt = (d: Drag, x: number, y: number): Hover | null => {
    const tab = wsTabAt(x, y);
    if (tab) return tab === opts.current.activeWs ? null : { kind: "ws", id: tab, ok: opts.current.canToWorkspace(d.id, tab) };
    // panes only when the layout shows them all (not one at a time in a window too small for them)
    if (document.querySelector(".split-cramped")) return null;
    const outer = outerAt(x, y);
    if (!outer) d.outerArmed = true;
    else if (d.outerArmed) {
      const c = opts.current.check(d.id, "outer", outer.side);
      if (c) return { kind: "pane", target: "outer", zone: outer.side, ok: c === "ok", why: c === "ok" ? undefined : c.why, box: outer.box };
    }
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".browser-pane[data-pane]");
    const target = el?.dataset.pane as PaneId | undefined;
    if (!el || !target) return null;
    const r = el.getBoundingClientRect();
    const zone = zoneAt(r, x, y, opts.current.centre(d.id));
    const c = opts.current.check(d.id, target, zone);
    return c ? { kind: "pane", target, zone, ok: c === "ok", why: c === "ok" ? undefined : c.why, box: zoneBox(r, zone) } : null;
  };

  /** Ends the drag: `drop` does what the pointer is over, otherwise it's cancelled. */
  function end(drop: boolean) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.off();
    d.spring.cancel();
    try {
      if (document.body.hasPointerCapture(d.pointerId)) document.body.releasePointerCapture(d.pointerId);
    } catch {
      /* already let go */
    }
    document.body.classList.remove("pane-dragging", "pane-drag-refused");
    if (!d.started) return;
    setLive(null);
    const h = d.hover;
    if (drop && h?.kind === "pane" && h.ok) {
      setLeaving(h.box);
      opts.current.onDrop(d.id, h.target, h.zone);
    } else if (drop && h?.kind === "ws" && h.ok !== null) opts.current.onToWorkspace(d.id, h.id);
    opts.current.onEnd?.();
  }

  const moveTo = (d: Drag, x: number, y: number) => {
    const g = ghostEl.current;
    if (g) {
      // beside the pointer, on its other side near the window's right or bottom edge
      const gx = x + 14 + g.offsetWidth > window.innerWidth - 4 ? x - 10 - g.offsetWidth : x + 14;
      const gy = y + 14 + g.offsetHeight > window.innerHeight - 4 ? y - 10 - g.offsetHeight : y + 14;
      g.style.transform = `translate(${gx}px, ${gy}px)`;
    }
    const h = hoverAt(d, x, y);
    d.spring.over(h?.kind === "ws" ? h.id : null);
    document.body.classList.toggle("pane-drag-refused", !!h && h.ok === false);
    if (sameHover(h, d.hover)) return;
    d.hover = h;
    setLive({ id: d.id, hover: h, spring: d.spring.pending });
  };

  /** pointerdown on the empty part of pane `id`'s header */
  const grip = (id: PaneId) => (e: React.PointerEvent<HTMLElement>) => {
    if (!opts.current.enabled || e.button !== 0 || drag.current) return;
    const pointerId = e.pointerId;
    let last = { x: e.clientX, y: e.clientY };
    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      // the button came up where we didn't hear it: the drag is over, and nothing is dropped
      if ((ev.buttons & 1) === 0) return end(false);
      last = { x: ev.clientX, y: ev.clientY };
      if (!d.started) {
        if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < DRAG_START) return;
        d.started = true;
        try {
          document.body.setPointerCapture(pointerId);
        } catch {
          /* not capturable (the press ended meanwhile): window events still arrive */
        }
        document.body.classList.add("pane-dragging");
        window.getSelection()?.removeAllRanges();
        opts.current.onStart?.(d.id);
        setLive({ id: d.id, hover: null, spring: null });
        // the ghost mounts with this render: place it once it's there
        requestAnimationFrame(() => drag.current === d && moveTo(d, last.x, last.y));
      }
      moveTo(d, ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && end(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && end(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !drag.current?.started) return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    const onBlur = () => end(false);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    document.body.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    const d: Drag = {
      id,
      pointerId,
      outerArmed: false,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      ghost: opts.current.ghost(id),
      hover: null,
      spring: springLoader((ws) => {
        if (drag.current !== d) return;
        opts.current.onSpring(d.id, ws);
        // the layout under the pointer changed: what it is over now
        d.hover = null;
        setLive({ id: d.id, hover: null, spring: null });
        requestAnimationFrame(() => drag.current === d && moveTo(d, last.x, last.y));
      }),
      off: () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        document.body.removeEventListener("lostpointercapture", onCancel);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onBlur);
      },
    };
    drag.current = d;
  };

  const h = live?.hover ?? null;
  const g = live ? drag.current?.ghost : null;
  const box = h?.kind === "pane" ? h.box : live ? null : leaving;
  const view: ReactNode = (
    <>
      {box && (
        <div
          key={h?.kind === "pane" ? "zone" : "leaving"}
          className={`pane-drop-zone ${h?.kind === "pane" ? (h.ok ? "" : "refused") : "leaving"}`}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          aria-hidden
        >
          {h?.kind === "pane" && (!h.ok ? <span className="pane-drop-label">{h.why}</span> : h.zone === "center" ? <span className="pane-drop-label">Swap</span> : null)}
        </div>
      )}
      {live && g && (
        <div className="drag-ghost pane-ghost" ref={ghostEl} aria-hidden>
          <ProviderBadge provider={g.provider} />
          <span className="pane-ghost-name">{g.name}</span>
        </div>
      )}
    </>
  );

  return {
    /** the header's pointerdown for pane `id`, or nothing while panes can't be dragged */
    grip: o.enabled ? grip : null,
    /** the pane being dragged (its slot: after a workspace switch that slot may hold another pane) */
    dragging: live?.id ?? null,
    /** the workspace tab under a dragged pane (WorkspaceBar `drop`) */
    tabDrop: h?.kind === "ws" ? ({ id: h.id, ok: h.ok, spring: live?.spring === h.id } satisfies TabDropTarget) : null,
    view,
  };
}
