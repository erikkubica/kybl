/** The result of Compare folders: what differs between the two panes, and what got selected. */
import { Modal } from "../ui/components/Dialogs";
import { Icon } from "../ui/components/Icons";
import { canDiff, openDiff } from "../viewers/lib/diff";
import type { Entry } from "../core/types";
import type { FolderDiff } from "./compareFolders";
import { plural } from "../core/format";

type At = { profileId: string; bucket: string; prefix: string };
/** Files shown with a Compare button (the rest are only counted). */
const MAX_COMPARE = 8;

const n = plural;

export function CompareSummary({
  diff,
  leftName,
  rightName,
  sides = ["left", "right"],
  partial,
  leftAt,
  rightAt,
  onClose,
}: {
  diff: FolderDiff;
  leftName: string;
  rightName: string;
  /** where the two folders are: files that differ get a Compare button (the text diff) */
  leftAt?: At | null;
  rightAt?: At | null;
  /** where the two panes are: side by side, or one above the other */
  sides?: ["left", "right"] | ["top", "bottom"];
  /** a listing was not loaded to the end: only the loaded items were compared */
  partial: boolean;
  onClose: () => void;
}) {
  const leftSel = diff.leftOnly.length + diff.leftNewer.length + diff.differ.length;
  const rightSel = diff.rightOnly.length + diff.rightNewer.length + diff.differ.length;
  const nothing = leftSel + rightSel === 0;
  // files on both sides that differ, and that are text: one click to see how
  const differing: Entry[] = [...diff.leftNewer, ...diff.rightNewer, ...diff.differ.map(([a]) => a)].filter((e) => e.kind === "file" && canDiff(e));
  const compare = (e: Entry) => {
    if (!leftAt || !rightAt) return;
    const side = (at: At, where: string) => ({ profileId: at.profileId, bucket: at.bucket, key: at.prefix + e.name, name: e.name, label: `${e.name} · ${where}` });
    void openDiff(side(leftAt, leftName), side(rightAt, rightName));
  };
  return (
    <Modal title="Compare folders" onClose={onClose} width={460} dismissOnBackdrop help="compare">
      <div className="modal-body compare-body">
        {nothing ? (
          <p>
            <strong>{diff.same ? "Both folders have the same items." : "Both folders are empty."}</strong> {diff.same ? `${n(diff.same, "item")} ${diff.same === 1 ? "matches" : "match"} by name and size.` : null}
          </p>
        ) : (
          <>
            <ul className="compare-list">
              {diff.leftOnly.length > 0 && <li>{n(diff.leftOnly.length, "item")} only in “{leftName}”</li>}
              {diff.rightOnly.length > 0 && <li>{n(diff.rightOnly.length, "item")} only in “{rightName}”</li>}
              {diff.leftNewer.length > 0 && <li>{n(diff.leftNewer.length, "file")} newer in “{leftName}”</li>}
              {diff.rightNewer.length > 0 && <li>{n(diff.rightNewer.length, "file")} newer in “{rightName}”</li>}
              {diff.differ.length > 0 && <li>{n(diff.differ.length, "file")} {diff.differ.length === 1 ? "differs" : "differ"}, with no telling which is newer</li>}
              <li className="dim">{n(diff.same, "item")} the same</li>
            </ul>
            {leftAt && rightAt && differing.length > 0 && (
              <ul className="compare-files">
                {differing.slice(0, MAX_COMPARE).map((e) => (
                  <li key={e.key}>
                    <span title={e.name}>{e.name}</span>
                    <button type="button" className="btn btn-sm" onClick={() => compare(e)}>
                      <Icon name="compare" size={12} /> Compare
                    </button>
                  </li>
                ))}
                {differing.length > MAX_COMPARE && <li className="dim">and {n(differing.length - MAX_COMPARE, "more file")}</li>}
              </ul>
            )}
            <p>
              Selected what the other side is missing or has an older copy of: {n(leftSel, "item")} {sides[0] === "left" ? "on the left" : "in the top pane"}, {n(rightSel, "item")}{" "}
              {sides[1] === "right" ? "on the right" : "in the bottom pane"}.{" "}
              {leftSel && rightSel
                ? "Press F5 to copy the active pane’s selection across, then Tab to the other pane and press F5 again."
                : `Press F5 to copy ${leftSel + rightSel === 1 ? "it" : "them"} to the ${leftSel ? sides[1] : sides[0]}${sides[0] === "top" ? " pane" : ""}.`}
            </p>
          </>
        )}
        <p className="hint">
          Files are compared by size, checksum and date. Folders are matched by name; what is inside them isn’t compared.
          {partial ? " One of the folders is very big, so only the items loaded so far were compared." : ""}
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn btn-primary" onClick={onClose} autoFocus>
          OK
        </button>
      </div>
    </Modal>
  );
}
