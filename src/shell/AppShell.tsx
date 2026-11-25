/**
 * The desktop app around the browser panes: the sidebar of connections and favorites, the
 * Activity panel, Settings, connection dialogs and the update banner. It owns the panes (one, or
 * several in a layout of splits) and routes the sidebar, the keyboard and the menu bar to the
 * active one.
 *
 * This file only wires the parts together: each part is a hook in ./hooks (state and what it
 * does) or a component in ./components (what it draws), taking what it needs from the parts
 * above it. What a part calls that is made by a part further down goes through `late`
 * (lib/late.ts), filled at the end of every render.
 */
import { ShellSidebar } from "./components/ShellSidebar";
import { ActivityArea } from "./components/ActivityArea";
import { ShellDialogs } from "./components/ShellDialogs";
import { usePaneViews } from "./hooks/usePaneViews";
import { useShellSettings } from "./hooks/useShellSettings";
import { useShellLayout } from "./hooks/useShellLayout";
import { useConnDialogs } from "./hooks/useConnDialogs";
import { useActivityPanel } from "./hooks/useActivityPanel";
import { usePanesHost } from "./hooks/usePanesHost";
import { useFullEditor } from "./hooks/useFullEditor";
import { usePaneSlots } from "./hooks/usePaneSlots";
import { usePaneSplits } from "./hooks/usePaneSplits";
import { usePaneMoves } from "./hooks/usePaneMoves";
import { useWorkspacesHost } from "./hooks/useWorkspacesHost";
import { useFileDragHost } from "./hooks/useFileDragHost";
import { useTerminalHost } from "./hooks/useTerminalHost";
import { useSidebarMenus } from "./hooks/useSidebarMenus";
import { useSidePeek } from "./hooks/useSidePeek";
import { useCommandsHost } from "./hooks/useCommandsHost";
import { usePaletteHost } from "./hooks/usePaletteHost";
import { useFinderDropHost } from "./hooks/useFinderDropHost";
import { useMounts } from "../mount/useMounts";
import { onTrustSaved } from "../connections/components/ConnFix";
import { useEffect, useMemo, useRef, useState } from "react";
import { UpdateBanner } from "../updates/UpdateBanner";
import { useSyncOverall } from "../sync/sync";
import { useUpdates } from "../updates/updates";
import { THIS_MAC } from "../browser/types";
import { useAuthNeeded } from "../connections/lib/authNeeded";
import { useDialogs } from "./hooks/useDialogs";
import { useTunnelCommands } from "../tunnels/tunnelMenu";
import { useConnections } from "./hooks/useConnections";
import { SplitLayout } from "./components/SplitLayout";
import { equalize, setSizes } from "./lib/paneLayout";
import { PaneSwitcherView, WorkspaceBar } from "./components/WorkspaceBar";
import { paneCount } from "./lib/workspaces";
import type { Late } from "./lib/late";
import { PaneContext } from "./components/PaneContext";
import { useConnPicks } from "../connections/hooks/useConnPicks";
import { useOpenGroups, useRecentConnections } from "../connections/lib/groups";

export function AppShell() {
  const dialogs = useDialogs();
  const { toast } = dialogs;
  // what the shell's parts call that is made further down (filled at the end of each render)
  const late = useRef({} as Late).current;
  const conns = useConnections();
  // trusted from a destination picker (copy to another connection, mirror): the sidebar's copy follows
  const { upsertProfile } = conns;
  useEffect(() => onTrustSaved(upsertProfile), [upsertProfile]);
  // sign-in connections whose access ended: "Sign in again" in the sidebar
  const authNeeded = useAuthNeeded();
  // drives ("Mount as drive"): the sidebar marks mounted places, the menus offer Eject
  const { mounts } = useMounts();
  // the saved connections, then this computer's own folders
  const saved = conns.profiles;
  const profiles = useMemo(() => [...saved, THIS_MAC], [saved]);
  // ⌘K: Start / Stop tunnel “name” for SFTP connections' SSH tunnels
  useTunnelCommands(saved, toast);
  const updates = useUpdates();
  const syncState = useSyncOverall();
  const { settings, sysDark, dark, settingsOpen, setSettingsOpen, settingsPage, openSettings, updateSettings, sideHidden, toggleSidebar } = useShellSettings();
  const sidePeek = useSidePeek(sideHidden, () => dialogs.isOpen());
  // the sidebar's groups folded open, and the connections opened last (both kept per device)
  const openGroups = useOpenGroups();
  const recents = useRecentConnections();
  const picks = useConnPicks(conns.profiles);
  // ⌥⌘F: the sidebar's filter field takes the keyboard (each press bumps this)
  const [findSignal, setFindSignal] = useState(0);
  const { rec, ws, setWs, wsNow, startSaved, tree, setTree, ids, dual, term, fileIds, links, setLinks, canLink, facing, liveLinks, isLinked, toggleSync, unlink, recent, setRecent, setActiveId, activeId, fileId } = useShellLayout({ settings });
  const { connDialog, kyblDialog, setKyblDialog, importOpen, setImportOpen, setConnDialog } = useConnDialogs();
  const { transfersOpen, setTransfersOpen, activityAsked, setActivityAsked, activityTab, setActivityTab, showActivity, showFailed, showActivityPanel, transfers, jobs, autoShowActivity, cancelAllTransfers, clearFailed } = useActivityPanel({ dialogs, toast, late });
  const { panesRef, allPanes, dualCtx, dualPane, reloadIfShowing, clearAllSizes, showJobs, migrations, settingsRef, foldersChanged } = usePanesHost({ dialogs, setActivityAsked, setActivityTab, setTransfersOpen, settings, updateSettings, late });
  const { doc, setDoc, docRef, editor, canOpenDocument, openDocument, closeEditor, beginItemDrag } = useFullEditor({ late });
  const { editing, edits, slots, slot, active, otherOf, other, activeRef, paneById, showFilePane, openHere, connectIn, openShell, toggleConnection, forgetProfile, opened, lastBefore } = usePaneSlots({ activeId, allPanes, autoShowActivity, beginItemDrag, canOpenDocument, clearAllSizes, conns, dialogs, dual, dualCtx, dualPane, fileId, fileIds, foldersChanged, ids, jobs, liveLinks, migrations, openDocument, openSettings, panesRef, profiles, rec, recent, recents, reloadIfShowing, setActiveId, setConnDialog, setDoc, setLinks, setWs, settings, showActivity, showActivityPanel, showFailed, sideHidden, sidePeek, startSaved, term, toast, transfers, tree, updateSettings, wsNow, late });
  const { treeRef, focusSoon, paneRoom, splitRefusal, split, splitItems, vacate, okToEndShells, busyShells, confirmEndShells, sidsOf, wsSids, paneLater, close, closeOthers, closeNow, closeOthersNow, focusToward, panesItems, panesMenu } = usePaneSplits({ activeId, dialogs, dual, ids, opened, otherOf, profiles, rec, recent, setActiveId, setRecent, setTree, showJobs, sideHidden, slot, term, toast, toggleSidebar, tree, unlink, ws, late });
  const { keptListings, pendingScroll, wsEditing, setWsEditing, wsSettings, setWsSettings, cramped, crampedRef, lastTop, live, layoutOf, DEFAULT_VIEW, switchWorkspace, addWorkspace, newWorkspace, duplicateWorkspace, patchWorkspace, renameWorkspace, replaceWorkspace, moveWorkspace, closeWorkspace, stepWorkspace, jumpWorkspace, moveActiveWorkspace, openWsSettings, workspaceMenu, applyLayout, fillSlot, histories, listScroller, setCramped, snapOf } = useWorkspacesHost({ active, activeId, busyShells, closeNow, confirmEndShells, connectIn, conns, dialogs, dualPane, focusSoon, ids, late, links, opened, paneRoom, profiles, rec, recent, setActiveId, setLinks, setRecent, setTree, setWs, sideHidden, slot, term, toast, toggleSidebar, tree, treeRef, vacate, ws, wsNow, wsSids });
  const { keepScrolls, onCramped, moveItems, dragAway, takeFromLive, wsShow, paneDrag } = usePaneMoves({ applyLayout, closeNow, cramped, crampedRef, dualPane, fillSlot, focusSoon, histories, ids, lastTop, listScroller, paneRoom, pendingScroll, setActiveId, setCramped, setTree, setWs, slot, snapOf, switchWorkspace, toast, treeRef, vacate, ws, late });
  const { wsDest, fileDrag } = useFileDragHost({ DEFAULT_VIEW, addWorkspace, autoShowActivity, beginItemDrag, conns, dualCtx, profiles, slot, switchWorkspace, term, toast, transfers, ws });
  useTerminalHost({ duplicateWorkspace, activeId, addWorkspace, clearAllSizes, closeNow, closeOthers, closeOthersNow, connectIn, conns, dialogs, fileId, focusSoon, ids, layoutOf, moveItems, newWorkspace, okToEndShells, paneLater, patchWorkspace, profiles, rec, recents, reloadIfShowing, replaceWorkspace, setActiveId, setConnDialog, setTree, showFailed, sidsOf, slot, split, splitItems, takeFromLive, term, toast, transfers, treeRef, ws });
  const { askBucketName, askNewBucket, openFavorite, emptyFor, openConnection, findConnection, moveToGroup, togglePin, groupItems, groupMenu, sectionMenu, railSection, driveMenu, connectionMenu, railPick, switchMenu, bucketMenu } = useSidebarMenus({ lastBefore, settings, active, authNeeded, connectIn, conns, dialogs, fileId, focusSoon, migrations, mounts, openGroups, openHere, openSettings, openShell, paneById, picks, profiles, rec, recents, saved, setActiveId, setConnDialog, setFindSignal, setKyblDialog, showFilePane, sideHidden, sidePeek, term, toast, toggleConnection });
  const { undo, overlayUp, route } = useCommandsHost({ active, allPanes, close, closeEditor, closeOthers, closeWorkspace, connDialog, dialogs, docRef, dual, dualPane, findConnection, focusToward, importOpen, jumpWorkspace, kyblDialog, moveActiveWorkspace, newWorkspace, openSettings, openWsSettings, panesRef, setConnDialog, setSettingsOpen, setWsEditing, settingsOpen, split, stepWorkspace, term, toast, toggleSidebar, ws });
  const { palette } = usePaletteHost({ active, activeId, closeOthers, connectIn, conns, facing, ids, isLinked, openConnection, openFavorite, openHere, openSettings, openShell, overlayUp, panesRef, profiles, recents, route, setImportOpen, setSettingsOpen, setTree, settings, settingsOpen, showActivityPanel, slot, split, splitRefusal, switchWorkspace, toast, toggleSync, tree, undo, updateSettings, ws, late });
  const { dropOver, dropRefused, finderTab } = useFinderDropHost({ activeRef, conns, overlayUp, paneById, profiles, switchWorkspace, term, toast, ws, wsDest, wsShow });
  const { paneView, nameOf, paneSwitcher } = usePaneViews({ activeId, conns, cramped, dialogs, dragAway, dropOver, dropRefused, dual, dualPane, emptyFor, facing, focusSoon, ids, isLinked, keepScrolls, otherOf, paneDrag, panesItems, panesMenu, setActiveId, settings, showJobs, slot, switchMenu, term, toggleSync, tree, updateSettings });
  const wsOpen = wsSettings ? ws.list.find((w) => w.id === wsSettings.id) : null;
  // what the parts above call through `late` (never while rendering)
  Object.assign(late, { crampedRef, keepScrolls, keptListings, lastTop, layoutOf, moveItems, nameOf, paneById, pendingScroll, settingsRef, split, splitItems });
  return (
    <div className={`app ${sideHidden ? "side-hidden" : ""}`}>
      <ShellSidebar
        active={active}
        activeRef={activeRef}
        askBucketName={askBucketName}
        askNewBucket={askNewBucket}
        authNeeded={authNeeded}
        bucketMenu={bucketMenu}
        connectionMenu={connectionMenu}
        conns={conns}
        dialogs={dialogs}
        driveMenu={driveMenu}
        findConnection={findConnection}
        findSignal={findSignal}
        focusSoon={focusSoon}
        groupItems={groupItems}
        groupMenu={groupMenu}
        mounts={mounts}
        moveToGroup={moveToGroup}
        openConnection={openConnection}
        openFavorite={openFavorite}
        openGroups={openGroups}
        openHere={openHere}
        openSettings={openSettings}
        openShell={openShell}
        picks={picks}
        profiles={profiles}
        railPick={railPick}
        railSection={railSection}
        recents={recents}
        saved={saved}
        sectionMenu={sectionMenu}
        setConnDialog={setConnDialog}
        settings={settings}
        sideHidden={sideHidden}
        sidePeek={sidePeek}
        syncState={syncState}
        term={term}
        toggleConnection={toggleConnection}
        togglePin={togglePin}
        toggleSidebar={toggleSidebar}
      />

      <main className="main">
        <WorkspaceBar
          tabs={ws.list.map((w) => ({ id: w.id, name: w.name, color: w.color, panes: paneCount(w.id === ws.active ? live : w) }))}
          activeId={ws.active}
          editingId={wsEditing}
          settingsId={wsSettings?.id ?? null}
          onPick={switchWorkspace}
          onNew={rec.newMenu}
          onEdit={setWsEditing}
          onEditEnd={(id, name) => {
            setWsEditing(null);
            if (name != null) renameWorkspace(id, name);
            if (id === ws.active) focusSoon(activeId);
          }}
          onMenu={workspaceMenu}
          onSettings={(id, anchor) => setWsSettings((cur) => (cur?.id === id ? null : { id, anchor }))}
          onReorder={moveWorkspace}
          onFind={palette.toggle}
          dark={dark}
          onTheme={() => {
            // back to the OS's own look means following the OS again
            const want = dark ? "light" : "dark";
            updateSettings({ theme: want === (sysDark ? "dark" : "light") ? "system" : want });
          }}
          drop={paneDrag.tabDrop ?? fileDrag.tabDrop ?? finderTab}
        />
        {/* the window can't show every pane: a row to pick the one on screen */}
        {paneSwitcher && (
          <div className="pane-row">
            <PaneSwitcherView {...paneSwitcher} />
          </div>
        )}
        {paneDrag.view}
        {fileDrag.view}
        <PaneContext.Provider value={{ panes: panesRef.current, active, other, dual, setActive: setActiveId }}>
          {dual ? (
            <div className="content dual-wrap">
              <SplitLayout
                tree={tree}
                activeId={activeId}
                pane={paneView}
                onSizes={(path, sizes) => setTree((t) => setSizes(t, path, sizes))}
                onEqualize={(path) => setTree((t) => equalize(t, path))}
                nameOf={nameOf}
                onCramped={onCramped}
                linked={isLinked}
                onToggleLink={toggleSync}
                canLink={canLink}
              />
            </div>
          ) : (
            paneView(ids[0])
          )}
        </PaneContext.Provider>

      <ActivityArea
        activityAsked={activityAsked}
        activityTab={activityTab}
        cancelAllTransfers={cancelAllTransfers}
        clearFailed={clearFailed}
        conns={conns}
        dialogs={dialogs}
        editing={editing}
        edits={edits}
        jobs={jobs}
        openHere={openHere}
        openSettings={openSettings}
        profiles={profiles}
        setActivityAsked={setActivityAsked}
        setActivityTab={setActivityTab}
        setTransfersOpen={setTransfersOpen}
        toast={toast}
        transfers={transfers}
        transfersOpen={transfersOpen}
      />
      </main>

      <ShellDialogs
        dialogs={dialogs}
        groupItems={groupItems}
        active={active}
        closeWorkspace={closeWorkspace}
        connDialog={connDialog}
        connectIn={connectIn}
        conns={conns}
        doc={doc}
        duplicateWorkspace={duplicateWorkspace}
        editor={editor}
        forgetProfile={forgetProfile}
        importOpen={importOpen}
        kyblDialog={kyblDialog}
        openHere={openHere}
        openShell={openShell}
        paneById={paneById}
        patchWorkspace={patchWorkspace}
        rec={rec}
        reloadIfShowing={reloadIfShowing}
        renameWorkspace={renameWorkspace}
        saved={saved}
        setConnDialog={setConnDialog}
        setDoc={setDoc}
        setImportOpen={setImportOpen}
        setKyblDialog={setKyblDialog}
        setSettingsOpen={setSettingsOpen}
        setWsSettings={setWsSettings}
        settings={settings}
        settingsOpen={settingsOpen}
        settingsPage={settingsPage}
        slots={slots}
        toast={toast}
        updateSettings={updateSettings}
        ws={ws}
        wsOpen={wsOpen}
        wsSettings={wsSettings}
      />
      {migrations.element}
      {palette.element}
      {!settingsOpen && <UpdateBanner st={updates} />}
    </div>
  );
}

