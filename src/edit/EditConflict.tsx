/**
 * A save that wasn't uploaded because the server's copy changed (or went away) since the file
 * was opened: overwrite it, keep both, or take the server's version.
 */
import { useState } from "react";
import { Modal } from "../components/Dialogs";
import { errMessage, errSummary } from "../api";
import { formatBytes, formatDateFull } from "../format";
import { Icon } from "../Icons";
import { editApi, putOffConflict, useAsking, type ConflictAnswer, type EditSession } from "./editStore";
import { canDiff, openDiff } from "../viewers/diff";
import "./edit.css";

/** "index.php" → "index (edited).php" (what "Keep both" names the upload first). */
export function editedName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (edited)${name.slice(dot)}` : `${name} (edited)`;
}

export function EditConflict({ s, onStop }: { s: EditSession; onStop: (s: EditSession) => void }) {
  const [busy, setBusy] = useState<ConflictAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gone = !s.server;
  const later = () => putOffConflict(s.id);
  const answer = async (a: ConflictAnswer) => {
    setBusy(a);
    setError(null);
    try {
      const after = await editApi.resolve(s.id, a);
      // the upload itself can fail (a dropped connection): say so here, the question stays
      if (after.phase === "error") setError(errSummary(after.error ?? "The upload didn't go through."));
    } catch (e) {
      setError(errSummary(errMessage(e)));
    } finally {
      setBusy(null);
    }
  };
  const compare = async () => {
    setError(null);
    try {
      const mine = await editApi.localText(s.id);
      await openDiff(
        { profileId: s.profileId, bucket: s.root, key: s.key, name: s.name, label: "On the server now" },
        { text: mine, name: s.name, label: "Your version" },
        { title: s.name },
      );
    } catch (e) {
      setError(errSummary(errMessage(e)));
    }
  };
  const theirs = s.server ? [s.server.modified ? `saved ${formatDateFull(s.server.modified)}` : null, formatBytes(s.server.size)].filter(Boolean).join(", ") : null;
  return (
    <Modal title={gone ? `“${s.name}” was deleted on the server` : `“${s.name}” changed on the server since you opened it`} onClose={later} width={440}>
      <div className="modal-body">
        <p>
          Your save wasn't uploaded{theirs ? `. The server's copy was ${theirs}.` : ". Nothing is there now."}
        </p>
        <div className="ed-answers">
          <button className="btn ed-answer" onClick={() => void answer("overwrite")} disabled={!!busy} data-autofocus={gone ? "" : undefined}>
            {busy === "overwrite" ? <span className="spinner" /> : <Icon name="upload" size={15} />}
            <span>{gone ? "Upload mine again" : "Overwrite the server's copy"}</span>
          </button>
          {/* the safe default: nothing is lost either way */}
          {!gone && (
            <button className="btn ed-answer" onClick={() => void answer("keepBoth")} disabled={!!busy} data-autofocus="">
              {busy === "keepBoth" ? <span className="spinner" /> : <Icon name="copy" size={15} />}
              <span>
                Keep both <span className="ed-dim">(upload mine as {editedName(s.name)})</span>
              </span>
            </button>
          )}
          {gone ? (
            <button className="btn btn-danger-ghost ed-answer" onClick={() => onStop(s)} disabled={!!busy}>
              <Icon name="x" size={15} />
              <span>Stop editing and discard my changes</span>
            </button>
          ) : (
            <button className="btn btn-danger-ghost ed-answer" onClick={() => void answer("reload")} disabled={!!busy}>
              {busy === "reload" ? <span className="spinner" /> : <Icon name="refresh" size={15} />}
              <span>Discard my changes and reload the server's</span>
            </button>
          )}
        </div>
        {error && (
          <p className="ed-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-foot">
        {!gone && canDiff({ name: s.name }) && (
          <button className="btn btn-ghost" onClick={() => void compare()} disabled={!!busy} style={{ marginRight: "auto" }}>
            Compare…
          </button>
        )}
        <button className="btn" onClick={later} disabled={!!busy}>
          Decide later
        </button>
      </div>
    </Modal>
  );
}

/** The conflict question of whichever edited file has one waiting (one at a time). */
export function EditConflictHost({ onStop }: { onStop: (s: EditSession) => void }) {
  const s = useAsking();
  return s ? <EditConflict key={s.id} s={s} onStop={onStop} /> : null;
}
