import type { Settings } from "../../settings/settings";
import { useWorkspaceRecipes } from "./useWorkspaceRecipes";
import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { type WorkspaceStore, loadWorkspaces, writeSlot } from "../lib/workspaces";
import { loadLayout, loadLinks, leaves, type PaneNode, saveLayout, type SyncLink, saveLinks, allFacing, sameLink, toggleLink } from "../lib/paneLayout";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";
import { type PaneId } from "../../browser/types";

export interface UseShellLayoutDeps {
  settings: Settings;
}

/** The layout on screen: workspaces, the tree of splits, terminal slots, synchronized-browsing links and which pane was active last. */
export function useShellLayout(h: UseShellLayoutDeps) {
  // workspace recipes (recipes.ts): layouts saved to reset to or open again, terminals included
  const rec = useWorkspaceRecipes();
  // workspaces (workspaces.ts): named layouts the window switches between. The one on screen lives
  // in the pane slots and the state below; the others are snapshots. The first launch with them
  // makes "Default workspace" of the layout as it was.
  const [ws, setWs] = useState<WorkspaceStore>(() => {
    const loaded = loadWorkspaces(() => {
      const t = loadLayout(h.settings.layout);
      return { tree: t, links: loadLinks(t, h.settings.syncBrowsing), recent: leaves(t) };
    });
    // the ones set to open from their recipe do (their terminals type their startup commands)
    const s = rec.atLaunch(loaded);
    const start = s.list.find((w) => w.id === s.active)!;
    // its panes into their slots' keys, where the slots read where to open and how to show it
    for (const id of leaves(start.tree)) writeSlot(id, start.panes[id]);
    return s;
  });
  const wsNow = ws.list.find((w) => w.id === ws.active) ?? ws.list[0];
  /** the workspace on screen at launch opens at its recipe's folders even with "reopen where I was" off */
  const startSaved = useRef(wsNow.start === "saved" && !!rec.recipeOf(wsNow));
  // the panes on screen as a tree of splits (the workspace's)
  const [tree, setTree] = useState<PaneNode>(() => wsNow.tree);
  const ids = useMemo(() => leaves(tree), [tree]);
  const dual = ids.length > 1;
  // terminal panes (src/terminal): slots that show a shell instead of files
  const term = useTerminalPanes(wsNow);
  const fileIds = ids.filter((id) => !term.terms[id]);
  useEffect(() => {
    // dragging a divider changes the tree on every mouse move: write once it settles
    const t = window.setTimeout(() => saveLayout(tree), 200);
    return () => window.clearTimeout(t);
  }, [tree]);
  // synchronized browsing: pairs of panes that follow each other, switched by the link on the
  // divider between them. Only pairs facing each other across a divider count, so what is lit on
  // screen is exactly what moves together; a link kept from another layout comes back with it.
  const [links, setLinks] = useState<SyncLink[]>(() => wsNow.links);
  useEffect(() => saveLinks(links), [links]);
  // (file panes only: a terminal doesn't follow a folder this way, it has "Follow the folder above")
  const canLink = (a: PaneId, b: PaneId) => !term.terms[a] && !term.terms[b];
  const facing = useMemo(() => allFacing(tree).filter(({ pair: [a, b] }) => !term.terms[a] && !term.terms[b]), [tree, term.terms]);
  const liveLinks = useMemo(() => links.filter((l) => facing.some(({ pair: [a, b] }) => sameLink(l, a, b))), [links, facing]);
  const isLinked = (a: PaneId, b: PaneId) => liveLinks.some((l) => sameLink(l, a, b));
  const toggleSync = (a: PaneId, b: PaneId) => setLinks((cur) => toggleLink(cur, a, b));
  /** a closed pane's slot opens empty next time: it lets go of its links too */
  const unlink = (gone: (id: PaneId) => boolean) => setLinks((cur) => cur.filter(([a, b]) => !gone(a) && !gone(b)));
  // the panes by when they were last active, most recent first: the first on screen is the
  // active one, the next is what "the other pane" means for it (F5 / F6, swap, compare)
  const [recent, setRecent] = useState<PaneId[]>(() => wsNow.recent);
  const setActiveId = useCallback((id: PaneId) => setRecent((cur) => (cur[0] === id ? cur : [id, ...cur.filter((x) => x !== id)])), []);
  const activeId = recent.find((id) => ids.includes(id)) ?? ids[0];
  /** the file pane used last: what the sidebar, the menus and the keyboard act on while a terminal has the keyboard */
  const fileId = recent.find((id) => fileIds.includes(id)) ?? fileIds[0] ?? null;
  return { rec, ws, setWs, wsNow, startSaved, tree, setTree, ids, dual, term, fileIds, links, setLinks, canLink, facing, liveLinks, isLinked, toggleSync, unlink, recent, setRecent, setActiveId, activeId, fileId };
}
