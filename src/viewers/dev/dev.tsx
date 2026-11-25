/**
 * Dev-only harness for the viewers, on the browser mock backend (devSamples.ts):
 * `pnpm exec vite --port 1448`, then open http://localhost:1448/src/viewers/dev/dev.html
 * (add `?dark` for the dark theme). Not part of any build.
 */
import { StrictMode, Suspense, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import "../../dev/devMock";
import { LazyDocumentView, canView, viewerFor } from "../lib/registry";
import type { DocumentHandle } from "../components/DocumentView";
import { remove, touch } from "./devSamples";
import type { Entry } from "../../core/types";

const KEYS: [string, number][] = [
  ["docs/notes.md", 900],
  ["config.json", 230],
  ["inventory.csv", 42_000],
  ["exports/big-export.csv", 11_000_000],
  ["src/app.ts", 260],
  ["deploy/compose.yml", 180],
  ["reports/report.docx", 9_000],
  ["finance/budget.xlsx", 400_000],
  ["slides/deck.pptx", 4_000],
  ["art/banner.svg", 700],
  ["logs/legacy.log", 30],
  ["readonly-bucket/notes.txt", 50],
  ["huge/video-notes.txt", 80_000_000],
  ["archive.zip", 1_000],
];

const entries: Entry[] = KEYS.map(([key, size]) => ({ kind: "file", key, name: key.slice(key.lastIndexOf("/") + 1), size, modified: Date.now() }));

function Harness() {
  const [sel, setSel] = useState<Entry>(entries[0]);
  const [full, setFull] = useState<Entry | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [dark, setDark] = useState(() => new URLSearchParams(location.search).has("dark"));
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const handle = useRef<DocumentHandle>(null);
  const say = (s: string) => setLog((l) => [s, ...l].slice(0, 6));

  // `?open=<key>`: only the full view, as on a phone screen
  const only = new URLSearchParams(location.search).get("open");
  if (only) {
    const e = entries.find((x) => x.key === only) ?? entries[0];
    return (
      <Suspense fallback={null}>
        <LazyDocumentView profileId="p1" bucket="media-prod" entry={e} mode="full" onClose={() => say("closed")} onOpenExternal={() => say("open externally")} />
      </Suspense>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", fontSize: 13 }}>
      <aside style={{ width: 230, borderRight: "1px solid var(--border)", background: "var(--sidebar)", padding: 8, overflow: "auto", flex: "none" }}>
        {entries.map((e) => {
          const v = viewerFor(e.name, null, e.size);
          return (
            <button
              key={e.key}
              className="btn btn-ghost"
              style={{ width: "100%", justifyContent: "space-between", color: sel === e ? "var(--accent)" : undefined }}
              onClick={() => setSel(e)}
              onDoubleClick={() => setFull(e)}
            >
              <span>{e.name}</span>
              <small style={{ color: "var(--faint)" }}>{v ? `${v.kind}${v.canEdit ? " ✎" : ""}${canView(e.name, e.size) ? "" : " ⤓"}` : "—"}</small>
            </button>
          );
        })}
        <hr style={{ border: 0, borderTop: "1px solid var(--border)" }} />
        <button className="btn btn-block" onClick={() => setDark((d) => !d)}>
          {dark ? "Light" : "Dark"} theme
        </button>
        <button className="btn btn-block" style={{ marginTop: 6 }} onClick={() => (touch(sel.key), say(`someone changed ${sel.name}`))}>
          Change it elsewhere
        </button>
        <button className="btn btn-block" style={{ marginTop: 6 }} onClick={() => (remove(sel.key), say(`someone deleted ${sel.name}`))}>
          Delete it elsewhere
        </button>
        <button className="btn btn-block" style={{ marginTop: 6 }} onClick={() => setFull(sel)}>
          Open full
        </button>
        <div style={{ marginTop: 10, color: "var(--dim)", fontSize: 11.5 }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </aside>
      <main style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--dim)" }}>Double-click a file (or Open full) for the editor.</main>
      <aside className="preview" style={{ width: 360, flex: "none", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div style={{ height: 300, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
          <Suspense fallback={null}>
            <LazyDocumentView key={sel.key} profileId="p1" bucket="media-prod" entry={sel} mode="preview" onOpenFull={setFull} onOpenExternal={(e) => say(`open externally: ${e.name}`)} />
          </Suspense>
        </div>
        <p style={{ padding: 12 }}>{sel.key}</p>
      </aside>
      {full && (
        <Suspense fallback={null}>
          <LazyDocumentView
            ref={handle}
            profileId="p1"
            bucket="media-prod"
            entry={full}
            mode="full"
            onClose={() => setFull(null)}
            onSaved={(s) => say(`saved ${s.key}${s.asCopy ? " (copy)" : ""} etag ${s.meta.etag}`)}
            onOpenExternal={(e) => say(`open externally: ${e.name}`)}
          />
        </Suspense>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
