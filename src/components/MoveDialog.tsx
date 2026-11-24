import { useEffect, useRef, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { rootIcon, useRootName } from "../connections/roots";
import { Modal } from "./Dialogs";
import { ErrorText } from "./ErrorText";
import { FileIcon } from "./FileIcon";
import { entryParent, isValidDest } from "../moving";
import type { Entry } from "../types";
import { nameProblem } from "../itemText";

const MAX_PAGES = 5;

/**
 * Folder picker for "Move to…" / "Copy to…", in the current bucket or, when `buckets` lists more
 * than one, in another bucket of the same connection (copied server-side).
 */
export function MoveDialog({
  profileId,
  bucket,
  buckets,
  items,
  startPrefix,
  initialMode,
  onSubmit,
  onOtherConnection,
  onClose,
}: {
  profileId: string;
  bucket: string;
  /** buckets of this connection the items may go to; omitted = only `bucket` */
  buckets?: string[];
  items: Entry[];
  startPrefix: string;
  initialMode: "move" | "copy";
  onSubmit: (dest: string, mode: "move" | "copy", destBucket: string) => void;
  /** "Another connection…": the same items to any other connection (or this computer), as a job */
  onOtherConnection?: (mode: "move" | "copy") => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  // roots by name (drives, a server's one root), not by id
  const label = useRootName();
  // what the roots are called here: S3 buckets, cloud drives, this computer's places
  const ico = rootIcon(profileId, bucket);
  const word = ico === "bucket" ? "bucket" : ico === "cloud" ? "drive" : "place";
  const [target, setTarget] = useState(bucket);
  const [path, setPath] = useState(startPrefix);
  const other = target !== bucket;
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** folders made in this picker; they only exist once something is put in them */
  const made = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    setFolders(null);
    setError(null);
    setCursor(-1);
    // the folders made here under `path`: shown with the listed ones until they exist for real
    const madeHere = [...made.current].filter((f) => f !== path && f.startsWith(path) && !f.slice(path.length, -1).includes("/"));
    // one made here doesn't exist yet (on disk and servers listing it fails): nothing to list
    if (made.current.has(path)) {
      setFolders(madeHere.sort());
      return;
    }
    (async () => {
      const found = new Set<string>(madeHere);
      let token: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const r = await api.listObjects(profileId, target, path, token);
        r.folders.forEach((f) => found.add(f));
        token = r.nextToken;
        if (!token) break;
      }
      return [...found].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    })()
      .then((f) => live && setFolders(f))
      .catch((e) => live && setError(errMessage(e)));
    return () => {
      live = false;
    };
  }, [profileId, target, path, attempt]);

  const parts = path.split("/").filter(Boolean);
  const blocked = (f: string) => !other && items.some((e) => e.kind === "folder" && f.startsWith(e.key));
  // a folder name still being typed counts as the destination, so "Move here" finishes the job
  // without a separate confirm step (touch keyboards can be dismissed without pressing Return)
  const pending = creating ? newName.trim().replace(/\/+$/, "") : "";
  // a name that can't be a folder ("a/b", "..") is said under the list and moves nothing
  const pendingBad = pending ? nameProblem(pending) : null;
  const dest = pending && !pendingBad ? `${path}${pending}/` : path;
  const allHere = !other && items.every((e) => entryParent(e) === dest);
  // copying into the folder the items are in makes copies next to them ("photo (1).jpg")
  const valid = !pendingBad && (other || isValidDest(items, dest) || (mode === "copy" && allHere && !items.some((e) => e.kind === "folder" && dest.startsWith(e.key))));
  const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} items`;
  const verb = mode === "move" ? "Move" : "Copy";

  /** a "new" folder that is already in the list is just opened (it has folders of its own to list) */
  const exists = (f: string) => !!folders?.includes(f);
  const createFolder = () => {
    if (pendingBad || dest === path) return;
    if (!exists(dest)) made.current.add(dest);
    setCreating(false);
    setNewName("");
    setPath(dest);
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

        {buckets && buckets.length > 1 && (
          <label className="move-bucket">
            <Icon name={rootIcon(profileId, target)} size={14} />
            <span>{word.charAt(0).toUpperCase() + word.slice(1)}</span>
            <select
              value={target}
              onChange={(e) => {
                made.current.clear();
                setTarget(e.target.value);
                setPath("");
              }}
              aria-label={`Destination ${word}`}
            >
              {buckets.map((b) => (
                <option key={b} value={b}>
                  {label(profileId, b)}
                  {b === bucket ? ` (this ${word})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <nav className="move-crumbs" aria-label="Destination">
          <button className="crumb" onClick={() => setPath("")}>
            <Icon name={rootIcon(profileId, target)} size={14} />
            {label(profileId, target)}
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
          {error && (
            <div className="move-state error">
              <span>
                <Icon name="alert" size={14} /> Couldn't list the folders here.
              </span>
              <ErrorText message={error} />
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          )}
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
                enterKeyHint="done"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") createFolder();
                  if (e.key === "Escape") setCreating(false);
                }}
                onBlur={() => (newName.trim() ? createFolder() : setCreating(false))}
              />
            </div>
          )}
        </div>
        <p className="hint move-hint">
          {pendingBad
            ? pendingBad
            : allHere && mode === "copy"
            ? `${items.length === 1 ? "It’s" : "They’re"} already in this folder: the ${items.length === 1 ? "copy gets" : "copies get"} a new name next to the ${items.length === 1 ? "original" : "originals"}.`
            : allHere
            ? `${items.length === 1 ? "It’s" : "They’re"} already in this folder. Pick another one.`
            : !valid
              ? "A folder can’t be moved into itself."
              : `${verb} to ${other ? `${label(profileId, target)}/` : "/"}${dest}`}
        </p>
      </div>
      <div className="modal-foot split">
        <div className="btn-row">
          <button className="btn" onClick={() => setCreating(true)} disabled={creating}>
            <Icon name="folder-plus" size={14} /> New folder
          </button>
          {onOtherConnection && (
            <button className="btn" onClick={() => onOtherConnection(mode)} title="Copy or move to another connection, or to this computer">
              Another connection…
            </button>
          )}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => {
              // S3 has no real folders: without a marker object a new folder would vanish again
              // the moment its last file is moved out. Best effort, the move itself doesn't need it.
              if (dest !== path && !exists(dest)) made.current.add(dest);
              for (const f of made.current) {
                if (dest.startsWith(f)) api.createFolder(profileId, target, f).catch(() => {});
              }
              onSubmit(dest, mode, target);
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
