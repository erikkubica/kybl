import { useEffect, useRef, useState } from "react";
import { ErrorText } from "./ErrorText";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errMessage } from "../api";
import { formatBytes, formatSpeed } from "../format";
import { etaLabel } from "../useJobs";
import { Icon } from "../Icons";
import { ago, prettyPath, syncApi, type SyncMapping, type SyncStatus, useSync } from "../sync";
import type { Profile } from "../types";
import { SyncDialog } from "./SyncDialog";

function baseName(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function StatusPill({ st, paused }: { st: SyncStatus | undefined; paused: boolean }) {
  const state = paused ? "paused" : (st?.state ?? "idle");
  const label = { idle: "Up to date", scanning: "Checking…", syncing: "Syncing", error: "Problem", paused: "Paused" }[state];
  return (
    <span className={`sync-pill ${state}`}>
      {state === "syncing" || state === "scanning" ? <span className="spinner" /> : <i />}
      {label}
    </span>
  );
}

function StatusLine({ m, st, paused }: { m: SyncMapping; st: SyncStatus | undefined; paused: boolean }) {
  // re-render every 30 s so "2 min ago" stays true
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const rate = useRate(st?.state === "syncing" ? st.bytes : null);

  if (st?.state === "syncing" && st.total > 0) {
    // bytes are the honest measure: one big file can be most of the work
    const frac = st.totalBytes > 0 ? st.bytes / st.totalBytes : st.done / st.total;
    const pct = Math.min(100, Math.round(frac * 100));
    const eta = rate > 0 && st.totalBytes > st.bytes ? etaLabel((st.totalBytes - st.bytes) / rate) : null;
    return (
      <div className="sync-progress">
        <div className="bar">
          <i style={{ width: `${pct}%` }} />
        </div>
        <span>
          {m.direction === "upload" ? "Uploading" : "Downloading"} {st.done.toLocaleString()} of {st.total.toLocaleString()} files
          {st.totalBytes > 0 && ` · ${formatBytes(st.bytes)} of ${formatBytes(st.totalBytes)}`}
          {rate > 0 && ` · ${formatSpeed(rate)}`}
          {eta && ` · ${eta}`}
        </span>
        {st.current && (
          <span className="sync-current" title={st.current}>
            <Icon name="file" size={12} />
            <b>{st.current.split("/").pop()}</b>
            {st.current.includes("/") && <span className="dim">in {st.current.slice(0, st.current.lastIndexOf("/"))}</span>}
          </span>
        )}
      </div>
    );
  }
  const facts = [
    st?.files ? `${st.files.toLocaleString()} ${st.files === 1 ? "file" : "files"}` : null,
    `synced ${ago(st?.lastSync ?? null)}`,
    st?.summary ? `last run: ${st.summary}` : null,
  ].filter(Boolean);
  return (
    <>
      {st?.state === "error" && st.error && !paused && (
        <p className="sync-error selectable">
          <Icon name="alert" size={13} /> <ErrorText message={st.error} />
        </p>
      )}
      <p className="sync-facts">{facts.join(" · ")}</p>
    </>
  );
}

/** Smoothed bytes-per-second from successive byte counts (null resets). */
function useRate(bytes: number | null): number {
  const last = useRef<{ t: number; b: number } | null>(null);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (bytes == null) {
      last.current = null;
      setRate(0);
      return;
    }
    const now = performance.now();
    const prev = last.current;
    if (!prev || bytes < prev.b) {
      last.current = { t: now, b: bytes };
      return;
    }
    if (now - prev.t < 900) return;
    const inst = ((bytes - prev.b) / (now - prev.t)) * 1000;
    setRate((r) => (r ? r * 0.7 + inst * 0.3 : inst));
    last.current = { t: now, b: bytes };
  }, [bytes]);
  return rate;
}

/** Settings page: synced folders. */
export function SyncSection({
  profiles,
  activeProfileId,
  onToast,
}: {
  profiles: Profile[];
  activeProfileId: string | null;
  onToast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  const sync = useSync();
  const [editing, setEditing] = useState<SyncMapping | "new" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await sync.reload();
    } catch (e) {
      onToast("error", errMessage(e));
    }
  };

  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? "Missing connection";

  return (
    <>
      <h3 className="set-title">Synced folders</h3>
      {sync.mappings.length === 0 ? (
        <div className="set-card sync-empty">
          <div className="empty-art">
            <Icon name="sync" size={24} />
          </div>
          <h4>Keep a folder in sync with S3</h4>
          <p>Back up a folder from this Mac to a bucket, or keep a local mirror of a bucket folder. Syncing keeps running in the menu bar when the window is closed.</p>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")} disabled={profiles.length === 0}>
            <Icon name="plus" size={14} /> Add folder
          </button>
          {profiles.length === 0 && <small>Add a connection first.</small>}
        </div>
      ) : (
        <div className="sync-list">
          {sync.mappings.map((m) => {
            const st = sync.status[m.id];
            const paused = m.paused || sync.pausedAll;
            return (
              <div key={m.id} className={`set-card sync-card ${paused ? "is-paused" : ""}`}>
                <div className="sync-head">
                  <span className={`sync-dir ${m.direction}`} title={m.direction === "upload" ? "Backs up to S3" : "Mirrors from S3"}>
                    <Icon name={m.direction === "upload" ? "upload" : "download"} size={15} />
                  </span>
                  <div className="sync-title">
                    <strong title={m.localPath}>{baseName(m.localPath)}</strong>
                    <small className="selectable">
                      {prettyPath(m.localPath)}
                      <span className="sync-arrow">{m.direction === "upload" ? " → " : " ← "}</span>
                      {m.bucket}/{m.prefix}
                      <span className="dim"> · {profileName(m.profileId)}</span>
                    </small>
                  </div>
                  <StatusPill st={st} paused={paused} />
                </div>
                <StatusLine m={m} st={st} paused={paused} />
                <div className="sync-actions">
                  <button className="btn btn-sm" disabled={paused || st?.state === "syncing" || st?.state === "scanning"} onClick={() => run(() => syncApi.now(m.id))}>
                    <Icon name="sync" size={13} /> Sync now
                  </button>
                  <button className="btn btn-sm" disabled={sync.pausedAll} onClick={() => run(() => syncApi.setPaused(m.id, !m.paused))}>
                    <Icon name={m.paused ? "play" : "pause"} size={13} /> {m.paused ? "Resume" : "Pause"}
                  </button>
                  <button className="btn btn-sm" onClick={() => setEditing(m)}>
                    <Icon name="edit" size={13} /> Edit
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => revealItemInDir(m.localPath).catch(() => {})}>
                    <Icon name="reveal" size={13} /> Show in Finder
                  </button>
                  <span className="spacer" />
                  {confirmRemove === m.id ? (
                    <>
                      <span className="sync-confirm">Stop syncing? Files stay where they are.</span>
                      <button className="btn btn-sm" onClick={() => setConfirmRemove(null)}>
                        Cancel
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          setConfirmRemove(null);
                          run(() => syncApi.remove(m.id));
                        }}
                      >
                        Stop syncing
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => setConfirmRemove(m.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div>
            <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")} disabled={profiles.length === 0}>
              <Icon name="plus" size={14} /> Add folder
            </button>
          </div>
        </div>
      )}

      {sync.mappings.length > 0 && (
        <>
          <h3 className="set-title">All folders</h3>
          <div className="set-card">
            <div className="set-row">
              <div className="set-label">
                Pause syncing
                <small>Stops all folders until you resume. Also in the menu bar icon.</small>
              </div>
              <button
                className={`switch ${sync.pausedAll ? "on" : ""}`}
                role="switch"
                aria-checked={sync.pausedAll}
                aria-label="Pause syncing"
                onClick={() => run(() => syncApi.pauseAll(!sync.pausedAll))}
              />
            </div>
          </div>
        </>
      )}

      {editing && (
        <SyncDialog
          initial={editing === "new" ? null : editing}
          profiles={profiles}
          defaultProfileId={activeProfileId}
          onSave={async (m) => {
            await syncApi.save(m);
            await sync.reload();
            onToast("success", editing === "new" ? "Folder added. The first sync starts in a moment." : "Sync settings saved");
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
