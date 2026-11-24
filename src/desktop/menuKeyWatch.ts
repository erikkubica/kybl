/**
 * A menu-bar item's click and its accelerator key both arrive as the same `menu` event. ⌘ itself
 * still reaches the page, so watching it tells them apart: a key hands the press back to whatever
 * has the keyboard (the editor, a terminal), a click runs the command.
 */
import { menuByKey } from "./menus";

let cmdHeld = false;
/** when ⌘ (or Ctrl) was last seen down: its keydowns and its release */
let lastCmd = 0;
let watching = false;

function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener(
    "keydown",
    (ev) => {
      // our own handed-back keydowns don't count
      if (!ev.isTrusted || !(ev.metaKey || ev.ctrlKey)) return;
      cmdHeld = true;
      lastCmd = performance.now();
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (ev) => {
      if (!cmdHeld) return;
      if (ev.key === "Meta" || ev.key === "Control" || !(ev.metaKey || ev.ctrlKey)) {
        cmdHeld = false;
        lastCmd = performance.now();
      }
    },
    true,
  );
  window.addEventListener("blur", () => (cmdHeld = false));
  window.addEventListener("pointerdown", (ev) => ev.metaKey || ev.ctrlKey || (cmdHeld = false), true);
}

/** Starts watching ⌘ (once); call it early, before the first `menu` event can arrive. */
export function watchMenuKeys(): void {
  watch();
}

/** True when the `menu` event arriving now came from its accelerator key, false for a click. */
export function menuFromKey(): boolean {
  watch();
  return menuByKey(cmdHeld, lastCmd, performance.now());
}
