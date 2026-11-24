import { useEffect, useState } from "react";
import { useTransfersActive } from "../useTransfers";
import { openLink } from "../openLink";
import { Icon } from "../Icons";
import { formatBytes } from "../format";
import { errMessage } from "../api";
import { actionLabel, installAndRestart, UpdateStepError, updatesApi, type UpdateStatus } from "../updates";

/** Versions the user put off with "Later": not shown again until the next launch. */
const later = new Set<string>();

/** The "new version" card: offer, progress, then restart. Hidden when there is nothing to say. */
export function UpdateBanner({ st, mobile }: { st: UpdateStatus | null; mobile?: boolean }) {
  const [, rerender] = useState(0);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // once the transfers end, the next click is a plain restart again (it asks anew if still busy)
  const transfersActive = useTransfersActive();
  useEffect(() => {
    if (!transfersActive) setBusy(false);
  }, [transfersActive]);
  const rel = st?.available;
  if (!st || !rel) return null;
  const working = st.phase === "downloading" || st.phase === "installing";
  // a prompt the user asked for (or one already under way) always shows; otherwise only once
  if (!started && !working && st.phase !== "ready" && (later.has(rel.version) || st.skipped === rel.version)) return null;

  const hide = () => {
    later.add(rel.version);
    setStarted(false);
    rerender((n) => n + 1);
  };
  const go = () => {
    setStarted(true);
    setBusy(false);
    setRestartError(null);
    setInstallError(null);
    if (rel.how !== "install") {
      // the download page opens in the browser: hidden once it did, else the reason shows here
      updatesApi.install().then(hide, (e) => setInstallError(errMessage(e)));
      return;
    }
    installAndRestart(() => setBusy(true)).catch((e) =>
      e instanceof UpdateStepError && e.step === "install" ? setInstallError(e.message) : setRestartError(e instanceof Error ? e.message : String(e)),
    );
  };
  const pct = st.total > 0 ? Math.min(100, (st.received / st.total) * 100) : 0;
  // a refused restart drops the phase back (the installer went missing): its reason shows here too
  const failText = working || st.phase === "ready" ? null : (restartError ?? installError ?? (started && st.phase === "" ? st.error : null));
  const failed = !!failText;

  return (
    <div className={`update-card ${mobile ? "m" : ""}`} role="status" aria-live="polite">
      <div className="update-icon">
        <Icon name={failed ? "alert" : st.phase === "ready" ? "check-circle" : "download"} size={16} />
      </div>
      <div className="update-body">
        {st.phase === "downloading" ? (
          <>
            <b>Downloading Kybl {rel.version}…</b>
            <div className="update-bar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </div>
            <small>{st.total > 0 ? `${formatBytes(st.received)} of ${formatBytes(st.total)}` : formatBytes(st.received)}</small>
          </>
        ) : st.phase === "installing" ? (
          <>
            <b>Installing Kybl {rel.version}…</b>
            <div className="update-bar busy" aria-hidden>
              <i />
            </div>
          </>
        ) : st.phase === "ready" ? (
          <>
            <b>Kybl {rel.version} is installed</b>
            <small className={restartError ? "update-err" : undefined}>
              {restartError ?? (busy ? "Transfers are still running. Restart when they finish, or now to stop them." : "Restart to start using it.")}
            </small>
            <div className="update-actions">
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setRestartError(null);
                  setStarted(true);
                  // forced only once the user was told transfers are running
                  updatesApi.restart(busy).catch((e) => (String(e) === "busy" ? setBusy(true) : setRestartError(String(e))));
                }}
              >
                {busy ? "Restart and stop transfers" : "Restart now"}
              </button>
            </div>
          </>
        ) : failed ? (
          <>
            <b>{restartError ? "Kybl couldn't restart" : rel.how !== "install" ? "Couldn't open the download" : "The update didn't install"}</b>
            <small className="update-err" role="alert">
              {failText}
            </small>
            <div className="update-actions">
              <button className="btn btn-sm btn-primary" onClick={go}>
                Try again
              </button>
              <button className="btn btn-sm" onClick={() => openLink(rel.page).catch(() => {})}>
                Release page
              </button>
              <button className="btn btn-sm btn-ghost" onClick={hide}>
                Later
              </button>
            </div>
          </>
        ) : (
          <>
            <b>Kybl {rel.version} is available</b>
            <small>
              You have {st.current}.{" "}
              <button className="update-link" onClick={() => openLink(rel.page).catch(() => {})}>
                What's new
              </button>
            </small>
            <div className="update-actions">
              <button className="btn btn-sm btn-primary" onClick={go}>
                {actionLabel(rel)}
              </button>
              <button className="btn btn-sm" onClick={hide}>
                Later
              </button>
              <button
                className="btn btn-sm btn-ghost"
                title="Don't remind me about this version"
                onClick={() => {
                  updatesApi.settings({ skip: rel.version }).catch(() => {});
                  hide();
                }}
              >
                Skip
              </button>
            </div>
          </>
        )}
      </div>
      {!working && st.phase !== "ready" && (
        <button className="update-close" aria-label="Close" onClick={hide}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}
