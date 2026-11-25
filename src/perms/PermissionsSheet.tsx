/**
 * "Permissions…" on a server: the classic grid (read, write, execute for owner, group and others)
 * with the numeric value kept in step, for one item or a selection. Where the selection differs
 * a box is mixed (and its digit an "x"), and stays as each item has it unless it's clicked. For
 * folders, "Apply to enclosed items" also changes what is inside: everything, or only the files
 * or only the folders (like FileZilla).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { errMessage } from "../core/api";
import { Modal } from "../ui/components/Dialogs";
import { ErrorText } from "../ui/components/ErrorText";
import type { Entry } from "../core/types";
import { permsApi, modeText, type Recurse } from "./permsApi";
import { bitOf, bitsFromText, digits, octalDigits, startBits, type Bit } from "./permBits";
import "./perms.css";

const WHO = ["Owner", "Group", "Others"] as const;
const WHAT = ["Read", "Write", "Execute"] as const;
/** The same value, or null when the items differ. */
const same = (vals: (string | undefined)[]) => (vals.every((v) => v === vals[0]) ? vals[0] : undefined);

export function PermissionsSheet({
  profileId,
  bucket,
  items,
  onDone,
  onClose,
}: {
  profileId: string;
  bucket: string;
  items: Entry[];
  /** something changed: list the folder again */
  onDone: (changed: number) => void;
  onClose: () => void;
}) {
  const initial = useMemo(() => startBits(items.map((e) => e.mode)), [items]);
  const [bits, setBits] = useState<Bit[]>(initial);
  const [text, setText] = useState(() => digits(initial));
  const [recurse, setRecurse] = useState(false);
  const [scope, setScope] = useState<Recurse>("all");
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const op = useRef(`perm-${Math.random().toString(36).slice(2)}`);

  const folders = items.filter((e) => e.kind === "folder").length;
  const one = items.length === 1 ? items[0] : null;
  const owner = same(items.map((e) => e.owner));
  const group = same(items.map((e) => e.group));

  useEffect(() => {
    let off: (() => void) | undefined;
    let live = true;
    void listen<{ opId: string; phase: string; done: number; total: number }>("move-progress", (e) => {
      if (e.payload.opId === op.current) setBusy({ done: e.payload.done, total: e.payload.total });
    }).then((f) => (live ? (off = f) : f()));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const update = (next: Bit[]) => {
    setBits(next);
    setText(digits(next));
  };
  const toggle = (i: number) => update(bits.map((b, j) => (j === i ? !b : b)));
  const typed = (v: string) => {
    setText(v);
    const next = bitsFromText(v, initial);
    if (next) setBits(next);
  };

  let set = 0;
  let clear = 0;
  bits.forEach((b, i) => {
    if (b === true) set |= bitOf(i);
    else if (b === false) clear |= bitOf(i);
  });
  const parsed = octalDigits(text);
  const num = parsed === "special" ? null : parsed;
  const valid = num !== null;
  const changed = bits.some((b, i) => b !== initial[i]);
  const canApply = valid && (set | clear) !== 0 && (changed || (recurse && folders > 0)) && !busy;

  const apply = async () => {
    setError(null);
    setBusy({ done: 0, total: items.length });
    try {
      const r = await permsApi.set(profileId, bucket, items, set, clear, recurse && folders ? scope : null, op.current);
      if (r.done) onDone(r.done);
      if (r.error) {
        setError(r.done ? `Changed ${r.done} of ${r.total}, then stopped: ${r.error}` : r.error);
        setBusy(null);
        return;
      }
      onClose();
    } catch (e) {
      setError(errMessage(e));
      setBusy(null);
    }
  };

  const title = one ? `Permissions of “${one.name}”` : `Permissions of ${items.length} items`;
  return (
    // a running change can't be stopped: the sheet stays (with its progress) until it ends
    <Modal title={title} onClose={onClose} locked={!!busy} width={400} help="file-operations">
      <div className="modal-body perm-body">
        {(owner || group) && (
          <p className="perm-who">
            {owner && (
              <>
                Owner <strong>{owner}</strong>
              </>
            )}
            {owner && group && " · "}
            {group && (
              <>
                Group <strong>{group}</strong>
              </>
            )}
          </p>
        )}
        <table className="perm-grid">
          <thead>
            <tr>
              <th />
              {WHAT.map((w) => (
                <th key={w} scope="col" title={w === "Execute" ? "For folders: open the folder and list what's in it" : undefined}>
                  {w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WHO.map((who, r) => (
              <tr key={who}>
                <th scope="row">{who}</th>
                {WHAT.map((what, c) => {
                  const i = r * 3 + c;
                  return (
                    <td key={what}>
                      <input
                        type="checkbox"
                        aria-label={`${who} ${what.toLowerCase()}`}
                        checked={bits[i] === true}
                        ref={(el) => {
                          if (el) el.indeterminate = bits[i] === null;
                        }}
                        disabled={!!busy}
                        onChange={() => toggle(i)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="perm-num">
          <span>Numeric value</span>
          <input
            className={`mono${valid ? "" : " bad"}`}
            value={text}
            maxLength={4}
            spellCheck={false}
            disabled={!!busy}
            onChange={(e) => typed(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canApply) void apply();
            }}
            aria-invalid={!valid}
            aria-describedby="perm-num-hint"
          />
          <em id="perm-num-hint" className="mono">
            {num !== null
              ? /x/i.test(num)
                ? "x: as each item has it"
                : modeText(parseInt(num, 8))
              : parsed === "special"
                ? "setuid, setgid and sticky can't be set here"
                : "three digits, 0–7"}
          </em>
        </label>
        {folders > 0 && (
          <div className="perm-recurse">
            <label className="perm-check">
              <input type="checkbox" checked={recurse} disabled={!!busy} onChange={(e) => setRecurse(e.target.checked)} />
              Apply to enclosed items
            </label>
            {recurse && (
              <div className="seg perm-scope" role="radiogroup" aria-label="What inside changes">
                {(
                  [
                    ["all", "Everything"],
                    ["files", "Files only"],
                    ["folders", "Folders only"],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? "on" : ""} disabled={!!busy} onClick={() => setScope(v)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {recurse && scope === "files" && <p className="hint">{folders === 1 ? "The folder itself keeps its" : "The folders themselves keep their"} permissions.</p>}
          </div>
        )}
        {error && (
          <p className="hint error" role="alert">
            <ErrorText message={error} />
          </p>
        )}
      </div>
      <div className="modal-foot split">
        <span className="perm-progress" role="status">
          {busy && busy.total > 1 ? `Changed ${busy.done.toLocaleString()} of ${busy.total.toLocaleString()}…` : ""}
        </span>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void apply()} disabled={!canApply} data-autofocus>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
