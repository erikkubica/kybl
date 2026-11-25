import type { PaneId } from "../../browser/types";

/** Gives a pane's file list keyboard focus (after a sidebar click the arrows should move in it). */
export function focusPaneList(id: PaneId) {
  // (a terminal pane: its terminal's input)
  document.querySelector<HTMLElement>(`[data-pane="${id}"] [data-list-focus], [data-pane="${id}"] textarea.xterm-helper-textarea`)?.focus({ preventScroll: true });
}
