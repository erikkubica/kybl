import { useDialogs } from "../hooks/useDialogs";
import type { Workspace } from "../lib/workspaces";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast, MenuItem } from "../../ui/components/Dialogs";
import type { Profile } from "../../core/types";
import { SettingsPage } from "../../settings/SettingsPage";
import { KyblConnectDialog } from "../../connections/components/KyblConnectDialog";
import { forgetCaps } from "../../core/useCaps";
import { ConnectionDialog } from "../../connections/components/ConnectionDialog";
import { KYBL } from "../../connections/lib/kybl";
import { allGroups } from "../../connections/lib/groups";
import { clearAuthNeeded } from "../../connections/lib/authNeeded";
import { flushSync } from "react-dom";
import { isShellConn } from "../../connections/lib/kinds";
import { ImportDialog } from "../../connections/components/ImportDialog";
import { Suspense } from "react";
import { LazyDocumentView } from "../../viewers/lib/registry";
import { focusPaneList } from "../lib/focus";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { usePaneSlots } from "../hooks/usePaneSlots";
import { useWorkspacesHost } from "../hooks/useWorkspacesHost";
import { useConnDialogs } from "../hooks/useConnDialogs";
import { useConnections } from "../hooks/useConnections";
import { useFullEditor } from "../hooks/useFullEditor";
import { useShellLayout } from "../hooks/useShellLayout";
import { usePanesHost } from "../hooks/usePanesHost";
import { useShellSettings } from "../hooks/useShellSettings";

export interface ShellDialogsProps {
  dialogs: ReturnType<typeof useDialogs>;
  /** "Move to group" items for these connections (the sidebar's) */
  groupItems: (ps: Profile[]) => MenuItem[];
  active: ReturnType<typeof usePaneSlots>["active"];
  closeWorkspace: ReturnType<typeof useWorkspacesHost>["closeWorkspace"];
  connDialog: ReturnType<typeof useConnDialogs>["connDialog"];
  connectIn: ReturnType<typeof usePaneSlots>["connectIn"];
  conns: ReturnType<typeof useConnections>;
  doc: ReturnType<typeof useFullEditor>["doc"];
  duplicateWorkspace: ReturnType<typeof useWorkspacesHost>["duplicateWorkspace"];
  editor: ReturnType<typeof useFullEditor>["editor"];
  forgetProfile: ReturnType<typeof usePaneSlots>["forgetProfile"];
  importOpen: ReturnType<typeof useConnDialogs>["importOpen"];
  kyblDialog: ReturnType<typeof useConnDialogs>["kyblDialog"];
  openHere: ReturnType<typeof usePaneSlots>["openHere"];
  openShell: ReturnType<typeof usePaneSlots>["openShell"];
  paneById: ReturnType<typeof usePaneSlots>["paneById"];
  patchWorkspace: ReturnType<typeof useWorkspacesHost>["patchWorkspace"];
  rec: ReturnType<typeof useShellLayout>["rec"];
  reloadIfShowing: ReturnType<typeof usePanesHost>["reloadIfShowing"];
  renameWorkspace: ReturnType<typeof useWorkspacesHost>["renameWorkspace"];
  saved: Profile[];
  setConnDialog: ReturnType<typeof useConnDialogs>["setConnDialog"];
  setDoc: ReturnType<typeof useFullEditor>["setDoc"];
  setImportOpen: ReturnType<typeof useConnDialogs>["setImportOpen"];
  setKyblDialog: ReturnType<typeof useConnDialogs>["setKyblDialog"];
  setSettingsOpen: ReturnType<typeof useShellSettings>["setSettingsOpen"];
  setWsSettings: ReturnType<typeof useWorkspacesHost>["setWsSettings"];
  settings: ReturnType<typeof useShellSettings>["settings"];
  settingsOpen: ReturnType<typeof useShellSettings>["settingsOpen"];
  settingsPage: ReturnType<typeof useShellSettings>["settingsPage"];
  slots: ReturnType<typeof usePaneSlots>["slots"];
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  updateSettings: ReturnType<typeof useShellSettings>["updateSettings"];
  ws: ReturnType<typeof useShellLayout>["ws"];
  wsOpen: Workspace | null | undefined;
  wsSettings: ReturnType<typeof useWorkspacesHost>["wsSettings"];
}

/** What comes up over the window: Settings, the connection dialogs, Import, the full-window editor and a workspace's settings. */
export function ShellDialogs({ active, closeWorkspace, connDialog, connectIn, conns, dialogs, doc, duplicateWorkspace, editor, forgetProfile, groupItems, importOpen, kyblDialog, openHere, openShell, paneById, patchWorkspace, rec, reloadIfShowing, renameWorkspace, saved, setConnDialog, setDoc, setImportOpen, setKyblDialog, setSettingsOpen, setWsSettings, settings, settingsOpen, settingsPage, slots, toast, updateSettings, ws, wsOpen, wsSettings }: ShellDialogsProps) {
  return (
    <>
      {settingsOpen && (
        <SettingsPage
          settings={settings}
          profiles={saved}
          onChange={updateSettings}
          // Reset all: the panes on screen let go of their own compact choice too
          onResetPanes={() => {
            for (const p of slots) p.setCompact(null);
          }}
          onEditProfile={(p) => setConnDialog({ profile: p })}
          onNewProfile={() => setConnDialog({ profile: null })}
          onImportProfiles={() => setImportOpen(true)}
          onClose={() => setSettingsOpen(false)}
          initialPage={settingsPage.page}
          pageRequest={settingsPage.n}
          activeProfileId={active.profile?.id ?? null}
          onToast={toast}
          onGroupMenu={(ps, x, y) => dialogs.menu(x, y, groupItems(ps))}
        />
      )}
      {kyblDialog && (
        <KyblConnectDialog
          existing={kyblDialog.existing}
          reconnect={kyblDialog.reconnect}
          onClose={() => setKyblDialog(null)}
          onConnected={(p) => {
            forgetCaps(p.id);
            conns.upsertProfile(p);
            openHere((pane) => void connectIn(pane.id, p));
          }}
          onDeleted={forgetProfile}
        />
      )}
      {connDialog && (
        <ConnectionDialog
          initial={connDialog.profile}
          reconnect={connDialog.reconnect}
          startKind={connDialog.startKind}
          startTab={connDialog.startTab}
          onClose={() => setConnDialog(null)}
          onKybl={() => {
            setConnDialog(null);
            setKyblDialog({ existing: null });
          }}
          kyblFirst={!saved.some((p) => p.provider === KYBL)}
          groups={allGroups(saved)}
          onImport={() => {
            setConnDialog(null);
            setImportOpen(true);
          }}
          onSaved={(p) => {
            forgetCaps(p.id);
            clearAuthNeeded(p.id);
            // rendered at once: an SSH connection opens as its terminal, which looks the new
            // profile up in the list
            flushSync(() => conns.upsertProfile(p));
            // an edit only saves: panes already on it show it as changed, nothing else opens
            // (a new connection, or one signed in again, opens where you are)
            if (connDialog.profile && !connDialog.reconnect) {
              for (const s of slots) if (s.profile?.id === p.id && s.bucket != null) reloadIfShowing(p.id, s.bucket);
              return;
            }
            if (isShellConn(p)) openShell(p);
            else openHere((pane) => void connectIn(pane.id, p));
          }}
          onDeleted={forgetProfile}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(list) => {
            for (const p of list) conns.upsertProfile(p);
          }}
          toast={toast}
        />
      )}
      {doc && (
          <Suspense fallback={null}>
            <LazyDocumentView
              ref={editor}
              profileId={doc.profileId}
              bucket={doc.bucket}
              entry={doc.entry}
              mode="full"
              onClose={() => {
                setDoc(null);
                requestAnimationFrame(() => focusPaneList(doc.pane));
              }}
              onSaved={() => {
                // size, date and ETag changed (or a copy appeared); the editor's header says
                // "Saved" / "Saved as …" itself, so no toast on top
                reloadIfShowing(doc.profileId, doc.bucket);
              }}
              onOpenExternal={(e) => void paneById(doc.pane).ops.openInApp(e)}
            />
          </Suspense>
      )}
      {wsSettings && wsOpen && (
        <WorkspaceSettings
          key={wsOpen.id}
          name={wsOpen.name}
          color={wsOpen.color}
          recipe={rec.view(wsOpen.id)}
          canClose={ws.list.length > 1}
          anchor={wsSettings.anchor}
          onRename={(n) => renameWorkspace(wsOpen.id, n)}
          onColor={(color) => patchWorkspace(wsOpen.id, { color })}
          onSaveRecipe={() => rec.save(wsOpen.id)}
          onResetRecipe={() => {
            setWsSettings(null);
            void rec.reset(wsOpen.id);
          }}
          onDeleteRecipe={() => {
            const r = rec.recipeOf(wsOpen);
            if (r) rec.remove(r.id);
          }}
          onOpenOnLaunch={(on) => patchWorkspace(wsOpen.id, { start: on ? "saved" : "restore" })}
          onStartup={(pane, text) => {
            const r = rec.recipeOf(wsOpen);
            if (r) rec.setLines(r.id, pane, text);
          }}
          onDuplicate={() => duplicateWorkspace(wsOpen.id)}
          onClose={() => {
            setWsSettings(null);
            void closeWorkspace(wsOpen.id);
          }}
          onDismiss={() => setWsSettings(null)}
        />
      )}
    </>
  );
}
