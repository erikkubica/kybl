import { Icon, type IconName } from "../Icons";

export type SheetItem = { icon: IconName; label: string; run: () => void; danger?: boolean; keepOpen?: boolean };

/** A bottom sheet of actions, the phone's stand-in for a context menu. Tapping outside it or
 * the system back closes it, so it has no Cancel button. */
export function ActionSheet({
  title,
  items,
  onPick,
  onClose,
}: {
  title?: string;
  items: SheetItem[];
  onPick: (item: SheetItem) => void;
  onClose: () => void;
}) {
  return (
    <div className="m-sheet-backdrop" onClick={onClose}>
      <div className="m-sheet" role="menu" aria-label={title ?? "Actions"} onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grip" />
        {title && <div className="m-sheet-title">{title}</div>}
        {items.map((it) => (
          <button key={it.label} role="menuitem" className={`m-sheet-item ${it.danger ? "danger" : ""}`} onClick={() => onPick(it)}>
            <Icon name={it.icon} size={19} />
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
