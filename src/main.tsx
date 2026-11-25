import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/fredoka/latin-700.css";
import "./styles.css";
import { applySettings, loadSettings } from "./settings/settings";
import { api } from "./core/api";
import { setTrustTag } from "./connections/lib/kinds";

// before first paint, so the window never flashes the wrong theme
applySettings(loadSettings());

// Android's WebView reports 0 for env(safe-area-inset-*); MainActivity.kt hands us the real
// system-bar insets instead, as CSS variables the mobile stylesheet prefers.
type Insets = { top: number; bottom: number; left: number; right: number };
const androidInsets = (window as unknown as { KyblInsets?: { insets(): string } }).KyblInsets;
if (androidInsets) {
  const set = (i: Insets) => {
    const root = document.documentElement.style;
    for (const side of ["top", "bottom", "left", "right"] as const) root.setProperty(`--a-${side}`, `${i[side]}px`);
  };
  (window as unknown as { __kyblInsets: (i: Insets) => void }).__kyblInsets = set;
  try {
    set(JSON.parse(androidInsets.insets()));
  } catch {
    /* keep the env() fallback */
  }
}

// Status bar and other system chrome follow the theme picked in Settings ("System" = the OS).
if (androidInsets || /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  let last = "";
  const sync = () => {
    const theme = loadSettings().theme;
    const dark = theme === "system" ? null : theme === "dark";
    const key = String(dark);
    if (key === last) return;
    last = key;
    const bridge = androidInsets as unknown as { setDark?: (d: string | null) => void } | undefined;
    if (bridge?.setDark) bridge.setDark(dark === null ? null : String(dark));
    else if ("__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/core").then(({ invoke }) => invoke("native_theme", { dark }).catch(() => {}));
    }
  };
  sync();
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

async function boot() {
  // Plain `pnpm dev` in a browser has no Rust backend: fall back to demo data.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/devMock");
  }
  // the tag that marks Kybl's own trust questions (a host key, a certificate, plain FTP), before
  // any error can ask one
  // A failed read is tried again a few times in the background, so a trust question asked later
  // still gets its button (until then, a connection that needs one shows its error)
  const readTag = async (left: number): Promise<void> => {
    try {
      setTrustTag(await api.trustTag());
    } catch {
      if (left > 0) setTimeout(() => void readTag(left - 1), (6 - left) * 2000);
    }
  };
  await readTag(5);
  // Phones get their own touch UI over the same backend. `?mobile` forces it in a desktop browser.
  const phone =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || new URLSearchParams(location.search).has("mobile");
  const { default: App } = phone ? await import("./mobile/MobileApp") : await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

boot();
