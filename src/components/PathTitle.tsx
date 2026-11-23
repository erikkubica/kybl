import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../Icons";
import type { MenuItem } from "./Dialogs";
import { useDialogs } from "../shell/useDialogs";

/**
 * The desktop pane's place in its one-row header: just the current folder's name (the root's
 * name at the top), cut short with an ellipsis when the pane is narrow. The whole path is its
 * tooltip; a click turns it into a text field to type a path (as ⇧⌘G does), and the small chevron
 * after it, or a right-click on the name, lists the enclosing folders to jump to, like the path
 * menu in a Finder window's title.
 *
 * The full breadcrumb trail (Breadcrumbs.tsx) stays for phones, where the bar has the width.
 * Keeps the `crumbs can-edit` classes: Go to folder (useEntryActions `askGoTo`) looks for them to
 * open the pane's own bar instead of a dialog.
 */
export function PathTitle({
  label,
  icon = "bucket",
  parts,
  onNavigate,
  onGoTo,
}: {
  /** what the root is called on screen */
  label: string;
  /** the root's icon, for its row in the enclosing folders menu */
  icon?: IconName;
  parts: string[];
  onNavigate: (prefix: string) => void;
  /** typing a path (same rules as Go to folder); without it the name is plain text */
  onGoTo?: (path: string) => void;
}) {
  const dialogs = useDialogs();
  const [editing, setEditing] = useState<string | null>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const nav = useRef<HTMLElement>(null);
  const startEdit = () => setEditing("/" + parts.map((p) => p + "/").join(""));
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

  const n = parts.length;
  const name = n ? parts[n - 1] : label;
  const full = [label, ...parts].join(" / ");
  const prefixOf = (i: number) => (i < 0 ? "" : parts.slice(0, i + 1).join("/") + "/");

  /** The enclosing folders, nearest first and the root last (the one on screen ticked at the top). */
  const parentsMenu = (x: number, y: number) => {
    const items: MenuItem[] = [];
    for (let i = n - 1; i >= -1; i--) {
      const here = i === n - 1;
      items.push({
        type: "item",
        label: i < 0 ? label : parts[i],
        icon: i < 0 ? icon : "folder",
        checked: here || undefined,
        onClick: () => !here && onNavigate(prefixOf(i)),
      });
    }
    if (onGoTo) items.push({ type: "sep" }, { type: "item", label: "Go to folder…", icon: "edit", hint: "⇧⌘G", onClick: startEdit });
    dialogs.menu(x, y, items);
  };
  const below = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.bottom + 4] as const;
  };

  if (editing != null && onGoTo)
    return (
      <nav className="crumbs path-title editing" aria-label="Path" ref={nav}>
        <input
          ref={editInput}
          className="crumbs-input"
          value={editing}
          aria-label={`Path in ${label}`}
          placeholder="/photos/2026 or s3://bucket/photos"
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

  return (
    <nav className={`crumbs path-title ${onGoTo ? "can-edit" : ""}`} aria-label="Path" ref={nav} data-tauri-drag-region>
      <button
        type="button"
        className="crumb current path-name"
        title={onGoTo ? `${full}\nClick to type a path (⇧⌘G) · right-click for the enclosing folders` : full}
        aria-label={onGoTo ? `${full}. Type a path` : full}
        onClick={onGoTo ? startEdit : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          parentsMenu(...below(e.currentTarget));
        }}
      >
        <span className="crumb-label">{name}</span>
      </button>
      {n > 0 && (
        <button
          type="button"
          className="icon-btn path-parents"
          title="Enclosing folders"
          aria-label="Enclosing folders"
          aria-haspopup="menu"
          onClick={(e) => parentsMenu(...below(e.currentTarget.previousElementSibling as HTMLElement))}
        >
          <Icon name="chevron-down" size={12} />
        </button>
      )}
    </nav>
  );
}
