/**
 * The desktop side of copies between connections (src/jobs): starts the job store, opens the
 * "Copy to another connection…" dialog and the quick F5 / F6 confirm, and when a job ends
 * reloads the panes that show its destination (and, for a move, its source) and says so.
 */
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { errSummary, type JobSummary } from "../api";
import { JobConfirm, MigrationDialog, onJobFinished, startMigrations, type MigrationSource } from "../jobs";
import type { Loc as JobLoc, PickedLocation } from "../jobs/LocationPicker";
import type { Dialogs } from "./useDialogs";

export type OpenMigration = (source: MigrationSource, mode: "copy" | "move", initialDest?: JobLoc | null) => void;
export type ConfirmMigration = (source: MigrationSource, mode: "copy" | "move", dest: PickedLocation, singleRoot?: boolean) => void;

/** "Everything in media-prod to Backups" reads as "everything in…" after "Copied". */
const lowerLead = (t: string) => (/^(Everything|All) /.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

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
  const [migrate, setMigrate] = useState<{ source: MigrationSource; mode: "copy" | "move"; initialDest?: JobLoc | null; key: number } | null>(null);
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
      const show = { label: "Show", run: showJobs };
      const verbed = j.spec.mode === "move" ? "moved" : "copied";
      if (p.state === "done" && p.filesFailed > 0)
        dialogs.toast("error", `${j.title}: ${p.filesFailed.toLocaleString()} ${p.filesFailed === 1 ? "file" : "files"} couldn't be ${verbed}`, show);
      else if (p.state === "done") dialogs.toast("success", `${j.spec.mode === "move" ? "Moved" : "Copied"} ${lowerLead(j.title)}`, show);
      else if (p.state === "failed") dialogs.toast("error", `${j.title} stopped: ${errSummary(p.error ?? "something went wrong")}`, show);
      // cancelled: the user did that themselves, nothing to say
    });
  }, []);

  const open: OpenMigration = useCallback((source, mode, initialDest) => setMigrate({ source, mode, initialDest, key: Date.now() }), []);

  const confirm: ConfirmMigration = useCallback(
    (source, mode, dest, singleRoot) =>
      live.current.dialogs.show((close) =>
        createElement(JobConfirm, {
          source,
          mode,
          dest,
          singleRoot,
          onClose: close,
          onStarted: () => live.current.showJobs(),
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
      onClose={() => setMigrate(null)}
      onStarted={() => live.current.showJobs()}
    />
  );

  return { open, confirm, element, isOpen: !!migrate };
}
