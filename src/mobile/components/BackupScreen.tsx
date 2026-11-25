/**
 * Phone backup: the camera roll and chosen folders, copied to any connection. Lists the backups
 * with how each is doing, opens one for its details, and walks through setting a new one up.
 * The phone does the work (Android's WorkManager, iOS background tasks); this screen only shows
 * and steers it.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { backupApi, errMessage, errSummary, type BackupPermission, type BackupSetStatus } from "../../core/api";
import { Icon } from "../../ui/components/Icons";
import type { Toast } from "../../ui/components/Dialogs";
import { MIcon } from "./icons";
import type { BackupState } from "../backup/useBackup";
import { countsLine, HONEST, isRoll, PermissionNote, Progress, SetIcon, setName, stateLine } from "../backup/parts";
import { SetDetail } from "../backup/SetDetail";
import { SetupFlow } from "../backup/SetupFlow";
import "../backup/backup.css";

export { BackupCard } from "../backup/parts";
export { useBackup, type BackupState } from "../backup/useBackup";

/** Back inside the screen (a set, a setup step) before the screen itself closes. */
export type BackupHandle = { back: () => boolean };

type Page = { kind: "list" } | { kind: "set"; id: string } | { kind: "setup" };

export function BackupScreen({
  backup,
  onBack,
  toast,
  handle,
  startSetup = false,
  onSignIn,
}: {
  backup: BackupState;
  onBack: () => void;
  toast: (kind: Toast["kind"], text: string) => void;
  handle: MutableRefObject<BackupHandle | null>;
  /** open straight into setting one up (the home card, when there is no backup yet) */
  startSetup?: boolean;
  /** a set needs its connection signed in again: opens that sign-in */
  onSignIn?: (profileId: string) => void;
}) {
  const { overview, error, refresh, put, remove } = backup;
  const [page, setPage] = useState<Page>(startSetup ? { kind: "setup" } : { kind: "list" });
  const [perm, setPerm] = useState<BackupPermission | null>(null);
  const [setupTitle, setSetupTitle] = useState("New backup");
  const setupBack = useRef<(() => boolean) | null>(null);
  const platform = overview?.platform ?? "ios";
  const sets = overview?.sets ?? [];

  const loadPerm = useCallback(() => {
    backupApi
      .permission()
      .then(setPerm)
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadPerm();
    // back from the system settings or the photo picker: access may have changed
    const onShow = () => document.visibilityState === "visible" && loadPerm();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [loadPerm]);

  handle.current = {
    back: () => {
      if (page.kind === "setup" && setupBack.current?.()) return true;
      if (page.kind !== "list" && !(page.kind === "setup" && startSetup && sets.length === 0)) {
        setPage({ kind: "list" });
        return true;
      }
      return false;
    },
  };

  const request = async () => {
    try {
      setPerm(await backupApi.requestPermission());
    } catch (e) {
      toast("error", errSummary(errMessage(e)));
    }
  };
  const manage = async () => {
    try {
      await backupApi.manageAccess();
    } catch (e) {
      toast("error", errSummary(errMessage(e)));
    }
    loadPerm();
    // newly allowed photos are found by the next run
    void refresh();
  };

  const current = page.kind === "set" ? sets.find((s) => s.set.id === page.id) : undefined;
  // a set removed elsewhere (or just now): back to the list
  useEffect(() => {
    if (page.kind === "set" && overview && !current) setPage({ kind: "list" });
  }, [page, overview, current]);

  const title = page.kind === "setup" ? setupTitle : current ? setName(current.set) : "Photo backup";
  const hasRoll = sets.some((s) => isRoll(s.set));
  const anyRunning = sets.some((s) => s.state === "running");

  return (
    <section className="m-screen m-overlay bk-screen" aria-label={title}>
      <header className="m-bar solid">
        <button className="m-icon" onClick={onBack} aria-label="Back">
          <Icon name="arrow-left" size={22} />
        </button>
        <div className="m-title">
          <h1>{title}</h1>
        </div>
      </header>

      {page.kind === "setup" ? (
        <SetupFlow
          platform={platform}
          perm={perm}
          onPerm={setPerm}
          onManage={() => void manage()}
          toast={toast}
          stepBack={setupBack}
          setTitle={setSetupTitle}
          onDone={(st) => {
            put(st);
            setPage({ kind: "set", id: st.set.id });
          }}
        />
      ) : current ? (
        <SetDetail
          key={current.set.id}
          st={current}
          platform={platform}
          perm={perm}
          onRequest={() => void request()}
          onManage={() => void manage()}
          put={put}
          onRemoved={(id) => {
            remove(id);
            setPage({ kind: "list" });
          }}
          toast={toast}
          onSignIn={onSignIn}
        />
      ) : (
        <div className="m-scroll bk-body">
          {!overview && !error && (
            <div className="m-empty">
              <span className="spinner" />
            </div>
          )}
          {error && !overview && (
            <div className="m-empty">
              <div className="m-empty-art warn">
                <Icon name="alert" size={40} />
              </div>
              <h3>Couldn't load your backups</h3>
              <p>{errSummary(error)}</p>
              <button className="btn m-big-btn" onClick={() => void refresh()}>
                <Icon name="retry" size={16} /> Try again
              </button>
            </div>
          )}
          {overview && sets.length === 0 && (
            <div className="m-empty bk-intro">
              <div className="m-empty-art bk-intro-art">
                <MIcon name="photos" size={44} />
              </div>
              <h3>Back up your photos</h3>
              <p>Kybl copies the photos and videos on this phone, or a folder you choose, to a bucket or drive of yours. Each one is sent once; only new ones go after that.</p>
              <p className="bk-honest">{HONEST}</p>
              <button className="btn btn-primary m-big-btn" onClick={() => setPage({ kind: "setup" })}>
                <Icon name="plus" size={16} /> Set up backup
              </button>
            </div>
          )}
          {sets.length > 0 && (
            <>
              {hasRoll && <PermissionNote perm={perm} platform={platform} onRequest={() => void request()} onManage={() => void manage()} />}
              <ul className="bk-list">
                {sets.map((st) => (
                  <SetCard key={st.set.id} st={st} onOpen={() => setPage({ kind: "set", id: st.set.id })} toast={toast} put={put} onSignIn={onSignIn} />
                ))}
              </ul>
              <ul className="m-group bk-gap">
                <li>
                  <button className="m-setting-row accent" disabled={anyRunning} onClick={() => backupApi.runNow().catch((e) => toast("error", errSummary(errMessage(e))))}>
                    <Icon name="upload" size={16} />
                    <span className="m-grow">Back up everything now</span>
                  </button>
                </li>
                <li>
                  <button className="m-setting-row accent" onClick={() => setPage({ kind: "setup" })}>
                    <Icon name="plus" size={16} />
                    <span className="m-grow">Add another backup</span>
                  </button>
                </li>
              </ul>
              <p className="m-foot">{HONEST}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SetCard({
  st,
  onOpen,
  toast,
  put,
  onSignIn,
}: {
  st: BackupSetStatus;
  onOpen: () => void;
  toast: (kind: Toast["kind"], text: string) => void;
  put: (s: BackupSetStatus) => void;
  onSignIn?: (profileId: string) => void;
}) {
  const line = stateLine(st);
  const running = st.state === "running";
  const paused = st.state === "paused";
  const fail = (e: unknown) => toast("error", errSummary(errMessage(e)));
  return (
    <li className="bk-card">
      <button className="bk-card-main" onClick={onOpen}>
        <SetIcon set={st.set} />
        <span className="bk-card-text">
          <strong>{setName(st.set)}</strong>
          <small className="bk-dest-label">{st.set.destLabel}</small>
          <small className={`bk-tone-${line.tone}`}>{line.text}</small>
          {running && st.current ? <small className="bk-current">{st.current.name}</small> : <small>{countsLine(st)}</small>}
        </span>
        <Icon name="chevron" size={13} className="m-chev" />
      </button>
      <Progress st={st} />
      <div className="bk-card-acts">
        {st.state === "needsAuth" && onSignIn && (
          <button className="bk-mini" onClick={() => onSignIn(st.set.profileId)}>
            <Icon name="refresh" size={15} /> Sign in again
          </button>
        )}
        {running ? (
          <button className="bk-mini" onClick={() => backupApi.cancel(st.set.id).catch(fail)}>
            <Icon name="x" size={15} /> Stop
          </button>
        ) : (
          <button className="bk-mini" disabled={paused} onClick={() => backupApi.runNow(st.set.id).catch(fail)}>
            <Icon name="upload" size={15} /> Back up now
          </button>
        )}
        <button className="bk-mini" onClick={() => backupApi.setPaused(st.set.id, !paused).then(put).catch(fail)}>
          <Icon name={paused ? "play" : "pause"} size={15} /> {paused ? "Resume" : "Pause"}
        </button>
      </div>
    </li>
  );
}
