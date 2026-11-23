import { useEffect, useRef, useState } from "react";
import { Modal } from "../components/Dialogs";

/** Go to folder (⇧⌘G / ⌘L): type or paste a path (or an s3:// address); the words come from `goToText`. */
export function GoToDialog({ initial, placeholder, hint, onGo, onClose }: { initial: string; placeholder: string; hint: string; onGo: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial);
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
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submit()}
            placeholder={placeholder}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </label>
        <p className="hint">{hint}</p>
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
