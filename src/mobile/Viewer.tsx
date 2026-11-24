/**
 * Full-screen photo and video viewer: swipe between the folder's media, pinch or double-tap to
 * zoom, drag down to close, tap to hide the controls.
 *
 * A photo shows its small thumbnail at once and the original when it arrives. Neighbours are
 * preloaded so swiping is instant, but on mobile data only their thumbnails are (originals can
 * be 10-25 MB each). Only the photo or video on screen has a player: a video swiped away stops
 * and lets go of its stream.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errMessage, errSummary } from "../api";
import { Icon } from "../Icons";
import { classify, formatBytes, isPlayableVideo } from "../format";
import { canThumb, cachedThumb, loadThumb } from "../thumbs";
import { playableUrl } from "../media";
import type { Entry } from "../types";
import { MIcon, type MIconName } from "./icons";
import { releaseOnUnmount } from "../releaseMedia";
import { videoErrorStep } from "./viewerRetry";

type Props = {
  items: Entry[];
  index: number;
  profileId: string;
  bucket: string;
  /** not known to be on Wi-Fi: preload only the neighbours' thumbnails, not their originals */
  lowData: boolean;
  /** Save to Photos is offered (phones) */
  photos: boolean;
  /** the network is up: originals that failed are asked again when it comes back */
  online: boolean;
  /** the folder has pages not loaded yet: asked for as the last loaded photos come up */
  more: boolean;
  onNearEnd: () => void;
  onIndex: (i: number) => void;
  onClose: () => void;
  onInfo: (e: Entry) => void;
  onShare: (e: Entry) => void;
  onDownload: (e: Entry) => void;
  onSaveToPhotos: (e: Entry) => void;
  onOpenIn: (e: Entry) => void;
  onDelete: (e: Entry) => void;
};

const isVideo = (e: Entry) => classify(e.name) === "video";
/** the strip along the bottom of a video where its own controls sit */
const VIDEO_CONTROLS_PX = 76;

export function Viewer({ items, index, profileId, bucket, lowData, photos, online, more, onNearEnd, onIndex, onClose, onInfo, onShare, onDownload, onSaveToPhotos, onOpenIn, onDelete }: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  /** bumped by Retry and when the network comes back: originals that failed are asked again */
  const [retryTick, setRetryTick] = useState(0);
  /** videos the web view couldn't play, even after asking again */
  const [unplayable, setUnplayable] = useState<Record<string, boolean>>({});
  /** how often each video failed to play: a first failure may be the network or an expired link */
  const videoErrors = useRef<Record<string, number>>({});
  /** originals that finished loading (their thumbnail can go) */
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [chrome, setChrome] = useState(true);
  // gesture state: horizontal paging offset, vertical dismiss offset, zoom
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [anim, setAnim] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const cur = items[index];
  // the slide animation ends in a timer: closed meanwhile (dragged down, back), it must not move
  // the viewer to another photo, which would open it again
  const pageTimer = useRef<number | undefined>(undefined);
  const closed = useRef(false);
  useEffect(
    () => () => {
      closed.current = true;
      window.clearTimeout(pageTimer.current);
    },
    [],
  );
  const close = () => {
    closed.current = true;
    window.clearTimeout(pageTimer.current);
    onClose();
  };

  // thumbnails first (small and often cached), for the current item and both neighbours
  useEffect(() => {
    let live = true;
    for (const i of [index, index + 1, index - 1]) {
      const e = items[i];
      if (!e || isVideo(e) || thumbs[e.key] || !canThumb(e)) continue;
      const known = cachedThumb(profileId, bucket, e);
      if (known) {
        setThumbs((m) => ({ ...m, [e.key]: known }));
        continue;
      }
      if (known === null) continue;
      loadThumb(profileId, bucket, e, () => live).then((u) => live && u && setThumbs((m) => ({ ...m, [e.key]: u })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items, profileId, bucket]);

  // originals: the current item always, neighbours too unless on mobile data
  useEffect(() => {
    let live = true;
    const want = lowData ? [index] : [index, index + 1, index - 1];
    for (const i of want) {
      const e = items[i];
      if (!e || urls[e.key] || failed[e.key]) continue;
      if (isVideo(e) && !isPlayableVideo(e.name)) continue;
      playableUrl(profileId, bucket, e)
        .then((u) => live && setUrls((m) => ({ ...m, [e.key]: u })))
        .catch((err) => live && setFailed((m) => ({ ...m, [e.key]: errSummary(errMessage(err)) })));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items, profileId, bucket, lowData, retryTick]);

  const failedRef = useRef(failed);
  failedRef.current = failed;
  const unplayableRef = useRef(unplayable);
  unplayableRef.current = unplayable;
  /** Asks for originals that failed again (`key`, or all of them), with a fresh link. */
  const retry = useCallback((key?: string) => {
    const keys = key === undefined ? [...Object.keys(failedRef.current), ...Object.keys(unplayableRef.current)] : [key];
    if (!keys.length) return;
    const drop = <T,>(m: Record<string, T>) => {
      const rest = { ...m };
      for (const k of keys) delete rest[k];
      return rest;
    };
    setFailed(drop);
    setUrls(drop);
    setReady(drop);
    setUnplayable(drop);
    setRetryTick((t) => t + 1);
  }, []);
  // a failure while offline (a tunnel, a lift) is over when the network is back
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) retry();
    wasOnline.current = online;
  }, [online, retry]);

  // near the end of what is loaded: the folder's next page, so swiping goes on
  const nearEnd = useRef(onNearEnd);
  nearEnd.current = onNearEnd;
  useEffect(() => {
    if (more && index >= items.length - 3) nearEnd.current();
  }, [more, index, items]);

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
      window.clearTimeout(pageTimer.current);
      pageTimer.current = window.setTimeout(() => {
        if (closed.current) return;
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
    /** started on a video: a tap belongs to the video's own controls */
    onVideo: boolean;
    zoom0: { s: number; x: number; y: number };
    dist0: number;
    mid0: { x: number; y: number };
  }>({ mode: "none", sx: 0, sy: 0, t: 0, moved: false, onVideo: false, zoom0: { s: 1, x: 0, y: 0 }, dist0: 1, mid0: { x: 0, y: 0 } });
  const lastTap = useRef(0);
  const tapTimer = useRef<number | undefined>(undefined);

  const center = () => {
    const r = stage.current!.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };

  const onDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // buttons inside a slide (the "Open in…" fallback) work as buttons
    if (target.closest("button")) return;
    const video = target.closest("video");
    if (video) {
      // the scrub bar and play button live along the bottom: leave those touches to the video
      const r = video.getBoundingClientRect();
      if (e.clientY > r.bottom - VIDEO_CONTROLS_PX) return;
    }
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
    s.onVideo = !!video;
    s.zoom0 = zoom;
  };

  const onMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    if (s.mode === "pinch" && pts.current.size >= 2) {
      if (s.onVideo) return;
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
      // a tap on a video shows its own controls; the viewer's bars follow along
      if (s.onVideo) {
        setChrome(true);
        return;
      }
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
      if (my > 130 || (my > 40 && my / dt > 0.5)) close();
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
    const thumb = thumbs[e.key];
    const here = offset === 0;
    const t = here
      ? `translate3d(${dx + zoom.x}px, ${dy + zoom.y}px, 0) scale(${zoom.s * (1 - Math.min(dy, 400) / 1600)})`
      : `translate3d(calc(${offset * 100}% + ${offset * 16}px + ${dx}px), 0, 0)`;
    const cantPlay = isVideo(e) && (!isPlayableVideo(e.name) || unplayable[e.key]);
    const videoFailed = () => {
      const n = (videoErrors.current[e.key] ?? 0) + 1;
      videoErrors.current[e.key] = n;
      if (videoErrorStep(n) === "fallback") setUnplayable((m) => ({ ...m, [e.key]: true }));
      else setFailed((m) => ({ ...m, [e.key]: "This video couldn’t be loaded." }));
    };
    return (
      <div key={e.key} className={`m-vslide ${anim ? "anim" : ""}`} style={{ transform: t }}>
        {failed[e.key] ? (
          <>
            {/* the thumbnail already on screen stays, under the note */}
            {thumb && <img className="m-vthumb" src={thumb} alt="" draggable={false} />}
            <div className={`m-verror ${thumb ? "on-thumb" : ""}`}>
              <Icon name="alert" size={26} />
              <span>{failed[e.key]}</span>
              <button className="btn btn-sm" onClick={() => retry(e.key)}>
                <Icon name="retry" size={14} /> Try again
              </button>
              {isVideo(e) && (
                <button className="btn btn-sm" onClick={() => onOpenIn(e)}>
                  <MIcon name="open" size={14} /> Open in…
                </button>
              )}
            </div>
          </>
        ) : cantPlay ? (
          <div className="m-verror m-vfallback">
            <Icon name="video" size={30} />
            <strong>Can't play this video here</strong>
            <span>Open it in another app on your phone.</span>
            <button className="btn btn-primary" onClick={() => onOpenIn(e)}>
              <MIcon name="open" size={15} /> Open in…
            </button>
            {unplayable[e.key] && (
              <button className="btn btn-sm" onClick={() => retry(e.key)}>
                <Icon name="retry" size={14} /> Try again
              </button>
            )}
          </div>
        ) : isVideo(e) ? (
          here && url ? (
            <video
              ref={releaseOnUnmount}
              src={url}
              controls
              playsInline
              preload="metadata"
              // a dropped connection or an expired link looks the same as a format the web view
              // can't play: the first failure offers Try again (a fresh link), a repeat the other app
              onError={videoFailed}
            />
          ) : here ? (
            <span className="spinner" />
          ) : (
            <span className="m-vplay" aria-hidden="true">
              <Icon name="play" size={30} />
            </span>
          )
        ) : (
          <>
            {thumb && !ready[e.key] && <img className="m-vthumb" src={thumb} alt="" draggable={false} />}
            {url && (
              <img
                ref={releaseOnUnmount}
                className="m-vfull"
                src={url}
                alt={e.name}
                draggable={false}
                onLoad={() => setReady((m) => ({ ...m, [e.key]: true }))}
                // the connection dropped mid-way, the link went stale, or it isn't drawable (damaged,
                // a format the phone can't show): Try again sorts out the first two
                onError={() => setFailed((m) => ({ ...m, [e.key]: "This photo couldn’t be loaded." }))}
              />
            )}
            {!url && !thumb && <span className="spinner m-vspin" />}
          </>
        )}
      </div>
    );
  };

  return (
    <div className={`m-viewer ${chrome ? "" : "bare"}`} role="dialog" aria-modal="true" aria-label="Photo viewer" style={{ background: `rgba(0,0,0,${fade})` }}>
      <div ref={stage} className="m-vstage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {slide(items[index - 1], -1)}
        {slide(cur, 0)}
        {slide(items[index + 1], 1)}
      </div>

      {/* swiping isn't there for VoiceOver and TalkBack: buttons, seen only once focused */}
      {index > 0 && (
        <button className="m-vstep prev" onClick={() => page(-1)} aria-label={`Previous: ${items[index - 1].name}`}>
          <Icon name="chevron" size={20} />
        </button>
      )}
      {index < items.length - 1 && (
        <button className="m-vstep next" onClick={() => page(1)} aria-label={`Next: ${items[index + 1].name}`}>
          <Icon name="chevron" size={20} />
        </button>
      )}

      <header className="m-vbar" style={{ opacity: chrome ? fade : 0 }}>
        <button className="m-icon" onClick={close} aria-label="Close">
          <Icon name="arrow-left" size={22} />
        </button>
        <div className="m-title">
          <h1>{cur.name}</h1>
          <p>
            {index + 1} of {items.length.toLocaleString()}
            {more ? "+" : ""} · {formatBytes(cur.size)}
          </p>
        </div>
      </header>

      <nav className="m-vtools" style={{ opacity: chrome ? fade : 0 }}>
        <Tool icon="share" label="Share" onClick={() => onShare(cur)} />
        {photos && <Tool icon="photos" label="Save to Photos" onClick={() => onSaveToPhotos(cur)} />}
        <Tool icon="download" label="Download" onClick={() => onDownload(cur)} />
        <Tool icon="info" label="Info" onClick={() => onInfo(cur)} />
        <Tool icon="trash" label="Delete" onClick={() => onDelete(cur)} />
      </nav>
    </div>
  );
}

function Tool({ icon, label, aria, onClick }: { icon: MIconName; label: string; aria?: string; onClick: () => void }) {
  return (
    <button className="m-vtool" onClick={onClick} aria-label={aria}>
      <MIcon name={icon} size={22} />
      <span>{label}</span>
    </button>
  );
}
