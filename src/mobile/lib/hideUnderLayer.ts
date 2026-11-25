/**
 * The layer on top of the phone's stack (a sheet, a screen, the photo viewer, a dialog) is the
 * only thing a screen reader or a keyboard can reach: everything else in `.m-app` (the folder,
 * its bars and button, the layers under it) is made `inert` while it is up, and the layer takes
 * the focus. Toasts, pills, the offline note, the lock screen and dialogs drawn over the layer
 * stay reachable. Returns the undo, for an effect's cleanup.
 */
const KEEP = ".toasts, .m-pills, .m-offline, .m-lock, .modal-backdrop";

/**
 * The opener of a layer that just went away, for the layer replacing it in the same commit (an
 * action sheet's Rename opens the name prompt as the sheet closes). The prompt focuses itself
 * before this runs for it, so the real opener (the row's "…" button) would be lost otherwise.
 */
let handoff: Element | null = null;
/** Each open layer's opener, kept while dialogs open and close over it (Rename's Replace question). */
const openers = new WeakMap<Element, Element | null>();

export function hideUnderLayer(top: string | undefined): (() => void) | undefined {
  const handed = handoff;
  handoff = null;
  const app = document.querySelector(".m-app");
  if (!app || !top) return;
  // (the tablet's details panel is in the stack but sits beside the files, not over them)
  const layer = app.querySelector<HTMLElement>(`:scope > [data-layer="${top}"]:not(.m-leaving)`);
  if (!layer || app.querySelector(":scope > .m-lock")) return;
  // what had the keyboard when the layer opened (the row's "…" button): it gets it back (read
  // before `inert` below can take the focus away from it)
  const opener = openers.has(layer)
    ? openers.get(layer)!
    : !layer.contains(document.activeElement)
      ? document.activeElement
      : handed instanceof HTMLElement && handed.isConnected && !layer.contains(handed)
        ? handed
        : null;
  openers.set(layer, opener);
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
    // only when this layer went away (not when another opened over it, which takes the focus)
    const gone = !layer.isConnected || layer.classList.contains("m-leaving");
    if (gone) {
      handoff = opener;
      openers.delete(layer);
    }
    if (gone && opener instanceof HTMLElement && opener.isConnected && opener !== document.body && !opener.closest("[inert]")) {
      const now = document.activeElement;
      if (!now || now === document.body || layer.contains(now) || !now.isConnected) opener.focus({ preventScroll: true });
    }
  };
}
