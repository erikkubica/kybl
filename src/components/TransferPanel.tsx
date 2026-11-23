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
import { JobsPanel, isActive as migrationActive, migrations as migrationStore, useMigrations } from "../jobs";
import { useJobs } from "../useJobs";

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

const KIND_LABEL: Record<Transfer["kind"], string> = { upload: "Upload", download: "Download", compress: "Compress", extract: "Extract" };
const KIND_DONE: Record<Transfer["kind"], string> = { upload: "Uploaded", download: "Downloaded", compress: "Compressed", extract: "Extracted" };
const STATE_ICON: Record<TransferState, "upload" | "download" | "check-circle" | "alert" | "clock" | "x"> = {
  running: "upload",
  queued: "clock",
  done: "check-circle",
  error: "alert",
  cancelled: "x",
};

/** A copy between connections that stopped with an error, needs a new sign-in, or finished with files that failed. */
const migrationFailed = (m: JobSummary) =>
  m.progress.state === "failed" || m.progress.state === "needsAuth" || (m.progress.state === "done" && m.progress.filesFailed > 0);
/** What "Retry" does for a copy between connections: the files that failed, or the rest of a failed one; null = nothing (a sign-in is needed first). */
function migrationRetry(m: JobSummary): (() => Promise<void>) | null {
  const p = m.progress;
  if ((p.state === "done" || p.state === "failed") && p.filesFailed > 0) return () => migrationStore.retryFailed(m.id);
  if (p.state === "failed") return () => migrationStore.resume(m.id);
  return null;
}

/**
 * Keeps toasts above the Activity panel while it shows (they would cover its rows): sets
 * `--toasts-bottom` on the page to the panel's top edge plus a gap, following its height.
 */
function liftToasts(el: HTMLElement | null) {
  if (!el) return;
  const root = document.documentElement;
  const place = () => root.style.setProperty("--toasts-bottom", `${Math.max(22, Math.round(window.innerHeight - el.getBoundingClientRect().top + 12))}px`);
  place();
  const ro = new ResizeObserver(place);
  ro.observe(el);
  window.addEventListener("resize", place);
  return () => {
    ro.disconnect();
    window.removeEventListener("resize", place);
    root.style.removeProperty("--toasts-bottom");
  };
}

/** The Activity panel, subscribed to the live transfer, job and sync lists itself. */
export function TransferPanel(props: Omit<PanelProps, "transfers" | "jobs" | "syncs" | "migrations" | "migrationsActive" | "migrationsFailed" | "migrationsDone">) {
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
  const migsFailed = useMemo(() => migs.filter(migrationFailed), [migs]);
  const migsDone = useMemo(() => migs.filter((m) => (m.progress.state === "done" && !migrationFailed(m)) || m.progress.state === "cancelled"), [migs]);
  return (
    <TransferPanelView
      {...props}
      transfers={transfers}
      jobs={jobs}
      syncs={syncs}
      migrations={migs.length}
      migrationsActive={migsActive}
      migrationsFailed={migsFailed}
      migrationsDone={migsDone}
    />
  );
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
  /** copies between connections that stopped with an error, need a new sign-in, or finished with files that failed */
  migrationsFailed: JobSummary[];
  /** copies between connections that finished cleanly or were cancelled */
  migrationsDone: JobSummary[];
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
  /** clears what finished or was cancelled (failed items stay) */
  onClear: () => void;
  /** clears the failed items (the Failed tab) */
  onClearFailed?(): void;
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
  onClearFailed,
  onReveal,
  onOpenLocal,
  showEmpty,
  onCancelJob,
  onDismissJob,
  onOpenJob,
  onOpenSync,
  migrations,
  migrationsActive,
  migrationsFailed,
  migrationsDone,
  tab = "activity",
  onTab,
  onOpenMigrationDest,
}: PanelProps) {
  const jobActions = useJobs();
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
  // copies between connections show here too (with tabs); their details and controls are in Jobs
  const shownMigs = onTab
    ? [...(show("progress") ? migrationsActive : []), ...(show("failed") ? migrationsFailed : []), ...(show("done") ? migrationsDone.slice(0, 30) : [])]
    : [];
  const counts = {
    progress: active + jobsRunning.length + syncs.length + migrationsActive.length,
    failed: failed.length + jobsFailed.length + migrationsFailed.length,
    done: done.length + cancelled.length + jobsDone.length + jobsCancelled.length + migrationsDone.length,
  };
  const onLog = !!onTab && tab === "log";
  const tabEmpty = shownJobs.length + shownSyncs.length + shownMigs.length + list.length === 0;
  const EMPTY_NOTE: Record<string, string> = {
    activity: "Nothing in progress right now.",
    failed: "Nothing has failed.",
    done: "Nothing has finished yet.",
  };

  const cancelledCount = transfers.length - active - done.length - failed.length + jobsCancelled.length;
  const activeAll = active + jobsRunning.length + syncs.length + migrationsActive.length;
  const doneAll = done.length + jobsDone.length;
  const failedAll = failed.length + jobsFailed.length;
  const finishedAll = done.length + cancelled.length + jobsDone.length + jobsCancelled.length + (onTab ? migrationsDone.length : 0);
  // with no transfers running, the header summarises the first running job, then the first copy
  // between connections
  const leadJob = active === 0 ? jobsRunning[0] : undefined;
  const leadMig = active === 0 && !leadJob ? migrationsActive[0] : undefined;
  const leadMigFrac = leadMig && leadMig.progress.state !== "planning" && leadMig.progress.bytesTotal > 0 ? leadMig.progress.bytesDone / leadMig.progress.bytesTotal : null;
  // "Retry all": failed transfers, failed moves / copies / deletes, and copies between connections
  const retryJobs = jobsFailed.filter((j) => j.retry);
  const retryMigs = (onTab ? migrationsFailed : []).flatMap((m) => {
    const r = migrationRetry(m);
    return r ? [r] : [];
  });
  const retryCount = failed.length + retryJobs.length + retryMigs.length;
  const retryAll = () => {
    if (onRetryAll) onRetryAll();
    else failed.forEach((t) => onRetry(t.id));
    for (const j of retryJobs) jobActions.retry(j.id);
    for (const r of retryMigs) void r().catch(() => {});
  };
  const clearFinished = () => {
    onClear();
    if (onTab) for (const m of migrationsDone) void migrationStore.remove(m.id).catch(() => {});
  };
  const openLocal = (t: Transfer) => (onOpenLocal ? onOpenLocal(t) : api.openLocal(t.local).catch(() => onReveal(t)));
  // only what fits the tab on screen (all of it without tabs)
  const acts = {
    retry: retryCount > 0 && (!onTab || tab === "activity" || tab === "failed"),
    cancel: active > 0 && (!onTab || tab === "activity"),
    clear: finishedAll > 0 && (!onTab || tab === "done"),
    clearFailed: !!onClearFailed && counts.failed > 0 && !!onTab && tab === "failed",
  };
  const showActs = !(open && (onJobs || onLog)) && (acts.retry || acts.cancel || acts.clear || acts.clearFailed);

  return (
    <section ref={liftToasts} className={`transfers ${open ? "open" : ""}`} aria-label="Activity">
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
        {/* not on Jobs (its own buttons) or Log; each tab gets what fits it. Narrow: icons with their names as tooltips */}
        {showActs && (
          <div className="tp-actions" onClick={(e) => e.stopPropagation()}>
            {acts.retry && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={retryAll}
                title="Try everything that failed again"
                aria-label={retryCount === 1 ? "Retry failed" : `Retry all ${retryCount} failed`}
              >
                <Icon name="retry" size={13} /> <span className="tp-lbl">Retry {retryCount === 1 ? "failed" : `all ${retryCount.toLocaleString()} failed`}</span>
              </button>
            )}
            {acts.cancel && (
              <button className="btn btn-ghost btn-sm" onClick={onCancelAll} title="Cancel every upload and download" aria-label="Cancel transfers">
                <Icon name="x" size={13} /> <span className="tp-lbl">Cancel transfers</span>
              </button>
            )}
            {acts.clear && (
              <button className="btn btn-ghost btn-sm" onClick={clearFinished} title="Take finished and cancelled items off the list" aria-label="Clear finished">
                <Icon name="check" size={13} /> <span className="tp-lbl">Clear finished</span>
              </button>
            )}
            {acts.clearFailed && (
              <button className="btn btn-ghost btn-sm" onClick={onClearFailed} title="Take failed items off the list" aria-label="Clear failed">
                <Icon name="trash" size={13} /> <span className="tp-lbl">Clear failed</span>
              </button>
            )}
          </div>
        )}
      </header>
      {open && onJobs && (
        <div className="tp-list tp-jobs" id="tp-list">
          <JobsPanel onOpenDest={onOpenMigrationDest} />
        </div>
      )}
      {open && onLog && <MessageLog />}
      {/* phones (no tabs) with nothing at all: one general note */}
      {open && !onTab && nothing && (
        <div className="tp-empty" id="tp-list">
          <Icon name="transfers" size={18} />
          <span>Nothing is uploading or downloading. Transfers, moves and deletes you start show up here.</span>
        </div>
      )}
      {open && onTab && !onJobs && !onLog && tabEmpty && (
        <div className="tp-empty" id="tp-list">
          <Icon name={tab === "failed" ? "check-circle" : "transfers"} size={18} />
          <span>
            {EMPTY_NOTE[tab]}
            {nothing && tab === "activity" && " Transfers, moves and deletes you start show up here."}
          </span>
        </div>
      )}
      {open && !onJobs && !onLog && !tabEmpty && (
        <div className="tp-list" id="tp-list">
          {shownMigs.map((m) => {
            const p = m.progress;
            const bad = migrationFailed(m);
            const finished = p.state === "done" || p.state === "cancelled";
            const frac = p.state !== "planning" && p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : null;
            const retry = bad ? migrationRetry(m) : null;
            const verb = m.spec.mode === "move" ? "moved" : "copied";
            return (
              <div
                key={m.id}
                className={`tp-row job ${bad ? "st-error" : p.state === "done" ? "st-done" : p.state === "cancelled" ? "st-cancelled" : "st-running"} sync-act`}
                onClick={() => pickTab("jobs")}
                title="Open in Jobs"
              >
                <span className="tp-icon">
                  <Icon name={bad ? "alert" : p.state === "done" ? "check-circle" : p.state === "cancelled" ? "x" : m.spec.mode === "move" ? "move" : "copy"} size={15} />
                </span>
                <div className="tp-name">
                  {m.title}
                  {bad && p.error && (
                    <div className="tp-err">
                      <ErrorText message={p.error} />
                    </div>
                  )}
                </div>
                <div className="tp-meta">
                  {p.state === "planning"
                    ? "Finding files…"
                    : p.state === "paused"
                      ? "Paused"
                      : p.state === "waitingNetwork"
                        ? "Waiting for the network"
                        : p.state === "needsAuth"
                          ? "Sign in again to continue"
                          : p.state === "done" && p.filesFailed > 0
                            ? `${p.filesFailed.toLocaleString()} of ${p.filesTotal.toLocaleString()} files couldn’t be ${verb}`
                            : p.state === "done"
                              ? `${p.filesTotal.toLocaleString()} ${p.filesTotal === 1 ? "file" : "files"}` + (p.bytesTotal > 0 ? ` · ${formatBytes(p.bytesTotal)}` : "")
                              : `${(p.filesDone + p.filesSkipped).toLocaleString()} of ${p.filesTotal.toLocaleString()} files` +
                                (p.bytesTotal > 0 ? ` · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}` : "")}
                </div>
                {bad ? (
                  <div className="tp-state">{p.state === "needsAuth" ? "Needs sign-in" : p.state === "done" ? "Some failed" : "Failed"}</div>
                ) : finished ? (
                  <div className="tp-state">{p.state === "cancelled" ? "Cancelled" : m.spec.mode === "move" ? "Moved" : "Copied"}</div>
                ) : (
                  <div className={`bar ${frac == null ? "indeterminate" : ""}`}>
                    <div style={{ width: `${Math.round((frac ?? 0) * 100)}%` }} />
                  </div>
                )}
                <div className="tp-row-actions">
                  {retry && (
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void retry().catch(() => {});
                      }}
                      title={p.filesFailed > 0 ? "Try the files that failed again" : "Try again"}
                      aria-label="Retry"
                    >
                      <Icon name="retry" size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
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
                {j.state === "running" && (j.kind !== "rename" || j.stoppable) && (
                  <button className="icon-btn" onClick={() => onCancelJob(j.id)} title="Stop. What’s done stays done; nothing is half-moved." aria-label="Stop">
                    <Icon name="x" size={13} />
                  </button>
                )}
                {j.state === "error" && j.retry && (
                  <button className="icon-btn" onClick={() => jobActions.retry(j.id)} title="Try what’s left again" aria-label="Retry">
                    <Icon name="retry" size={13} />
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
              <span className="tp-icon" title={KIND_LABEL[t.kind]}>
                <Icon name={t.state === "running" ? (t.kind === "upload" || t.kind === "download" ? t.kind : "archive") : STATE_ICON[t.state]} size={15} />
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
                  {t.state === "done" && KIND_DONE[t.kind]}
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
