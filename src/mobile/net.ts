/**
 * Network awareness on the phone: online / offline, whether the connection is metered (mobile
 * data), and the "Wi-Fi only" transfer setting that pauses list thumbnails on mobile data.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type TransferPrefs } from "../api";
import { setThumbsPaused } from "../thumbs";

type Conn = EventTarget & { type?: string; saveData?: boolean };
const conn = (): Conn | undefined => (navigator as Navigator & { connection?: Conn }).connection;

/**
 * True on mobile data. Android's web view reports the connection type; iOS's doesn't, so there
 * this is only true with Low Data Mode ("save data") on, and the backend enforces Wi-Fi only.
 */
export function isMetered(): boolean {
  const c = conn();
  return !!c && (c.type === "cellular" || c.saveData === true);
}

/**
 * True only on a network known not to cost anything (Wi-Fi, ethernet). iOS's web view doesn't say
 * what network it is on, so there this is false: unknown is treated like mobile data.
 */
export function isUnmetered(): boolean {
  const c = conn();
  return !!c && (c.type === "wifi" || c.type === "ethernet") && c.saveData !== true;
}

/** Errors that mean the request never reached the storage (no network, DNS, timeouts). */
export function isNetworkError(msg: string): boolean {
  return /dispatch failure|dns error|failed to lookup|connection (refused|reset|closed)|timed? ?out|network is unreachable|no route to host|offline|error sending request|io error/i.test(
    msg,
  );
}

export type NetState = { online: boolean; metered: boolean; unmetered: boolean };

/**
 * Online and metered, kept current. `onBack` runs when the network returns after a drop and when
 * the app comes back to the foreground, so lists can refresh.
 */
export function useNetwork(onBack: (why: "online" | "resumed") => void): NetState {
  const [state, setState] = useState<NetState>(() => ({ online: navigator.onLine !== false, metered: isMetered(), unmetered: isUnmetered() }));
  const cb = useRef(onBack);
  useEffect(() => {
    const read = () => setState({ online: navigator.onLine !== false, metered: isMetered(), unmetered: isUnmetered() });
    const online = () => {
      read();
      cb.current("online");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", read);
    conn()?.addEventListener("change", read);
    const off = listen("app-resumed", () => {
      read();
      cb.current("resumed");
    });
    // web views without the native event still report the page becoming visible again
    const vis = () => {
      if (document.visibilityState === "visible") cb.current("resumed");
    };
    if (!("__TAURI_INTERNALS__" in window)) document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", read);
      conn()?.removeEventListener("change", read);
      document.removeEventListener("visibilitychange", vis);
      off.then((f) => f()).catch(() => {});
    };
  }, []);
  cb.current = onBack;
  return state;
}

/** The transfer settings (Wi-Fi only), loaded once; null until known or where unsupported. */
export function useTransferPrefs(): [TransferPrefs | null, (p: Partial<TransferPrefs>) => Promise<void>] {
  const [prefs, setPrefs] = useState<TransferPrefs | null>(null);
  useEffect(() => {
    api.transferPrefs().then(setPrefs).catch(() => {});
  }, []);
  const prev = useRef<TransferPrefs | null>(null);
  prev.current = prefs;
  /** Shows the change at once; puts the switch back (and throws) if the backend refused it. */
  const save = async (p: Partial<TransferPrefs>) => {
    const before = prev.current;
    setPrefs((cur) => (cur ? { ...cur, ...p } : cur));
    try {
      setPrefs(await api.setTransferPrefs(p));
    } catch (e) {
      setPrefs(before);
      throw e;
    }
  };
  return [prefs, save];
}

/** Keeps list thumbnails off while on mobile data with "Wi-Fi only" on. */
export function syncThumbPause(prefs: TransferPrefs | null, net: NetState) {
  setThumbsPaused(!!prefs?.wifiOnly && net.metered);
}
