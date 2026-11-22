/**
 * The phone's backup sets and how each is doing, kept current from `backup-status`. One copy for
 * the app: the home screen card and the backup screen share it.
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BACKUP_STATUS_EVENT, backupApi, errMessage, type BackupOverview, type BackupSetStatus } from "../../api";

export type BackupState = {
  overview: BackupOverview | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** a status a command returned, shown before its event arrives */
  put: (s: BackupSetStatus) => void;
  remove: (id: string) => void;
};

function merge(o: BackupOverview, s: BackupSetStatus): BackupOverview {
  const i = o.sets.findIndex((x) => x.set.id === s.set.id);
  const sets = i < 0 ? [...o.sets, s] : o.sets.map((x, j) => (j === i ? s : x));
  return { ...o, sets };
}

export function useBackup(enabled: boolean): BackupState {
  const [overview, setOverview] = useState<BackupOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await backupApi.overview());
      setError(null);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const un = listen<BackupSetStatus>(BACKUP_STATUS_EVENT, (e) => setOverview((o) => (o ? merge(o, e.payload) : o)));
    // the worker ran while Kybl was in the background: counts moved without events here
    const onShow = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      void un.then((f) => f());
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [enabled, refresh]);

  const put = useCallback((s: BackupSetStatus) => setOverview((o) => (o ? merge(o, s) : o)), []);
  const remove = useCallback((id: string) => setOverview((o) => (o ? { ...o, sets: o.sets.filter((x) => x.set.id !== id) } : o)), []);
  return { overview, error, refresh, put, remove };
}
