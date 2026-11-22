/**
 * The phone side of copies between connections (src/jobs): starts the job store, keeps which
 * "Copy to another connection…" screen is open, and when a job ends refreshes the folders it
 * changed and says so, with a way to the Transfers screen where the job is listed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { jobFinishedToast, onJobFinished, startMigrations, type MigrationSource } from "../jobs";
import type { Toast } from "../components/Dialogs";
import type { ToastAction } from "./useFileOps";

export type MigrateRequest = { source: MigrationSource; mode: "copy" | "move"; key: number };

export function useMigrate({
  toast,
  changed,
  openTransfers,
}: {
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  /** something in this bucket changed: refresh it if it is on screen */
  changed: (profileId: string, bucket: string) => void;
  openTransfers: () => void;
}) {
  const [migrate, setMigrate] = useState<MigrateRequest | null>(null);
  const live = useRef({ toast, changed, openTransfers });
  live.current = { toast, changed, openTransfers };

  useEffect(() => {
    startMigrations(); // once per app: loads the list, follows job-progress and app-resumed
    return onJobFinished((j) => {
      const { toast, changed, openTransfers } = live.current;
      const p = j.progress;
      if (p.filesDone > 0 || p.state === "done") {
        changed(j.spec.dst.profileId, j.spec.dst.root);
        if (j.spec.mode === "move") changed(j.spec.src.profileId, j.spec.src.root);
      }
      // the same words as on computers (jobs/finishedToast.ts)
      const t = jobFinishedToast(j);
      if (t) toast(t.kind, t.text, { label: "Show", run: openTransfers });
    });
  }, []);

  const open = useCallback((source: MigrationSource, mode: "copy" | "move" = "copy") => setMigrate({ source, mode, key: Date.now() }), []);
  const close = useCallback(() => setMigrate(null), []);
  /** the job started: it runs in the background, listed under Transfers */
  const started = useCallback(
    (mode: "copy" | "move") => live.current.toast("success", mode === "move" ? "Moving in the background" : "Copying in the background", { label: "Show", run: live.current.openTransfers }),
    [],
  );
  return { migrate, open, close, started };
}
