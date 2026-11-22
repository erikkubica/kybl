/**
 * App lock (Settings → Lock with Face ID / fingerprint): Kybl asks for Face ID, Touch ID, a
 * fingerprint or the phone's passcode when it starts and when it comes back after more than a
 * minute in the background. While locked nothing of the app is drawn: the file list, an open
 * document and any toasts are hidden (still there underneath, so unsaved edits survive), and
 * the privacy screen keeps the content out of the app switcher and screenshots.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { Mascot } from "./Mascot";

const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/** Away for longer than this locks the app again. */
const GRACE_MS = 60_000;

/** The setting's name in the words of each phone. */
export const LOCK_LABEL = IOS ? "Lock with Face ID" : "Lock with fingerprint";
export const LOCK_SUB = IOS
  ? "Kybl asks for Face ID, Touch ID or your passcode when you open it"
  : "Kybl asks for your fingerprint, face or screen lock when you open it";

/**
 * Whether the app is locked, and the unlock action. `enabled` is the setting: on at launch means
 * locked from the start; turning it off unlocks.
 */
export function useAppLock(enabled: boolean) {
  const [locked, setLocked] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const on = useRef(enabled);
  on.current = enabled;

  useEffect(() => {
    api.setPrivacyScreen(enabled).catch(() => {});
    if (!enabled) setLocked(false);
  }, [enabled]);

  // lock again after a minute away: the page notes when it was hidden, and the app's return
  // (the native `app-resumed`, or the page becoming visible where there is none) checks the time
  useEffect(() => {
    let hiddenAt: number | null = null;
    const back = () => {
      if (hiddenAt !== null && on.current && Date.now() - hiddenAt > GRACE_MS) setLocked(true);
      hiddenAt = null;
    };
    const vis = () => {
      // the unlock prompt itself sends the app to the background on some phones: not "away"
      if (document.visibilityState === "hidden") hiddenAt ??= busyRef.current ? null : Date.now();
      else back();
    };
    document.addEventListener("visibilitychange", vis);
    const off = listen("app-resumed", back);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      off.then((f) => f()).catch(() => {});
    };
  }, []);

  const unlock = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (await api.biometricUnlock("Unlock Kybl")) setLocked(false);
    } catch (e) {
      // most likely the phone's screen lock was turned off since
      setError(errSummary(errMessage(e)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { locked, unlock, error, busy };
}

/** The lock screen: Kyblík and an Unlock button. It asks once by itself when it appears. */
export function LockScreen({ unlock, error, busy }: { unlock: () => void; error: string | null; busy: boolean }) {
  // `unlock` is stable, so this runs once each time the lock screen appears
  useEffect(() => {
    // a moment for the screen to appear first, so the prompt doesn't flash over the splash
    const t = window.setTimeout(() => {
      if (document.visibilityState === "visible") unlock();
    }, 350);
    return () => window.clearTimeout(t);
  }, [unlock]);

  return (
    <section className="m-lock" role="dialog" aria-modal="true" aria-labelledby="m-lock-title">
      <Mascot size={104} />
      <h1 id="m-lock-title">Kybl is locked</h1>
      <p>{IOS ? "Use Face ID, Touch ID or your passcode to open it." : "Use your fingerprint, face or screen lock to open it."}</p>
      {error && (
        <p className="m-lock-err" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary m-big-btn" onClick={unlock} disabled={busy}>
        {busy ? <span className="spinner" /> : null}
        Unlock
      </button>
    </section>
  );
}
