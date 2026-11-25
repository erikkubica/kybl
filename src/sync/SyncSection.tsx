import { TRAY } from "../ui/lib/osText";
import { ON_OS } from "../core/osNames";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "../ui/components/ErrorText";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errMessage } from "../core/api";
import { formatBytes, formatSpeed, plural } from "../core/format";
import { etaLabel } from "../jobs/hooks/useJobs";
import { Icon } from "../ui/components/Icons";
import { ago, prettyPath, syncApi, type PendingDelete, type SyncConflict, type SyncMapping, type SyncStatus, useSync } from "./sync";
import type { Profile } from "../core/types";
import { SyncDialog } from "./SyncDialog";
import "./sync.css";
import { loadRootNames, rootLabel, useRootName } from "../connections/lib/roots";
import { useDialogs } from "../shell/hooks/useDialogs";
import { baseName as leafOf, okToRun, openFromConnection } from "../desktop/components/openGuard";

const DIR_ICON = { upload: "upload", download: "download", twoway: "sync" } as const;
const DIR_TITLE = { upload: "Uploads to the remote folder", download: "Mirrors the remote folder", twoway: "Two-way: changes go both ways" };
const DIR_ARROW = { upload: " → ", download: " ← ", twoway: " ⇄ " };
const DIR_VERB = { upload: "Uploading", download: "Downloading", twoway: "Syncing" };

function baseName(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** The only problem is deletions waiting for a confirmation: the panel below says it better. */
function heldOnly(st: SyncStatus): boolean {
  return (st.pendingDeletes ?? 0) > 0 && !!st.error && !st.error.includes("\n") && st.error.endsWith("confirm the deletions.");
}

function StatusPill({ st, paused }: { st: SyncStatus | undefined; paused: boolean }) {
  const raw = paused ? "paused" : (st?.state ?? "idle");
  // held deletions are a question for the user, not a failure
  const state = (raw === "error" || raw === "idle") && (st?.pendingDeletes ?? 0) > 0 ? "waiting" : raw;
  const label = { idle: "Up to date", scanning: "Checking…", syncing: "Syncing", error: "Problem", paused: "Paused", waiting: "Waiting for you" }[state];
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
          {DIR_VERB[m.direction]} {st.done.toLocaleString()} of {plural(st.total, "file")}
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
      {st?.state === "error" && st.error && !paused && !heldOnly(st) && (
        <p className="sync-error selectable">
          <Icon name="alert" size={13} /> <ErrorText message={st.error} />
        </p>
      )}
      <p className="sync-facts">{facts.join(" · ")}</p>
    </>
  );
}

/** Deletions held by the guard: what would go, with "Delete them" and "Keep the files". */
function PendingPanel({ m, count, run }: { m: SyncMapping; count: number; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [items, setItems] = useState<PendingDelete[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    syncApi
      .pending(m.id)
      .then((p) => live && setItems(p))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [open, m.id, count]);
  const here = items?.filter((i) => i.side === "local").length ?? 0;
  const there = (items?.length ?? 0) - here;
  // confirm exactly what was shown: the open list, or (closed) the count in the heading. If a
  // run changed the list meanwhile, the backend confirms nothing and the list is shown afresh.
  const confirm = async () => {
    const shown = open && items ? items : await syncApi.pending(m.id);
    if (shown.length !== count) {
      setItems(shown);
      setOpen(true);
      throw new Error("The list of files changed since you looked. Check it again, then confirm.");
    }
    try {
      await syncApi.confirmDeletes(m.id, shown);
    } catch (e) {
      setItems(await syncApi.pending(m.id).catch(() => null));
      setOpen(true);
      throw e;
    }
  };
  return (
    <div className="sync-attn warn" role="group" aria-label="Deletions waiting">
      <div className="sync-attn-head">
        <Icon name="trash" size={14} />
        <span>
          <b>
            {count.toLocaleString()} {count === 1 ? "deletion is" : "deletions are"} waiting for you
          </b>
          <small>Nothing was deleted yet. Check the list, then delete them or keep the files.</small>
        </span>
        <button className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide files" : "Show files"}
        </button>
      </div>
      {open && (
        <div className="sync-attn-list selectable">
          {items === null ? (
            <span className="dim">Loading…</span>
          ) : (
            <>
              {items.length > 0 && (
                <span className="dim">
                  {there > 0 && `${there.toLocaleString()} would be deleted there`}
                  {there > 0 && here > 0 && " · "}
                  {here > 0 && `${here.toLocaleString()} would go to the ${ON_OS.trash} here`}
                </span>
              )}
              <ul>
                {items.slice(0, 200).map((i) => (
                  <li key={`${i.side}:${i.path}`} title={i.path}>
                    <Icon name="file" size={12} />
                    <span>{i.path}</span>
                    <em>{i.side === "local" ? "here" : "there"}</em>
                  </li>
                ))}
              </ul>
              {items.length > 200 && <span className="dim">and {(items.length - 200).toLocaleString()} more</span>}
            </>
          )}
        </div>
      )}
      <div className="sync-attn-actions">
        <button className="btn btn-sm btn-danger" onClick={() => run(confirm)}>
          Delete them
        </button>
        <button className="btn btn-sm" onClick={() => run(() => syncApi.restoreDeletes(m.id))}>
          Keep the files
        </button>
      </div>
    </div>
  );
}

/** Conflict copies: open both, or keep one. */
function ConflictsPanel({ m, count, run }: { m: SyncMapping; count: number; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [items, setItems] = useState<SyncConflict[] | null>(null);
  const dialogs = useDialogs();
  useEffect(() => {
    let live = true;
    syncApi
      .conflicts(m.id)
      .then((c) => live && setItems(c))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [m.id, count]);
  if (!items || items.length === 0) return null;
  const open = async (c: SyncConflict) => {
    // both came from the connection at some point: a program is asked about first, once
    const paths = [c.localPath, c.copyLocalPath];
    if (!(await okToRun(paths.map(leafOf), dialogs.confirm))) return;
    for (const p of paths) await openFromConnection(p, dialogs.confirm, undefined, leafOf(p), true).catch(() => {});
  };
  return (
    <div className="sync-attn" role="group" aria-label="Conflicts">
      <div className="sync-attn-head">
        <Icon name="copy" size={14} />
        <span>
          <b>
            {items.length} {items.length === 1 ? "file was" : "files were"} changed on both sides
          </b>
          <small>Both versions are kept: the other one under the file’s name, yours as a copy next to it.</small>
        </span>
      </div>
      <ul className="sync-conflicts">
        {items.map((c) => (
          <li key={c.copy}>
            <div className="sync-conflict-name selectable" title={c.path}>
              <Icon name="file" size={12} />
              <b>{c.path.split("/").pop()}</b>
              {c.path.includes("/") && <span className="dim">in {c.path.slice(0, c.path.lastIndexOf("/"))}</span>}
              <span className="dim">· {ago(c.createdAt)}</span>
            </div>
            <div className="sync-conflict-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => void open(c)} title="Opens both versions">
                <Icon name="external" size={12} /> Open both
              </button>
              <button className="btn btn-sm" onClick={() => run(() => syncApi.resolveConflict(m.id, c.copy, "copy"))} title="Your version replaces the other one, on both sides">
                Keep mine
              </button>
              <button className="btn btn-sm" onClick={() => run(() => syncApi.resolveConflict(m.id, c.copy, "original"))} title={`Your copy goes to the ${ON_OS.trash}`}>
                Keep theirs
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => run(() => syncApi.resolveConflict(m.id, c.copy, "both"))} title="Keeps both files and stops showing this">
                Keep both
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
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
  // Drive and OneDrive roots are ids ("root", a shared drive's 0AB…): show their names
  useRootName();
  useEffect(() => loadRootNames(profiles.filter((p) => sync.mappings.some((m) => m.profileId === p.id))), [profiles, sync.mappings]);

  return (
    <>
      <h3 className="set-title">Synced folders</h3>
      {sync.mappings.length === 0 ? (
        <div className="set-card sync-empty">
          <div className="empty-art">
            <Icon name="sync" size={24} />
          </div>
          <h4>Keep a folder in sync</h4>
          <p>Back up a folder from {ON_OS.here}, keep a local mirror of a remote folder, or keep both sides the same. Syncing keeps running in the {TRAY} when the window is closed.</p>
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
                  <span className={`sync-dir ${m.direction}`} title={DIR_TITLE[m.direction]}>
                    <Icon name={DIR_ICON[m.direction]} size={15} />
                  </span>
                  <div className="sync-title">
                    <strong title={m.localPath}>{baseName(m.localPath)}</strong>
                    <small className="selectable">
                      {prettyPath(m.localPath)}
                      <span className="sync-arrow">{DIR_ARROW[m.direction]}</span>
                      {/* single-root connections (SFTP, WebDAV…) have no bucket: the connection name follows */}
                      {m.bucket ? `${rootLabel(m.profileId, m.bucket)}/${m.prefix}` : `/${m.prefix}`}
                      <span className="dim"> · {profileName(m.profileId)}</span>
                    </small>
                  </div>
                  <StatusPill st={st} paused={paused} />
                </div>
                <StatusLine m={m} st={st} paused={paused} />
                {(st?.pendingDeletes ?? 0) > 0 && <PendingPanel m={m} count={st?.pendingDeletes ?? 0} run={run} />}
                {(st?.conflicts ?? 0) > 0 && <ConflictsPanel m={m} count={st?.conflicts ?? 0} run={run} />}
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
                    <Icon name="reveal" size={13} /> {ON_OS.showInFiles}
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
                <small>Stops all folders until you resume. Also in the {TRAY} icon.</small>
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
