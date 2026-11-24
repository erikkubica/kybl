import { MIcon, type MIconName } from "./icons";
import { SheetBackdrop } from "./ui";

export type SheetItem = { icon: MIconName; label: string; run: () => void; danger?: boolean; keepOpen?: boolean };

/** A bottom sheet of actions, the phone's stand-in for a context menu. Tapping outside it, the
 * system back or Escape closes it, so it shows no Cancel button (a hidden one is there for
 * screen readers and switches). */
export function ActionSheet({
  title,
  message,
  items,
  onPick,
  onClose,
}: {
  title?: string;
  /** a sentence under the title (what the choice is about) */
  message?: string;
  items: SheetItem[];
  onPick: (item: SheetItem) => void;
  onClose: () => void;
}) {
  return (
    <SheetBackdrop onClose={onClose}>
      <div className="m-sheet" role="menu" aria-label={title ?? "Actions"} onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grip" />
        {title && <div className="m-sheet-title">{title}</div>}
        {message && <p className="m-sheet-msg">{message}</p>}
        {items.map((it) => (
          <button key={it.label} role="menuitem" className={`m-sheet-item ${it.danger ? "danger" : ""}`} onClick={() => onPick(it)}>
            <MIcon name={it.icon} size={19} />
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </SheetBackdrop>
  );
}
