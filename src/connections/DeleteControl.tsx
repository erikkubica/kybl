/** "Delete" in a connection's footer, with an inline "Delete connection / Keep" confirmation. */
import { useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import type { Profile } from "../types";

export function DeleteControl<B extends string>({
  profile,
  busy,
  setBusy,
  onDeleted,
  onClose,
  onError,
}: {
  profile: Profile;
  busy: B | "delete" | null;
  setBusy: (b: "delete" | null) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    setBusy("delete");
    try {
      await api.deleteProfile(profile.id);
      onDeleted(profile.id);
      onClose();
    } catch (e) {
      onError(`Couldn’t delete this connection.\n\n${errMessage(e)}`);
      setConfirm(false);
      setBusy(null);
    }
  };
  return confirm ? (
    <>
      <button type="button" className="btn btn-danger" onClick={remove} disabled={busy !== null}>
        {busy === "delete" && <span className="spinner" />}
        {busy === "delete" ? "Deleting…" : "Delete connection"}
      </button>
      {/* focus starts on Keep, so a second Return doesn't delete the connection */}
      <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy === "delete"} autoFocus>
        Keep
      </button>
    </>
  ) : (
    <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirm(true)} disabled={busy !== null}>
      <Icon name="trash" size={14} /> Delete
    </button>
  );
}
