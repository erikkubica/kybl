/**
 * The bell at the right end of the workspace bar: the toasts that didn't pop up (and the ones
 * that did), newest first, with a count of the unread. Opening it marks them read. A row's action
 * (Show, Undo…) runs and closes the list. Esc or a click elsewhere closes it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../ui/components/Icons";
import { ago } from "../../updates/updates";
import { actionLive, clearNotifications, markAllRead, useNotifications } from "../lib/notifications";
import { errSummary } from "../../core/api";

export function NotificationBell() {
  const list = useNotifications();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  const unread = list.filter((n) => !n.read);
  const hasError = unread.some((n) => n.kind === "error");

  const toggle = () => {
    if (!open) {
      const r = btn.current!.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    }
    setOpen(!open);
  };

  // an Undo expires while the list is open too
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  // what was unread is marked read as it opens (and while it stays open, as new ones arrive)
  useEffect(() => {
    if (open) markAllRead();
  }, [open, list]);

  // focus moves into the list; Esc and a click elsewhere close it and give the focus back
  useLayoutEffect(() => {
    if (open) box.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    const resize = () => setOpen(false);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="icon-btn ws-bell"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread.length ? `Notifications, ${unread.length} unread` : "Notifications"}
        title="Notifications"
        onClick={toggle}
      >
        <Icon name="bell" size={15} />
        {unread.length > 0 && <span className={`ws-bell-count ${hasError ? "err" : ""}`}>{unread.length > 99 ? "99+" : unread.length}</span>}
      </button>
      {open && (
        <div ref={box} className="ctx-menu notif-pop" role="dialog" aria-label="Notifications" tabIndex={-1} style={{ top: pos.top, right: pos.right }}>
          <div className="notif-head">
            <span>Notifications</span>
            {list.length > 0 && (
              <button type="button" className="notif-clear" onClick={() => {
                  clearNotifications();
                  // the button goes with the list: keep the keyboard in the popup, which stays open, not on the page
                  box.current?.focus();
                }}>
                Clear all
              </button>
            )}
          </div>
          {list.length === 0 ? (
            <div className="notif-empty">No notifications</div>
          ) : (
            <ul className="notif-list">
              {list.map((n) => (
                <li key={n.id} className={`notif-row notif-${n.kind}`}>
                  <Icon name={n.kind === "error" ? "alert" : n.kind === "success" ? "check-circle" : "info"} size={15} />
                  <div className="notif-body">
                    <span className="notif-text">{errSummary(n.text)}</span>
                    <span className="notif-time">{ago(n.at)}</span>
                  </div>
                  {actionLive(n) && n.action && (
                    <button
                      type="button"
                      className="toast-action"
                      onClick={() => {
                        setOpen(false);
                        n.action!.run();
                      }}
                    >
                      {n.action.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
