/**
 * A menu-bar item's click and its accelerator key both arrive as the same `menu` event. ⌘ itself
 * still reaches the page, so watching it tells them apart: a key hands the press back to whatever
 * has the keyboard (the editor, a terminal), a click runs the command.
 */
import { menuByKey } from "./menus";

let cmdHeld = false;
let lastCmdDown = 0;
let watching = false;

/**
 * Watches ⌘ in `win`: the app's window, or a frame's (SandboxFrame's preview), whose keys fire in
 * its own document and never reach the app's listeners. Returns the way to stop.
 */
function watchIn(win: Window): () => void {
  const down = (ev: KeyboardEvent) => {
    // our own handed-back keydowns don't count
    if (!ev.isTrusted || !(ev.metaKey || ev.ctrlKey)) return;
    cmdHeld = true;
    lastCmdDown = performance.now();
  };
  const up = (ev: KeyboardEvent) => {
    if (ev.key === "Meta" || ev.key === "Control" || !(ev.metaKey || ev.ctrlKey)) cmdHeld = false;
  };
  const blur = () => (cmdHeld = false);
  const pointer = (ev: PointerEvent) => ev.metaKey || ev.ctrlKey || (cmdHeld = false);
  win.addEventListener("keydown", down, true);
  win.addEventListener("keyup", up, true);
  win.addEventListener("blur", blur);
  win.addEventListener("pointerdown", pointer, true);
  return () => {
    win.removeEventListener("keydown", down, true);
    win.removeEventListener("keyup", up, true);
    win.removeEventListener("blur", blur);
    win.removeEventListener("pointerdown", pointer, true);
  };
}

function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  watchIn(window);
}

/** Starts watching ⌘ (once); call it early, before the first `menu` event can arrive. */
export function watchMenuKeys(): void {
  watch();
}

/**
 * Watches ⌘ inside a frame that can take the keyboard (SandboxFrame), so an accelerator pressed
 * there still counts as the key, not as a click that would run the command behind the preview.
 */
export function watchMenuKeysIn(win: Window): () => void {
  watch();
  return watchIn(win);
}

/** True when the `menu` event arriving now came from its accelerator key, false for a click. */
export function menuFromKey(): boolean {
  watch();
  return menuByKey(cmdHeld, lastCmdDown, performance.now());
}
