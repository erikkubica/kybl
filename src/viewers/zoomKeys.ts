/**
 * The image viewer's zoom keys: ⌘/Ctrl with + (or =), − and 0. On macOS ⌘+ / ⌘− are menu-bar
 * accelerators; while a viewer has the keyboard the menu hands them back as these keydowns.
 */
export type ZoomKey = "in" | "out" | "fit";

export function zoomKey(ev: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">): ZoomKey | null {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return null;
  if (ev.key === "=" || ev.key === "+" || ev.code === "NumpadAdd") return "in";
  if (ev.key === "-" || ev.key === "_" || ev.code === "NumpadSubtract") return "out";
  if (ev.key === "0" || ev.code === "Digit0" || ev.code === "Numpad0") return "fit";
  return null;
}
