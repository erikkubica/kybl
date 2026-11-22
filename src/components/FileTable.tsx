import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMeasured, useWindowed } from "../useWindowed";
import { Icon } from "../Icons";
import { formatBytes, formatDate, formatDateFull, entrySize, entryKind } from "../format";
import { EmptyState, FileIcon, SkeletonRows } from "./FileIcon";
import { ContextMenu, isMenuKey, menuPointFor, type MenuItem } from "./Dialogs";
import { useListNav, useMarquee, type Box, type FolderSizeInfo, type SelectKeys } from "./listNav";
import { storageClassLabel } from "./storageClasses";
import { DEFAULTS, type ColumnId } from "../settings";
import type { Entry } from "../types";

export type SortKey = "name" | "size" | "modified" | "kind";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

/**
 * Optional columns. Name always comes first and takes whatever room is left; the others have a
 * width the user can drag (kept in localStorage) and can be switched on and off from a
 * right-click on the header (kept in settings).
 */
type Col = { id: ColumnId; cls: string; sort?: SortKey; label: string; def: number; min: number; max: number };
const COLS: Col[] = [
  { id: "size", cls: "c-size", sort: "size", label: "Size", def: 84, min: 56, max: 180 },
  { id: "modified", cls: "c-mod", sort: "modified", label: "Modified", def: 140, min: 90, max: 280 },
  { id: "kind", cls: "c-kind", sort: "kind", label: "Kind", def: 108, min: 64, max: 280 },
  { id: "storageClass", cls: "c-sc", label: "Storage class", def: 118, min: 70, max: 240 },
  { id: "etag", cls: "c-etag", label: "ETag", def: 150, min: 80, max: 320 },
];
const NAME_MIN = 190;
const GAP = 14;
const PAD = 36;
const WIDTHS_KEY = "s3b.columns";
/** columns chosen in this window when the app doesn't keep them in settings */
const LOCAL_COLS_KEY = "s3b.columnsShown";

type Widths = Record<ColumnId, number>;

function loadWidths(): Widths {
  const w = Object.fromEntries(COLS.map((c) => [c.id, c.def])) as Widths;
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}");
    // "mod" is what older versions saved for the Modified column
    if (typeof saved?.mod === "number" && typeof saved?.modified !== "number") saved.modified = saved.mod;
    for (const c of COLS) if (typeof saved?.[c.id] === "number") w[c.id] = Math.min(c.max, Math.max(c.min, saved[c.id]));
  } catch {
    /* defaults */
  }
  return w;
}

function saveWidths(w: Widths) {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(w));
  } catch {
    /* ignore */
  }
}

function loadLocalCols(): ColumnId[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_COLS_KEY) ?? "null");
    if (Array.isArray(v)) return v.filter((id) => COLS.some((c) => c.id === id));
  } catch {
    /* defaults */
  }
  return DEFAULTS.columns;
}

/** Size cell of a folder: its size once worked out, progress while it runs, else a Calculate link. */
function FolderSizeCell({ info, onCalc }: { info: FolderSizeInfo | undefined; onCalc?: () => void }) {
  if (info?.running)
    return (
      <span className="fsize running" title={`${info.objects.toLocaleString()} objects so far`}>
        <span className="spinner sm" />
        {info.bytes > 0 ? formatBytes(info.bytes) : ""}
      </span>
    );
  if (info) return <span title={`${info.objects.toLocaleString()} ${info.objects === 1 ? "object" : "objects"}`}>{formatBytes(info.bytes)}</span>;
  if (!onCalc) return <span className="faint">—</span>;
  return (
    <>
      <span className="faint fsize-dash">—</span>
      <button
        type="button"
        className="fsize-calc"
        tabIndex={-1}
        title="Add up the size of everything in this folder"
        onMouseDown={(ev) => ev.stopPropagation()}
        onDoubleClick={(ev) => ev.stopPropagation()}
        onClick={(ev) => {
          ev.stopPropagation();
          onCalc();
        }}
      >
        Calculate
      </button>
    </>
  );
}

export function FileTable({
  entries,
  selected,
  sort,
  loading = false,
  stale = false,
  hasMore,
  searchMode,
  prefix,
  emptyAction,
  columns,
  activeKey,
  autoFocus,
  folderSize,
  onCalcSize,
  onColumnsChange,
  onSort,
  onPress,
  onOpen,
  onContext,
  onBackgroundContextMenu,
  onLoadMore,
  onClearSelection,
  onMove,
  onSelectKeys,
  onUpload,
  onNewFolder,
}: {
  entries: Entry[];
  selected: Set<string>;
  sort: Sort;
  /** a listing is on its way: skeleton rows when there is nothing to show yet */
  loading?: boolean;
  /** the rows belong to the previous place while the new one loads: dimmed and inert */
  stale?: boolean;
  hasMore: boolean;
  searchMode: boolean;
  prefix: string;
  emptyAction?: ReactNode;
  /** optional columns in order (settings.columns); without it the choice is kept per window */
  columns?: ColumnId[];
  /** the app's keyboard cursor, if it shares it */
  activeKey?: string | null;
  /** take keyboard focus when shown and whenever `prefix` changes */
  autoFocus?: boolean;
  folderSize?(key: string): FolderSizeInfo | undefined;
  onCalcSize?(key: string): void;
  onColumnsChange?(columns: ColumnId[]): void;
  onSort: (k: SortKey) => void;
  onPress: (e: Entry, ev: React.MouseEvent) => void;
  onOpen: (e: Entry) => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
  /** right-click (or the menu key with nothing selected) on empty space */
  onBackgroundContextMenu?(ev: React.MouseEvent): void;
  onLoadMore: () => void;
  onClearSelection: () => void;
  onMove: (delta: number, shift: boolean) => void;
  /** replace the selection (rubber-band, type-to-select); see listNav */
  onSelectKeys?: SelectKeys;
  /** empty folder: "Upload files" and "New folder" buttons */
  onUpload?(): void;
  onNewFolder?(): void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowH = useMeasured(body, ".row", 32);
  // the body's top padding sits above the first row
  const win = useWindowed({ scroller: body, count: entries.length, rowHeight: rowH, offset: 4 });
  const [widths, setWidths] = useState(loadWidths);
  const [avail, setAvail] = useState(10_000);
  const [resizing, setResizing] = useState<ColumnId | null>(null);
  const [localCols, setLocalCols] = useState(loadLocalCols);
  const [headMenu, setHeadMenu] = useState<{ x: number; y: number } | null>(null);
  const chosen = columns ?? localCols;

  useEffect(() => {
    const el = table.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The name keeps at least NAME_MIN; when the pane gets too narrow, columns drop from the right.
  const shown = chosen.map((id) => COLS.find((c) => c.id === id)).filter((c): c is Col => !!c);
  const need = () => NAME_MIN + PAD + shown.reduce((n, c) => n + widths[c.id] + GAP, 0);
  while (shown.length > 0 && need() > avail) shown.pop();
  const template = `minmax(0, 1fr)${shown.map((c) => ` ${widths[c.id]}px`).join("")}`;

  const setChosen = (next: ColumnId[]) => {
    if (onColumnsChange) onColumnsChange(next);
    else {
      setLocalCols(next);
      try {
        localStorage.setItem(LOCAL_COLS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    }
  };
  const toggleCol = (id: ColumnId) => {
    if (chosen.includes(id)) setChosen(chosen.filter((c) => c !== id));
    // a column switched back on returns to its usual place
    else setChosen(COLS.map((c) => c.id).filter((c) => c === id || chosen.includes(c)));
  };

  /** Drag the edge in front of a column: moving left makes it wider. Double-click resets it. */
  const startResize = (ev: React.PointerEvent, col: Col) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = widths[col.id];
    const others = shown.filter((c) => c.id !== col.id).reduce((n, c) => n + widths[c.id] + GAP, 0);
    const room = avail - PAD - NAME_MIN - others - GAP; // widest this column can get right now
    const ceiling = Math.max(col.min, Math.min(col.max, room));
    let latest = widths;
    setResizing(col.id);
    const move = (e: PointerEvent) => {
      const w = Math.min(ceiling, Math.max(col.min, Math.round(startW + startX - e.clientX)));
      latest = { ...latest, [col.id]: w };
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
  const resetCol = (col: Col) => {
    const w = { ...widths, [col.id]: col.def };
    setWidths(w);
    saveWidths(w);
  };
  /** Arrow keys on a focused column edge resize it too. */
  const keyResize = (ev: React.KeyboardEvent, col: Col) => {
    const d = ev.key === "ArrowLeft" ? 10 : ev.key === "ArrowRight" ? -10 : 0;
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation();
    const w = { ...widths, [col.id]: Math.min(col.max, Math.max(col.min, widths[col.id] + d)) };
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

  const rowEl = useCallback((i: number) => body.current?.querySelector(`[data-index="${i}"]`) ?? null, []);
  const nav = useListNav({
    entries,
    selected,
    activeKey,
    columns: () => 1,
    pageItems: () => Math.max(1, Math.floor((body.current?.clientHeight ?? 320) / rowH) - 1),
    container: table,
    itemEl: rowEl,
    autoFocus,
    focusKey: `${prefix}|${searchMode}`,
    onMove,
    onSelectKeys,
    onContext,
    onBackgroundContextMenu,
  });

  const hitTest = useCallback(
    (b: Box) => {
      const first = Math.max(0, Math.floor((b.y0 - 4) / rowH));
      const last = Math.min(entries.length - 1, Math.floor((b.y1 - 4) / rowH));
      const out: number[] = [];
      for (let i = first; i <= last; i++) out.push(i);
      return out;
    },
    [rowH, entries.length],
  );
  const marquee = useMarquee({ scroller: body, entries, selected, hitTest, onSelectKeys, onMove, onClearSelection });

  // keep the keyboard cursor visible (it may not be rendered yet); not while rubber-banding
  const { reveal } = win;
  useEffect(() => {
    if (marquee.selecting.current || nav.activeIndex < 0) return;
    reveal(nav.activeIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.active, selected, reveal]);

  const press = (e: Entry, ev: React.MouseEvent) => {
    nav.notePress(e);
    // like Finder: a press beside the name of an unselected row starts a rubber band (released in
    // place it just selects the row); on the name or icon, or on a selected row, it drags
    const t = ev.target as HTMLElement;
    const plain = ev.button === 0 && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey;
    if (plain && onSelectKeys && !selected.has(e.key) && !t.closest(".name-text, .file-icon, svg, button, a")) {
      nav.setKbd(false);
      marquee.begin(ev, () => onSelectKeys([e.key], e.key));
      return;
    }
    onPress(e, ev);
  };

  const head = (label: string, cls: string, key?: SortKey, col?: Col) => (
    <div
      key={cls}
      className={`th ${cls} ${key && sort.key === key ? "sorted" : ""}`}
      role="columnheader"
      aria-sort={key && sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      {col && (
        <span
          className={`col-grip ${resizing === col.id ? "on" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize the ${label} column`}
          aria-valuenow={widths[col.id]}
          aria-valuemin={col.min}
          aria-valuemax={col.max}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={(ev) => startResize(ev, col)}
          onKeyDown={(ev) => keyResize(ev, col)}
          onClick={(ev) => ev.stopPropagation()}
          onDoubleClick={(ev) => {
            ev.stopPropagation();
            resetCol(col);
          }}
        />
      )}
      {key ? (
        <button
          type="button"
          className="th-btn"
          // a click sorts without taking focus from the list, so the arrow keys keep working
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => onSort(key)} title={`Sort by ${label.toLowerCase()}`}>
          {label}
          {sort.key === key && (
            <span className={`sort-arrow ${sort.dir}`}>
              <Icon name="chevron-down" size={12} />
            </span>
          )}
        </button>
      ) : (
        <span className="th-btn static">{label}</span>
      )}
    </div>
  );

  const menuItems: MenuItem[] = [
    { type: "label", label: "Columns" },
    { type: "item", label: "Name", checked: true, disabled: true, onClick: () => {} },
    ...COLS.map((c): MenuItem => ({ type: "item", label: c.label, checked: chosen.includes(c.id), onClick: () => toggleCol(c.id) })),
    { type: "sep" },
    {
      type: "item",
      label: "Reset columns",
      onClick: () => {
        setChosen(DEFAULTS.columns);
        const w = loadWidths();
        for (const c of COLS) w[c.id] = c.def;
        setWidths(w);
        saveWidths(w);
      },
    },
  ];

  const activeId = nav.activeIndex >= 0 ? `${listId}-r${nav.activeIndex}` : undefined;
  const empty = entries.length === 0;

  return (
    <div
      className={`table ${resizing ? "resizing" : ""} ${stale ? "stale" : ""} ${nav.kbd ? "kbd" : ""}`}
      ref={table}
      style={{ "--cols": template } as React.CSSProperties}
      tabIndex={0}
      data-list-focus=""
      role="grid"
      aria-label={searchMode ? "Search results" : "Files"}
      aria-multiselectable="true"
      aria-rowcount={hasMore ? -1 : entries.length + 1}
      aria-colcount={shown.length + 1}
      aria-activedescendant={activeId}
      aria-busy={loading || stale || undefined}
      onKeyDown={nav.onKeyDown}
      onContextMenu={(ev) => nav.onContextMenu(ev, ".row, .thead")}
      onMouseDown={(ev) => {
        const t = ev.target as HTMLElement;
        if (t.closest(".row, .thead, button, a, .empty")) return;
        if (!t.closest(".table-body")) return;
        nav.setKbd(false);
        marquee.begin(ev);
      }}
    >
      <div
        className="thead"
        role="row"
        aria-rowindex={1}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setHeadMenu({ x: ev.clientX, y: ev.clientY });
        }}
        onKeyDown={(ev) => {
          if (!isMenuKey(ev)) return;
          ev.preventDefault();
          setHeadMenu(menuPointFor(ev.target as Element));
        }}
        title="Right-click to choose columns"
      >
        {head("Name", "c-name", "name")}
        {shown.map((c) => head(c.label, c.cls, c.sort, c))}
      </div>
      <div className="table-body" ref={body} role="rowgroup">
        {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
        {entries.slice(win.start, win.end).map((e, n) => {
          const i = win.start + n;
          const sel = selected.has(e.key);
          const rel = e.key.slice(prefix.length).replace(/\/$/, "");
          const slash = searchMode ? rel.lastIndexOf("/") : -1;
          const folder = e.kind === "folder";
          return (
            <div
              key={e.key}
              id={`${listId}-r${i}`}
              data-key={e.key}
              data-index={i}
              data-drop={folder ? e.key : undefined}
              data-spring={folder ? "" : undefined}
              className={`row ${sel ? "selected" : ""} ${folder ? "is-folder" : ""} ${i === nav.activeIndex ? "active" : ""}`}
              role="row"
              aria-rowindex={i + 2}
              aria-selected={sel}
              onMouseDown={(ev) => press(e, ev)}
              onDoubleClick={() => onOpen(e)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                onContext(ev, e);
              }}
            >
              <div className="c-name" role="gridcell">
                <FileIcon entry={e} />
                <span className="name-text" title={e.key}>
                  {slash >= 0 && <span className="dim">{rel.slice(0, slash + 1)}</span>}
                  {slash >= 0 ? rel.slice(slash + 1) : e.name}
                </span>
              </div>
              {shown.map((c) => {
                switch (c.id) {
                  case "size":
                    return (
                      <div key={c.id} className="c-size" role="gridcell">
                        {folder ? <FolderSizeCell info={folderSize?.(e.key)} onCalc={onCalcSize && (() => onCalcSize(e.key))} /> : entrySize(e)}
                      </div>
                    );
                  case "modified":
                    return (
                      <div key={c.id} className={`c-mod ${e.modified ? "" : "faint"}`} role="gridcell" title={e.modified ? formatDateFull(e.modified) : undefined}>
                        {formatDate(e.modified)}
                      </div>
                    );
                  case "kind":
                    return (
                      <div key={c.id} className="c-kind" role="gridcell">
                        {entryKind(e)}
                      </div>
                    );
                  case "storageClass":
                    return (
                      <div key={c.id} className={`c-sc ${e.storageClass ? "" : "faint"}`} role="gridcell" title={e.storageClass ?? undefined}>
                        {folder ? "" : storageClassLabel(e.storageClass) || "—"}
                      </div>
                    );
                  case "etag": {
                    const tag = e.etag?.replace(/"/g, "") ?? "";
                    return (
                      <div key={c.id} className={`c-etag mono ${tag ? "" : "faint"}`} role="gridcell" title={tag || undefined}>
                        {folder ? "" : tag || "—"}
                      </div>
                    );
                  }
                }
                return null;
              })}
            </div>
          );
        })}
        {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
        {empty && !loading && <EmptyState searchMode={searchMode} action={emptyAction} onUpload={onUpload} onNewFolder={onNewFolder} />}
        {loading && empty && <SkeletonRows columns={shown.length} />}
        {loading && !empty && !stale && (
          <div className="loading-row" role="status">
            <span className="spinner" /> Loading more…
          </div>
        )}
        {hasMore && <div ref={sentinel} className="sentinel" />}
        {marquee.box && (
          <div
            className="marquee"
            aria-hidden="true"
            style={{ left: marquee.box.x0, top: marquee.box.y0, width: marquee.box.x1 - marquee.box.x0, height: marquee.box.y1 - marquee.box.y0 }}
          />
        )}
      </div>
      {headMenu && <ContextMenu x={headMenu.x} y={headMenu.y} items={menuItems} label="Columns" onClose={() => setHeadMenu(null)} />}
    </div>
  );
}
