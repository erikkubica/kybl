/**
 * Batch rename: a pattern with variables ("Trip {n:3}") or find & replace, a case and extension
 * option, and a live preview of every old → new name that flags the names that can't be used.
 * The preview renders only the rows in view, so 2,000 photos stay smooth while typing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../ui/components/Icons";
import { Modal } from "../../ui/components/Dialogs";
import { useWindowed } from "../../ui/hooks/useWindowed";
import { DEFAULT_RULES, VARIABLES, planRenames, splitName, type BatchItem, type Move, type PlanRow, type Rules } from "../lib/batchRename";

/** localStorage: the rules used last */
const STORE = "kybl.batchRename";
const ROW_H = 28;

function loadRules(): Rules {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<Rules>) };
  } catch {
    /* storage off or garbled: the defaults */
  }
  return DEFAULT_RULES;
}
function saveRules(r: Rules) {
  try {
    localStorage.setItem(STORE, JSON.stringify(r));
  } catch {
    /* storage off: not remembered */
  }
}

const int = (v: string, fallback: number) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export function BatchRenameDialog({
  items,
  others,
  rootName,
  foldCase,
  note,
  onRun,
  onClose,
}: {
  /** the selected items, in the order the list shows them */
  items: BatchItem[];
  /** keys of everything else listed: names already taken */
  others: string[];
  rootName: string;
  foldCase: boolean;
  /** a caution under the options (folders on S3 are copied file by file) */
  note?: string;
  onRun: (moves: Move[]) => void;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<Rules>(loadRules);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const set = (p: Partial<Rules>) => setRules((r) => ({ ...r, ...p }));
  const pattern = useRef<HTMLInputElement>(null);
  // the last pattern comes back selected: typing replaces it, an arrow key edits it
  useEffect(() => pattern.current?.select(), []);

  const plan = useMemo(() => planRenames(items, rules, { others, rootName, foldCase }), [items, rules, others, rootName, foldCase]);
  const rows = useMemo(() => (onlyProblems ? plan.rows.filter((r) => r.status === "invalid" || r.status === "conflict") : plan.rows), [plan, onlyProblems]);
  const canRun = !plan.error && plan.problems === 0 && plan.changed > 0;

  const scroller = useRef<HTMLDivElement>(null);
  const win = useWindowed({ scroller, count: rows.length, rowHeight: ROW_H });

  // what the extension option does, said with a real extension from the selection
  const exts = useMemo(() => [...new Set(items.map((i) => splitName(i.name, i.folder)[1]).filter(Boolean))], [items]);
  const sampleExt = exts[0];
  const extLabel = exts.length > 1 ? `.${exts[0]}, .${exts[1]}${exts.length > 2 ? "…" : ""}` : `.${sampleExt}`;
  const usesExt = rules.mode === "pattern" && rules.pattern.includes("{ext}");
  const usesCounter = rules.mode === "pattern" && /\{n(:\d*)?\}/.test(rules.pattern);

  const run = () => {
    if (!canRun) return;
    saveRules(rules);
    onRun(plan.rows.filter((r) => r.status === "ok").map((r) => ({ from: r.item.key, to: r.toKey, isPrefix: r.item.folder })));
    onClose();
  };

  /** A variable chip: typed in where the cursor is (replacing a selection), the cursor after it. */
  const insert = (token: string) => {
    const el = pattern.current;
    const v = rules.pattern;
    const [a, b] = el && document.activeElement === el ? [el.selectionStart ?? v.length, el.selectionEnd ?? v.length] : [v.length, v.length];
    set({ pattern: v.slice(0, a) + token + v.slice(b) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + token.length, a + token.length);
    });
  };

  // case and extension apply in both modes
  const caseExt = (
    <>
      <label className="br-opt">
        <span>Case</span>
        <select value={rules.case} onChange={(e) => set({ case: e.target.value as Rules["case"] })}>
          <option value="keep">Keep</option>
          <option value="lower">lowercase</option>
          <option value="upper">UPPERCASE</option>
          <option value="title">Title Case</option>
        </select>
      </label>
      <label className="br-opt">
        <span>Extension</span>
        <select value={rules.ext} onChange={(e) => set({ ext: e.target.value as Rules["ext"] })}>
          <option value="keep">Keep</option>
          <option value="lower">lowercase</option>
          <option value="upper">UPPERCASE</option>
          <option value="change">Change to…</option>
          <option value="remove">Remove</option>
        </select>
      </label>
      {rules.ext === "change" && (
        <label className="br-opt">
          <span>New extension</span>
          <input value={rules.extTo} placeholder={sampleExt ?? "jpg"} onChange={(e) => set({ extTo: e.target.value })} spellCheck={false} autoCorrect="off" autoCapitalize="off" />
        </label>
      )}
    </>
  );

  const summary = [
    plan.changed && `${plan.changed.toLocaleString()} to rename`,
    plan.same && `${plan.same.toLocaleString()} unchanged`,
    plan.problems && `${plan.problems.toLocaleString()} with problems`,
  ].filter(Boolean);

  return (
    <Modal title={`Rename ${items.length.toLocaleString()} items`} onClose={onClose} width={680}>
      <form
        className="br"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="modal-body br-body">
          <div className="seg br-mode" role="tablist">
            <button type="button" role="tab" aria-selected={rules.mode === "pattern"} className={rules.mode === "pattern" ? "on" : ""} onClick={() => set({ mode: "pattern" })}>
              Pattern
            </button>
            <button type="button" role="tab" aria-selected={rules.mode === "replace"} className={rules.mode === "replace" ? "on" : ""} onClick={() => set({ mode: "replace" })}>
              Find & replace
            </button>
          </div>

          {rules.mode === "pattern" ? (
            <>
              <label className="field">
                <span>New name</span>
                <input
                  ref={pattern}
                  className="br-pattern"
                  value={rules.pattern}
                  onChange={(e) => set({ pattern: e.target.value })}
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  aria-invalid={!!plan.error}
                />
              </label>
              <div className="br-chips" aria-label="Variables">
                {VARIABLES.map((v) => (
                  <button
                    type="button"
                    key={v.token}
                    className="br-chip"
                    title={v.label}
                    // keep the cursor in the pattern field
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(v.token)}
                  >
                    {v.token}
                  </button>
                ))}
              </div>
              <div className="br-opts">
                <label className="br-opt">
                  <span>Start at</span>
                  <input type="number" value={rules.start} disabled={!usesCounter} onChange={(e) => set({ start: int(e.target.value, 1) })} />
                </label>
                <label className="br-opt">
                  <span>Step</span>
                  <input type="number" value={rules.step} disabled={!usesCounter} onChange={(e) => set({ step: int(e.target.value, 1) })} />
                </label>
                <label className="br-opt">
                  <span>Count in order of</span>
                  <select value={rules.order} disabled={!usesCounter} onChange={(e) => set({ order: e.target.value as Rules["order"] })}>
                    <option value="view">As shown</option>
                    <option value="name">Name</option>
                    <option value="date">Date modified</option>
                  </select>
                </label>
                {caseExt}
              </div>
            </>
          ) : (
            <>
              <div className="br-pair">
                <label className="field">
                  <span>Find</span>
                  <input value={rules.find} onChange={(e) => set({ find: e.target.value })} autoFocus spellCheck={false} autoCorrect="off" autoCapitalize="off" aria-invalid={!!plan.error} />
                </label>
                <label className="field">
                  <span>Replace with</span>
                  <input value={rules.replace} onChange={(e) => set({ replace: e.target.value })} spellCheck={false} autoCorrect="off" autoCapitalize="off" />
                </label>
              </div>
              <div className="br-opts">
                <label className="check">
                  <input type="checkbox" checked={rules.matchCase} onChange={(e) => set({ matchCase: e.target.checked })} />
                  <span>Match case</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={rules.regex} onChange={(e) => set({ regex: e.target.checked })} />
                  <span>Regular expression {rules.regex && <em className="br-inline-em">($1 inserts a group)</em>}</span>
                </label>
              </div>
              <div className="br-opts">{caseExt}</div>
            </>
          )}


          {plan.error ? (
            <p className="hint error br-note">
              <Icon name="alert" size={13} />
              <span>{plan.error}</span>
            </p>
          ) : (
            <p className="hint br-note">
              <Icon name="info" size={13} />
              <span>
                {rules.mode === "replace"
                  ? "Find & replace works on the name without its extension."
                  : usesExt
                    ? "{ext} places the extension; nothing else is added."
                    : !sampleExt
                      ? "Add {ext} to place the extension yourself."
                      : rules.ext === "keep"
                        ? `The extension (${extLabel}) is kept. Add {ext} to place it yourself.`
                        : "The extension is added at the end, as set under Extension. Add {ext} to place it yourself."}
              </span>
            </p>
          )}
          {note && (
            <p className="hint warn br-note">
              <Icon name="info" size={13} />
              <span>{note}</span>
            </p>
          )}

          <div className="br-preview-head">
            <span>{summary.join(" · ") || "Preview"}</span>
            {(plan.problems > 0 || onlyProblems) && (
              <label className="check">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
                <span>Only problems</span>
              </label>
            )}
          </div>
          <div className="br-preview" ref={scroller} role="list" aria-label="Preview">
            <div style={{ height: win.padTop }} />
            {rows.slice(win.start, win.end).map((r) => (
              <PreviewRow key={r.item.key} row={r} />
            ))}
            <div style={{ height: win.padBottom }} />
            {!rows.length && <div className="br-empty">No problems</div>}
          </div>
        </div>
        <div className="modal-foot split">
          <span className="br-foot-note">{plan.problems > 0 ? "Fix the names marked in red to continue." : ""}</span>
          <div className="btn-row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canRun}>
              {plan.changed ? `Rename ${plan.changed.toLocaleString()} ${plan.changed === 1 ? "item" : "items"}` : "Rename"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function PreviewRow({ row }: { row: PlanRow }) {
  const bad = row.status === "invalid" || row.status === "conflict";
  return (
    <div className={`br-row st-${row.status}`} role="listitem" title={row.reason}>
      <Icon name={row.item.folder ? "folder" : "file"} size={13} />
      <span className="br-old">{row.from}</span>
      <Icon name="arrow-right" size={12} />
      <span className="br-new">{row.status === "same" ? "unchanged" : row.to || "—"}</span>
      {bad && <span className="br-why">{row.reason}</span>}
    </div>
  );
}
