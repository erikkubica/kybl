/**
 * Full-screen photo and video viewer: swipe between the folder's media, pinch or double-tap to
 * zoom, drag down to close, tap to hide the controls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMessage } from "../api";
import { Icon, type IconName } from "../Icons";
import { classify, formatBytes } from "../format";
import { cachedThumb } from "../thumbs";
import type { Entry } from "../types";

type Props = {
  items: Entry[];
  index: number;
  profileId: string;
  bucket: string;
  onIndex: (i: number) => void;
  onClose: () => void;
  onInfo: (e: Entry) => void;
  onShare: (e: Entry) => void;
  onDownload: (e: Entry) => void;
  onDelete: (e: Entry) => void;
};

const isVideo = (e: Entry) => classify(e.name) === "video";

export function Viewer({ items, index, profileId, bucket, onIndex, onClose, onInfo, onShare, onDownload, onDelete }: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [chrome, setChrome] = useState(true);
  // gesture state: horizontal paging offset, vertical dismiss offset, zoom
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [anim, setAnim] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const cur = items[index];

  // presign the current item and its neighbours
  useEffect(() => {
    let live = true;
    for (const i of [index, index + 1, index - 1]) {
      const e = items[i];
      if (!e || urls[e.key] || failed[e.key]) continue;
      api
        .presign(profileId, bucket, e.key, 3600)
        .then((u) => live && setUrls((m) => ({ ...m, [e.key]: u })))
        .catch((err) => live && setFailed((m) => ({ ...m, [e.key]: errMessage(err) })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items, profileId, bucket]);

  const resetZoom = () => setZoom({ s: 1, x: 0, y: 0 });

  const page = useCallback(
    (dir: 1 | -1) => {
      const next = index + dir;
      const w = stage.current?.clientWidth ?? window.innerWidth;
      if (!items[next]) {
        setAnim(true);
        setDx(0);
        return;
      }
      setAnim(true);
      setDx(-dir * w);
      window.setTimeout(() => {
        setAnim(false);
        setDx(0);
        resetZoom();
        onIndex(next);
      }, 240);
    },
    [index, items, onIndex],
  );

  // ---------------------------------------------------------------- gestures
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef<{
    mode: "none" | "page" | "dismiss" | "pan" | "pinch";
    sx: number;
    sy: number;
    t: number;
    moved: boolean;
    zoom0: { s: number; x: number; y: number };
    dist0: number;
    mid0: { x: number; y: number };
  }>({ mode: "none", sx: 0, sy: 0, t: 0, moved: false, zoom0: { s: 1, x: 0, y: 0 }, dist0: 1, mid0: { x: 0, y: 0 } });
  const lastTap = useRef(0);
  const tapTimer = useRef<number | undefined>(undefined);

  const center = () => {
    const r = stage.current!.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setAnim(false);
    const s = g.current;
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      s.mode = "pinch";
      s.dist0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      s.mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      s.zoom0 = zoom;
      s.moved = true;
      setDx(0);
      setDy(0);
      return;
    }
    s.mode = "none";
    s.sx = e.clientX;
    s.sy = e.clientY;
    s.t = performance.now();
    s.moved = false;
    s.zoom0 = zoom;
  };

  const onMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    if (s.mode === "pinch" && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ns = Math.min(5, Math.max(1, (s.zoom0.s * dist) / s.dist0));
      const { cx, cy } = center();
      // keep the point under the fingers where it was
      const k = ns / s.zoom0.s;
      const x = mid.x - cx - (s.mid0.x - cx - s.zoom0.x) * k;
      const y = mid.y - cy - (s.mid0.y - cy - s.zoom0.y) * k;
      setZoom(ns === 1 ? { s: 1, x: 0, y: 0 } : { s: ns, x, y });
      return;
    }
    const mx = e.clientX - s.sx;
    const my = e.clientY - s.sy;
    if (!s.moved && Math.hypot(mx, my) < 8) return;
    s.moved = true;
    if (s.mode === "none") s.mode = zoom.s > 1 ? "pan" : Math.abs(mx) > Math.abs(my) ? "page" : my > 0 ? "dismiss" : "page";
    if (s.mode === "pan") setZoom({ ...s.zoom0, x: s.zoom0.x + mx, y: s.zoom0.y + my });
    else if (s.mode === "page") {
      // resist at the ends
      const edge = (mx > 0 && index === 0) || (mx < 0 && index === items.length - 1);
      setDx(edge ? mx / 3 : mx);
    } else if (s.mode === "dismiss") setDy(Math.max(0, my));
  };

  const onUp = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.delete(e.pointerId);
    const s = g.current;
    if (s.mode === "pinch") {
      if (pts.current.size === 1) {
        // carry on panning with the finger left on the screen
        const [p] = [...pts.current.values()];
        s.mode = "pan";
        s.sx = p.x;
        s.sy = p.y;
        s.zoom0 = zoom;
      } else s.mode = "none";
      if (zoom.s < 1.05) {
        setAnim(true);
        resetZoom();
      }
      return;
    }
    if (pts.current.size > 0) return;
    const dt = Math.max(1, performance.now() - s.t);
    const mx = e.clientX - s.sx;
    const my = e.clientY - s.sy;
    if (!s.moved) {
      // tap: double tap zooms, a single tap shows / hides the controls
      const now = performance.now();
      if (now - lastTap.current < 280) {
        window.clearTimeout(tapTimer.current);
        lastTap.current = 0;
        setAnim(true);
        if (zoom.s > 1) resetZoom();
        else {
          const { cx, cy } = center();
          const k = 2.5;
          setZoom({ s: k, x: -(e.clientX - cx) * (k - 1), y: -(e.clientY - cy) * (k - 1) });
        }
      } else {
        lastTap.current = now;
        tapTimer.current = window.setTimeout(() => setChrome((c) => !c), 280);
      }
      return;
    }
    if (s.mode === "page") {
      const w = stage.current?.clientWidth ?? window.innerWidth;
      const fast = Math.abs(mx) / dt > 0.45;
      if ((mx < -w * 0.2 || (fast && mx < -30)) && index < items.length - 1) page(1);
      else if ((mx > w * 0.2 || (fast && mx > 30)) && index > 0) page(-1);
      else {
        setAnim(true);
        setDx(0);
      }
    } else if (s.mode === "dismiss") {
      if (my > 130 || (my > 40 && my / dt > 0.5)) onClose();
      else {
        setAnim(true);
        setDy(0);
      }
    }
    s.mode = "none";
  };

  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  if (!cur) return null;
  const fade = Math.max(0, 1 - dy / 400);

  const slide = (e: Entry | undefined, offset: number) => {
    if (!e) return null;
    const url = urls[e.key];
    const thumb = cachedThumb(profileId, bucket, e);
    const here = offset === 0;
    const t = here
      ? `translate3d(${dx + zoom.x}px, ${dy + zoom.y}px, 0) scale(${zoom.s * (1 - Math.min(dy, 400) / 1600)})`
      : `translate3d(calc(${offset * 100}% + ${offset * 16}px + ${dx}px), 0, 0)`;
    return (
      <div key={e.key} className={`m-vslide ${anim ? "anim" : ""}`} style={{ transform: t }}>
        {failed[e.key] ? (
          <div className="m-verror">
            <Icon name="alert" size={26} />
            <span>{failed[e.key]}</span>
          </div>
        ) : isVideo(e) ? (
          url ? <video src={url} controls playsInline preload="metadata" /> : <span className="spinner" />
        ) : (
          <>
            {thumb && !url && <img className="m-vthumb" src={thumb} alt="" draggable={false} />}
            {url && <img src={url} alt={e.name} draggable={false} />}
            {!url && <span className="spinner m-vspin" />}
          </>
        )}
      </div>
    );
  };

  return (
    <div className={`m-viewer ${chrome ? "" : "bare"}`} style={{ background: `rgba(0,0,0,${fade})` }}>
      <div
        ref={stage}
        className="m-vstage"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {slide(items[index - 1], -1)}
        {slide(cur, 0)}
        {slide(items[index + 1], 1)}
      </div>

      <header className="m-vbar" style={{ opacity: chrome ? fade : 0 }}>
        <button className="m-icon" onClick={onClose} aria-label="Close">
          <Icon name="arrow-left" size={22} />
        </button>
        <div className="m-title">
          <h1>{cur.name}</h1>
          <p>
            {index + 1} of {items.length} · {formatBytes(cur.size)}
          </p>
        </div>
      </header>

      <nav className="m-vtools" style={{ opacity: chrome ? fade : 0 }}>
        <Tool icon="link" label="Share" onClick={() => onShare(cur)} />
        <Tool icon="download" label="Save" onClick={() => onDownload(cur)} />
        <Tool icon="info" label="Info" onClick={() => onInfo(cur)} />
        <Tool icon="trash" label="Delete" onClick={() => onDelete(cur)} />
      </nav>
    </div>
  );
}

function Tool({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button className="m-vtool" onClick={onClick}>
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </button>
  );
}
