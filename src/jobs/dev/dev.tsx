/**
 * A tiny page to look at the jobs UI in a browser with the mock backend:
 * `pnpm exec vite --port 1455` and open /src/jobs/dev/dev.html (add `?mobile` for the phone look).
 * Not part of the app build (vite only builds index.html).
 */
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "../../styles.css";
import { applySettings, loadSettings } from "../../settings/settings";
import { JobsPanel, MigrationDialog, startMigrations, useActiveJobCount, type MigrationSource } from "..";

const SEG = { width: "auto", padding: "0 12px" };
const mobile = new URLSearchParams(location.search).has("mobile");

const SAMPLES: Record<string, MigrationSource> = {
  selection: {
    profileId: "p1",
    root: "media-prod",
    items: [
      { path: "photos/", isDir: true },
      { path: "documents/", isDir: true },
      { path: "hero-banner.jpg", isDir: false, size: 2_400_000 },
    ],
  },
  everything: { profileId: "p1", root: "media-prod", items: [{ path: "", isDir: true }] },
  local: { profileId: "local", root: "/Users/demo", items: [{ path: "Pictures/", isDir: true }] },
};

function Harness() {
  const [theme, setTheme] = useState(() => loadSettings().theme);
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const active = useActiveJobCount();
  const switchTheme = (t: typeof theme) => {
    setTheme(t);
    applySettings({ ...loadSettings(), theme: t });
  };
  return (
    <div className={mobile ? "m-app" : ""} style={{ padding: 20, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <strong style={{ marginRight: 8 }}>Jobs harness</strong>
        <div className="seg">
          {(["light", "dark"] as const).map((t) => (
            <button key={t} style={SEG} className={theme === t ? "on" : ""} onClick={() => switchTheme(t)}>
              {t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
        <div className="seg">
          {(["copy", "move"] as const).map((m) => (
            <button key={m} style={SEG} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
        {Object.keys(SAMPLES).map((k) => (
          <button key={k} className="btn" onClick={() => setOpen(k)}>
            Open dialog: {k}
          </button>
        ))}
        <span className="pill accent">{active} active</span>
      </div>
      <div style={{ maxWidth: 760, border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel)", padding: 6 }}>
        <JobsPanel variant={mobile ? "mobile" : "desktop"} onOpenDest={(j) => alert(`Open ${j.spec.dst.profileId} / ${j.spec.dst.root} / ${j.spec.dst.dir}`)} />
      </div>
      {open && <MigrationDialog source={SAMPLES[open]} initialMode={mode} onClose={() => setOpen(null)} onStarted={(id) => console.log("started", id)} />}
    </div>
  );
}

async function boot() {
  applySettings(loadSettings());
  if (!("__TAURI_INTERNALS__" in window)) await import("../../dev/devMock");
  if (mobile) await import("../../mobile/components/mobile.css");
  startMigrations();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Harness />
    </React.StrictMode>,
  );
}

boot();
