/**
 * Everything that opens on top of the folder list (screens, the photo viewer, documents, sheets,
 * dialogs) as one stack, in the order it opened. The stack is the single answer to "what is on
 * top": it sets each layer's z-order, decides what back (Android's button, the history, the
 * iPhone edge swipe, every on-screen back arrow) closes first, which screen the edge swipe moves,
 * and how deep the history goes. Opening something always puts it on top, whatever else is open.
 */
import { useRef } from "react";

export type LayerId =
  | "detail"
  | "viewer"
  | "doc"
  | "intake"
  | "transfers"
  | "settings"
  | "folderInfo"
  | "sheet"
  | "move"
  | "prompt"
  | "confirm"
  | "conn"
  | "kybl";

/** Full-screen layers the iPhone edge swipe can slide away (the viewer has its own drag-down). */
export const SWIPEABLE: ReadonlySet<LayerId> = new Set<LayerId>(["detail", "doc", "intake", "transfers", "settings"]);
/** Sheets and dialogs: they take the bottom of the screen, where toasts usually are. */
export const SHEETS: ReadonlySet<LayerId> = new Set<LayerId>(["folderInfo", "sheet", "move", "prompt", "confirm", "conn", "kybl"]);

/** z-index of the layer at `pos` in the stack: above the folder (bars 5, FAB 6), below toasts and pills. */
export const layerZ = (pos: number) => 20 + pos * 4;

/**
 * The open layers, bottom first. A layer that turns open goes on top; one that closes leaves
 * the stack; the rest keep their order. Derived during render from what is open, so it can never
 * disagree with the screen.
 */
export function useLayerStack(open: Record<LayerId, boolean>): LayerId[] {
  const order = useRef<LayerId[]>([]);
  const prev = order.current;
  const next = prev.filter((id) => open[id]);
  for (const id of Object.keys(open) as LayerId[]) if (open[id] && !next.includes(id)) next.push(id);
  if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) order.current = next;
  return order.current;
}

/** The element the edge swipe moves for the layer on top (its wrapper carries `data-layer`). */
export function layerElement(id: LayerId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.m-app [data-layer="${id}"]:not(.m-leaving) > .m-overlay`);
}
