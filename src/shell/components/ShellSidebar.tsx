import type { Profile } from "../../core/types";
import { SidebarRail, Sidebar } from "../../sidebar/Sidebar";
import { THIS_MAC, LOCAL_PROFILE } from "../../browser/types";
import { canTerminal } from "../../terminal/api";
import { closestLocalRoot } from "../../connections/lib/roots";
import { isShellConn } from "../../connections/lib/kinds";
import { usePaneSlots } from "../hooks/usePaneSlots";
import { useSidebarMenus } from "../hooks/useSidebarMenus";
import { useAuthNeeded } from "../../connections/lib/authNeeded";
import { useConnections } from "../hooks/useConnections";
import { useDialogs } from "../hooks/useDialogs";
import { usePaneSplits } from "../hooks/usePaneSplits";
import { useMounts } from "../../mount/useMounts";
import { useOpenGroups, useRecentConnections } from "../../connections/lib/groups";
import { useShellSettings } from "../hooks/useShellSettings";
import { useConnPicks } from "../../connections/hooks/useConnPicks";
import { useConnDialogs } from "../hooks/useConnDialogs";
import { useSidePeek } from "../hooks/useSidePeek";
import { useSyncOverall } from "../../sync/sync";
import { useShellLayout } from "../hooks/useShellLayout";

export interface ShellSidebarProps {
  active: ReturnType<typeof usePaneSlots>["active"];
  activeRef: ReturnType<typeof usePaneSlots>["activeRef"];
  askBucketName: ReturnType<typeof useSidebarMenus>["askBucketName"];
  askNewBucket: ReturnType<typeof useSidebarMenus>["askNewBucket"];
  authNeeded: ReturnType<typeof useAuthNeeded>;
  bucketMenu: ReturnType<typeof useSidebarMenus>["bucketMenu"];
  connectionMenu: ReturnType<typeof useSidebarMenus>["connectionMenu"];
  conns: ReturnType<typeof useConnections>;
  dialogs: ReturnType<typeof useDialogs>;
  driveMenu: ReturnType<typeof useSidebarMenus>["driveMenu"];
  findConnection: ReturnType<typeof useSidebarMenus>["findConnection"];
  findSignal: number;
  focusSoon: ReturnType<typeof usePaneSplits>["focusSoon"];
  groupItems: ReturnType<typeof useSidebarMenus>["groupItems"];
  groupMenu: ReturnType<typeof useSidebarMenus>["groupMenu"];
  mounts: ReturnType<typeof useMounts>["mounts"];
  moveToGroup: ReturnType<typeof useSidebarMenus>["moveToGroup"];
  openConnection: ReturnType<typeof useSidebarMenus>["openConnection"];
  openFavorite: ReturnType<typeof useSidebarMenus>["openFavorite"];
  openGroups: ReturnType<typeof useOpenGroups>;
  openHere: ReturnType<typeof usePaneSlots>["openHere"];
  openSettings: ReturnType<typeof useShellSettings>["openSettings"];
  openShell: ReturnType<typeof usePaneSlots>["openShell"];
  picks: ReturnType<typeof useConnPicks>;
  profiles: Profile[];
  railPick: ReturnType<typeof useSidebarMenus>["railPick"];
  railSection: ReturnType<typeof useSidebarMenus>["railSection"];
  recents: ReturnType<typeof useRecentConnections>;
  saved: Profile[];
  sectionMenu: ReturnType<typeof useSidebarMenus>["sectionMenu"];
  setConnDialog: ReturnType<typeof useConnDialogs>["setConnDialog"];
  settings: ReturnType<typeof useShellSettings>["settings"];
  sideHidden: ReturnType<typeof useShellSettings>["sideHidden"];
  sidePeek: ReturnType<typeof useSidePeek>;
  syncState: ReturnType<typeof useSyncOverall>;
  term: ReturnType<typeof useShellLayout>["term"];
  toggleConnection: ReturnType<typeof usePaneSlots>["toggleConnection"];
  togglePin: ReturnType<typeof useSidebarMenus>["togglePin"];
  toggleSidebar: ReturnType<typeof useShellSettings>["toggleSidebar"];
}

/** The sidebar: the full one, or folded to the rail with the full one coming in over the panes on hover. */
export function ShellSidebar({ active, activeRef, askBucketName, askNewBucket, authNeeded, bucketMenu, connectionMenu, conns, dialogs, driveMenu, findConnection, findSignal, focusSoon, groupItems, groupMenu, mounts, moveToGroup, openConnection, openFavorite, openGroups, openHere, openSettings, openShell, picks, profiles, railPick, railSection, recents, saved, sectionMenu, setConnDialog, settings, sideHidden, sidePeek, syncState, term, toggleConnection, togglePin, toggleSidebar }: ShellSidebarProps) {
  return (
    <>
      {sideHidden && (
        <SidebarRail
          profiles={profiles}
          activeId={active.profile?.id ?? null}
          favorites={settings.favorites}
          syncState={syncState}
          authNeeded={authNeeded}
          builtIn={(p) => p.id === THIS_MAC.id}
          onExpand={toggleSidebar}
          onPick={(p, x, y) => void railPick(p, x, y)}
          onOpenFavorite={openFavorite}
          onNewProfile={() => setConnDialog({ profile: null })}
          onTerminal={canTerminal({ id: LOCAL_PROFILE, kind: "local" }) ? () => void term.openLocal(undefined, { reuse: true }) : undefined}
          onOpenSync={() => openSettings("sync")}
          onOpenSettings={() => openSettings()}
          onConnectionMenu={connectionMenu}
          onHover={sidePeek.hover}
          recent={recents.recent}
          onMore={findConnection}
          onSection={railSection}
        />
      )}
      {(!sideHidden || sidePeek.open) && (
        <div
          className={sideHidden ? "side-peek" : "side-full"}
          ref={sidePeek.ref}
          onMouseLeave={sideHidden ? sidePeek.leave : undefined}
          // opening a place from the overlay puts it away: on the way back up, once the row's own
          // click has opened it (closing on the way down unmounted the row before that)
          onClick={sideHidden ? sidePeek.clicked : undefined}
        >
          <Sidebar
            profiles={profiles}
            activeId={active.profile?.id ?? null}
            expanded={conns.expanded}
            bucketsBy={conns.bucketsBy}
            // on this computer, the sidebar folder holding the place (Home › Documents lights up Documents)
            bucket={active.profile && active.bucket != null ? closestLocalRoot(active.profile.id, active.bucket, active.prefix) : active.bucket}
            onToggleProfile={toggleConnection}
            onEditProfile={(p) => setConnDialog({ profile: p })}
            onNewProfile={() => setConnDialog({ profile: null })}
            onOpenSettings={() => openSettings()}
            syncState={syncState}
            onTerminal={canTerminal({ id: LOCAL_PROFILE, kind: "local" }) ? () => void term.openLocal(undefined, { reuse: true }) : undefined}
          onOpenSync={() => openSettings("sync")}
            onSelectBucket={(p, b) => (isShellConn(p) ? openShell(p) : openHere((pane) => pane.openBucket(p, b)))}
            onOpenBucketByName={(p) => askBucketName(p)}
            onNewBucket={(p) => askNewBucket(p)}
            hiddenBuckets={conns.hiddenBuckets}
            onHideBucket={conns.setBucketHidden}
            onReconnect={(p) => setConnDialog({ profile: p, reconnect: true })}
            authNeeded={authNeeded}
            onSignInAgain={(p) => setConnDialog({ profile: p, reconnect: true })}
            favorites={settings.favorites}
            onOpenFavorite={openFavorite}
            onRemoveFavorite={active.actions.removeFavorite}
            rootLabel={conns.rootLabel}
            builtIn={(p) => p.id === THIS_MAC.id}
            onConnectionMenu={connectionMenu}
            onBucketMenu={bucketMenu}
            mounts={mounts}
            onDriveMenu={driveMenu}
            onHide={toggleSidebar}
            peek={sideHidden}
            recent={recents.recent}
            openGroups={openGroups.open}
            onToggleGroup={openGroups.toggle}
            onGroupMenu={groupMenu}
            onSectionMenu={sectionMenu}
            onOpenConnection={openConnection}
            paneEmpty={!active.profile}
            picked={picks.picked}
            onTogglePick={(p) => picks.toggle(p.id)}
            onClearPicks={picks.clear}
            onMoveToGroup={(ids, g) => moveToGroup(saved.filter((x) => ids.includes(x.id)), g)}
            onMoveMenu={(ids, x, y) => dialogs.menu(x, y, groupItems(saved.filter((q) => ids.includes(q.id))))}
            onTogglePin={(ids) => void togglePin(ids)}
            findSignal={findSignal}
            findOnMount={sideHidden && sidePeek.byFind}
            onFindDone={() => {
              if (sideHidden) sidePeek.close();
              focusSoon(activeRef.current.id);
            }}
          />
        </div>
      )}
    </>
  );
}
