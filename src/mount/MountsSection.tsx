import { TRAY } from "../ui/lib/osText";
import { useEffect, useState } from "react";
import { LOCAL_ID, errMessage, mountApi, type MountInfo } from "../core/api";
import { loadRootNames, useRootName } from "../connections/lib/roots";
import { ON_OS } from "../core/osNames";
import { ErrorText } from "../ui/components/ErrorText";
import { formatBytes } from "../core/format";
import { Icon } from "../ui/components/Icons";
import { prettyPath } from "../sync/sync";
import type { Profile } from "../core/types";
import { fileManagerName, mountWhere, reloadMounts, useMounts } from "./useMounts";
import { ejectLabel, retryDrive } from "./driveMenu";
import "./mount.css";

type Toast = (kind: "success" | "error" | "info", text: string) => void;

const PILL: Record<MountInfo["state"], { cls: string; label: string }> = {
  mounted: { cls: "idle", label: "Mounted" },
  mounting: { cls: "syncing", label: "Mounting…" },
  unmounted: { cls: "paused", label: "Not mounted" },
  error: { cls: "error", label: "Problem" },
  unsupported: { cls: "paused", label: "Not available" },
  removed: { cls: "paused", label: "Removed" },
};

function StatusPill({ m }: { m: MountInfo }) {
  const uploading = m.uploading > 0 && m.state === "mounted";
  const { cls, label } = uploading ? { cls: "syncing", label: "Uploading" } : PILL[m.state];
  return (
    <span className={`sync-pill ${cls}`}>
      {cls === "syncing" ? <span className="spinner" /> : <i />}
      {label}
    </span>
  );
}

/** Saves going up from the drive, or the plain facts. */
function StatusLine({ m }: { m: MountInfo }) {
  if (m.uploading > 0) {
    const pct = m.uploadBytes > 0 ? Math.min(100, Math.round((m.uploadSent / m.uploadBytes) * 100)) : 0;
    return (
      <>
        <div className="sync-progress">
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <span>
            Uploading {m.uploading.toLocaleString()} {m.uploading === 1 ? "file" : "files"} saved on the drive
            {m.uploadBytes > 0 && ` · ${formatBytes(m.uploadBytes)}`}
          </span>
        </div>
        {m.uploadError && (
          <p className="sync-error selectable">
            <Icon name="alert" size={13} /> <span>Upload failed, Kybl keeps trying: <ErrorText message={m.uploadError} /></span>
          </p>
        )}
      </>
    );
  }
  const facts = [
    m.state === "mounted" && m.mountPoint ? prettyPath(m.mountPoint).replace(/^\/home\/[^/]+/, "~") : null,
    m.readOnly ? "read-only" : null,
    m.cacheBytes > 0 ? `${formatBytes(m.cacheBytes)} cached` : null,
  ].filter(Boolean);
  return facts.length ? <p className="sync-facts selectable">{facts.join(" · ")}</p> : null;
}

/** Settings page: drives (connections, buckets or folders mounted in Finder / the file manager). */
export function MountsSection({ profiles, onToast }: { profiles: Profile[]; onToast: Toast }) {
  const { mounts, loaded } = useMounts();
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fm = fileManagerName();

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      onToast("error", errMessage(e));
    } finally {
      setBusy(null);
      reloadMounts();
    }
  };
  useRootName(); // re-render when root names arrive
  useEffect(() => loadRootNames(profiles.filter((p) => mounts.some((m) => m.profileId === p.id))), [profiles, mounts]);
  const connection = (id: string) => (id === LOCAL_ID ? ON_OS.device : (profiles.find((p) => p.id === id)?.name ?? "Missing connection"));

  return (
    <>
      <h3 className="set-title">Drives</h3>
      {loaded && mounts.length === 0 ? (
        <div className="set-card sync-empty">
          <div className="empty-art">
            <Icon name="server" size={24} />
          </div>
          <h4>Open your storage in {fm}</h4>
          <p>
            Mount a bucket or folder as a drive and it shows up in {fm} like a disk. Files download when you open them, and what you save there uploads in the
            background.
          </p>
          <small>Right-click a bucket or folder in Kybl and choose Mount as drive.</small>
        </div>
      ) : (
        <div className="sync-list">
          {mounts.map((m) => (
            <div key={m.id} className={`set-card sync-card ${m.state === "unmounted" || m.state === "unsupported" ? "is-paused" : ""}`}>
              <div className="sync-head">
                <span className="sync-dir" aria-hidden>
                  <Icon name="server" size={15} />
                </span>
                <div className="sync-title">
                  <strong title={m.name}>{m.name}</strong>
                  <small className="selectable">{mountWhere(m, connection(m.profileId))}</small>
                </div>
                <StatusPill m={m} />
              </div>
              {m.error && (m.state === "error" || m.state === "unsupported") && (
                <p className="sync-error selectable">
                  <Icon name="alert" size={13} /> <ErrorText message={m.error} />
                </p>
              )}
              {m.notice && (
                <p className="sync-error selectable mount-notice">
                  <Icon name="info" size={13} />
                  <span>{m.notice}</span>
                  {m.state === "mounted" && (
                    <button className="btn btn-sm btn-ghost" onClick={() => run(m.id, () => mountApi.mountReveal(m.id))} title={`Open the drive in ${fm}`}>
                      Show
                    </button>
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => run(m.id, () => mountApi.mountDismiss(m.id))}>
                    OK
                  </button>
                </p>
              )}
              <StatusLine m={m} />
              <div className="sync-actions">
                {m.state === "mounted" ? (
                  <>
                    <button className="btn btn-sm" onClick={() => run(m.id, () => mountApi.mountReveal(m.id))}>
                      <Icon name="reveal" size={13} /> Show in {fm}
                    </button>
                    <button className="btn btn-sm" disabled={busy === m.id} onClick={() => run(m.id, () => mountApi.mountEject(m.id))}>
                      {ejectLabel()}
                    </button>
                  </>
                ) : (
                  m.state !== "unsupported" && (
                    <button className="btn btn-sm" disabled={busy === m.id || m.state === "mounting"} onClick={() => run(m.id, () => retryDrive(m.id, onToast))}>
                      <Icon name={m.state === "error" ? "retry" : "play"} size={13} /> {m.state === "error" ? "Try again" : "Mount"}
                    </button>
                  )
                )}
                <span className="spacer" />
                {confirmRemove === m.id ? (
                  <>
                    <span className="sync-confirm">Remove this drive? Your files stay in storage.</span>
                    <button className="btn btn-sm" onClick={() => setConfirmRemove(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        setConfirmRemove(null);
                        run(m.id, () => mountApi.mountRemove(m.id));
                      }}
                    >
                      Remove drive
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm btn-danger-ghost" disabled={busy === m.id} onClick={() => setConfirmRemove(m.id)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
          <p className="set-hint mount-add-hint">To add a drive, right-click a folder or bucket and choose Mount as drive…</p>
        </div>
      )}

      <h3 className="set-title">How drives work</h3>
      <div className="set-card">
        <div className="set-row">
          <div className="set-label">
            Files on demand
            <small>Nothing is copied ahead. A file downloads when an app opens it, and recently used files stay cached on this computer.</small>
          </div>
        </div>
        <div className="set-row">
          <div className="set-label">
            Saving
            <small>
              Saves land on this computer first and upload a moment later. If someone changed the same file in the meantime, your version is kept beside it as a
              conflict copy.
            </small>
          </div>
        </div>
        <div className="set-row">
          <div className="set-label">
            While Kybl runs
            <small>Drives need Kybl running, also in the {TRAY}. They come back when Kybl starts, and unmount when you quit.</small>
          </div>
        </div>
      </div>
    </>
  );
}
