import type { ToastAction } from "../../desktop/components/fileOps";
import type { WorkspaceStore } from "../lib/workspaces";
import type { Toast } from "../../ui/components/Dialogs";
import type { Profile } from "../../core/types";
import type { Pane } from "../../browser/hooks/usePane";
import { useRef, type RefObject } from "react";
import { type PaneId, THIS_MAC, type Loc } from "../../browser/types";
import { useFinderDrop } from "./useFinderDrop";
import { REMOTE_TERM_DROP, useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";
import { wsTabAt } from "../components/WorkspaceBar";
import { baseName } from "../../core/format";
import { useConnections } from "./useConnections";

export interface UseFinderDropHostDeps {
  activeRef: RefObject<Pane>;
  conns: ReturnType<typeof useConnections>;
  overlayUp: () => boolean;
  paneById: (id: PaneId) => Pane;
  profiles: Profile[];
  switchWorkspace: (id: string) => void;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  ws: WorkspaceStore;
  wsDest: (id: string) => { name: string; loc: Loc | null; } | null;
  wsShow: RefObject<(_id: string) => void>;
}

/** Drag & drop from Finder: onto a pane (upload), a terminal (its paths typed in) or a workspace tab. */
export function useFinderDropHost(s: UseFinderDropHostDeps) {
  const dropOnArchive = useRef(false);
  /** why a drop on a terminal can't go there (one on a server: these are paths of this computer) */
  const dropOnTermWhy = useRef<string | null>(null);
  /** the server terminal under the pointer (it shows that it takes no files) */
  const dropOnTerm = useRef<PaneId | null>(null);
  const { over: dropOver, refused: dropRefused, tab: finderTab } = useFinderDrop({
    target: (x, y) => {
      dropOnTermWhy.current = null;
      dropOnTerm.current = null;
      dropOnArchive.current = false;
      // a dialog owns the screen: nothing lands behind it
      if (s.overlayUp()) return null;
      // the pane under the pointer, terminals included; without one (sidebar, no position) the active file pane
      const under = (x != null && y != null ? document.elementFromPoint(x, y)?.closest("[data-pane]")?.getAttribute("data-pane") : null) as PaneId | null;
      // a terminal takes the paths typed in (never an upload), and only one running here
      const t = under ? s.term.terms[under] : undefined;
      if (under && t) {
        if (t.profileId === THIS_MAC.id) return under;
        dropOnTermWhy.current = REMOTE_TERM_DROP;
        dropOnTerm.current = under;
        return null;
      }
      const p = under ? s.paneById(under) : s.activeRef.current;
      // (an archive opens read-only: it takes nothing)
      dropOnArchive.current = !!p.profile && p.archive.inArchive;
      return p.profile && p.bucket != null && !p.archive.inArchive ? p.id : null;
    },
    refusedPane: () => dropOnTerm.current,
    onDrop: (id, paths) => {
      const why = s.term.dropPaths(id, paths);
      if (why === undefined) void s.paneById(id).ops.uploadPaths(paths);
      else if (why) s.toast("info", why);
    },
    // dropped where nothing takes them: behind a dialog, on a pane with no folder open, on a terminal, in an archive
    onRefused: () =>
      s.toast(
        "info",
        s.overlayUp()
          ? "Finish what’s open first, then drop the files again."
          : dropOnTermWhy.current
            ? dropOnTermWhy.current
            : dropOnArchive.current
            ? "Archives open read-only. Drop the files on a folder to upload them."
            : "Drop the files on a pane with a folder open to upload them there.",
      ),
    // over a workspace's tab: resting there opens it; letting go uploads into its active pane's folder
    tabs: {
      at: (x, y) => {
        const id = s.overlayUp() ? null : wsTabAt(x, y);
        return id === s.ws.active ? null : id;
      },
      accepts: (id) => {
        const at = s.wsDest(id)?.loc;
        return !!at && s.profiles.some((p) => p.id === at.profileId);
      },
      onSpring: s.switchWorkspace,
      onDrop: (id, paths) => {
        const w = s.wsDest(id);
        const at = w?.loc;
        if (!w || !at) return;
        void s.activeRef.current.ops.uploadPaths(paths, at.prefix, at).then((ok) => {
          if (ok) s.toast("info", `Uploading to ${at.prefix ? baseName(at.prefix) : s.conns.rootLabel(at.profileId, at.bucket)} in “${w.name}”`, { label: "Show", run: () => s.wsShow.current(id) });
        });
      },
    },
  });
  return { dropOver, dropRefused, finderTab };
}
