import { useState, useRef, useCallback, useEffect, type MouseEvent } from "react";

/**
 * The folded sidebar's overlay: resting on a rail icon brings the whole sidebar in over the
 * panes (nothing moves); it goes once the pointer has left it and no menu from it is up.
 */
export function useSidePeek(folded: boolean, menuUp: () => boolean) {
  const [open, setOpenState] = useState(false);
  // brought up by ⌥⌘F or the rail's "All connections": the filter field takes the keyboard
  const [byFind, setByFind] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const setOpen = useCallback((on: boolean, find = false) => {
    setOpenState(on);
    setByFind(on && find);
  }, []);
  useEffect(() => {
    if (!folded) setOpen(false);
    return () => window.clearTimeout(timer.current);
  }, [folded, setOpen]);
  // put away while the pointer rests on the rail (its "All connections", say): it doesn't come
  // straight back until the pointer has moved off that icon
  const resting = useRef(false);
  const hover = useCallback((on: boolean) => {
    window.clearTimeout(timer.current);
    if (!on) resting.current = false;
    else if (!resting.current) timer.current = window.setTimeout(() => setOpenState(true), 280);
  }, []);
  // it stays while the pointer is on it, a menu from it is up, or something in it has the
  // keyboard (typing in its filter field with the pointer elsewhere)
  const check = useCallback(() => {
    const keep = menuUp() || ref.current?.matches(":hover") || ref.current?.contains(document.activeElement);
    if (keep) timer.current = window.setTimeout(check, 300);
    else setOpen(false);
  }, [menuUp, setOpen]);
  const leave = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(check, 220);
  }, [check]);
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(true, true);
    timer.current = window.setTimeout(check, 600);
  }, [check, setOpen]);
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    resting.current = !!ref.current?.matches(":hover");
    setOpen(false);
  }, [setOpen]);
  const clicked = useCallback(
    (e: MouseEvent) => {
      const t = e.target as Element;
      if (t.closest(".side-item.sub, .fav-row, .side-item.conn.single, .side-toggle, .recent-row, .find-row")) close();
    },
    [close],
  );
  return { open, byFind, ref, hover, leave, clicked, show, close };
}
