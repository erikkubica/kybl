import { memo, useMemo } from "react";
import { api, errSummary } from "../api";
import { Icon } from "../Icons";
import { baseName, formatBytes, formatEta, formatSpeed } from "../format";
import { useJobList, useJobs } from "../useJobs";
import { useTransferList, type TransferActions } from "../useTransfers";
import type { Transfer } from "../types";
import { JobsPanel, useActiveJobCount, useMigrations } from "../jobs";

/** Transfers still queued or running, bucket jobs and copies between connections in progress (for the badge). */
export function useActiveCount(): number {
  const list = useTransferList();
  const jobs = useJobList();
  const copies = useActiveJobCount();
  return useMemo(
    () => list.filter((t) => t.state === "queued" || t.state === "running").length + jobs.filter((j) => j.state === "running").length + copies,
    [list, jobs, copies],
  );
}

/**
 * The Transfers button with its running count. The count subscribes to transfer progress here,
 * in this one small button, so a progress tick doesn't re-render the whole file list.
 */
export function TransfersButton({ onClick }: { onClick: () => void }) {
  const count = useActiveCount();
  return (
    <button className="m-icon" onClick={onClick} aria-label={count ? `Transfers, ${count} running` : "Transfers"}>
      <Icon name="transfers" size={20} />
      {count > 0 && <span className="m-badge">{count > 99 ? "99+" : count}</span>}
    </button>
  );
}

const ORDER = { running: 0, queued: 1, paused: 2, error: 3, cancelled: 4, done: 5 } as const;

/** Retries every failed or stopped transfer (the queue's own `retryAll` where it has one). */
export function retryAllFailed(transfers: TransferActions, list: Transfer[]) {
  const all = (transfers as TransferActions & { retryAll?: () => void }).retryAll;
  if (all) return all();
  for (const t of list) if (t.state === "error" || t.state === "cancelled") transfers.retry(t.id);
}

export function TransfersScreen({
  onBack,
  transfers,
  savedWhere,
  onOpenFile,
  onOpenPlace,
}: {
  onBack: () => void;
  transfers: TransferActions;
  savedWhere: string;
  /** a finished download was tapped */
  onOpenFile: (path: string) => void;
  /** a finished copy between connections: show where it went */
  onOpenPlace?: (dst: { profileId: string; root: string; dir: string }) => void;
}) {
  const list = useTransferList();
  const jobs = useJobList();
  const jobActions = useJobs();
  const sorted = useMemo(() => [...list].sort((a, b) => ORDER[a.state] - ORDER[b.state]), [list]);
  const active = list.some((t) => t.state === "queued" || t.state === "running");
  const failed = list.filter((t) => t.state === "error" || t.state === "cancelled").length;
  // "Clear finished" takes done and cancelled items; failed ones stay until retried
  const finished = list.some((t) => t.state === "done" || t.state === "cancelled") || jobs.some((j) => j.state === "done" || j.state === "cancelled");
  const copies = useMigrations().length;
  const copiesSection = copies > 0 && (
    <section className="m-jobs-section">
      <h3 className="m-section">Copies between connections</h3>
      <JobsPanel variant="mobile" hideWhenEmpty onOpenDest={onOpenPlace && ((j) => onOpenPlace(j.spec.dst))} />
    </section>
  );

  return (
    <section className="m-screen m-overlay">
      <header className="m-bar solid">
        <button className="m-icon" onClick={onBack} aria-label="Back">
          <Icon name="arrow-left" size={22} />
        </button>
        <div className="m-title">
          <h1>Transfers</h1>
        </div>
        {active && (
          <button className="m-text-btn danger" onClick={() => transfers.cancelAll()}>
            Stop all
          </button>
        )}
      </header>
      <div className="m-scroll">
        {list.length === 0 && jobs.length === 0 ? (
          copiesSection || (
            <div className="m-empty">
              <Icon name="transfers" size={30} />
              <h3>No transfers</h3>
              <p>Uploads and downloads show up here. Downloads are saved to {savedWhere}.</p>
            </div>
          )
        ) : (
          <>
            {(failed > 0 || finished) && (
              <div className="m-xfer-tools">
                {failed > 0 && (
                  <button className="m-pill" onClick={() => retryAllFailed(transfers, list)}>
                    <Icon name="retry" size={14} /> Retry {failed} failed
                  </button>
                )}
                {finished && (
                  <button
                    className="m-pill"
                    onClick={() => {
                      transfers.clearFinished();
                      jobActions.clearFinished();
                    }}
                  >
                    <Icon name="check" size={14} /> Clear finished
                  </button>
                )}
              </div>
            )}
            <ul className="m-list">
              {jobs.map((j) => (
                <li key={j.id} className="m-row m-xfer">
                  <span className="m-xfer-main">
                    <span className={`m-xfer-ico ${j.state}`}>
                      <Icon name={j.state === "done" ? "check-circle" : j.state === "error" ? "alert" : j.kind === "delete" ? "trash" : j.kind === "rename" ? "edit" : "move"} size={18} />
                    </span>
                    <span className="m-row-text">
                      <span className="m-row-name">{j.title}</span>
                      <span className="m-row-sub">
                        {j.state === "running" ? (j.total ? `${j.done.toLocaleString()} of ${j.total.toLocaleString()}${j.eta ? ` · ${j.eta}` : ""}` : "Finding objects…") : j.state === "error" ? errSummary(j.error ?? "Failed") : j.state === "cancelled" ? "Stopped" : "Done"}
                      </span>
                      {j.state === "running" && <Progress frac={j.frac} />}
                    </span>
                  </span>
                  {j.state === "running" ? (
                    <button className="m-icon" onClick={() => api.cancelTransfer(j.id).catch(() => {})} aria-label="Stop">
                      <Icon name="x" size={18} />
                    </button>
                  ) : (
                    <button className="m-icon" onClick={() => jobActions.dismiss(j.id)} aria-label="Dismiss">
                      <Icon name="x" size={16} />
                    </button>
                  )}
                </li>
              ))}
              {sorted.map((t) => (
                <TransferRow key={t.id} t={t} transfers={transfers} onOpenFile={onOpenFile} />
              ))}
            </ul>
            {copiesSection}
          </>
        )}
      </div>
    </section>
  );
}

function Progress({ frac }: { frac: number | null }) {
  return (
    <span className={`m-progress ${frac == null ? "indeterminate" : ""}`}>
      <span style={{ width: frac == null ? undefined : `${Math.round(Math.min(1, frac) * 100)}%` }} />
    </span>
  );
}

const TransferRow = memo(function TransferRow({ t, transfers, onOpenFile }: { t: Transfer; transfers: TransferActions; onOpenFile: (path: string) => void }) {
  const frac = t.total ? t.bytes / t.total : t.state === "running" ? null : 0;
  // downloads get a free name when the file is already there ("photo (1).jpg"): say so
  const savedAs = t.kind === "download" && t.local ? baseName(t.local.replace(/\\/g, "/")) : "";
  const renamed = !!savedAs && savedAs !== baseName(t.name);
  let sub: string;
  if (t.state === "running") {
    const left = t.speed > 0 && t.total ? (t.total - t.bytes) / t.speed : 0;
    // total 0: a Google Docs export, whose size isn't known until it's done
    sub = `${t.total ? `${formatBytes(t.bytes)} of ${formatBytes(t.total)}` : formatBytes(t.bytes)}${t.speed ? ` · ${formatSpeed(t.speed)}` : ""}${left ? ` · ${formatEta(left)}` : ""}`;
  } else if (t.state === "queued") sub = t.total ? `Waiting · ${formatBytes(t.total)}` : "Waiting";
  else if (t.state === "done") sub = t.kind === "upload" ? `Uploaded · ${formatBytes(t.total)}` : `${renamed ? `Saved as “${savedAs}”` : "Saved"} · ${formatBytes(t.total || t.bytes)} · Tap to open`;
  else if (t.state === "cancelled") sub = "Stopped · Tap to retry";
  else if (t.state === "paused") sub = `Paused${t.total ? ` · ${formatBytes(t.bytes)} of ${formatBytes(t.total)}` : ""} · Tap to resume`;
  else sub = `${errSummary(t.error ?? "Failed")} · Tap to retry`;
  const tap =
    t.state === "done" && t.kind === "download"
      ? () => onOpenFile(t.local)
      : t.state === "error" || t.state === "cancelled" || t.state === "paused"
        ? () => transfers.retry(t.id)
        : null;
  const body = (
    <>
      <span className={`m-xfer-ico ${t.state}`}>
        <Icon name={t.state === "done" ? "check-circle" : t.state === "error" ? "alert" : t.kind === "upload" ? "upload" : "download"} size={18} />
      </span>
      <span className="m-row-text">
        <span className="m-row-name">{t.name}</span>
        <span className={`m-row-sub ${t.state === "error" ? "danger" : ""}`}>{sub}</span>
        {(t.state === "running" || t.state === "queued" || t.state === "paused") && <Progress frac={t.state === "queued" ? 0 : frac} />}
      </span>
    </>
  );
  return (
    <li className="m-row m-xfer">
      {tap ? (
        <button className="m-xfer-main" onClick={tap}>
          {body}
        </button>
      ) : (
        <span className="m-xfer-main">{body}</span>
      )}
      {t.state === "running" || t.state === "queued" ? (
        <button className="m-icon" onClick={() => transfers.cancel(t.id)} aria-label={`Stop ${t.name}`}>
          <Icon name="x" size={18} />
        </button>
      ) : t.state === "paused" ? (
        <button className="m-icon" onClick={() => transfers.resume(t.id)} aria-label={`Resume ${t.name}`}>
          <Icon name="play" size={17} />
        </button>
      ) : t.state === "error" || t.state === "cancelled" ? (
        <button className="m-icon" onClick={() => transfers.retry(t.id)} aria-label={`Retry ${t.name}`}>
          <Icon name="retry" size={17} />
        </button>
      ) : null}
    </li>
  );
});
