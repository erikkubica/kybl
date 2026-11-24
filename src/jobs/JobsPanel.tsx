/**
 * The list of copies and moves between connections: progress, speed, time left, pause, resume,
 * stop, and the files that couldn't be copied with a way to try them again.
 */
import { useEffect, useRef, useState } from "react";
import { errMessage, errSummary, type JobFailure, type JobProgress, type JobSummary } from "../api";
import { Icon, type IconName } from "../Icons";
import { ErrorText } from "../components/ErrorText";
import { formatBytes, formatEta, formatSpeed } from "../format";
import { isFinished, migrations, useMigrations } from "./useMigrations";
import "./jobs.css";

const PAGE = 50;

const n = (x: number) => x.toLocaleString();
const files = (x: number) => `${n(x)} ${x === 1 ? "file" : "files"}`;

const BADGE: Record<JobProgress["state"], { label: string; tone: "" | "accent" | "ok" | "bad" | "warn" }> = {
  planning: { label: "Getting ready", tone: "accent" },
  running: { label: "Copying", tone: "accent" },
  paused: { label: "Paused", tone: "" },
  waitingNetwork: { label: "Waiting for Wi-Fi", tone: "warn" },
  needsAuth: { label: "Sign in again", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Stopped by a problem", tone: "bad" },
  cancelled: { label: "Stopped", tone: "" },
};

function badge(j: JobSummary) {
  const p = j.progress;
  if (p.state === "running" && p.phase === "deleting") return { label: "Removing originals", tone: "accent" as const };
  if (p.state === "running" && j.spec.mode === "move") return { label: "Moving", tone: "accent" as const };
  if (p.state === "done" && p.filesFailed > 0) return { label: "Done, with problems", tone: "warn" as const };
  return BADGE[p.state];
}

function icon(j: JobSummary): IconName {
  switch (j.progress.state) {
    case "done":
      return j.progress.filesFailed > 0 ? "alert" : "check-circle";
    case "failed":
    case "needsAuth":
      return "alert";
    case "cancelled":
      return "x";
    case "paused":
      return "pause";
    case "waitingNetwork":
      return "clock";
    default:
      return j.spec.mode === "move" ? "move" : "copy";
  }
}

/** One line on how far it got. */
/** "7 of 10 files": every file dealt with so far (copied, already there or failed), Jobs and Activity alike. */
export const jobFilesCount = (p: JobProgress) => `${n(p.filesDone + p.filesSkipped + p.filesFailed)} of ${files(p.filesTotal)}`;

export function jobMeta(j: JobSummary): string {
  const p = j.progress;
  const moved = j.spec.mode === "move" ? "moved" : "copied";
  const counts = p.filesTotal > 0 ? jobFilesCount(p) : "";
  const bytes = p.bytesTotal > 0 ? `${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}` : "";
  switch (p.state) {
    case "planning":
      return p.filesTotal > 0 ? `Finding files… ${n(p.filesTotal)} so far` : "Finding files…";
    case "running": {
      const parts = [counts, bytes];
      if (p.rateBps > 0) parts.push(formatSpeed(p.rateBps));
      if (p.etaSecs != null && p.etaSecs > 0) parts.push(`${formatEta(p.etaSecs)} left`);
      return parts.filter(Boolean).join(" · ");
    }
    case "paused":
    case "waitingNetwork":
    case "needsAuth":
      return [counts, bytes].filter(Boolean).join(" · ");
    case "done": {
      // a mirror's deletions count as files done too: split them out when they all went
      const del = j.spec.mirror?.deletes ?? 0;
      const split = del > 0 && p.filesFailed === 0 && p.filesDone >= del;
      const parts = [`${files(split ? p.filesDone - del : p.filesDone)} ${moved}${p.bytesDone > 0 ? ` (${formatBytes(p.bytesDone)})` : ""}`];
      if (split) parts.push(`${n(del)} deleted`);
      if (p.filesSkipped > 0) parts.push(`${n(p.filesSkipped)} already there`);
      return parts.join(" · ");
    }
    case "cancelled":
      return p.filesDone > 0 ? `${files(p.filesDone)} ${moved} before stopping` : `Nothing was ${moved}`;
    case "failed":
      return p.filesDone > 0 ? `${files(p.filesDone)} ${moved} before it stopped` : "";
  }
}

/** Planning has no total yet; afterwards bytes, or files when sizes are unknown. */
function fraction(p: JobProgress): number | null {
  if (p.state === "planning") return null;
  if (p.state === "done") return 1;
  if (p.bytesTotal > 0) return Math.min(1, p.bytesDone / p.bytesTotal);
  if (p.filesTotal > 0) return Math.min(1, (p.filesDone + p.filesSkipped + p.filesFailed) / p.filesTotal);
  return 0;
}

function Failures({ job }: { job: JobSummary }) {
  const [list, setList] = useState<JobFailure[] | null>(null);
  const [end, setEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // more problems came while a page was loading: once it is in, fetch what it missed
  const inFlight = useRef(false);
  const recheck = useRef(false);
  // each load's number: a page that comes back after a newer load started (a retry reloading from
  // the top while "Show more" was out) is dropped, not appended to the fresh list
  const seq = useRef(0);
  const load = async (offset: number) => {
    const my = ++seq.current;
    setLoading(true);
    inFlight.current = true;
    let reached: number | null = null;
    try {
      const page = await migrations.failures(job.id, offset, PAGE);
      if (my !== seq.current) return;
      setList((cur) => (offset === 0 ? page : [...(cur ?? []), ...page]));
      setEnd(page.length < PAGE);
      setError(null);
      if (page.length < PAGE) reached = offset + page.length;
    } catch (e) {
      if (my === seq.current) setError(errMessage(e));
    } finally {
      // a newer load owns the busy state and the catch-up
      if (my === seq.current) {
        setLoading(false);
        inFlight.current = false;
        if (recheck.current) {
          recheck.current = false;
          if (reached !== null && reached < seen.current.failed) void load(reached);
        }
      }
    }
  };
  // follow the number of problems: fewer (a retry) loads afresh; more while running adds the new
  // ones at the end when everything was listed, and otherwise waits for "Show more", so pages
  // already open stay where they are
  const seen = useRef({ id: "", failed: 0 });
  const shown = useRef({ count: 0, end: false });
  shown.current = { count: list?.length ?? 0, end };
  useEffect(() => {
    const failed = job.progress.filesFailed;
    const before = seen.current;
    seen.current = { id: job.id, failed };
    if (before.id !== job.id || failed < before.failed) void load(0);
    else if (failed > before.failed && inFlight.current) recheck.current = true;
    else if (failed > before.failed && shown.current.end) void load(shown.current.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, job.progress.filesFailed]);

  return (
    <div className="jobs-failures">
      {error && <ErrorText message={error} />}
      {list === null && !error && (
        <div className="jobs-failure muted">
          <span className="spinner" /> Loading…
        </div>
      )}
      {list?.map((f) => (
        <div key={f.path} className="jobs-failure" title={f.error}>
          <span className="jobs-failure-path">{f.path}</span>
          <span className="jobs-failure-err">{errSummary(f.error)}</span>
        </div>
      ))}
      {list && !end && (
        <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load(list.length)}>
          Show more
        </button>
      )}
    </div>
  );
}

function JobRow({ job, onOpenDest }: { job: JobSummary; onOpenDest?: (j: JobSummary) => void }) {
  const p = job.progress;
  const [confirmStop, setConfirmStop] = useState(false);
  const [showFailures, setShowFailures] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const b = badge(job);
  const frac = fraction(p);
  const meta = jobMeta(job);
  const finished = isFinished(job);
  const canPause = p.state === "running" || p.state === "planning" || p.state === "waitingNetwork";
  // a failed one resumes when nothing in it failed on its own (it stopped while listing, or while
  // removing originals after every file was copied: no count shows that) or when files are left
  const canResume = p.state === "paused" || p.state === "needsAuth" || (p.state === "failed" && (p.filesFailed === 0 || p.filesDone + p.filesSkipped < p.filesTotal));

  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 4000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  const run = (f: () => Promise<void>) => () => {
    setError(null);
    f().catch((e) => setError(errMessage(e)));
  };

  return (
    <div className={`jobs-row st-${p.state}`}>
      <span className={`jobs-icon tone-${b.tone}`}>
        <Icon name={icon(job)} size={15} />
      </span>
      <div className="jobs-main">
        <div className="jobs-line">
          <span className="jobs-title" title={job.title}>
            {job.title}
          </span>
          <span className={`pill ${b.tone}`}>{b.label}</span>
        </div>
        {!finished && (
          <div className={`bar ${frac === null ? "indeterminate" : ""}`}>
            <div style={{ width: `${Math.round((frac ?? 0) * 100)}%` }} />
          </div>
        )}
        {meta && <div className="jobs-meta">{meta}</div>}
        {p.state === "running" && p.current.length > 0 && (
          <div className="jobs-current" title={p.current.join("\n")}>
            {p.current[0]}
            {p.current.length > 1 && <span className="jobs-faint"> and {p.current.length - 1} more</span>}
          </div>
        )}
        {p.error && (p.state === "failed" || p.state === "needsAuth" || p.state === "waitingNetwork") && (
          <div className={`jobs-note ${p.state === "failed" ? "bad" : ""}`}>
            {p.state === "waitingNetwork" ? "It carries on by itself once you're on Wi-Fi." : p.state === "needsAuth" ? "Sign in to this connection again, then press Resume." : null}
            {p.state === "failed" && <ErrorText message={p.error} />}
          </div>
        )}
        {p.filesFailed > 0 && (
          <div className="jobs-problems">
            <button className="jobs-link" onClick={() => setShowFailures((s) => !s)} aria-expanded={showFailures}>
              <Icon name="chevron" size={10} className={`jobs-caret ${showFailures ? "open" : ""}`} />
              {files(p.filesFailed)} couldn't be {job.spec.mode === "move" ? "moved" : "copied"}
            </button>
            {/* a stopped copy can't be retried (the backend refuses): start a new one instead */}
            {(finished || p.state === "paused") && p.state !== "cancelled" && (
              <button className="btn btn-ghost btn-sm" onClick={run(() => migrations.retryFailed(job.id))}>
                <Icon name="retry" size={13} /> Try again
              </button>
            )}
          </div>
        )}
        {showFailures && p.filesFailed > 0 && <Failures job={job} />}
        {error && <ErrorText message={error} />}
      </div>
      <div className="jobs-actions">
        {canPause && (
          <button className="icon-btn" title="Pause" aria-label="Pause" onClick={run(() => migrations.pause(job.id))}>
            <Icon name="pause" size={14} />
          </button>
        )}
        {canResume && (
          <button className="icon-btn" title="Resume" aria-label="Resume" onClick={run(() => migrations.resume(job.id))}>
            <Icon name="play" size={14} />
          </button>
        )}
        {!finished &&
          (confirmStop ? (
            <button className="btn btn-danger-ghost btn-sm" onClick={run(() => migrations.cancel(job.id))}>
              Stop for good?
            </button>
          ) : (
            <button className="icon-btn" title="Stop" aria-label="Stop" onClick={() => setConfirmStop(true)}>
              <Icon name="x" size={14} />
            </button>
          ))}
        {finished && p.state === "done" && onOpenDest && (
          <button className="icon-btn" title="Show where it went" aria-label="Show where it went" onClick={() => onOpenDest(job)}>
            <Icon name="reveal" size={14} />
          </button>
        )}
        {finished && (
          <button className="icon-btn" title="Remove from the list" aria-label="Remove from the list" onClick={run(() => migrations.remove(job.id))}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Every copy and move between connections, active ones first. `variant="mobile"` gives bigger
 * rows for the phone's Transfers screen; `limit` caps how many finished jobs are listed.
 */
export function JobsPanel({
  variant = "desktop",
  onOpenDest,
  limit = 30,
  hideWhenEmpty = false,
}: {
  variant?: "desktop" | "mobile";
  /** a finished job's "Show where it went" (open dst.profileId / dst.root / dst.dir) */
  onOpenDest?: (job: JobSummary) => void;
  limit?: number;
  /** render nothing at all instead of the empty note */
  hideWhenEmpty?: boolean;
}) {
  const jobs = useMigrations();
  const active = jobs.filter((j) => !isFinished(j));
  // done without problems, or cancelled: failed and partly failed copies stay (Resume, Try again)
  const isClearable = (j: JobSummary) => (j.progress.state === "done" && j.progress.filesFailed === 0) || j.progress.state === "cancelled";
  const clearable = jobs.filter(isClearable);
  // `limit` only trims clean ones: a failed copy is always listed (the Failed tab leads here)
  const finished = jobs.filter(isFinished);
  const keep = new Set(finished.filter(isClearable).slice(0, limit).map((j) => j.id));
  const done = finished.filter((j) => !isClearable(j) || keep.has(j.id));

  if (jobs.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <div className={`jobs-panel jobs-${variant}`}>
        <div className="jobs-empty">
          <Icon name="copy" size={18} />
          <span>No copies between connections yet. Use “Copy to another connection…” on files or folders, and they show up here, even after Kybl restarts.</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`jobs-panel jobs-${variant}`}>
      {[...active, ...done].map((j) => (
        <JobRow key={j.id} job={j} onOpenDest={onOpenDest} />
      ))}
      {clearable.length > 1 && (
        <div className="jobs-foot">
          <button className="btn btn-ghost btn-sm" onClick={() => clearable.forEach((j) => migrations.remove(j.id).catch(() => {}))}>
            Clear finished
          </button>
        </div>
      )}
    </div>
  );
}
