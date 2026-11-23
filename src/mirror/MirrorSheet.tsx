/**
 * The Mirror sheet: source → destination (swap to pull instead of push), what to do, how
 * "changed" is decided, what to leave out, and a dry run of exactly what will be copied and
 * deleted, grouped by folder. "Mirror" then runs that as one job. Mirrors can be saved by name
 * and loaded again from the row at the top.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { errMessage, type Capabilities } from "../api";
import { Icon } from "../Icons";
import { Modal } from "../components/Dialogs";
import { ErrorText } from "../components/ErrorText";
import { FileIcon } from "../components/FileIcon";
import { formatBytes } from "../format";
import { LocationPicker, deviceName } from "../jobs/LocationPicker";
import { capsFor } from "../useCaps";
import { DEFAULT_EXCLUDES, parseRules } from "./ignore";
import { groupByFolder, planIsEmpty, type Change, type CompareMode } from "./plan";
import { canChecksum, defaultMirrorName, gitignoreSide, mirrorBlocked, previewMirror, readGitignore, replan, startMirror, type MirrorPreview, type MirrorStatus } from "./run";
import { deleteMirror, markRun, saveMirror, useMirrors, type MirrorConfig, type MirrorEnd, type SavedMirror } from "./store";
import { Cancelled } from "./walk";
import "./mirror.css";

export type MirrorSheetProps = {
  /** where it starts: a folder (and, with two panes, the other pane's folder) */
  src?: MirrorEnd | null;
  dst?: MirrorEnd | null;
  /** open with a saved mirror loaded */
  saved?: SavedMirror | null;
  /** a dry run already made (a one-click run that has deletions to confirm) */
  preview?: MirrorPreview | null;
  onClose: () => void;
  /** the job started (show the jobs list) */
  onStarted?: (jobId: string) => void;
};

type Tab = "upload" | "remove" | "skip";
const n = (c: number) => c.toLocaleString();
const files = (c: number) => `${n(c)} ${c === 1 ? "file" : "files"}`;
const ROWS_MAX = 800;

/** "Web server › public_html › site" */
function endLabel(e: MirrorEnd) {
  const parts = [e.rootName, ...e.dir.split("/").filter(Boolean)].filter(Boolean);
  return { conn: e.connectionName || deviceName(), path: parts.join(" › ") || "/" };
}

function End({ end, label, onPick, picking }: { end: MirrorEnd | null; label: string; onPick?: () => void; picking?: boolean }) {
  const l = end ? endLabel(end) : null;
  return (
    <div className={`mirror-end ${end ? "" : "empty"}`}>
      <span className="mirror-end-k">{label}</span>
      {l ? (
        <span className="mirror-end-v" title={`${l.conn} › ${l.path}`}>
          <strong>{l.conn}</strong>
          <span>{l.path}</span>
        </span>
      ) : (
        <span className="mirror-end-v dim">Not picked yet</span>
      )}
      {onPick && (
        <button className="btn btn-ghost btn-sm mirror-end-pick" onClick={onPick} aria-expanded={picking}>
          {picking ? "Done" : end ? "Change…" : "Choose…"}
        </button>
      )}
    </div>
  );
}

function Rows({ items, tab }: { items: Change[]; tab: Tab }) {
  const groups = useMemo(() => groupByFolder(items.slice(0, ROWS_MAX)), [items]);
  if (!items.length)
    return <div className="mirror-empty">{tab === "upload" ? "Nothing to copy." : tab === "remove" ? "Nothing to delete." : "Nothing skipped."}</div>;
  return (
    <div className="mirror-rows" role="list">
      {groups.map((g) => (
        <div key={g.dir} className="mirror-group">
          <div className="mirror-group-head">
            <Icon name="folder" size={13} />
            <span className="mirror-group-name">{g.dir || "Top folder"}</span>
            <span className="mirror-group-sum">
              {files(g.items.length)}
              {g.bytes > 0 && ` · ${formatBytes(g.bytes)}`}
            </span>
          </div>
          {g.items.map((c) => {
            const name = c.rel.slice(g.dir.length);
            const tag = c.why === "new" ? "new" : c.why === "changed" ? (c.note ?? "changed") : c.why === "gone" ? (c.note ?? "gone from source") : c.why === "same" ? (c.note ?? "unchanged") : c.why === "kept" ? (c.note ?? "only at destination") : (c.note ?? "");
            return (
              <div key={c.rel} className={`mirror-row ${c.why}`} role="listitem" title={c.rel}>
                <FileIcon entry={{ kind: name.endsWith("/") ? "folder" : "file", key: c.rel, name: name.replace(/\/$/, ""), size: c.size, modified: null }} size={15} />
                <span className="mirror-row-name">{name}</span>
                <span className="mirror-row-tag">{tag}</span>
                <span className="mirror-row-size">{name.endsWith("/") ? "" : formatBytes(c.size)}</span>
              </div>
            );
          })}
        </div>
      ))}
      {items.length > ROWS_MAX && <div className="mirror-empty">…and {files(items.length - ROWS_MAX)} more</div>}
    </div>
  );
}

const statusText = (s: MirrorStatus | null) =>
  !s ? "Starting…" : s.phase === "listing-src" ? `Listing the source… ${files(s.done)}` : s.phase === "listing-dst" ? `Listing the destination… ${files(s.done)}` : `Comparing checksums… ${n(s.done)} of ${n(s.total ?? 0)}`;

export function MirrorSheet({ src: src0 = null, dst: dst0 = null, saved: saved0 = null, preview: preview0 = null, onClose, onStarted }: MirrorSheetProps) {
  const savedList = useMirrors();
  const base = saved0 ?? preview0?.config ?? null;
  const [savedId, setSavedId] = useState<string | null>(saved0?.id ?? null);
  const [name, setName] = useState(saved0?.name ?? "");
  const [src, setSrc] = useState<MirrorEnd | null>(base?.src ?? src0);
  const [dst, setDst] = useState<MirrorEnd | null>(base?.dst ?? dst0);
  const [deleteExtra, setDeleteExtra] = useState(base?.deleteExtra ?? false);
  const [compare, setCompare] = useState<CompareMode>(base?.compare ?? "time");
  const [excludes, setExcludes] = useState(base?.excludes ?? DEFAULT_EXCLUDES);
  const [useGitignore, setUseGitignore] = useState(base?.useGitignore ?? true);
  const [picking, setPicking] = useState<"src" | "dst" | null>(!dst0 && !base ? "dst" : null);
  const [caps, setCaps] = useState<{ src: Capabilities | null; dst: Capabilities | null }>({ src: null, dst: null });
  const [gitignore, setGitignore] = useState<string | null>(null);
  const [preview, setPreview] = useState<MirrorPreview | null>(preview0);
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [busy, setBusy] = useState<"preview" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(preview0?.plan.remove.length ? "remove" : "upload");
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const config: MirrorConfig | null = src && dst ? { src, dst, deleteExtra, compare, excludes, useGitignore } : null;
  const key = JSON.stringify(config);
  /** the dry run on screen is for these settings */
  const fresh = !!preview && JSON.stringify(preview.config) === key;
  const blocked = src && dst ? mirrorBlocked(src, dst) : null;
  const checksumOk = canChecksum(caps.src, caps.dst);

  // what each end can do (checksums, a .gitignore on this device)
  useEffect(() => {
    let live = true;
    void Promise.all([src ? capsFor(src.profileId).catch(() => null) : null, dst ? capsFor(dst.profileId).catch(() => null) : null]).then(([s, d]) => {
      if (!live) return;
      setCaps({ src: s, dst: d });
      const side = src && dst ? gitignoreSide({ src, dst } as MirrorConfig, s, d) : null;
      if (!side) return setGitignore(null);
      void readGitignore(side, side === src ? s : d).then((t) => live && setGitignore(t));
    });
    return () => {
      live = false;
    };
  }, [src?.profileId, src?.root, src?.dir, dst?.profileId, dst?.root, dst?.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  const runPreview = async () => {
    if (!config || blocked) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy("preview");
    setError(null);
    setStatus(null);
    try {
      const p = await previewMirror(config, { signal: ctl.signal, onStatus: setStatus });
      if (ctl.signal.aborted) return;
      setPreview(p);
      setTab(p.plan.upload.length || !p.plan.remove.length ? "upload" : "remove");
    } catch (e) {
      if (!(e instanceof Cancelled) && !ctl.signal.aborted) setError(errMessage(e));
    } finally {
      if (abort.current === ctl) {
        abort.current = null;
        setBusy(null);
      }
    }
  };

  // "also delete" and how changes are decided: planned again from the same listings at once
  useEffect(() => {
    if (config && preview && !fresh && !busy) {
      const p = replan(preview, config);
      if (p) setPreview(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // the first dry run starts by itself once both ends are known (and again when they change)
  const ends = JSON.stringify([src, dst]);
  useEffect(() => {
    if (config && !blocked && !picking && !fresh) void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ends, picking]);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (!preview || !fresh) return;
    setBusy("start");
    setError(null);
    try {
      const title = name.trim() || defaultMirrorName(preview.config);
      const id = await startMirror(preview, title);
      if (savedId) markRun(savedId);
      if (id) onStarted?.(id);
      onClose();
    } catch (e) {
      setError(errMessage(e));
      setBusy(null);
    }
  };

  const save = () => {
    if (!config) return;
    const m = saveMirror({ ...config, id: savedId ?? undefined, name: name.trim() || defaultMirrorName(config) });
    setSavedId(m.id);
    setName(m.name);
    setSavedNote(savedId ? "Saved" : "Saved on this device");
    setTimeout(() => setSavedNote(null), 2200);
  };

  const load = (m: SavedMirror) => {
    abort.current?.abort();
    setSavedId(m.id);
    setName(m.name);
    setSrc(m.src);
    setDst(m.dst);
    setDeleteExtra(m.deleteExtra);
    setCompare(m.compare);
    setExcludes(m.excludes);
    setUseGitignore(m.useGitignore);
    setPicking(null);
    setPreview(null);
  };

  const swap = () => {
    setSrc(dst);
    setDst(src);
    setPicking(null);
  };

  const pick = (which: "src" | "dst") => setPicking((p) => (p === which ? null : which));
  /** the dry run to act on: only one made for these exact settings */
  const plan = fresh ? preview!.plan : null;
  /** what the list shows: also a run for other options of these same folders, faded until previewed again */
  const shown = preview && JSON.stringify([preview.config.src, preview.config.dst]) === JSON.stringify([src, dst]) ? preview.plan : null;
  const removes = shown ? shown.remove.length + shown.removeDirs.length : 0;
  const skipItems = useMemo(() => (shown ? [...shown.blocked, ...shown.kept, ...shown.unchanged] : []), [shown]);
  const gitRules = gitignore ? parseRules(gitignore).length : 0;
  const localDst = !!caps.dst?.localPaths;
  const trash = !!caps.dst?.trash || localDst;

  const notes: string[] = [];
  if (shown && preview) {
    const plan = shown;
    if (preview.toleranceMs > 2000 && compare === "time") notes.push("Times within a minute count as the same (FTP servers give minutes).");
    if (plan.offsetMs) notes.push(`The destination's clock or listing is ${Math.abs(plan.offsetMs / 3_600_000)} h ${plan.offsetMs > 0 ? "ahead" : "behind"}; allowed for.`);
    if (preview.dstMissing) notes.push("The destination folder isn't there yet; it's made first.");
    if (compare === "checksum" && plan.checksummed < plan.upload.filter((u) => u.why === "changed").length + plan.same) notes.push("Files without a checksum on both sides were compared by size and date.");
    if (plan.blocked.length) notes.push(`${files(plan.blocked.length)} can't be mirrored: a file and a folder have the same name.`);
  }

  const primary = !fresh ? (
    <button className="btn btn-primary" disabled={!config || !!blocked || busy === "preview" || !!picking} onClick={() => void runPreview()}>
      {busy === "preview" ? "Checking…" : "Preview"}
    </button>
  ) : (
    <button className={`btn ${removes ? "btn-danger" : "btn-primary"}`} disabled={busy === "start" || planIsEmpty(plan!)} onClick={() => void start()}>
      {busy === "start" ? "Starting…" : planIsEmpty(plan!) ? "Up to date" : removes ? `Mirror and delete ${n(removes)}` : "Mirror"}
    </button>
  );

  return (
    <Modal title={saved0 || savedId ? `Mirror · ${name || "saved"}` : "Mirror"} onClose={onClose} width={640}>
      <div className="modal-body mirror-sheet">
        {savedList.length > 0 && (
          <div className="mirror-saved" role="group" aria-label="Saved mirrors">
            <span className="mirror-saved-k">Saved</span>
            {savedList.map((m) => (
              <button key={m.id} className={`mirror-chip ${m.id === savedId ? "on" : ""}`} onClick={() => load(m)} title={`${endLabel(m.src).path} → ${endLabel(m.dst).conn} › ${endLabel(m.dst).path}`}>
                {m.name}
              </button>
            ))}
          </div>
        )}

        <div className="mirror-route">
          <End end={src} label="From" onPick={() => pick("src")} picking={picking === "src"} />
          <button className="mirror-swap" onClick={swap} disabled={!src || !dst} title="Swap direction: pull instead of push" aria-label="Swap direction">
            <Icon name="swap" size={15} />
          </button>
          <End end={dst} label="To" onPick={() => pick("dst")} picking={picking === "dst"} />
        </div>
        {picking && (
          <LocationPicker
            className="mirror-picker"
            value={picking === "src" ? src : dst}
            blocked={(loc) => {
              const other = picking === "src" ? dst : src;
              return other ? mirrorBlocked(loc, other) : null;
            }}
            onChange={(p) => (picking === "src" ? setSrc(p) : setDst(p))}
          />
        )}
        {blocked && (
          <div className="jobs-summary bad">
            <Icon name="alert" size={13} /> {blocked}
          </div>
        )}

        <div className="mirror-opts">
          <label className="mirror-check">
            <input type="checkbox" checked readOnly disabled />
            <span>Upload new and changed files</span>
          </label>
          <label className="mirror-check">
            <input
              type="checkbox"
              checked={deleteExtra}
              onChange={(e) => {
                setDeleteExtra(e.target.checked);
                setTab(e.target.checked ? "remove" : "upload");
              }}
            />
            <span>Also delete what's gone from the source</span>
          </label>
          {deleteExtra && (
            <div className="mirror-warn" role="note">
              <Icon name="alert" size={14} />
              <span>
                Files at the destination that aren't in the source are deleted{trash && localDst ? " (to the Trash)" : ""}, so it ends up exactly like the source. Excluded files are left
                alone. Check the list before you mirror.
              </span>
            </div>
          )}
          <label className="mirror-field">
            <span>Changed means</span>
            <select value={compare} onChange={(e) => setCompare(e.target.value as CompareMode)}>
              <option value="time">Another size, or modified more recently</option>
              <option value="size">Another size</option>
              <option value="checksum" disabled={!checksumOk}>
                Different checksum (MD5){checksumOk ? "" : " – not on these connections"}
              </option>
            </select>
          </label>
          <label className="mirror-field top">
            <span>
              Leave out
              <small>Like a .gitignore, one per line</small>
            </span>
            <textarea value={excludes} rows={4} spellCheck={false} autoCorrect="off" autoCapitalize="off" onChange={(e) => setExcludes(e.target.value)} />
          </label>
          {gitignore != null && (
            <label className="mirror-check indent">
              <input type="checkbox" checked={useGitignore} onChange={(e) => setUseGitignore(e.target.checked)} />
              <span>
                Also leave out what the folder's .gitignore lists
                <small>
                  {n(gitRules)} {gitRules === 1 ? "rule" : "rules"}
                </small>
              </span>
            </label>
          )}
        </div>

        <div className={`mirror-preview ${fresh ? "" : "stale"}`} aria-live="polite">
          {busy === "preview" ? (
            <div className="mirror-status">
              <span className="spinner" /> {statusText(status)}
            </div>
          ) : (
            !plan && (
              <div className="mirror-status dim">
                {!config ? "Pick both folders to see what would change." : shown ? "Settings changed. Preview again to update this list." : "Preview shows exactly what would change before anything does."}
              </div>
            )
          )}
          {shown && (
            <div className={`mirror-result ${plan ? "" : "faded"}`}>
              <div className="mirror-tabs" role="tablist">
                <button role="tab" aria-selected={tab === "upload"} className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>
                  <Icon name="upload" size={13} /> Copy <b>{n(shown.upload.length)}</b>
                  <small>{formatBytes(shown.uploadBytes)}</small>
                </button>
                <button role="tab" aria-selected={tab === "remove"} className={`${tab === "remove" ? "on" : ""} ${removes ? "danger" : ""}`} onClick={() => setTab("remove")}>
                  <Icon name="trash" size={13} /> Delete <b>{n(removes)}</b>
                  {shown.removeBytes > 0 && <small>{formatBytes(shown.removeBytes)}</small>}
                </button>
                <button role="tab" aria-selected={tab === "skip"} className={tab === "skip" ? "on" : ""} onClick={() => setTab("skip")}>
                  <Icon name="check" size={13} /> Skip <b>{n(skipItems.length)}</b>
                </button>
                <span className="mirror-excl" title="Left out by the exclude rules, on both sides">
                  {n(shown.excluded)} excluded
                </span>
              </div>
              <Rows items={tab === "upload" ? [...shown.mkdirs.map((rel): Change => ({ rel, size: 0, why: "new", note: "new folder" })), ...shown.upload] : tab === "remove" ? [...shown.remove, ...shown.removeDirs.map((rel): Change => ({ rel, size: 0, why: "gone", note: "folder, once empty" }))] : skipItems} tab={tab} />
              {!deleteExtra && shown.kept.length > 0 && tab !== "skip" && (
                <div className="mirror-note">
                  {files(shown.kept.length)} only at the destination stay. Turn on “Also delete” to remove them.
                </div>
              )}
              {notes.map((t) => (
                <div key={t} className="mirror-note">
                  {t}
                </div>
              ))}
            </div>
          )}
        </div>
        {error && <ErrorText message={error} />}
      </div>
      <div className="modal-foot split">
        <div className="mirror-save">
          <input
            type="text"
            value={name}
            placeholder={config ? defaultMirrorName(config) : "Name, to save it"}
            aria-label="Name of this mirror"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <button className="btn" disabled={!config || !!blocked} onClick={save} title="Keep it to run again with one click (on this device)">
            {savedNote ?? (savedId ? "Update" : "Save")}
          </button>
          {savedId && (
            <button
              className="btn btn-ghost"
              title="Forget this saved mirror"
              aria-label="Forget this saved mirror"
              onClick={() => {
                deleteMirror(savedId);
                setSavedId(null);
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {primary}
        </div>
      </div>
    </Modal>
  );
}
