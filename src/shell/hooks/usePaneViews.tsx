import type { usePanesHost } from "./usePanesHost";
import type { usePaneMoves } from "./usePaneMoves";
import type { useShellLayout } from "./useShellLayout";
import type { Settings } from "../../settings/settings";
import type { MenuItem } from "../../ui/components/Dialogs";
import type { EmptyActions } from "../../browser/components/PaneEmpty";
import { type Pane } from "../../browser/hooks/usePane";
import { dualMenuItems } from "../components/SplitLayout";
import { relation, type Facing, type PaneNode } from "../lib/paneLayout";
import { paneName } from "../components/dualActions";
import { mirrorToPane } from "../../mirror";
import { canTerminal } from "../../terminal/api";
import { LOCAL_PROFILE, type PaneId } from "../../browser/types";
import { BrowserPane } from "../../browser/BrowserPane";
import { type PaneSwitcher } from "../components/WorkspaceBar";
import { useConnections } from "./useConnections";
import { useDialogs } from "./useDialogs";

export interface UsePaneViewsDeps {
  activeId: PaneId;
  conns: ReturnType<typeof useConnections>;
  cramped: boolean;
  dialogs: ReturnType<typeof useDialogs>;
  dragAway: () => boolean;
  dropOver: PaneId | null;
  dropRefused: PaneId | null;
  dual: boolean;
  dualPane: ReturnType<typeof usePanesHost>["dualPane"];
  emptyFor: (id: PaneId) => EmptyActions;
  facing: Facing[];
  focusSoon: (id: PaneId) => number;
  ids: (PaneId)[];
  isLinked: (a: PaneId, b: PaneId) => boolean;
  keepScrolls: () => void;
  otherOf: (id: PaneId) => PaneId | null;
  paneDrag: ReturnType<typeof usePaneMoves>["paneDrag"];
  panesItems: (id: PaneId) => MenuItem[];
  panesMenu: (id: PaneId, x: number, y: number) => void;
  setActiveId: (id: PaneId) => void;
  settings: Settings;
  showJobs: () => void;
  slot: (id: PaneId) => Pane;
  switchMenu: (id: PaneId, x: number, y: number) => void;
  term: ReturnType<typeof useShellLayout>["term"];
  toggleSync: (a: PaneId, b: PaneId) => void;
  tree: PaneNode;
  updateSettings: (patch: Partial<Settings>) => void;
}

/** What draws a pane slot: a file pane with its props, or a terminal; and the cramped window's pane switcher. */
export function usePaneViews(s: UsePaneViewsDeps) {
  /** A pane's items for its other pane, first in its toolbar's "…" (several panes only). */
  const dualItemsFor = (p: Pane) => {
    const o = s.dual ? s.otherOf(p.id) : null;
    if (!o) return undefined;
    // "the right pane", "the pane below": the way to it says which (the menu has no room for folder names too)
    return () =>
      dualMenuItems({
        toOther: { dir: relation(s.tree, p.id, o) ?? "right", name: "" },
        onToOther: () => s.dualPane.sameFolderInOther(p.id),
        onSwap: s.dualPane.swap,
        onCompare: s.dualPane.compare,
        syncWith: s.facing
          .filter(({ pair: [a, b] }) => a === p.id || b === p.id)
          .map(({ pair: [a, b], at }) => {
            const id = a === p.id ? b : a;
            const dir = relation(s.tree, p.id, id);
            return { id, dir, name: dir ? "" : paneName(s.slot(id)), on: s.isLinked(p.id, id), at };
          }),
        onToggleSync: (id) => s.toggleSync(p.id, id),
      }).concat(mirrorToPane(p, s.slot(o), s.dialogs, s.showJobs));
  };
  const paneProps = (p: Pane) => ({
    pane: p,
    active: p.id === s.activeId,
    dual: s.dual,
    label: `Pane ${s.ids.indexOf(p.id) + 1} of ${s.ids.length}`,
    dualItems: dualItemsFor(p),
    settings: s.settings,
    updateSettings: s.updateSettings,
    dropUpload: s.dropOver === p.id,
    bucketNote: (p.profile && s.conns.bucketsBy[p.profile.id]?.note) || null,
    bucketError: (p.profile && s.conns.bucketsBy[p.profile.id]?.error) || null,
    bucketReconnect: !!(p.profile && s.conns.bucketsBy[p.profile.id]?.reconnect),
    empty: s.emptyFor(p.id),
    // one pane: a click splits it, as the dual pane button always did; more: the panes menu
    onSwitchConnection: (x: number, y: number) => s.switchMenu(p.id, x, y),
    // always the menu, so where the new pane goes is a choice (⌘\ still splits right at once)
    onPanes: (x: number, y: number) => s.panesMenu(p.id, x, y),
    onTerminal: canTerminal({ id: LOCAL_PROFILE, kind: "local" }) ? () => s.term.openFor(p.id) : undefined,
    panesItems: () => s.panesItems(p.id),
    onActivate: () => {
      if (s.dual && s.activeId !== p.id) s.setActiveId(p.id);
    },
    onGrip: s.paneDrag.grip?.(p.id),
    // (after resting on a tab opened another workspace, this slot may be another pane)
    lifted: s.paneDrag.dragging === p.id && !s.dragAway(),
  });
  /** Pane slot `id` on screen: a file pane, or a terminal. */
  const paneView = (id: PaneId, style?: React.CSSProperties) =>
    s.term.terms[id] ? (
      s.term.render(id, {
        style,
        active: id === s.activeId,
        dual: s.dual,
        onGrip: s.paneDrag.grip?.(id),
        lifted: s.paneDrag.dragging === id && !s.dragAway(),
        drop: s.dropOver === id ? "paste" : s.dropRefused === id ? "refuse" : null,
      })
    ) : (
      // keyed by slot: a cramped window draws one pane at a time in the same place, and each
      // must be its own (its list's scroll, open menus, a name being edited)
      <BrowserPane key={id} {...paneProps(s.slot(id))} style={style} />
    );
  const nameOf =(id: PaneId) => s.term.nameOf(id) || paneName(s.slot(id)) || s.slot(id).profile?.name || "Empty pane";
  const paneSwitcher: PaneSwitcher | null =
    s.dual && s.cramped
      ? {
          items: s.ids.map((id) => ({ id, name: nameOf(id) })),
          activeId: s.activeId,
          onPick: (id) => {
            s.keepScrolls();
            s.setActiveId(id);
            s.focusSoon(id);
          },
        }
      : null;
  return { paneView, nameOf, paneSwitcher };
}
