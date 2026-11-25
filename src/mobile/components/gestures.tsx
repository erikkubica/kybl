/**
 * Touch gestures the web views don't give us: pull-to-refresh on a list, and the iPhone's swipe
 * from the left edge to go back. Both are plain touch events, so they behave the same in
 * WKWebView and Android's WebView.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../core/api";
import { Mascot } from "./Mascot";

const PULL_TRIGGER = 72;
const PULL_MAX = 120;
/** where the list rests while it refreshes */
const PULL_HOLD = 56;

/** Rubber band: the further you pull, the less it follows. */
const resist = (d: number) => PULL_MAX * (1 - Math.exp(-d / (PULL_MAX * 1.6)));

/**
 * Pull down at the top of `el` to refresh. Returns how far the list is pulled (to move the page
 * and draw the indicator) and whether the refresh is running.
 */
export function usePullToRefresh(el: HTMLElement | null, onRefresh: () => Promise<unknown> | void, enabled: boolean) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const run = useRef(onRefresh);
  run.current = onRefresh;
  const busyRef = useRef(false);

  useEffect(() => {
    if (!el || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let active = false;
    let armed = false;
    let dist = 0;
    // the move listener can stop scrolling, which makes the web view wait for it on every move:
    // it is only attached while a touch that started at the very top (where a pull can begin) lasts
    let tracking = false;
    const track = (on: boolean) => {
      if (on === tracking) return;
      tracking = on;
      if (on) el.addEventListener("touchmove", tm, { passive: false });
      else el.removeEventListener("touchmove", tm);
    };
    const ts = (e: TouchEvent) => {
      active = false;
      start = e.touches.length === 1 && el.scrollTop <= 0 && !busyRef.current ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      track(!!start);
    };
    const tm = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (!active) {
        if (dy > 8 && dy > Math.abs(dx) * 1.4 && el.scrollTop <= 0) active = true;
        else {
          if (dy < -4 || Math.abs(dx) > 12) start = null;
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      dist = resist(Math.max(0, dy - 8));
      if (!armed && dist >= PULL_TRIGGER) {
        armed = true;
        void api.haptic("selection");
      } else if (armed && dist < PULL_TRIGGER) armed = false;
      setPull(dist);
    };
    const te = () => {
      track(false);
      if (!start || !active) {
        start = null;
        return;
      }
      start = null;
      active = false;
      if (dist >= PULL_TRIGGER) {
        armed = false;
        busyRef.current = true;
        setBusy(true);
        setPull(PULL_HOLD);
        void api.haptic("medium");
        Promise.resolve(run.current())
          .catch(() => {})
          .finally(() => {
            busyRef.current = false;
            setBusy(false);
            setPull(0);
          });
      } else setPull(0);
      dist = 0;
    };
    el.addEventListener("touchstart", ts, { passive: true });
    el.addEventListener("touchend", te);
    el.addEventListener("touchcancel", te);
    return () => {
      el.removeEventListener("touchstart", ts);
      track(false);
      el.removeEventListener("touchend", te);
      el.removeEventListener("touchcancel", te);
    };
  }, [el, enabled]);

  return { pull, busy };
}

/** Kyblík drops in from the bar as the list is pulled, and wobbles while it refreshes. */
export function PullIndicator({ pull, busy }: { pull: number; busy: boolean }) {
  if (!pull && !busy) return null;
  const k = Math.min(1, pull / PULL_TRIGGER);
  return (
    <div
      className={`m-ptr ${busy ? "busy" : ""} ${k >= 1 ? "ready" : ""}`}
      style={{ transform: `translate(-50%, ${pull - 44}px)`, opacity: Math.min(1, k * 1.4) }}
      role={busy ? "status" : undefined}
      aria-label={busy ? "Refreshing" : undefined}
    >
      <span style={{ transform: busy ? undefined : `rotate(${(k - 1) * 30}deg) scale(${0.7 + k * 0.3})` }}>
        <Mascot size={34} />
      </span>
    </div>
  );
}

export type SwipeTarget = { el: HTMLElement; overlay: boolean };

/**
 * Swipe right from the left edge to go back, like the iPhone's own apps. The screen on top
 * follows the finger; letting go past a third of the width (or with a quick flick) goes back.
 * `target` finds the element to move (the caller's layer stack knows what is on top).
 */
export function useEdgeSwipe(supported: boolean, enabled: boolean, onBack: () => void, target: () => SwipeTarget | null) {
  const back = useRef(onBack);
  back.current = onBack;
  const on = useRef(enabled);
  on.current = enabled;
  const find = useRef(target);
  find.current = target;

  useEffect(() => {
    // Android has its own back gesture; without this a non-passive listener would slow its scrolling
    if (!supported) return;
    const EDGE = 22;
    let s: { x: number; y: number; t: number; el: HTMLElement; overlay: boolean; going: boolean } | null = null;
    // a move listener that can stop scrolling slows every scroll down: it is only attached while
    // a touch that started at the edge lasts
    let tracking = false;
    const track = (on: boolean) => {
      if (on === tracking) return;
      tracking = on;
      if (on) document.addEventListener("touchmove", tm, { passive: false });
      else document.removeEventListener("touchmove", tm);
    };
    const reset = (el: HTMLElement) => {
      el.style.removeProperty("transition");
      el.style.transform = "";
      el.style.boxShadow = "";
    };
    const ts = (e: TouchEvent) => {
      s = null;
      if (!on.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;
      const target = find.current();
      if (!target) return;
      s = { x: t.clientX, y: t.clientY, t: performance.now(), ...target, going: false };
      track(true);
    };
    const tm = (e: TouchEvent) => {
      if (!s) return;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (!s.going) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > dx) {
          s = null;
          return;
        }
        if (dx < 10) return;
        s.going = true;
        s.el.style.setProperty("transition", "none", "important");
      }
      if (e.cancelable) e.preventDefault();
      const x = Math.max(0, dx);
      s.el.style.transform = `translate3d(${x}px, 0, 0)`;
      if (s.overlay) s.el.style.boxShadow = "-12px 0 32px rgba(0,0,0,0.18)";
      else s.el.style.opacity = String(1 - Math.min(0.6, x / window.innerWidth));
    };
    const te = (e: TouchEvent) => {
      track(false);
      const g = s;
      s = null;
      if (!g || !g.going) return;
      const dx = (e.changedTouches[0]?.clientX ?? g.x) - g.x;
      const v = dx / Math.max(1, performance.now() - g.t);
      const w = window.innerWidth;
      const go = dx > w * 0.33 || (v > 0.5 && dx > 40);
      g.el.style.setProperty("transition", "transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s", "important");
      if (go) {
        g.el.style.transform = `translate3d(${w}px, 0, 0)`;
        void api.haptic("light");
        window.setTimeout(
          () => {
            back.current();
            // a page that stays (closing a selection, say) slides back into place
            if (!g.overlay) {
              reset(g.el);
              g.el.style.opacity = "";
            }
            // a screen whose back asked first (unsaved changes, "Don't upload?") or only went up a
            // folder is still there once the app has drawn: it slides back instead of jumping back
            window.setTimeout(() => {
              if (g.overlay && g.el.isConnected && !g.el.closest(".m-leaving")) g.el.style.transform = "translate3d(0, 0, 0)";
            }, 60);
            window.setTimeout(() => {
              reset(g.el);
            }, 400);
          },
          g.overlay ? 160 : 90,
        );
      } else {
        g.el.style.transform = "translate3d(0, 0, 0)";
        g.el.style.opacity = "";
        window.setTimeout(() => {
          reset(g.el);
        }, 240);
      }
    };
    document.addEventListener("touchstart", ts, { passive: true });
    document.addEventListener("touchend", te);
    document.addEventListener("touchcancel", te);
    return () => {
      document.removeEventListener("touchstart", ts);
      track(false);
      document.removeEventListener("touchend", te);
      document.removeEventListener("touchcancel", te);
    };
  }, [supported]);
}
