import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMeasured, useWindowed } from "../useWindowed";
import { Icon } from "../Icons";
import { formatBytes, formatDate, formatDateFull, kindLabel } from "../format";
import { EmptyState, FileIcon, SkeletonRows } from "./FileIcon";
import type { Entry } from "../types";

export type SortKey = "name" | "size" | "modified" | "kind";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

/** Widths of the resizable columns; Name takes whatever is left. */
type ColKey = "size" | "mod" | "kind";
const COLS: { key: ColKey; sort: SortKey; label: string; def: number; min: number; max: number }[] = [
  { key: "size", sort: "size", label: "Size", def: 84, min: 56, max: 180 },
  { key: "mod", sort: "modified", label: "Modified", def: 140, min: 90, max: 280 },
  { key: "kind", sort: "kind", label: "Kind", def: 108, min: 64, max: 280 },
];
const NAME_MIN = 190;
const GAP = 14;
const PAD = 36;
const COLS_KEY = "s3b.columns";

function loadCols(): Record<ColKey, number> {
  const widths = { size: 84, mod: 140, kind: 108 };
  try {
    const saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? "{}");
    for (const c of COLS) if (typeof saved?.[c.key] === "number") widths[c.key] = Math.min(c.max, Math.max(c.min, saved[c.key]));
  } catch {
    /* defaults */
  }
  return widths;
}

export function FileTable({
  entries,
  selected,
  sort,
  loading,
  hasMore,
  searchMode,
  prefix,
  emptyAction,
  onSort,
  onPress,
  onOpen,
  onContext,
  onLoadMore,
  onClearSelection,
  onMove,
}: {
  entries: Entry[];
  selected: Set<string>;
  sort: Sort;
  loading: boolean;
  hasMore: boolean;
  searchMode: boolean;
  prefix: string;
  emptyAction?: ReactNode;
  onSort: (k: SortKey) => void;
  onPress: (e: Entry, ev: React.MouseEvent) => void;
  onOpen: (e: Entry) => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
  onLoadMore: () => void;
  onClearSelection: () => void;
  onMove: (delta: number, shift: boolean) => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const rowH = useMeasured(body, ".row", 32);
  // the body's top padding sits above the first row
  const win = useWindowed({ scroller: body, count: entries.length, rowHeight: rowH, offset: 4 });
  const [widths, setWidths] = useState(loadCols);
  const [avail, setAvail] = useState(10_000);
  const [resizing, setResizing] = useState<ColKey | null>(null);

  useEffect(() => {
    const el = table.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The name keeps at least NAME_MIN; when the pane gets too narrow, columns drop from the right.
  const shown = [...COLS];
  const need = () => NAME_MIN + PAD + shown.reduce((n, c) => n + widths[c.key] + GAP, 0);
  while (shown.length > 1 && need() > avail) shown.pop();
  const template = `minmax(0, 1fr) ${shown.map((c) => `${widths[c.key]}px`).join(" ")}`;

  const saveWidths = (w: Record<ColKey, number>) => {
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(w));
    } catch {
      /* ignore */
    }
  };

  /** Drag the edge in front of a column: moving left makes it wider. Double-click resets it. */
  const startResize = (ev: React.PointerEvent, col: (typeof COLS)[number]) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = widths[col.key];
    const others = shown.filter((c) => c.key !== col.key).reduce((n, c) => n + widths[c.key] + GAP, 0);
    const room = avail - PAD - NAME_MIN - others - GAP; // widest this column can get right now
    const ceiling = Math.max(col.min, Math.min(col.max, room));
    let latest = widths;
    setResizing(col.key);
    const move = (e: PointerEvent) => {
      const w = Math.min(ceiling, Math.max(col.min, Math.round(startW + startX - e.clientX)));
      latest = { ...latest, [col.key]: w };
      setWidths(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(null);
      saveWidths(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resetCol = (col: (typeof COLS)[number]) => {
    const w = { ...widths, [col.key]: col.def };
    setWidths(w);
    saveWidths(w);
  };

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (items) => {
        if (items.some((i) => i.isIntersecting)) onLoadMore();
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, entries.length]);

  // keep the keyboard-selected row visible (it may not be rendered yet)
  const { reveal } = win;
  useEffect(() => {
    const [first] = selected;
    if (first === undefined) return;
    reveal(entries.findIndex((e) => e.key === first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, reveal]);

  const head = (key: SortKey, label: string, cls: string, col?: (typeof COLS)[number]) => (
    <button
      key={cls}
      className={`th ${cls} ${sort.key === key ? "sorted" : ""}`}
      onClick={() => onSort(key)}
      aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      {col && (
        <span
          className={`col-grip ${resizing === col.key ? "on" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize the ${label} column`}
          title="Drag to resize · double-click to reset"
          onPointerDown={(ev) => startResize(ev, col)}
          onClick={(ev) => ev.stopPropagation()}
          onDoubleClick={(ev) => {
            ev.stopPropagation();
            resetCol(col);
          }}
        />
      )}
      {label}
      {sort.key === key && (
        <span className={`sort-arrow ${sort.dir}`}>
          <Icon name="chevron-down" size={12} />
        </span>
      )}
    </button>
  );

  return (
    <div
      className={`table ${resizing ? "resizing" : ""}`}
      ref={table}
      style={{ "--cols": template } as React.CSSProperties}
      tabIndex={0}
      onKeyDown={(ev) => {
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          onMove(1, ev.shiftKey);
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          onMove(-1, ev.shiftKey);
        }
      }}
      onMouseDown={(ev) => {
        if ((ev.target as HTMLElement).classList.contains("table-body")) onClearSelection();
      }}
    >
      <div className="thead">
        {head("name", "Name", "c-name")}
        {shown.map((c) => head(c.sort, c.label, `c-${c.key}`, c))}
      </div>
      <div className="table-body" ref={body}>
        {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
        {entries.slice(win.start, win.end).map((e) => {
          const sel = selected.has(e.key);
          const rel = e.key.slice(prefix.length);
          const slash = searchMode ? rel.lastIndexOf("/") : -1;
          return (
            <div
              key={e.key}
              data-key={e.key}
              data-drop={e.kind === "folder" ? e.key : undefined}
              data-spring={e.kind === "folder" ? "" : undefined}
              className={`row ${sel ? "selected" : ""} ${e.kind === "folder" ? "is-folder" : ""}`}
              onMouseDown={(ev) => onPress(e, ev)}
              onDoubleClick={() => onOpen(e)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                onContext(ev, e);
              }}
            >
              <div className="c-name">
                <FileIcon entry={e} />
                <span className="name-text" title={e.key}>
                  {slash >= 0 && <span className="dim">{rel.slice(0, slash + 1)}</span>}
                  {slash >= 0 ? rel.slice(slash + 1) : e.name}
                </span>
              </div>
              {shown.some((c) => c.key === "size") && <div className={`c-size ${e.kind === "folder" ? "faint" : ""}`}>{e.kind === "folder" ? "—" : formatBytes(e.size)}</div>}
              {shown.some((c) => c.key === "mod") && (
                <div className={`c-mod ${e.modified ? "" : "faint"}`} title={e.modified ? formatDateFull(e.modified) : undefined}>
                  {formatDate(e.modified)}
                </div>
              )}
              {shown.some((c) => c.key === "kind") && <div className="c-kind">{kindLabel(e.name, e.kind === "folder")}</div>}
            </div>
          );
        })}
        {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
        {entries.length === 0 && !loading && <EmptyState searchMode={searchMode} action={emptyAction} />}
        {loading && entries.length === 0 && <SkeletonRows columns={shown.length} />}
        {loading && entries.length > 0 && (
          <div className="loading-row">
            <span className="spinner" /> Loading more…
          </div>
        )}
        {hasMore && <div ref={sentinel} className="sentinel" />}
      </div>
    </div>
  );
}
