import { useEffect, useRef, useState } from "react";
import { Modal } from "../components/Dialogs";

/** Go to folder (⇧⌘G / ⌘L): type or paste a path or an s3:// address. */
export function GoToDialog({ bucket, prefix, onGo, onClose }: { bucket: string; prefix: string; onGo: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(`/${prefix}`);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const submit = () => {
    if (!value.trim()) return;
    onGo(value.trim());
    onClose();
  };
  return (
    <Modal title="Go to folder" onClose={onClose}>
      <div className="modal-body">
        <label className="field">
          <span>Path</span>
          <input
            ref={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="/photos/2026 or s3://bucket/photos"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </label>
        <p className="hint">
          Start with “/” for a path in {bucket}, or paste an S3 address like s3://bucket/folder. A bucket name at the start switches to that bucket.
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={!value.trim()}>
          Go
        </button>
      </div>
    </Modal>
  );
}
