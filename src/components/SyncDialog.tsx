import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { DEFAULT_IGNORE, INTERVALS, prettyPath, type SyncDirection, type SyncMapping } from "../sync";
import type { Profile } from "../types";
import { Modal } from "./Dialogs";

const DIRECTIONS: { id: SyncDirection; icon: "upload" | "download"; title: string; text: string }[] = [
  {
    id: "upload",
    icon: "upload",
    title: "Back up to S3",
    text: "Changes in this folder are uploaded within seconds. The folder on your Mac is the original.",
  },
  {
    id: "download",
    icon: "download",
    title: "Mirror from S3",
    text: "Keeps a local copy of the bucket folder, checked on a schedule. The bucket is the original.",
  },
];

/** Add or edit a synced folder. */
export function SyncDialog({
  initial,
  profiles,
  defaultProfileId,
  onSave,
  onClose,
}: {
  initial: SyncMapping | null;
  profiles: Profile[];
  defaultProfileId: string | null;
  onSave: (m: SyncMapping) => Promise<void>;
  onClose: () => void;
}) {
  const firstProfile = profiles.find((p) => p.id === defaultProfileId) ?? profiles[0];
  const [m, setM] = useState<SyncMapping>(
    () =>
      initial ?? {
        id: "",
        profileId: firstProfile?.id ?? "",
        bucket: firstProfile?.bucket ?? "",
        prefix: "",
        localPath: "",
        direction: "upload",
        ignore: DEFAULT_IGNORE,
        mirrorDeletes: false,
        intervalMins: 5,
        paused: false,
      },
  );
  const [ignoreText, setIgnoreText] = useState(() => m.ignore.join("\n"));
  const [buckets, setBuckets] = useState<string[] | null>(null);
  const [bucketsFailed, setBucketsFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SyncMapping>) => setM((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!m.profileId) return;
    let live = true;
    setBuckets(null);
    setBucketsFailed(false);
    api
      .listBuckets(m.profileId)
      .then((b) => {
        if (!live) return;
        const names = b.map((x) => x.name);
        setBuckets(names);
        setM((x) => (x.bucket && names.includes(x.bucket) ? x : { ...x, bucket: x.bucket || names[0] || "" }));
      })
      .catch(() => live && setBucketsFailed(true));
    return () => {
      live = false;
    };
  }, [m.profileId]);

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

  const changingTarget =
    !!initial &&
    (initial.localPath !== m.localPath ||
      initial.profileId !== m.profileId ||
      initial.bucket !== m.bucket ||
      initial.prefix.replace(/^\/+|\/+$/g, "") !== m.prefix.replace(/^\/+|\/+$/g, "") ||
      initial.direction !== m.direction);
  const valid = !!m.localPath && !!m.profileId && !!m.bucket.trim();
  const profile = profiles.find((p) => p.id === m.profileId);

  return (
    <Modal title={initial ? "Edit synced folder" : "Sync a folder"} onClose={onClose} width={560}>
      <div className="modal-body sync-form">
        <div className="field">
          <span>Folder on this Mac</span>
          <div className="path-pick">
            <span className={`path-value ${m.localPath ? "" : "is-unset"}`} title={m.localPath}>
              <Icon name="folder" size={15} />
              {m.localPath ? prettyPath(m.localPath) : "No folder chosen"}
            </span>
            <button className="btn btn-sm" onClick={pickFolder}>
              Choose…
            </button>
          </div>
        </div>

        <div className="field">
          <span>Direction</span>
          <div className="dir-grid" role="radiogroup" aria-label="Direction">
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
          <label className="field">
            <span>Connection</span>
            <select value={m.profileId} onChange={(e) => set({ profileId: e.target.value, bucket: profiles.find((p) => p.id === e.target.value)?.bucket ?? "" })}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Bucket</span>
            {buckets && buckets.length > 0 && !bucketsFailed ? (
              <select value={m.bucket} onChange={(e) => set({ bucket: e.target.value })}>
                {buckets.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={m.bucket}
                onChange={(e) => set({ bucket: e.target.value })}
                placeholder={buckets === null && !bucketsFailed ? "Loading…" : "bucket-name"}
                spellCheck={false}
                className="mono"
              />
            )}
          </label>
          <label className="field span2">
            <span>
              Folder in the bucket <em>· leave empty for the whole bucket</em>
            </span>
            <div className="prefix-input">
              <span className="prefix-lead">{m.bucket || profile?.bucket || "bucket"}/</span>
              <input value={m.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="backups/laptop/" spellCheck={false} className="mono" />
            </div>
          </label>
        </div>

        <div className="sync-opts">
          <div className="set-row">
            <div className="set-label">
              Mirror deletions
              <small>
                {m.direction === "upload"
                  ? "Deleting a file here also deletes it from the bucket. Off: the bucket keeps everything ever uploaded."
                  : "Files removed from the bucket are moved to the Trash here. Files you edited locally are never removed."}
              </small>
            </div>
            <button className={`switch ${m.mirrorDeletes ? "on" : ""}`} role="switch" aria-checked={m.mirrorDeletes} aria-label="Mirror deletions" onClick={() => set({ mirrorDeletes: !m.mirrorDeletes })} />
          </div>
          <div className="set-row">
            <div className="set-label">
              {m.direction === "upload" ? "Full check every" : "Check the bucket every"}
              <small>
                {m.direction === "upload"
                  ? "Local changes upload right away; this also catches files changed or removed on S3."
                  : "S3 can’t notify the app about changes, so it looks for them on this schedule."}
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

        <label className="field">
          <span className="field-head">
            Ignore <em>· one pattern per line, like .gitignore</em>
            <button type="button" className="link-btn" onClick={() => setIgnoreText(DEFAULT_IGNORE.join("\n"))}>
              Reset to defaults
            </button>
          </span>
          <textarea className="ignore-input mono" rows={5} value={ignoreText} onChange={(e) => setIgnoreText(e.target.value)} spellCheck={false} />
          <small className="field-hint">
            <code>*.log</code> any .log file · <code>cache/</code> any folder named cache · <code>/drafts</code> only at the top · <code>!keep.log</code> exception
          </small>
        </label>

        {changingTarget && (
          <p className="hint warn">
            <Icon name="info" size={14} /> You changed where this folder syncs to. It will be compared from scratch on the next run; nothing is deleted.
          </p>
        )}
        {error && (
          <p className="hint error">
            <Icon name="alert" size={14} /> {error}
          </p>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!valid || saving} onClick={save}>
          {saving ? "Saving…" : initial ? "Save" : "Start syncing"}
        </button>
      </div>
    </Modal>
  );
}
