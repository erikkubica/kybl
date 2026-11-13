import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { applySettings, loadSettings } from "./settings";

// before first paint, so the window never flashes the wrong theme
applySettings(loadSettings());

async function boot() {
  // Plain `pnpm dev` in a browser has no Rust backend: fall back to demo data.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./devMock");
  }
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

boot();
