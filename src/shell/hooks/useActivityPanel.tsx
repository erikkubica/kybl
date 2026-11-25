import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast } from "../../ui/components/Dialogs";
import { useState, useCallback } from "react";
import { type ActivityTab } from "../../transfers/components/TransferPanel";
import { useTransfers } from "../../transfers/hooks/useTransfers";
import { useJobs } from "../../jobs/hooks/useJobs";
import { getJobs, migrations as migrationStore } from "../../jobs";
import { useDialogs } from "./useDialogs";
import type { Late } from "../lib/late";

export interface UseActivityPanelDeps {
  dialogs: ReturnType<typeof useDialogs>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  late: Late;
}

/** The Activity panel's state (open, its tab, opened on purpose), the transfer queue and jobs, and its Cancel / Clear failed asks. */
export function useActivityPanel(s: UseActivityPanelDeps) {
  const [transfersOpen, setTransfersOpen] = useState(true);
  // the activity panel was opened on purpose: it stays up with a note even with nothing going on
  const [activityAsked, setActivityAsked] = useState(false);
  // the Activity panel's tab: transfers and moves, or copies between connections (Jobs)
  const [activityTab, setActivityTab] = useState<ActivityTab>("activity");
  const onError = useCallback((m: string) => s.toast("error", m), [s.toast]);
  const showActivity = useCallback(() => setTransfersOpen(true), []);
  /** a failure toast's "Show": the Activity panel on its Failed tab */
  const showFailed = useCallback(() => {
    setActivityTab("failed");
    setTransfersOpen(true);
  }, []);
  const showActivityPanel = useCallback(() => {
    setTransfersOpen(true);
    setActivityAsked(true);
  }, []);
  const transfers = useTransfers(onError);
  const jobs = useJobs();
  /**
   * A transfer or job just started: the panel shows In progress (not the Failed, Done, Log or
   * Jobs tab it was left on), and opens if Settings say so.
   */
  const autoShowActivity = useCallback(() => {
    setActivityTab((t) => (t === "activity" ? t : "activity"));
    if (s.late.settingsRef.current.autoOpenTransfers) setTransfersOpen(true);
  }, []);
  /** The Activity tab's "Cancel transfers": one click must not throw a whole batch away, partial downloads included. */
  const cancelAllTransfers = async () => {
    const n = transfers.activeCount();
    if (n > 0) {
      const ok = await s.dialogs.confirm({
        title: n === 1 ? "Cancel this transfer?" : `Cancel ${n.toLocaleString()} transfers?`,
        label: n === 1 ? "Cancel transfer" : "Cancel transfers",
        cancelLabel: n === 1 ? "Keep transfer" : "Keep transfers",
        danger: true,
        message: <p>Partly downloaded files are deleted and what was sent of an upload is let go. Finished ones stay. Pause all keeps the progress, to carry on later.</p>,
      });
      if (!ok) return;
    }
    transfers.cancelAll();
  };
  /** The Failed tab's "Clear failed": asks first when that throws away what a retry would resume from. */
  const clearFailed = async () => {
    const { partial } = transfers.failedCounts();
    const migs = getJobs().filter((j) => j.progress.state === "failed" || j.progress.state === "needsAuth" || (j.progress.state === "done" && j.progress.filesFailed > 0));
    if (partial > 0 || migs.length > 0) {
      const ok = await s.dialogs.confirm({
        title: "Clear failed items?",
        label: "Clear failed",
        message: (
          <>
            {partial > 0 && (
              <p>
                {partial === 1 ? "One upload" : `${partial.toLocaleString()} uploads`} got partway. Kybl lets go of what was sent, so trying again later starts from the beginning.
              </p>
            )}
            {migs.length > 0 && <p>Copies between connections that failed leave Jobs too. Files they already copied stay where they are.</p>}
          </>
        ),
      });
      if (!ok) return;
    }
    transfers.clearFailed();
    jobs.clearFailed();
    for (const j of migs) void migrationStore.remove(j.id).catch(() => {});
  };
  return { transfersOpen, setTransfersOpen, activityAsked, setActivityAsked, activityTab, setActivityTab, showActivity, showFailed, showActivityPanel, transfers, jobs, autoShowActivity, cancelAllTransfers, clearFailed };
}
