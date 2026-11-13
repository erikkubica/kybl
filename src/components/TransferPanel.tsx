import { Icon, type IconName } from "../Icons";
import { errDetail, errSummary } from "../api";
import { formatBytes, formatEta, formatSpeed } from "../format";
import type { Transfer, TransferState } from "../types";
import { useJobList, type Job, type JobKind } from "../useJobs";
import { useTransferList } from "../useTransfers";
import { useSync } from "../sync";
import { useMemo } from "react";

/** A synced folder that is busy right now (shown read-only). */
export type SyncActivity = { id: string; name: string; direction: "upload" | "download"; state: "scanning" | "syncing"; done: number; total: number; current: string | null; bytes: number; totalBytes: number };

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
export function TransferPanel(props: Omit<PanelProps, "transfers" | "jobs" | "syncs">) {
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
  return <TransferPanelView {...props} transfers={transfers} jobs={jobs} syncs={syncs} />;
}

type PanelProps = {
  transfers: Transfer[];
  jobs: Job[];
  syncs: SyncActivity[];
  onCancelJob: (id: string) => void;
  onDismissJob: (id: string) => void;
  onOpenJob: (j: Job) => void;
  onOpenSync: () => void;
  open: boolean;
  onToggle: () => void;
  onCancel: (id: string) => void;
  onCancelAll: () => void;
  onRetry: (id: string) => void;
  onClear: () => void;
  onReveal: (t: Transfer) => void;
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
  onClear,
  onReveal,
  onCancelJob,
  onDismissJob,
  onOpenJob,
  onOpenSync,
}: PanelProps) {
  if (transfers.length === 0 && jobs.length === 0 && syncs.length === 0) return null;

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

  const list = [
    ...running,
    ...failed,
    ...queued.slice(0, 40),
    ...done.slice(-40).reverse(),
    ...transfers.filter((t) => t.state === "cancelled").slice(-20),
  ];

  const cancelledCount = transfers.length - active - done.length - failed.length + jobsCancelled.length;
  const activeAll = active + jobsRunning.length + syncs.length;
  const doneAll = done.length + jobsDone.length;
  const failedAll = failed.length + jobsFailed.length;
  const finishedAll = transfers.length - active + jobs.length - jobsRunning.length;
  // with no transfers running, the header summarises the first running job
  const leadJob = active === 0 ? jobsRunning[0] : undefined;

  return (
    <section className={`transfers ${open ? "open" : ""}`}>
      <header onClick={onToggle}>
        <div className="tp-title">
          <Icon name="chevron" size={13} className={`tp-caret ${open ? "open" : ""}`} />
          <strong>Activity</strong>
          <span className="tp-counts">
            {activeAll > 0 && <span className="pill accent">{activeAll} active</span>}
            {doneAll > 0 && <span className="pill ok">{doneAll} done</span>}
            {failedAll > 0 && <span className="pill bad">{failedAll} failed</span>}
            {cancelledCount > 0 && <span className="pill">{cancelledCount} cancelled</span>}
          </span>
        </div>
        <div className="tp-summary">
          {active > 0 && (
            <>
              <span>
                {formatBytes(doneBytes)} of {formatBytes(totalBytes)}
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
        </div>
        <div className="tp-actions" onClick={(e) => e.stopPropagation()}>
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
      {open && (
        <div className="tp-list">
          {jobList.map((j) => (
            <div key={j.id} className={`tp-row job st-${j.state}`}>
              <span className="tp-icon" title={JOB_DONE[j.kind]}>
                <Icon name={j.state === "error" ? "alert" : j.state === "cancelled" ? "x" : j.state === "done" ? "check-circle" : JOB_ICON[j.kind]} size={15} />
              </span>
              <div className="tp-name" title={j.title}>
                {j.title}
                {j.state === "error" && j.error && (
                  <div className="tp-err" title={errDetail(j.error) ?? undefined}>
                    {errSummary(j.error)}
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
          {syncs.map((sy) => (
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
                  <div className="tp-err" title={errDetail(t.error) ?? undefined}>
                    {errSummary(t.error)}
                  </div>
                )}
              </div>
              <div className="tp-meta">
                {t.state === "running" && (
                  <>
                    {formatBytes(t.bytes)} of {formatBytes(t.total)}
                    {t.speed > 0 && ` · ${formatSpeed(t.speed)}`}
                  </>
                )}
                {t.state !== "running" && t.total > 0 && formatBytes(t.total)}
              </div>
              {t.state === "running" || t.state === "queued" ? (
                <div className="bar">
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
                {t.state === "done" && t.kind === "download" && (
                  <button className="icon-btn" onClick={() => onReveal(t)} title="Show in Finder" aria-label="Show in Finder">
                    <Icon name="reveal" size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {queued.length > 40 && <div className="tp-more">+ {(queued.length - 40).toLocaleString()} more waiting</div>}
        </div>
      )}
    </section>
  );
}
