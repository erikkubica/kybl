import type { WorkspaceStore } from "../lib/workspaces";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { Pane } from "../../browser/hooks/usePane";
import type { Profile } from "../../core/types";
import { useRef, type RefObject, type Dispatch, type SetStateAction } from "react";
import { type PaneId } from "../../browser/types";
import { focusPaneList } from "../lib/focus";
import { type PaneNode, minSize, type Dir, freeSlot, leaves, MAX_PANES, splitPane, closePane, leaf, equalize } from "../lib/paneLayout";
import { type MenuItem, type Toast } from "../../ui/components/Dialogs";
import { terminalBusy } from "../../terminal/api";
import { mirrorToPane } from "../../mirror";
import { useDialogs } from "./useDialogs";
import { useWorkspaceRecipes } from "./useWorkspaceRecipes";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";
import type { Late } from "../lib/late";

export interface UsePaneSplitsDeps {
  activeId: PaneId;
  dialogs: ReturnType<typeof useDialogs>;
  dual: boolean;
  ids: (PaneId)[];
  opened: RefObject<Set<PaneId>>;
  otherOf: (id: PaneId) => PaneId | null;
  profiles: Profile[];
  rec: ReturnType<typeof useWorkspaceRecipes>;
  recent: (PaneId)[];
  setActiveId: (id: PaneId) => void;
  setRecent: Dispatch<SetStateAction<(PaneId)[]>>;
  setTree: Dispatch<SetStateAction<PaneNode>>;
  showJobs: () => void;
  sideHidden: boolean;
  slot: (id: PaneId) => Pane;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  toggleSidebar: () => void;
  tree: PaneNode;
  unlink: (gone: (id: PaneId) => boolean) => void;
  ws: WorkspaceStore;
  late: Late;
}

/** Splitting and closing panes: where a new pane goes, and asking before ending running shells. The sidebar is never folded for room: that's the user's call. */
export function usePaneSplits(deps: UsePaneSplitsDeps) {
  const treeRef = useRef(deps.tree);
  treeRef.current = deps.tree;
  const focusSoon = (id: PaneId) => requestAnimationFrame(() => requestAnimationFrame(() => focusPaneList(id)));
  /** The room the panes share now. */
  const paneRoom = () => {
    const box = document.querySelector<HTMLElement>(".splits");
    if (box) return { w: box.clientWidth, h: box.clientHeight };
    const one = document.querySelector<HTMLElement>(`[data-pane="${deps.ids[0]}"]`);
    if (!one) return null;
    return { w: one.clientWidth, h: one.clientHeight };
  };
  /**
   * Whether pane `id` can be split that way: "no" with the reason (no free slot, or no room), or "ok".
   */
  const splitRoom = (dir: Dir, id: PaneId): { ok: "ok" } | { ok: "no"; why: string } => {
    const t = treeRef.current;
    const fresh = freeSlot(t);
    if (!fresh || leaves(t).length >= MAX_PANES) return { ok: "no", why: `Kybl shows up to ${MAX_PANES} panes. Close one to make room.` };
    const room = paneRoom();
    const need = minSize(splitPane(t, id, dir, fresh));
    if (!room || (need.w <= room.w && need.h <= room.h)) return { ok: "ok" };
    return { ok: "no", why: deps.sideHidden ? "There isn’t room for another pane. Make the window bigger, or close a pane." : "There isn’t room for another pane. Fold the sidebar (⌥⌘S), make the window bigger, or close a pane." };
  };
  /** Why pane `id` can't be split that way, or null when it can. */
  const splitRefusal = (dir: Dir, id: PaneId): string | null => {
    const r = splitRoom(dir, id);
    return r.ok === "no" ? r.why : null;
  };
  /**
   * Where a new pane can go when the way asked for (`dir` of pane `id`) has no room: that pane the
   * other way, else the nearest other pane either way, so a 2 + 1 layout becomes 2 + 2 rather
   * than refusing; null: nowhere.
   */
  const roomyPlace = (dir: Dir, id: PaneId): { dir: Dir; id: PaneId } | null => {
    const t = treeRef.current;
    const other: Dir = dir === "row" ? "col" : "row";
    const centre = (x: PaneId) => {
      const r = document.querySelector<HTMLElement>(`[data-pane="${x}"]`)?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    const from = centre(id);
    const far = (x: PaneId) => {
      const c = centre(x);
      return c && from ? Math.hypot(c.x - from.x, c.y - from.y) : Infinity;
    };
    const rest = leaves(t).filter((x) => x !== id).sort((a, b) => far(a) - far(b));
    const tries = [{ dir, id }, { dir: other, id }, ...rest.flatMap((x) => [{ dir, id: x }, { dir: other, id: x }])].map((c) => ({ ...c, r: splitRoom(c.dir, c.id) }));
    const pick = tries.find((c) => c.r.ok === "ok");
    return pick ? { dir: pick.dir, id: pick.id } : null;
  };
  /**
   * Splits a pane: the new one opens the same place (and view) and becomes the active pane. It
   * goes right of or below the pane, or with `before` left of or above it. With `anywhere` (a new
   * terminal, ⌘↵ in the palette) it goes wherever there's room when that way has none.
   */
  const split = (dir: Dir, id: PaneId = deps.activeId, before = false, fill?: (fresh: PaneId) => void, anywhere = false) => {
    const asked = splitRoom(dir, id);
    const place = asked.ok !== "no" || !anywhere ? null : roomyPlace(dir, id);
    if (asked.ok === "no" && !place) return deps.toast("info", asked.why);
    const at = place ?? { dir, id };
    const t = treeRef.current;
    const fresh = freeSlot(t)!;
    const src = deps.slot(id);
    const p = deps.slot(fresh);
    deps.opened.current.add(fresh);
    // `fill`: the new pane opens somewhere else (the command palette's ⌘↵); else it opens empty and
    // asks what to show (PaneLauncher), the folder of the pane it came from first, so ↵ is a copy
    if (fill) fill(fresh);
    else p.showConnection(null);
    if (p.view !== src.view) p.setView(src.view);
    deps.late.keepScrolls();
    deps.setTree(splitPane(t, at.id, at.dir, fresh, place ? place.id === id && before : before));
    deps.setActiveId(fresh);
    focusSoon(fresh);
  };
  /** Split right, down, left and up for pane `id`, each greyed out when there's no room (or no slot) for it. */
  const splitItems = (id: PaneId): MenuItem[] => {
    const can = { row: !splitRefusal("row", id), col: !splitRefusal("col", id) };
    return [
      { type: "item", label: "Right", icon: "arrow-right", hint: "⌘\\", disabled: !can.row, onClick: () => split("row", id) },
      { type: "item", label: "Down", icon: "arrow-down", hint: "⇧⌘\\", disabled: !can.col, onClick: () => split("col", id) },
      { type: "item", label: "Left", icon: "arrow-left", disabled: !can.row, onClick: () => split("row", id, true) },
      { type: "item", label: "Up", icon: "arrow-up", disabled: !can.col, onClick: () => split("col", id, true) },
    ];
  };
  /** A pane leaves the screen: its slot lets go of its place, so it is empty when used again. */
  const vacate = (id: PaneId) => {
    const p = deps.slot(id);
    p.closeQuick();
    p.ent.setQuery("");
    p.sel.setSelected(new Set());
    p.showConnection(null);
    deps.opened.current.delete(id);
    deps.rec.clearNote(id);
    // its list's place goes with it: the next pane in this slot starts at the top
    deps.late.pendingScroll.current.delete(id);
    deps.late.lastTop.current.delete(id);
    // a terminal's slot is a file pane again (its shell ends unless another workspace has the pane now)
    deps.term.assign(id, undefined);
  };
  /**
   * Asks before terminals still running a program close with their panes (their shells end):
   * true to go ahead. An idle shell, or one not known to be busy, closes without asking.
   */
  const okToEndShells = async (sids: (string | undefined)[], label: string) => {
    const busy = await busyShells(sids);
    return !busy || confirmEndShells(busy, label);
  };
  /** how many of sessions `sids` run a program */
  const busyShells = async (sids: (string | undefined)[]) => {
    const live = sids.filter((s): s is string => !!s);
    return live.length ? (await Promise.all(live.map((s) => terminalBusy(s)))).filter((b) => b === true).length : 0;
  };
  const confirmEndShells = (busy: number, label: string) =>
    deps.dialogs.confirm({
      title: busy === 1 ? "A program is still running in a terminal" : `Programs are still running in ${busy} terminals`,
      label,
      danger: true,
      icon: "alert",
      message: <p>{busy === 1 ? "Closing ends it, and what the terminal has printed is gone." : "Closing ends them, and what the terminals have printed is gone."}</p>,
    });
  /** the terminals' sessions among panes `of` on screen */
  const sidsOf = (of: PaneId[]) => of.map((x) => deps.term.terms[x]?.sid);
  /** the terminals' sessions in workspace `wsId` */
  const wsSids = (wsId: string) => {
    const l = deps.late.layoutOf(wsId);
    return wsId === deps.ws.active ? sidsOf(leaves(l.tree)) : leaves(l.tree).map((x) => l.panes[x]?.term?.sid);
  };
  /** the latest close steps, for after a confirm (by then this render's values are old) */
  const paneLater = useRef({ close: (_id: PaneId): boolean => false, closeOthers: (_id: PaneId) => {}, takeFromLive: (_id: PaneId) => {} });
  /**
   * Closes a pane, asking first when it is a terminal with a program running; false when it is
   * the only one (⌘W then closes the window, as it always did).
   */
  const close = (id: PaneId = deps.activeId) => {
    if (!closePane(treeRef.current, id)) return false;
    const sid = deps.term.terms[id]?.sid;
    if (!sid) return closeNow(id);
    void okToEndShells([sid], "Close terminal").then((ok) => ok && paneLater.current.close(id));
    return true;
  };
  const closeOthers = (id: PaneId = deps.activeId) => {
    const sids = sidsOf(deps.ids.filter((x) => x !== id));
    if (!sids.some(Boolean)) return closeOthersNow(id);
    void okToEndShells(sids, "Close other panes").then((ok) => ok && paneLater.current.closeOthers(id));
  };
  const closeNow = (id: PaneId) => {
    const next = closePane(treeRef.current, id);
    if (!next) return false;
    deps.late.keepScrolls();
    vacate(id);
    deps.setTree(next);
    deps.unlink((x) => x === id);
    deps.setRecent((cur) => cur.filter((x) => x !== id));
    if (id === deps.activeId) focusSoon(deps.recent.find((x) => x !== id && leaves(next).includes(x)) ?? leaves(next)[0]);
    return true;
  };
  const closeOthersNow = (id: PaneId) => {
    deps.late.keepScrolls();
    for (const x of deps.ids) if (x !== id) vacate(x);
    deps.setTree(leaf(id));
    deps.unlink((x) => x !== id);
    deps.setActiveId(id);
    focusSoon(id);
  };
  /** ⌥⌘ and an arrow: the nearest pane that way (in a window too small for all, the previous or next one). */
  const focusToward = (d: "left" | "right" | "up" | "down") => {
    if (!deps.dual) return false;
    const rect = (id: PaneId) => document.querySelector(`[data-pane="${id}"]`)?.getBoundingClientRect();
    const a = rect(deps.activeId);
    let best: PaneId | null = null;
    let bestScore = Infinity;
    for (const id of deps.ids) {
      const r = id !== deps.activeId && rect(id);
      if (!a || !r) continue;
      const across = d === "left" || d === "right";
      const gap = { left: a.left - r.right, right: r.left - a.right, up: a.top - r.bottom, down: r.top - a.bottom }[d];
      if (gap < -2) continue;
      const overlap = across ? Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top) : Math.min(a.right, r.right) - Math.max(a.left, r.left);
      // beside it first, then the nearest, then the one sharing the longest edge
      const score = (overlap > 0 ? 0 : 1e6) + gap * 10 - overlap;
      if (score < bestScore) (bestScore = score), (best = id);
    }
    if (!best && deps.ids.every((id) => id === deps.activeId || !rect(id))) {
      const i = deps.ids.indexOf(deps.activeId) + (d === "left" || d === "up" ? -1 : 1);
      best = deps.ids[(i + deps.ids.length) % deps.ids.length];
    }
    if (!best) return true;
    deps.setActiveId(best);
    focusSoon(best);
    return true;
  };
  /** The panes menu: split four ways, and with several panes size and close them. */
  const panesItems = (id: PaneId): MenuItem[] => [
    ...splitItems(id).map((it) => (it.type === "item" ? { ...it, label: `Split ${it.label.toLowerCase()}` } : it)),
    ...(leaves(treeRef.current).length > 1
      ? ([
          { type: "sep" },
          { type: "item", label: "Make panes the same size", onClick: () => deps.setTree((t) => equalize(t)) },
          { type: "submenu", label: "Move pane", icon: "move", items: () => deps.late.moveItems(id) },
          mirrorToPane(deps.slot(id), deps.otherOf(id) ? deps.slot(deps.otherOf(id)!) : null, deps.dialogs, deps.showJobs),
          { type: "sep" },
          { type: "item", label: "Close pane", icon: "x", hint: "⌘W", onClick: () => void close(id) },
          { type: "item", label: "Close other panes", onClick: () => closeOthers(id) },
        ] satisfies MenuItem[])
      : []),
  ];
  const panesMenu = (id: PaneId, x: number, y: number) => deps.dialogs.menu(x, y, panesItems(id));
  return { treeRef, focusSoon, paneRoom, splitRefusal, split, splitItems, vacate, okToEndShells, busyShells, confirmEndShells, sidsOf, wsSids, paneLater, close, closeOthers, closeNow, closeOthersNow, focusToward, panesItems, panesMenu };
}
