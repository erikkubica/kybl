import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMeasured, useWindowed } from "../useWindowed";
import { formatBytes } from "../format";
import { EmptyState, FileIcon } from "./FileIcon";
import { cachedThumb, canListThumb, loadThumb } from "../thumbs";
import type { Entry } from "../types";

const Card = memo(function Card({
  entry,
  selected,
  profileId,
  bucket,
  label,
  onPress,
  onOpen,
  onContext,
}: {
  entry: Entry;
  selected: boolean;
  profileId: string;
  bucket: string;
  label: string;
  onPress: (e: Entry, ev: React.MouseEvent) => void;
  onOpen: (e: Entry) => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const eligible = canListThumb(entry);
  const [thumb, setThumb] = useState<string | null | undefined>(() =>
    eligible ? cachedThumb(profileId, bucket, entry) : null,
  );

  useEffect(() => {
    if (!eligible) return;
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const request = () => {
      if (thumb !== undefined) return;
      loadThumb(profileId, bucket, entry, () => visible.current).then((u) => {
        if (alive && u !== undefined) setThumb(u);
      });
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
    return () => {
      alive = false;
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, profileId, bucket, entry.key, entry.etag, entry.size]);


  return (
    <div
      ref={ref}
      data-key={entry.key}
      data-drop={entry.kind === "folder" ? entry.key : undefined}
      data-spring={entry.kind === "folder" ? "" : undefined}
      className={`card ${selected ? "selected" : ""}`}
      onMouseDown={(ev) => onPress(entry, ev)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        onContext(ev, entry);
      }}
      title={entry.key}
    >
      <div className={`card-thumb ${thumb ? "has-img" : ""} ${entry.kind === "folder" ? "is-folder" : ""}`}>
        {thumb ? (
          <img src={thumb} alt="" draggable={false} />
        ) : (
          <FileIcon entry={entry} size={34} big>
            {eligible && thumb === undefined && <span className="shimmer" />}
          </FileIcon>
        )}
      </div>
      <div className="card-text">
        <div className="card-name">{label}</div>
        {entry.kind === "file" && <div className="card-meta">{formatBytes(entry.size)}</div>}
      </div>
    </div>
  );
});

export function GridView({
  entries,
  selected,
  loading,
  hasMore,
  searchMode,
  prefix,
  tile,
  profileId,
  bucket,
  emptyAction,
  onPress,
  onOpen,
  onContext,
  onLoadMore,
  onClearSelection,
  onMove,
}: {
  entries: Entry[];
  selected: Set<string>;
  loading: boolean;
  hasMore: boolean;
  searchMode: boolean;
  prefix: string;
  tile: number;
  profileId: string;
  bucket: string;
  emptyAction?: ReactNode;
  onPress: (e: Entry, ev: React.MouseEvent) => void;
  onOpen: (e: Entry) => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
  onLoadMore: () => void;
  onClearSelection: () => void;
  onMove: (delta: number, shift: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

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

  const columns = () => {
    const g = grid.current;
    if (!g) return 1;
    return getComputedStyle(g).gridTemplateColumns.split(" ").length || 1;
  };

  // Only the rows of tiles near the viewport are rendered. Column count, row gap and the grid's
  // top padding come from the layout, so they follow the window size, tile size and density.
  const [layout, setLayout] = useState({ cols: 1, gap: 6, top: 12 });
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    const read = () => {
      const cs = getComputedStyle(g);
      const next = { cols: cs.gridTemplateColumns.split(" ").length || 1, gap: parseFloat(cs.rowGap) || 0, top: parseFloat(cs.paddingTop) || 0 };
      setLayout((l) => (l.cols === next.cols && l.gap === next.gap && l.top === next.top ? l : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(g);
    return () => ro.disconnect();
  }, [tile]);
  const cardH = useMeasured(grid, ".card", tile + 40);
  const win = useWindowed({ scroller, count: entries.length, columns: layout.cols, rowHeight: cardH + layout.gap, offset: layout.top });

  const { reveal } = win;
  useEffect(() => {
    const [first] = selected;
    if (first === undefined) return;
    reveal(entries.findIndex((e) => e.key === first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, reveal]);

  return (
    <div
      className="grid-scroll"
      ref={scroller}
      tabIndex={0}
      onKeyDown={(ev) => {
        const cols = columns();
        const map: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
        if (ev.key in map) {
          ev.preventDefault();
          onMove(map[ev.key], ev.shiftKey);
        }
      }}
      onMouseDown={(ev) => {
        const t = ev.target as HTMLElement;
        if (t === scroller.current || t === grid.current) onClearSelection();
      }}
    >
      {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden="true" />}
      <div
        className="grid"
        ref={grid}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))` }}
      >
        {entries.slice(win.start, win.end).map((e) => {
          const rel = e.key.slice(prefix.length);
          return (
            <Card
              key={e.key}
              entry={e}
              selected={selected.has(e.key)}
              profileId={profileId}
              bucket={bucket}
              label={searchMode ? rel : e.name}
              onPress={onPress}
              onOpen={onOpen}
              onContext={onContext}
            />
          );
        })}
      </div>
      {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden="true" />}
      {entries.length === 0 && !loading && <EmptyState searchMode={searchMode} action={emptyAction} />}
      {loading && entries.length === 0 && (
        <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))` }} aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="card">
              <div className="skel skel-card" style={{ alignSelf: "stretch" }} />
            </div>
          ))}
        </div>
      )}
      {loading && entries.length > 0 && (
        <div className="loading-row">
          <span className="spinner" /> Loading more…
        </div>
      )}
      {hasMore && <div ref={sentinel} className="sentinel" />}
    </div>
  );
}
