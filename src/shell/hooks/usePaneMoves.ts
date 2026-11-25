import type { usePanesHost } from "./usePanesHost";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { HistorySnap } from "../../browser/hooks/useHistory";
import type { Pane } from "../../browser/hooks/usePane";
import { type PaneNode, minSize, shapeOf, moveToward, closePane, leaves, freeSlot, MAX_PANES, splitPane, type DropZone, moveToEdge, dockEdge, movePane } from "../lib/paneLayout";
import { sameLoc, type Listing } from "../../browser/hooks/useListing";
import { type PaneId, type Loc } from "../../browser/types";
import { type MenuItem, type Toast } from "../../ui/components/Dialogs";
import { useRef, type RefObject, type Dispatch, type SetStateAction } from "react";
import { type Layout, oneLayout, type PaneSnap, type WorkspaceStore } from "../lib/workspaces";
import { type DropTarget, type DropCheck, usePaneDrag } from "./usePaneDrag";
import type { Late } from "../lib/late";

export interface UsePaneMovesDeps {
  applyLayout: (l: Layout, wsId: string, fallback: Loc | null, focus?: boolean, empty?: Set<PaneId>) => void;
  closeNow: (id: PaneId) => boolean;
  cramped: boolean;
  crampedRef: RefObject<boolean>;
  dualPane: ReturnType<typeof usePanesHost>["dualPane"];
  fillSlot: (id: PaneId, s: PaneSnap | undefined, hist: HistorySnap | null, fallback: Loc | null, empty?: boolean, seed?: Listing) => void;
  focusSoon: (id: PaneId) => number;
  histories: RefObject<Map<string, Partial<Record<PaneId, HistorySnap>>>>;
  ids: (PaneId)[];
  lastTop: RefObject<Map<PaneId, { loc: Loc | null; top: number; }>>;
  listScroller: (id: PaneId) => HTMLElement | null;
  paneRoom: () => { w: number; h: number; } | null;
  pendingScroll: RefObject<Map<PaneId, { loc: Loc; top: number; selected?: string[]; }>>;
  setActiveId: (id: PaneId) => void;
  setCramped: Dispatch<SetStateAction<boolean>>;
  setTree: Dispatch<SetStateAction<PaneNode>>;
  setWs: Dispatch<SetStateAction<WorkspaceStore>>;
  slot: (id: PaneId) => Pane;
  snapOf: (id: PaneId, withScroll: boolean) => PaneSnap;
  switchWorkspace: (id: string) => void;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  treeRef: RefObject<PaneNode>;
  vacate: (id: PaneId) => void;
  ws: WorkspaceStore;
  late: Late;
}

/** Moving panes: dragged by the header to dock beside another, swap, or go to another workspace; and the cramped window's one-pane-at-a-time view. */
export function usePaneMoves(s: UsePaneMovesDeps) {
  // A pane dragged by its header's empty part (usePaneDrag) docks beside another or swaps with
  // it, or goes to another workspace: dropped on its tab, or into its layout once resting on the
  // tab has opened it. The panes menu's Move pane ▸ steps it with the keyboard. A pane that moves
  // keeps its slot, place, view, Back / Forward and links; one that changes workspace keeps all
  // but its links (the panes they were with stay behind) and takes a free slot there.
  /** Whether layout `t` fits the room the panes have now. */
  const fitsRoom = (t: PaneNode) => {
    const room = s.paneRoom();
    const need = minSize(t);
    return !room || (need.w <= room.w + 0.5 && need.h <= room.h + 0.5);
  };
  /** How far down each list on screen is, given back once the layout has changed (a pane that moves to another split is drawn anew). */
  const keepScrolls = () => {
    for (const id of s.ids) {
      const here = s.slot(id).here;
      const el = s.listScroller(id);
      // a pane not drawn now (cramped window): how far down it was when last seen
      const seen = s.lastTop.current.get(id);
      const top = el ? el.scrollTop : seen && sameLoc(seen.loc, here) ? seen.top : 0;
      if (here && top) s.pendingScroll.current.set(id, { loc: here, top });
    }
  };
  /** The window gets too small for every pane, or room again: each list keeps its place. */
  const onCramped = (on: boolean) => {
    if (on === s.crampedRef.current) return;
    s.crampedRef.current = on;
    // the panes were drawn anew already: their places come from the last scroll seen
    for (const id of s.ids) {
      const here = s.slot(id).here;
      const seen = s.lastTop.current.get(id);
      if (here && seen?.top && sameLoc(seen.loc, here)) s.pendingScroll.current.set(id, { loc: here, top: seen.top });
    }
    s.setCramped(on);
  };
  /** The panes on screen laid out as `next` (the same panes, moved): `id` is the one that moved and becomes the active one. */
  const rearrange = (id: PaneId, next: PaneNode) => {
    if (shapeOf(next) === shapeOf(s.treeRef.current)) return;
    keepScrolls();
    s.setTree(next);
    s.setActiveId(id);
    s.focusSoon(id);
  };
  /** Move pane ▸ Left, Right, Up, Down: past its neighbour that way, greyed out at the window's edge or without room. */
  const moveItems = (id: PaneId): MenuItem[] =>
    (["left", "right", "up", "down"] as const).map((d) => {
      const next = moveToward(s.treeRef.current, id, d);
      return {
        type: "item",
        label: d[0].toUpperCase() + d.slice(1),
        icon: `arrow-${d}` as const,
        disabled: !next || !fitsRoom(next),
        onClick: () => next && rearrange(id, next),
      };
    });
  /** the pane being dragged: its slot and the workspace it is in (on screen or not, once resting on a tab opened another) */
  const dragFrom = useRef<{ ws: string; id: PaneId } | null>(null);
  /** the dragged pane isn't in the workspace on screen */
  const dragAway = () => !!dragFrom.current && dragFrom.current.ws !== s.ws.active;
  /** A pane of a workspace not on screen, as it was left there. */
  const keptPane = (wsId: string, id: PaneId) => ({ snap: s.ws.list.find((w) => w.id === wsId)?.panes[id], hist: s.histories.current.get(wsId)?.[id] ?? null });
  /** A layout without pane `id`; the only pane leaves an empty one behind (a workspace always has one). */
  const withoutPane = (l: Layout, id: PaneId): Layout => {
    const t = closePane(l.tree, id);
    if (!t) return oneLayout(null);
    const panes = { ...l.panes };
    delete panes[id];
    return { tree: t, links: l.links.filter((x) => !x.includes(id)), recent: l.recent.filter((x) => x !== id), panes };
  };
  /** Takes pane `id` out of workspace `wsId` (not the one on screen). */
  const takeFromKept = (wsId: string, id: PaneId) => {
    const h = s.histories.current.get(wsId);
    if (h) delete h[id];
    s.setWs((cur) => ({ ...cur, list: cur.list.map((w) => (w.id === wsId ? { ...w, ...withoutPane(w, id) } : w)) }));
  };
  /** Takes pane `id` off the screen: closed, or as the only one, an empty pane in its place. */
  const takeFromLive = (id: PaneId) => {
    if (s.closeNow(id)) return;
    s.vacate(id);
    s.applyLayout(oneLayout(null), s.ws.active, null);
  };
  /** Where a pane goes in workspace `l` (dropped on its tab): right of its active pane, else below it; or why it can't. */
  const placeIn = (l: Layout, name: string): { tree: PaneNode; fresh: PaneId } | string => {
    const ls = leaves(l.tree);
    const fresh = freeSlot(l.tree);
    if (!fresh || ls.length >= MAX_PANES) return `“${name}” already shows ${MAX_PANES} panes, the most a workspace can. Close one there first.`;
    const act = l.recent.find((x) => ls.includes(x)) ?? ls[0];
    for (const dir of ["row", "col"] as const) {
      const t = splitPane(l.tree, act, dir, fresh);
      if (fitsRoom(t)) return { tree: t, fresh };
    }
    return `There isn’t room for another pane in “${name}”. Make the window bigger, or close a pane there.`;
  };
  /** Pane `fresh` beside pane `target` on side `zone` of it. */
  const dockAt = (t: PaneNode, target: PaneId, zone: DropZone, fresh: PaneId) =>
    splitPane(t, target, zone === "left" || zone === "right" ? "row" : "col", fresh, zone === "left" || zone === "top");
  /** What dropping the dragged pane on pane `target`'s `zone` would do. */
  const checkDrop = (id: PaneId, target: DropTarget, zone: DropZone): DropCheck => {
    const t = s.treeRef.current;
    // the outer edge of all the panes: along that whole side
    if (target === "outer") {
      if (zone === "center") return null;
      if (!dragAway()) {
        const next = moveToEdge(t, id, zone);
        if (shapeOf(next) === shapeOf(t)) return null;
        return fitsRoom(next) ? "ok" : { why: "Not enough room" };
      }
      const fresh = freeSlot(t);
      if (!fresh || leaves(t).length >= MAX_PANES) return { why: `${MAX_PANES} panes at most` };
      return fitsRoom(dockEdge(t, fresh, zone)) ? "ok" : { why: "Not enough room" };
    }
    if (!dragAway()) {
      if (target === id) return null;
      const next = movePane(t, id, target, zone);
      if (shapeOf(next) === shapeOf(t)) return null;
      return fitsRoom(next) ? "ok" : { why: "Not enough room" };
    }
    // brought from another workspace: it takes a free slot here
    const fresh = freeSlot(t);
    if (!fresh || leaves(t).length >= MAX_PANES) return { why: `${MAX_PANES} panes at most` };
    return fitsRoom(dockAt(t, target, zone, fresh)) ? "ok" : { why: "Not enough room" };
  };
  const dropPane = (id: PaneId, target: DropTarget, zone: DropZone) => {
    const from = dragFrom.current;
    const outer = target === "outer" && zone !== "center" ? zone : null;
    if (!from || from.ws === s.ws.active) return rearrange(id, outer ? moveToEdge(s.treeRef.current, id, outer) : target === "outer" ? s.treeRef.current : movePane(s.treeRef.current, id, target, zone));
    // from the workspace it was dragged out of, into a free slot here
    const t = s.treeRef.current;
    const fresh = freeSlot(t);
    if (!fresh) return;
    const { snap, hist } = keptPane(from.ws, from.id);
    keepScrolls();
    s.dualPane.quietly(() => s.fillSlot(fresh, snap, hist, null));
    s.setTree(outer ? dockEdge(t, fresh, outer) : target === "outer" ? t : dockAt(t, target, zone, fresh));
    s.setActiveId(fresh);
    s.focusSoon(fresh);
    takeFromKept(from.ws, from.id);
  };
  /** latest steps for a toast's button (by the time it is clicked this render's values are old) */
  const wsShow = useRef((_id: string) => {});
  wsShow.current = s.switchWorkspace;
  /** Whether letting go of the dragged pane on workspace `wsId`'s tab moves it there (null: the tab it came from, which only opens). */
  const canToWorkspace = (_id: PaneId, wsId: string) => {
    const from = dragFrom.current;
    const w = s.ws.list.find((x) => x.id === wsId);
    if (!from || !w || wsId === s.ws.active) return null;
    if (wsId === from.ws) return null;
    return typeof placeIn(w, w.name) !== "string";
  };
  /** The dragged pane let go on workspace `wsId`'s tab: it moves into that workspace, which stays where it is. */
  const toWorkspace = (_id: PaneId, wsId: string) => {
    const from = dragFrom.current;
    const w = s.ws.list.find((x) => x.id === wsId);
    if (!from || !w || wsId === from.ws || wsId === s.ws.active) return;
    const placed = placeIn(w, w.name);
    if (typeof placed === "string") return s.toast("info", placed);
    const onScreen = from.ws === s.ws.active;
    const name = onScreen ? s.late.nameOf(from.id) : (keptPane(from.ws, from.id).snap?.loc?.prefix.split("/").filter(Boolean).pop() ?? "The pane");
    const { snap, hist } = onScreen ? { snap: s.snapOf(from.id, true), hist: s.slot(from.id).history.save() } : keptPane(from.ws, from.id);
    const f = placed.fresh;
    s.histories.current.set(wsId, { ...s.histories.current.get(wsId), [f]: hist ?? undefined });
    s.setWs((cur) => ({
      ...cur,
      list: cur.list.map((x) =>
        x.id !== wsId
          ? x
          : { ...x, tree: placed.tree, links: x.links.filter((l) => !l.includes(f)), recent: [f, ...x.recent.filter((r) => r !== f)], panes: { ...x.panes, [f]: snap } },
      ),
    }));
    if (onScreen) takeFromLive(from.id);
    else takeFromKept(from.ws, from.id);
    s.toast("info", `Moved “${name}” to “${w.name}”`, { label: "Show", run: () => wsShow.current(wsId) });
  };
  const paneDrag = usePaneDrag({
    // anywhere to move it: another pane, or another workspace (not with one pane at a time in a small window)
    enabled: !s.cramped && (s.ids.length > 1 || s.ws.list.length > 1),
    activeWs: s.ws.active,
    ghost: (id) => ({ provider: s.slot(id).profile?.provider, name: s.late.nameOf(id) }),
    centre: () => !dragAway(),
    check: checkDrop,
    onDrop: dropPane,
    canToWorkspace,
    onToWorkspace: toWorkspace,
    onSpring: (_id, wsId) => s.switchWorkspace(wsId),
    onStart: (id) => (dragFrom.current = { ws: s.ws.active, id }),
    onEnd: () => (dragFrom.current = null),
  });
  return { keepScrolls, onCramped, moveItems, dragAway, takeFromLive, wsShow, paneDrag };
}
