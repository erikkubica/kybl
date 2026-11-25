import type { Settings } from "../../settings/settings";
import type { ActivityTab } from "../../transfers/components/TransferPanel";
import { useRef, useMemo, useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { type Pane } from "../../browser/hooks/usePane";
import { type DualContext, makeDualActions } from "../components/dualActions";
import { registerCommands } from "../../palette/lib/commands";
import { listMirrors, quickRun } from "../../mirror";
import { useMigrationHost } from "./useMigrationHost";
import { baseName } from "../../core/format";
import { useDialogs } from "./useDialogs";
import type { Late } from "../lib/late";

export interface UsePanesHostDeps {
  dialogs: ReturnType<typeof useDialogs>;
  setActivityAsked: Dispatch<SetStateAction<boolean>>;
  setActivityTab: Dispatch<SetStateAction<ActivityTab>>;
  setTransfersOpen: Dispatch<SetStateAction<boolean>>;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  late: Late;
}

/** The panes on screen as one list, what works across two of them, reloading what a finished transfer touched, and the migration (copy between connections) dialog. */
export function usePanesHost(s: UsePanesHostDeps) {
  /** the panes on screen (work that finishes reloads these) */
  const panesRef = useRef<Pane[]>([]);
  const allPanes = useRef<Pane[]>([]);
  const dualCtx = useRef<DualContext | null>(null);
  const dualPane = useMemo(() => makeDualActions(() => dualCtx.current!), []);
  /**
   * After a job in `pid`/`b` finishes, reloads every pane still showing that bucket. Work in
   * another connection or bucket carries on undisturbed in the meantime.
   */
  const reloadIfShowing = useCallback((pid: string, b: string) => {
    // a workspace not on screen that kept this place's listing would bring back the old rows
    for (const [k, l] of s.late.keptListings.current) if (l.loc?.profileId === pid && l.loc.bucket === b) s.late.keptListings.current.delete(k);
    let hit = false;
    for (const p of panesRef.current) {
      if (p.profile?.id !== pid || p.bucket !== b) continue;
      p.ent.refresh();
      hit = true;
    }
    return hit;
  }, []);
  const clearAllSizes = useCallback(() => {
    for (const p of allPanes.current) p.folderSizes.clear();
  }, []);
  /** Opens the Activity panel on its Jobs tab (a copy between connections started or ended). */
  const showJobs = useCallback(() => {
    s.setActivityTab("jobs");
    s.setTransfersOpen(true);
    s.setActivityAsked(true);
  }, []);
  // ⌘K: each saved mirror runs from the palette (its dry run first, as from a folder's ⋯ menu)
  const dialogsRef = useRef(s.dialogs);
  dialogsRef.current = s.dialogs;
  useEffect(
    () =>
      registerCommands("mirrors", () =>
        listMirrors().map((m) => ({
          id: `mirror:${m.id}`,
          title: `Run mirror “${m.name}”`,
          group: "Mirror",
          keywords: `deploy sync ${m.src.connectionName} ${m.dst.connectionName}`,
          icon: "play" as const,
          run: () => quickRun(m, dialogsRef.current, showJobs),
        })),
      ),
    [showJobs],
  );
  // copies between connections: their dialog, the quick F5 / F6 confirm, and what happens when one ends
  const migrations = useMigrationHost({ dialogs: s.dialogs, reloadIfShowing, clearAllSizes, showJobs });

  const settingsRef = useRef(s.settings);
  settingsRef.current = s.settings;
  /** Favorites follow a folder that was renamed or moved, and go when it is deleted. */
  const foldersChanged = useCallback(
    (pid: string, fromBucket: string, toBucket: string, moves: { from: string; to: string | null }[]) => {
      const favs = settingsRef.current.favorites;
      let changed = false;
      const next = favs.flatMap((f) => {
        if (f.profileId !== pid || f.bucket !== fromBucket) return [f];
        const m = moves.find((x) => f.prefix.startsWith(x.from));
        if (!m) return [f];
        changed = true;
        if (m.to === null) return [];
        const prefix = m.to + f.prefix.slice(m.from.length);
        // a favorite still called by the folder's own name takes the new name
        const name = f.prefix === m.from && f.name === baseName(m.from) ? baseName(m.to) : f.name;
        return [{ ...f, bucket: toBucket, prefix, name }];
      });
      if (changed) s.updateSettings({ favorites: next });
    },
    [s.updateSettings],
  );
  return { panesRef, allPanes, dualCtx, dualPane, reloadIfShowing, clearAllSizes, showJobs, migrations, settingsRef, foldersChanged };
}
