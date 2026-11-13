import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../Icons";
import { Modal } from "./Dialogs";
import { FileIcon } from "./FileIcon";
import { entryParent, isValidDest } from "../moving";
import type { Entry } from "../types";

const MAX_PAGES = 5;

/** Folder picker for "Move to…" / "Copy to…" inside the current bucket. */
export function MoveDialog({
  profileId,
  bucket,
  items,
  startPrefix,
  initialMode,
  onSubmit,
  onClose,
}: {
  profileId: string;
  bucket: string;
  items: Entry[];
  startPrefix: string;
  initialMode: "move" | "copy";
  onSubmit: (dest: string, mode: "move" | "copy") => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [path, setPath] = useState(startPrefix);
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [cursor, setCursor] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setFolders(null);
    setError(null);
    setCursor(-1);
    (async () => {
      const found = new Set<string>();
      let token: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const r = await api.listObjects(profileId, bucket, path, token);
        r.folders.forEach((f) => found.add(f));
        token = r.nextToken;
        if (!token) break;
      }
      return [...found].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    })()
      .then((f) => live && setFolders(f))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [profileId, bucket, path]);

  const parts = path.split("/").filter(Boolean);
  const blocked = (f: string) => items.some((e) => e.kind === "folder" && f.startsWith(e.key));
  const valid = isValidDest(items, path);
  const allHere = items.every((e) => entryParent(e) === path);
  const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} items`;
  const verb = mode === "move" ? "Move" : "Copy";

  const createFolder = () => {
    const n = newName.trim().replace(/\/+$/, "");
    if (!n || n.includes("/")) return;
    setCreating(false);
    setNewName("");
    setPath(`${path}${n}/`);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!folders?.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(folders.length - 1, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if ((e.key === "Enter" || e.key === "ArrowRight") && cursor >= 0 && !blocked(folders[cursor])) {
      e.preventDefault();
      setPath(folders[cursor]);
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && path) {
      e.preventDefault();
      setPath(parts.slice(0, -1).map((p) => p + "/").join(""));
    }
  };

  return (
    <Modal title={`${verb} ${what}`} onClose={onClose} width={520}>
      <div className="modal-body move-body">
        <div className="seg move-mode" role="tablist">
          <button className={mode === "move" ? "on" : ""} onClick={() => setMode("move")} role="tab" aria-selected={mode === "move"}>
            Move
          </button>
          <button className={mode === "copy" ? "on" : ""} onClick={() => setMode("copy")} role="tab" aria-selected={mode === "copy"}>
            Copy
          </button>
        </div>

        <nav className="move-crumbs" aria-label="Destination">
          <button className="crumb" onClick={() => setPath("")}>
            <Icon name="bucket" size={14} />
            {bucket}
          </button>
          {parts.map((p, i) => (
            <span key={i} className="crumb-wrap">
              <Icon name="chevron" size={11} className="crumb-sep" />
              <button className="crumb" onClick={() => setPath(parts.slice(0, i + 1).map((x) => x + "/").join(""))}>
                {p}
              </button>
            </span>
          ))}
        </nav>

        <div className="move-list" ref={listRef} tabIndex={0} onKeyDown={onListKey} role="listbox" aria-label="Folders">
          {path && (
            <button className="move-row up" onClick={() => setPath(parts.slice(0, -1).map((p) => p + "/").join(""))}>
              <Icon name="arrow-up" size={14} />
              <span>Up one level</span>
            </button>
          )}
          {folders === null && !error && (
            <div className="move-state">
              <span className="spinner" /> Loading folders…
            </div>
          )}
          {error && <div className="move-state error selectable">{error}</div>}
          {folders?.length === 0 && !creating && <div className="move-state">No folders here. You can {mode} into this folder or create a new one.</div>}
          {folders?.map((f, i) => {
            const name = f.slice(path.length).replace(/\/$/, "");
            const no = blocked(f);
            return (
              <button
                key={f}
                className={`move-row ${i === cursor ? "cursor" : ""}`}
                disabled={no}
                title={no ? "Can’t move a folder into itself" : f}
                onClick={() => setPath(f)}
                role="option"
                aria-selected={i === cursor}
              >
                <FileIcon entry={{ kind: "folder", key: f, name, size: 0, modified: null }} size={16} />
                <span className="move-name">{name}</span>
                <Icon name="chevron" size={12} className="move-caret" />
              </button>
            );
          })}
          {creating && (
            <div className="move-row new">
              <FileIcon entry={{ kind: "folder", key: "_", name: "", size: 0, modified: null }} size={16} />
              <input
                autoFocus
                value={newName}
                placeholder="Folder name"
                spellCheck={false}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") createFolder();
                  if (e.key === "Escape") setCreating(false);
                }}
                onBlur={() => !newName.trim() && setCreating(false)}
              />
            </div>
          )}
        </div>
        <p className="hint move-hint">
          {allHere
            ? `${items.length === 1 ? "It’s" : "They’re"} already in this folder. Pick another one.`
            : !valid
              ? "A folder can’t be moved into itself."
              : `${verb} to /${path}`}
        </p>
      </div>
      <div className="modal-foot split">
        <button className="btn" onClick={() => setCreating(true)} disabled={creating}>
          <Icon name="folder-plus" size={14} /> New folder
        </button>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => {
              onSubmit(path, mode);
              onClose();
            }}
          >
            {verb} here
          </button>
        </div>
      </div>
    </Modal>
  );
}
