import { Icon, type IconName } from "../Icons";
import { errMessage } from "../api";
import { ErrorText } from "./ErrorText";
import { formatBytes, formatEta, formatSpeed, mbpsInput, mbpsToKbps, parseMbps, plural } from "../format";
import type { Transfer, TransferState } from "../types";
import { useJobList, type Job, type JobKind } from "../useJobs";
import { runCounts, runTotals, transferActions, transferControls, usePrunedDone, useTransferList } from "../useTransfers";
import { useSync } from "../sync";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, PromptDialog, type MenuItem } from "./Dialogs";
import { MBPS, limitLabel, saveTransferPrefs, useTransferPrefsStore } from "../transferPrefs";
import "./transfers.css";
import { clearLog, logMessage, useActivityLog } from "../activityLog";
import { logAsText } from "../logText.ts";
import type { JobSummary } from "../api";
import { JobsPanel, isActive as migrationActive, jobFilesCount, jobMeta as migrationMeta, migrations as migrationStore, useMigrations } from "../jobs";
import { useJobs } from "../useJobs";
import { ON_OS } from "../osNames";
import { connWithRoot } from "../transferLog";

/** A synced folder that is busy right now (shown read-only). */
export type SyncActivity = { id: string; name: string; direction: "upload" | "download" | "twoway"; state: "scanning" | "syncing"; done: number; total: number; current: string | null; bytes: number; totalBytes: number };

const JOB_ICON: Record<JobKind, IconName> = { move: "move", copy: "copy", delete: "trash", rename: "edit", action: "play" };
const JOB_DONE: Record<JobKind, string> = { move: "Moved", copy: "Copied", delete: "Deleted", rename: "Renamed", action: "Finished" };

function jobMeta(j: Job): string {
  if (j.kind === "action") return j.state === "running" ? "Running…" : "";
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
/**
 * Where a row goes (an upload: the connection and folder; a download: the folder on this
 * computer and where from), so a list of relative names says where they land.
 */
function routeOf(t: Transfer): string | null {
  const dirOf = (p: string) => p.replace(/[\\/]+[^\\/]*$/, "");
  if (t.kind === "upload") {
    const k = t.key.replace(/\/$/, "");
    const dir = k.includes("/") ? k.slice(0, k.lastIndexOf("/") + 1) : "";
    return `to ${connWithRoot(t.profileId, t.bucket)} · /${dir}`;
  }
  if (t.kind === "download" && t.local) return `to ${dirOf(t.local)} · from ${connWithRoot(t.profileId, t.bucket)}`;
  return null;
}

const KIND_DONE: Record<Transfer["kind"], string> = { upload: "Uploaded", download: "Downloaded", compress: "Compressed", extract: "Extracted" };
const STATE_ICON: Record<TransferState, IconName> = {
  running: "upload",
  queued: "clock",
  paused: "pause",
  done: "check-circle",
  error: "alert",
  cancelled: "x",
};

const VERIFIED: Record<string, string> = {
  size: "the size matches",
  md5: "the MD5 checksum matches",
  etag: "the checksum (S3 ETag) matches",
  sha256: "the SHA-256 checksum matches",
  quickxor: "the OneDrive checksum matches",
  dropbox: "the Dropbox checksum matches",
};

const SPEED_PRESETS = [0, 1, 5, 10];

/** Failed rows listed at most; the rest are counted below them (Retry all and Clear failed cover every one). */
const FAILED_SHOWN = 200;
/** Finished rows listed at most; older ones are still counted (the Done tab says how many). */
const DONE_SHOWN = 200;
/** Waiting rows listed at most; the rest are counted under "Queued". */
const QUEUED_SHOWN = 40;

/** Uploads and downloads can pause and move up the queue; compress and extract run on their own. */
const pausable = (t: Transfer) => t.kind === "upload" || t.kind === "download";

/**
 * The speed limit at hand: a gauge in the header with presets for both directions (Settings has
 * one per direction), and "limited to 5 MB/s" beside it while a limit is on.
 */
function SpeedMenu() {
  const prefs = useTransferPrefsStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [custom, setCustom] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!prefs) return null;
  const down = prefs.downloadLimitKbps;
  const up = prefs.uploadLimitKbps;
  const same = down === up;
  const set = (kbps: number) => {
    setFailed(false);
    saveTransferPrefs({ downloadLimitKbps: kbps, uploadLimitKbps: kbps }).catch((e) => {
      setFailed(true);
      logMessage("error", `The speed limit wasn't saved: ${errMessage(e)}`);
    });
  };
  const isPreset = same && SPEED_PRESETS.some((mb) => Math.round(mb * MBPS) === down);
  const items: MenuItem[] = [
    { type: "label", label: same ? "Speed limit" : `Speed limit · ↓ ${down ? limitLabel(down) : "none"} · ↑ ${up ? limitLabel(up) : "none"}` },
    ...SPEED_PRESETS.map(
      (mb): MenuItem => ({
        type: "item",
        label: mb === 0 ? "No limit" : `${mb} MB/s`,
        checked: same && Math.round(mb * MBPS) === down,
        onClick: () => set(Math.round(mb * MBPS)),
      }),
    ),
    { type: "item", label: isPreset || (!down && !up) ? "Custom…" : `Custom (${same ? limitLabel(down) : "per direction"})…`, checked: !isPreset && (down > 0 || up > 0), onClick: () => setCustom(true) },
  ];
  const text = !down && !up ? null : same ? `limited to ${limitLabel(down)}` : [down && `↓ ${limitLabel(down)}`, up && `↑ ${limitLabel(up)}`].filter(Boolean).join(" ");
  return (
    <div className="tp-speed" onClick={(e) => e.stopPropagation()}>
      <button
        className={`icon-btn ${text ? "on" : ""}`}
        title={text ? `Speed ${text}. Change it` : "Limit the speed"}
        aria-label="Speed limit"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.top });
        }}
      >
        <Icon name="gauge" size={14} />
      </button>
      {failed ? <span className="tp-limit tp-limit-err">limit not saved</span> : text && <span className="tp-limit">{text}</span>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} label="Speed limit" onClose={() => setMenu(null)} />}
      {custom && (
        <PromptDialog
          title="Speed limit"
          label="MB/s, for uploads and downloads each (0: no limit)"
          initial={down ? mbpsInput(down / MBPS) : ""}
          selectAll
          confirmLabel="Limit"
          check={(v) => {
            const mb = parseMbps(v);
            return typeof mb === "string" ? mb : null;
          }}
          onSubmit={(v) => {
            const mb = parseMbps(v);
            // a tiny limit stays a limit (1 KB/s at least), never "none"
            if (typeof mb === "number") set(mbpsToKbps(mb));
          }}
          onClose={() => setCustom(false)}
        />
      )}
    </div>
  );
}

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
        const name = m.localPath.split(/[\\/]+/).filter(Boolean).pop() ?? m.localPath;
        return [{ id: m.id, name, direction: m.direction, state: "syncing", done: st.done, total: st.total, current: st.current, bytes: st.bytes ?? 0, totalBytes: st.totalBytes ?? 0 }];
      }),
    [sync],
  );
  const migs = useMigrations();
  // a paused copy still holds work: listed (and counted) with what is in progress
  const migsActive = useMemo(() => migs.filter((m) => migrationActive(m) || m.progress.state === "paused"), [migs]);
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
  /** a job's Stop; `kind` lets custom actions stop their own way (still downloading their files) */
  onCancelJob: (id: string, kind: JobKind) => void;
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
  /** open a finished download in its default app (asking first about a program: `openGuard`) */
  onOpenLocal(t: Transfer): void;
  /**
   * Show the panel with a short "nothing here" note while there is no activity, for when the
   * user opened it on purpose (an Activity button or menu item). Off: no activity, no panel.
   */
  showEmpty?: boolean;
  /** something of the caller's in the header ("Editing (n)", src/edit); it renders nothing when idle */
  extra?: React.ReactNode;
  /** `extra` has something to show: the panel stays, even with no transfers */
  extraShown?: boolean;
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
  extra,
  extraShown,
}: PanelProps) {
  const jobActions = useJobs();
  const prunedDone = usePrunedDone();
  const nothing = transfers.length === 0 && jobs.length === 0 && syncs.length === 0;
  // no activity and no copies between connections: no panel, unless it was opened on purpose
  if (nothing && migrations === 0 && !(showEmpty && open) && !extraShown) return null;
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
  // every running and failed job (the Failed tab counts them all), and the 30 latest finished
  const byFinished = (a: Job, b: Job) => (b.finished ?? 0) - (a.finished ?? 0);
  const jobList = [...jobsRunning, ...[...jobsFailed].sort(byFinished), ...[...jobsDone, ...jobsCancelled].sort(byFinished).slice(0, 30)];

  const running = transfers.filter((t) => t.state === "running");
  const queued = transfers.filter((t) => t.state === "queued");
  const failed = transfers.filter((t) => t.state === "error");
  const done = transfers.filter((t) => t.state === "done");
  const paused = transfers.filter((t) => t.state === "paused");
  const active = running.length + queued.length;
  // the backend's own transfers (edited files saving back) can't be paused or cancelled from here
  const manageable = (t: Transfer) => transferControls(t.id).manage;
  const activeManaged = running.filter(manageable).length + queued.filter(manageable).length;
  const retryable = failed.filter((t) => transferControls(t.id).retry);

  // this run only: rows finished in an earlier batch don't count in "X of Y" and the time left
  const { total: totalBytes, done: doneBytes } = runTotals(transfers);
  const speed = running.reduce((s, t) => s + t.speed, 0);
  const pct = totalBytes > 0 ? Math.min(100, (doneBytes / totalBytes) * 100) : 0;
  const eta = speed > 0 ? (totalBytes - doneBytes) / speed : 0;

  const cancelled = transfers.filter((t) => t.state === "cancelled");
  // the run in counts: finished rows are in Done (the header's "done of" counts them as they go)
  const run = runCounts(transfers);
  const list = [
    ...(show("progress") ? running : []),
    // capped like the others: tens of thousands of failed rows would freeze the window
    ...(show("failed") ? failed.slice(0, FAILED_SHOWN) : []),
    ...(show("progress") ? queued.slice(0, QUEUED_SHOWN) : []),
    ...(show("progress") ? paused.slice(0, 40) : []),
    ...(show("done") ? done.slice(-DONE_SHOWN).reverse() : []),
    ...(show("done") ? cancelled.slice(-20).reverse() : []),
  ];
  // In progress tells running from waiting: a heading before each group's first row
  const heads = new Map<string, string>();
  if (onTab && tab === "activity") {
    if (running[0]) heads.set(running[0].id, `Running (${running.length.toLocaleString()})`);
    if (queued[0]) heads.set(queued[0].id, `Queued (${queued.length.toLocaleString()})`);
    if (paused[0]) heads.set(paused[0].id, `Paused (${paused.length.toLocaleString()})`);
  }
  const shownJobs = jobList.filter((j) => (j.state === "running" ? show("progress") : j.state === "error" ? show("failed") : show("done")));
  const shownSyncs = show("progress") ? syncs : [];
  // copies between connections show here too (with tabs); their details and controls are in Jobs
  const shownMigs = onTab
    ? [...(show("progress") ? migrationsActive : []), ...(show("failed") ? migrationsFailed : []), ...(show("done") ? migrationsDone.slice(0, 30) : [])]
    : [];
  const counts = {
    progress: active + paused.length + jobsRunning.length + syncs.length + migrationsActive.length,
    failed: failed.length + jobsFailed.length + migrationsFailed.length,
    // plus the ones pruned off the list: the count stays the true number
    done: done.length + prunedDone + cancelled.length + jobsDone.length + jobsCancelled.length + migrationsDone.length,
  };
  // finished rows past the caps above: said, like the other capped lists
  const doneHidden =
    counts.done - Math.min(done.length, DONE_SHOWN) - Math.min(cancelled.length, 20) - Math.min(jobsDone.length + jobsCancelled.length, 30) - (onTab ? Math.min(migrationsDone.length, 30) : migrationsDone.length);
  const onLog = !!onTab && tab === "log";
  const tabEmpty = shownJobs.length + shownSyncs.length + shownMigs.length + list.length === 0;
  const EMPTY_NOTE: Record<string, string> = {
    activity: "Nothing in progress right now.",
    failed: "Nothing has failed.",
    done: "Nothing has finished yet.",
  };

  const cancelledCount = transfers.length - active - paused.length - done.length - failed.length + jobsCancelled.length;
  const activeAll = active + paused.length + jobsRunning.length + syncs.length + migrationsActive.length;
  const doneAll = done.length + jobsDone.length;
  const failedAll = failed.length + jobsFailed.length;
  const finishedAll = done.length + cancelled.length + jobsDone.length + jobsCancelled.length + (onTab ? migrationsDone.length : 0);
  // with no transfers running, the header summarises the first running job, then the first copy
  // between connections
  const leadJob = active === 0 ? jobsRunning[0] : undefined;
  const leadMig = active === 0 && !leadJob ? migrationsActive.find((m) => m.progress.state !== "paused") : undefined;
  const leadMigFrac = leadMig && leadMig.progress.state !== "planning" && leadMig.progress.bytesTotal > 0 ? leadMig.progress.bytesDone / leadMig.progress.bytesTotal : null;
  // "Retry all": failed transfers, failed moves / copies / deletes, and copies between connections
  const retryJobs = jobsFailed.filter((j) => j.retry);
  const retryMigs = (onTab ? migrationsFailed : []).flatMap((m) => {
    const r = migrationRetry(m);
    return r ? [r] : [];
  });
  const retryCount = retryable.length + retryJobs.length + retryMigs.length;
  const retryAll = () => {
    if (onRetryAll) onRetryAll();
    else retryable.forEach((t) => onRetry(t.id));
    for (const j of retryJobs) jobActions.retry(j.id);
    for (const r of retryMigs) void r().catch(() => {});
  };
  const clearFinished = () => {
    onClear();
    if (onTab) for (const m of migrationsDone) void migrationStore.remove(m.id).catch(() => {});
  };
  const openLocal = (t: Transfer) => onOpenLocal(t);
  // only what fits the tab on screen (all of it without tabs)
  const acts = {
    retry: retryCount > 0 && (!onTab || tab === "activity" || tab === "failed"),
    cancel: activeManaged > 0 && (!onTab || tab === "activity"),
    pause: activeManaged > 0 && (!onTab || tab === "activity"),
    resume: paused.length > 0 && (!onTab || tab === "activity"),
    clear: finishedAll > 0 && (!onTab || tab === "done"),
    clearFailed: !!onClearFailed && counts.failed > 0 && !!onTab && tab === "failed",
  };
  const showActs = !(open && (onJobs || onLog)) && (acts.retry || acts.cancel || acts.pause || acts.resume || acts.clear || acts.clearFailed);
  const firstQueued = queued[0]?.id;

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
              <button
                key={id}
                role="tab"
                aria-selected={open && tab === id}
                className={open && tab === id ? "on" : ""}
                onClick={() => pickTab(id)}
                title={id === "done" && prunedDone > 0 ? `${n.toLocaleString()} finished. The list shows the latest ${DONE_SHOWN.toLocaleString()}.` : undefined}
              >
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
        {extra}
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
              <span className="tp-run" title="Running now, waiting for a turn, and finished, out of everything started in this run">
                {running.length.toLocaleString()} running · {queued.length.toLocaleString()} queued · {run.done.toLocaleString()} done of {run.total.toLocaleString()}
              </span>
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
        {onTab && <SpeedMenu />}
        {/* not on Jobs (its own buttons) or Log; each tab gets what fits it. Narrow: icons with their names as tooltips */}
        {showActs && (
          <div className="tp-actions" onClick={(e) => e.stopPropagation()}>
            {acts.resume && (
              <button className="btn btn-ghost btn-sm" onClick={() => transferActions.resumeAll()} title="Carry on with every paused transfer" aria-label="Resume all">
                <Icon name="play" size={13} /> <span className="tp-lbl">Resume all</span>
              </button>
            )}
            {acts.pause && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => transferActions.pauseAll()}
                title="Stop every upload and download, keeping what they did, to carry on later (also after a restart)"
                aria-label="Pause all"
              >
                <Icon name="pause" size={13} /> <span className="tp-lbl">Pause all</span>
              </button>
            )}
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
                            ? `${p.filesFailed.toLocaleString()} of ${plural(p.filesTotal, "file")} couldn’t be ${verb}`
                            : p.state === "done" || p.state === "cancelled"
                              ? migrationMeta(m)
                              : jobFilesCount(p) + (p.bytesTotal > 0 ? ` · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}` : "")}
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
                  <button className="icon-btn" onClick={() => onCancelJob(j.id, j.kind)} title="Stop. What’s done stays done; nothing is half-moved." aria-label="Stop">
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
                  : `${sy.done.toLocaleString()} of ${plural(sy.total, "file")}` + (sy.totalBytes > 0 ? ` · ${formatBytes(sy.bytes)} of ${formatBytes(sy.totalBytes)}` : "")}
              </div>
              <div className={`bar ${sy.state === "scanning" || !sy.total ? "indeterminate" : ""}`}>
                <div style={{ width: `${Math.round((sy.totalBytes > 0 ? sy.bytes / sy.totalBytes : sy.total ? sy.done / sy.total : 0) * 100)}%` }} />
              </div>
              <div className="tp-row-actions" />
            </div>
          ))}
          {list.map((t) => {
            const ctl = transferControls(t.id);
            const head = heads.get(t.id);
            const route = routeOf(t);
            return (
              <Fragment key={t.id}>
                {head && <div className="tp-group">{head}</div>}
              <div className={`tp-row st-${t.state}`}>
                <span className="tp-icon" title={KIND_LABEL[t.kind]}>
                  <Icon name={t.state === "running" ? (t.kind === "upload" || t.kind === "download" ? t.kind : "archive") : STATE_ICON[t.state]} size={15} />
                </span>
                <div className="tp-name" title={t.kind === "download" && t.local ? t.local : t.key}>
                  {t.name}
                  {route && <div className="tp-route">{route}</div>}
                  {t.state === "error" && t.error && (
                    <div className="tp-err">
                      <ErrorText message={t.error} />
                    </div>
                  )}
                  {t.state === "done" && t.error && <div className="tp-note">{t.error}</div>}
                </div>
                <div className="tp-meta">
                  {t.state === "running" && (
                    <>
                      {t.phase && `${t.phase} · `}
                      {/* total 0: a Google Docs export, whose size isn't known until it's done */}
                      {t.total > 0 ? `${formatBytes(t.bytes)} of ${formatBytes(t.total)}` : formatBytes(t.bytes)}
                      {t.speed > 0 && ` · ${formatSpeed(t.speed)}`}
                    </>
                  )}
                  {t.state === "paused" &&
                    (t.checkPending ? `Downloaded, check paused · ${formatBytes(t.total)}` : t.total > 0 ? `Paused · ${formatBytes(t.bytes)} of ${formatBytes(t.total)}` : "Paused")}
                  {t.state !== "running" && t.state !== "paused" && (t.total || (t.state === "done" ? t.bytes : 0)) > 0 && formatBytes(t.total || t.bytes)}
                </div>
                {t.state === "running" || t.state === "queued" || t.state === "paused" ? (
                  <div className={`bar ${t.state === "running" && !t.total ? "indeterminate" : ""}`}>
                    <div style={{ width: `${t.total > 0 ? Math.min(100, (t.bytes / t.total) * 100) : 0}%` }} />
                  </div>
                ) : (
                  <div className="tp-state">
                    {t.state === "done" && KIND_DONE[t.kind]}
                    {t.state === "done" && t.verified && (
                      <span className="tp-verified" title={`Verified: ${VERIFIED[t.verified] ?? "it matches"}`} aria-label="Verified">
                        <Icon name="check" size={11} /> verified
                      </span>
                    )}
                    {t.state === "done" && t.checkStopped && (
                      <span className="tp-unverified" title="Cancel stopped the check after copying. The file is there, but it wasn't checked.">
                        · not checked
                      </span>
                    )}
                    {t.state === "cancelled" && "Cancelled"}
                    {t.state === "error" && "Failed"}
                  </div>
                )}
                <div className="tp-row-actions">
                  {t.state === "queued" && t.id !== firstQueued && ctl.manage && pausable(t) && (
                    <button className="icon-btn" onClick={() => transferActions.moveToTop(t.id)} title="Move to top: start this one next" aria-label={`Move ${t.name} to top`}>
                      <Icon name="to-top" size={13} />
                    </button>
                  )}
                  {(t.state === "running" || t.state === "queued") && ctl.manage && pausable(t) && (
                    <button className="icon-btn" onClick={() => transferActions.pause(t.id)} title="Pause, keeping what’s done" aria-label={`Pause ${t.name}`}>
                      <Icon name="pause" size={13} />
                    </button>
                  )}
                  {t.state === "paused" && (
                    <button
                      className="icon-btn"
                      onClick={() => transferActions.resume(t.id)}
                      title={t.checkPending ? "Check it now" : "Resume from where it stopped"}
                      aria-label={t.checkPending ? `Check ${t.name}` : `Resume ${t.name}`}
                    >
                      <Icon name="play" size={13} />
                    </button>
                  )}
                  {(t.state === "running" || t.state === "queued" || t.state === "paused") && ctl.manage && (
                    <button className="icon-btn" onClick={() => onCancel(t.id)} title={t.state !== "paused" ? "Cancel" : t.checkPending ? "Keep the file, skip the check" : "Cancel and drop what was done"} aria-label="Cancel">
                      <Icon name="x" size={13} />
                    </button>
                  )}
                  {(t.state === "error" || t.state === "cancelled") && ctl.retry && (
                    <button className="icon-btn" onClick={() => onRetry(t.id)} title="Retry" aria-label="Retry">
                      <Icon name="retry" size={13} />
                    </button>
                  )}
                  {(t.state === "done" || t.checkPending) && t.kind === "download" && t.local && (
                    <>
                      <button className="icon-btn" onClick={() => openLocal(t)} title="Open" aria-label={`Open ${t.name}`}>
                        <Icon name="external" size={13} />
                      </button>
                      <button className="icon-btn" onClick={() => onReveal(t)} title={ON_OS.showInFiles} aria-label={`Show ${t.name} in ${ON_OS.fileManager}`}>
                        <Icon name="reveal" size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              </Fragment>
            );
          })}
          {show("failed") && failed.length > FAILED_SHOWN && <div className="tp-more">+ {(failed.length - FAILED_SHOWN).toLocaleString()} more failed</div>}
          {show("progress") && queued.length > QUEUED_SHOWN && <div className="tp-more">+ {(queued.length - QUEUED_SHOWN).toLocaleString()} more queued</div>}
          {show("progress") && paused.length > 40 && <div className="tp-more">+ {(paused.length - 40).toLocaleString()} more paused</div>}
          {show("done") && doneHidden > 0 && (
            <div className="tp-more">
              + {doneHidden.toLocaleString()} more finished{prunedDone > 0 ? " (counted, not listed)" : ""}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The Log tab: what Kybl did and said this session, newest at the bottom: transfers started and
 * finished, connecting, and every error, each with its technical side under "Details".
 */
function MessageLog() {
  const log = useActivityLog();
  const box = useRef<HTMLDivElement>(null);
  const [problems, setProblems] = useState(false);
  const [copied, setCopied] = useState(false);
  const errors = useMemo(() => log.filter((m) => m.kind === "error").length, [log]);
  const shown = problems ? log.filter((m) => m.kind === "error") : log;
  // follow new messages while the view is at the bottom; scrolling up to read holds it
  const follow = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shown[shown.length - 1]?.id]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  if (!log.length)
    return (
      <div className="tp-empty" id="tp-list">
        <Icon name="info" size={18} />
        <span>What Kybl does and tells you collects here for this session: downloads and uploads started and finished, connecting, and anything that went wrong.</span>
      </div>
    );
  const copy = () =>
    void navigator.clipboard
      // the whole log, whatever the filter shows: a bug report needs the lines before the error
      ?.writeText(logAsText(log))
      .then(() => setCopied(true))
      .catch(() => {});
  return (
    <div
      ref={box}
      className="tp-list tp-log"
      id="tp-list"
      role="log"
      aria-live="off"
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {(errors > 0 || problems) && (
        <div className="tp-log-filter">
          <button className={`btn btn-ghost btn-sm ${problems ? "on" : ""}`} aria-pressed={problems} onClick={() => setProblems((v) => !v)}>
            <Icon name="alert" size={12} /> {problems ? "Showing problems only" : `Only problems (${errors.toLocaleString()})`}
          </button>
        </div>
      )}
      {shown.map((m) => (
        <div key={m.id} className={`tp-log-row k-${m.kind}`}>
          <time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
          <Icon name={m.kind === "error" ? "alert" : m.kind === "success" ? "check-circle" : "info"} size={13} />
          <div className="tp-log-body">
            <span className="tp-log-text">
              {m.kind === "error" && <span className="tp-log-sr">Problem: </span>}
              {m.text}
            </span>
            {m.detail && (
              <details className="tp-log-more">
                <summary>Details</summary>
                <pre className="selectable">{m.detail}</pre>
              </details>
            )}
          </div>
        </div>
      ))}
      <div className="tp-log-tools">
        <button className="btn btn-ghost btn-sm" onClick={copy} title="Copy the log as text, with details (for a bug report)">
          <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy log"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={clearLog}>
          Clear log
        </button>
      </div>
    </div>
  );
}
