import { memo, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../Icons";
import { FileIcon } from "../components/FileIcon";
import { formatBytes, formatDate, parentPrefix } from "../format";
import { cachedThumb, canListThumb, loadThumb } from "../thumbs";
import type { Entry } from "../types";
import { whenNear } from "./thumbObserver";

/** Where the finger was when a long-press fired (to start drag-to-select from there). */
export type PressPoint = { x: number; y: number; pointerType: string };

/** Tap / long-press / move-cancels, for touch and mouse alike. */
export function usePress(onTap: () => void, onLongPress: (p: PressPoint) => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number; type: string } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY, type: e.pointerType };
      clear();
      timer.current = window.setTimeout(() => {
        const s = start.current;
        if (!s) return;
        fired.current = true;
        void api.haptic("medium");
        onLongPress({ x: s.x, y: s.y, pointerType: s.type });
      }, 450);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (s && !fired.current && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
        clear();
        start.current = null;
      }
    },
    onPointerUp: clear,
    onPointerCancel: () => {
      clear();
      start.current = null;
    },
    onClick: () => {
      if (fired.current) {
        fired.current = false;
        return;
      }
      onTap();
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

/** The thumbnail once the item is near the screen (undefined while unknown, null when there is none). */
function useThumb(entry: Entry, profileId: string, bucket: string) {
  const ok = canListThumb(entry);
  const [url, setUrl] = useState<string | null | undefined>(() => (ok ? cachedThumb(profileId, bucket, entry) : null));
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ok) {
      // thumbnails turned off (or paused on mobile data): keep one that already loaded
      setUrl((u) => u ?? cachedThumb(profileId, bucket, entry) ?? null);
      return;
    }
    if (url !== undefined && url !== null) return;
    const known = cachedThumb(profileId, bucket, entry);
    if (known !== undefined) {
      setUrl(known);
      return;
    }
    if (!ref.current) return;
    let live = true;
    const stop = whenNear(ref.current, () => {
      loadThumb(profileId, bucket, entry, () => live).then((u) => live && u !== undefined && setUrl(u));
    });
    return () => {
      live = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, profileId, bucket, entry.key, entry.etag]);
  return { ref, url, loading: ok && url === undefined };
}

/** Folder / page art like the desktop grid, or the photo itself on a small print. */
export function Art({ entry, profileId, bucket, className = "" }: { entry: Entry; profileId: string; bucket: string; className?: string }) {
  const { ref, url, loading } = useThumb(entry, profileId, bucket);
  return (
    <span ref={ref} className={`m-art ${className} ${url ? "has-img" : ""}`}>
      {url ? <img src={url} alt="" draggable={false} /> : <FileIcon entry={entry} big />}
      {loading && <span className="shimmer" />}
    </span>
  );
}

function Check({ on }: { on?: boolean }) {
  return <span className={`m-check ${on ? "on" : ""}`}>{on && <Icon name="check" size={13} />}</span>;
}

/** Stable handlers shared by every row; they get the entry and its index. */
export type RowHandlers = {
  tap: (e: Entry, index: number) => void;
  longPress: (e: Entry, index: number, p: PressPoint) => void;
  more: (e: Entry) => void;
};

type RowProps = {
  entry: Entry;
  index: number;
  profileId: string;
  bucket: string;
  /** search results: show the folder each match is in */
  showPath: boolean;
  selected: boolean;
  selecting: boolean;
  /** open in the side panel (tablets) */
  active: boolean;
  /** bumped when thumbnails are turned on or off, so rows re-check */
  thumbs: string;
  h: RowHandlers;
};

export const EntryRow = memo(function EntryRow({ entry, index, profileId, bucket, showPath, selected, selecting, active, h }: RowProps) {
  const press = usePress(
    () => h.tap(entry, index),
    (p) => h.longPress(entry, index, p),
  );
  const sub = showPath
    ? `${parentPrefix(entry.key) || "/"} · ${formatBytes(entry.size)}`
    : entry.kind === "folder"
      ? "Folder"
      : `${formatBytes(entry.size)} · ${formatDate(entry.modified)}`;
  return (
    <li className={`m-row ${selected ? "selected" : ""} ${active ? "active" : ""}`} data-idx={index}>
      <button className="m-row-main" {...press} aria-pressed={selecting ? selected : undefined}>
        {selecting && <Check on={selected} />}
        <Art entry={entry} profileId={profileId} bucket={bucket} />
        <span className="m-row-text">
          <span className="m-row-name">{entry.name}</span>
          <span className="m-row-sub">{sub}</span>
        </span>
      </button>
      {!selecting && (
        <button className="m-icon m-row-more" onClick={() => h.more(entry)} aria-label={`Actions for ${entry.name}`}>
          <Icon name="more" size={18} />
        </button>
      )}
    </li>
  );
});

/** Finder-style tile, the same shape as the desktop grid: art, name on up to two lines, size. */
export const EntryTile = memo(function EntryTile({ entry, index, profileId, bucket, selected, selecting, active, h }: RowProps) {
  const press = usePress(
    () => h.tap(entry, index),
    (p) => h.longPress(entry, index, p),
  );
  return (
    <div className="m-cell" data-idx={index}>
      <button className={`m-card ${selected ? "selected" : ""} ${active ? "active" : ""}`} {...press} aria-pressed={selecting ? selected : undefined}>
        <span className="m-card-art">
          <Art entry={entry} profileId={profileId} bucket={bucket} />
          {selecting && <Check on={selected} />}
        </span>
        <span className="m-card-label">
          <span className="m-card-name">{entry.name}</span>
        </span>
        <span className="m-card-meta">{entry.kind === "folder" ? " " : formatBytes(entry.size)}</span>
      </button>
    </div>
  );
});

export function SkeletonList() {
  return (
    <ul className="m-list" aria-hidden="true">
      {[62, 48, 74, 40, 56, 66, 44].map((w, i) => (
        <li key={i} className="m-row m-skel" style={{ opacity: 1 - i * 0.11 }}>
          <span className="m-art skel" />
          <span className="m-row-text">
            <span className="skel" style={{ width: `${w}%`, height: 12 }} />
            <span className="skel" style={{ width: `${w / 2}%`, height: 10, marginTop: 7 }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
