/**
 * Files and folders dragged from a list (useItemDrag): one drag for the whole window, owned by the
 * shell rather than the pane it started in, so it carries on when another workspace comes up.
 *
 * The drag keeps where the items came from (`Origin`: the workspace, the pane slot, the connection
 * and root, and that pane's file actions as they were): nothing at the drop needs the source
 * pane's listing or selection, and a slot that shows something else by then (the same slot of
 * another workspace) is never taken for the source. While the pane it started in still shows that
 * root, its own folders are plain moves, as before; every other pane is "another pane".
 *
 * Over a workspace's tab (not the one on screen): letting go drops the items into the folder of
 * that workspace's active pane (a toast says where, with Show), and resting on it opens it
 * (WorkspaceBar `springLoader`) to drop into its panes and folders. Resting on "+" opens a new
 * workspace at the root the items came from.
 */
import { useMemo, useRef } from "react";
import { useItemDrag, type TabTarget } from "../../browser/hooks/useItemDrag";
import { destLabel, isValidDest } from "../../transfers/lib/moving";
import { makeDragOut } from "../../desktop/lib/dragOut";
import { peekCaps } from "../../core/useCaps";
import type { Pane } from "../../browser/hooks/usePane";
import type { Loc, PaneId } from "../../browser/types";
import type { FileOps } from "../../desktop/components/fileOps";
import type { Entry, Profile } from "../../core/types";
import type { TransferActions } from "../../transfers/hooks/useTransfers";
import { DragGhost } from "../../browser/components/PaneParts";
import { crossesDiskAt, sendItems, viaJobAt, type CrossCtx, type DestPlace, type Place } from "../lib/crossPane";
import { NEW_WS, wsTabAt, type TabDropTarget } from "../components/WorkspaceBar";
import type { Dialogs } from "./useDialogs";

type Origin = { ws: string; pane: PaneId; place: Place; ops: FileOps; localPaths: boolean; search: boolean };

export type FileDragOptions = {
  activeWs: string;
  /** any pane slot */
  slot: (id: PaneId) => Pane;
  profiles: Profile[];
  rootLabel: (profileId: string, root: string) => string;
  cross: () => CrossCtx;
  transfers: TransferActions;
  autoShowActivity: () => void;
  toast: Dialogs["toast"];
  /** a workspace not on screen: its name and the place of its active pane */
  wsDest: (id: string) => { name: string; loc: Loc | null } | null;
  switchWorkspace: (id: string) => void;
  /** a new workspace with one pane at `loc`, on screen */
  newWorkspaceAt: (loc: Loc) => void;
  /**
   * Terminal panes (src/terminal): what dropping the items on pane `pane` does when it is one
   * (undefined: not a terminal; null: it can't take them), and the drop (it types their paths).
   */
  terminal?: { target: (pane: PaneId, from: Place, items: Entry[]) => string | null | undefined; drop: (pane: PaneId, from: Place, items: Entry[]) => void };
};

const what = (items: Entry[]) => (items.length === 1 ? `“${items[0].name}”` : `${items.length.toLocaleString()} items`);

export function useFileDrag(o: FileDragOptions) {
  const opts = useRef(o);
  opts.current = o;
  const origin = useRef<Origin | null>(null);

  const same = (a: Place, b: Place) => a.profileId === b.profileId && a.bucket === b.bucket;
  /** names for the confirm of a copy between connections */
  const named = (p: Place): DestPlace => ({
    ...p,
    connectionName: opts.current.profiles.find((x) => x.id === p.profileId)?.name ?? "",
    rootName: opts.current.rootLabel(p.profileId, p.bucket),
    singleRoot: peekCaps(p.profileId)?.roots === "single",
  });
  /** the pane it started in, while it is on screen and still shows the items' root */
  const home = (): PaneId | null => {
    const g = origin.current;
    if (!g || g.ws !== opts.current.activeWs) return null;
    const here = opts.current.slot(g.pane).here;
    return here && same(here, g.place) ? g.pane : null;
  };
  /**
   * File actions for a copy or move from the origin: the home pane's; else a destination pane's
   * on the same connection (as ⌘V does there); else the origin's as they were when the drag began.
   */
  const opsFor = (g: Origin, dst?: Pane) => {
    const h = home();
    if (h) return opts.current.slot(h).ops;
    return dst?.profile?.id === g.place.profileId ? dst.ops : g.ops;
  };
  const send = (g: Origin, dst: Place, items: Entry[], copy: boolean, dest: string, ops: FileOps, onStarted?: () => void) =>
    void sendItems(ops, g.place, items, copy ? "copy" : "move", named(dst), dest, opts.current.cross(), onStarted);

  /** Where dropping on workspace `id`'s tab puts the items. */
  const tabTarget = (id: string, items: Entry[]): TabTarget => {
    const g = origin.current;
    if (id === NEW_WS) return { open: "Hold to open a new workspace here" };
    const w = opts.current.wsDest(id);
    if (!g || !w) return { why: "Can’t drop here" };
    const at = w.loc;
    if (!at || !opts.current.profiles.some((p) => p.id === at.profileId)) return { why: `“${w.name}” has no folder open` };
    if (same(at, g.place) && !isValidDest(items, at.prefix)) return { why: `Already in “${w.name}”` };
    return { label: `${destLabel(at.prefix, at.bucket, at.profileId)} in “${w.name}”`, copyOnly: crossesDiskAt(g.place, at) };
  };

  const dragOut = useMemo(
    () =>
      makeDragOut(() => {
        const g = origin.current;
        return g ? { ...g.place, localPaths: g.localPaths, transfers: opts.current.transfers, autoShowActivity: opts.current.autoShowActivity } : null;
      }),
    [],
  );

  const { drag, begin: beginDrag } = useItemDrag<PaneId>({
    home,
    onDrop: (items, dest, copy, destBucket, pane, destProfile) => {
      const g = origin.current;
      if (!g) return;
      if (pane && opts.current.terminal?.target(pane, g.place, items)) return opts.current.terminal.drop(pane, g.place, items);
      if (pane) {
        const dst = opts.current.slot(pane);
        if (dst.here) send(g, dst.here, items, copy, dest, opsFor(g, dst));
        return;
      }
      const ops = opsFor(g);
      const to = { profileId: destProfile ?? g.place.profileId, bucket: destBucket ?? g.place.bucket };
      // another connection, or a root of this one the server can't copy into: by the route those take
      if (destBucket != null && (destProfile ? destProfile !== g.place.profileId : viaJobAt(g.place, to))) send(g, to, items, copy, dest, ops);
      else void ops.relocate(items, dest, copy ? "copy" : "move", { srcBucket: g.place.bucket, ...(destBucket != null ? { destBucket } : {}) });
    },
    onSpring: (dest, pane) => {
      const id = pane ?? home();
      if (id) opts.current.slot(id).navigate(dest);
    },
    bucketTarget: (pid, b) => {
      const g = origin.current;
      if (!g || g.search) return null;
      if (pid === g.place.profileId) return b === g.place.bucket ? "same" : "other";
      const to = opts.current.profiles.find((x) => x.id === pid);
      if (!to) return null;
      const root = opts.current.rootLabel(pid, b) || b;
      return { label: b ? `“${root}” on ${to.name}` : to.name, copyOnly: crossesDiskAt({ profileId: g.place.profileId, bucket: "" }, { profileId: pid, bucket: b }) };
    },
    paneTarget: (pane, d, items) => {
      const g = origin.current;
      const say = g ? opts.current.terminal?.target(pane, g.place, items) : undefined;
      if (say !== undefined) return say ? { dest: "", label: "", copyOnly: true, say } : null;
      const dst = opts.current.slot(pane);
      if (!g || !dst.here) return null;
      const dest = d ?? dst.prefix;
      if (same(dst.here, g.place) && !isValidDest(items, dest)) return null;
      return { dest, label: dest && dst.profile ? destLabel(dest, dst.here.bucket, dst.profile.id) : (dst.bucketLabel ?? ""), copyOnly: crossesDiskAt(g.place, dst.here) };
    },
    tabs: {
      at: (x, y) => {
        const id = wsTabAt(x, y) ?? (document.elementFromPoint(x, y)?.closest(".ws-new") ? NEW_WS : null);
        return id === opts.current.activeWs ? null : id;
      },
      target: tabTarget,
      onSpring: (id) => {
        const g = origin.current;
        if (id !== NEW_WS) opts.current.switchWorkspace(id);
        else if (g) opts.current.newWorkspaceAt({ ...g.place, prefix: "" });
      },
      onDrop: (id, items, copy) => {
        const g = origin.current;
        const w = opts.current.wsDest(id);
        const at = w?.loc;
        if (!g || !w || !at) return;
        const asCopy = copy || crossesDiskAt(g.place, at);
        // a move or copy inside a connection is done by now; the others (transfers, a job) have begun
        const done = !viaJobAt(g.place, at) && !crossesDiskAt(g.place, at);
        const verb = asCopy ? (done ? "Copied" : "Copying") : done ? "Moved" : "Moving";
        const folder = destLabel(at.prefix, at.bucket, at.profileId);
        send(g, at, items, asCopy, at.prefix, opsFor(g), () =>
          opts.current.toast(done ? "success" : "info", `${verb} ${what(items)} to ${folder} in “${w.name}”`, { label: "Show", run: () => opts.current.switchWorkspace(id) }),
        );
      },
    },
    dragOut,
  });

  /** The press on items of pane `id`: maybe the start of a drag (a click without one runs `onClick`). */
  const begin = (id: PaneId, ev: React.MouseEvent, items: Entry[], onClick?: () => void) => {
    const p = opts.current.slot(id);
    if (!p.here) return;
    origin.current = { ws: opts.current.activeWs, pane: id, place: { profileId: p.here.profileId, bucket: p.here.bucket }, ops: p.ops, localPaths: !!p.caps?.localPaths, search: !!p.ent.search };
    beginDrag(ev, items, onClick);
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;
  const stableBegin = useMemo(() => (id: PaneId, ev: React.MouseEvent, items: Entry[], onClick?: () => void) => beginRef.current(id, ev, items, onClick), []);

  const g = origin.current;
  return {
    begin: stableBegin,
    /** the workspace tab under the dragged items (WorkspaceBar `drop`) */
    tabDrop: (drag?.tab ?? null) as TabDropTarget | null,
    /** the ghost by the pointer */
    view: drag && !drag.outside && g ? <DragGhost drag={drag} bucket={g.place.bucket} profileId={g.place.profileId} /> : null,
  };
}
