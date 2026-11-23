/**
 * The layer on top of the phone's stack (a sheet, a screen, the photo viewer, a dialog) is the
 * only thing a screen reader or a keyboard can reach: everything else in `.m-app` (the folder,
 * its bars and button, the layers under it) is made `inert` while it is up, and the layer takes
 * the focus. Toasts, pills, the offline note, the lock screen and dialogs drawn over the layer
 * stay reachable. Returns the undo, for an effect's cleanup.
 */
const KEEP = ".toasts, .m-pills, .m-offline, .m-lock, .modal-backdrop";

export function hideUnderLayer(top: string | undefined): (() => void) | undefined {
  const app = document.querySelector(".m-app");
  if (!app || !top) return;
  // (the tablet's details panel is in the stack but sits beside the files, not over them)
  const layer = app.querySelector<HTMLElement>(`:scope > [data-layer="${top}"]:not(.m-leaving)`);
  if (!layer || app.querySelector(":scope > .m-lock")) return;
  const marked: Element[] = [];
  for (const el of Array.from(app.children)) {
    if (el === layer || el.matches(KEEP) || el.hasAttribute("inert")) continue;
    el.setAttribute("inert", "");
    marked.push(el);
  }
  if (!layer.contains(document.activeElement)) {
    const box = layer.querySelector<HTMLElement>("[role=dialog], [role=menu], .m-overlay, .m-sheet") ?? layer;
    if (!box.hasAttribute("tabindex")) box.setAttribute("tabindex", "-1");
    box.focus({ preventScroll: true });
  }
  return () => {
    // a layer closing now animates out inert (Presence): that stays
    for (const el of marked) if (!el.classList.contains("m-leaving")) el.removeAttribute("inert");
  };
}
