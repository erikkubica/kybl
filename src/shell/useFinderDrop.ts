/**
 * Files and folders dragged in from Finder / Explorer go to the pane under the pointer (terminals
 * included: AppShell types their paths in there, never uploads), else the active one. The webview reports the drag,
 * not the DOM, so the pane is found from the pointer position.
 *
 * Over a workspace's tab (`tabs`): resting there opens that workspace (WorkspaceBar
 * `springLoader`), to drop into one of its panes; letting go there uploads into the folder of its
 * active pane.
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PaneId } from "../browser/types";
import { isDraggingOut } from "../desktop/dragOut";
import { springLoader, type TabDropTarget } from "./WorkspaceBar";

export function useFinderDrop({
  target,
  onDrop,
  onRefused,
  refusedPane,
  tabs,
}: {
  /** the pane at this point (CSS pixels) that accepts uploads, or null */
  target: (x: number | null, y: number | null) => PaneId | null;
  onDrop: (pane: PaneId, paths: string[]) => void;
  /** files were dropped where nothing takes them (no bucket open, or a dialog is up) */
  onRefused?: () => void;
  /** where `target` just said no, a pane that should show it refuses (a terminal on a server), or null */
  refusedPane?: () => PaneId | null;
  /** workspace tabs: the one under the point (not the one on screen), whether it takes files, resting on it, letting go there */
  tabs?: {
    at: (x: number, y: number) => string | null;
    accepts: (id: string) => boolean;
    onSpring: (id: string) => void;
    onDrop: (id: string, paths: string[]) => void;
  };
}) {
  const [over, setOver] = useState<PaneId | null>(null);
  const [refused, setRefused] = useState<PaneId | null>(null);
  const [tab, setTab] = useState<TabDropTarget | null>(null);
  const cbs = useRef({ target, onDrop, onRefused, refusedPane, tabs });
  cbs.current = { target, onDrop, onRefused, refusedPane, tabs };

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    const spring = springLoader((id) => {
      setTab(null);
      cbs.current.tabs?.onSpring(id);
    });
    /** the tab under the point, if any (and its hover state on the bar) */
    const tabAt = (x: number | null, y: number | null) => {
      const id = x != null && y != null ? (cbs.current.tabs?.at(x, y) ?? null) : null;
      spring.over(id);
      const ok = id ? cbs.current.tabs!.accepts(id) : false;
      setTab((cur) => (!id ? null : cur?.id === id && cur.ok === ok ? cur : { id, ok, spring: true }));
      return id;
    };
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        // our own items dragged out and back in: not an upload into the folder they came from
        if (isDraggingOut()) {
          spring.cancel();
          setTab(null);
          setRefused(null);
          return setOver(null);
        }
        // positions come in physical pixels
        const at = "position" in p && p.position ? [p.position.x / devicePixelRatio, p.position.y / devicePixelRatio] : [null, null];
        if (p.type === "enter" || p.type === "over") {
          const onTab = tabAt(at[0], at[1]);
          const id = onTab ? null : cbs.current.target(at[0], at[1]);
          setOver(id);
          setRefused(onTab || id ? null : (cbs.current.refusedPane?.() ?? null));
        } else if (p.type === "leave") {
          spring.cancel();
          setTab(null);
          setOver(null);
          setRefused(null);
        } else if (p.type === "drop") {
          setOver(null);
          setRefused(null);
          const ws = tabAt(at[0], at[1]);
          spring.cancel();
          setTab(null);
          if (ws) {
            if (cbs.current.tabs!.accepts(ws)) cbs.current.tabs!.onDrop(ws, p.paths);
            return;
          }
          const pane = cbs.current.target(at[0], at[1]);
          if (pane) cbs.current.onDrop(pane, p.paths);
          else if (p.paths.length) cbs.current.onRefused?.();
        }
      })
      .then((u) => {
        // unmounted before the listener was in place (React's dev double mount): no second listener
        if (gone) u();
        else un = u;
      })
      .catch(() => {});
    return () => {
      gone = true;
      spring.cancel();
      un?.();
    };
  }, []);

  return { over, refused, tab };
}
