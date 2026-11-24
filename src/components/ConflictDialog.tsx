import { useCallback, useRef, useState } from "react";
import { Icon } from "../Icons";
import { Modal } from "./Dialogs";
import { rememberChoice, rememberedChoice, type Choice, type Clash, type Direction, type Sticky } from "../desktop/conflicts";

/** What a caller can add to `resolve` for work that goes on while it asks (a streaming download). */
export type ResolveOpts = {
  /**
   * The answers given for the rest of this action ("Skip all", "Replace all"), owned by the caller: a
   * download that finds files later asks again with the same object and isn't asked twice.
   */
  sticky?: Sticky;
  /** more clashes may come after these (files still being found): "all" then covers them too */
  more?: boolean;
  /** offers "Remember until Kybl quits" for this direction, and applies what was remembered */
  remember?: Direction;
};

type Ask = {
  clash: Clash;
  /** clashes of the same kind (files or folders) still to come after this one */
  sameLeft: number;
  /** "Uploading", "Moving", "Copying" */
  verb: string;
  where: string;
  more: boolean;
  remember?: Direction;
  done: (r: { choice: Choice; all: boolean; remember: boolean } | null) => void;
};

/**
 * Asks what to do about each name that already exists: Replace (Merge for folders), Skip or
 * Keep both, each with an "all" button that answers the rest at once. Closing the dialog
 * cancels the whole action.
 */
export function useConflictPrompt() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const busy = useRef(false);

  /** Resolves with a choice per clashing key, or null when the user cancelled. */
  const resolve = useCallback(async (clashes: Clash[], verb: string, where: string, opts: ResolveOpts = {}): Promise<Map<string, Choice> | null> => {
    const out = new Map<string, Choice>();
    if (!clashes.length) return out;
    if (busy.current) return null;
    busy.current = true;
    try {
      const sticky: Sticky = opts.sticky ?? {};
      for (let i = 0; i < clashes.length; i++) {
        const c = clashes[i];
        const kind = c.folder ? "folder" : "file";
        // "Remember until Kybl quits" first, then "all" of this action
        const remembered = (opts.remember && rememberedChoice(opts.remember, c.folder)) || sticky[kind];
        if (remembered) {
          out.set(c.key, remembered);
          continue;
        }
        const sameLeft = clashes.slice(i + 1).filter((x) => x.folder === c.folder).length;
        const r = await new Promise<{ choice: Choice; all: boolean; remember: boolean } | null>((done) =>
          setAsk({ clash: c, sameLeft, verb, where, more: !!opts.more, remember: opts.remember, done }),
        );
        if (!r) return null;
        out.set(c.key, r.choice);
        if (r.all || r.remember) sticky[kind] = r.choice;
        if (r.remember && opts.remember) rememberChoice(opts.remember, c.folder, r.choice);
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
  const [remember, setRemember] = useState(false);
  const { clash, verb, where } = ask;
  const folder = clash.folder;
  // more of the same kind waiting, now or still being found by a listing: the choice can cover
  // them too. The buttons say "all" rather than a count, because a folder being listed hasn't
  // found every clash yet (a "2" would be wrong once the rest turn up).
  const more = ask.sameLeft > 0 || ask.more;
  const pick = (choice: Choice, all = false) => ask.done({ choice, all: all || remember, remember });
  const replace = folder ? "Merge" : "Replace";
  return (
    <Modal title={folder ? `A folder named “${clash.name}” already exists` : `“${clash.name}” already exists`} onClose={() => ask.done(null)} width={520}>
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
            {more && ` “All” answers every other ${folder ? "folder" : "file"} that already exists in this ${verb.toLowerCase()}, including ones still being found.`}
          </p>
          {ask.remember && (
            <label className="check conflict-all">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember my choice until Kybl quits</span>
            </label>
          )}
        </div>
      </div>
      <div className="modal-foot split">
        <div className="btn-row">
          <button className="btn" onClick={() => ask.done(null)}>
            Cancel
          </button>
          <button className="btn btn-ghost" onClick={() => pick("keep", more)} title={`Keep the existing ${folder ? "folder" : "file"} and add a number to the new one’s name${more ? ", for all of them" : ""}`}>
            {more ? "Keep both, all" : "Keep both"}
          </button>
        </div>
        <div className="btn-row">
          {/* Return skips: it neither loses the existing file nor makes a second copy */}
          <button className="btn btn-primary" autoFocus data-autofocus onClick={() => pick("skip")}>
            Skip
          </button>
          {more && (
            <button className="btn" onClick={() => pick("skip", true)}>
              Skip all
            </button>
          )}
          <button className="btn btn-danger-ghost" onClick={() => pick("replace")}>
            {replace}
          </button>
          {more && (
            <button className="btn btn-danger-ghost" onClick={() => pick("replace", true)}>
              {replace} all
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
