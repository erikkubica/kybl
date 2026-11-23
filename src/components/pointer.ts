/**
 * Small pointer facts the lists and the grid share. Pure, so the tests run them under node.
 */

export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

type Press = { button: number; ctrlKey: boolean; metaKey: boolean };

/**
 * Whether a press opens the context menu rather than selecting: the right button, or on macOS
 * Control with the left button (Finder treats Ctrl+click as a right-click, and WebKit sends it as a
 * left press with ctrlKey, then a contextmenu event).
 */
export const isContextPress = (ev: Press, mac = IS_MAC) => ev.button === 2 || (mac && ev.button === 0 && ev.ctrlKey && !ev.metaKey);

/**
 * Whether a press at viewport point (`x`, `y`) lands on element `el`'s own scrollbar (or the gutter
 * kept for it): past its content box on the right or below. `rect` is its bounding box.
 */
export function onScrollbar(
  x: number,
  y: number,
  rect: { left: number; top: number },
  el: { clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number },
): boolean {
  return x - rect.left - el.clientLeft >= el.clientWidth || y - rect.top - el.clientTop >= el.clientHeight;
}
