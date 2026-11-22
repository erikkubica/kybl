/** One backup: how it is doing, back up now or pause, what failed, its options, removing it. */
import { useEffect, useState } from "react";
import { backupApi, errMessage, errSummary, type BackupFailure, type BackupPermission, type BackupSet, type BackupSetStatus } from "../../api";
import { Icon } from "../../Icons";
import type { Toast } from "../../components/Dialogs";
import { countsLine, HONEST, isRoll, PermissionNote, Progress, Seg, SetIcon, setName, stateLine, Toggle, type Platform } from "./parts";
import { example, templatesFor } from "./SetupFlow";

export function SetDetail({
  st,
  platform,
  perm,
  onRequest,
  onManage,
  put,
  onRemoved,
  toast,
}: {
  st: BackupSetStatus;
  platform: Platform;
  perm: BackupPermission | null;
  onRequest: () => void;
  onManage: () => void;
  put: (s: BackupSetStatus) => void;
  onRemoved: (id: string) => void;
  toast: (kind: Toast["kind"], text: string) => void;
}) {
  const s = st.set;
  const roll = isRoll(s);
  const ios = platform === "ios";
  const line = stateLine(st);
  const [failures, setFailures] = useState<BackupFailure[] | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fail = (what: string) => (e: unknown) => toast("error", `${what} ${errSummary(errMessage(e))}`);

  useEffect(() => {
    if (!st.failed) {
      setFailures([]);
      return;
    }
    let live = true;
    backupApi
      .failures(s.id)
      .then((f) => live && setFailures(f))
      .catch(() => live && setFailures([]));
    return () => {
      live = false;
    };
  }, [s.id, st.failed]);

  const change = (patch: Partial<BackupSet>) => {
    put({ ...st, set: { ...s, ...patch } });
    backupApi
      .save({ ...s, ...patch })
      .then(put)
      .catch((e) => {
        put(st);
        fail("Couldn't change that.")(e);
      });
  };
  const running = st.state === "running";
  const paused = st.state === "paused";

  const retry = async () => {
    setRetrying(true);
    try {
      const n = await backupApi.retry(s.id);
      toast("success", n === 1 ? "Trying 1 item again" : `Trying ${n} items again`);
    } catch (e) {
      fail("Couldn't try again.")(e);
    } finally {
      setRetrying(false);
    }
  };
  const remove = async () => {
    try {
      await backupApi.delete(s.id);
      onRemoved(s.id);
      toast("success", "Backup removed. Files already backed up stay where they are.");
    } catch (e) {
      fail("Couldn't remove the backup.")(e);
    }
  };

  return (
    <div className="m-scroll bk-body">
      <div className="bk-hero">
        <SetIcon set={s} size={26} />
        <div className="bk-hero-text">
          <strong className={`bk-tone-${line.tone}`}>{line.text}</strong>
          <small>{countsLine(st)}</small>
          {running && st.current && <small className="bk-current">{st.current.name}</small>}
        </div>
      </div>
      <Progress st={st} />
      <div className="bk-actions">
        {running ? (
          <button className="btn bk-act" onClick={() => backupApi.cancel(s.id).catch(fail("Couldn't stop."))}>
            <Icon name="x" size={16} /> Stop
          </button>
        ) : (
          <button className="btn btn-primary bk-act" disabled={paused} onClick={() => backupApi.runNow(s.id).catch(fail("Couldn't start the backup."))}>
            <Icon name="upload" size={16} /> Back up now
          </button>
        )}
        <button
          className="btn bk-act"
          onClick={() =>
            backupApi
              .setPaused(s.id, !paused)
              .then(put)
              .catch(fail(paused ? "Couldn't resume." : "Couldn't pause."))
          }
        >
          <Icon name={paused ? "play" : "pause"} size={16} /> {paused ? "Resume" : "Pause"}
        </button>
      </div>

      {roll && <PermissionNote perm={perm} platform={platform} onRequest={onRequest} onManage={onManage} />}

      {st.failed > 0 && (
        <>
          <h2 className="m-section">Couldn't back up</h2>
          <ul className="m-group">
            {(failures ?? []).slice(0, 50).map((f) => (
              <li key={f.sourceId} className="bk-fail">
                <Icon name="alert" size={16} />
                <span className="m-grow">
                  {f.name}
                  <small className="m-sub">{errSummary(f.error)}</small>
                </span>
              </li>
            ))}
            {failures && failures.length > 50 && <li className="bk-fail more">and {failures.length - 50} more</li>}
            <li>
              <button className="m-setting-row accent" disabled={retrying || running} onClick={() => void retry()}>
                <Icon name="retry" size={16} />
                <span className="m-grow">{retrying ? "Trying again…" : "Try again"}</span>
              </button>
            </li>
          </ul>
        </>
      )}

      <h2 className="m-section">Goes to</h2>
      <ul className="m-group">
        <li className="bk-static">
          <Icon name="cloud" size={16} />
          <span className="m-grow">
            {s.destLabel}
            <small className="m-sub">To back up somewhere else, add another backup.</small>
          </span>
        </li>
      </ul>

      <h2 className="m-section">When</h2>
      <ul className="m-group">
        <Toggle label="Wi-Fi only" sub="Waits for Wi-Fi instead of using mobile data" on={s.wifiOnly} set={(v) => change({ wifiOnly: v })} />
        <Toggle label="Only while charging" sub="Backups in the background wait for the charger" on={s.chargingOnly} set={(v) => change({ chargingOnly: v })} />
      </ul>

      {roll && (
        <>
          <h2 className="m-section">What to back up</h2>
          <ul className="m-group">
            <Toggle label="Videos" on={s.includeVideos} set={(v) => change({ includeVideos: v })} />
            {ios && <Toggle label="Live Photo videos" on={s.livePhotoVideo} set={(v) => change({ livePhotoVideo: v })} />}
            {ios && <Toggle label="Save HEIC photos as JPEG" on={s.heic === "convertJpeg"} set={(v) => change({ heic: v ? "convertJpeg" : "keep" })} />}
          </ul>
          {ios && <h2 className="m-section">Edited photos</h2>}
          {ios && (
            <div className="m-group m-pad">
              <Seg
                label="Edited photos"
                value={s.edited}
                set={(v) => change({ edited: v })}
                options={[
                  { id: "current", label: "As edited" },
                  { id: "original", label: "Original" },
                  { id: "both", label: "Both" },
                ]}
              />
            </div>
          )}
        </>
      )}

      <h2 className="m-section">Folders</h2>
      <ul className="m-group" role="radiogroup" aria-label="Folders">
        {templatesFor(roll, s.template).map((t) => (
          <li key={t.id}>
            <button className="m-setting-row" role="radio" aria-checked={s.template === t.id} onClick={() => s.template !== t.id && change({ template: t.id })}>
              <span className="m-grow">
                {t.label}
                <small className="m-sub bk-path">{example(t.id, s.destPrefix, roll)}</small>
              </span>
              <span className={`bk-radio ${s.template === t.id ? "on" : ""}`} aria-hidden="true">
                {s.template === t.id && <Icon name="check" size={14} />}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="m-hint bk-hint">
        {s.since ? `Only items added after ${new Date(s.since).toLocaleDateString()} are backed up. ` : ""}A new naming applies to items backed up from now on.
      </p>

      <ul className="m-group bk-danger">
        {confirmRemove ? (
          <li className="bk-confirm">
            <p>Stop backing up {setName(s).toLowerCase() === "camera roll" ? "the camera roll" : `“${setName(s)}”`}? Files already backed up stay where they are.</p>
            <div className="bk-actions">
              <button className="btn bk-act" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
              <button className="btn btn-danger bk-act" onClick={() => void remove()}>
                Remove
              </button>
            </div>
          </li>
        ) : (
          <li>
            <button className="m-setting-row bk-remove" onClick={() => setConfirmRemove(true)}>
              <Icon name="trash" size={16} />
              <span className="m-grow">Remove this backup</span>
            </button>
          </li>
        )}
      </ul>
      <p className="m-foot">{HONEST}</p>
    </div>
  );
}
