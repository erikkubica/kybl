import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Group } from "../../lib/grouping";
import { useMeasured, useWindowed } from "../../../ui/hooks/useWindowed";
import { formatBytes, entrySize } from "../../../core/format";
import { EmptyState, FileIcon, LinkBadge } from "./FileIcon";
import { cachedThumb, canListThumb, loadThumb, onThumbReady } from "../../../thumbs/thumbs";
import { cachedPlaceholder, canPlaceholder, forgetPlaceholderMiss, learnPlaceholder, loadPlaceholder } from "../../../thumbs/thumbhash";
import { imageModeFor } from "../../../thumbs/imageMode";
import { useListNav, useMarquee, type Box, type FolderSizeInfo, type SelectKeys } from "./listNav";
import { gridHits, trackWidth } from "./gridHit";
import type { Entry } from "../../../core/types";
import { GitBadge } from "../DevMarks";
import type { GitMark } from "../../hooks/useGitStatus";

/** Tile width when the app passes none (settings.tileSize defaults to the same). */
const DEFAULT_TILE = 160;
/** a group's heading in a grouped grid, px */
const HEAD_H = 36;
/** grouped, rows this far outside the view are drawn too, px */
const OVERSCAN = 600;

/** A grouped grid's rows: a group's heading, or a row of tiles (entries start..start+n). */
type GRow = { head: Group; top: number } | { start: number; n: number; top: number };

const Card = memo(function Card({
  entry,
  selected,
  active,
  id,
  index,
  count,
  profileId,
  bucket,
  label,
  size,
  markKind,
  markTitle,
  markLetter,
  onPress,
  onOpen,
  onContext,
}: {
  entry: Entry;
  selected: boolean;
  /** has the keyboard cursor */
  active: boolean;
  id: string;
  index: number;
  /** total items, for screen readers ("12 of 340") */
  count: number;
  profileId: string;
  bucket: string;
  label: string;
  /** folder size, once worked out */
  size?: FolderSizeInfo;
  /** git status (parts of a GitMark, so the memo still holds) */
  markKind?: GitMark["kind"];
  markTitle?: string;
  markLetter?: string;
  onPress: (e: Entry, ev: React.MouseEvent) => void;
  onOpen: (e: Entry) => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  // the image mode is read at mount: the pane remounts the grid when it changes
  const eligible = canListThumb(entry, profileId);
  const phEligible = imageModeFor(profileId) !== "off" && canPlaceholder(entry);
  const [thumb, setThumb] = useState<string | null | undefined>(() => {
    if (eligible) return cachedThumb(profileId, bucket, entry);
    // showing placeholders only: a thumbnail already made on this device costs nothing to show
    return phEligible ? cachedThumb(profileId, bucket, entry) || null : null;
  });
  // the blurry ThumbHash stand-in, shown under the thumbnail until that fades in over it
  const [ph, setPh] = useState<string | null | undefined>(() =>
    phEligible && !thumb ? cachedPlaceholder(profileId, bucket, entry) : null,
  );
  /** its thumbnail is being made right now (not just queued): only then does the tile shimmer */
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!eligible && !phEligible) return;
    const el = ref.current;
    if (!el) return;
    let alive = true;
    // what is still to fetch (the state seen by this effect would go stale)
    let needThumb = eligible && thumb === undefined;
    let needPh = phEligible && ph === undefined;
    const asking = { thumb: false, ph: false };
    const request = () => {
      if (needThumb && !asking.thumb) {
        asking.thumb = true;
        loadThumb(
          profileId,
          bucket,
          entry,
          () => visible.current,
          () => alive && setLoading(true),
        ).then((u) => {
          asking.thumb = false;
          if (!alive) return;
          setLoading(false);
          if (u !== undefined) {
            needThumb = false;
            setThumb(u);
            if (u) learnPlaceholder(profileId, bucket, entry);
          }
          // skipped because it was off screen when its turn came; it may be back by now, and the
          // observer won't fire again while it stays put (it then waited forever)
          else if (visible.current) request();
        });
      }
      if (needPh && !asking.ph) {
        asking.ph = true;
        loadPlaceholder(profileId, bucket, entry, () => visible.current).then((u) => {
          asking.ph = false;
          if (!alive) return;
          if (u !== undefined) {
            needPh = false;
            setPh(u);
          } else if (visible.current) request();
        });
      }
    };
    const io = new IntersectionObserver(
      (items) => {
        for (const it of items) {
          visible.current = it.isIntersecting;
          if (it.isIntersecting) request();
        }
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    // its thumbnail made elsewhere (Quick Look for the selected photo): take it now rather
    // than waiting for this tile's own turn, or, showing placeholders only, the one it left behind
    const offReady = onThumbReady(profileId, bucket, entry, (url) => {
      if (!alive) return;
      if (eligible || phEligible) {
        needThumb = false;
        setLoading(false);
        setThumb(url);
        if (!eligible) forgetPlaceholderMiss(profileId, bucket, entry);
      }
    });
    return () => {
      alive = false;
      io.disconnect();
      offReady();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, phEligible, profileId, bucket, entry.key, entry.etag, entry.size]);

  const folder = entry.kind === "folder";
  const meta = folder ? (size && !size.running ? formatBytes(size.bytes) : "") : entrySize(entry);
  return (
    <div
      ref={ref}
      id={id}
      data-key={entry.key}
      data-index={index}
      data-drop={folder ? entry.key : undefined}
      data-spring={folder ? "" : undefined}
      className={`card ${selected ? "selected" : ""} ${active ? "active" : ""} ${markKind === "ignored" ? "git-ignored" : ""}`}
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={count}
      aria-label={folder ? `${label}, folder` : `${label}, ${meta}`}
      onMouseDown={(ev) => onPress(entry, ev)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        onContext(ev, entry);
      }}
      title={entry.key}
    >
      <div className={`card-thumb ${thumb || ph ? "has-img" : ""} ${folder ? "is-folder" : ""}`}>
        {/* the placeholder is static; the thumbnail fades in over it once */}
        {ph && <img className="ph" src={ph} alt="" draggable={false} />}
        {thumb && <img src={thumb} alt="" draggable={false} />}
        {/* shimmers only while its thumbnail is really being made (a few at a time), not while it
            waits its turn, and not over a placeholder: dozens of tiles animating kept the CPU and
            GPU busy */}
        {!thumb && !ph && <FileIcon entry={entry} size={34} big>{loading && thumb === undefined && <span className="shimmer" />}</FileIcon>}
        {(thumb || ph) && entry.link !== undefined && <LinkBadge link={entry.link} />}
      </div>
      <div className="card-text">
        {markKind ? (
          <div className="card-name">
            <span>{label}</span>
            <GitBadge mark={{ kind: markKind, title: markTitle ?? "", letter: markLetter ?? "" }} />
          </div>
        ) : (
          <div className="card-name">{label}</div>
        )}
        {meta && <div className="card-meta">{meta}</div>}
      </div>
    </div>
  );
});

export function GridView({
  entries,
  selected,
  loading = false,
  stale = false,
  hasMore,
  searchMode,
  prefix,
  tile,
  tileSize,
  compact = false,
  profileId,
  bucket,
  emptyAction,
  activeKey,
  autoFocus,
  folderSize,
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
  gitMark,
  groups,
}: {
  entries: Entry[];
  /** the tiles in headed groups (lib/grouping.ts; `entries` already in that order), or none */
  groups?: Group[] | null;
  selected: Set<string>;
  loading?: boolean;
  /** the tiles belong to the previous place while the new one loads: dimmed and inert */
  stale?: boolean;
  hasMore: boolean;
  searchMode: boolean;
  prefix: string;
  /** @deprecated use `tileSize` */
  tile?: number;
  /** tile width in px (settings.tileSize, 96..320) */
  tileSize?: number;
  /** compact density: tiles a quarter smaller, so more columns and rows fit */
  compact?: boolean;
  profileId: string;
  bucket: string;
  emptyAction?: ReactNode;
  activeKey?: string | null;
  autoFocus?: boolean;
  folderSize?(key: string): FolderSizeInfo | undefined;
  onPress: (e: Entry, ev: React.MouseEvent) => void;
  onOpen: (e: Entry) => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
  onBackgroundContextMenu?(ev: React.MouseEvent): void;
  onLoadMore: () => void;
  onClearSelection: () => void;
  onMove: (delta: number, shift: boolean) => void;
  onSelectKeys?: SelectKeys;
  onUpload?(): void;
  onNewFolder?(): void;
  /** this computer's folders in a git work tree: an item's status mark */
  gitMark?(e: Entry): GitMark | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const listId = useId();
  const size = Math.round(Math.min(320, Math.max(96, tileSize ?? tile ?? DEFAULT_TILE)) * (compact ? 0.75 : 1));

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((items) => items.some((i) => i.isIntersecting) && onLoadMore(), {
      root: scroller.current,
      rootMargin: "400px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, entries.length]);

  // Only the rows of tiles near the viewport are rendered. Column count, gaps and the grid's
  // padding come from the layout, so they follow the window size, tile size and density.
  const [layout, setLayout] = useState({ cols: 1, colW: size, gap: 6, colGap: 6, top: 12, left: 12 });
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    const read = () => {
      const cs = getComputedStyle(g);
      const next = {
        cols: cs.gridTemplateColumns.split(" ").length || 1,
        colW: trackWidth(cs.gridTemplateColumns, size),
        gap: parseFloat(cs.rowGap) || 0,
        colGap: parseFloat(cs.columnGap) || 0,
        top: parseFloat(cs.paddingTop) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      };
      setLayout((l) => (l.cols === next.cols && Math.abs(l.colW - next.colW) < 0.5 && l.gap === next.gap && l.colGap === next.colGap && l.top === next.top && l.left === next.left ? l : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(g);
    return () => ro.disconnect();
    // (grouping swaps the measured element: the tile grid, or the grouped grid's measure)
  }, [size, entries.length === 0, !!groups?.length]);
  const cardH = useMeasured(scroller, ".card", size + 40);
  const rowH = cardH + layout.gap;
  const win = useWindowed({ scroller, count: entries.length, columns: layout.cols, rowHeight: rowH, offset: layout.top });

  // grouped: each group a heading, then its tiles in rows of their own; laid out here (heights
  // known: the heading's and a tile row's), and only the rows near the view are drawn
  const grouped = useMemo(() => {
    if (!groups?.length) return null;
    const cols = Math.max(1, layout.cols);
    const rows: GRow[] = [];
    let y = layout.top;
    for (const g of groups) {
      rows.push({ head: g, top: y });
      y += HEAD_H;
      for (let s = g.start; s < g.start + g.count; s += cols) {
        rows.push({ start: s, n: Math.min(cols, g.start + g.count - s), top: y });
        y += rowH;
      }
    }
    return { rows, height: y };
  }, [groups, layout.cols, layout.top, rowH]);
  const [vp, setVp] = useState({ top: 0, height: 800 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !grouped) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setVp((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    const on = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", on);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [!!grouped]);
  const rowHeight = (r: GRow) => ("head" in r ? HEAD_H : rowH);

  const itemEl = useCallback((i: number) => scroller.current?.querySelector(`[data-index="${i}"]`) ?? null, []);
  const nav = useListNav({
    entries,
    selected,
    activeKey,
    columns: () => layout.cols,
    pageItems: () => Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / rowH)) * layout.cols,
    container: scroller,
    itemEl,
    autoFocus,
    focusKey: `${prefix}|${searchMode}`,
    onMove,
    onSelectKeys,
    onContext,
    onBackgroundContextMenu,
  });

  // the columns share out the row's width: the rectangle maps to rows and the drawn columns
  const hitTest = useCallback(
    (b: Box) => {
      if (!grouped) return gridHits(b, { ...layout, rowH, cardH }, entries.length);
      const out: number[] = [];
      const pitchX = layout.colW + layout.colGap;
      for (const r of grouped.rows) {
        if ("head" in r || b.y1 < r.top || b.y0 > r.top + cardH) continue;
        for (let c = 0; c < r.n; c++) {
          const left = layout.left + c * pitchX;
          if (b.x1 >= left && b.x0 <= left + layout.colW) out.push(r.start + c);
        }
      }
      return out;
    },
    [grouped, layout, rowH, cardH, entries.length],
  );
  const marquee = useMarquee({ scroller, entries, selected, hitTest, onSelectKeys, onMove, onClearSelection });

  const { reveal } = win;
  useEffect(() => {
    if (marquee.selecting.current || nav.activeIndex < 0) return;
    if (grouped) {
      const el = scroller.current;
      const i = nav.activeIndex;
      const r = grouped.rows.find((x) => !("head" in x) && i >= x.start && i < x.start + x.n);
      if (!el || !r) return;
      // the group's heading comes along when it's the group's first row
      const top = r.top - ("start" in r && grouped.rows.some((x) => "head" in x && x.top + HEAD_H === r.top) ? HEAD_H : 0);
      if (top < el.scrollTop) el.scrollTop = top;
      else if (r.top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = r.top + rowH - el.clientHeight;
      return;
    }
    reveal(nav.activeIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.active, selected, reveal]);

  // memoised cards need a stable handler; the latest props are read through a ref
  const pressRef = useRef({ notePress: nav.notePress, onPress });
  pressRef.current = { notePress: nav.notePress, onPress };
  const press = useCallback((e: Entry, ev: React.MouseEvent) => {
    pressRef.current.notePress(e);
    pressRef.current.onPress(e, ev);
  }, []);

  /** One tile: entry `e`, item `i` of the list. */
  const card = (e: Entry, i: number) => {
    const rel = e.key.slice(prefix.length).replace(/\/$/, "");
    const fs = e.kind === "folder" ? folderSize?.(e.key) : undefined;
    const mark = gitMark?.(e);
    return (
      <Card
        // keyed by content too: a changed file gets a fresh tile, which asks for its new thumbnail
        key={`${e.key}\n${e.etag ?? ""}\n${e.size}`}
        entry={e}
        id={`${listId}-o${i}`}
        index={i}
        count={entries.length}
        selected={selected.has(e.key)}
        active={i === nav.activeIndex}
        profileId={profileId}
        bucket={bucket}
        label={searchMode ? rel : e.name}
        size={fs}
        markKind={mark?.kind}
        markTitle={mark?.title}
        markLetter={mark?.letter}
        onPress={press}
        onOpen={onOpen}
        onContext={onContext}
      />
    );
  };

  // columns may narrow to 80% of the tile size to fit one more, then share the row evenly
  const columnsCss = `repeat(auto-fill, minmax(min(${Math.round(size * 0.8)}px, 100%), 1fr))`;
  const empty = entries.length === 0;

  return (
    <div
      className={`grid-scroll ${stale ? "stale" : ""} ${nav.kbd ? "kbd" : ""}`}
      ref={scroller}
      tabIndex={0}
      data-list-focus=""
      role={empty ? undefined : "listbox"}
      aria-label={searchMode ? "Search results" : "Files"}
      aria-multiselectable={empty ? undefined : true}
      aria-activedescendant={nav.activeIndex >= 0 ? `${listId}-o${nav.activeIndex}` : undefined}
      aria-busy={loading || stale || undefined}
      style={{ "--tile": `${size}px` } as React.CSSProperties}
      onKeyDown={nav.onKeyDown}
      onContextMenu={(ev) => nav.onContextMenu(ev, ".card")}
      onMouseDown={(ev) => {
        const t = ev.target as HTMLElement;
        if (t.closest(".card, button, a, .empty")) return;
        nav.setKbd(false);
        marquee.begin(ev);
      }}
    >
      {grouped ? (
        <>
          {/* only measured: the columns and gaps the tile rows share */}
          <div className="grid grid-measure" ref={grid} aria-hidden="true" style={{ gridTemplateColumns: columnsCss }} />
          <div className="grid-groups" role="presentation" style={{ height: grouped.height }}>
            {grouped.rows
              .filter((r) => r.top + rowHeight(r) >= vp.top - OVERSCAN && r.top <= vp.top + vp.height + OVERSCAN)
              .map((r) =>
                "head" in r ? (
                  <div
                    key={`g:${r.head.key}`}
                    className="grid-group-head"
                    style={{ top: r.top, height: HEAD_H, paddingInline: layout.left }}
                    // a click selects everything in it (as Explorer's does)
                    onMouseDown={(ev) => {
                      if (ev.button !== 0 || !onSelectKeys) return;
                      ev.preventDefault();
                      const ks = entries.slice(r.head.start, r.head.start + r.head.count).map((x) => x.key);
                      onSelectKeys(ks, ks[0]);
                    }}
                  >
                    <span>{r.head.label}</span>
                    <span className="group-count">{r.head.count.toLocaleString()}</span>
                  </div>
                ) : (
                  <div key={`r:${r.start}`} className="grid grid-row" role="presentation" style={{ top: r.top, gridTemplateColumns: columnsCss, paddingInline: layout.left }}>
                    {entries.slice(r.start, r.start + r.n).map((e, n) => card(e, r.start + n))}
                  </div>
                ),
              )}
          </div>
        </>
      ) : (
        <>
          {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
          <div className="grid" ref={grid} role="presentation" style={{ gridTemplateColumns: columnsCss }}>
            {entries.slice(win.start, win.end).map((e, n) => card(e, win.start + n))}
          </div>
          {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
        </>
      )}
      {empty && !loading && <EmptyState searchMode={searchMode} action={emptyAction} onUpload={onUpload} onNewFolder={onNewFolder} />}
      {loading && empty && (
        <div className="grid skel-grid" style={{ gridTemplateColumns: columnsCss }} aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="card" style={{ opacity: 1 - i * 0.06 }}>
              <div className="skel skel-thumb" />
              <div className="skel skel-line" />
            </div>
          ))}
        </div>
      )}
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
  );
}
