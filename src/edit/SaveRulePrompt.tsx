/**
 * Asked on every edit, before the file opens: what to do when it's saved. The last answer is
 * preselected (per device), but there is no "don't ask again": overwriting someone's change on
 * a server is the one mistake this is here to prevent.
 */
import { useState } from "react";
import { Modal } from "../components/Dialogs";
import { lastRule, rememberRule, type SaveRule } from "./editStore";
import "./edit.css";

const CHOICES: { rule: SaveRule; label: string; note?: string }[] = [
  { rule: "auto", label: "Upload changes automatically" },
  { rule: "ifUnchanged", label: "Upload only if the file on the server hasn't changed since you opened it", note: "Recommended" },
];

export function SaveRulePrompt({ name, where, onAnswer }: { name: string; where?: string; onAnswer: (r: SaveRule | null) => void }) {
  const [rule, setRule] = useState<SaveRule>(lastRule);
  const go = () => {
    rememberRule(rule);
    onAnswer(rule);
  };
  return (
    <Modal title={`Edit “${name}”${where ? ` in ${where}` : ""}`} onClose={() => onAnswer(null)} width={420} dismissOnBackdrop>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="modal-body">
          <div className="ed-ask" id="ed-ask-label">
            When you save this file:
          </div>
          <div className="ed-choices" role="radiogroup" aria-labelledby="ed-ask-label">
            {CHOICES.map((c) => (
              <label key={c.rule} className={`ed-choice ${rule === c.rule ? "on" : ""}`}>
                <input type="radio" name="ed-rule" value={c.rule} checked={rule === c.rule} onChange={() => setRule(c.rule)} />
                <span className="ed-choice-text">
                  {c.label}
                  {c.note && <span className="pill accent ed-rec">{c.note}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" data-autofocus="">
            Edit
          </button>
        </div>
      </form>
    </Modal>
  );
}
