import { keys } from "../../../ui/lib/osText";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { GitBadge, HitLine } from "../DevMarks";
import type { GitMark } from "../../hooks/useGitStatus";
import type { ContentHit } from "../../lib/devtoolsApi";
import { useMeasured, useWindowed } from "../../../ui/hooks/useWindowed";
import { Icon } from "../../../ui/components/Icons";
import { formatBytes, formatDate, formatDateFull, entrySize, entryKind, extOf, parentPrefix, plural } from "../../../core/format";
import { modeText } from "../../../perms/permsApi";
import type { Group } from "../../lib/grouping";
import { EmptyState, FileIcon, SkeletonRows } from "./FileIcon";
import { ContextMenu, isMenuKey, menuPointFor, type MenuItem } from "../../../ui/components/Dialogs";
import { useListNav, useMarquee, type Box, type FolderSizeInfo, type SelectKeys } from "./listNav";
import { storageClassLabel } from "../../lib/storageClasses";
import { DEFAULTS, type ColumnId, type SortBy } from "../../../settings/settings";
import type { Entry } from "../../../core/types";

export type SortKey = SortBy;
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
  { id: "created", cls: "c-created", sort: "created", label: "Created", def: 140, min: 90, max: 280 },
  { id: "kind", cls: "c-kind", sort: "kind", label: "Kind", def: 108, min: 64, max: 280 },
  { id: "type", cls: "c-type", sort: "type", label: "Type", def: 64, min: 44, max: 160 },
  { id: "perms", cls: "c-perms", label: "Permissions", def: 96, min: 70, max: 160 },
  { id: "owner", cls: "c-owner", label: "Owner", def: 110, min: 56, max: 240 },
  { id: "storageClass", cls: "c-sc", label: "Storage class", def: 118, min: 70, max: 240 },
  { id: "etag", cls: "c-etag", label: "ETag", def: 150, min: 80, max: 320 },
];
const NAME_MIN = 190;
/** a width given to the name (dragged, or fitted to short names) may go this narrow */
const NAME_SET_MIN = 80;
const GAP = 14;
/** a row's own side padding (10px each side) */
const ROW_PAD = 20;
/** the Name column's own width, once dragged (none: it takes the room the others leave) */
const NAME_W_KEY = "s3b.nameWidth";
const NAME_MAX = 1600;

function loadNameW(): number | null {
  const v = Number(localStorage.getItem(NAME_W_KEY) ?? "");
  return Number.isFinite(v) && v >= NAME_SET_MIN ? Math.min(NAME_MAX, v) : null;
}
function saveNameW(w: number | null) {
  try {
    if (w == null) localStorage.removeItem(NAME_W_KEY);
    else localStorage.setItem(NAME_W_KEY, String(w));
  } catch {
    /* ignore */
  }
}
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

/** What a column's cell says for an entry, as drawn (for fitting the column to it). */
function cellText(id: ColumnId | "name", e: Entry, folderSize: ((key: string) => FolderSizeInfo | undefined) | undefined, searchBase: string | null): string {
  const folder = e.kind === "folder";
  switch (id) {
    case "name":
      return searchBase != null ? e.key.slice(searchBase.length).replace(/\/$/, "") : e.name;
    case "size": {
      if (!folder) return entrySize(e);
      const info = folderSize?.(e.key);
      return info ? formatBytes(info.bytes) : "Calculate";
    }
    case "modified":
      return formatDate(e.modified);
    case "created":
      return e.created ? formatDate(e.created) : "—";
    case "kind":
      return entryKind(e);
    case "type":
      return folder ? "" : extOf(e.name).toUpperCase() || "—";
    case "perms":
      return e.mode != null ? modeText(e.mode) : "—";
    case "owner":
      return e.owner ? `${e.owner}${e.group ? ` · ${e.group}` : ""}` : "—";
    case "storageClass":
      return folder ? "" : storageClassLabel(e.storageClass) || "—";
    case "etag":
      return folder ? "" : e.etag?.replace(/"/g, "") || "—";
  }
}

/** A row the list draws: a group's heading, or entry `i`. */
type Item = { head: Group } | { i: number };

/** Grouped rows: the headings and entries in drawing order, and where each entry is drawn. */
function useMemoGroups(count: number, groups: Group[] | null | undefined): { items: Item[] | null; posOf: (i: number) => number } {
  return useMemo(() => {
    if (!groups?.length) return { items: null, posOf: (i: number) => i };
    const items: Item[] = [];
    const pos = new Array<number>(count);
    for (const g of groups) {
      items.push({ head: g });
      for (let i = g.start; i < g.start + g.count && i < count; i++) {
        pos[i] = items.length;
        items.push({ i });
      }
    }
    return { items, posOf: (i: number) => pos[i] ?? i };
  }, [count, groups]);
}

/** Size cell of a folder: its size once worked out, progress while it runs, else a Calculate link. */
function FolderSizeCell({ info, onCalc, onStop }: { info: FolderSizeInfo | undefined; onCalc?: () => void; onStop?: () => void }) {
  if (info?.running)
    return (
      <span className="fsize running" title={`${plural(info.objects, "object")} so far`}>
        <span className="spinner sm" />
        {info.bytes > 0 ? formatBytes(info.bytes) : ""}
        {onStop && (
          <button
            type="button"
            className="fsize-calc"
            title="Stop adding up this folder"
            onMouseDown={(ev) => ev.stopPropagation()}
            onDoubleClick={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation();
              onStop();
            }}
          >
            Stop
          </button>
        )}
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
  groups,
  columns,
  unavailable,
  activeKey,
  autoFocus,
  folderSize,
  onCalcSize,
  onCancelSize,
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
  onGoUp,
  gitMark,
  hitOf,
  onHitOpen,
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
  /** the rows in headed groups (lib/grouping.ts; `entries` already in that order), or none */
  groups?: Group[] | null;
  /** optional columns in order (settings.columns); without it the choice is kept per window */
  columns?: ColumnId[];
  /** columns this connection can't fill (storage class off S3): left out of the header's menu */
  unavailable?: ColumnId[];
  /** the app's keyboard cursor, if it shares it */
  activeKey?: string | null;
  /** take keyboard focus when shown and whenever `prefix` changes */
  autoFocus?: boolean;
  folderSize?(key: string): FolderSizeInfo | undefined;
  onCalcSize?(key: string): void;
  onCancelSize?(key: string): void;
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
  /** a ".." row on top goes to the enclosing folder (given only inside a folder) */
  onGoUp?(): void;
  /** this computer's folders in a git work tree: an item's status mark */
  gitMark?(e: Entry): GitMark | undefined;
  /** a search inside files: the item's first matching line */
  hitOf?(e: Entry): ContentHit | undefined;
  /** a click on that line: preview the file there */
  onHitOpen?(e: Entry): void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowH = useMeasured(body, ".row:not(.row-group)", 32);
  // the ".." row sits above the first entry
  const upH = onGoUp ? rowH : 0;
  // grouped: each group's heading is a row of its own before its entries. `items` is what the
  // list draws in order; `posOf[i]` is where entry i sits among them
  const { items, posOf } = useMemoGroups(entries.length, groups);
  // the body's top padding sits above the first row
  const win = useWindowed({ scroller: body, count: items ? items.length : entries.length, rowHeight: rowH, offset: 4 + upH });
  const [widths, setWidths] = useState(loadWidths);
  const [resizing, setResizing] = useState<ColumnId | "name" | null>(null);
  const [nameW, setNameW] = useState(loadNameW);
  const [localCols, setLocalCols] = useState(loadLocalCols);
  const [headMenu, setHeadMenu] = useState<{ x: number; y: number } | null>(null);
  const chosen = columns ?? localCols;

  // The name keeps at least NAME_MIN; when the columns don't fit beside it, the list scrolls
  // sideways (the header follows the rows) instead of leaving columns out.
  const shown = chosen.map((id) => COLS.find((c) => c.id === id)).filter((c): c is Col => !!c && !unavailable?.includes(c.id));
  const rowMin = (nameW ?? NAME_MIN) + ROW_PAD + shown.reduce((n, c) => n + widths[c.id] + GAP, 0);
  // a dragged Name keeps its width, and an empty track after the last column takes what's left
  const template = nameW
    ? `${nameW}px${shown.map((c) => ` ${widths[c.id]}px`).join("")} minmax(0, 1fr)`
    : `minmax(${NAME_MIN}px, 1fr)${shown.map((c) => ` ${widths[c.id]}px`).join("")}`;
  const thead = useRef<HTMLDivElement>(null);
  const followScroll = () => {
    const h = thead.current;
    if (h && body.current) h.style.transform = `translateX(${-body.current.scrollLeft}px)`;
  };

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

  /**
   * Each column's handle is its right edge, as in Finder and Explorer: dragging it right makes
   * that column wider and moves the ones after it along (the list scrolls sideways once they
   * don't fit); left makes it narrower. Name too: once dragged it keeps its own width.
   * Double-click resets (Name back to taking the room the others leave).
   */
  const startResize = (ev: React.PointerEvent, col: Col | "name") => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const isName = col === "name";
    // Name starts from the width it's drawn at
    const startW = isName ? Math.round(thead.current?.querySelector<HTMLElement>(".th.c-name")?.getBoundingClientRect().width ?? NAME_MIN) : widths[col.id];
    const [lo, hi] = isName ? [NAME_SET_MIN, NAME_MAX] : [col.min, col.max];
    let latest = widths;
    let latestName = nameW;
    setResizing(isName ? "name" : col.id);
    const move = (e: PointerEvent) => {
      const w = Math.min(hi, Math.max(lo, Math.round(startW + e.clientX - startX)));
      if (isName) {
        latestName = w;
        setNameW(w);
      } else {
        latest = { ...latest, [col.id]: w };
        setWidths(latest);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(null);
      if (isName) saveNameW(latestName);
      else saveWidths(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /**
   * Double-click on a column's edge: as wide as its longest text, in the whole folder (or its
   * first few thousand items), as Explorer does; the header's label counts too.
   */
  const fitCol = (col: Col | "name") => {
    const id = col === "name" ? "name" : col.id;
    const cls = col === "name" ? "c-name" : col.cls;
    const cell = body.current?.querySelector<HTMLElement>(`.row:not(.row-group):not(.row-up) .${cls}${col === "name" ? " .name-text" : ""}`);
    const headLabel = thead.current?.querySelector<HTMLElement>(`.th.${cls} .th-btn`);
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const measure = (font: string, texts: Iterable<string>) => {
      ctx.font = font;
      let w = 0;
      for (const t of texts) if (t) w = Math.max(w, ctx.measureText(t).width);
      return w;
    };
    // from its parts: the shorthand reads "" when a part (tabular numbers) has no shorthand form
    const fontOf = (el: Element | null | undefined, fallback: string) => {
      if (!el) return fallback;
      const c = getComputedStyle(el);
      return `${c.fontStyle} ${c.fontWeight} ${c.fontSize} ${c.fontFamily}`;
    };
    const base = fontOf(body.current, "13px sans-serif");
    // a cell's own font (mono for ETag and permissions, the list's for the rest)
    const sample = id === "etag" || id === "perms" ? body.current?.querySelector(`.row .${cls}.mono`) : cell;
    const list = entries.length > 5000 ? entries.slice(0, 5000) : entries;
    const texts = list.map((e) => cellText(id, e, folderSize, searchMode ? prefix : null));
    let w = Math.ceil(measure(fontOf(sample, base), texts));
    // the canvas knows no tabular digits or letter spacing: the longest few, measured as drawn
    const from = sample ?? body.current;
    if (from) {
      ctx.font = fontOf(sample, base);
      const top = [...new Set(texts)].map((t) => [t, ctx.measureText(t).width] as const).sort((a, b) => b[1] - a[1]).slice(0, 12);
      const span = document.createElement("span");
      const c = getComputedStyle(from);
      Object.assign(span.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre", font: "inherit", fontStyle: c.fontStyle, fontWeight: c.fontWeight, fontSize: c.fontSize, fontFamily: c.fontFamily, fontVariantNumeric: c.fontVariantNumeric, letterSpacing: c.letterSpacing, fontFeatureSettings: c.fontFeatureSettings });
      document.body.appendChild(span);
      for (const [t] of top) {
        span.textContent = t;
        w = Math.max(w, Math.ceil(span.getBoundingClientRect().width));
      }
      span.remove();
    }
    // the label's text (and the sort arrow beside it); the button itself fills the column
    if (headLabel) w = Math.max(w, Math.ceil(measure(fontOf(headLabel, base), [headLabel.textContent?.trim() ?? ""])) + 18);
    if (col === "name") {
      // the icon and the gap before the name
      const ico = body.current?.querySelector<HTMLElement>(".row .c-name .ico");
      w += (ico?.offsetWidth ?? 17) + 10 + 4;
      w = Math.min(NAME_MAX, Math.max(NAME_SET_MIN, w));
      setNameW(w);
      saveNameW(w);
      return;
    }
    w = Math.min(col.max, Math.max(col.min, w + 4));
    const next = { ...widths, [col.id]: w };
    setWidths(next);
    saveWidths(next);
  };
  const resetCol = (col: Col | "name") => {
    if (col === "name") {
      setNameW(null);
      saveNameW(null);
      return;
    }
    const w = { ...widths, [col.id]: col.def };
    setWidths(w);
    saveWidths(w);
  };
  /** Arrow keys on a focused column edge resize it too (right: wider). */
  const keyResize = (ev: React.KeyboardEvent, col: Col | "name") => {
    const d = ev.key === "ArrowRight" ? 10 : ev.key === "ArrowLeft" ? -10 : 0;
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (col === "name") {
      const cur = nameW ?? Math.round(thead.current?.querySelector<HTMLElement>(".th.c-name")?.getBoundingClientRect().width ?? NAME_MIN);
      const w = Math.min(NAME_MAX, Math.max(NAME_SET_MIN, cur + d));
      setNameW(w);
      saveNameW(w);
      return;
    }
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

  // the ".." row can have the keyboard cursor (ArrowUp from the first row, or Home): Enter goes up,
  // ArrowDown comes back. It is never selected, so nothing acts on it but Enter.
  const [upActive, setUpActive] = useState(false);
  const hasUp = !!onGoUp;
  useEffect(() => setUpActive(false), [prefix, searchMode, hasUp]);
  useEffect(() => {
    if (selected.size) setUpActive(false);
  }, [selected]);
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.target === ev.currentTarget && onGoUp) {
      const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey;
      if (upActive) {
        if (ev.key === "Enter" && plain) {
          ev.preventDefault();
          setUpActive(false);
          onGoUp();
          return;
        }
        if ((ev.key === "ArrowUp" || ev.key === "Home" || ev.key === "PageUp") && plain) {
          ev.preventDefault();
          return;
        }
        if (ev.key === "ArrowDown" && plain) {
          ev.preventDefault();
          setUpActive(false);
          if (entries.length) nav.goTo(0);
          return;
        }
        if (ev.key === "Escape") setUpActive(false);
      } else if (plain && ((ev.key === "ArrowUp" && (nav.activeIndex === 0 || !entries.length)) || ev.key === "Home")) {
        ev.preventDefault();
        nav.setKbd(true);
        setUpActive(true);
        onClearSelection();
        body.current?.scrollTo({ top: 0 });
        return;
      }
    }
    nav.onKeyDown(ev);
  };

  const hitTest = useCallback(
    (b: Box) => {
      const n = items ? items.length : entries.length;
      const first = Math.max(0, Math.floor((b.y0 - 4 - upH) / rowH));
      const last = Math.min(n - 1, Math.floor((b.y1 - 4 - upH) / rowH));
      const out: number[] = [];
      for (let k = first; k <= last; k++) {
        const it = items ? items[k] : { i: k };
        if ("i" in it) out.push(it.i);
      }
      return out;
    },
    [rowH, upH, entries.length, items],
  );
  const marquee = useMarquee({ scroller: body, entries, selected, hitTest, onSelectKeys, onMove, onClearSelection });

  // keep the keyboard cursor visible (it may not be rendered yet); not while rubber-banding
  const { reveal } = win;
  useEffect(() => {
    if (marquee.selecting.current || nav.activeIndex < 0) return;
    reveal(posOf(nav.activeIndex));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.active, selected, reveal]);

  const press = (e: Entry, ev: React.MouseEvent) => {
    nav.notePress(e);
    // like Finder: a press beside the name of an unselected row starts a rubber band (released in
    // place it just selects the row); on the name or icon, or on a selected row, it drags
    const t = ev.target as HTMLElement;
    const plain = ev.button === 0 && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey;
    if (plain && onSelectKeys && !selected.has(e.key) && !t.closest(".name-text, .ico, svg, button, a")) {
      nav.setKbd(false);
      marquee.begin(ev, () => onSelectKeys([e.key], e.key));
      return;
    }
    onPress(e, ev);
  };

  const head = (label: string, cls: string, key?: SortKey, col?: Col | "name") => (
    <div
      key={cls}
      className={`th ${cls} ${key && sort.key === key ? "sorted" : ""}`}
      role="columnheader"
      aria-sort={key && sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      {col && (
        <span
          className={`col-grip ${resizing === (col === "name" ? "name" : col.id) ? "on" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize the ${label} column`}
          aria-valuenow={col === "name" ? (nameW ?? undefined) : widths[col.id]}
          aria-valuemin={col === "name" ? NAME_SET_MIN : col.min}
          aria-valuemax={col === "name" ? NAME_MAX : col.max}
          tabIndex={0}
          title="Drag to resize · double-click to fit the longest · ⌥ double-click to reset"
          onPointerDown={(ev) => startResize(ev, col)}
          onKeyDown={(ev) => keyResize(ev, col)}
          onClick={(ev) => ev.stopPropagation()}
          onDoubleClick={(ev) => {
            ev.stopPropagation();
            if (ev.altKey) resetCol(col);
            else fitCol(col);
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
    ...COLS.filter((c) => !unavailable?.includes(c.id)).map((c): MenuItem => ({ type: "item", label: c.label, checked: chosen.includes(c.id), onClick: () => toggleCol(c.id) })),
    { type: "sep" },
    {
      type: "item",
      label: "Reset columns",
      onClick: () => {
        setChosen(DEFAULTS.columns);
        setNameW(null);
        saveNameW(null);
        const w = loadWidths();
        for (const c of COLS) w[c.id] = c.def;
        setWidths(w);
        saveWidths(w);
      },
    },
  ];

  const activeId = upActive ? `${listId}-up` : nav.activeIndex >= 0 ? `${listId}-r${nav.activeIndex}` : undefined;
  const empty = entries.length === 0;

  return (
    <div
      className={`table ${resizing ? "resizing" : ""} ${stale ? "stale" : ""} ${nav.kbd ? "kbd" : ""}`}
      ref={table}
      style={{ "--cols": template, "--row-min": `${rowMin}px` } as React.CSSProperties}
      tabIndex={0}
      data-list-focus=""
      role="grid"
      aria-label={searchMode ? "Search results" : "Files"}
      aria-multiselectable="true"
      aria-rowcount={hasMore ? -1 : entries.length + 1}
      aria-colcount={shown.length + 1}
      aria-activedescendant={activeId}
      aria-busy={loading || stale || undefined}
      onKeyDown={onKeyDown}
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
        ref={thead}
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
        {head("Name", "c-name", "name", "name")}
        {shown.map((c) => head(c.label, c.cls, c.sort, c))}
      </div>
      <div className="table-body" ref={body} role="rowgroup" onScroll={followScroll}>
        {onGoUp && (
          // not an entry: no selection or menu; files dropped on it move to the enclosing folder
          <div
            id={`${listId}-up`}
            className={`row is-folder row-up ${upActive ? "active" : ""}`}
            role="row"
            data-drop={parentPrefix(prefix)}
            title={keys("Enclosing folder (⌘↑)")}
            onMouseDown={(ev) => ev.button === 0 && ev.preventDefault()}
            onDoubleClick={onGoUp}
            onContextMenu={(ev) => ev.preventDefault()}
          >
            <div className="c-name" role="gridcell">
              <span className="ico ico-folder">
                <Icon name="folder" size={17} />
              </span>
              <span className="name-text" aria-label="Enclosing folder">..</span>
            </div>
            {shown.map((c) => (
              <div key={c.id} role="gridcell" />
            ))}
          </div>
        )}
        {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
        {Array.from({ length: Math.max(0, win.end - win.start) }, (_, n) => {
          const k = win.start + n;
          const it: Item = items ? items[k] : { i: k };
          if ("head" in it) {
            const g = it.head;
            const keysIn = () => entries.slice(g.start, g.start + g.count).map((x) => x.key);
            return (
              // a group's heading: a click selects everything in it (as Explorer's does)
              <div
                key={`g:${g.key}`}
                className="row row-group"
                role="row"
                onMouseDown={(ev) => {
                  if (ev.button !== 0 || !onSelectKeys) return;
                  ev.preventDefault();
                  const ks = keysIn();
                  onSelectKeys(ks, ks[0]);
                }}
                onContextMenu={(ev) => ev.preventDefault()}
              >
                <div className="group-label" role="gridcell">
                  {/* stays in view when the list is scrolled sideways */}
                  <span className="group-text">
                    <span>{g.label}</span>
                    <span className="group-count">{g.count.toLocaleString()}</span>
                  </span>
                </div>
              </div>
            );
          }
          const i = it.i;
          const e = entries[i];
          if (!e) return null;
          const sel = selected.has(e.key);
          const rel = e.key.slice(prefix.length).replace(/\/$/, "");
          const slash = searchMode ? rel.lastIndexOf("/") : -1;
          const folder = e.kind === "folder";
          const mark = gitMark?.(e);
          const hit = hitOf?.(e);
          return (
            <div
              key={e.key}
              id={`${listId}-r${i}`}
              data-key={e.key}
              data-index={i}
              data-drop={folder ? e.key : undefined}
              data-spring={folder ? "" : undefined}
              className={`row ${sel ? "selected" : ""} ${folder ? "is-folder" : ""} ${i === nav.activeIndex && !upActive ? "active" : ""} ${mark?.kind === "ignored" ? "git-ignored" : ""}`}
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
                {hit && <HitLine hit={hit} onOpen={onHitOpen && (() => onHitOpen(e))} />}
                {mark && <GitBadge mark={mark} />}
              </div>
              {shown.map((c) => {
                switch (c.id) {
                  case "size":
                    return (
                      <div key={c.id} className="c-size" role="gridcell">
                        {folder ? <FolderSizeCell info={folderSize?.(e.key)} onCalc={onCalcSize && (() => onCalcSize(e.key))} onStop={onCancelSize && (() => onCancelSize(e.key))} /> : entrySize(e)}
                      </div>
                    );
                  case "modified":
                    return (
                      <div key={c.id} className={`c-mod ${e.modified ? "" : "faint"}`} role="gridcell" title={e.modified ? formatDateFull(e.modified) : undefined}>
                        {formatDate(e.modified)}
                      </div>
                    );
                  case "created":
                    return (
                      <div key={c.id} className={`c-mod ${e.created ? "" : "faint"}`} role="gridcell" title={e.created ? formatDateFull(e.created) : undefined}>
                        {e.created ? formatDate(e.created) : "—"}
                      </div>
                    );
                  case "kind":
                    return (
                      <div key={c.id} className="c-kind" role="gridcell">
                        {entryKind(e)}
                      </div>
                    );
                  case "type": {
                    const x = folder ? "" : extOf(e.name).toUpperCase();
                    return (
                      <div key={c.id} className={`c-kind ${x ? "" : "faint"}`} role="gridcell">
                        {folder ? "" : x || "—"}
                      </div>
                    );
                  }
                  case "perms":
                    return (
                      <div key={c.id} className={`c-kind mono ${e.mode != null ? "" : "faint"}`} role="gridcell" title={e.mode != null ? `${(e.mode & 0o7777).toString(8).padStart(3, "0")}` : undefined}>
                        {e.mode != null ? modeText(e.mode) : "—"}
                      </div>
                    );
                  case "owner":
                    return (
                      <div key={c.id} className={`c-kind ${e.owner ? "" : "faint"}`} role="gridcell" title={e.owner ? `${e.owner}${e.group ? `:${e.group}` : ""}` : undefined}>
                        {e.owner ? `${e.owner}${e.group ? ` · ${e.group}` : ""}` : "—"}
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
        {/* only while further pages load: a refresh of what's on screen adds no row (it made the
            content taller than the view, and a scrollbar came and went) */}
        {loading && !empty && !stale && hasMore && (
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
