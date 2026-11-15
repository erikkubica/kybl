import { useMemo } from "react";
import { api, errSummary } from "../api";
import { Icon } from "../Icons";
import { formatBytes, formatEta, formatSpeed } from "../format";
import { useJobList, useJobs } from "../useJobs";
import { useTransferList, type TransferActions } from "../useTransfers";
import type { Transfer } from "../types";

/** Transfers still queued or running, plus bucket jobs in progress (for the badge). */
export function useActiveCount(): number {
  const list = useTransferList();
  const jobs = useJobList();
  return useMemo(
    () => list.filter((t) => t.state === "queued" || t.state === "running").length + jobs.filter((j) => j.state === "running").length,
    [list, jobs],
  );
}

const ORDER = { running: 0, queued: 1, error: 2, cancelled: 3, done: 4 } as const;

export function TransfersScreen({ onBack, transfers, savedWhere }: { onBack: () => void; transfers: TransferActions; savedWhere: string }) {
  const list = useTransferList();
  const jobs = useJobList();
  const jobActions = useJobs();
  const sorted = useMemo(() => [...list].sort((a, b) => ORDER[a.state] - ORDER[b.state]), [list]);
  const active = list.some((t) => t.state === "queued" || t.state === "running");
  const finished = list.some((t) => t.state !== "queued" && t.state !== "running") || jobs.some((j) => j.state !== "running");

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
        {finished && (
          <button
            className="m-text-btn"
            onClick={() => {
              transfers.clearFinished();
              jobActions.clearFinished();
            }}
          >
            Clear
          </button>
        )}
      </header>
      <div className="m-scroll">
        {list.length === 0 && jobs.length === 0 ? (
          <div className="m-empty">
            <Icon name="transfers" size={30} />
            <h3>No transfers</h3>
            <p>Uploads and downloads show up here. Downloads are saved to {savedWhere}.</p>
          </div>
        ) : (
          <ul className="m-list">
            {jobs.map((j) => (
              <li key={j.id} className="m-row m-xfer">
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
              <TransferRow key={t.id} t={t} transfers={transfers} />
            ))}
          </ul>
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

function TransferRow({ t, transfers }: { t: Transfer; transfers: TransferActions }) {
  const frac = t.total ? t.bytes / t.total : t.state === "running" ? null : 0;
  let sub: string;
  if (t.state === "running") {
    const left = t.speed > 0 && t.total ? (t.total - t.bytes) / t.speed : 0;
    sub = `${formatBytes(t.bytes)} of ${formatBytes(t.total)}${t.speed ? ` · ${formatSpeed(t.speed)}` : ""}${left ? ` · ${formatEta(left)}` : ""}`;
  } else if (t.state === "queued") sub = `Waiting · ${formatBytes(t.total)}`;
  else if (t.state === "done") sub = `${t.kind === "upload" ? "Uploaded" : "Saved"} · ${formatBytes(t.total)}`;
  else if (t.state === "cancelled") sub = "Stopped";
  else sub = errSummary(t.error ?? "Failed");
  return (
    <li className="m-row m-xfer">
      <span className={`m-xfer-ico ${t.state}`}>
        <Icon name={t.state === "done" ? "check-circle" : t.state === "error" ? "alert" : t.kind === "upload" ? "upload" : "download"} size={18} />
      </span>
      <span className="m-row-text">
        <span className="m-row-name">{t.name}</span>
        <span className={`m-row-sub ${t.state === "error" ? "danger" : ""}`}>{sub}</span>
        {(t.state === "running" || t.state === "queued") && <Progress frac={t.state === "queued" ? 0 : frac} />}
      </span>
      {t.state === "running" || t.state === "queued" ? (
        <button className="m-icon" onClick={() => transfers.cancel(t.id)} aria-label="Stop">
          <Icon name="x" size={18} />
        </button>
      ) : t.state === "error" || t.state === "cancelled" ? (
        <button className="m-icon" onClick={() => transfers.retry(t.id)} aria-label="Retry">
          <Icon name="retry" size={17} />
        </button>
      ) : null}
    </li>
  );
}
