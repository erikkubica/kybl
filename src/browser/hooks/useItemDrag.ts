/**
 * Pointer-driven drag of files/folders onto folders (rows, tiles, breadcrumb segments). Plain
 * mouse events rather than HTML5 drag-and-drop: the native webview drop handler (used for
 * Finder uploads) swallows HTML5 drags on some platforms, and this gives full control over the
 * ghost and hit-testing. Drop targets are any element with a `data-drop="<prefix>"` attribute, and
 * sidebar buckets marked `data-drop-bucket="<bucket>" data-drop-profile="<connection id>"` (the
 * items land at that bucket's top level, also in another connection). A drop moves; hold ⌥ to copy (at the press or any time
 * during the drag). Places that only take copies (`copyOnly`) always copy.
 *
 * Several panes: every pane's root carries `data-pane="<id>"` and `data-drop-pane`. A drop on a folder,
 * breadcrumb or empty space of ANOTHER pane goes to that pane's place (`paneTarget` decides and
 * names it), and moves like any other drop (⌥ copies).
 *
 * One drag for the whole window (the shell owns it, shell/useFileDrag.tsx), so it outlives the
 * pane it started in: over a workspace's tab (`tabs`), letting go drops into that workspace, and
 * resting there opens it with the drag still going. `home` says which pane still shows the place
 * the items came from (none once another workspace is on screen): its own folders are plain moves.
 *
 * Out of the window: when the pointer leaves it with the button down, `dragOut` hands the items to
 * the system's drag (desktop/dragOut.ts), so they drop into Finder, a mail or a chat as files.
 * Back inside before that happened, the drag carries on here as before.
 *
 * The press is the page's own (its default is prevented): otherwise WebKit treats it as the start of
 * a text selection and scrolls the list whenever the pointer is beyond it, which with the pointer
 * outside the window meant the pane kept scrolling. Lists scroll while the pointer is near their
 * top or bottom edge instead (inside the window only).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isValidDest } from "../../transfers/lib/moving";
import type { DragOut } from "../../desktop/lib/dragOut";
import type { Entry } from "../../core/types";
import { springLoader, type TabDropTarget } from "../../shell/components/WorkspaceBar";

export type DragState = {
  items: Entry[];
  x: number;
  y: number;
  /** destination prefix under the pointer, if it accepts the items */
  dest: string | null;
  /** destination bucket when it is another bucket of the connection (a sidebar bucket) */
  bucket: string | null;
  /** destination connection when the sidebar bucket belongs to another connection */
  profile?: string | null;
  /** the other pane the items would land in, and how to name that place */
  pane: string | null;
  label: string | null;
  copy: boolean;
  /** the place only takes copies (this computer and the cloud): it never moves */
  copyOnly?: boolean;
  /** the pointer is outside the window (the items are about to go to another app) */
  outside?: boolean;
  /** a workspace's tab under the pointer (WorkspaceBar `drop`) */
  tab?: TabDropTarget | null;
  /** what the ghost says where nothing takes the items (a tab that only opens, or refuses) */
  note?: string | null;
  /** what dropping there does, in the target's own words (a terminal pastes the paths) */
  say?: string | null;
};

/**
 * A workspace's tab under the pointer: letting go there drops into it (`label` names where), it
 * can't take the items (`why`), or (`open`) resting on it is all it does.
 */
export type TabTarget = { label: string; copyOnly?: boolean } | { why: string } | { open: string };

const THRESHOLD = 5;
/** resting on a folder this long opens it */
const SPRING_MS = 900;
/** Fetching for a drag out starts this close to the window's edge. */
const NEAR_EDGE = 48;
/** Lists scroll while the pointer is this close to their top or bottom. */
const SCROLL_EDGE = 28;

/** The list under the pointer that can scroll up or down (the grid itself, the table's body). */
function scrollerAt(x: number, y: number): HTMLElement | null {
  for (let el = document.elementFromPoint(x, y) as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

export function useItemDrag<P extends string = string>({
  home,
  onDrop,
  onSpring,
  bucketTarget,
  paneTarget,
  tabs,
  dragOut,
}: {
  /** the pane that still shows the items' place (their own folders there are plain moves); null when none does */
  home: () => P | null;
  onDrop: (items: Entry[], dest: string, copy: boolean, destBucket: string | null, pane: P | null, destProfile: string | null) => void;
  /** hovering a folder for a moment opens it (Finder's spring-loaded folders), in pane `pane` (null: home) */
  onSpring: (dest: string, pane: P | null) => void;
  /**
   * Whether a sidebar bucket accepts the items: null = no, "same" = the bucket they are in (a
   * move to its top level), "other" = another bucket of the same connection, or for a bucket of
   * another connection how to name it and whether it only takes copies (this computer and a cloud).
   */
  bucketTarget?: (profileId: string, bucket: string) => "same" | "other" | { label: string; copyOnly?: boolean } | null;
  /**
   * Whether another pane accepts the items at `dest` (a folder there; null = the folder it
   * shows), and the label of that place; null = no.
   */
  paneTarget?: (pane: P, dest: string | null, items: Entry[]) => { dest: string; label: string; copyOnly?: boolean; say?: string } | null;
  /** workspace tabs: which is under the point (not the one on screen), what it does with the items, resting on it, letting go there */
  tabs?: {
    at: (x: number, y: number) => string | null;
    target: (id: string, items: Entry[]) => TabTarget;
    onSpring: (id: string) => void;
    onDrop: (id: string, items: Entry[], copy: boolean) => void;
  };
  /** hands the drag to the system when the pointer leaves the window (desktop) */
  dragOut?: DragOut;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const cbs = useRef({ home, onDrop, onSpring, bucketTarget, paneTarget, tabs, dragOut });
  cbs.current = { home, onDrop, onSpring, bucketTarget, paneTarget, tabs, dragOut };
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const begin = useCallback((ev: React.MouseEvent, items: Entry[], onClick?: () => void) => {
    if (ev.button !== 0 || items.length === 0) return;
    cleanup.current?.();
    ev.preventDefault();
    // what the prevented press would have done: focus the list (keys work on it), or drop the focus
    const focusable = (ev.target as Element).closest<HTMLElement>("[tabindex], button, a[href], input, textarea, select");
    if (focusable) {
      if (document.activeElement !== focusable) focusable.focus({ preventScroll: true });
    } else (document.activeElement as HTMLElement | null)?.blur?.();
    const sx = ev.clientX;
    const sy = ev.clientY;
    let active = false;
    let lit: HTMLElement | null = null;
    let dest: string | null = null;
    let destBucket: string | null = null;
    let destProfile: string | null = null;
    let destPane: P | null = null;
    let label: string | null = null;
    let copyOnly = false;
    let say: string | null = null;
    // a modifier held before the press counts too
    let alt = ev.altKey;
    let springTimer = 0;
    let springFor: string | null = null;
    /** the workspace tab under the pointer and what it does */
    let tab: { id: string; t: TabTarget } | null = null;
    /** the tab that just opened ("+" is still there under the pointer): it doesn't open again until left */
    let sprung: string | null = null;
    const tabSpring = springLoader((id) => {
      if (ended) return;
      tab = null;
      sprung = id;
      cbs.current.tabs?.onSpring(id);
      // another layout is under the pointer now: what it is over there
      requestAnimationFrame(() => {
        if (ended || outside) return;
        over(x, y);
        show();
      });
    });
    const isCopy = () => copyOnly || alt;
    let x = sx;
    let y = sy;
    let outside = false;
    let warmed = false;
    /** the hand-over to the system: idle, under way, or it said no (not tried again until back inside) */
    let handing: "no" | "trying" | "refused" = "no";
    let scrollFrame = 0;
    let ended = false;

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
      destProfile = null;
      destPane = null;
      label = null;
      copyOnly = false;
      say = null;
      const pane = (el?.closest("[data-pane]")?.getAttribute("data-pane") ?? null) as P | null;
      let ok = false;
      if (el && pane && pane !== cbs.current.home()) {
        // a place in the other pane
        const t = d != null || el.hasAttribute("data-drop-pane") ? cbs.current.paneTarget?.(pane, d, items) : null;
        if (t) {
          d = t.dest;
          destPane = pane;
          label = t.label;
          copyOnly = !!t.copyOnly;
          say = t.say ?? null;
          ok = true;
        }
      } else if (el && (d != null || !el.hasAttribute("data-drop-pane"))) {
        if (d == null) {
          const kind = cbs.current.bucketTarget?.(el.getAttribute("data-drop-profile") ?? "", el.getAttribute("data-drop-bucket") ?? "") ?? null;
          if (kind) d = "";
          if (kind === "other") destBucket = el.getAttribute("data-drop-bucket");
          else if (kind && typeof kind === "object") {
            // a bucket of another connection
            destBucket = el.getAttribute("data-drop-bucket");
            destProfile = el.getAttribute("data-drop-profile");
            label = kind.label;
            copyOnly = !!kind.copyOnly;
          }
        }
        ok = d != null && (destBucket != null || isValidDest(items, d));
      }
      light(ok ? el : null);
      dest = ok ? d : null;
      if (!ok) {
        destBucket = null;
        destProfile = null;
        destPane = null;
        label = null;
        copyOnly = false;
      }
      // spring-load folder rows/tiles, in any pane (not breadcrumbs: those are one click away anyway)
      const springPane = destPane;
      const springable = ok && el!.hasAttribute("data-spring") ? d : null;
      const springKey = springable == null ? null : `${springPane ?? ""}:${springable}`;
      if (springKey !== springFor) {
        window.clearTimeout(springTimer);
        springFor = springKey;
        if (springable != null)
          springTimer = window.setTimeout(() => {
            light(null);
            dest = null;
            destBucket = null;
            destProfile = null;
            destPane = null;
            setDrag((st) => (st ? { ...st, dest: null, bucket: null, pane: null, label: null } : st));
            cbs.current.onSpring(springable, springPane);
          }, SPRING_MS);
      }
    };

    /** What is under the point: a workspace's tab, else a place in the window (`hit`). */
    const over = (x: number, y: number) => {
      let id = cbs.current.tabs?.at(x, y) ?? null;
      if (id !== sprung) sprung = null;
      else id = null;
      tabSpring.over(id);
      if (!id) {
        tab = null;
        return hit(x, y);
      }
      unlight();
      tab = { id, t: cbs.current.tabs!.target(id, items) };
      if ("label" in tab.t) {
        label = tab.t.label;
        copyOnly = !!tab.t.copyOnly;
      }
    };
    const tabState = (): Pick<DragState, "tab" | "note"> => {
      if (!tab) return { tab: null, note: null };
      const ok = "label" in tab.t ? true : "why" in tab.t ? false : null;
      return { tab: { id: tab.id, ok, spring: tabSpring.pending === tab.id }, note: "why" in tab.t ? tab.t.why : "open" in tab.t ? tab.t.open : null };
    };

    const show = () =>
      setDrag({ items, x, y, dest: tab && "label" in tab.t ? "" : dest, bucket: destBucket, profile: destProfile, pane: destPane, label, copy: isCopy(), copyOnly, outside, say: dest != null ? say : null, ...tabState() });

    const unlight = () => {
      light(null);
      dest = null;
      destBucket = null;
      destProfile = null;
      destPane = null;
      label = null;
      copyOnly = false;
      window.clearTimeout(springTimer);
      springFor = null;
    };

    // the list under the pointer scrolls while it is near its top or bottom
    const scrollTick = () => {
      scrollFrame = 0;
      if (outside || ended) return;
      if (tab) return;
      const list = scrollerAt(x, y);
      if (!list) return;
      const r = list.getBoundingClientRect();
      let dy = 0;
      if (y < r.top + SCROLL_EDGE) dy = -Math.min(24, (r.top + SCROLL_EDGE - y) / 2);
      else if (y > r.bottom - SCROLL_EDGE) dy = Math.min(24, (y - (r.bottom - SCROLL_EDGE)) / 2);
      const before = list.scrollTop;
      if (dy) list.scrollTop += dy;
      if (list.scrollTop === before) return;
      hit(x, y);
      show();
      scrollFrame = requestAnimationFrame(scrollTick);
    };

    /** The pointer left the window: hand the items to the system's drag, if it takes them. */
    const handOver = () => {
      const out = cbs.current.dragOut;
      if (!out || handing !== "no") return;
      handing = "trying";
      void out.start(items, () => outside && !ended).then(
        (took) => {
          if (ended) return;
          if (took) end();
          // back inside before it was ready: try again when it leaves again
          else handing = outside ? "refused" : "no";
        },
        () => {
          handing = "refused";
        },
      );
    };

    const move = (e: MouseEvent) => {
      if (!active) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < THRESHOLD) return;
        active = true;
        document.body.classList.add("dragging-items");
      }
      alt = e.altKey;
      x = e.clientX;
      y = e.clientY;
      const w = window.innerWidth;
      const h = window.innerHeight;
      outside = x < 0 || y < 0 || x >= w || y >= h;
      if (!warmed && cbs.current.dragOut && Math.min(x, y, w - x, h - y) < NEAR_EDGE) {
        warmed = true;
        cbs.current.dragOut.warm(items);
      }
      if (outside) {
        // nothing in the window is under the pointer, and nothing there scrolls
        unlight();
        tab = null;
        tabSpring.over(null);
        handOver();
      } else {
        if (handing === "refused") handing = "no";
        over(x, y);
        if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollTick);
      }
      show();
    };
    const up = (e: MouseEvent) => {
      const wasActive = active;
      const d = dest;
      const b = destBucket;
      const p = destPane;
      const prof = destProfile;
      const t = tab;
      alt = e.altKey;
      const c = isCopy();
      end();
      if (!wasActive) onClick?.();
      else if (t) {
        if ("label" in t.t) cbs.current.tabs?.onDrop(t.id, items, c);
      } else if (d != null) cbs.current.onDrop(items, d, c, b, p, prof);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && active) {
        e.preventDefault();
        e.stopPropagation();
        end();
      } else if (e.key === "Alt" && active) {
        alt = e.type === "keydown";
        const copy = isCopy();
        setDrag((s) => (s ? { ...s, copy } : s));
      }
    };
    const end = () => {
      ended = true;
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      window.clearTimeout(springTimer);
      tabSpring.cancel();
      tab = null;
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
