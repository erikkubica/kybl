import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast } from "../../ui/components/Dialogs";
import type { Profile } from "../../core/types";
import { TransferPanel } from "../../transfers/components/TransferPanel";
import { stopOrCancel } from "../../actions/lib/customActions";
import { api, errMessage } from "../../core/api";
import { openFromConnection } from "../../desktop/components/openGuard";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Suspense } from "react";
import { LazyEditingChip, LazyEditConflictHost } from "../../edit/lib/lazy";
import { useActivityPanel } from "../hooks/useActivityPanel";
import { useConnections } from "../hooks/useConnections";
import { useDialogs } from "../hooks/useDialogs";
import { usePaneSlots } from "../hooks/usePaneSlots";
import { useShellSettings } from "../hooks/useShellSettings";

export interface ActivityAreaProps {
  activityAsked: ReturnType<typeof useActivityPanel>["activityAsked"];
  activityTab: ReturnType<typeof useActivityPanel>["activityTab"];
  cancelAllTransfers: ReturnType<typeof useActivityPanel>["cancelAllTransfers"];
  clearFailed: ReturnType<typeof useActivityPanel>["clearFailed"];
  conns: ReturnType<typeof useConnections>;
  dialogs: ReturnType<typeof useDialogs>;
  editing: ReturnType<typeof usePaneSlots>["editing"];
  edits: ReturnType<typeof usePaneSlots>["edits"];
  jobs: ReturnType<typeof useActivityPanel>["jobs"];
  openHere: ReturnType<typeof usePaneSlots>["openHere"];
  openSettings: ReturnType<typeof useShellSettings>["openSettings"];
  profiles: Profile[];
  setActivityAsked: ReturnType<typeof useActivityPanel>["setActivityAsked"];
  setActivityTab: ReturnType<typeof useActivityPanel>["setActivityTab"];
  setTransfersOpen: ReturnType<typeof useActivityPanel>["setTransfersOpen"];
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  transfers: ReturnType<typeof useActivityPanel>["transfers"];
  transfersOpen: ReturnType<typeof useActivityPanel>["transfersOpen"];
}

/** The Activity panel at the bottom of the window, with the Edit-in-another-app chip and its conflict prompt. */
export function ActivityArea({ activityAsked, activityTab, cancelAllTransfers, clearFailed, conns, dialogs, editing, edits, jobs, openHere, openSettings, profiles, setActivityAsked, setActivityTab, setTransfersOpen, toast, transfers, transfersOpen }: ActivityAreaProps) {
  return (
    <>
      <TransferPanel
        onCancelJob={(id, kind) => (kind === "action" ? stopOrCancel(id) : void api.cancelTransfer(id).catch(() => {}))}
        onDismissJob={jobs.dismiss}
        onOpenJob={(j) => {
          if (j.dest == null) return;
          const p = profiles.find((x) => x.id === j.profileId);
          if (p && j.bucket != null) openHere((pane) => pane.go(p, j.bucket!, j.dest!));
        }}
        onOpenSync={() => openSettings("sync")}
        open={transfersOpen}
        onToggle={() => {
          if (transfersOpen) setActivityAsked(false);
          setTransfersOpen(!transfersOpen);
        }}
        showEmpty={activityAsked}
        tab={activityTab}
        onTab={setActivityTab}
        onOpenMigrationDest={(j) => {
          const p = profiles.find((x) => x.id === j.spec.dst.profileId);
          if (!p) return toast("error", "That connection no longer exists.");
          conns.expand(p.id);
          openHere((pane) => pane.go(p, j.spec.dst.root, j.spec.dst.dir));
        }}
        onCancel={transfers.cancel}
        onCancelAll={() => void cancelAllTransfers()}
        onRetry={transfers.retry}
        onRetryAll={() => void transfers.retryAll(true)}
        onOpenLocal={(t) => void openFromConnection(t.local, dialogs.confirm, undefined, t.name).catch((e) => toast("error", `Couldn’t open “${t.name}”. ${errMessage(e)}`))}
        onClear={() => {
          transfers.clearFinished();
          jobs.clearFinished();
        }}
        onClearFailed={() => void clearFailed()}
        onReveal={(t) => revealItemInDir(t.local).catch(() => {})}
        extraShown={editing > 0}
        extra={
          editing > 0 && (
            <Suspense fallback={null}>
              <LazyEditingChip connectionName={(pid) => profiles.find((x) => x.id === pid)?.name ?? ""} onStop={(list) => void edits.stop(list)} onReopen={edits.reopen} onReveal={edits.reveal} />
            </Suspense>
          )
        }
      />
      {editing > 0 && (
        <Suspense fallback={null}>
          <LazyEditConflictHost onStop={(s) => void edits.stop([s])} />
        </Suspense>
      )}
    </>
  );
}
