/**
 * "Copy to another connection…": pick any folder on any connection (or this device), choose what
 * happens to files that are already there, and start a job that runs in the background. A dialog
 * on desktop; on phones (`variant="screen"`) a full-screen layer of the app's screen stack.
 */
import { useMemo, useState, type ReactNode } from "react";
import { errMessage, type JobConflict, type JobSpec } from "../api";
import { Icon } from "../Icons";
import { Modal } from "../components/Dialogs";
import { ErrorText } from "../components/ErrorText";
import { LocationPicker, locLabel, type Loc, type PickedLocation } from "./LocationPicker";
import { jobTitle, parentDir, useSourceSummary, type MigrationItem, type MigrationSource } from "./useSourceSummary";
import { migrations } from "./useMigrations";
import "./jobs.css";

export type { MigrationItem, MigrationSource };

export const CONFLICTS: { id: JobConflict; label: string; hint: string }[] = [
  { id: "skipIdentical", label: "Skip if it's the same", hint: "Files already there with the same size are skipped. Different ones are replaced." },
  { id: "skip", label: "Always skip", hint: "Files already there are left as they are." },
  { id: "newerWins", label: "Replace if older", hint: "Files already there are replaced only when this copy is newer." },
  { id: "overwrite", label: "Always replace", hint: "Files already there are replaced." },
  { id: "keepBoth", label: "Keep both", hint: "Files already there stay, and the copy gets a new name like “photo (1).jpg”." },
];

const DEFAULT_IGNORE = ".DS_Store, Thumbs.db, desktop.ini";
const OPTIONS_KEY = "kybl.jobs.options";
const DEST_KEY = "kybl.jobs.lastDest";

export type JobOptions = { conflict: JobConflict; verify: "size" | "hash"; preserveMtime: boolean; ignore: string };
const DEFAULT_OPTIONS: JobOptions = { conflict: "skipIdentical", verify: "hash", preserveMtime: true, ignore: DEFAULT_IGNORE };

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

/** The options last used in the dialog (the quick confirm starts jobs with them too). */
export const loadJobOptions = (): JobOptions => loadJson(OPTIONS_KEY, DEFAULT_OPTIONS);
export const saveJobOptions = (o: JobOptions) => saveJson(OPTIONS_KEY, o);
export const rememberDest = (d: Loc) => saveJson(DEST_KEY, { profileId: d.profileId, root: d.root, dir: d.dir });
export const ignoreList = (o: JobOptions) =>
  o.ignore
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** A folder name made from a root's name ("Macintosh HD", "media-prod"), for whole-connection copies. */
const folderNameOf = (name: string) => name.replace(/[/\\]+/g, "-").trim() || "root";

/** Why `dest` can't take these items, or null. */
export function blockedReason(source: MigrationSource, dest: Loc): string | null {
  if (dest.profileId !== source.profileId) return null;
  // a whole connection can't go into one of its own roots: it would copy into itself
  if (source.roots?.length) return source.roots.some((r) => r.id === dest.root) ? "That's where these files already are." : null;
  if (dest.root !== source.root) return null;
  for (const i of source.items) {
    if (i.isDir && dest.dir.startsWith(i.path)) return i.path === "" ? "That's where these files already are." : "A folder can't go inside itself.";
  }
  if (source.items.every((i) => parentDir(i.path) === dest.dir)) return source.items.length === 1 ? "It's already in this folder." : "They're already in this folder.";
  return null;
}

/**
 * Creates the job(s) for `source` into `dest` and remembers the destination; resolves to the
 * first job's id. A whole connection becomes one job per root, each into a folder of its name.
 */
export async function startJobs(
  source: MigrationSource,
  mode: "copy" | "move",
  dest: PickedLocation,
  opts: JobOptions,
  what: string,
): Promise<{ id: string; spec: JobSpec }> {
  const base = { conflict: opts.conflict, verify: opts.verify, preserveMtime: opts.preserveMtime, ignore: ignoreList(opts) };
  const to = dest.profileId === source.profileId ? locLabel(dest, false) : dest.connectionName;
  const specs: JobSpec[] = source.roots?.length
    ? source.roots.map((r) => ({
        ...base,
        mode,
        src: { profileId: source.profileId, root: r.id, items: [{ path: "", isDir: true }] },
        dst: { profileId: dest.profileId, root: dest.root, dir: `${dest.dir}${folderNameOf(r.name)}/` },
        title: jobTitle(`everything in ${r.name}`, to),
      }))
    : [
        {
          ...base,
          mode,
          src: { profileId: source.profileId, root: source.root, items: source.items.map(({ path, isDir }) => ({ path, isDir })) },
          dst: { profileId: dest.profileId, root: dest.root, dir: dest.dir },
          title: jobTitle(what, to),
        },
      ];
  let first: { id: string; spec: JobSpec } | null = null;
  for (const spec of specs) {
    const id = await migrations.create(spec);
    first ??= { id, spec };
  }
  rememberDest(dest);
  return first!;
}

export function MigrationDialog({
  source,
  initialMode = "copy",
  initialDest,
  onClose,
  onStarted,
  variant = "modal",
  relocate,
}: {
  source: MigrationSource;
  initialMode?: "copy" | "move";
  /** where the picker starts; defaults to the last destination used */
  initialDest?: Loc | null;
  onClose: () => void;
  /** the job was created (it runs in the background; the dialog has closed) */
  onStarted?: (id: string, spec: JobSpec) => void;
  /** "screen": a full-screen phone layer (its back arrow calls onClose) */
  variant?: "modal" | "screen";
  /**
   * The file browser's own copy and move, for folders this connection can reach directly
   * (`roots`): done on the server at once, no background job. Anywhere else becomes a job.
   */
  relocate?: { roots: string[]; run: (dest: Loc, mode: "copy" | "move") => void };
}) {
  const [mode, setMode] = useState(initialMode);
  const [opts, setOpts] = useState<JobOptions>(loadJobOptions);
  const [dest, setDest] = useState<PickedLocation | null>(null);
  const [startAt] = useState<Loc | null>(() => {
    // a folder handed in (the one on screen) is where the tree opens, even when it can't be picked
    if (initialDest?.profileId) return initialDest;
    const d = loadJson<Loc | null>(DEST_KEY, null);
    return d && d.profileId && !blockedReason(source, d) ? d : null;
  });
  const [creating, setCreating] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const s = useSourceSummary(source, mode);

  const set = <K extends keyof JobOptions>(k: K, v: JobOptions[K]) =>
    setOpts((o) => {
      const n = { ...o, [k]: v };
      saveJobOptions(n);
      return n;
    });

  /** dest is done by the browser's own copy/move, not a job */
  const direct = (loc: Loc | null) => !!relocate && !!loc && loc.profileId === source.profileId && relocate.roots.includes(loc.root);
  const blocked = useMemo(
    () => (loc: Loc) => {
      const r = blockedReason(source, loc);
      // a direct copy into the folder the files are in makes copies next to them ("photo (1).jpg")
      if (r && mode === "copy" && direct(loc) && /already in this folder/.test(r)) return null;
      return r;
    },
    [source, mode, relocate],
  );
  const why = dest ? blocked(dest) : null;
  const fast = direct(dest);
  const verb = s.Verb;
  const title = `${verb} ${s.multi || s.whole ? "everything" : s.what} to…`;
  const conflict = CONFLICTS.find((c) => c.id === opts.conflict) ?? CONFLICTS[0];

  const start = async () => {
    if (!dest || why) return;
    if (fast && relocate) {
      relocate.run({ profileId: dest.profileId, root: dest.root, dir: dest.dir }, mode);
      rememberDest(dest);
      onClose();
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const { id, spec } = await startJobs(source, mode, dest, opts, s.what);
      onStarted?.(id, spec);
      onClose();
    } catch (e) {
      setError(errMessage(e));
      setStarting(false);
    }
  };

  const body: ReactNode = (
    <>
      <div className="seg jobs-mode" role="tablist">
        <button className={mode === "copy" ? "on" : ""} onClick={() => setMode("copy")} role="tab" aria-selected={mode === "copy"}>
          Copy
        </button>
        <button className={mode === "move" ? "on" : ""} onClick={() => setMode("move")} role="tab" aria-selected={mode === "move"}>
          Move
        </button>
      </div>

      <LocationPicker value={dest ?? startAt} onChange={setDest} blocked={blocked} creating={creating} onCreatingDone={() => setCreating(false)} />

      {!fast && (
      <button className="jobs-options-toggle" onClick={() => setShowOptions((v) => !v)} aria-expanded={showOptions}>
        <Icon name="chevron" size={11} className={`jobs-caret ${showOptions ? "open" : ""}`} />
        <span>Options</span>
        {!showOptions && (
          <span className="jobs-options-sum">
            {conflict.label}
            {opts.verify === "hash" ? " · check contents" : ""}
          </span>
        )}
      </button>
      )}
      {showOptions && !fast && (
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
            {verb} {s.what}
            {s.amount}
            {s.from && (
              <>
                {" "}
                from <strong>{s.from}</strong>
              </>
            )}{" "}
            to <strong>{locLabel(dest, !fast)}</strong>.
            {fast ? (
              mode === "copy" && blockedReason(source, dest) ? " The copies get a new name next to the originals." : ""
            ) : (
              <>
                {s.multi && " Each bucket gets a folder of its own there."} {conflict.hint}
                {mode === "move" && " Originals are deleted once each copy is checked."}
              </>
            )}
          </span>
        )}
      </div>
      {error && <ErrorText message={error} />}
    </>
  );
  const canStart = !!dest && !why && !starting;
  const label = starting ? "Starting…" : `${verb} here`;

  if (variant === "screen")
    return (
      <section className="m-screen m-overlay jobs-screen" aria-label={title}>
        <header className="m-bar solid">
          <button className="m-icon" onClick={onClose} aria-label="Back">
            <Icon name="arrow-left" size={22} />
          </button>
          <div className="m-title">
            <h1>{title}</h1>
          </div>
          <button className="m-text-btn" onClick={() => setCreating(true)} disabled={creating || !dest || !!why}>
            New folder
          </button>
        </header>
        <div className="jobs-screen-body jobs-dialog">{body}</div>
        <nav className="m-actionbar jobs-screen-bar">
          <button className="btn btn-primary m-big-btn" disabled={!canStart} onClick={() => void start()}>
            <Icon name={mode === "move" ? "move" : "copy"} size={16} /> {label}
          </button>
        </nav>
      </section>
    );

  return (
    <Modal title={title} onClose={onClose} width={560}>
      <div className="modal-body jobs-dialog">{body}</div>
      <div className="modal-foot split">
        <button className="btn" onClick={() => setCreating(true)} disabled={creating || !dest || !!why}>
          <Icon name="folder-plus" size={14} /> New folder
        </button>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>
            {label}
          </button>
        </div>
      </div>
    </Modal>
  );
}
