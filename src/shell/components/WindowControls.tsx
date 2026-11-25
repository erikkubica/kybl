/**
 * Windows draws no title bar for Kybl (app/tray.rs turns it off): the workspace bar is the title
 * bar, and these are its minimize, maximize / restore and close, drawn like the system's (46px
 * wide, the bar's full height, close turning red). Nothing on macOS and Linux, where the system
 * draws them.
 */
import { useEffect, useState } from "react";
import { OS } from "../../core/osNames";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (OS !== "win" || !inTauri) return;
    let gone = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const look = () => void w.isMaximized().then((m) => !gone && setMax(m), () => {});
      look();
      const un = await w.onResized(look);
      if (gone) un();
      else stop = un;
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  if (OS !== "win") return null;
  const run = (what: "minimize" | "toggleMaximize" | "close") => {
    if (!inTauri) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow()[what]()).catch(() => {});
  };
  return (
    <div className="win-controls">
      <button type="button" className="win-btn" onClick={() => run("minimize")} title="Minimize" aria-label="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button type="button" className="win-btn" onClick={() => run("toggleMaximize")} title={max ? "Restore down" : "Maximize"} aria-label={max ? "Restore down" : "Maximize"}>
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" />
            <rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button type="button" className="win-btn win-close" onClick={() => run("close")} title="Close" aria-label="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
