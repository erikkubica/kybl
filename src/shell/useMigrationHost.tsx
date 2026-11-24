/**
 * The desktop side of copies between connections (src/jobs): starts the job store, opens the
 * "Copy to another connection…" dialog and the quick F5 / F6 confirm, and when a job ends
 * reloads the panes that show its destination (and, for a move, its source) and says so.
 */
import { inBackground } from "./notifications";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { JobSummary } from "../api";
import { JobConfirm, MigrationDialog, jobFinishedToast, onJobFinished, startMigrations, type MigrationSource } from "../jobs";
import type { Loc as JobLoc, PickedLocation } from "../jobs/LocationPicker";
import type { Dialogs } from "./useDialogs";

/** `relocate`: the browser's own copy/move for folders of the same connection (see MigrationDialog) */
export type Relocate = { roots: string[]; run: (dest: JobLoc, mode: "copy" | "move") => void };
export type OpenMigration = (source: MigrationSource, mode: "copy" | "move", initialDest?: JobLoc | null, relocate?: Relocate) => void;
export type ConfirmMigration = (source: MigrationSource, mode: "copy" | "move", dest: PickedLocation, singleRoot?: boolean, onStarted?: () => void) => void;

export function useMigrationHost({
  dialogs,
  reloadIfShowing,
  clearAllSizes,
  showJobs,
}: {
  dialogs: Dialogs;
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  clearAllSizes: () => void;
  /** opens the Activity panel on its Jobs tab */
  showJobs: () => void;
}) {
  const [migrate, setMigrate] = useState<{ source: MigrationSource; mode: "copy" | "move"; initialDest?: JobLoc | null; relocate?: Relocate; key: number } | null>(null);
  const live = useRef({ dialogs, reloadIfShowing, clearAllSizes, showJobs });
  live.current = { dialogs, reloadIfShowing, clearAllSizes, showJobs };

  useEffect(() => {
    startMigrations(); // once per app: loads the list, follows job-progress
    return onJobFinished((j: JobSummary) => {
      const { dialogs, reloadIfShowing, clearAllSizes, showJobs } = live.current;
      const p = j.progress;
      // what changed is on screen in these places
      if (p.filesDone > 0 || p.state === "done") {
        clearAllSizes();
        reloadIfShowing(j.spec.dst.profileId, j.spec.dst.root);
        if (j.spec.mode === "move") reloadIfShowing(j.spec.src.profileId, j.spec.src.root);
      }
      // the same words as on phones (jobs/finishedToast.ts)
      const t = jobFinishedToast(j);
      if (t) inBackground(() => dialogs.toast(t.kind, t.text, { label: "Show", run: showJobs }));
    });
  }, []);

  const open: OpenMigration = useCallback((source, mode, initialDest, relocate) => setMigrate({ source, mode, initialDest, relocate, key: Date.now() }), []);

  const confirm: ConfirmMigration = useCallback(
    (source, mode, dest, singleRoot, onStarted) =>
      live.current.dialogs.show((close) =>
        createElement(JobConfirm, {
          source,
          mode,
          dest,
          singleRoot,
          onClose: close,
          onStarted: () => {
            onStarted?.();
            live.current.showJobs();
          },
          onMoreOptions: (dir: string) => open(source, mode, { profileId: dest.profileId, root: dest.root, dir }),
        }),
      ),
    [open],
  );

  const element = migrate && (
    <MigrationDialog
      key={migrate.key}
      source={migrate.source}
      initialMode={migrate.mode}
      initialDest={migrate.initialDest}
      relocate={migrate.relocate}
      onClose={() => setMigrate(null)}
      onStarted={() => live.current.showJobs()}
    />
  );

  return { open, confirm, element, isOpen: !!migrate };
}
