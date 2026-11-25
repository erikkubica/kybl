/** Pieces the backup screens share: names, status lines, the permission note, the home card. */
import type { ReactNode } from "react";
import type { BackupOverview, BackupPermission, BackupSet, BackupSetStatus } from "../../core/api";
import { Icon } from "../../ui/components/Icons";
import { ago } from "../../updates/updates";
import { MIcon } from "../components/icons";

/** Said wherever backup is offered: what really happens, nothing more. */
export const HONEST = "Backs up while Kybl is open, and overnight while charging.";

export type Platform = BackupOverview["platform"];

export const setName = (s: BackupSet) => (s.source.type === "cameraRoll" ? "Camera roll" : s.source.label || "Folder");
export const isRoll = (s: BackupSet) => s.source.type === "cameraRoll";
const n = (x: number) => x.toLocaleString();

export type Tone = "ok" | "busy" | "warn" | "dim";

/** What a set is doing, in a few words. */
export function stateLine(st: BackupSetStatus): { text: string; tone: Tone } {
  switch (st.state) {
    case "running":
      return { text: st.runTotal ? `Backing up ${n(Math.min(st.runDone + 1, st.runTotal))} of ${n(st.runTotal)}` : "Looking for new items…", tone: "busy" };
    case "waitingWifi":
      return { text: "Waiting for Wi-Fi", tone: "warn" };
    case "waitingNetwork":
      return { text: "Waiting for a connection", tone: "warn" };
    case "needsAuth":
      return { text: "Sign in to this connection again to keep backing up", tone: "warn" };
    case "paused":
      return { text: "Paused", tone: "dim" };
  }
  if (st.lastError) return { text: st.lastError, tone: "warn" };
  if (st.pending > 0) return { text: `${n(st.pending)} waiting to be backed up`, tone: "dim" };
  // items that failed are not backed up: never "up to date" while there are some
  if (st.lastRun) return st.failed ? { text: `Checked ${ago(st.lastRun)}`, tone: "dim" } : { text: `Up to date · checked ${ago(st.lastRun)}`, tone: "ok" };
  return { text: "Starts in a moment", tone: "dim" };
}

/** "1,284 backed up · 2 couldn't be backed up" */
export function countsLine(st: BackupSetStatus): string {
  const parts = [`${n(st.backedUp)} backed up`];
  if (st.failed) parts.push(`${n(st.failed)} couldn't be backed up`);
  return parts.join(" · ");
}

export function SetIcon({ set, size = 22 }: { set: BackupSet; size?: number }) {
  return <span className={`bk-ico ${isRoll(set) ? "roll" : "folder"}`}>{isRoll(set) ? <MIcon name="photos" size={size} /> : <Icon name="folder" size={size} />}</span>;
}

export function Progress({ st }: { st: BackupSetStatus }) {
  if (st.state !== "running") return null;
  const pct = st.runTotal ? Math.min(100, (st.runDone / st.runTotal) * 100) : null;
  return (
    <div
      className={`bk-bar ${pct === null ? "busy" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={st.runTotal || undefined}
      aria-valuenow={st.runTotal ? st.runDone : undefined}
    >
      <span style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

export function Toggle({ label, sub, on, set, disabled }: { label: string; sub?: string; on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <li>
      <label className="m-setting-row">
        <span className="m-grow">
          {label}
          {sub && <small className="m-sub">{sub}</small>}
        </span>
        <input type="checkbox" className="m-switch" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} />
      </label>
    </li>
  );
}

/** A row of choices, one picked. */
export function Seg<T extends string>({ label, value, options, set }: { label: string; value: T; options: { id: T; label: string }[]; set: (v: T) => void }) {
  return (
    <div className="m-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} className={value === o.id ? "on" : ""} aria-pressed={value === o.id} onClick={() => set(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Photo access that keeps the camera roll from being backed up in full, and the one thing that
 * fixes it. Nothing when access is complete.
 */
export function PermissionNote({
  perm,
  platform,
  onRequest,
  onManage,
}: {
  perm: BackupPermission | null;
  platform: Platform;
  onRequest: () => void;
  onManage: () => void;
}) {
  if (!perm) return null;
  let text: ReactNode;
  let action: { label: string; run: () => void };
  switch (perm.photos) {
    case "notDetermined":
      text = "Kybl needs access to your photos and videos to back them up.";
      action = { label: "Allow access", run: onRequest };
      break;
    case "denied":
      text = "Kybl isn't allowed to see your photos, so nothing from the camera roll is backed up.";
      action = { label: "Open Settings", run: onManage };
      break;
    case "limited":
      text =
        platform === "ios" ? (
          <>
            Kybl can see only the photos you picked, so only those are backed up. New photos aren't included until you add them, or allow
            full access in Settings › Kybl › Photos.
          </>
        ) : (
          "You let Kybl see only some photos and videos, so only those are backed up."
        );
      action = platform === "ios" ? { label: "Choose more photos", run: onManage } : { label: "Allow all", run: onManage };
      break;
    default:
      return null;
  }
  return (
    <div className={`bk-note ${perm.photos === "limited" ? "" : "warn"}`} role="status">
      <Icon name={perm.photos === "limited" ? "info" : "alert"} size={18} />
      <div className="bk-note-body">
        <p>{text}</p>
        <button className="btn bk-note-btn" onClick={action.run}>
          {action.label}
        </button>
      </div>
    </div>
  );
}

/** A set that stopped because its connection's sign-in ended: the way to sign in again. */
export function SignInNote({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="bk-note warn" role="status">
      <Icon name="alert" size={18} />
      <div className="bk-note-body">
        <p>Kybl is no longer signed in to this connection, so nothing is backed up until you sign in again.</p>
        <button className="btn bk-note-btn" onClick={onSignIn}>
          Sign in again
        </button>
      </div>
    </div>
  );
}

/**
 * The home screen's way in: an offer to set backup up (people can hide it), or how the backup is
 * doing once there is one.
 */
export function BackupCard({ overview, onOpen, onHide }: { overview: BackupOverview | null; onOpen: () => void; onHide?: () => void }) {
  if (!overview || overview.platform === "desktop") return null;
  const sets = overview.sets;
  if (sets.length === 0) {
    if (!onHide) return null;
    return (
      <div className="bk-home">
        <button className="bk-home-main" onClick={onOpen}>
          <span className="bk-ico roll big">
            <MIcon name="photos" size={24} />
          </span>
          <span className="bk-home-text">
            <strong>Back up your photos</strong>
            <small>Copies new photos and videos to your storage. {HONEST}</small>
          </span>
          <Icon name="chevron" size={13} className="m-chev" />
        </button>
        <button className="bk-home-x" onClick={onHide} aria-label="Hide this">
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }
  const running = sets.find((s) => s.state === "running");
  const warn = sets.map(stateLine).find((l) => l.tone === "warn");
  const lastRun = Math.max(0, ...sets.map((s) => s.lastRun ?? 0));
  const backedUp = sets.reduce((a, s) => a + s.backedUp, 0);
  const failed = sets.reduce((a, s) => a + s.failed, 0);
  const allPaused = sets.every((s) => s.state === "paused");
  const line = running
    ? stateLine(running)
    : warn
      ? warn
      : failed > 0
        ? { text: `${n(failed)} couldn't be backed up · ${n(backedUp)} backed up`, tone: "warn" as Tone }
        : allPaused
          ? { text: "Paused", tone: "dim" as Tone }
          : { text: `${n(backedUp)} backed up${lastRun ? ` · checked ${ago(lastRun)}` : ""}`, tone: "ok" as Tone };
  return (
    <div className="bk-home">
      <button className="bk-home-main" onClick={onOpen}>
        <span className={`bk-ico roll big ${line.tone}`}>
          {line.tone === "warn" ? <Icon name="alert" size={22} /> : line.tone === "ok" ? <Icon name="check-circle" size={22} /> : <MIcon name="photos" size={24} />}
        </span>
        <span className="bk-home-text">
          <strong>Photo backup</strong>
          <small className={`bk-tone-${line.tone}`}>{line.text}</small>
          {running && <Progress st={running} />}
        </span>
        <Icon name="chevron" size={13} className="m-chev" />
      </button>
    </div>
  );
}
