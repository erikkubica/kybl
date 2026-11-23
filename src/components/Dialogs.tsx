import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { errDetail, errSummary } from "../api";
import { Icon, type IconName } from "../Icons";

/** Elements Tab can reach inside a dialog or menu. */
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])';

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

/** On touch screens a focused text field pops the keyboard up, so dialogs don't focus one by themselves. */
const coarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;

/**
 * Puts focus back where it was before a dialog or menu opened. When that element is gone (the row
 * was deleted or renamed), the file list gets it instead, so the arrow keys keep working.
 */
function restoreFocus(prev: Element | null, fallback = true) {
  const target =
    prev instanceof HTMLElement && prev.isConnected && prev !== document.body
      ? prev
      : fallback
        ? // with two browser panes, the active one's list
          (document.querySelector<HTMLElement>("[data-active-pane] [data-list-focus]") ?? document.querySelector<HTMLElement>("[data-list-focus]"))
        : null;
  target?.focus({ preventScroll: true });
}

/** Open dialogs, oldest first: only the topmost one answers Escape and traps Tab. */
const modalStack: symbol[] = [];

export function Modal({
  title,
  onClose,
  children,
  width = 440,
  icon,
  dismissOnBackdrop = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** optional leading icon block (e.g. the red trash for destructive confirms) */
  icon?: ReactNode;
  /**
   * Close when the dimmed area around the dialog is clicked. Off by default, so a stray click
   * never throws away a half-filled form; Escape and the close button always work.
   */
  dismissOnBackdrop?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // what had focus before: read while rendering, before a child's autoFocus moves it
  const [prev] = useState(() => document.activeElement);

  useEffect(() => {
    const id = Symbol(title);
    modalStack.push(id);
    const el = box.current;
    // First focus: whatever the content focused itself (autoFocus), else the button it marks as
    // the default (data-autofocus), else the first field, else the main button, else the dialog
    // itself so screen readers start at its title.
    const preferred = el?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)");
    if (el && preferred && !el.contains(document.activeElement)) preferred.focus({ preventScroll: true });
    else if (el && !el.contains(document.activeElement)) {
      const field = coarse() ? null : el.querySelector<HTMLElement>('input:not(:disabled):not([type="hidden"]):not([type="checkbox"]), select:not(:disabled), textarea:not(:disabled)');
      const primary = el.querySelector<HTMLElement>(".btn-primary:not(:disabled), .btn-danger:not(:disabled)");
      (field && visible(field) ? field : primary && !coarse() ? primary : el).focus({ preventScroll: true });
    }
    const top = () => modalStack[modalStack.length - 1] === id;
    const onKey = (e: KeyboardEvent) => {
      if (!top() || !box.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab") {
        // keep Tab inside the dialog, also when focus somehow ended up behind it
        const items = focusables(box.current);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !box.current.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && (active === first || active === box.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = modalStack.indexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      // back to what had focus; the file list only when no other dialog is still open
      restoreFocus(prev, modalStack.length === 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={`modal ${icon ? "compact" : ""}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {/* an icon sits in the title row; the text below lines up with the title (as a macOS alert) */}
        <div className="modal-head">
          {icon}
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={420}
      // nothing typed here to lose, so a click outside may cancel
      dismissOnBackdrop
      icon={
        danger ? (
          <div className="confirm-icon">
            <Icon name="trash" size={19} />
          </div>
        ) : undefined
      }
    >
      <div className="modal-body">{message}</div>
      <div className="modal-foot">
        {/* a destructive confirm starts on Cancel, so Return twice never deletes or overwrites */}
        <button className="btn" onClick={onClose} autoFocus={!!danger} data-autofocus={danger ? "" : undefined}>
          Cancel
        </button>
        <button
          className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
          autoFocus={!danger}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function PromptDialog({
  title,
  label,
  initial,
  confirmLabel,
  note,
  check,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  /** a caution under the field (renaming a folder that is copied file by file, say) */
  note?: string;
  /** what's wrong with a value, shown under the field (the dialog stays open); null when fine */
  check?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const dot = initial.lastIndexOf(".");
    input.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    const bad = check?.(v) ?? null;
    if (bad) {
      setProblem(bad);
      input.current?.focus();
      return;
    }
    onSubmit(v);
    onClose();
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="modal-body">
          <label className="field">
            <span>{label}</span>
            <input
              ref={input}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setProblem(null);
              }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              aria-invalid={!!problem}
            />
          </label>
          {problem && <p className="hint error">{problem}</p>}
          {note && (
            <p className="hint warn prompt-note">
              <Icon name="info" size={13} />
              <span>{note}</span>
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export type MenuItem =
  | {
      type: "item";
      label: string;
      icon?: IconName;
      /** keyboard shortcut shown on the right, e.g. "⌘R" */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      /** a toggle (shown with a tick); the menu stays a plain menu otherwise */
      checked?: boolean;
      /** a picture instead of the icon, such as an app's own icon (a data URL) */
      image?: string;
      onClick: () => void;
    }
  /**
   * A row that opens a submenu (hover, → or Enter). `items` runs when it opens and may return a
   * promise: the submenu says "Loading…" until it settles.
   */
  | { type: "submenu"; label: string; icon?: IconName; disabled?: boolean; items: () => MenuItem[] | Promise<MenuItem[]> }
  | { type: "sep" }
  /** a small grey heading above a group of items */
  | { type: "label"; label: string };

/** Shift+F10 and the context-menu key open the app's menu, like a right-click. */
export function isMenuKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
}

/** Where a keyboard-opened context menu goes: just under the start of `el` (a row or tile). */
export function menuPointFor(el: Element | null): { x: number; y: number } {
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(40, r.width / 4)), y: Math.round(Math.min(r.bottom, r.top + 28)) };
}

const TYPE_AHEAD_MS = 600;
/** Hovering a submenu item this long opens it; leaving it for another item closes it after the longer wait, so a diagonal move into the submenu doesn't lose it. */
const SUB_OPEN_MS = 120;
const SUB_CLOSE_MS = 280;

type TypeAhead = { text: string; at: number };

/**
 * Arrow keys, Home/End and type-ahead inside one menu panel. True when it handled the key.
 */
function navigate(e: React.KeyboardEvent, panel: HTMLElement | null, typed: { current: TypeAhead }): boolean {
  const list = [...(panel?.querySelectorAll<HTMLButtonElement>(".ctx-item:not(:disabled)") ?? [])];
  if (list.length === 0) return false;
  const i = list.indexOf(document.activeElement as HTMLButtonElement);
  let next = -1;
  if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % list.length;
  else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
  else if (e.key === "Home" || e.key === "PageUp") next = 0;
  else if (e.key === "End" || e.key === "PageDown") next = list.length - 1;
  else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
    // type-ahead: jump to the next item starting with what was typed
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + e.key.toLowerCase(), at: now };
    const q = typed.current.text;
    const order = [...list.slice(i + (q.length === 1 ? 1 : 0)), ...list.slice(0, i + (q.length === 1 ? 1 : 0))];
    const hit = order.find((b) => (b.dataset.label ?? "").toLowerCase().startsWith(q));
    if (hit) next = list.indexOf(hit);
  } else return false;
  e.preventDefault();
  if (next >= 0) list[next].focus();
  return true;
}

const focusFirst = (panel: HTMLElement | null) => panel?.querySelector<HTMLElement>(".ctx-item:not(:disabled)")?.focus({ preventScroll: true });

/** The leading icon of an item: a tick for toggles, an app's own picture, or one of ours. */
function ItemIcon({ it }: { it: Extract<MenuItem, { type: "item" | "submenu" }> }) {
  if (it.type === "item" && it.checked !== undefined) return <span className="ctx-check">{it.checked && <Icon name="check" size={14} />}</span>;
  if (it.type === "item" && it.image) return <img className="ctx-img" src={it.image} alt="" width={16} height={16} draggable={false} />;
  return it.icon ? <Icon name={it.icon} size={15} /> : <span style={{ width: 15 }} />;
}

/** A menu with more rows than this gets a find field at its top (connections, groups, buckets). */
const FIND_AT = 12;
const rowCount = (items: MenuItem[]) => items.filter((it) => it.type === "item" || it.type === "submenu").length;

/** The rows to draw, with their places in `items`: all of them, or with `q`, the rows whose label has every word of it. */
function findRows(items: MenuItem[], q: string): { it: MenuItem; i: number }[] {
  const all = items.map((it, i) => ({ it, i }));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  return all.filter(({ it }) => (it.type === "item" || it.type === "submenu") && words.every((w) => it.label.toLowerCase().includes(w)));
}

/**
 * The find field at a long menu's top: typing filters the rows, ↓ goes into them, Enter picks the
 * first, Esc clears it (and closes the menu when it's empty).
 */
function MenuFind({ value, onChange, panel }: { value: string; onChange: (v: string) => void; panel: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="ctx-find" role="presentation">
      <Icon name="search" size={13} />
      <input
        className="ctx-find-input"
        value={value}
        placeholder="Find"
        aria-label="Find in this menu"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            focusFirst(panel.current);
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            panel.current?.querySelector<HTMLButtonElement>(".ctx-item:not(:disabled)")?.click();
          } else if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          } else if (e.key !== "Tab") e.stopPropagation();
        }}
      />
    </div>
  );
}

/** A printable key pressed on a menu row with a find field: it goes to the field instead. */
const toFind = (e: React.KeyboardEvent, panel: HTMLElement | null) => {
  const input = panel?.querySelector<HTMLInputElement>(".ctx-find-input");
  if (!input || e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === " ") return false;
  input.focus({ preventScroll: true });
  return true;
};

/** Whether a menu panel has more above or below what shows. */
function useScrollEdges(panel: React.RefObject<HTMLDivElement | null>, dep: unknown) {
  const [edge, setEdge] = useState({ up: false, down: false });
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const update = () => {
      const up = el.scrollTop > 1;
      const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdge((e) => (e.up === up && e.down === down ? e : { up, down }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [panel, dep]);
  return edge;
}

/**
 * The arrow at a long menu's top or bottom edge, as in the system's menus: it says there is more,
 * and resting the pointer on it scrolls that way (the wheel and the keyboard scroll too).
 */
function ScrollArrow({ panel, dir }: { panel: React.RefObject<HTMLDivElement | null>; dir: "up" | "down" }) {
  const frame = useRef(0);
  const stop = () => cancelAnimationFrame(frame.current);
  useEffect(() => stop, []);
  const start = () => {
    stop();
    const tick = () => {
      const el = panel.current;
      if (!el) return;
      el.scrollTop += dir === "up" ? -7 : 7;
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  return (
    <div className={`ctx-scroll ${dir}`} aria-hidden onMouseEnter={start} onMouseLeave={stop}>
      <Icon name="chevron-down" size={12} />
    </div>
  );
}

/** One panel's plain items, separators and headings (submenu rows are drawn by the caller). */
function PlainRow({ it, onClose, onHover }: { it: Exclude<MenuItem, { type: "submenu" }>; onClose: () => void; onHover?: () => void }) {
  if (it.type === "sep") return <div className="ctx-sep" role="separator" />;
  if (it.type === "label")
    return (
      <div className="ctx-heading" role="presentation">
        {it.label}
      </div>
    );
  return (
    <button
      className={`ctx-item ${it.danger ? "danger" : ""}`}
      role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={it.checked === undefined ? undefined : it.checked}
      aria-keyshortcuts={it.hint || undefined}
      data-label={it.label}
      disabled={it.disabled}
      onMouseEnter={(e) => {
        e.currentTarget.focus({ preventScroll: true });
        onHover?.();
      }}
      onClick={() => {
        onClose();
        it.onClick();
      }}
    >
      <ItemIcon it={it} />
      <span className="ctx-label">{it.label}</span>
      {it.hint && <span className="ctx-hint">{it.hint}</span>}
    </button>
  );
}

type SubState = { index: number; anchor: DOMRect; items: MenuItem[] | null; focus: boolean };

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  label = "Actions",
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** read out by screen readers when the menu opens */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, maxH: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // focus goes back to where it was unless the menu closed because something else was clicked
  const restore = useRef(true);
  const typed = useRef<TypeAhead>({ text: "", at: 0 });
  const [sub, setSub] = useState<SubState | null>(null);
  const subNow = useRef<SubState | null>(null);
  subNow.current = sub;
  // a submenu whose items are still loading when another one opens must not replace it
  const subSeq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const clearTimer = () => window.clearTimeout(timer.current);
  const finds = rowCount(items) > FIND_AT;
  const [q, setQ] = useState("");
  const rows = findRows(items, q);
  const edge = useScrollEdges(ref, `${pos.x},${pos.y},${pos.maxH},${rows.length}`);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const maxH = window.innerHeight - 24;
      const h = Math.min(r.height, maxH);
      setPos({
        x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
        // open upwards when there is no room below
        y: Math.max(8, y + h > window.innerHeight - 8 ? Math.max(8, Math.min(y - h, window.innerHeight - h - 8)) : y),
        maxH,
      });
    }
  }, [x, y]);

  /** Closes the submenu; `refocus` puts focus back on the row that opened it. */
  const closeSub = (refocus: boolean) => {
    clearTimer();
    const s = subNow.current;
    if (!s) return;
    subSeq.current++;
    setSub(null);
    if (refocus) ref.current?.querySelector<HTMLElement>(`[data-index="${s.index}"]`)?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const prev = document.activeElement;
    const first = ref.current?.querySelector<HTMLElement>(".ctx-find-input, .ctx-item:not(:disabled)");
    (first ?? ref.current)?.focus({ preventScroll: true });
    const inside = (t: EventTarget | null) => t instanceof Node && (!!ref.current?.contains(t) || !!subRef.current?.contains(t));
    const away = () => {
      restore.current = false;
      closeRef.current();
    };
    // caught on the way down: a window drag strip (the toolbar's empty space) stops the event
    // before it would bubble here, and the menu stayed open
    const downAway = (e: MouseEvent) => {
      if (inside(e.target)) return;
      away();
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLInputElement | null;
      if (e.key === "Escape" && t?.classList?.contains("ctx-find-input") && t.value) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // a submenu closes first, like the system's menus
        if (subNow.current) closeSub(true);
        else closeRef.current();
      }
    };
    // a long submenu (many apps) scrolls; anywhere else the page moved under the menu
    const wheelAway = (e: WheelEvent) => {
      if (!inside(e.target)) away();
    };
    window.addEventListener("mousedown", downAway, true);
    window.addEventListener("blur", away);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", wheelAway, { passive: true });
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("mousedown", downAway, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", wheelAway);
      window.removeEventListener("resize", away);
      window.clearTimeout(timer.current);
      if (restore.current) restoreFocus(prev, modalStack.length === 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Opens the submenu of row `i` (its items may come later); `focus` moves the keyboard into it. */
  const openSub = (i: number, el: HTMLElement, focus: boolean) => {
    clearTimer();
    const it = items[i];
    if (it?.type !== "submenu" || it.disabled) return;
    const s = subNow.current;
    if (s?.index === i) {
      if (focus) {
        if (s.items) focusFirst(subRef.current);
        else setSub({ ...s, focus: true });
      }
      return;
    }
    const seq = ++subSeq.current;
    const anchor = el.getBoundingClientRect();
    let got: MenuItem[] | Promise<MenuItem[]>;
    try {
      got = it.items();
    } catch {
      got = [];
    }
    if (Array.isArray(got)) return setSub({ index: i, anchor, items: got, focus });
    setSub({ index: i, anchor, items: null, focus });
    const done = (list: MenuItem[]) => {
      if (subSeq.current === seq) setSub((cur) => (cur && cur.index === i ? { ...cur, items: list } : cur));
    };
    got.then(done, () => done([]));
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      closeRef.current();
      return;
    }
    const el = document.activeElement as HTMLElement | null;
    if (e.key === "ArrowRight" && el?.dataset.submenu && el.dataset.index) {
      e.preventDefault();
      openSub(Number(el.dataset.index), el, true);
      return;
    }
    if (finds && toFind(e, ref.current)) {
      if (subNow.current) closeSub(false);
      return;
    }
    if (navigate(e, ref.current, typed) && subNow.current) closeSub(false);
  };

  return (
    <>
      <div
        ref={ref}
        className="ctx-menu"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y, maxHeight: pos.maxH || undefined }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={keys}
      >
        {finds && <MenuFind value={q} onChange={(v) => (setQ(v), subNow.current && closeSub(false))} panel={ref} />}
        {edge.up && <ScrollArrow panel={ref} dir="up" />}
        {finds && q && !rows.length && (
          <div className="ctx-heading" role="presentation">
            Nothing matches
          </div>
        )}
        {rows.map(({ it, i }) =>
          it.type === "submenu" ? (
            <button
              key={i}
              className={`ctx-item ${sub?.index === i ? "open" : ""}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={sub?.index === i}
              data-label={it.label}
              data-index={i}
              data-submenu="1"
              disabled={it.disabled}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.focus({ preventScroll: true });
                if (sub?.index === i) return clearTimer();
                clearTimer();
                timer.current = window.setTimeout(() => openSub(i, el, false), SUB_OPEN_MS);
              }}
              onClick={(e) => openSub(i, e.currentTarget, true)}
            >
              <ItemIcon it={it} />
              <span className="ctx-label">{it.label}</span>
              <Icon name="chevron" size={13} className="ctx-more" />
            </button>
          ) : (
            <PlainRow
              key={i}
              it={it}
              onClose={onClose}
              onHover={() => {
                clearTimer();
                if (subNow.current) timer.current = window.setTimeout(() => closeSub(false), SUB_CLOSE_MS);
              }}
            />
          ),
        )}
        {edge.down && <ScrollArrow panel={ref} dir="down" />}
      </div>
      {sub && (
        <SubPanel
          key={sub.index}
          panelRef={subRef}
          sub={sub}
          onClose={onClose}
          onBack={() => closeSub(true)}
          onEnter={clearTimer}
          typed={typed}
        />
      )}
    </>
  );
}

/** A submenu: next to its row (or to the left when there is no room), scrolling when long. */
function SubPanel({
  panelRef,
  sub,
  onClose,
  onBack,
  onEnter,
  typed,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  sub: SubState;
  onClose: () => void;
  /** ← or Escape: back to the row that opened it */
  onBack: () => void;
  onEnter: () => void;
  typed: { current: TypeAhead };
}) {
  const [pos, setPos] = useState<{ x: number; y: number; maxH: number } | null>(null);
  const { anchor, items, focus } = sub;
  const finds = !!items && rowCount(items) > FIND_AT;
  const [q, setQ] = useState("");
  const rows = items ? findRows(items, q) : [];
  const edge = useScrollEdges(panelRef, `${pos?.x},${pos?.y},${pos?.maxH},${rows.length}`);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxH = window.innerHeight - 24;
    const h = Math.min(r.height, maxH);
    // the first row lines up with the row that opened it (5px padding + 1px border)
    let left = anchor.right + 4;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, anchor.left - r.width - 4);
    const top = Math.max(8, Math.min(anchor.top - 6, window.innerHeight - h - 8));
    setPos({ x: left, y: top, maxH });
  }, [anchor, items, panelRef]);

  useEffect(() => {
    // opened from the keyboard: keys go to the submenu even while its items load
    if (!focus) return;
    if (items) {
      const find = panelRef.current?.querySelector<HTMLElement>(".ctx-find-input");
      if (find) find.focus({ preventScroll: true });
      else focusFirst(panelRef.current);
    }
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus({ preventScroll: true });
  }, [focus, items, panelRef]);

  return (
    <div
      ref={panelRef}
      className="ctx-menu ctx-sub"
      role="menu"
      tabIndex={-1}
      // unplaced for one layout pass: transparent, not hidden, so it can take focus already
      style={pos ? { left: pos.x, top: pos.y, maxHeight: pos.maxH } : { left: anchor.right, top: anchor.top, opacity: 0 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={onEnter}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onBack();
        } else if (e.key === "Tab") {
          e.preventDefault();
          onClose();
        } else if (!(finds && toFind(e, panelRef.current))) navigate(e, panelRef.current, typed);
      }}
    >
      {finds && <MenuFind value={q} onChange={setQ} panel={panelRef} />}
      {edge.up && <ScrollArrow panel={panelRef} dir="up" />}
      {items === null ? (
        <div className="ctx-heading ctx-loading" role="presentation">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="ctx-heading" role="presentation">
          {q ? "Nothing matches" : "Nothing to show"}
        </div>
      ) : (
        // one level deep: a submenu inside a submenu isn't drawn
        rows.map(({ it, i }) => (it.type === "submenu" ? null : <PlainRow key={i} it={it} onClose={onClose} />))
      )}
      {edge.down && <ScrollArrow panel={panelRef} dir="down" />}
    </div>
  );
}

/**
 * A short message. With `action`, the toast shows a button (Undo, Retry, Show…) that runs it and
 * dismisses the toast; callers should keep such toasts up longer (about 8 s).
 */
export type Toast = {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
  action?: { label: string; run: () => void };
};

/**
 * How long a toast stays when nobody touches it. Errors stay longer, and no toast leaves while
 * the pointer or keyboard focus is on it, so there is time to read the details. The toasts
 * dismiss themselves after this; a caller's own shorter timer still wins.
 */
const TOAST_MS = { info: 3200, success: 3200, error: 12000, action: 8000 };

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast: t, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  const [open, setOpen] = useState(false);
  const detail = errDetail(t.text);
  const ms = t.action ? Math.max(TOAST_MS.action, TOAST_MS[t.kind]) : TOAST_MS[t.kind];
  const left = useRef(ms);
  // callers pass a fresh dismiss on every render; the timer must not restart because of that
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (held || open) return;
    const start = Date.now();
    const timer = setTimeout(() => dismissRef.current(t.id), left.current);
    return () => {
      clearTimeout(timer);
      // after hovering or reading the details, leave a moment before it goes
      left.current = Math.max(2000, left.current - (Date.now() - start));
    };
  }, [held, open, t.id]);

  return (
    <div
      className={`toast toast-${t.kind} ${open ? "open" : ""}`}
      role={t.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHeld(false)}
      onClick={(e) => {
        // a click on the text dismisses; buttons and the details don't
        if ((e.target as HTMLElement).closest("button, pre")) return;
        dismiss(t.id);
      }}
    >
      <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check-circle" : "info"} size={16} />
      <div className="toast-body">
        <span>{errSummary(t.text)}</span>
        {detail && open && <pre className="toast-detail selectable">{detail}</pre>}
      </div>
      {detail && (
        <button type="button" className="toast-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Details"}
        </button>
      )}
      {t.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            dismiss(t.id);
            t.action!.run();
          }}
        >
          {t.action.label}
        </button>
      )}
      {(t.kind === "error" || t.action || detail) && (
        <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss" title="Dismiss">
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}
