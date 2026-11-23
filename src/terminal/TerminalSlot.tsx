/**
 * A terminal pane on screen: a compact header like a file pane's (a terminal badge, the
 * connection › folder, ⋯ on the right; its empty part is the grip to drag the pane), and the
 * terminal itself, loaded with xterm.js as a chunk of its own the first time one shows.
 * `data-own-keys` keeps app-wide shortcuts that a shell needs (⌘K) out of it.
 */
import "./terminal.css";
import { lazy, Suspense, type CSSProperties } from "react";
import { Icon } from "../Icons";
import type { MenuItem } from "../components/Dialogs";
import type { PaneId } from "../browser/types";
import { terminalAction, type TermSpec } from "./api";

const TermView = lazy(() => import("./TermView"));

const MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
const K = (k: string) => (MAC ? `⌘${k}` : `Ctrl+Shift+${k}`);

export type TerminalSlotProps = {
  id: PaneId;
  spec: TermSpec;
  /** the connection's name, and the folder's path as shown */
  connName: string;
  path: string;
  active: boolean;
  dual: boolean;
  lifted?: boolean;
  style?: CSSProperties;
  onActivate: () => void;
  onGrip?: (e: React.PointerEvent<HTMLElement>) => void;
  onClose: () => void;
  /** ⌃` inside the terminal: back to the file pane */
  onToggle: () => void;
  /** it `cd`s wherever the file pane it opened from goes; `canFollow`: that pane is on screen */
  follow: boolean;
  canFollow: boolean;
  onFollow: () => void;
  /** why it didn't follow last time ("not following: busy"), or null */
  note: string | null;
  menu: (x: number, y: number, items: MenuItem[]) => void;
};

export function TerminalSlot(p: TerminalSlotProps) {
  const { spec } = p;
  const act = (a: Parameters<typeof terminalAction>[1]) => () => terminalAction(spec.sid, a);
  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    p.menu(r.left, r.bottom + 4, [
      { type: "item", label: "Clear", icon: "x", hint: K("K"), onClick: act("clear") },
      { type: "item", label: "Restart shell", icon: "refresh", onClick: act("restart") },
      { type: "sep" },
      { type: "item", label: "Follow the folder above", checked: p.follow, disabled: !p.canFollow && !p.follow, onClick: p.onFollow },
      { type: "sep" },
      { type: "item", label: "Copy", icon: "copy", hint: K("C"), onClick: act("copy") },
      { type: "item", label: "Paste", icon: "copy", hint: K("V"), onClick: act("paste") },
      { type: "sep" },
      { type: "item", label: "Bigger text", icon: "plus", hint: K("+"), onClick: act("font+") },
      { type: "item", label: "Smaller text", hint: K("−"), onClick: act("font-") },
      { type: "item", label: "Actual size", hint: K("0"), onClick: act("font0") },
      { type: "sep" },
      { type: "item", label: "Close terminal", icon: "x", hint: MAC ? "⌘W" : undefined, onClick: p.onClose },
    ]);
  };
  return (
    <section
      className={`browser-pane term-pane ${p.dual ? (p.active ? "is-active" : "is-inactive") : ""} ${p.lifted ? "lifted" : ""}`}
      data-pane={p.id}
      data-drop-pane=""
      data-own-keys=""
      data-active-pane={p.active ? "" : undefined}
      aria-label={`Terminal, ${p.connName} ${p.path}`}
      onMouseDownCapture={p.onActivate}
      onFocusCapture={p.onActivate}
      style={p.style}
    >
      <header
        className={`chrome ${p.onGrip ? "can-move" : ""}`}
        onPointerDown={
          p.onGrip &&
          ((e) => {
            const t = e.target as Element;
            if (t === e.currentTarget || t.matches(".toolbar, .toolbar > .spacer, .term-path, .conn-sep")) p.onGrip!(e);
          })
        }
      >
        <div className="toolbar">
          <span className="pbadge term-badge" aria-hidden>
            <Icon name="terminal" size={12} />
          </span>
          <span className="term-conn">{p.connName}</span>
          <span className="conn-sep" aria-hidden>
            <Icon name="chevron" size={12} />
          </span>
          <span className="term-path" title={p.path}>
            {p.path}
          </span>
          {p.follow && (
            <span
              className={`term-follow ${p.note ? "off" : ""}`}
              title={
                p.note
                  ? "Kybl types into a shell only while it waits at its prompt. It follows again on the next folder change."
                  : "Goes wherever the folder of the pane it opened from goes"
              }
            >
              {p.note ?? "following"}
            </span>
          )}
          <div className="spacer" />
          <button className="icon-btn" onClick={more} title="Terminal actions" aria-label="Terminal actions" aria-haspopup="menu">
            <Icon name="more" />
          </button>
        </div>
      </header>
      <div className="content term-content">
        <Suspense fallback={null}>
          <TermView spec={spec} onToggle={p.onToggle} />
        </Suspense>
      </div>
    </section>
  );
}
