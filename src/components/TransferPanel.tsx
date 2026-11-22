import { Icon, type IconName } from "../Icons";
import { api } from "../api";
import { ErrorText } from "./ErrorText";
import { formatBytes, formatEta, formatSpeed } from "../format";
import type { Transfer, TransferState } from "../types";
import { useJobList, type Job, type JobKind } from "../useJobs";
import { useTransferList } from "../useTransfers";
import { useSync } from "../sync";
import { useEffect, useMemo, useRef } from "react";
import { clearLog, useActivityLog } from "../activityLog";
import type { JobSummary } from "../api";
import { JobsPanel, isActive as migrationActive, useMigrations } from "../jobs";

/** A synced folder that is busy right now (shown read-only). */
export type SyncActivity = { id: string; name: string; direction: "upload" | "download" | "twoway"; state: "scanning" | "syncing"; done: number; total: number; current: string | null; bytes: number; totalBytes: number };

const JOB_ICON: Record<JobKind, IconName> = { move: "move", copy: "copy", delete: "trash", rename: "edit" };
const JOB_DONE: Record<JobKind, string> = { move: "Moved", copy: "Copied", delete: "Deleted", rename: "Renamed" };

function jobMeta(j: Job): string {
  if (j.state === "running") {
    if (j.phase === null || j.phase === "listing") return j.total > 0 ? `Finding objects… ${j.total.toLocaleString()} so far` : "Finding objects…";
    const parts = [`${j.done.toLocaleString()} of ${j.total.toLocaleString()} ${j.total === 1 ? "object" : "objects"}`];
    if (j.totalBytes > 0) parts.push(`${formatBytes(j.bytes)} of ${formatBytes(j.totalBytes)}`);
    if (j.eta) parts.push(j.eta);
    return parts.join(" · ");
  }
  if (j.state === "cancelled") return j.done > 0 ? `${j.done.toLocaleString()} of ${j.total.toLocaleString()} done before stopping` : "Nothing was changed";
  if (j.state === "error") return `${j.done.toLocaleString()} of ${j.total.toLocaleString()} done`;
  return j.total > 1 ? `${j.total.toLocaleString()} objects` : "";
}

const STATE_ICON: Record<TransferState, "upload" | "download" | "check-circle" | "alert" | "clock" | "x"> = {
  running: "upload",
  queued: "clock",
  done: "check-circle",
  error: "alert",
  cancelled: "x",
};

/** The Activity panel, subscribed to the live transfer, job and sync lists itself. */
export function TransferPanel(props: Omit<PanelProps, "transfers" | "jobs" | "syncs" | "migrations" | "migrationsActive">) {
  const transfers = useTransferList();
  const jobs = useJobList();
  const sync = useSync();
  const syncs = useMemo(
    () =>
      sync.mappings.flatMap((m): SyncActivity[] => {
        const st = sync.status[m.id];
        if (st?.state !== "syncing") return [];
        const name = m.localPath.split("/").filter(Boolean).pop() ?? m.localPath;
        return [{ id: m.id, name, direction: m.direction, state: "syncing", done: st.done, total: st.total, current: st.current, bytes: st.bytes ?? 0, totalBytes: st.totalBytes ?? 0 }];
      }),
    [sync],
  );
  const migs = useMigrations();
  const migsActive = useMemo(() => migs.filter(migrationActive), [migs]);
  return <TransferPanelView {...props} transfers={transfers} jobs={jobs} syncs={syncs} migrations={migs.length} migrationsActive={migsActive} />;
}

/** In progress (running and waiting), Failed, Done (finished and cancelled), Log (messages), Jobs. */
export type ActivityTab = "activity" | "failed" | "done" | "log" | "jobs";

type PanelProps = {
  transfers: Transfer[];
  jobs: Job[];
  syncs: SyncActivity[];
  /** copies between connections (src/jobs): how many are listed, and the ones still going */
  migrations: number;
  migrationsActive: JobSummary[];
  /** which tab shows: in progress, failed, done, the message log, or Jobs (copies between connections) */
  tab?: ActivityTab;
  onTab?(tab: ActivityTab): void;
  /** a finished copy's "Show where it went" */
  onOpenMigrationDest?(job: JobSummary): void;
  onCancelJob: (id: string) => void;
  onDismissJob: (id: string) => void;
  onOpenJob: (j: Job) => void;
  onOpenSync: () => void;
  open: boolean;
  onToggle: () => void;
  onCancel: (id: string) => void;
  onCancelAll: () => void;
  onRetry: (id: string) => void;
  /** retry every failed transfer at once; without it each failed one is retried in turn */
  onRetryAll?(): void;
  onClear: () => void;
  onReveal: (t: Transfer) => void;
  /** open a finished download in its default app; defaults to api.openLocal */
  onOpenLocal?(t: Transfer): void;
  /**
   * Show the panel with a short "nothing here" note while there is no activity, for when the
   * user opened it on purpose (an Activity button or menu item). Off: no activity, no panel.
   */
  showEmpty?: boolean;
};

function TransferPanelView({
  transfers,
  jobs,
  syncs,
  open,
  onToggle,
  onCancel,
  onCancelAll,
  onRetry,
  onRetryAll,
  onClear,
  onReveal,
  onOpenLocal,
  showEmpty,
  onCancelJob,
  onDismissJob,
  onOpenJob,
  onOpenSync,
  migrations,
  migrationsActive,
  tab = "activity",
  onTab,
  onOpenMigrationDest,
}: PanelProps) {
  const nothing = transfers.length === 0 && jobs.length === 0 && syncs.length === 0;
  // no activity and no copies between connections: no panel, unless it was opened on purpose
  if (nothing && migrations === 0 && !(showEmpty && open)) return null;
  const onJobs = tab === "jobs";
  const pickTab = (t: ActivityTab) => {
    onTab?.(t);
    if (!open) onToggle();
  };
  // without tabs (phones) every row shows in one list, as before
  const show = (what: "progress" | "failed" | "done") => !onTab || (what === "progress" ? tab === "activity" : tab === what);

  const jobsRunning = jobs.filter((j) => j.state === "running");
  const jobsFailed = jobs.filter((j) => j.state === "error");
  const jobsDone = jobs.filter((j) => j.state === "done");
  const jobsCancelled = jobs.filter((j) => j.state === "cancelled");
  const jobList = [...jobsRunning, ...[...jobs].filter((j) => j.state !== "running").sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0)).slice(0, 30)];

  const running = transfers.filter((t) => t.state === "running");
  const queued = transfers.filter((t) => t.state === "queued");
  const failed = transfers.filter((t) => t.state === "error");
  const done = transfers.filter((t) => t.state === "done");
  const active = running.length + queued.length;

  const live = transfers.filter((t) => t.state === "running" || t.state === "queued" || t.state === "done");
  const totalBytes = live.reduce((s, t) => s + t.total, 0);
  const doneBytes = live.reduce((s, t) => s + (t.state === "done" ? t.total : t.bytes), 0);
  const speed = running.reduce((s, t) => s + t.speed, 0);
  const pct = totalBytes > 0 ? Math.min(100, (doneBytes / totalBytes) * 100) : 0;
  const eta = speed > 0 ? (totalBytes - doneBytes) / speed : 0;

  const cancelled = transfers.filter((t) => t.state === "cancelled");
  const list = [
    ...(show("progress") ? running : []),
    ...(show("failed") ? failed : []),
    ...(show("progress") ? queued.slice(0, 40) : []),
    ...(show("done") ? done.slice(-40).reverse() : []),
    ...(show("done") ? cancelled.slice(-20) : []),
  ];
  const shownJobs = jobList.filter((j) => (j.state === "running" ? show("progress") : j.state === "error" ? show("failed") : show("done")));
  const shownSyncs = show("progress") ? syncs : [];
  const counts = {
    progress: active + jobsRunning.length + syncs.length,
    failed: failed.length + jobsFailed.length,
    done: done.length + cancelled.length + jobsDone.length + jobsCancelled.length,
  };
  const onLog = !!onTab && tab === "log";
  const tabEmpty = shownJobs.length + shownSyncs.length + list.length === 0;
  const EMPTY_NOTE: Record<string, string> = {
    activity: "Nothing is uploading or downloading right now.",
    failed: "Nothing has failed.",
    done: "Nothing has finished yet.",
  };

  const cancelledCount = transfers.length - active - done.length - failed.length + jobsCancelled.length;
  const activeAll = active + jobsRunning.length + syncs.length + migrationsActive.length;
  const doneAll = done.length + jobsDone.length;
  const failedAll = failed.length + jobsFailed.length;
  const finishedAll = transfers.length - active + jobs.length - jobsRunning.length;
  // with no transfers running, the header summarises the first running job, then the first copy
  // between connections
  const leadJob = active === 0 ? jobsRunning[0] : undefined;
  const leadMig = active === 0 && !leadJob ? migrationsActive[0] : undefined;
  const leadMigFrac = leadMig && leadMig.progress.state !== "planning" && leadMig.progress.bytesTotal > 0 ? leadMig.progress.bytesDone / leadMig.progress.bytesTotal : null;
  const retryAll = () => (onRetryAll ? onRetryAll() : failed.forEach((t) => onRetry(t.id)));
  const openLocal = (t: Transfer) => (onOpenLocal ? onOpenLocal(t) : api.openLocal(t.local).catch(() => onReveal(t)));

  return (
    <section className={`transfers ${open ? "open" : ""}`} aria-label="Activity">
      <header onClick={onToggle}>
        <button
          type="button"
          className="tp-title"
          aria-expanded={open}
          aria-controls="tp-list"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <Icon name="chevron" size={13} className={`tp-caret ${open ? "open" : ""}`} />
          {!onTab && <strong>Activity</strong>}
        </button>
        {onTab && (
          <div className="tp-tabs" role="tablist" aria-label="Activity" onClick={(e) => e.stopPropagation()}>
            {(
              [
                ["activity", "In progress", counts.progress, "accent"],
                ["failed", "Failed", counts.failed, "bad"],
                ["done", "Done", counts.done, ""],
                ["log", "Log", 0, ""],
              ] as const
            ).map(([id, label, n, tone]) => (
              <button key={id} role="tab" aria-selected={open && tab === id} className={open && tab === id ? "on" : ""} onClick={() => pickTab(id)}>
                {label}
                {n > 0 && <span className={`pill ${tone}`}>{n.toLocaleString()}</span>}
              </button>
            ))}
            <button
              role="tab"
              aria-selected={open && onJobs}
              className={open && onJobs ? "on" : ""}
              onClick={() => pickTab("jobs")}
              title="Copies and moves between connections"
            >
              Jobs
              {migrationsActive.length > 0 && <span className="pill accent">{migrationsActive.length}</span>}
            </button>
          </div>
        )}
        {/* with tabs the counts sit on the tabs */}
        {!onTab && (
          <span className="tp-counts">
            {activeAll > 0 && <span className="pill accent">{activeAll} active</span>}
            {doneAll > 0 && <span className="pill ok">{doneAll} done</span>}
            {failedAll > 0 && <span className="pill bad">{failedAll} failed</span>}
            {cancelledCount > 0 && <span className="pill">{cancelledCount} cancelled</span>}
          </span>
        )}
        <div className="tp-summary">
          {active > 0 && (
            <>
              <span>
                {running.some((t) => !t.total) ? formatBytes(doneBytes) : `${formatBytes(doneBytes)} of ${formatBytes(totalBytes)}`}
              </span>
              {speed > 0 && <span>{formatSpeed(speed)}</span>}
              {eta > 0 && <span>{formatEta(eta)} left</span>}
              <div className="bar">
                <div style={{ width: `${pct}%` }} />
              </div>
            </>
          )}
          {leadJob && (
            <>
              <span className="tp-lead">{leadJob.title}</span>
              {leadJob.eta && <span>{leadJob.eta}</span>}
              <div className={`bar ${leadJob.frac == null ? "indeterminate" : ""}`}>
                <div style={{ width: `${Math.round((leadJob.frac ?? 0) * 100)}%` }} />
              </div>
            </>
          )}
          {leadMig && (
            <>
              <span className="tp-lead">{leadMig.title}</span>
              {leadMig.progress.etaSecs != null && leadMig.progress.etaSecs > 0 && <span>{formatEta(leadMig.progress.etaSecs)} left</span>}
              <div className={`bar ${leadMigFrac == null ? "indeterminate" : ""}`}>
                <div style={{ width: `${Math.round((leadMigFrac ?? 0) * 100)}%` }} />
              </div>
            </>
          )}
        </div>
        <div className="tp-actions" onClick={(e) => e.stopPropagation()} hidden={open && (onJobs || onLog)}>
          {failed.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={retryAll} title="Try every failed transfer again">
              <Icon name="retry" size={13} /> Retry {failed.length === 1 ? "failed" : `all ${failed.length} failed`}
            </button>
          )}
          {active > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={onCancelAll}>
              Cancel transfers
            </button>
          )}
          {finishedAll > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={onClear}>
              Clear finished
            </button>
          )}
        </div>
      </header>
      {open && onJobs && (
        <div className="tp-list tp-jobs" id="tp-list">
          <JobsPanel onOpenDest={onOpenMigrationDest} />
        </div>
      )}
      {open && onLog && <MessageLog />}
      {open && !onJobs && !onLog && nothing && (
        <div className="tp-empty" id="tp-list">
          <Icon name="transfers" size={18} />
          <span>Nothing is uploading or downloading. Transfers, moves and deletes you start show up here.</span>
        </div>
      )}
      {open && !onJobs && !onLog && !nothing && onTab && tabEmpty && (
        <div className="tp-empty" id="tp-list">
          <Icon name={tab === "failed" ? "check-circle" : "transfers"} size={18} />
          <span>{EMPTY_NOTE[tab]}</span>
        </div>
      )}
      {open && !onJobs && !onLog && !nothing && !(onTab && tabEmpty) && (
        <div className="tp-list" id="tp-list">
          {shownJobs.map((j) => (
            <div key={j.id} className={`tp-row job st-${j.state}`}>
              <span className="tp-icon" title={JOB_DONE[j.kind]}>
                <Icon name={j.state === "error" ? "alert" : j.state === "cancelled" ? "x" : j.state === "done" ? "check-circle" : JOB_ICON[j.kind]} size={15} />
              </span>
              <div className="tp-name" title={j.title}>
                {j.title}
                {j.state === "error" && j.error && (
                  <div className="tp-err">
                    <ErrorText message={j.error} />
                  </div>
                )}
              </div>
              <div className="tp-meta">{jobMeta(j)}</div>
              {j.state === "running" ? (
                <div className={`bar ${j.frac == null ? "indeterminate" : ""}`}>
                  <div style={{ width: `${Math.round((j.frac ?? 0) * 100)}%` }} />
                </div>
              ) : (
                <div className="tp-state">
                  {j.state === "done" && JOB_DONE[j.kind]}
                  {j.state === "cancelled" && "Cancelled"}
                  {j.state === "error" && "Failed"}
                </div>
              )}
              <div className="tp-row-actions">
                {j.state === "running" && j.kind !== "rename" && (
                  <button className="icon-btn" onClick={() => onCancelJob(j.id)} title="Stop. What’s done stays done; nothing is half-moved." aria-label="Stop">
                    <Icon name="x" size={13} />
                  </button>
                )}
                {j.state !== "running" && j.dest != null && j.kind !== "delete" && (
                  <button className="icon-btn" onClick={() => onOpenJob(j)} title="Open destination folder" aria-label="Open destination folder">
                    <Icon name="folder" size={13} />
                  </button>
                )}
                {j.state !== "running" && (
                  <button className="icon-btn" onClick={() => onDismissJob(j.id)} title="Remove from list" aria-label="Remove from list">
                    <Icon name="x" size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {shownSyncs.map((sy) => (
            <div key={sy.id} className="tp-row job st-running sync-act" onClick={onOpenSync} title="Open sync settings">
              <span className="tp-icon">
                <Icon name="sync" size={15} />
              </span>
              <div className="tp-name">
                Syncing {sy.name}
                {sy.current && <span className="dim"> · {sy.current}</span>}
              </div>
              <div className="tp-meta">
                {sy.state === "scanning"
                  ? "Checking for changes…"
                  : `${sy.done.toLocaleString()} of ${sy.total.toLocaleString()} files` + (sy.totalBytes > 0 ? ` · ${formatBytes(sy.bytes)} of ${formatBytes(sy.totalBytes)}` : "")}
              </div>
              <div className={`bar ${sy.state === "scanning" || !sy.total ? "indeterminate" : ""}`}>
                <div style={{ width: `${Math.round((sy.totalBytes > 0 ? sy.bytes / sy.totalBytes : sy.total ? sy.done / sy.total : 0) * 100)}%` }} />
              </div>
              <div className="tp-row-actions" />
            </div>
          ))}
          {list.map((t) => (
            <div key={t.id} className={`tp-row st-${t.state}`}>
              <span className="tp-icon" title={t.kind === "upload" ? "Upload" : "Download"}>
                <Icon name={t.state === "running" ? t.kind : STATE_ICON[t.state]} size={15} />
              </span>
              <div className="tp-name" title={t.key}>
                {t.name}
                {t.state === "error" && t.error && (
                  <div className="tp-err">
                    <ErrorText message={t.error} />
                  </div>
                )}
              </div>
              <div className="tp-meta">
                {t.state === "running" && (
                  <>
                    {/* total 0: a Google Docs export, whose size isn't known until it's done */}
                    {t.total > 0 ? `${formatBytes(t.bytes)} of ${formatBytes(t.total)}` : formatBytes(t.bytes)}
                    {t.speed > 0 && ` · ${formatSpeed(t.speed)}`}
                  </>
                )}
                {t.state !== "running" && (t.total || (t.state === "done" ? t.bytes : 0)) > 0 && formatBytes(t.total || t.bytes)}
              </div>
              {t.state === "running" || t.state === "queued" ? (
                <div className={`bar ${t.state === "running" && !t.total ? "indeterminate" : ""}`}>
                  <div style={{ width: `${t.total > 0 ? Math.min(100, (t.bytes / t.total) * 100) : 0}%` }} />
                </div>
              ) : (
                <div className="tp-state">
                  {t.state === "done" && (t.kind === "upload" ? "Uploaded" : "Downloaded")}
                  {t.state === "cancelled" && "Cancelled"}
                  {t.state === "error" && "Failed"}
                </div>
              )}
              <div className="tp-row-actions">
                {(t.state === "running" || t.state === "queued") && (
                  <button className="icon-btn" onClick={() => onCancel(t.id)} title="Cancel" aria-label="Cancel">
                    <Icon name="x" size={13} />
                  </button>
                )}
                {(t.state === "error" || t.state === "cancelled") && (
                  <button className="icon-btn" onClick={() => onRetry(t.id)} title="Retry" aria-label="Retry">
                    <Icon name="retry" size={13} />
                  </button>
                )}
                {t.state === "done" && t.kind === "download" && t.local && (
                  <>
                    <button className="icon-btn" onClick={() => openLocal(t)} title="Open" aria-label={`Open ${t.name}`}>
                      <Icon name="external" size={13} />
                    </button>
                    <button className="icon-btn" onClick={() => onReveal(t)} title="Show in Finder" aria-label={`Show ${t.name} in Finder`}>
                      <Icon name="reveal" size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {show("progress") && queued.length > 40 && <div className="tp-more">+ {(queued.length - 40).toLocaleString()} more waiting</div>}
        </div>
      )}
    </section>
  );
}

/** The Log tab: every message the app showed this session, newest at the bottom. */
function MessageLog() {
  const log = useActivityLog();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // braces: newer engines return a Promise from scrollIntoView, which React would take for a clean-up
    end.current?.scrollIntoView({ block: "end" });
  }, [log.length]);
  if (!log.length)
    return (
      <div className="tp-empty" id="tp-list">
        <Icon name="info" size={18} />
        <span>Messages Kybl shows you (finished copies, errors, notes) collect here for this session.</span>
      </div>
    );
  return (
    <div className="tp-list tp-log" id="tp-list" role="log" aria-live="off">
      {log.map((m) => (
        <div key={m.id} className={`tp-log-row k-${m.kind}`}>
          <time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
          <Icon name={m.kind === "error" ? "alert" : m.kind === "success" ? "check-circle" : "info"} size={13} />
          <span className="tp-log-text">{m.text}</span>
        </div>
      ))}
      <div className="tp-log-tools">
        <button className="btn btn-ghost btn-sm" onClick={clearLog}>
          Clear log
        </button>
      </div>
      <div ref={end} />
    </div>
  );
}
