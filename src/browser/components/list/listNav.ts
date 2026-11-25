/**
 * Keyboard and pointer behaviour shared by the list (FileTable) and the grid (GridView):
 * which item has the keyboard cursor, Home/End/PageUp/PageDown, type-to-select, the
 * context-menu key, and rubber-band (marquee) selection on empty space.
 *
 * The app owns the selection. These helpers only ask for changes through the list's callbacks
 * (`onMove`, and `onSelectKeys` when the app provides it), so the app's own cursor and Shift
 * anchor stay the source of truth.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isMenuKey, menuPointFor } from "../../../ui/components/Dialogs";
import { rowStepBlocked } from "./gridHit";
import { isContextPress, onScrollbar } from "../../../ui/lib/pointer";
import type { Entry } from "../../../core/types";

/** Folder size as the app reports it (see useFolderSizes). */
export type FolderSizeInfo = { bytes: number; objects: number; running: boolean };

/** Replace the selection with `keys` and put the keyboard cursor (and Shift anchor) on `cursor`. */
export type SelectKeys = (keys: string[], cursor: string | null) => void;

const TYPE_AHEAD_MS = 800;

/**
 * Where a move lands when nothing has the cursor yet: an arrow or page key goes to the first item
 * (or the last, going back), as in Finder; Home and End (a step as long as the list) to that end.
 */
export function firstStep(delta: number, count: number): number {
  const toEnd = Math.abs(delta) >= count;
  return (delta > 0) !== toEnd ? 0 : count - 1;
}

/** A stand-in for a mouse event, for menus opened from the keyboard. */
export function syntheticMouse(el: Element | null): React.MouseEvent {
  const { x, y } = menuPointFor(el);
  return {
    clientX: x,
    clientY: y,
    button: 2,
    buttons: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: el,
    currentTarget: el,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as React.MouseEvent;
}

/** Gives the file list keyboard focus (for after a sidebar click or a navigation). */
export function focusList() {
  document.querySelector<HTMLElement>("[data-list-focus]")?.focus({ preventScroll: true });
}

/** Focus somewhere the list must not take it from: a field, a dialog or a menu. */
function focusIsBusy(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return false;
  if (a.closest(".modal, .ctx-menu, .settings-view")) return true;
  return a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable;
}

export function useListNav({
  entries,
  selected,
  activeKey,
  columns,
  pageItems,
  container,
  itemEl,
  autoFocus,
  focusKey,
  onMove,
  onSelectKeys,
  onContext,
  onBackgroundContextMenu,
}: {
  entries: Entry[];
  selected: Set<string>;
  /** the app's keyboard cursor, when it shares it; otherwise followed from the selection */
  activeKey?: string | null;
  columns: () => number;
  /** items that fit on one screen, for PageUp/PageDown */
  pageItems: () => number;
  container: RefObject<HTMLElement | null>;
  itemEl: (index: number) => Element | null;
  autoFocus?: boolean;
  /** changes when the list shows another place: autoFocus takes focus again */
  focusKey: string;
  onMove: (delta: number, shift: boolean) => void;
  onSelectKeys?: SelectKeys;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
  onBackgroundContextMenu?: (ev: React.MouseEvent) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const [kbd, setKbd] = useState(false);
  const typed = useRef({ text: "", at: 0 });
  const active = activeKey !== undefined ? activeKey : own;

  // Follow the selection: one selected item is the cursor; with several, keep the cursor if it
  // is still among them, else take the end of the range nearest to where it was.
  useEffect(() => {
    if (activeKey !== undefined) return;
    if (selected.size === 1) {
      const [k] = selected;
      setOwn(k);
    } else if (selected.size > 1) {
      setOwn((cur) => {
        if (cur && selected.has(cur)) return cur;
        const idx = [...selected].map((k) => entries.findIndex((e) => e.key === k)).filter((i) => i >= 0);
        if (idx.length === 0) return cur;
        const at = cur ? entries.findIndex((e) => e.key === cur) : -1;
        const lo = idx.reduce((a, b) => (b < a ? b : a));
        const hi = idx.reduce((a, b) => (b > a ? b : a));
        return entries[at >= 0 && Math.abs(at - lo) < Math.abs(at - hi) ? lo : hi].key;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, activeKey]);

  const activeIndex = active ? entries.findIndex((e) => e.key === active) : -1;

  // take focus when the list appears or moves to another place, unless the user is busy elsewhere
  useEffect(() => {
    if (!autoFocus || focusIsBusy()) return;
    container.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, focusKey]);

  /** Mirrors the app's cursor arithmetic so the highlight follows before the app re-renders. */
  const step = (delta: number, shift: boolean) => {
    if (entries.length === 0) return;
    const cur = activeIndex;
    const next = cur < 0 ? firstStep(delta, entries.length) : Math.max(0, Math.min(entries.length - 1, cur + delta));
    if (activeKey === undefined) setOwn(entries[next].key);
    onMove(delta, shift);
  };

  /** Selects exactly one item by index. */
  const goTo = (index: number) => {
    const e = entries[index];
    if (!e) return;
    if (activeKey === undefined) setOwn(e.key);
    if (onSelectKeys) onSelectKeys([e.key], e.key);
    else {
      // jump to the top, then down to the item: both land in one render
      onMove(-entries.length, false);
      onMove(index, false);
    }
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.target !== ev.currentTarget) return;
    const cols = Math.max(1, columns());
    const page = Math.max(cols, pageItems());
    const mod = ev.metaKey || ev.ctrlKey;
    let delta: number | null = null;
    switch (ev.key) {
      case "ArrowDown":
        if (!mod) delta = cols;
        break;
      case "ArrowUp":
        if (!mod) delta = -cols;
        break;
      case "ArrowRight":
        if (cols > 1 && !mod) delta = 1;
        break;
      case "ArrowLeft":
        if (cols > 1 && !mod) delta = -1;
        break;
      case "Home":
        delta = -entries.length;
        break;
      case "End":
        delta = entries.length;
        break;
      case "PageDown":
        delta = page;
        break;
      case "PageUp":
        delta = -page;
        break;
    }
    if (delta !== null) {
      ev.preventDefault();
      setKbd(true);
      // a grid's first row has nothing above it, its last nothing below
      if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && rowStepBlocked(activeIndex, delta, cols, entries.length)) return;
      step(delta, ev.shiftKey);
      return;
    }
    if (isMenuKey(ev)) {
      ev.preventDefault();
      const e = activeIndex >= 0 && selected.has(entries[activeIndex].key) ? entries[activeIndex] : entries.find((x) => selected.has(x.key));
      const i = e ? entries.indexOf(e) : -1;
      if (e) onContext(syntheticMouse(itemEl(i) ?? container.current), e);
      else onBackgroundContextMenu?.(syntheticMouse(container.current));
      return;
    }
    // type-to-select: letters jump to the next name starting with what was typed
    const printable = ev.key.length === 1 && !mod && !ev.altKey;
    if (!printable || entries.length === 0) return;
    const now = Date.now();
    const fresh = now - typed.current.at > TYPE_AHEAD_MS;
    if (ev.key === " " && fresh) return; // a lone Space belongs to the app (quick look)
    ev.preventDefault();
    const text = (fresh ? "" : typed.current.text) + ev.key.toLowerCase();
    typed.current = { text, at: now };
    // typing the same letter again cycles through the names that start with it
    const same = text.length > 1 && [...text].every((c) => c === text[0]);
    const q = same ? text[0] : text;
    const from = activeIndex < 0 ? 0 : q.length === 1 && (same || fresh) ? activeIndex + 1 : activeIndex;
    for (let n = 0; n < entries.length; n++) {
      const i = (from + n) % entries.length;
      if (entries[i].name.toLowerCase().startsWith(q)) {
        setKbd(true);
        goTo(i);
        return;
      }
    }
  };

  /** Right-click on empty space: the app's background menu, never the web view's own. */
  const onContextMenu = (ev: React.MouseEvent, itemSelector: string) => {
    if ((ev.target as HTMLElement).closest(itemSelector)) return;
    if ((ev.target as HTMLElement).closest("input, textarea, .text-preview")) return;
    ev.preventDefault();
    onBackgroundContextMenu?.(ev);
  };

  /** Call when an item is pressed with the mouse, so the cursor follows the pointer. */
  const notePress = useCallback(
    (e: Entry) => {
      setKbd(false);
      if (activeKey === undefined) setOwn(e.key);
    },
    [activeKey],
  );

  return { active, activeIndex, kbd, setKbd, onKeyDown, onContextMenu, notePress, goTo };
}

/** Marquee rectangle in the scroller's content coordinates. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Rubber-band selection: dragging on empty space selects every item the rectangle touches.
 * Shift adds to the selection, ⌘ toggles. The list scrolls by itself near its top and bottom
 * edges, and only geometry is used (no DOM reads per item), so virtualised rows work too.
 */
export function useMarquee({
  scroller,
  entries,
  selected,
  hitTest,
  onSelectKeys,
  onMove,
  onClearSelection,
}: {
  scroller: RefObject<HTMLElement | null>;
  entries: Entry[];
  selected: Set<string>;
  /** indices of the items the rectangle touches */
  hitTest: (b: Box) => number[];
  onSelectKeys?: SelectKeys;
  onMove: (delta: number, shift: boolean) => void;
  onClearSelection: () => void;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const live = useRef(false);
  const latest = useRef({ entries, selected, hitTest, onSelectKeys, onMove, onClearSelection });
  latest.current = { entries, selected, hitTest, onSelectKeys, onMove, onClearSelection };
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  /**
   * Starts a rubber band at this press. With `onClick` (a press on a row), nothing changes until the
   * pointer moves; released in place it is a plain click and `onClick` runs instead.
   */
  const begin = (ev: React.MouseEvent, onClick?: () => void) => {
    const el = scroller.current;
    if (!el || ev.button !== 0 || isContextPress(ev)) return;
    // a press on the scrollbar scrolls; it neither clears the selection nor starts a band
    if (onScrollbar(ev.clientX, ev.clientY, el.getBoundingClientRect(), el)) return;
    const additive = ev.shiftKey ? "add" : ev.metaKey || ev.ctrlKey ? "toggle" : null;
    const base = additive ? new Set(latest.current.selected) : new Set<string>();
    if (!additive && !onClick) latest.current.onClearSelection();
    const at = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return { x: cx - r.left + el.scrollLeft, y: cy - r.top + el.scrollTop };
    };
    const start = at(ev.clientX, ev.clientY);
    let pointer = { x: ev.clientX, y: ev.clientY };
    let started = false;
    let last = "";
    let frame = 0;

    const apply = () => {
      const p = at(pointer.x, pointer.y);
      const b: Box = {
        x0: Math.min(start.x, p.x),
        y0: Math.min(start.y, p.y),
        x1: Math.max(start.x, p.x),
        y1: Math.max(start.y, p.y),
      };
      setBox(b);
      const { entries: list, hitTest: hit, onSelectKeys: sel, onMove: move } = latest.current;
      const idx = hit(b).filter((i) => i >= 0 && i < list.length);
      const keys = new Set(idx.map((i) => list[i].key));
      let result: Set<string>;
      if (additive === "add") result = new Set([...base, ...keys]);
      else if (additive === "toggle") {
        result = new Set(base);
        for (const k of keys) {
          if (result.has(k)) result.delete(k);
          else result.add(k);
        }
      } else result = keys;
      const sig = [...result].join("\n");
      if (sig === last) return;
      last = sig;
      const cursor = idx.length ? list[idx[idx.length - 1]].key : null;
      if (sel) sel([...result], cursor);
      else if (idx.length) {
        // without onSelectKeys the app can only select a range: from the first touched item to the last
        const lo = idx.reduce((a, b) => (b < a ? b : a));
        const hi = idx.reduce((a, b) => (b > a ? b : a));
        move(-list.length, false);
        move(lo, false);
        if (hi > lo) move(hi - lo, true);
      } else latest.current.onClearSelection();
    };

    // scroll while the pointer is above or below the list
    const tick = () => {
      frame = 0;
      if (!started) return;
      const r = el.getBoundingClientRect();
      const edge = 24;
      let dy = 0;
      if (pointer.y < r.top + edge) dy = -Math.min(40, (r.top + edge - pointer.y) / 2);
      else if (pointer.y > r.bottom - edge) dy = Math.min(40, (pointer.y - (r.bottom - edge)) / 2);
      if (dy) {
        el.scrollTop += dy;
        apply();
        frame = requestAnimationFrame(tick);
      }
    };

    const move = (e: MouseEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!started) {
        if (Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < 4) return;
        if (onClick && !additive) latest.current.onClearSelection();
        started = true;
        live.current = true;
        document.body.classList.add("marquee-selecting");
      }
      apply();
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const end = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      if (!started && onClick && stop.current === end) onClick();
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove("marquee-selecting");
      live.current = false;
      stop.current = null;
      setBox(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    stop.current = end;
  };

  return { box, begin, selecting: live };
}
