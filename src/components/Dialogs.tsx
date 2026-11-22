import { useEffect, useRef, useState, type ReactNode } from "react";
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
        {icon}
        <div className="modal-head">
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
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const dot = initial.lastIndexOf(".");
    input.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
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
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </label>
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
      onClick: () => void;
    }
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
  const [pos, setPos] = useState({ x, y, maxH: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // focus goes back to where it was unless the menu closed because something else was clicked
  const restore = useRef(true);
  const typed = useRef({ text: "", at: 0 });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const maxH = window.innerHeight - 16;
      const h = Math.min(r.height, maxH);
      setPos({
        x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
        // open upwards when there is no room below
        y: Math.max(8, y + h > window.innerHeight - 8 ? Math.max(8, Math.min(y - h, window.innerHeight - h - 8)) : y),
        maxH,
      });
    }
  }, [x, y]);

  useEffect(() => {
    const prev = document.activeElement;
    const first = ref.current?.querySelector<HTMLElement>(".ctx-item:not(:disabled)");
    (first ?? ref.current)?.focus({ preventScroll: true });
    const away = () => {
      restore.current = false;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("blur", away);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", away, { passive: true });
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("blur", away);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", away);
      window.removeEventListener("resize", away);
      if (restore.current) restoreFocus(prev, modalStack.length === 0);
    };
  }, []);

  const move = (e: React.KeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".ctx-item:not(:disabled)") ?? [])];
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
    else if (e.key === "Home" || e.key === "PageUp") next = 0;
    else if (e.key === "End" || e.key === "PageDown") next = list.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      closeRef.current();
      return;
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
      // type-ahead: jump to the next item starting with what was typed
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const q = typed.current.text;
      const order = [...list.slice(i + (q.length === 1 ? 1 : 0)), ...list.slice(0, i + (q.length === 1 ? 1 : 0))];
      const hit = order.find((b) => (b.dataset.label ?? "").toLowerCase().startsWith(q));
      if (hit) next = list.indexOf(hit);
    } else return;
    e.preventDefault();
    if (next >= 0) list[next].focus();
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, maxHeight: pos.maxH || undefined }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={move}
    >
      {items.map((it, i) =>
        it.type === "sep" ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : it.type === "label" ? (
          <div key={i} className="ctx-heading" role="presentation">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            className={`ctx-item ${it.danger ? "danger" : ""}`}
            role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={it.checked === undefined ? undefined : it.checked}
            aria-keyshortcuts={it.hint || undefined}
            data-label={it.label}
            disabled={it.disabled}
            onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.checked !== undefined ? (
              <span className="ctx-check">{it.checked && <Icon name="check" size={14} />}</span>
            ) : it.icon ? (
              <Icon name={it.icon} size={15} />
            ) : (
              <span style={{ width: 15 }} />
            )}
            <span className="ctx-label">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ),
      )}
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
