/**
 * A terminal pane's body (lazy chunk with xterm.js): attaches the running session's terminal,
 * keeps it fitted to the pane, and handles the pane's own keys. Those are taken on the pane in the
 * capture phase, so untrusted keydowns count too: the command palette hands ⌘K back to a
 * `[data-own-keys]` element as a synthetic keydown when the menu bar took the key first.
 */
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { isToggleKey, ownKey, ownKeyName, sessionFor } from "../lib/session";
import type { TermSpec } from "../api";

export default function TermView({ spec, onToggle }: { spec: TermSpec; onToggle: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef(onToggle);
  toggle.current = onToggle;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const s = sessionFor(spec);
    s.attach(el);
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => s.fitNow());
    });
    ro.observe(el);
    const onKey = (e: KeyboardEvent) => {
      if (!ownKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const k = ownKeyName(e);
      if (isToggleKey(e)) toggle.current();
      else if (k === "k") s.action("clear");
      else if (k === "c") s.action("copy");
      else if (k === "0") s.action("font0");
      else s.action(k === "-" ? "font-" : "font+");
    };
    el.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      el.removeEventListener("keydown", onKey, true);
      // the shell runs on: a workspace switch or a move only takes the pane off screen
      s.detach();
    };
    // a pane shows one session for good (another session is another key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.sid]);

  return <div className="term-box" ref={box} />;
}
