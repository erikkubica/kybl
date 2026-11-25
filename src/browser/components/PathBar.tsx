import { keys } from "../../ui/lib/osText";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../ui/components/Icons";
import type { MenuItem } from "../../ui/components/Dialogs";
import { useOptionalDialogs } from "../../shell/hooks/useDialogs";
import { IS_MAC } from "../../ui/lib/pointer";
import { foldCount, type Crumb } from "../lib/crumbs";

/**
 * A path (lib/crumbs.ts), fitted to the room it has: every step while they fit, then the ones
 * nearest the top fold into "…" one by one, so it reads
 *   This Mac › Home › Downloads › photos     (room for all)
 *   This Mac › … › Downloads › photos
 *   This Mac › … › photos                    (the least)
 * and only then do the names get cut short. Each step is measured once in a hidden copy, and the
 * fold is worked out from those widths and the bar's, so a resize needs no extra layout pass.
 *
 * The last step is where you are: a click types a path (as ⇧⌘G does), and a right-click or
 * ⌘-click lists every step to jump to, like the path menu in a Finder window's title. "…" lists
 * the steps it holds. Keeps the `crumbs can-edit` classes: Go to folder (useEntryActions
 * `askGoTo`) looks for them to open the pane's own bar instead of a dialog.
 */
export function PathBar({
  crumbs,
  onGoTo,
  goTo,
  after,
  compact = false,
  className = "",
}: {
  /** the steps, the place on screen last */
  crumbs: Crumb[];
  /** typing a path (same rules as Go to folder); without it the last step is plain */
  onGoTo?: (path: string) => void;
  /** the path the field starts with, and its example */
  goTo?: { initial: string; placeholder: string };
  /** right after the path, in its room (the git branch chip) */
  after?: ReactNode;
  /** narrow bars (phones): the first step shows as its icon once you're further in */
  compact?: boolean;
  className?: string;
}) {
  // the phone app has no menus: there "…" goes to the nearest folder it holds
  const dialogs = useOptionalDialogs();
  const [editing, setEditing] = useState<string | null>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const nav = useRef<HTMLElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLSpanElement>(null);
  const [room, setRoom] = useState(0);
  const [widths, setWidths] = useState<{ sig: string; steps: number[]; more: number }>({ sig: "", steps: [], more: 0 });

  const n = crumbs.length;
  const iconFirst = compact && n > 1 && !!crumbs[0]?.icon;
  const sig = `${iconFirst}|${crumbs.map((c) => c.label).join("\u0000")}`;
  const startEdit = () => setEditing(goTo?.initial ?? "/");

  // a passive effect, not a layout one: opened from a menu ("Go to folder…"), the menu gives focus
  // back as it goes, in its own passive cleanup, which React runs before this
  useEffect(() => {
    if (editing != null) editInput.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing != null]);
  // ⇧⌘G (Go to folder) opens the bar of the pane it is sent to
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el || !onGoTo) return;
    el.addEventListener("kybl-edit-path", startEdit);
    return () => el.removeEventListener("kybl-edit-path", startEdit);
  });
  // the bar's room, less what comes after the path
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => setRoom(el.clientWidth - (afterRef.current?.offsetWidth ?? 0));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (afterRef.current) ro.observe(afterRef.current);
    measure();
    return () => ro.disconnect();
  }, [editing != null, !!after]);
  // each step's width, once per path
  useLayoutEffect(() => {
    const el = ruler.current;
    if (!el || widths.sig === sig) return;
    const all = [...el.children].map((c) => c.getBoundingClientRect().width);
    setWidths({ sig, more: all[0] ?? 0, steps: all.slice(1) });
  });

  const fold = widths.sig === sig ? foldCount(widths.steps, widths.more, room) : 0;
  const hidden = crumbs.slice(1, 1 + fold);

  /** every step, nearest first and the top last (the one on screen ticked at the top) */
  const stepsMenu = (x: number, y: number, list: Crumb[], withHere: boolean) => {
    if (!dialogs) {
      if (!withHere) list[list.length - 1]?.go?.();
      return;
    }
    const items: MenuItem[] = [...list].reverse().map((c, i) => {
      const here = withHere && i === 0;
      return { type: "item", label: c.label, icon: c.icon, checked: here || undefined, disabled: !here && !c.go, onClick: () => !here && c.go?.() };
    });
    if (withHere && onGoTo) items.push({ type: "sep" }, { type: "item", label: "Go to folder…", icon: "edit", hint: "⇧⌘G", onClick: startEdit });
    dialogs.menu(x, y, items);
  };
  const below = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.bottom + 4] as const;
  };
  const full = crumbs.map((c) => c.label).join(" / ");
  const sep = <Icon name="chevron" size={12} className="crumb-sep" />;

  if (editing != null && onGoTo)
    return (
      <nav className={`crumbs path-bar editing ${className}`} aria-label="Path" ref={nav}>
        <input
          ref={editInput}
          className="crumbs-input"
          value={editing}
          aria-label={`Path in ${full}`}
          placeholder={goTo?.placeholder ?? "/photos/2026"}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => setEditing(e.target.value)}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const v = editing.trim();
              setEditing(null);
              if (v) onGoTo(v);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(null);
            }
          }}
        />
      </nav>
    );

  const step = (c: Crumb, i: number) => {
    const isLast = i === n - 1;
    const first = i === 0;
    const iconOnly = first && iconFirst;
    return (
      <span key={i} className={`crumb-wrap ${first ? "crumb-root" : ""} ${isLast ? "crumb-here" : ""} ${iconOnly ? "icon-only" : ""}`}>
        {!first && sep}
        {isLast ? (
          <button
            type="button"
            className={`crumb current ${c.muted ? "muted" : ""}`}
            disabled={c.muted}
            title={`${full}\n${keys(onGoTo ? "Click to type a path (⇧⌘G) · right-click or ⌘-click for the enclosing folders" : "Right-click or ⌘-click for the enclosing folders")}`}
            aria-label={onGoTo ? `${full}. Type a path` : full}
            data-drop={c.drop}
            onClick={(e) => {
              // ⌘-click lists the enclosing folders, as on a Finder window's title
              if ((IS_MAC ? e.metaKey : e.ctrlKey) || !onGoTo) n > 1 && stepsMenu(...below(e.currentTarget), crumbs, true);
              else startEdit();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (n > 1) stepsMenu(...below(e.currentTarget), crumbs, true);
            }}
          >
            {iconOnly && c.icon && <Icon name={c.icon} size={15} />}
            {!iconOnly && <span className="crumb-label">{c.label}</span>}
          </button>
        ) : (
          <button
            type="button"
            className={`crumb ${first ? "crumb-top" : ""}`}
            disabled={!c.go}
            title={c.label}
            aria-label={c.label}
            data-drop={c.drop}
            onClick={() => c.go?.()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              stepsMenu(...below(e.currentTarget), crumbs, true);
            }}
          >
            {iconOnly && c.icon && <Icon name={c.icon} size={15} />}
            {!iconOnly && <span className="crumb-label">{c.label}</span>}
          </button>
        )}
      </span>
    );
  };

  return (
    <nav className={`crumbs path-bar ${onGoTo ? "can-edit" : ""} ${className}`} aria-label="Path" ref={nav}>
      <div className="crumbs-ruler" ref={ruler} aria-hidden="true">
        <span className="crumb-wrap">
          {sep}
          <span className="crumb">…</span>
        </span>
        {crumbs.map((c, i) => (
          <span key={i} className="crumb-wrap">
            {i > 0 && sep}
            <span className={`crumb ${i === n - 1 ? "current" : ""}`}>
              {i === 0 && iconFirst && c.icon ? <Icon name={c.icon} size={15} /> : <span className="crumb-label">{c.label}</span>}
            </span>
          </span>
        ))}
      </div>
      {n > 0 && step(crumbs[0], 0)}
      {fold > 0 && (
        <span className="crumb-wrap">
          {sep}
          <button
            type="button"
            className="crumb crumb-more"
            title={hidden.map((c) => c.label).join(" / ")}
            aria-label={`${hidden.length} more: ${hidden.map((c) => c.label).join(", ")}`}
            aria-haspopup="menu"
            // dropping on it: the folder nearest the one on screen it holds
            data-drop={hidden[hidden.length - 1]?.drop}
            onClick={(e) => stepsMenu(...below(e.currentTarget), hidden, false)}
          >
            …
          </button>
        </span>
      )}
      {crumbs.slice(1 + fold).map((c, j) => step(c, 1 + fold + j))}
      {after && (
        <span className="path-after" ref={afterRef}>
          {after}
        </span>
      )}
    </nav>
  );
}
