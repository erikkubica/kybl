import { useState } from "react";
import { errMessage, mountApi, type MountInfo } from "../api";
import { Modal } from "../components/Dialogs";
import { ErrorText } from "../components/ErrorText";
import { Icon } from "../Icons";
import { fileManagerName, findMount, mountWhere, reloadMounts, useMounts } from "./useMounts";
import { rootName } from "../connections/roots";
import "./mount.css";

type Toast = (kind: "success" | "error" | "info", text: string) => void;

/** The drive name Kybl suggests for a place: the folder, else the bucket, else the connection. */
export function suggestedDriveName(connection: string, bucket: string, prefix: string): string {
  const folder = prefix.replace(/\/+$/, "").split("/").pop();
  if (folder) return folder;
  if (bucket) return bucket.split(/[\\/]/).filter(Boolean).pop() ?? bucket;
  return connection;
}

/**
 * "Mount as drive…": names the drive and mounts it. Opened from the browser's context menu on a
 * bucket (prefix "") or a folder (prefix ending with "/"); see INTEGRATION.md. When the place is
 * already a drive it offers to show it instead.
 */
export function MountDialog({
  profileId,
  connection,
  bucket,
  prefix,
  onClose,
  onToast,
  onOpenSettings,
}: {
  profileId: string;
  /** the connection's name, for the suggested drive name and the "where" line */
  connection: string;
  bucket: string;
  prefix: string;
  onClose: () => void;
  onToast: Toast;
  /** opens Settings › Drives (shown after mounting) */
  onOpenSettings?: () => void;
}) {
  const { mounts } = useMounts();
  const existing = findMount(mounts, profileId, bucket, prefix);
  const [name, setName] = useState(() => suggestedDriveName(connection, bucket ? rootName(profileId, bucket) : "", prefix));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fm = fileManagerName();

  const reveal = async (m: MountInfo) => {
    try {
      await mountApi.mountReveal(m.id);
      onClose();
    } catch (e) {
      setError(errMessage(e));
    }
  };

  const mount = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await mountApi.mountAdd(profileId, bucket, prefix, name.trim() || null);
      await reloadMounts();
      if (m.state === "mounted") {
        onToast("success", `“${m.name}” is now a drive in ${fm}`);
        mountApi.mountReveal(m.id).catch(() => {});
        onClose();
      } else {
        // saved, but the system didn't mount it: say why here, the drive stays in Settings
        setError(m.error ?? "The drive couldn't be mounted.");
      }
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Mount as drive" onClose={onClose} width={440}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (existing) reveal(existing);
          else mount();
        }}
      >
        <div className="modal-body mount-dialog">
          <p className="mount-where">
            <Icon name="server" size={14} /> <span className="selectable">{mountWhere({ bucket, prefix }, connection)}</span>
          </p>
          {existing ? (
            <p>
              This is already the drive “{existing.name}”.{" "}
              {existing.state === "mounted" ? `Open it in ${fm}?` : "It isn't mounted right now; you can mount it in Settings › Drives."}
            </p>
          ) : (
            <>
              <p className="dim">It shows up in {fm} like a disk. Files download when you open them, and what you save there uploads in the background.</p>
              <label className="field">
                <span>Drive name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoCorrect="off" autoCapitalize="off" maxLength={80} />
              </label>
            </>
          )}
          {error && (
            <p className="sync-error selectable">
              <Icon name="alert" size={13} /> <ErrorText message={error} />
            </p>
          )}
        </div>
        <div className="modal-foot">
          {onOpenSettings && (error || existing) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                onOpenSettings();
                onClose();
              }}
            >
              Drive settings
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {error && !existing ? "Close" : "Cancel"}
          </button>
          {existing ? (
            <button type="submit" className="btn btn-primary" disabled={existing.state !== "mounted"}>
              Show in {fm}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? "Mounting…" : "Mount"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
