/** Small building blocks the connection forms share: labelled fields, secrets, warnings. */
import { useId, useState, type ReactNode } from "react";
import { Icon } from "../Icons";
import type { Profile } from "../types";
import { ON_OS } from "../osNames";

/** Addresses, keys and user names are typed exactly: no autocorrect or capitals on phones. */
export const RAW = {
  spellCheck: false,
  autoCorrect: "off",
  autoCapitalize: "off",
  autoComplete: "off",
} as const;

export const ANDROID = /Android/i.test(navigator.userAgent);
const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/** Phones and tablets: no ssh-agent there. */
export const PHONE = ANDROID || IOS;

/** Where saved secrets live, in words for the "unchanged" placeholder and the footnote. */
export const SAVED_WHERE = ANDROID ? "Saved on this device" : "Saved encrypted";
export const SECRET_NOTE = ANDROID
  ? "Passwords and keys stay on this device, in Kybl's private storage, and are left out of backups."
  : `Passwords and keys are saved encrypted, with the key in ${ON_OS.keychain}.`;

/** The fields of a form that need fixing; messages show once Save or Test was tried. */
export type Problems = Record<string, string | null>;

/**
 * A labelled input row. `error` shows under it (and marks the control invalid for screen readers
 * through `aria-describedby`, which the child gets from `control`).
 */
export function Field({
  label,
  optional,
  error,
  hint,
  wide,
  children,
}: {
  label: string;
  optional?: boolean;
  error?: string | null;
  hint?: ReactNode;
  /** spans both columns of the form grid */
  wide?: boolean;
  children: (control: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const described = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${wide ? "span2" : ""}`}>
      <label htmlFor={id} className="field-label">
        {label} {optional && <em>optional</em>}
      </label>
      {children({ id, "aria-invalid": !!error, "aria-describedby": described })}
      {error && (
        <em className="field-err" id={errId}>
          {error}
        </em>
      )}
      {hint && !error && (
        <small className="field-hint" id={hintId}>
          {hint}
        </small>
      )}
    </div>
  );
}

/** A password-style input with a show/hide button. Editing: empty keeps the saved one. */
export function SecretInput({
  value,
  onChange,
  editing,
  control,
  placeholder,
  label = "secret",
}: {
  value: string;
  onChange: (v: string) => void;
  /** a saved connection: an empty field keeps what is saved */
  editing: boolean;
  control: { id: string; "aria-invalid": boolean; "aria-describedby"?: string };
  placeholder?: string;
  /** what the show/hide button names ("password", "key") */
  label?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input
        className="mono"
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={editing ? `Unchanged · ${SAVED_WHERE.toLowerCase()}` : placeholder}
        {...control}
        {...RAW}
      />
      <button type="button" className="icon-btn" onClick={() => setShow((v) => !v)} title={show ? `Hide ${label}` : `Show ${label}`} aria-label={show ? `Hide ${label}` : `Show ${label}`} aria-pressed={show}>
        <Icon name={show ? "eye-off" : "eye"} size={14} />
      </button>
    </div>
  );
}

/** A caution under a field or above the buttons (unencrypted connections and the like). */
export function Warning({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "info" }) {
  return (
    <p className={`conn-warn span2 ${tone}`} role={tone === "warn" ? "note" : undefined}>
      <Icon name={tone === "warn" ? "alert" : "info"} size={14} />
      <span>{children}</span>
    </p>
  );
}

/** A row of mutually exclusive choices (TLS mode, sign-in method), as radio buttons. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg conn-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The parts of a connection the dialog needs from whichever form is showing. */
/** `clearSecret`: forget the saved password ("Remove saved password", FTP and WebDAV) */
export type Draft = { profile: Profile; secret?: string; clearSecret?: boolean };

/** What every kind's form gives the dialog (through `formApi`). */
export type FormApi = {
  /** The connection as filled in, or null (after marking what's missing) when it isn't valid yet. */
  draft(): Draft | null;
  /** SFTP: remember a fingerprint the user trusted (or forget it with null). */
  setHostKey?(fp: string | null): void;
  /** FTPS / WebDAV: remember a server certificate the user trusted (or forget it with null). */
  setCertFingerprint?(fp: string | null): void;
};
