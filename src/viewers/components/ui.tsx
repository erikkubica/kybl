/** Small building blocks shared by the viewers. */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../../ui/components/Icons";

/** A toolbar button; with `pressed` it is a toggle. */
export function ToolButton({
  icon,
  label,
  title,
  pressed,
  disabled,
  onClick,
}: {
  icon?: IconName;
  label: string;
  title?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`dv-tool ${pressed ? "on" : ""}`}
      aria-pressed={pressed}
      disabled={disabled}
      title={title ?? label}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={14} />}
      <span>{label}</span>
    </button>
  );
}

/** A row of mutually exclusive choices ("Table | Text"). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="dv-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className={value === o.id ? "on" : ""} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Centered message inside a viewer: loading, errors, "too large". */
export function Note({ icon, spinner, children }: { icon?: IconName; spinner?: boolean; children?: ReactNode }) {
  return (
    <div className="dv-note">
      {spinner && <span className="spinner" />}
      {icon && <Icon name={icon} size={22} />}
      {children}
    </div>
  );
}
