/**
 * The folder's files as a list or a grid, rendering only what is near the screen (a folder of
 * 50,000 photos costs the same few dozen rows as one of 50). Long-press selects; keep the finger
 * down and drag to select everything between, with the list scrolling at the edges.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Entry } from "../../core/types";
import { EntryRow, EntryTile, type PressPoint, type RowHandlers } from "./rows";

const OVERSCAN_PX = 700;

type View = { top: number; height: number; offset: number; cols: number; rowH: number };

/** Which rows of `count` items are near the screen, measured from the list itself. */
function useWindow(wrap: React.RefObject<HTMLDivElement | null>, count: number, grid: boolean) {
  const [v, setV] = useState<View>({ top: 0, height: 900, offset: 0, cols: grid ? 3 : 1, rowH: grid ? 150 : 62 });

  const measure = useRef<() => void>(() => {});
  measure.current = () => {
    const w = wrap.current;
    const sc = w?.closest<HTMLElement>(".m-scroll");
    if (!w || !sc) return;
    const body = w.querySelector<HTMLElement>(grid ? ".m-grid" : ".m-list");
    const first = body?.querySelector<HTMLElement>(grid ? ".m-cell" : ".m-row");
    let cols = 1;
    let rowH = v.rowH;
    if (body && grid) {
      const cs = getComputedStyle(body);
      cols = Math.max(1, cs.gridTemplateColumns.split(" ").filter(Boolean).length);
      if (first) rowH = first.offsetHeight + (parseFloat(cs.rowGap) || 0);
    } else if (first) rowH = first.offsetHeight;
    const offset = w.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const next = { top: sc.scrollTop, height: sc.clientHeight, offset, cols, rowH: Math.max(20, rowH) };
    setV((p) =>
      p.top === next.top && p.height === next.height && Math.abs(p.offset - next.offset) < 1 && p.cols === next.cols && Math.abs(p.rowH - next.rowH) < 0.5 ? p : next,
    );
  };

  useLayoutEffect(() => {
    const w = wrap.current;
    const sc = w?.closest<HTMLElement>(".m-scroll");
    if (!w || !sc) return;
    let frame = 0;
    const later = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure.current();
        });
    };
    measure.current();
    sc.addEventListener("scroll", later, { passive: true });
    const ro = new ResizeObserver(later);
    ro.observe(sc);
    ro.observe(w);
    return () => {
      sc.removeEventListener("scroll", later);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [wrap, grid]);

  // row size and columns follow text size and rotation: re-read after rendering
  useLayoutEffect(() => measure.current());

  const rows = Math.ceil(count / v.cols);
  const first = Math.max(0, Math.floor((v.top - v.offset - OVERSCAN_PX) / v.rowH));
  const last = Math.min(rows, Math.ceil((v.top - v.offset + v.height + OVERSCAN_PX) / v.rowH));
  const end = Math.max(first, last);
  return { start: first * v.cols, end: Math.min(count, end * v.cols), padTop: first * v.rowH, padBottom: Math.max(0, (rows - end) * v.rowH) };
}

export function FileList({
  entries,
  grid,
  profileId,
  bucket,
  showPath,
  selected,
  selecting,
  activeKey,
  thumbs,
  h,
  onDragRange,
}: {
  entries: Entry[];
  grid: boolean;
  profileId: string;
  bucket: string;
  showPath: boolean;
  selected: Set<string> | null;
  selecting: boolean;
  activeKey: string | null;
  thumbs: string;
  h: RowHandlers;
  /** while dragging after a long-press: the item index under the finger */
  onDragRange: (anchor: number, to: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const win = useWindow(wrap, entries.length, grid);
  // the first screenful rises in; rows that scroll in later just appear
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setFresh(false), 700);
    return () => window.clearTimeout(t);
  }, []);

  // ------------------------------------------------------------ drag to select
  const drag = useRef<{ anchor: number; last: number; y: number; x: number } | null>(null);
  const onDragRef = useRef(onDragRange);
  onDragRef.current = onDragRange;
  const handlers = useRef<RowHandlers>(h);
  handlers.current = h;
  /** set up by the effect below: listens to the finger while a drag-select lasts */
  const startDrag = useRef<() => void>(() => {});
  const [stable] = useState<RowHandlers>(() => ({
    tap: (e: Entry, i: number) => handlers.current.tap(e, i),
    more: (e: Entry) => handlers.current.more(e),
    longPress: (e: Entry, i: number, p: PressPoint) => {
      handlers.current.longPress(e, i, p);
      drag.current = { anchor: i, last: i, x: p.x, y: p.y };
      startDrag.current();
    },
  }));

  useEffect(() => {
    const w = wrap.current;
    const sc = w?.closest<HTMLElement>(".m-scroll");
    if (!w || !sc) return;
    let frame = 0;
    const pick = () => {
      const d = drag.current;
      if (!d) return;
      const el = document.elementFromPoint(d.x, d.y)?.closest<HTMLElement>("[data-idx]");
      const i = el ? Number(el.dataset.idx) : NaN;
      if (Number.isFinite(i) && i !== d.last) {
        d.last = i;
        onDragRef.current(d.anchor, i);
      }
    };
    // near the top or bottom edge the list scrolls by itself, faster the closer the finger is
    const tick = () => {
      frame = 0;
      const d = drag.current;
      if (!d) return;
      const r = sc.getBoundingClientRect();
      const edge = 70;
      const up = d.y - r.top < edge ? -(edge - (d.y - r.top)) : 0;
      const down = r.bottom - d.y < edge ? edge - (r.bottom - d.y) : 0;
      const speed = (up || down) / 4;
      if (speed) {
        sc.scrollTop += speed;
        pick();
        frame = requestAnimationFrame(tick);
      }
    };
    const move = (x: number, y: number) => {
      const d = drag.current;
      if (!d) return;
      d.x = x;
      d.y = y;
      pick();
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const tm = (e: TouchEvent) => {
      if (!drag.current) return;
      if (e.cancelable) e.preventDefault();
      move(e.touches[0].clientX, e.touches[0].clientY);
    };
    const pm = (e: PointerEvent) => {
      if (drag.current && e.pointerType === "mouse" && e.buttons & 1) move(e.clientX, e.clientY);
    };
    // Listeners only while a drag lasts: a move listener that may stop scrolling makes every
    // scroll of the list wait for it. Since a web view may already have decided that this touch
    // scrolls, the list also stops scrolling by itself while dragging (it scrolls at the edges
    // from code instead).
    let on = false;
    const end = () => {
      drag.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!on) return;
      on = false;
      sc.classList.remove("m-drag-lock");
      w.removeEventListener("touchmove", tm);
      window.removeEventListener("pointermove", pm);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      window.removeEventListener("pointerup", end);
    };
    startDrag.current = () => {
      if (on) return;
      on = true;
      sc.classList.add("m-drag-lock");
      w.addEventListener("touchmove", tm, { passive: false });
      window.addEventListener("pointermove", pm);
      window.addEventListener("touchend", end);
      window.addEventListener("touchcancel", end);
      window.addEventListener("pointerup", end);
    };
    return () => {
      end();
      startDrag.current = () => {};
    };
  }, []);

  const slice = entries.slice(win.start, win.end);
  const rows = slice.map((e, j) => {
    const i = win.start + j;
    const props = {
      entry: e,
      index: i,
      profileId,
      bucket,
      showPath,
      selected: !!selected?.has(e.key),
      selecting,
      active: activeKey === e.key,
      thumbs,
      h: stable,
    };
    return grid ? <EntryTile key={e.key} {...props} /> : <EntryRow key={e.key} {...props} />;
  });

  return (
    <div ref={wrap} className={`m-files ${fresh ? "fresh" : ""}`}>
      <div style={{ height: win.padTop }} aria-hidden="true" />
      {grid ? <div className="m-grid">{rows}</div> : <ul className="m-list">{rows}</ul>}
      <div style={{ height: win.padBottom }} aria-hidden="true" />
    </div>
  );
}
