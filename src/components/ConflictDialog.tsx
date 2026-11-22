import { useCallback, useRef, useState } from "react";
import { Icon } from "../Icons";
import { Modal } from "./Dialogs";
import type { Choice, Clash } from "../desktop/conflicts";

type Ask = {
  clash: Clash;
  /** clashes of the same kind (files or folders) still to come after this one */
  sameLeft: number;
  /** "Uploading", "Moving", "Copying" */
  verb: string;
  where: string;
  done: (r: { choice: Choice; all: boolean } | null) => void;
};

/**
 * Asks what to do about each name that already exists: Replace (Merge for folders), Skip or
 * Keep both, with "Do this for the other N" to answer the rest at once. Closing the dialog
 * cancels the whole action.
 */
export function useConflictPrompt() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const busy = useRef(false);

  /** Resolves with a choice per clashing key, or null when the user cancelled. */
  const resolve = useCallback(async (clashes: Clash[], verb: string, where: string): Promise<Map<string, Choice> | null> => {
    const out = new Map<string, Choice>();
    if (!clashes.length) return out;
    if (busy.current) return null;
    busy.current = true;
    try {
      const sticky: { file?: Choice; folder?: Choice } = {};
      for (let i = 0; i < clashes.length; i++) {
        const c = clashes[i];
        const kind = c.folder ? "folder" : "file";
        const remembered = sticky[kind];
        if (remembered) {
          out.set(c.key, remembered);
          continue;
        }
        const sameLeft = clashes.slice(i + 1).filter((x) => x.folder === c.folder).length;
        const r = await new Promise<{ choice: Choice; all: boolean } | null>((done) => setAsk({ clash: c, sameLeft, verb, where, done }));
        if (!r) return null;
        out.set(c.key, r.choice);
        if (r.all) sticky[kind] = r.choice;
      }
      return out;
    } finally {
      busy.current = false;
      setAsk(null);
    }
  }, []);

  const element = ask ? <ConflictDialog key={ask.clash.key} ask={ask} /> : null;
  return { resolve, element, open: !!ask };
}

function ConflictDialog({ ask }: { ask: Ask }) {
  const [all, setAll] = useState(false);
  const { clash, sameLeft, verb, where } = ask;
  const folder = clash.folder;
  const pick = (choice: Choice) => ask.done({ choice, all });
  return (
    <Modal title={folder ? `A folder named “${clash.name}” already exists` : `“${clash.name}” already exists`} onClose={() => ask.done(null)} width={480}>
      <div className="modal-body conflict-body">
        <div className="conflict-icon" aria-hidden="true">
          <Icon name={folder ? "folder" : "file"} size={22} />
        </div>
        <div>
          <p>
            {folder ? "There’s already a folder with this name" : "There’s already a file with this name"} in <strong>{where}</strong>.
          </p>
          <p className="hint">
            {folder
              ? "Merge puts everything into the existing folder and replaces files with the same names. Keep both adds a number to the new folder’s name."
              : `Replace overwrites the existing file. Keep both adds a number to the name of the one you’re ${verb.toLowerCase()}.`}
          </p>
          {sameLeft > 0 && (
            <label className="check conflict-all">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              <span>
                Do this for the other {sameLeft.toLocaleString()} {folder ? (sameLeft === 1 ? "folder" : "folders") : sameLeft === 1 ? "file" : "files"}
              </span>
            </label>
          )}
        </div>
      </div>
      <div className="modal-foot split">
        <button className="btn" onClick={() => ask.done(null)}>
          Cancel
        </button>
        <div className="btn-row">
          <button className="btn" onClick={() => pick("skip")}>
            Skip
          </button>
          {/* Return keeps both: the choice that never loses anything */}
          <button className="btn btn-danger-ghost" onClick={() => pick("replace")}>
            {folder ? "Merge" : "Replace"}
          </button>
          <button className="btn btn-primary" autoFocus data-autofocus onClick={() => pick("keep")}>
            Keep both
          </button>
        </div>
      </div>
    </Modal>
  );
}
