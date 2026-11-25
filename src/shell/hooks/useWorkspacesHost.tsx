import type { usePanesHost } from "./usePanesHost";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { Toast } from "../../ui/components/Dialogs";
import type { Late } from "../lib/late";
import type { Profile } from "../../core/types";
import type { Pane } from "../../browser/hooks/usePane";
import { useRef, useState, useEffect, type RefObject, type Dispatch, type SetStateAction } from "react";
import { type PaneId, type Loc, type PaneView, LOCAL_PROFILE, THIS_MAC, PANE_IDS } from "../../browser/types";
import { type HistorySnap } from "../../browser/hooks/useHistory";
import { type Listing, sameLoc } from "../../browser/hooks/useListing";
import { type PaneSnap, type Layout, type WorkspaceStore, saveWorkspaces, type Workspace, oneLayout, newId, nextName, copyLayout, copyName, reorder, paneCount } from "../lib/workspaces";
import { leaves, minSize, type SyncLink, type PaneNode } from "../lib/paneLayout";
import { useConnections } from "./useConnections";
import { useDialogs } from "./useDialogs";
import { useWorkspaceRecipes } from "./useWorkspaceRecipes";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";

export interface UseWorkspacesHostDeps {
  active: Pane;
  activeId: PaneId;
  autoFold: RefObject<number>;
  busyShells: (sids: (string | undefined)[]) => Promise<number>;
  closeNow: (id: PaneId) => boolean;
  confirmEndShells: (busy: number, label: string) => Promise<boolean>;
  connectIn: (id: PaneId, p: Profile, preferBucket?: string, startPrefix?: string) => Promise<void>;
  conns: ReturnType<typeof useConnections>;
  dialogs: ReturnType<typeof useDialogs>;
  dualPane: ReturnType<typeof usePanesHost>["dualPane"];
  focusSoon: (id: PaneId) => number;
  ids: (PaneId)[];
  late: Late;
  links: SyncLink[];
  opened: RefObject<Set<PaneId>>;
  paneRoom: () => { w: number; h: number; } | null;
  profiles: Profile[];
  rec: ReturnType<typeof useWorkspaceRecipes>;
  recent: (PaneId)[];
  setActiveId: (id: PaneId) => void;
  setLinks: Dispatch<SetStateAction<SyncLink[]>>;
  setRecent: Dispatch<SetStateAction<(PaneId)[]>>;
  setTree: Dispatch<SetStateAction<PaneNode>>;
  setWs: Dispatch<SetStateAction<WorkspaceStore>>;
  sideHidden: boolean;
  sideSpare: () => number;
  slot: (id: PaneId) => Pane;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  toggleSidebar: () => void;
  tree: PaneNode;
  treeRef: RefObject<PaneNode>;
  unfoldIfRoom: (next: PaneNode) => void;
  vacate: (id: PaneId) => void;
  ws: WorkspaceStore;
  wsNow: Workspace;
  wsSids: (wsId: string) => (string | undefined)[];
}

/** Workspaces: switching, adding, renaming, reordering and closing them, keeping each one's panes, scroll and history while another is on screen. */
export function useWorkspacesHost(h: UseWorkspacesHostDeps) {
  /** a workspace's panes' Back / Forward while another is on screen (this session only) */
  const histories = useRef(new Map<string, Partial<Record<PaneId, HistorySnap>>>());
  /**
   * The listings of the panes of workspaces not on screen, by workspace and slot. The slots are
   * shared by every workspace, so without this each switch would list every folder again (and
   * with it reconnect). Held only for what a pane showed when it was left; dropped when that place
   * changes (reloadIfShowing), the workspace closes or resets. No pane stays mounted, so nothing
   * polls in the background.
   */
  const keptListings = useRef(new Map<string, Listing>());
  /** a listing this big is listed again instead of kept: it would weigh on memory for a rare return */
  const KEEP_LISTING_MAX = 20_000;
  const dropKept = (match: (key: string, l: Listing) => boolean) => {
    for (const [k, l] of keptListings.current) if (match(k, l)) keptListings.current.delete(k);
  };
  const keepListings = (wsId: string) => {
    for (const k of [...keptListings.current.keys()]) if (k.startsWith(`${wsId}\n`)) keptListings.current.delete(k);
    for (const id of h.ids) {
      const p = h.slot(id);
      const l = p.ent.listing;
      // (one whose pages are still being pulled is listed again: coming back, the pull would bump the
      // request id and the quiet refresh after `seed` would never land, leaving stale rows. A big one
      // that stopped at the cap and waits for scrolling is idle, so it is kept)
      if (h.term.terms[id] || !p.ent.fresh || p.ent.listError || !l.loc || (l.next && p.ent.pulling) || l.folders.length + l.objects.length > KEEP_LISTING_MAX) continue;
      keptListings.current.set(`${wsId}\n${id}`, l);
    }
  };
  /** how far down a pane's list was, given back once that list is there again */
  const pendingScroll = useRef(new Map<PaneId, { loc: Loc; top: number; selected?: string[] }>());
  /** the workspace being renamed in its tab, and the one whose settings are open */
  const [wsEditing, setWsEditing] = useState<string | null>(null);
  const [wsSettings, setWsSettings] = useState<{ id: string; anchor: DOMRect } | null>(null);
  /** the window is too small for every pane: one shows, the bar's pane switcher picks it */
  const [cramped, setCramped] = useState(false);
  const crampedRef = useRef(false);
  /** how far down each pane's list was when last scrolled, and where (a cramped window draws only one) */
  const lastTop = useRef(new Map<PaneId, { loc: Loc | null; top: number }>());
  const slotRef = useRef(h.slot);
  slotRef.current = h.slot;
  useEffect(() => {
    const on = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!el.matches?.(".table-body, .grid-scroll")) return;
      const id = el.closest("[data-pane]")?.getAttribute("data-pane") as PaneId | null;
      if (id) lastTop.current.set(id, { loc: slotRef.current(id).here, top: el.scrollTop });
    };
    document.addEventListener("scroll", on, true);
    return () => document.removeEventListener("scroll", on, true);
  }, []);
  const listScroller = (id: PaneId) => document.querySelector<HTMLElement>(`[data-pane="${id}"] .table-body, [data-pane="${id}"] .grid-scroll`);
  const snapOf = (id: PaneId, withScroll: boolean): PaneSnap => {
    const p = h.slot(id);
    const t = h.term.terms[id];
    if (t) return { loc: null, view: p.viewState(), term: t };
    if (!withScroll) return { loc: p.here, view: p.viewState() };
    // this session only: how far down, what is selected and the filter typed (a pane not drawn
    // in a cramped window: how far down it was when last seen)
    const el = listScroller(id);
    const seen = lastTop.current.get(id);
    const top = el ? el.scrollTop : seen && sameLoc(seen.loc, p.here) ? seen.top : 0;
    const selected = [...p.sel.selected];
    const query = p.ent.query;
    return { loc: p.here, view: p.viewState(), ...(top ? { scroll: top } : {}), ...(selected.length ? { selected } : {}), ...(query ? { query } : {}) };
  };
  /** What the workspace on screen shows now. */
  const liveLayout = (withScroll = false): Layout => ({
    tree: h.tree,
    // all of them: a link kept from another arrangement of these panes comes back with it
    links: h.links,
    recent: [h.activeId, ...h.recent.filter((x) => x !== h.activeId && h.ids.includes(x))],
    panes: Object.fromEntries(h.ids.map((id) => [id, snapOf(id, withScroll)])),
  });
  const live = liveLayout();
  /** A workspace's layout: the one on screen as it is now, another as it was left. */
  const layoutOf = (id: string): Layout => (id === h.ws.active ? live : (h.ws.list.find((w) => w.id === id) ?? h.wsNow));
  /** The store with the workspace on screen as it is now. */
  const withLive = (s: WorkspaceStore, l: Layout = live) => ({ ...s, list: s.list.map((w) => (w.id === s.active ? { ...w, ...l } : w)) });
  // kept as it changes (dragging a divider changes it on every mouse move: written once it settles),
  // and on the way out
  const liveKey = JSON.stringify(live);
  const flush = useRef(() => {});
  flush.current = () => saveWorkspaces(withLive(h.ws));
  useEffect(() => {
    const t = window.setTimeout(() => flush.current(), 250);
    return () => window.clearTimeout(t);
  }, [liveKey, h.ws]);
  useEffect(() => {
    const out = () => flush.current();
    window.addEventListener("pagehide", out);
    window.addEventListener("beforeunload", out);
    return () => {
      window.removeEventListener("pagehide", out);
      window.removeEventListener("beforeunload", out);
    };
  }, []);
  // a cramped window draws only the active pane, anew each time: whichever way it was switched
  // (Tab, an arrow, the palette, the switcher), each list gets back to where it was last seen
  useEffect(() => {
    if (!crampedRef.current) return;
    for (const id of h.ids) {
      const here = h.slot(id).here;
      const seen = lastTop.current.get(id);
      if (here && seen?.top && sameLoc(seen.loc, here)) pendingScroll.current.set(id, { ...pendingScroll.current.get(id), loc: here, top: seen.top });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.activeId]);
  // a list's place in a workspace that came back: once it is listed again
  useEffect(() => {
    for (const [id, s] of pendingScroll.current) {
      const p = h.slot(id);
      if (!sameLoc(p.here, s.loc)) {
        if (p.here) pendingScroll.current.delete(id);
        continue;
      }
      if (!p.ent.fresh) continue;
      const el = listScroller(id);
      // not drawn (another pane shows in a cramped window): selected now, the place kept until it is
      if (!el && s.top) {
        if (s.selected) {
          p.sel.setSelected(new Set(s.selected));
          pendingScroll.current.set(id, { loc: s.loc, top: s.top });
        }
        continue;
      }
      pendingScroll.current.delete(id);
      if (s.selected) p.sel.setSelected(new Set(s.selected));
      if (el && s.top) el.scrollTop = s.top;
    }
  });

  const DEFAULT_VIEW: PaneView = { view: "list", sort: null, hidden: null, compact: null, tile: null };
  /**
   * Points the slots at a workspace's panes (`fallback`: where a pane without a place of its own
   * opens; without one, This Mac), and takes its layout and links. Synchronized
   * browsing doesn't follow these moves, and a pane waiting out of step forgets it.
   */
  /**
   * Points slot `id` at a pane as a workspace kept it: its place, how it looked, its Back / Forward
   * and how far down its list was (`fallback`: where it opens without a place; without one, This Mac).
   */
  const fillSlot = (id: PaneId, s: PaneSnap | undefined, hist: HistorySnap | null, fallback: Loc | null, empty = false, seed?: Listing) => {
    const p = h.slot(id);
    p.closeQuick();
    p.ent.setQuery("");
    p.applyView(s?.view ?? DEFAULT_VIEW);
    h.opened.current.add(id);
    // a terminal on a connection that no longer exists comes back as an empty file pane
    const t = s?.term && (s.term.profileId === LOCAL_PROFILE || h.profiles.some((x) => x.id === s.term!.profileId)) ? s.term : undefined;
    h.term.assign(id, t);
    const at = s?.loc ?? (empty || (s?.term && !t) ? null : fallback);
    const prof = at ? h.profiles.find((x) => x.id === at.profileId) : null;
    if (t) {
      // a terminal pane: its slot shows no files
      p.showConnection(null);
      p.history.load(null, null);
    } else if (at && prof) {
      p.go(prof, at.bucket, at.prefix, { history: false, seed });
      p.history.load(hist, at);
      void h.conns.loadBuckets(prof);
      if (s?.query) p.ent.setQuery(s.query);
      if ((s?.scroll || s?.selected?.length) && s.loc) pendingScroll.current.set(id, { loc: s.loc, top: s.scroll ?? 0, selected: s.selected });
      // (its own place, also while a cramped window leaves it undrawn)
      if (s?.scroll && s.loc) lastTop.current.set(id, { loc: s.loc, top: s.scroll });
    } else {
      p.showConnection(null);
      p.history.load(null, null);
      // (a recipe's pane whose connection is gone stays empty, with a note)
      if (!empty) void h.connectIn(id, THIS_MAC);
    }
  };
  /** `empty`: panes that stay empty (a recipe's, whose connection is gone) */
  const applyLayout = (l: Layout, wsId: string, fallback: Loc | null, focus = true, empty?: Set<PaneId>) => {
    const nextIds = leaves(l.tree);
    const hist = histories.current.get(wsId) ?? {};
    pendingScroll.current.clear();
    // places seen in the layout that leaves (snapshotted by then) would land on the panes that come in
    lastTop.current.clear();
    h.rec.clearNotes();
    h.dualPane.quietly(() => {
      for (const id of PANE_IDS) {
        if (!nextIds.includes(id)) {
          if (h.ids.includes(id)) h.vacate(id);
          continue;
        }
        fillSlot(id, l.panes[id], hist[id] ?? null, fallback, !!empty?.has(id), keptListings.current.get(`${wsId}\n${id}`));
      }
    });
    h.dualPane.forgetBehind();
    // used up: this workspace is on screen now, and its panes' own state is the live one
    dropKept((k) => k.startsWith(`${wsId}\n`));
    h.setTree(l.tree);
    h.setLinks(l.links);
    h.setRecent([...l.recent.filter((x) => nextIds.includes(x)), ...nextIds.filter((x) => !l.recent.includes(x))]);
    // the sidebar folds to its rail when that is what it takes to show every pane, as a split
    // does, and comes back when a split had folded it and the panes fit beside it
    const room = h.paneRoom();
    const need = minSize(l.tree);
    if (room && h.sideHidden) h.unfoldIfRoom(l.tree);
    else if (room && need.w > room.w && need.w <= room.w + h.sideSpare()) {
      h.autoFold.current = h.sideSpare();
      h.toggleSidebar();
    }
    if (focus) h.focusSoon(l.recent.find((x) => nextIds.includes(x)) ?? nextIds[0]);
  };
  /** Keeps the Back / Forward of the panes on screen for when this workspace comes back. */
  const keepHistories = () => histories.current.set(h.ws.active, Object.fromEntries(h.ids.map((id) => [id, h.slot(id).history.save()])));
  /** Shows workspace `id` (the one on screen is kept as it is). */
  const switchWorkspace = (id: string) => {
    const target = h.ws.list.find((w) => w.id === id);
    if (!target || id === h.ws.active) return;
    const now = liveLayout(true);
    keepHistories();
    keepListings(h.ws.active);
    setWsSettings(null);
    h.setWs((cur) => ({ ...withLive(cur, now), active: id }));
    applyLayout(target, id, h.active.here);
  };
  /** Adds a workspace (after the others, or after `after`) and shows it. */
  const addWorkspace = (w: Workspace, after?: string, focus = true, empty?: Set<PaneId>) => {
    const now = liveLayout(true);
    keepHistories();
    keepListings(h.ws.active);
    setWsSettings(null);
    h.setWs((cur) => {
      const list = withLive(cur, now).list;
      const at = after ? list.findIndex((x) => x.id === after) + 1 : list.length;
      return { list: [...list.slice(0, at), w, ...list.slice(at)], active: w.id };
    });
    applyLayout(w, w.id, h.active.here, focus, empty);
  };
  /** "+": one empty pane, which asks what to show (PaneLauncher); its name ready to type over. */
  const newWorkspace = () => {
    const w: Workspace = { ...oneLayout(null), id: newId(), name: nextName(h.ws.list), color: null, start: "restore", recipe: null };
    addWorkspace(w, undefined, false, new Set(leaves(w.tree)));
    setWsEditing(w.id);
  };
  const duplicateWorkspace = (id: string) => {
    const src = h.ws.list.find((w) => w.id === id);
    if (!src) return;
    // a copy of its own: not tied to the source's recipe (updating it there would overwrite the source's)
    const w: Workspace = { ...src, ...copyLayout(layoutOf(id)), id: newId(), name: copyName(h.ws.list, src.name), recipe: null, start: "restore" };
    addWorkspace(w, id);
  };
  const patchWorkspace = (id: string, patch: Partial<Pick<Workspace, "name" | "color" | "start" | "recipe">>) =>
    h.setWs((cur) => ({ ...cur, list: cur.list.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  const renameWorkspace = (id: string, name: string) => {
    const n = name.trim().slice(0, 80);
    const before = h.ws.list.find((w) => w.id === id)?.name;
    if (!n) return;
    patchWorkspace(id, { name: n });
    if (before) h.rec.renamed(id, before, n);
  };
  /** Shows layout `l` as workspace `id`, in place of what it showed (a reset to its recipe). */
  const replaceWorkspace = (id: string, l: Layout, empty: Set<PaneId>) => {
    histories.current.delete(id);
    dropKept((k) => k.startsWith(`${id}\n`));
    setWsSettings(null);
    if (id === h.ws.active) {
      h.setWs((cur) => ({ ...cur, list: cur.list.map((w) => (w.id === id ? { ...w, ...l } : w)) }));
    } else {
      const now = liveLayout(true);
      keepHistories();
      keepListings(h.ws.active);
      h.setWs((cur) => {
        const list = withLive(cur, now).list.map((w) => (w.id === id ? { ...w, ...l } : w));
        return { list, active: id };
      });
    }
    applyLayout(l, id, null, true, empty);
  };
  const moveWorkspace = (from: number, to: number) => h.setWs((cur) => ({ ...cur, list: reorder(cur.list, from, to) }));
  /** The latest of the steps that run after a confirm (by then this render's values are old). */
  const wsLater = useRef({ close: (_id: string) => {}, closeOthers: (_id: string) => {} });
  wsLater.current.close = (id) => {
    const i = h.ws.list.findIndex((w) => w.id === id);
    const w = h.ws.list[i];
    if (!w || h.ws.list.length < 2) return;
    const was = { ...w, ...layoutOf(id) };
    setWsSettings(null);
    histories.current.delete(id);
    dropKept((k) => k.startsWith(`${id}\n`));
    if (id === h.ws.active) {
      const next = h.ws.list[i + 1] ?? h.ws.list[i - 1];
      h.setWs((cur) => ({ list: cur.list.filter((x) => x.id !== id), active: next.id }));
      applyLayout(next, next.id, null);
    } else h.setWs((cur) => ({ ...cur, list: cur.list.filter((x) => x.id !== id) }));
    // its shells end now: Undo brings the panes back with fresh terminals, so say so
    const terms = leaves(was.tree).filter((p) => was.panes[p]?.term).length;
    const ended = terms ? (terms === 1 ? "; its terminal ended" : `; its ${terms} terminals ended`) : "";
    h.toast("info", `Closed “${w.name}”${ended}`, {
      label: "Undo",
      run: () =>
        h.setWs((cur) => {
          if (cur.list.some((x) => x.id === was.id)) return cur;
          const list = [...cur.list];
          list.splice(Math.min(i, list.length), 0, was);
          return { ...cur, list };
        }),
    });
  };
  wsLater.current.closeOthers = (id) => {
    // as they are now (the one on screen with its live layout), for Undo
    const was = h.ws.list.map((w) => ({ ...w, ...layoutOf(w.id) }));
    const gone = was.filter((w) => w.id !== id);
    if (!gone.length) return;
    if (id !== h.ws.active) switchWorkspace(id);
    for (const w of gone) histories.current.delete(w.id);
    h.setWs((cur) => ({ ...cur, list: cur.list.filter((x) => x.id === id), active: id }));
    // their shells end now: Undo brings the panes back with fresh terminals, so say so
    const terms = gone.reduce((n, w) => n + leaves(w.tree).filter((p) => w.panes[p]?.term).length, 0);
    const ended = terms ? (terms === 1 ? "; a terminal ended" : `; ${terms} terminals ended`) : "";
    h.toast("info", `Closed ${gone.length === 1 ? `“${gone[0].name}”` : `${gone.length} workspaces`}${ended}`, {
      label: "Undo",
      run: () =>
        h.setWs((cur) => {
          // back in their old order, around the ones there now
          const list = [...cur.list];
          was.forEach((w, i) => {
            if (!list.some((x) => x.id === w.id)) list.splice(Math.min(i, list.length), 0, w);
          });
          return { ...cur, list };
        }),
    });
  };
  /** Closes a workspace, asking first when it holds several panes. Never the last one. */
  const closeWorkspace = async (id: string) => {
    const w = h.ws.list.find((x) => x.id === id);
    if (!w || h.ws.list.length < 2) return;
    const n = paneCount(layoutOf(id));
    const sids = h.wsSids(id);
    const terms = sids.filter(Boolean).length;
    // a program running in one of its terminals asks for itself; otherwise several panes ask once
    const busy = await h.busyShells(sids);
    if (busy) {
      if (!(await h.confirmEndShells(busy, "Close workspace"))) return;
    } else if (n > 1) {
      const ok = await h.dialogs.confirm({
        title: `Close “${w.name}”?`,
        label: "Close workspace",
        message: (
          <p>
            Its {n} panes and the folders they show close with it{terms ? (terms === 1 ? ", and its terminal ends" : `, and its ${terms} terminals end`) : ""}. No files are
            touched.
          </p>
        ),
      });
      if (!ok) return;
    }
    wsLater.current.close(id);
  };
  const closeOtherWorkspaces = async (id: string) => {
    const others = h.ws.list.filter((x) => x.id !== id);
    if (!others.length) return;
    const busy = await h.busyShells(others.flatMap((x) => h.wsSids(x.id)));
    if (busy) {
      if (!(await h.confirmEndShells(busy, others.length === 1 ? "Close workspace" : "Close workspaces"))) return;
    } else if (others.some((x) => paneCount(layoutOf(x.id)) > 1)) {
      const ok = await h.dialogs.confirm({
        title: others.length === 1 ? `Close “${others[0].name}”?` : `Close ${others.length} other workspaces?`,
        label: others.length === 1 ? "Close workspace" : "Close workspaces",
        message: (
          <p>
            {others.length <= 3 ? `${others.map((x) => `“${x.name}”`).join(", ")} and the folders they show close.` : "They close with the folders they show."} Only “
            {h.ws.list.find((x) => x.id === id)?.name}” stays. No files are touched.
          </p>
        ),
      });
      if (!ok) return;
    }
    wsLater.current.closeOthers(id);
  };
  const stepWorkspace = (d: number) => {
    const n = h.ws.list.length;
    if (n < 2) return false;
    const i = h.ws.list.findIndex((w) => w.id === h.ws.active);
    switchWorkspace(h.ws.list[(i + d + n) % n].id);
  };
  /** ⌥⌘1–8: that workspace; ⌥⌘9: the last, as browsers do with tabs. */
  const jumpWorkspace = (n: number) => {
    const w = n === 9 ? h.ws.list[h.ws.list.length - 1] : h.ws.list[n - 1];
    if (w) switchWorkspace(w.id);
  };
  const moveActiveWorkspace = (d: number) => {
    const i = h.ws.list.findIndex((w) => w.id === h.ws.active);
    if (i + d >= 0 && i + d < h.ws.list.length) moveWorkspace(i, i + d);
  };
  /** after a menu closes it puts the keyboard back where it was: what opens from it waits a moment */
  const afterMenu = (fn: () => void) => () => window.setTimeout(fn, 40);
  const openWsSettings = (id: string) => {
    const el = document.querySelector<HTMLElement>(`.ws-tab[data-ws="${CSS.escape(id)}"]`);
    if (el) setWsSettings({ id, anchor: el.getBoundingClientRect() });
  };
  const workspaceMenu = (id: string, x: number, y: number) =>
    h.dialogs.menu(x, y, [
      { type: "item", label: "Rename", icon: "edit", hint: "F2", onClick: afterMenu(() => setWsEditing(id)) },
      { type: "item", label: "Settings…", icon: "settings", onClick: afterMenu(() => openWsSettings(id)) },
      { type: "item", label: "Duplicate", icon: "copy", onClick: () => duplicateWorkspace(id) },
      { type: "sep" },
      { type: "item", label: "Close workspace", icon: "x", disabled: h.ws.list.length < 2, onClick: () => void closeWorkspace(id) },
      { type: "item", label: "Close other workspaces", disabled: h.ws.list.length < 2, onClick: () => void closeOtherWorkspaces(id) },
    ]);
  return { keptListings, pendingScroll, wsEditing, setWsEditing, wsSettings, setWsSettings, cramped, crampedRef, lastTop, live, layoutOf, DEFAULT_VIEW, switchWorkspace, addWorkspace, newWorkspace, duplicateWorkspace, patchWorkspace, renameWorkspace, replaceWorkspace, moveWorkspace, closeWorkspace, stepWorkspace, jumpWorkspace, moveActiveWorkspace, openWsSettings, workspaceMenu, applyLayout, fillSlot, histories, listScroller, setCramped, snapOf };
}
