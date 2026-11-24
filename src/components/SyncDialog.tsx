import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMessage } from "../api";
import { Icon, type IconName } from "../Icons";
import { DEFAULT_IGNORE, INTERVALS, prettyPath, remoteTrashOn, type SyncDirection, type SyncMapping } from "../sync";
import type { Profile } from "../types";
import { Modal } from "./Dialogs";
import { ErrorText } from "./ErrorText";
import { ON_OS } from "../osNames";
import "./sync.css";

/** Where a new synced folder should point, e.g. "Sync this folder…" from the file browser. */
export type SyncTarget = { profileId: string; bucket: string; prefix: string; direction?: SyncDirection };

const DIRECTIONS: { id: SyncDirection; icon: IconName; title: string; text: string }[] = [
  {
    id: "upload",
    icon: "upload",
    title: "Upload only",
    text: `Changes in this folder go up within seconds. The folder on ${ON_OS.here} is the original.`,
  },
  {
    id: "download",
    icon: "download",
    title: "Download only",
    text: "Keeps a copy of the remote folder here, checked on a schedule. The remote folder is the original.",
  },
  {
    id: "twoway",
    icon: "sync",
    title: "Two-way",
    text: "Changes on either side are copied to the other. Edited on both? You keep both versions.",
  },
];

/** A place to sync with: a bucket, a drive, or (single-root connections) the connection itself. */
type RootChoice = { id: string; name: string };

/** Add or edit a synced folder. */
export function SyncDialog({
  initial,
  profiles,
  defaultProfileId,
  onSave,
  onClose,
}: {
  /**
   * A synced folder to edit, or (for a new one) the connection, bucket and folder to start
   * from. Nothing: a new one on the default connection.
   */
  initial?: SyncMapping | SyncTarget | null;
  profiles: Profile[];
  defaultProfileId: string | null;
  onSave: (m: SyncMapping) => Promise<void>;
  onClose: () => void;
}) {
  // only a full mapping (with an id) is an edit; a bare target just fills in a new one
  const existing = initial && "id" in initial ? initial : null;
  const target = initial && !("id" in initial) ? initial : null;
  const firstProfile = profiles.find((p) => p.id === (target?.profileId ?? defaultProfileId)) ?? profiles[0];
  const [m, setM] = useState<SyncMapping>(
    () =>
      existing ?? {
        id: "",
        profileId: firstProfile?.id ?? "",
        bucket: target?.bucket ?? firstProfile?.bucket ?? "",
        prefix: target?.prefix ?? "",
        localPath: "",
        direction: target?.direction ?? "upload",
        ignore: DEFAULT_IGNORE,
        mirrorDeletes: false,
        intervalMins: 5,
        paused: false,
        remoteTrash: null,
        deleteGuard: true,
      },
  );
  const [ignoreText, setIgnoreText] = useState(() => m.ignore.join("\n"));
  // null while loading; "single": the connection is its own root (SFTP, WebDAV, Dropbox…)
  const [roots, setRoots] = useState<RootChoice[] | "single" | null>(null);
  const [rootsFailed, setRootsFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SyncMapping>) => setM((x) => ({ ...x, ...patch }));
  const profile = profiles.find((p) => p.id === m.profileId);
  const kind = profile?.kind ?? "s3";

  useEffect(() => {
    if (!m.profileId) return;
    let live = true;
    setRoots(null);
    setRootsFailed(false);
    // S3 lists its buckets as always; other kinds have roots (drives, containers) or just one
    const load: Promise<RootChoice[] | "single"> =
      kind === "s3"
        ? api.listBuckets(m.profileId).then((b) => b.map((x) => ({ id: x.name, name: x.name })))
        : api.capabilities(m.profileId).then(async (caps) => (caps.roots === "single" ? "single" : (await api.listRoots(m.profileId)).map((r) => ({ id: r.id, name: r.name }))));
    load
      .then((r) => {
        if (!live) return;
        setRoots(r);
        if (r === "single") setM((x) => ({ ...x, bucket: "" }));
        else setM((x) => (x.bucket && r.some((o) => o.id === x.bucket) ? x : { ...x, bucket: x.bucket || r[0]?.id || "" }));
      })
      .catch(() => live && setRootsFailed(true));
    return () => {
      live = false;
    };
  }, [m.profileId, kind]);

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose a folder to sync" });
    const path = Array.isArray(dir) ? dir[0] : dir;
    if (path) set({ localPath: path });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...m, ignore: ignoreText.split("\n").map((l) => l.trim()).filter(Boolean) });
      onClose();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const single = roots === "single";
  const rootList = Array.isArray(roots) ? roots : null;
  // what the remote folder is called: the bucket or drive, or the connection itself
  const rootName = single ? (profile?.name ?? "connection") : (rootList?.find((r) => r.id === m.bucket)?.name ?? (m.bucket || "bucket"));
  const changingTarget =
    !!existing &&
    (existing.localPath !== m.localPath ||
      existing.profileId !== m.profileId ||
      existing.bucket !== m.bucket ||
      existing.prefix.replace(/^\/+|\/+$/g, "") !== m.prefix.replace(/^\/+|\/+$/g, ""));
  const valid = !!m.localPath && !!m.profileId && (single || !!m.bucket.trim());
  const twoway = m.direction === "twoway";
  // remote deletions happen in two-way, and in uploads that mirror deletions
  const deletesRemotely = twoway || (m.direction === "upload" && m.mirrorDeletes);
  const deletes = twoway || m.mirrorDeletes;

  return (
    <Modal title={existing ? "Edit synced folder" : "Sync a folder"} onClose={onClose} width={600} locked={saving}>
      <div className="modal-body sync-form">
        <div className="field">
          <span>Folder on {ON_OS.here}</span>
          <div className="path-pick">
            <span className={`path-value ${m.localPath ? "" : "is-unset"}`} title={m.localPath}>
              <Icon name="folder" size={15} />
              {m.localPath ? prettyPath(m.localPath) : "No folder chosen"}
            </span>
            <button type="button" className="btn btn-sm" onClick={pickFolder} autoFocus={!m.localPath}>
              Choose…
            </button>
          </div>
        </div>

        <div className="field">
          <span>Direction</span>
          <div className="dir-grid three" role="radiogroup" aria-label="Direction">
            {DIRECTIONS.map((d) => (
              <button
                key={d.id}
                className={`dir-card ${m.direction === d.id ? "on" : ""}`}
                role="radio"
                aria-checked={m.direction === d.id}
                onClick={() => set({ direction: d.id })}
              >
                <span className="dir-icon">
                  <Icon name={d.icon} size={16} />
                </span>
                <strong>{d.title}</strong>
                <small>{d.text}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="form-grid">
          <label className={`field ${single ? "span2" : ""}`}>
            <span>Connection</span>
            <select value={m.profileId} onChange={(e) => set({ profileId: e.target.value, bucket: profiles.find((p) => p.id === e.target.value)?.bucket ?? "" })}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {!single && (
            <label className="field">
              <span>{kind === "s3" ? "Bucket" : "Location"}</span>
              {rootList && rootList.length > 0 && !rootsFailed ? (
                <select value={m.bucket} onChange={(e) => set({ bucket: e.target.value })}>
                  {rootList.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={m.bucket}
                  onChange={(e) => set({ bucket: e.target.value })}
                  placeholder={roots === null && !rootsFailed ? "Loading…" : "bucket-name"}
                  spellCheck={false}
                  className="mono"
                />
              )}
            </label>
          )}
          <label className="field span2">
            <span>
              Folder there <em>· leave empty for all of {single ? "it" : rootName}</em>
            </span>
            <div className="prefix-input">
              <span className="prefix-lead">{rootName}/</span>
              <input value={m.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="backups/laptop/" spellCheck={false} className="mono" />
            </div>
          </label>
        </div>

        <div className="sync-opts">
          {!twoway && (
            <div className="set-row">
              <div className="set-label">
                Mirror deletions
                <small>
                  {m.direction === "upload"
                    ? "Deleting a file here also deletes it there. Off: the remote folder keeps everything ever uploaded."
                    : `Files removed there are moved to the ${ON_OS.trash} here. Files you edited here are never removed.`}
                </small>
              </div>
              <button className={`switch ${m.mirrorDeletes ? "on" : ""}`} role="switch" aria-checked={m.mirrorDeletes} aria-label="Mirror deletions" onClick={() => set({ mirrorDeletes: !m.mirrorDeletes })} />
            </div>
          )}
          {deletesRemotely && (
            <div className="set-row">
              <div className="set-label">
                Keep deleted files in a trash folder
                <small>
                  Files deleted on {ON_OS.here} move to <code>.kybl-trash</code> in the remote folder instead of disappearing. Connections with their own trash use that.
                  {twoway && ` Files deleted there go to the ${ON_OS.trash} here.`}
                </small>
              </div>
              <button
                className={`switch ${remoteTrashOn(m) ? "on" : ""}`}
                role="switch"
                aria-checked={remoteTrashOn(m)}
                aria-label="Keep deleted files in a trash folder"
                onClick={() => set({ remoteTrash: !remoteTrashOn(m) })}
              />
            </div>
          )}
          {deletes && (
            <div className="set-row">
              <div className="set-label">
                Ask before big deletions
                <small>Waits for you to confirm before deleting more than 50 files at once. A side that suddenly looks empty is always checked with you.</small>
              </div>
              <button
                className={`switch ${m.deleteGuard !== false ? "on" : ""}`}
                role="switch"
                aria-checked={m.deleteGuard !== false}
                aria-label="Ask before big deletions"
                onClick={() => set({ deleteGuard: m.deleteGuard === false })}
              />
            </div>
          )}
          <div className="set-row">
            <div className="set-label">
              {m.direction === "download" ? "Check for changes every" : "Full check every"}
              <small>
                {m.direction === "download"
                  ? "Most storage can’t tell the app about changes, so it looks for them on this schedule."
                  : twoway
                    ? "Changes here go over right away; this is how often changes there are looked for."
                    : "Local changes upload right away; this also catches files changed or removed there."}
              </small>
            </div>
            <div className="seg" role="group" aria-label="Interval">
              {INTERVALS.map((o) => (
                <button key={o.value} className={m.intervalMins === o.value ? "on" : ""} aria-pressed={m.intervalMins === o.value} onClick={() => set({ intervalMins: o.value })}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* not a <label>: a click on its words would press "Reset to defaults" (the first control in it) */}
        <div className="field">
          <span className="field-head">
            <span id="sync-ignore-label">
              Ignore <em>· one pattern per line, like .gitignore</em>
            </span>
            <button type="button" className="link-btn" onClick={() => setIgnoreText(DEFAULT_IGNORE.join("\n"))}>
              Reset to defaults
            </button>
          </span>
          <textarea
            className="ignore-input mono"
            rows={5}
            value={ignoreText}
            onChange={(e) => setIgnoreText(e.target.value)}
            spellCheck={false}
            aria-labelledby="sync-ignore-label"
            aria-describedby="sync-ignore-hint"
          />
          <small className="field-hint" id="sync-ignore-hint">
            <code>*.log</code> any .log file · <code>cache/</code> any folder named cache · <code>/drafts</code> only at the top · <code>!keep.log</code> exception
          </small>
        </div>

        {changingTarget && (
          <p className="hint warn">
            <Icon name="info" size={14} /> You changed where this folder syncs to. It will be compared from scratch on the next run; nothing is deleted.
          </p>
        )}
        {error && (
          <div className="result bad" role="alert">
            <Icon name="alert" size={15} />
            <ErrorText message={error} />
          </div>
        )}
        {!valid && !m.localPath && <p className="hint">Choose a folder on {ON_OS.here} to start.</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid || saving} onClick={save}>
          {saving ? "Saving…" : existing ? "Save" : "Start syncing"}
        </button>
      </div>
    </Modal>
  );
}
