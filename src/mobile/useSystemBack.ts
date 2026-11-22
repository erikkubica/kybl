/**
 * The system back (Android's button and gesture, the browser history elsewhere) steps back
 * inside the app while there is somewhere to go back to, and leaves the app at the root.
 */
import { useEffect, useRef, useState } from "react";

const ANDROID = /Android/i.test(navigator.userAgent);

/**
 * `back` closes the topmost thing (returns false at the root); `depth` counts what is open, so
 * a history entry is kept ahead exactly while there is something to close.
 */
export function useSystemBack(back: () => boolean, depth: number) {
  const backRef = useRef(back);
  backRef.current = back;
  // Keep exactly one history entry ahead while there is somewhere to go back to: the system back
  // pops it, and we step back in the app instead of leaving. At the root the entry is dropped so
  // the next back leaves the app as people expect.
  const armed = useRef(false);
  const skipPop = useRef(false);
  // Bumped on every handled back, so the entry is re-armed even when the depth stays the same
  // (going up one folder keeps depth at 1).
  const [popTick, setPopTick] = useState(0);
  useEffect(() => {
    // Android's back button calls this directly (MainActivity.kt), no history needed.
    if (ANDROID) {
      (window as unknown as { __kyblBack?: () => boolean }).__kyblBack = () => backRef.current();
      return;
    }
    if (depth > 0 && !armed.current) {
      history.pushState({ kybl: 1 }, "");
      armed.current = true;
    } else if (depth === 0 && armed.current) {
      armed.current = false;
      skipPop.current = true;
      history.back();
    }
  }, [depth, popTick]);
  useEffect(() => {
    const onPop = () => {
      if (skipPop.current) {
        skipPop.current = false;
        return;
      }
      armed.current = false;
      backRef.current();
      setPopTick((t) => t + 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return backRef;
}

/** iOS keyboard handling: the app is sized to the part above the keyboard, and the field being
 * typed in stays on screen. */
export function useKeyboardFit(ios: boolean) {
  // iOS keeps the layout viewport full height under the keyboard and scrolls the page instead,
  // pushing fixed sheets up under the status bar. Size the app to the visible part and keep the
  // page pinned, so everything sits above the keyboard as on Android.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !ios) return;
    // the tallest the view has been at this width is the height without a keyboard; some
    // WebViews shrink innerHeight along with the visual viewport, so it can't be the reference
    let full = 0;
    let width = 0;
    const fit = () => {
      if (vv.width !== width) {
        width = vv.width;
        full = 0;
      }
      full = Math.max(full, vv.height);
      document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      document.documentElement.classList.toggle("m-kb", vv.height < full - 80);
      if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [ios]);

  // When the keyboard opens the view shrinks; keep the field being typed in on screen.
  useEffect(() => {
    const reveal = () => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };
    let t: number | undefined;
    const later = () => {
      window.clearTimeout(t);
      t = window.setTimeout(reveal, 120);
    };
    // iOS doesn't resize the window for the keyboard, only the visual viewport
    const vv = window.visualViewport;
    window.addEventListener("resize", later);
    vv?.addEventListener("resize", later);
    document.addEventListener("focusin", later);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", later);
      vv?.removeEventListener("resize", later);
      document.removeEventListener("focusin", later);
    };
  }, []);
}
