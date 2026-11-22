/**
 * A pane's selection: the selected keys, the Shift anchor and the keyboard cursor. The cursor
 * is a ref for handlers, mirrored in state so the list highlights the same item the arrow keys
 * move from.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { firstStep, type SelectKeys } from "../components/listNav";
import type { Entry } from "../types";

export function useSelection(entries: Entry[], stale: boolean) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const cursor = useRef<string | null>(null);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const staleRef = useRef(stale);
  staleRef.current = stale;

  const setCursor = useCallback((key: string | null, alsoAnchor = false) => {
    cursor.current = key;
    if (alsoAnchor) anchor.current = key;
    setCursorKey(key);
  }, []);

  /** A click: plain selects one, ⌘ toggles, Shift selects the range from the anchor. */
  const select = useCallback(
    (e: Entry, mods: { meta: boolean; shift: boolean }) => {
      const idx = entries.findIndex((x) => x.key === e.key);
      // an anchor the filter hides can't start a range: the click starts a new one
      const a = mods.shift && anchor.current ? entries.findIndex((x) => x.key === anchor.current) : -1;
      if (a >= 0) {
        const [lo, hi] = a < idx ? [a, idx] : [idx, a];
        setSelected(new Set(entries.slice(lo, hi + 1).map((x) => x.key)));
      } else if (mods.meta) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(e.key)) next.delete(e.key);
          else next.add(e.key);
          return next;
        });
        anchor.current = e.key;
      } else {
        setSelected(new Set([e.key]));
        anchor.current = e.key;
      }
      setCursor(e.key);
    },
    [entries, setCursor],
  );

  /** Rubber-band and type-to-select: the list hands over the whole new selection. */
  const selectKeys: SelectKeys = useCallback(
    (keys, cur) => {
      if (staleRef.current) return;
      setSelected(new Set(keys));
      setCursor(cur, true);
    },
    [setCursor],
  );

  const selectOnly = useCallback(
    (key: string) => {
      setSelected(new Set([key]));
      setCursor(key, true);
    },
    [setCursor],
  );

  const moveSelection = useCallback(
    (delta: number, shift: boolean) => {
      if (entries.length === 0) return;
      const cur = cursor.current ? entries.findIndex((x) => x.key === cursor.current) : -1;
      const next = cur < 0 ? firstStep(delta, entries.length) : Math.max(0, Math.min(entries.length - 1, cur + delta));
      const key = entries[next].key;
      setCursor(key);
      const a = shift && anchor.current ? entries.findIndex((x) => x.key === anchor.current) : -1;
      if (a >= 0) {
        const [lo, hi] = a < next ? [a, next] : [next, a];
        setSelected(new Set(entries.slice(lo, hi + 1).map((x) => x.key)));
      } else {
        anchor.current = key;
        setSelected(new Set([key]));
      }
    },
    [entries, setCursor],
  );

  const clear = useCallback(() => setSelected(new Set()), []);
  const deselect = useCallback(
    (keys: string[]) =>
      setSelected((sel) => {
        const next = new Set(sel);
        keys.forEach((k) => next.delete(k));
        return next;
      }),
    [],
  );

  // what the list no longer shows (filtered out, deleted, moved) leaves the selection, so the count
  // and the actions always agree with what is on screen
  useEffect(() => {
    if (stale) return;
    setSelected((cur) => {
      if (!cur.size) return cur;
      const shown = new Set(entries.map((e) => e.key));
      const next = new Set([...cur].filter((k) => shown.has(k)));
      return next.size === cur.size ? cur : next;
    });
  }, [entries, stale]);

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.key)), [entries, selected]);
  // refs so the memoised grid cards don't re-render on every selection change
  const selRef = useRef({ selected, selectedEntries: [] as Entry[] });
  useEffect(() => {
    selRef.current = { selected, selectedEntries };
  });

  return { selected, setSelected, selectedEntries, selRef, anchor, cursor, cursorKey, setCursor, select, selectKeys, selectOnly, moveSelection, clear, deselect };
}

export type Selection = ReturnType<typeof useSelection>;
