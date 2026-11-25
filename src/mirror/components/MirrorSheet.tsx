/**
 * The Mirror sheet: source → destination (swap to pull instead of push), what to do, how
 * "changed" is decided, what to leave out, and a dry run of exactly what will be copied and
 * deleted, grouped by folder. "Mirror" then runs that as one job. Mirrors can be saved by name
 * and loaded again from the Saved menu at the bottom; the options fold to one line.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errMessage, type Capabilities } from "../../core/api";
import { Icon } from "../../ui/components/Icons";
import { Modal } from "../../ui/components/Dialogs";
import { ErrorText } from "../../ui/components/ErrorText";
import { FileIcon } from "../../browser/components/list/FileIcon";
import { formatBytes } from "../../core/format";
import { LocationPicker, deviceName } from "../../jobs/components/LocationPicker";
import { capsFor } from "../../core/useCaps";
import { DEFAULT_EXCLUDES, parseRules } from "../lib/ignore";
import { groupByFolder, planIsEmpty, type Change, type CompareMode } from "../lib/plan";
import { canChecksum, defaultMirrorName, gitignoreSide, mirrorBlocked, previewMirror, readGitignore, replan, startMirror, type MirrorPreview, type MirrorStatus } from "../lib/run";
import { deleteMirror, markRun, saveMirror, useMirrors, type MirrorConfig, type MirrorEnd, type SavedMirror } from "../lib/store";
import { Cancelled } from "../lib/walk";
import "./mirror.css";
import { ON_OS } from "../../core/osNames";

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
/** How long a preview may be acted on before it is checked again. */
const PREVIEW_MS = 5 * 60_000;

/** "Web server /public_html/site" (the saved list's tooltips) */
const endText = (e: MirrorEnd) => `${e.connectionName || deviceName()} ${endPath(e)}`;

/** The folder as a path: "/Users/demo/Sites/acme", "media/photos", "/". */
function endPath(e: MirrorEnd) {
  const dir = e.dir.replace(/\/+$/, "");
  const root = e.rootName === "/" ? "" : e.rootName.replace(/\/+$/, "");
  return root ? (dir ? `${root}/${dir}` : root) : "/" + dir;
}

function End({ end, label, onPick, picking, rowRef }: { end: MirrorEnd | null; label: string; onPick: () => void; picking: boolean; rowRef: React.Ref<HTMLDivElement> }) {
  return (
    <div className={`mirror-end ${picking ? "picking" : ""}`} ref={rowRef}>
      <span className="mirror-end-k">{label}</span>
      {end ? (
        <span className="mirror-end-v" title={`${end.connectionName || deviceName()} · ${endPath(end)}`}>
          <strong>{end.connectionName || deviceName()}</strong>
          <span className="mirror-end-path">{"\u200e" + endPath(end)}</span>
        </span>
      ) : (
        <span className="mirror-end-v dim">Not picked yet</span>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onPick} aria-expanded={picking}>
        {end ? "Change" : "Choose"}
      </button>
    </div>
  );
}

/**
 * The folder tree as a dropdown hanging from the end being changed (fixed, so the sheet's
 * scrolling body doesn't clip it), with the pick and Done at its foot. Escape or a click outside
 * closes it.
 */
function PickPop({ anchor, end, onClose, children }: { anchor: HTMLElement | null; end: MirrorEnd | null; onClose: () => void; children: React.ReactNode }) {
  const [box, setBox] = useState<React.CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const top = r.bottom + 4;
      setBox({ top, left: r.left, width: r.width, height: Math.max(220, Math.min(420, window.innerHeight - top - 16)) });
    };
    place();
    // the sheet may still be animating in: measured again once it has settled
    const t = setTimeout(place, 260);
    window.addEventListener("resize", place);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  useEffect(() => {
    // Escape closes the dropdown, not the sheet under it
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  if (!box) return null;
  return (
    <>
      <div className="mirror-pop-veil" onMouseDown={onClose} />
      <div className="mirror-pop" style={box} role="dialog" aria-label="Choose a folder">
        {children}
        <div className="mirror-pop-foot">
          <span className="mirror-pop-pick" title={end ? `${end.connectionName || deviceName()} ${endPath(end)}` : undefined}>
            {end ? (
              <>
                <strong>{end.connectionName || deviceName()}</strong> <span className="mirror-end-path">{"\u200e" + endPath(end)}</span>
              </>
            ) : (
              "Pick a folder"
            )}
          </span>
          <button className="btn btn-primary btn-sm" disabled={!end} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
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
  /** the options, folded to one line until opened (open when a saved mirror deletes) */
  const [optsOpen, setOptsOpen] = useState(false);
  /** the name being typed, to save (or rename) */
  const [naming, setNaming] = useState<string | null>(null);
  const [savedMenu, setSavedMenu] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const config: MirrorConfig | null = src && dst ? { src, dst, deleteExtra, compare, excludes, useGitignore } : null;
  const key = JSON.stringify(config);
  /** the dry run on screen is for these settings */
  // a dry run is only good for a while: the folders change under an open sheet, and the job
  // deletes exactly what the list says
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!preview) return;
    const t = setTimeout(() => setExpired(true), PREVIEW_MS);
    return () => clearTimeout(t);
    // the listings are what ages; planning them again for other options doesn't make them newer
  }, [preview?.lists]);
  const fresh = !!preview && !expired && JSON.stringify(preview.config) === key;
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

  // "also delete" and how changes are decided: planned again from the same listings at once, but
  // never into a plan that deletes: the old listings may not show what is there now
  useEffect(() => {
    if (config && preview && !expired && !fresh && !busy && !config.deleteExtra) {
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

  const save = (as = name) => {
    if (!config) return;
    const m = saveMirror({ ...config, id: savedId ?? undefined, name: as.trim() || defaultMirrorName(config) });
    setSavedId(m.id);
    setName(m.name);
    setNaming(null);
    setSavedNote("Saved");
    setTimeout(() => setSavedNote(null), 1800);
  };
  const savedNow = savedList.find((m) => m.id === savedId) ?? null;
  /** the settings differ from the saved mirror's */
  const dirty = !!savedNow && !!config && JSON.stringify([savedNow.src, savedNow.dst, savedNow.deleteExtra, savedNow.compare, savedNow.excludes, savedNow.useGitignore]) !== JSON.stringify([config.src, config.dst, config.deleteExtra, config.compare, config.excludes, config.useGitignore]);

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

  /** back to a mirror of the folders it opened with, not saved */
  const startNew = () => {
    abort.current?.abort();
    setSavedId(null);
    setName("");
    setSrc(src0);
    setDst(dst0);
    setDeleteExtra(false);
    setCompare("time");
    setExcludes(DEFAULT_EXCLUDES);
    setUseGitignore(true);
    setPicking(dst0 ? null : "dst");
    setPreview(null);
  };

  const swap = () => {
    setSrc(dst);
    setDst(src);
    setPicking(null);
  };

  const pick = (which: "src" | "dst") => setPicking((p) => (p === which ? null : which));
  const closePick = useCallback(() => setPicking(null), []);
  const [srcRow, setSrcRow] = useState<HTMLDivElement | null>(null);
  const [dstRow, setDstRow] = useState<HTMLDivElement | null>(null);
  /** the dry run to act on: only one made for these exact settings */
  const plan = fresh ? preview!.plan : null;
  /** what the list shows: also a run for other options of these same folders, faded until previewed again */
  const shown = preview && JSON.stringify([preview.config.src, preview.config.dst]) === JSON.stringify([src, dst]) ? preview.plan : null;
  const removes = shown ? shown.remove.length + shown.removeDirs.length : 0;
  const skipItems = useMemo(() => (shown ? [...shown.blocked, ...shown.links, ...shown.kept, ...shown.unchanged] : []), [shown]);
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
    if (plan.links.length) notes.push("Links are left alone: nothing at or behind a link is copied or deleted.");
  }

  const primary = !fresh ? (
    <button className="btn btn-primary" disabled={!config || !!blocked || busy === "preview" || !!picking} onClick={() => void runPreview()}>
      {busy === "preview" ? "Checking…" : "Check"}
    </button>
  ) : (
    planIsEmpty(plan!) ? (
      <button className="btn btn-primary" onClick={onClose}>
        Done
      </button>
    ) : (
      <button className={`btn ${removes ? "btn-danger" : "btn-primary"}`} disabled={busy === "start"} onClick={() => void start()}>
        {busy === "start" ? "Starting…" : removes ? `Mirror and delete ${n(removes)}` : `Mirror ${files(plan!.upload.length)}`}
      </button>
    )
  );

  const excl = excludes.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const optsSummary = [
    deleteExtra ? null : "Copies new and changed files",
    compare === "size" ? "by size" : compare === "checksum" ? "by checksum" : null,
    excl.length ? `leaves out ${excl.length === 1 ? excl[0] : `${excl.length} patterns`}` : null,
  ].filter(Boolean).join(" · ");
  const empty = !!plan && planIsEmpty(plan);

  return (
    <Modal title={savedId ? name || "Mirror" : "Mirror"} onClose={onClose} width={620} help="mirror">
      <div className="modal-body mirror-sheet">
        <div className="mirror-route">
          <End end={src} label="From" onPick={() => pick("src")} picking={picking === "src"} rowRef={setSrcRow} />
          <button className="mirror-swap" onClick={swap} disabled={!src || !dst} title="Swap: copy the other way" aria-label="Swap direction">
            <Icon name="sort" size={14} />
          </button>
          <End end={dst} label="To" onPick={() => pick("dst")} picking={picking === "dst"} rowRef={setDstRow} />
        </div>
        {picking && (
          <PickPop anchor={picking === "src" ? srcRow : dstRow} end={picking === "src" ? src : dst} onClose={closePick}>
            <LocationPicker
              search
              className="mirror-picker"
              value={picking === "src" ? src : dst}
              blocked={(loc) => {
                const other = picking === "src" ? dst : src;
                return other ? mirrorBlocked(loc, other) : null;
              }}
              onChange={(p) => (picking === "src" ? setSrc(p) : setDst(p))}
            />
          </PickPop>
        )}
        {blocked && (
          <div className="jobs-summary bad">
            <Icon name="alert" size={13} /> {blocked}
          </div>
        )}

        <div className="mirror-opts-wrap">
          <button className="mirror-opts-head" aria-expanded={optsOpen} onClick={() => setOptsOpen((o) => !o)}>
            <Icon name={optsOpen ? "chevron-down" : "chevron"} size={13} />
            <span className="mirror-opts-k">Options</span>
            {!optsOpen && (
              <span className="mirror-opts-sum">
                {deleteExtra && <b>Makes it exactly like the source (deletes extras){optsSummary ? " · " : ""}</b>}
                {optsSummary}
              </span>
            )}
          </button>
          {optsOpen && (
            <div className="mirror-opts">
              <div className="set-row">
                <div className="set-label">
                  Delete what isn't in the source
                  <small>The destination ends up exactly like the source{trash && localDst ? `; deleted files go to the ${ON_OS.trash}` : ""}. Left-out files stay.</small>
                </div>
                <button
                  className={`switch ${deleteExtra ? "on" : ""}`}
                  role="switch"
                  aria-checked={deleteExtra}
                  aria-label="Delete what isn't in the source"
                  onClick={() => {
                    setDeleteExtra(!deleteExtra);
                    setTab(!deleteExtra ? "remove" : "upload");
                  }}
                />
              </div>
              <div className="set-row">
                <div className="set-label">
                  Copy a file when
                  <small>{checksumOk ? "Checksums are exact, but slower." : config ? "These connections can't compare checksums." : "Size and date is quick and works everywhere."}</small>
                </div>
                <select value={compare} aria-label="Copy a file when" onChange={(e) => setCompare(e.target.value as CompareMode)}>
                  <option value="time">Size or date differs</option>
                  <option value="size">Size differs</option>
                  <option value="checksum" disabled={!checksumOk}>
                    Checksum differs
                  </option>
                </select>
              </div>
              <div className="set-row stack">
                <div className="set-label">
                  Leave out
                  <small>One per line, like a .gitignore. Never copied or deleted.</small>
                </div>
                <textarea value={excludes} rows={3} aria-label="Leave out" spellCheck={false} autoCorrect="off" autoCapitalize="off" onChange={(e) => setExcludes(e.target.value)} />
              </div>
              {gitignore != null && (
                <div className="set-row">
                  <div className="set-label">
                    Also leave out what .gitignore lists
                    <small>
                      The folder's own .gitignore, {n(gitRules)} {gitRules === 1 ? "rule" : "rules"}.
                    </small>
                  </div>
                  <button className={`switch ${useGitignore ? "on" : ""}`} role="switch" aria-checked={useGitignore} aria-label="Also leave out what .gitignore lists" onClick={() => setUseGitignore(!useGitignore)} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className={`mirror-preview ${fresh ? "" : "stale"}`} aria-live="polite">
          {busy === "preview" ? (
            <div className="mirror-status">
              <span className="spinner" /> {statusText(status)}
            </div>
          ) : empty ? (
            <div className="mirror-status ok">
              <Icon name="check" size={15} /> Already the same. Nothing to copy{deleteExtra ? " or delete" : ""}.
              {shown!.excluded > 0 && <span className="mirror-excl">{n(shown!.excluded)} left out</span>}
            </div>
          ) : (
            !plan && (
              <div className="mirror-status dim">
                {!config ? "Choose both folders to see what would change." : shown ? "Options changed. Check again to see what would change." : "Nothing changes until you look at the list and mirror."}
              </div>
            )
          )}
          {plan && shown && !empty && busy !== "preview" && (
            <div className="mirror-result">
              <div className="mirror-tabs" role="tablist">
                <button role="tab" aria-selected={tab === "upload"} className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>
                  Copy <b>{n(shown.upload.length)}</b>
                  {shown.uploadBytes > 0 && <small>{formatBytes(shown.uploadBytes)}</small>}
                </button>
                {(deleteExtra || removes > 0) && (
                  <button role="tab" aria-selected={tab === "remove"} className={`${tab === "remove" ? "on" : ""} ${removes ? "danger" : ""}`} onClick={() => setTab("remove")}>
                    Delete <b>{n(removes)}</b>
                    {shown.removeBytes > 0 && <small>{formatBytes(shown.removeBytes)}</small>}
                  </button>
                )}
                <button role="tab" aria-selected={tab === "skip"} className={tab === "skip" ? "on" : ""} onClick={() => setTab("skip")}>
                  Same <b>{n(skipItems.length)}</b>
                </button>
                {shown.excluded > 0 && (
                  <span className="mirror-excl" title="Left out by the Leave out list, on both sides">
                    {n(shown.excluded)} left out
                  </span>
                )}
              </div>
              <Rows items={tab === "upload" ? [...shown.mkdirs.map((rel): Change => ({ rel, size: 0, why: "new", note: "new folder" })), ...shown.upload] : tab === "remove" ? [...shown.remove, ...shown.removeDirs.map((rel): Change => ({ rel, size: 0, why: "gone", note: "folder, once empty" }))] : skipItems} tab={tab} />
              {!deleteExtra && shown.kept.length > 0 && tab !== "skip" && <div className="mirror-note">{files(shown.kept.length)} only at the destination stay there.</div>}
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
          {naming != null ? (
            <>
              <input
                type="text"
                autoFocus
                value={naming}
                placeholder={config ? defaultMirrorName(config) : "Name"}
                aria-label="Name of this mirror"
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save(naming);
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setNaming(null);
                  }
                }}
              />
              <button className="btn" onClick={() => save(naming)}>
                Save
              </button>
              <button className="btn btn-ghost" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {(savedList.length > 0 || savedId) && (
                <div className="mirror-saved-wrap">
                  <button className="btn btn-ghost" aria-expanded={savedMenu} onClick={() => setSavedMenu((o) => !o)}>
                    <Icon name="star" size={14} /> Saved <Icon name="chevron-down" size={12} />
                  </button>
                  {savedMenu && (
                    <>
                      <div className="mirror-menu-veil" onClick={() => setSavedMenu(false)} />
                      <div className="mirror-menu" role="menu">
                        <button
                          role="menuitem"
                          className={savedId ? "" : "on"}
                          onClick={() => {
                            setSavedMenu(false);
                            if (savedId) startNew();
                          }}
                        >
                          <Icon name={savedId ? "plus" : "check"} size={13} />
                          <span>New mirror</span>
                        </button>
                        <div className="mirror-menu-sep" />
                        {savedList.map((m) => (
                          <button
                            key={m.id}
                            role="menuitem"
                            className={m.id === savedId ? "on" : ""}
                            title={`${endText(m.src)} → ${endText(m.dst)}`}
                            onClick={() => {
                              setSavedMenu(false);
                              load(m);
                            }}
                          >
                            <Icon name={m.id === savedId ? "check" : "star"} size={13} />
                            <span>{m.name}</span>
                          </button>
                        ))}
                        {savedId && (
                          <>
                            <div className="mirror-menu-sep" />
                            <button role="menuitem" onClick={() => (setSavedMenu(false), setNaming(name))}>
                              <Icon name="edit" size={13} />
                              <span>Rename…</span>
                            </button>
                            <button
                              role="menuitem"
                              className="danger"
                              onClick={() => {
                                setSavedMenu(false);
                                deleteMirror(savedId);
                                setSavedId(null);
                                setName("");
                              }}
                            >
                              <Icon name="trash" size={13} />
                              <span>Forget this one</span>
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
              {savedNote ? (
                <span className="mirror-saved-note">
                  <Icon name="check" size={13} /> {savedNote}
                </span>
              ) : savedId ? (
                dirty && (
                  <button className="btn btn-ghost" onClick={() => save()}>
                    Save changes
                  </button>
                )
              ) : (
                <button className="btn btn-ghost" disabled={!config || !!blocked} onClick={() => setNaming("")} title="Keep it, to run again with one click">
                  Save…
                </button>
              )}
            </>
          )}
        </div>
        <div className="btn-row">
          {!empty && (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          {primary}
        </div>
      </div>
    </Modal>
  );
}
