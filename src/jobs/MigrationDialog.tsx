/**
 * "Copy to another connection…": pick any folder on any connection (or this device), choose what
 * happens to files that are already there, and start a job that runs in the background.
 */
import { useEffect, useMemo, useState } from "react";
import { api, errMessage, LOCAL_ID, type JobConflict, type JobSpec, type RootInfo } from "../api";
import { Icon } from "../Icons";
import { Modal } from "../components/Dialogs";
import { ErrorText } from "../components/ErrorText";
import { baseName, formatBytes } from "../format";
import type { Profile } from "../types";
import { LocationPicker, deviceName, locLabel, type Loc, type PickedLocation } from "./LocationPicker";
import { migrations } from "./useMigrations";
import "./jobs.css";

export type MigrationItem = { path: string; isDir: boolean; size?: number };
export type MigrationSource = {
  profileId: string;
  root: string;
  /** a folder with path "" is everything in the root */
  items: MigrationItem[];
};

const CONFLICTS: { id: JobConflict; label: string; hint: string }[] = [
  { id: "skipIdentical", label: "Skip if it's the same", hint: "Files already there with the same size are skipped. Different ones are replaced." },
  { id: "skip", label: "Always skip", hint: "Files already there are left as they are." },
  { id: "newerWins", label: "Replace if older", hint: "Files already there are replaced only when this copy is newer." },
  { id: "overwrite", label: "Always replace", hint: "Files already there are replaced." },
  { id: "keepBoth", label: "Keep both", hint: "Files already there stay, and the copy gets a new name like “photo (1).jpg”." },
];

const DEFAULT_IGNORE = ".DS_Store, Thumbs.db, desktop.ini";
const OPTIONS_KEY = "kybl.jobs.options";
const DEST_KEY = "kybl.jobs.lastDest";

type Options = { conflict: JobConflict; verify: "size" | "hash"; preserveMtime: boolean; ignore: string };
const DEFAULT_OPTIONS: Options = { conflict: "skipIdentical", verify: "hash", preserveMtime: true, ignore: DEFAULT_IGNORE };

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: nothing remembered */
  }
}

const parentDir = (path: string) => path.replace(/\/$/, "").replace(/[^/]*$/, "");
const itemName = (i: MigrationItem, rootName: string) => (i.path === "" ? rootName : baseName(i.path));

/** Why `dest` can't take these items, or null. */
export function blockedReason(source: MigrationSource, dest: Loc): string | null {
  if (dest.profileId !== source.profileId || dest.root !== source.root) return null;
  for (const i of source.items) {
    if (i.isDir && dest.dir.startsWith(i.path)) return i.path === "" ? "That's where these files already are." : "A folder can't go inside itself.";
  }
  if (source.items.every((i) => parentDir(i.path) === dest.dir)) return source.items.length === 1 ? "It's already in this folder." : "They're already in this folder.";
  return null;
}

export function MigrationDialog({
  source,
  initialMode = "copy",
  initialDest,
  onClose,
  onStarted,
}: {
  source: MigrationSource;
  initialMode?: "copy" | "move";
  /** where the picker starts; defaults to the last destination used */
  initialDest?: Loc | null;
  onClose: () => void;
  /** the job was created (it runs in the background; the dialog has closed) */
  onStarted?: (id: string, spec: JobSpec) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [opts, setOpts] = useState<Options>(() => loadJson(OPTIONS_KEY, DEFAULT_OPTIONS));
  const [dest, setDest] = useState<PickedLocation | null>(null);
  const [startAt] = useState<Loc | null>(() => {
    const d = initialDest ?? loadJson<Loc | null>(DEST_KEY, null);
    return d && !blockedReason(source, d) ? d : null;
  });
  const [creating, setCreating] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [srcNames, setSrcNames] = useState<{ connection: string; root: string } | null>(null);
  const [sizes, setSizes] = useState<{ bytes: number; files: number; counting: boolean }>({ bytes: 0, files: 0, counting: false });

  // names of where the items come from, for the summary
  useEffect(() => {
    let live = true;
    const conn: Promise<string> = source.profileId === LOCAL_ID ? Promise.resolve(deviceName()) : api.listProfiles().then((ps: Profile[]) => ps.find((p) => p.id === source.profileId)?.name ?? "this connection");
    const root = api
      .listRoots(source.profileId)
      .then((rs: RootInfo[]) => rs.find((r) => r.id === source.root)?.name ?? source.root)
      .catch(() => source.root);
    Promise.all([conn, root]).then(([connection, root]) => live && setSrcNames({ connection, root }), () => {});
    return () => {
      live = false;
    };
  }, [source.profileId, source.root]);

  // how much it is: file sizes as given, folders counted (stopped when the dialog closes)
  useEffect(() => {
    const files = source.items.filter((i) => !i.isDir);
    const folders = source.items.filter((i) => i.isDir);
    const base = { bytes: files.reduce((s, i) => s + (i.size ?? 0), 0), files: files.length };
    if (folders.length === 0 || folders.length > 20) {
      setSizes({ ...base, counting: false });
      return;
    }
    setSizes({ ...base, counting: true });
    let live = true;
    const ops = folders.map(() => `jobs-size-${Math.random().toString(36).slice(2)}`);
    Promise.all(folders.map((f, i) => api.folderSize(source.profileId, source.root, f.path, ops[i])))
      .then((rs) => live && setSizes({ bytes: base.bytes + rs.reduce((s, r) => s + r.bytes, 0), files: base.files + rs.reduce((s, r) => s + r.objects, 0), counting: false }))
      .catch(() => live && setSizes({ ...base, counting: false }));
    return () => {
      live = false;
      for (const op of ops) api.cancelTransfer(op).catch(() => {});
    };
  }, [source]);

  const set = <K extends keyof Options>(k: K, v: Options[K]) =>
    setOpts((o) => {
      const n = { ...o, [k]: v };
      saveJson(OPTIONS_KEY, n);
      return n;
    });

  const blocked = useMemo(() => (loc: Loc) => blockedReason(source, loc), [source]);
  const why = dest ? blocked(dest) : null;
  const verb = mode === "move" ? "Move" : "Copy";
  const rootName = srcNames?.root ?? source.root;
  const what =
    source.items.length === 1
      ? source.items[0].path === ""
        ? `everything in ${rootName}`
        : `“${itemName(source.items[0], rootName)}”`
      : `${source.items.length} items`;
  const title = `${verb} ${source.items.length === 1 && source.items[0].path === "" ? "everything" : what} to…`;
  const ignore = opts.ignore
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const conflict = CONFLICTS.find((c) => c.id === opts.conflict) ?? CONFLICTS[0];
  const amount =
    sizes.counting && sizes.files === 0
      ? ""
      : sizes.bytes > 0 || sizes.files > 0
        ? ` (${sizes.files > 0 ? `${sizes.files.toLocaleString()} ${sizes.files === 1 ? "file" : "files"}, ` : ""}${formatBytes(sizes.bytes)}${sizes.counting ? " so far" : ""})`
        : "";
  // the folder the items are in (they all come from one folder)
  const fromDir = source.items[0]?.path ? parentDir(source.items[0].path) : "";
  const from = srcNames ? locLabel({ connectionName: srcNames.connection, rootName: srcNames.root, dir: fromDir }) : "";

  const start = async () => {
    if (!dest || why) return;
    setStarting(true);
    setError(null);
    const destName = dest.connectionName;
    const spec: JobSpec = {
      mode,
      src: { profileId: source.profileId, root: source.root, items: source.items.map(({ path, isDir }) => ({ path, isDir })) },
      dst: { profileId: dest.profileId, root: dest.root, dir: dest.dir },
      conflict: opts.conflict,
      verify: opts.verify,
      preserveMtime: opts.preserveMtime,
      ignore,
      title: `${what.charAt(0).toUpperCase()}${what.slice(1)} to ${dest.profileId === source.profileId ? locLabel(dest, false) : destName}`,
    };
    try {
      const id = await migrations.create(spec);
      saveJson(DEST_KEY, { profileId: dest.profileId, root: dest.root, dir: dest.dir });
      onStarted?.(id, spec);
      onClose();
    } catch (e) {
      setError(errMessage(e));
      setStarting(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} width={560}>
      <div className="modal-body jobs-dialog">
        <div className="seg jobs-mode" role="tablist">
          <button className={mode === "copy" ? "on" : ""} onClick={() => setMode("copy")} role="tab" aria-selected={mode === "copy"}>
            Copy
          </button>
          <button className={mode === "move" ? "on" : ""} onClick={() => setMode("move")} role="tab" aria-selected={mode === "move"}>
            Move
          </button>
        </div>

        <LocationPicker value={dest ?? startAt} onChange={setDest} blocked={blocked} creating={creating} onCreatingDone={() => setCreating(false)} />

        <button className="jobs-options-toggle" onClick={() => setShowOptions((s) => !s)} aria-expanded={showOptions}>
          <Icon name="chevron" size={11} className={`jobs-caret ${showOptions ? "open" : ""}`} />
          <span>Options</span>
          {!showOptions && <span className="jobs-options-sum">{conflict.label}{opts.verify === "hash" ? " · check contents" : ""}</span>}
        </button>
        {showOptions && (
          <div className="jobs-options">
            <label className="jobs-field">
              <span>If a file is already there</span>
              <select value={opts.conflict} onChange={(e) => set("conflict", e.target.value as JobConflict)}>
                {CONFLICTS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="jobs-check">
              <input type="checkbox" checked={opts.verify === "hash"} onChange={(e) => set("verify", e.target.checked ? "hash" : "size")} />
              <span>
                Check contents after copying
                <small>Compares fingerprints where both sides have them. Sizes are always checked.</small>
              </span>
            </label>
            <label className="jobs-check">
              <input type="checkbox" checked={opts.preserveMtime} onChange={(e) => set("preserveMtime", e.target.checked)} />
              <span>
                Keep modification dates
                <small>Where the destination can store them, like this device.</small>
              </span>
            </label>
            <label className="jobs-field">
              <span>Leave out</span>
              <input type="text" value={opts.ignore} spellCheck={false} autoCorrect="off" autoCapitalize="off" placeholder="*.tmp, node_modules/" onChange={(e) => set("ignore", e.target.value)} />
            </label>
          </div>
        )}

        <div className={`jobs-summary ${why ? "bad" : ""}`} aria-live="polite">
          {!dest ? (
            <span>Pick a folder to {mode} to.</span>
          ) : why ? (
            <span>
              <Icon name="alert" size={13} /> {why}
            </span>
          ) : (
            <span>
              {verb} {what}
              {amount}
              {from && <> from <strong>{from}</strong></>} to <strong>{locLabel(dest)}</strong>. {conflict.hint}
              {mode === "move" && " Originals are deleted once each copy is checked."}
            </span>
          )}
        </div>
        {error && <ErrorText message={error} />}
      </div>
      <div className="modal-foot split">
        <button className="btn" onClick={() => setCreating(true)} disabled={creating || !dest || !!why}>
          <Icon name="folder-plus" size={14} /> New folder
        </button>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!dest || !!why || starting} onClick={() => void start()}>
            {starting ? "Starting…" : `${verb} here`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
