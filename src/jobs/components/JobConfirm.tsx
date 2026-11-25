/**
 * F5 / F6 between two panes on different connections: a short confirm, like Total Commander's,
 * with the destination folder editable in place and what to do with files already there. The
 * full dialog (any destination, all options) is one click away.
 */
import { useState } from "react";
import { errMessage, type JobConflict, type JobSpec } from "../../core/api";
import { Icon } from "../../ui/components/Icons";
import { Modal } from "../../ui/components/Dialogs";
import { ErrorText } from "../../ui/components/ErrorText";
import { blockedReason, CONFLICTS, loadJobOptions, saveJobOptions, startJobs } from "./MigrationDialog";
import { locLabel, type PickedLocation } from "./LocationPicker";
import { useSourceSummary, type MigrationSource } from "../hooks/useSourceSummary";
import "./jobs.css";

/** "photos//2026" → "photos/2026/", "" stays "" (the top of the root). */
export function normalizeDir(input: string): string {
  const parts = input
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== ".");
  return parts.length ? `${parts.join("/")}/` : "";
}

export function JobConfirm({
  source,
  mode,
  dest,
  onClose,
  onStarted,
  onMoreOptions,
  singleRoot = false,
}: {
  source: MigrationSource;
  mode: "copy" | "move";
  /** the other pane's folder, with the names to show */
  dest: PickedLocation;
  onClose: () => void;
  onStarted?: (id: string, spec: JobSpec) => void;
  /** opens the full dialog at the folder typed so far (this confirm has closed) */
  onMoreOptions?: (dir: string) => void;
  /** the destination connection has one root (SFTP, WebDAV…): its name is left out of the path */
  singleRoot?: boolean;
}) {
  const s = useSourceSummary(source, mode);
  const [dir, setDir] = useState(dest.dir);
  const [opts, setOpts] = useState(loadJobOptions);
  const [starting, setStarting] = useState(false);
  // jobs created on an earlier try that failed part way (see `startJobs`)
  const [startedJobs] = useState(() => new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const target: PickedLocation = { ...dest, dir: normalizeDir(dir) };
  const why = blockedReason(source, target);
  const conflict = CONFLICTS.find((c) => c.id === opts.conflict) ?? CONFLICTS[0];
  // the part of the path that can't be typed over: the connection and its root
  const fixed = singleRoot ? `${dest.connectionName} /` : `${dest.connectionName} / ${dest.rootName} /`;

  const setConflict = (c: JobConflict) =>
    setOpts((o) => {
      const n = { ...o, conflict: c };
      saveJobOptions(n);
      return n;
    });

  const start = async () => {
    if (why || starting) return;
    setStarting(true);
    setError(null);
    try {
      const { id, spec } = await startJobs(source, mode, target, opts, s.what, startedJobs);
      onStarted?.(id, spec);
      onClose();
    } catch (e) {
      setError(errMessage(e));
      setStarting(false);
    }
  };

  return (
    <Modal title={`${s.Verb} ${s.what}?`} onClose={onClose} width={520}>
      <form
        className="modal-body jobs-dialog jobs-confirm"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <p className="jobs-confirm-what">
          {s.Verb} {s.what}
          {s.amount}
          {s.from && (
            <>
              {" "}
              from <strong>{s.from}</strong>
            </>
          )}{" "}
          to:
        </p>
        <label className="jobs-confirm-path" title={locLabel(target)}>
          <span className="jobs-confirm-fixed">{fixed}</span>
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="(top level)"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Destination folder"
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <label className="jobs-field">
          <span>If a file is already there</span>
          <select value={opts.conflict} onChange={(e) => setConflict(e.target.value as JobConflict)}>
            {CONFLICTS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className={`jobs-summary ${why ? "bad" : ""}`} aria-live="polite">
          {why ? (
            <span>
              <Icon name="alert" size={13} /> {why}
            </span>
          ) : (
            <span>
              {conflict.hint} {target.dir !== dest.dir && "Folders that aren't there yet are made. "}
              It runs in the background, even with the window closed.
              {mode === "move" && " Originals are deleted once each copy is checked."}
            </span>
          )}
        </div>
        {error && <ErrorText message={error} />}
        {/* Enter in the path field starts it */}
        <button type="submit" hidden />
      </form>
      <div className="modal-foot split">
        {onMoreOptions ? (
          <button
            className="btn btn-ghost"
            onClick={() => {
              onClose();
              onMoreOptions(target.dir);
            }}
          >
            More options…
          </button>
        ) : (
          <span />
        )}
        <div className="btn-row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!why || starting} onClick={() => void start()}>
            {starting ? "Starting…" : s.Verb}
          </button>
        </div>
      </div>
    </Modal>
  );
}
