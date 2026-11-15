import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icons";
import { FileIcon } from "../components/FileIcon";
import { formatBytes } from "../format";
import { cachedThumb, canListThumb, loadThumb } from "../thumbs";
import type { Entry } from "../types";

/** Tap / long-press / move-cancels, for touch and mouse alike. */
export function usePress(onTap: () => void, onLongPress: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(12);
        onLongPress();
      }, 450);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
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
    if (!ok || url !== undefined || !ref.current) return;
    let live = true;
    const io = new IntersectionObserver(
      (xs) => {
        if (xs.some((x) => x.isIntersecting)) {
          io.disconnect();
          loadThumb(profileId, bucket, entry, () => live).then((u) => live && setUrl(u ?? null));
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(ref.current);
    return () => {
      live = false;
      io.disconnect();
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

export function EntryRow({
  entry,
  profileId,
  bucket,
  sub,
  selected,
  selecting,
  active,
  onTap,
  onLongPress,
  onMore,
}: {
  entry: Entry;
  profileId: string;
  bucket: string;
  sub: string;
  selected?: boolean;
  selecting: boolean;
  /** open in the side panel (tablets) */
  active?: boolean;
  onTap: () => void;
  onLongPress: () => void;
  onMore: () => void;
}) {
  const press = usePress(onTap, onLongPress);
  return (
    <li className={`m-row ${selected ? "selected" : ""} ${active ? "active" : ""}`}>
      <button className="m-row-main" {...press}>
        {selecting && <Check on={selected} />}
        <Art entry={entry} profileId={profileId} bucket={bucket} />
        <span className="m-row-text">
          <span className="m-row-name">{entry.name}</span>
          <span className="m-row-sub">{sub}</span>
        </span>
      </button>
      {!selecting && (
        <button className="m-icon m-row-more" onClick={onMore} aria-label={`Actions for ${entry.name}`}>
          <Icon name="more" size={18} />
        </button>
      )}
    </li>
  );
}

/** Finder-style tile, the same shape as the desktop grid: art, name on up to two lines, size. */
export function EntryTile({
  entry,
  profileId,
  bucket,
  selected,
  selecting,
  active,
  onTap,
  onLongPress,
}: {
  entry: Entry;
  profileId: string;
  bucket: string;
  selected?: boolean;
  selecting: boolean;
  active?: boolean;
  onTap: () => void;
  onLongPress: () => void;
}) {
  const press = usePress(onTap, onLongPress);
  return (
    <button className={`m-card ${selected ? "selected" : ""} ${active ? "active" : ""}`} {...press}>
      <span className="m-card-art">
        <Art entry={entry} profileId={profileId} bucket={bucket} />
        {selecting && <Check on={selected} />}
      </span>
      <span className="m-card-name">{entry.name}</span>
      <span className="m-card-meta">{entry.kind === "folder" ? " " : formatBytes(entry.size)}</span>
    </button>
  );
}

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
