/**
 * Keyboard shortcuts, menu-bar items (the native `menu` event), the mouse's back/forward buttons
 * and the window coming back to the front. Shortcuts and menu items name the same command ids
 * (see `NativeEvent` in api.ts), and both go through `route`, which refuses to act behind an
 * open dialog, menu or preview.
 */
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { MENU_ACCELERATORS, MENU_OWNS_SHORTCUTS } from "./menus";

export type ShortcutOptions = {
  /** runs a command by id; false when it didn't (a dialog is up, or it doesn't apply) */
  route: (id: string) => boolean;
  overlayUp: () => boolean;
  settingsOpen: boolean;
  closeSettings: () => void;
  hasSelection: boolean;
  /** a list is on screen that arrow keys can move in */
  listShown: boolean;
  moveSelection: (delta: number, shift: boolean) => void;
  /** the window came back to the front (`app-resumed`) */
  onResume: () => void;
  /** where the active list lives (with two panes, the active pane); default the whole page */
  listScope?: () => ParentNode | null;
  /** two panes on screen: the commander keys (Tab, F3, F5–F8) work */
  dual?: boolean;
  /** something owns the keyboard (the full-window editor): no shortcut runs */
  muted?: () => boolean;
};

export function useShortcuts(opts: ShortcutOptions) {
  const o = useRef(opts);
  o.current = opts;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.isComposing) return;
      const { route, overlayUp, settingsOpen, closeSettings, hasSelection, listShown, moveSelection } = o.current;
      const t = ev.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      const onControl = !!t.closest?.("button, a[href], [role=button], [role=menuitem], [role=tab], [role=switch]");
      const mod = ev.metaKey || ev.ctrlKey;
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      const textSelected = !!window.getSelection()?.toString();
      // keys with a menu-bar accelerator on macOS are handled there (the `menu` event)
      const own = (id: string) => (MENU_OWNS_SHORTCUTS && id in MENU_ACCELERATORS ? null : id);
      let id: string | null = null;
      // the full-window editor owns the keyboard (⌘S, ⌘F, Esc, arrows); only keep the webview
      // from reloading or opening its own location bar
      if (o.current.muted?.()) {
        if (mod && (k === "r" || k === "l")) ev.preventDefault();
        return;
      }
      if (mod && k === ",") id = own("settings");
      else if (mod && ev.shiftKey && k === "n") id = own("new-folder");
      else if (mod && k === "u") id = own(ev.shiftKey ? "upload-folder" : "upload-files");
      else if (mod && ev.shiftKey && k === "d") id = own("download");
      else if (mod && k === "[") id = own("back");
      else if (mod && k === "]") id = own("forward");
      else if (mod && ev.shiftKey && k === "g") id = own("go-to");
      else if (mod && k === "i") id = own("get-info");
      else if (mod && k === "l") id = "go-to";
      else if (mod && k === "r") id = "refresh";
      else if (mod && k === "f") id = "search";
      else if (mod && k === "\\") id = own("toggle-dual");
      else if (mod && ev.shiftKey && k === "s") id = own("swap-panes");
      // by code: Option turns "s" into "ß"
      else if (mod && ev.altKey && ev.code === "KeyS") id = own("toggle-sidebar");
      else if (settingsOpen) {
        // a dialog open on top of settings handles its own Escape
        if (ev.key === "Escape" && !overlayUp()) closeSettings();
        return;
      } else if (typing) return;
      else if (mod && k === "a") id = "select-all";
      else if (ev.key === "Delete" || (mod && ev.key === "Backspace")) id = "delete";
      else if (mod && k === "c" && !textSelected) id = "copy";
      else if (mod && k === "x" && !textSelected) id = "cut";
      else if (mod && k === "v") id = "paste";
      else if (mod && k === "z" && !ev.shiftKey) id = "undo";
      else if (mod && k === "d" && !ev.shiftKey) id = own("duplicate");
      else if (mod && k === "o") id = "open";
      else if (mod && ev.key === "ArrowUp") id = "go-up";
      else if (mod && ev.key === "ArrowDown") id = "open";
      // Finder's "show hidden files" (by code: Shift turns "." into ">")
      else if (mod && ev.shiftKey && ev.code === "Period") id = own("toggle-hidden");
      else if (mod) return;
      else if (ev.key === "Tab" && o.current.dual && !ev.altKey && t.closest?.("[data-list-focus]")) id = "switch-pane";
      else if (o.current.dual && /^F[35678]$/.test(ev.key))
        id = { F3: "quick-look", F5: "pane-copy", F6: "pane-move", F7: "new-folder", F8: "delete" }[ev.key] ?? null;
      else if (ev.key === "Backspace") id = "go-up";
      else if (ev.key === "F2") id = "rename";
      else if (onControl && (ev.key === "Enter" || ev.key === " ")) return;
      else if (ev.key === "Enter") id = hasSelection ? "open" : null;
      else if (ev.key === " ") id = hasSelection ? "quick-look" : null;
      else if (ev.key === "Escape") id = "deselect";
      else if (ev.key.startsWith("Arrow") && (document.activeElement === document.body || !document.activeElement) && listShown && !overlayUp()) {
        // nothing focused (after a sidebar click or a closed dialog): arrows still move in the list
        const list = (o.current.listScope?.() ?? document).querySelector<HTMLElement>(".table, .grid-scroll");
        const grid = list?.classList.contains("grid-scroll");
        const tiles = grid ? list!.querySelector(".grid") : null;
        const cols = tiles ? getComputedStyle(tiles).gridTemplateColumns.split(" ").length || 1 : 1;
        const delta = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: grid ? 1 : 0, ArrowLeft: grid ? -1 : 0 }[ev.key] ?? 0;
        if (delta) {
          ev.preventDefault();
          moveSelection(delta, ev.shiftKey);
          list?.focus();
        }
        return;
      }
      if (!id) return;
      // ⌘R / ⌘F / ⌘L must never fall through to the webview (reload, find) even behind a dialog
      if (route(id) || mod) ev.preventDefault();
    };

    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      o.current.route(e.button === 3 ? "back" : "forward");
    };
    // WebKit's own menu (Reload, Inspect…) means nothing here; text fields and selected text keep theirs
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, [contenteditable=true]") || window.getSelection()?.toString()) return;
      e.preventDefault();
    };
    const offs = [listen<string>("menu", (e) => void o.current.route(String(e.payload))), listen("app-resumed", () => o.current.onResume())];
    // A clicked button doesn't take the keyboard (as in Finder): focus stays on the list, so Space
    // and Enter go on acting on the selected file instead of pressing that button again. Dialogs
    // and menus keep ordinary focus (their buttons are part of a keyboard flow); Tab still reaches
    // every button.
    const onMouseDown = (ev: MouseEvent) => {
      const t = ev.target as Element | null;
      const b = t?.closest?.("button, [role=button]");
      if (!b || b.closest('[role=dialog], [role=menu], [aria-modal="true"]')) return;
      ev.preventDefault();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      for (const off of offs) off.then((f) => f()).catch(() => {});
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);
}
