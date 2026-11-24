/** A folder's size and file count, counted on the storage, in a bottom sheet. */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errSummary } from "../api";
import { Icon } from "../Icons";
import { FileIcon } from "../components/FileIcon";
import { formatBytes } from "../format";
import { rootName } from "../connections/roots";
import { SheetBackdrop } from "./ui";

type Size = { bytes: number; objects: number; done: boolean; error?: string; stopped?: boolean };

export function FolderInfo({
  profileId,
  bucket,
  prefix,
  name,
  onClose,
  onCopyPath,
}: {
  profileId: string;
  bucket: string;
  prefix: string;
  name: string;
  onClose: () => void;
  onCopyPath: (text: string) => void;
}) {
  const [size, setSize] = useState<Size>({ bytes: 0, objects: 0, done: false });
  // the running count's id, so Stop can end it
  const running = useRef<string | null>(null);
  useEffect(() => {
    const opId = `size-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    running.current = opId;
    let finished = false;
    const off = listen<{ opId: string; bytes: number; objects: number }>("size-progress", (e) => {
      if (e.payload.opId === opId) setSize((s) => (s.done ? s : { bytes: e.payload.bytes, objects: e.payload.objects, done: false }));
    });
    api
      .folderSize(profileId, bucket, prefix, opId)
      .then((r) => setSize({ ...r, done: true }))
      .catch((e) => setSize((s) => ({ ...s, done: true, ...(errMessage(e) === "Cancelled" ? { stopped: true } : { error: errSummary(errMessage(e)) }) })))
      .finally(() => {
        finished = true;
      });
    return () => {
      // closing the sheet stops the count on the storage too
      if (!finished) api.cancelTransfer(opId).catch(() => {});
      off.then((f) => f()).catch(() => {});
    };
  }, [profileId, bucket, prefix]);

  // on screen: the root's name ("My Drive", not its id); copied: a real path on this device's own
  // folders (their root is one), the same readable path elsewhere
  const shown = [rootName(profileId, bucket), ...prefix.split("/").filter(Boolean)].join("/");
  const path = /^(\/|[A-Za-z]:[\\/])/.test(bucket) ? `${bucket.replace(/[\\/]$/, "")}/${prefix}`.replace(/\/$/, "") : shown;
  return (
    <SheetBackdrop onClose={onClose}>
      <div className="m-sheet m-info" role="dialog" aria-label={`${name} info`} onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grip" />
        <div className="m-info-head">
          <span className="m-info-art">
            <FileIcon entry={{ kind: "folder", key: prefix, name, size: 0, modified: null }} big />
          </span>
          <div className="m-info-name">
            <strong>{name}</strong>
            <small>{shown}</small>
          </div>
        </div>
        <dl className="m-info-props">
          <div>
            <dt>Size</dt>
            <dd aria-live="polite">
              {size.error ? (
                <span className="danger">{size.error}</span>
              ) : (
                <>
                  {formatBytes(size.bytes)}
                  {!size.done && <span className="spinner" />}
                  {size.stopped && <span className="faint"> (stopped, only part counted)</span>}
                  {!size.done && (
                    <button type="button" className="link-btn" onClick={() => running.current && void api.cancelTransfer(running.current).catch(() => {})}>
                      Stop
                    </button>
                  )}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>
              {size.objects.toLocaleString()}
              {!size.done && " so far"}
            </dd>
          </div>
        </dl>
        <button className="m-sheet-item" onClick={() => onCopyPath(path)}>
          <Icon name="copy" size={19} />
          <span>Copy path</span>
        </button>
      </div>
    </SheetBackdrop>
  );
}
