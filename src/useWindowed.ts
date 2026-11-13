/**
 * Renders only the rows near the viewport of a scrolling list or grid, so a folder with 100,000
 * objects costs the same few dozen DOM nodes as one with 50. Rows have a fixed height (measured
 * from the first rendered row), and a grid row holds `columns` items.
 */
import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

const OVERSCAN_PX = 600;

export type Windowed = {
  /** first and one-past-last item index to render */
  start: number;
  end: number;
  /** space standing in for the rows above and below the rendered ones */
  padTop: number;
  padBottom: number;
  /** scrolls the item at `index` into view if it is not */
  reveal: (index: number) => void;
};

export function useWindowed({
  scroller,
  count,
  columns = 1,
  rowHeight,
  offset = 0,
}: {
  scroller: RefObject<HTMLElement | null>;
  count: number;
  /** items per row (1 for a list) */
  columns?: number;
  /** height of one row including any gap below it */
  rowHeight: number;
  /** distance from the top of the scroll content to the first row */
  offset?: number;
}): Windowed {
  const [view, setView] = useState({ top: 0, height: 800 });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller]);

  const cols = Math.max(1, columns);
  const h = Math.max(1, rowHeight);
  const rows = Math.ceil(count / cols);
  const firstRow = Math.max(0, Math.floor((view.top - offset - OVERSCAN_PX) / h));
  const lastRow = Math.min(rows, Math.ceil((view.top - offset + view.height + OVERSCAN_PX) / h));
  // keep the first rendered row even so alternating styles and :has() neighbours stay stable
  const startRow = firstRow - (firstRow % 2);
  const endRow = Math.max(startRow, lastRow);

  const reveal = useCallback(
    (index: number) => {
      const el = scroller.current;
      if (!el || index < 0) return;
      const top = offset + Math.floor(index / cols) * h;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight;
    },
    [scroller, offset, cols, h],
  );

  return {
    start: startRow * cols,
    end: Math.min(count, endRow * cols),
    padTop: startRow * h,
    padBottom: Math.max(0, (rows - endRow) * h),
    reveal,
  };
}

/**
 * Height of the first element matching `selector` inside `root`. Re-read after every render (one
 * layout read), so it follows density and tile-size changes without extra wiring.
 */
export function useMeasured(root: RefObject<HTMLElement | null>, selector: string, fallback: number): number {
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(selector);
    const h = el?.getBoundingClientRect().height ?? 0;
    if (h > 0 && Math.abs(h - size) >= 0.5) setSize(h);
  });
  return size;
}
