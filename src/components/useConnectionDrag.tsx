/**
 * Dragging connections onto a group in the sidebar. Pointer events, like the file drags (the
 * webview's own drag and drop is switched off for dropped files): a press that moves a few pixels
 * starts it, the group under the pointer lights up (any element marked `data-conn-drop="<group
 * path>"`, "" for the top level) and letting go files the connections there. The click that
 * follows a drag is swallowed so the row doesn't open.
 */
import { useEffect, useRef, useState } from "react";
import { plural } from "../format";
import { Icon } from "../Icons";

const START_AT = 5;

type Live = { ids: string[]; label: string; x: number; y: number; over: string | null };

export function useConnectionDrag(onDrop: (ids: string[], group: string) => void) {
  const [live, setLive] = useState<Live | null>(null);
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const press = useRef<{ x: number; y: number; ids: string[]; label: string } | null>(null);
  const dragged = useRef(false);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);

  const overOf = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-conn-drop]");
    return el ? (el.dataset.connDrop ?? "") : null;
  };

  /** Props for a row: `ids` and `label` say what a drag from it carries. */
  const rowProps = (ids: string[], label: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest("button, input")) return;
      press.current = { x: e.clientX, y: e.clientY, ids, label };
      dragged.current = false;
      const move = (ev: PointerEvent) => {
        const p = press.current;
        if (!p) return;
        if (!dragged.current && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < START_AT) return;
        dragged.current = true;
        document.body.classList.add("dragging-conn");
        setLive({ ids: p.ids, label: p.label, x: ev.clientX, y: ev.clientY, over: overOf(ev.clientX, ev.clientY) });
      };
      const end = (ev: PointerEvent | null) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("keydown", key, true);
        document.body.classList.remove("dragging-conn");
        const p = press.current;
        press.current = null;
        setLive(null);
        stop.current = () => {};
        if (!ev || !p || !dragged.current) return;
        const over = overOf(ev.clientX, ev.clientY);
        if (over !== null) drop.current(p.ids, over);
        // the click that ends this press must not open the row
        window.setTimeout(() => (dragged.current = false), 0);
      };
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        dragged.current = false;
        end(null);
      };
      stop.current = () => end(null);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      window.addEventListener("keydown", key, true);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (dragged.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
  });

  const ghost = live && (
    <div className="conn-drag-ghost" style={{ transform: `translate(${live.x + 12}px, ${live.y + 10}px)` }} aria-hidden="true">
      <Icon name="folder" size={13} />
      <span>{live.ids.length === 1 ? live.label : plural(live.ids.length, "connection")}</span>
    </div>
  );
  return { over: live?.over ?? null, active: !!live, rowProps, ghost };
}
