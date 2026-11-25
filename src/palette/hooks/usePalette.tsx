/**
 * The command palette's host side, in the main bundle: ⌘K (Ctrl+K off the Mac) and the View
 * menu's "Command Palette…" open it from anywhere, text fields included, except inside an element
 * marked `data-own-keys` (a terminal), which keeps the key for itself. The palette's UI is its
 * own chunk, loaded on first use. Remembers the folders visited in the active pane for its
 * "Recent folders".
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Loc } from "../../browser/types";
import { notePlace } from "../lib/recent";
import { menuFromKey, watchMenuKeys } from "../../desktop/lib/menuKeyWatch";
import type { PaletteHost } from "../types";

/** the palette's chunk has arrived (until then, what is typed is kept for it) */
let loaded = false;
const CommandPalette = lazy(() =>
  import("../components/CommandPalette").then((m) => {
    loaded = true;
    return m;
  }),
);

/** the menu item's id (menu.rs, api.ts) */
export const PALETTE_MENU_ID = "command-palette";
const MAC = /Mac|iPhone|iPad/i.test(navigator.userAgent);

const ownsKeys = (el: Element | null) => !!el?.closest?.("[data-own-keys]");

export function usePalette({ host, blocked, here }: { host: () => PaletteHost; blocked: () => boolean; here: Loc | null }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const latest = useRef({ host, blocked });
  latest.current = { host, blocked };
  /** what had the keyboard before: it gets it back */
  const back = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (here) notePlace(here);
  }, [here?.profileId, here?.bucket, here?.prefix]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    setOpen(false);
    const el = back.current;
    back.current = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, []);
  const toggle = useCallback(() => {
    if (openRef.current) return close();
    if (latest.current.blocked()) return;
    back.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    early.current = "";
    setOpen(true);
  }, [close]);

  /** typed while the palette's chunk was still loading (the first ⌘K): handed to it as its query */
  const early = useRef("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openRef.current && !loaded && !e.metaKey && !e.ctrlKey && !e.isComposing) {
        if (e.key === "Escape") close();
        else if (e.key === "Backspace") early.current = early.current.slice(0, -1);
        else if (e.key.length === 1) early.current += e.key;
        // (moving or picking in the list behind it would act on files the palette is about to cover)
        else if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "PageUp", "PageDown", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.isComposing || e.altKey || e.shiftKey || !(MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
      if (e.code !== "KeyK" && e.key.toLowerCase() !== "k") return;
      if (ownsKeys(e.target as Element)) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    };
    // capture: before anything else, text fields included
    window.addEventListener("keydown", onKey, true);
    // the menu item (with its ⌘K accelerator, which the menu bar may take before the page sees
    // the key): inside a [data-own-keys] element the key is handed back to it as a keydown
    // (a click on the menu item opens the palette)
    watchMenuKeys();
    const un = listen<string>("menu", (e) => {
      if (e.payload !== PALETTE_MENU_ID) return;
      const el = document.activeElement;
      if (el && ownsKeys(el) && menuFromKey()) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: MAC, ctrlKey: !MAC, bubbles: true, cancelable: true }));
        return;
      }
      toggle();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      un.then((f) => f()).catch(() => {});
    };
  }, [toggle]);

  /** A pick: the palette closes (the keyboard goes back), then it runs. */
  const onPick = useCallback(
    (run: () => void | Promise<unknown>) => {
      const h = latest.current.host();
      close();
      const go = () => {
        try {
          const r = run();
          if (r instanceof Promise) r.catch((e) => latest.current.host().toast("error", String(e?.message ?? e)));
        } catch (e) {
          latest.current.host().toast("error", String((e as Error)?.message ?? e));
        }
      };
      if (h.settingsOpen) {
        h.closeSettings();
        window.setTimeout(go, 60);
      } else requestAnimationFrame(() => requestAnimationFrame(go));
    },
    [close],
  );

  const element = open ? (
    <Suspense fallback={null}>
      <CommandPalette host={host()} onPick={onPick} onClose={close} typedEarly={() => early.current} />
    </Suspense>
  ) : null;
  return { open, toggle, element };
}
