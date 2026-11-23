/**
 * The workspace bar along the top of the window, right of the sidebar: a tab per workspace, "+"
 * for a new one, and in a window too small for every pane, the panes of the workspace on screen
 * (the pane switcher). It is the window's title bar too: any empty stretch of it drags the window
 * (`data-tauri-drag-region` works only on the element under the pointer, so each empty element
 * carries it).
 *
 * A tab: click (press) shows that workspace, double-click renames it in place (Return keeps,
 * Escape doesn't), the cog that shows on hover opens its settings, right-click its menu. Tabs drag
 * sideways to reorder; with the keyboard, ⌥⇧← / → moves the focused one. Too many to fit: the
 * strip scrolls (a mouse wheel scrolls it sideways too) and fades at the edges it hides.
 *
 * A tab is also a drop target for things dragged from the panes: see "dropping onto a tab" below
 * (files dragged there can rest on "+" too: `NEW_WS`).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../Icons";
import { isMenuKey } from "../components/Dialogs";
import type { PaneId } from "../browser/types";
import { colorValue } from "./workspaces";
import { k } from "../components/keys";

export type WorkspaceTab = { id: string; name: string; color: string | null; panes: number };

export type PaneSwitcher = {
  items: { id: PaneId; name: string }[];
  activeId: PaneId;
  onPick: (id: PaneId) => void;
};

export type WorkspaceBarProps = {
  tabs: WorkspaceTab[];
  activeId: string;
  /** the tab being renamed in place */
  editingId: string | null;
  /** the tab whose settings are open (its cog stays lit) */
  settingsId: string | null;
  onPick: (id: string) => void;
  /** "+" (`anchor`: the button, for a menu of recipes under it) */
  onNew: (anchor?: DOMRect) => void;
  onEdit: (id: string) => void;
  /** a rename ended: the new name, or null when it was cancelled */
  onEditEnd: (id: string, name: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void;
  /** the cog: the workspace's settings, under its tab */
  onSettings: (id: string, anchor: DOMRect) => void;
  onReorder: (from: number, to: number) => void;
  /** the window can't show every pane: pick the one to show */
  switcher: PaneSwitcher | null;
  /** something dragged is over a tab (TabDropTarget) */
  drop?: TabDropTarget | null;
};

// ---------------------------------------------------------------- dropping onto a tab
// Things dragged elsewhere in the window (a pane by its header, later files from a list) can be
// dropped onto a workspace's tab, and holding them over one for a moment opens that workspace
// ("spring-loading", as a folder does in Finder) so they can be dropped into its layout instead.
// The drag itself owns the pointer; these helpers only answer which tab is under it and time the
// spring, and the bar draws what `drop` says.

/** how long a drag rests on a tab before that workspace opens */
export const SPRING_MS = 500;

/**
 * A tab with something dragged over it: `ok` true when letting go there drops it into that
 * workspace, false when it can't take it (drawn refused), null when it only springs (no drop);
 * `spring` while the timer runs (the tab fills up to say it's about to open).
 */
export type TabDropTarget = { id: string; ok: boolean | null; spring: boolean };

/** `TabDropTarget.id` of "+" (new workspace), which a drag of files can rest on too */
export const NEW_WS = "+";

/** The workspace whose tab is under the point, if any (the ghost and overlays don't take the pointer). */
export function wsTabAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".ws-tab[data-ws]");
  return el?.dataset.ws ?? null;
}

/**
 * Spring-loading for a drag: call `over` with the tab under the pointer on every move (null when
 * none); resting on one tab for `delay` calls `open` with it, once. `cancel` when the drag ends.
 */
export function springLoader(open: (id: string) => void, delay = SPRING_MS) {
  let at: string | null = null;
  let timer = 0;
  return {
    over(id: string | null) {
      if (id === at) return;
      window.clearTimeout(timer);
      at = id;
      if (id)
        timer = window.setTimeout(() => {
          at = null;
          open(id);
        }, delay);
    },
    /** the tab whose timer is running */
    get pending() {
      return at;
    },
    cancel() {
      window.clearTimeout(timer);
      at = null;
    },
  };
}

/** past this the press is a drag, not a click */
const DRAG_START = 4;

type Drag = {
  id: string;
  from: number;
  to: number;
  startX: number;
  started: boolean;
  /** the tabs' places when the drag began */
  rects: DOMRect[];
  els: HTMLElement[];
  /** how far the others step aside: the dragged tab's width and the gap */
  step: number;
};

export function WorkspaceBar(p: WorkspaceBarProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ l: false, r: false });
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  /** after a drop: the dragged tab glides from where it was let go into its new place */
  const flip = useRef<{ id: string; left: number } | null>(null);

  // ---------------------------------------------------------------- scrolling
  const look = () => {
    const el = scroller.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.l === l && f.r === r ? f : { l, r }));
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(look);
    ro.observe(el);
    if (track.current) ro.observe(track.current);
    // a mouse wheel (up and down only) scrolls the strip sideways; a trackpad's sideways swipe already does
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);
  useLayoutEffect(look, [p.tabs]);

  // the workspace on screen is always in view
  useEffect(() => {
    const el = scroller.current;
    const tab = el?.querySelector<HTMLElement>(`[data-ws="${CSS.escape(p.activeId)}"]`);
    if (!el || !tab) return;
    const pad = 28;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    // (a hidden window runs no animations: there it jumps)
    const behavior = document.visibilityState === "visible" ? "smooth" : "auto";
    if (left < el.scrollLeft + pad) el.scrollTo({ left: Math.max(0, left - pad), behavior });
    else if (right > el.scrollLeft + el.clientWidth - pad) el.scrollTo({ left: right - el.clientWidth + pad, behavior });
    // (a rename or a reorder moves it too)
  }, [p.activeId, p.tabs.map((t) => `${t.id}:${t.name}`).join("|")]);

  // ---------------------------------------------------------------- dragging to reorder
  useLayoutEffect(() => {
    const f = flip.current;
    if (!f) return;
    flip.current = null;
    const el = track.current?.querySelector<HTMLElement>(`[data-ws="${CSS.escape(f.id)}"]`);
    if (!el) return;
    const dx = f.left - el.getBoundingClientRect().left;
    if (Math.abs(dx) < 1) return;
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
    void el.offsetWidth;
    el.style.transition = "transform 0.18s var(--ease)";
    el.style.transform = "";
    const done = () => {
      el.style.transition = "";
      el.removeEventListener("transitionend", done);
    };
    el.addEventListener("transitionend", done);
  });

  const press = (e: React.PointerEvent<HTMLElement>, i: number, id: string) => {
    if (e.button !== 0 || p.editingId === id) return;
    if ((e.target as Element).closest(".ws-cog")) return;
    p.onPick(id);
    const els = [...(track.current?.querySelectorAll<HTMLElement>(".ws-tab") ?? [])];
    // (a glide still settling from the last drop ends here)
    for (const x of els) x.style.transition = "";
    const rects = els.map((x) => x.getBoundingClientRect());
    const gap = rects.length > 1 ? rects[1].left - rects[0].right : 2;
    drag.current = { id, from: i, to: i, startX: e.clientX, started: false, rects, els, step: rects[i].width + gap };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // the button came up where we didn't hear it (a switch re-rendered the strip, the window lost
    // the pointer): that ends the drag, or a plain hover would keep moving the tab
    if ((e.buttons & 1) === 0) return release();
    const dx = e.clientX - d.startX;
    if (!d.started) {
      if (Math.abs(dx) < DRAG_START) return;
      d.started = true;
      setDragging(true);
    }
    // the dragged tab stays within the strip
    const first = d.rects[0];
    const last = d.rects[d.rects.length - 1];
    const r = d.rects[d.from];
    const x = Math.max(first.left - r.left, Math.min(last.right - r.right, dx));
    d.els[d.from].style.transform = `translateX(${x}px)`;
    // where it would land: past the middle of a neighbour, it takes that one's place
    const mid = r.left + r.width / 2 + x;
    let to = d.from;
    for (let j = d.from + 1; j < d.rects.length; j++) if (mid > d.rects[j].left + d.rects[j].width / 2) to = j;
    for (let j = d.from - 1; j >= 0; j--) if (mid < d.rects[j].left + d.rects[j].width / 2) to = j;
    d.to = to;
    d.els.forEach((el, k) => {
      if (k === d.from) return;
      const shift = d.from < k && k <= to ? -d.step : to <= k && k < d.from ? d.step : 0;
      el.style.transform = shift ? `translateX(${shift}px)` : "";
    });
  };
  const release = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.started) return;
    const left = d.els[d.from].isConnected ? d.els[d.from].getBoundingClientRect().left : null;
    // the others are where they stepped aside to; once the order changes that is their own place.
    // The tabs on screen now, too: a re-render may have put new elements in place of `d.els`.
    const all = new Set([...d.els, ...(track.current?.querySelectorAll<HTMLElement>(".ws-tab") ?? [])]);
    for (const el of all) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    void track.current?.offsetWidth;
    for (const el of all) el.style.transition = "";
    setDragging(false);
    if (left !== null) flip.current = { id: d.id, left };
    if (d.to !== d.from) p.onReorder(d.from, d.to);
  };

  // ---------------------------------------------------------------- keyboard
  const focusTab = (i: number) => track.current?.querySelectorAll<HTMLElement>(".ws-tab")[i]?.focus();
  const onKey = (e: React.KeyboardEvent, i: number, id: string) => {
    if (p.editingId === id) return;
    const n = p.tabs.length;
    if (e.altKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const to = i + (e.key === "ArrowLeft" ? -1 : 1);
      if (to >= 0 && to < n) {
        p.onReorder(i, to);
        requestAnimationFrame(() => focusTab(to));
      }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") focusTab((i + (e.key === "ArrowLeft" ? n - 1 : 1)) % n);
    else if (e.key === "Home") focusTab(0);
    else if (e.key === "End") focusTab(n - 1);
    else if (e.key === "Enter" || e.key === " ") p.onPick(id);
    else if (e.key === "F2") p.onEdit(id);
    else if (isMenuKey(e)) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      p.onMenu(id, r.left + 8, r.bottom + 4);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="ws-bar" data-tauri-drag-region>
      <div className={`ws-tabs ${fade.l ? "fade-l" : ""} ${fade.r ? "fade-r" : ""}`} ref={scroller} onScroll={look} data-tauri-drag-region>
        <div className={`ws-track ${dragging ? "dragging" : ""}`} ref={track} role="tablist" aria-label="Workspaces" data-tauri-drag-region>
          {p.tabs.map((t, i) => {
            const on = t.id === p.activeId;
            const color = colorValue(t.color);
            const drop = p.drop?.id === t.id ? p.drop : null;
            const dropCls = drop ? `drop-over ${drop.ok === false ? "drop-no" : drop.ok ? "drop-ok" : ""} ${drop.spring ? "springing" : ""}` : "";
            return (
              <div
                key={t.id}
                data-ws={t.id}
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                className={`ws-tab ${on ? "on" : ""} ${p.settingsId === t.id ? "set-open" : ""} ${dragging && drag.current?.id === t.id ? "lifted" : ""} ${dropCls}`}
                style={color ? ({ "--ws": color } as CSSProperties) : undefined}
                title={p.editingId === t.id ? undefined : `${t.name}${t.panes > 1 ? ` · ${t.panes} panes` : ""}`}
                // the list keeps the keyboard: a click on a tab doesn't take it
                onMouseDown={(e) => p.editingId !== t.id && e.preventDefault()}
                onPointerDown={(e) => press(e, i, t.id)}
                onPointerMove={move}
                onPointerUp={release}
                onPointerCancel={release}
                onLostPointerCapture={release}
                onDoubleClick={(e) => {
                  if (!(e.target as Element).closest(".ws-cog")) p.onEdit(t.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  p.onMenu(t.id, e.clientX, e.clientY);
                }}
                onKeyDown={(e) => onKey(e, i, t.id)}
              >
                {color && <span className="ws-dot" aria-hidden />}
                {p.editingId === t.id ? (
                  <RenameField name={t.name} onDone={(name) => p.onEditEnd(t.id, name)} />
                ) : (
                  <span className="ws-name">{t.name}</span>
                )}
                {p.editingId !== t.id && (
                  <button
                    type="button"
                    className="ws-cog"
                    tabIndex={-1}
                    aria-label={`Settings of ${t.name}`}
                    title="Workspace settings"
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onSettings(t.id, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect());
                    }}
                  >
                    <Icon name="settings" size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <button type="button" className={`icon-btn ws-new ${p.drop?.id === NEW_WS ? "drop-over springing" : ""}`} onClick={(e) => p.onNew(e.currentTarget.getBoundingClientRect())} title={k("New workspace (⌘T)")} aria-label="New workspace">
        <Icon name="plus" size={15} />
      </button>
      <div className="ws-fill" data-tauri-drag-region />
      {p.switcher && <PaneSwitcherView {...p.switcher} />}
    </div>
  );
}

/** The name of a tab being renamed: Return or leaving it keeps the name, Escape doesn't. */
function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (n: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(n);
  };
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="ws-rename"
      value={v}
      maxLength={80}
      size={Math.max(4, v.length + 1)}
      aria-label="Workspace name"
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(v);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(v)}
    />
  );
}

/**
 * A window too small for every pane of the workspace shows one at a time: the panes as a small
 * segmented control, numbered (two panes often show folders of the same name), the one on screen
 * with its folder's name.
 */
function PaneSwitcherView({ items, activeId, onPick }: PaneSwitcher) {
  return (
    <div
      className="ws-panes"
      role="tablist"
      aria-label="Panes"
      title={`The window is too small to show all ${items.length} panes side by side. Make it bigger, or close a pane.`}
    >
      <Icon name="dual-pane" size={13} />
      {items.map((it, i) => {
        const on = it.id === activeId;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`ws-pane ${on ? "on" : ""}`}
            title={`Pane ${i + 1}: ${it.name}`}
            aria-label={`Pane ${i + 1}: ${it.name}`}
            onClick={() => onPick(it.id)}
          >
            <span className="ws-pane-n">{i + 1}</span>
            {on && <span className="ws-pane-name">{it.name}</span>}
          </button>
        );
      })}
    </div>
  );
}
