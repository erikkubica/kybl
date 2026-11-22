/** The result of Compare folders: what differs between the two panes, and what got selected. */
import { Modal } from "../components/Dialogs";
import type { FolderDiff } from "./compareFolders";

const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

export function CompareSummary({
  diff,
  leftName,
  rightName,
  partial,
  onClose,
}: {
  diff: FolderDiff;
  leftName: string;
  rightName: string;
  /** a listing was not loaded to the end: only the loaded items were compared */
  partial: boolean;
  onClose: () => void;
}) {
  const leftSel = diff.leftOnly.length + diff.leftNewer.length + diff.differ.length;
  const rightSel = diff.rightOnly.length + diff.rightNewer.length + diff.differ.length;
  const nothing = leftSel + rightSel === 0;
  return (
    <Modal title="Compare folders" onClose={onClose} width={460} dismissOnBackdrop>
      <div className="modal-body compare-body">
        {nothing ? (
          <p>
            <strong>Both folders have the same items.</strong> {n(diff.same, "item")} match by name and size.
          </p>
        ) : (
          <>
            <ul className="compare-list">
              {diff.leftOnly.length > 0 && <li>{n(diff.leftOnly.length, "item")} only in “{leftName}”</li>}
              {diff.rightOnly.length > 0 && <li>{n(diff.rightOnly.length, "item")} only in “{rightName}”</li>}
              {diff.leftNewer.length > 0 && <li>{n(diff.leftNewer.length, "file")} newer in “{leftName}”</li>}
              {diff.rightNewer.length > 0 && <li>{n(diff.rightNewer.length, "file")} newer in “{rightName}”</li>}
              {diff.differ.length > 0 && <li>{n(diff.differ.length, "file")} differ, with no telling which is newer</li>}
              <li className="dim">{n(diff.same, "item")} the same</li>
            </ul>
            <p>
              Selected what the other side is missing or has an older copy of: {n(leftSel, "item")} on the left, {n(rightSel, "item")} on the right.{" "}
              {leftSel && rightSel
                ? "Press F5 to copy the active pane’s selection across, then Tab to the other pane and press F5 again."
                : `Press F5 to copy ${leftSel + rightSel === 1 ? "it" : "them"} to the ${leftSel ? "right" : "left"}.`}
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
