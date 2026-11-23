/**
 * The info column's lines for what a server says about an item (EntryInfo, inside its `props`
 * list): the permissions ("rw-r--r-- 644"), owner and group, and where a link points.
 */
import type { Entry } from "../types";
import { modeOctal, modeText } from "./permsApi";
import "./perms.css";

export function ServerProps({ entry, onPermissions, onShowOriginal }: { entry: Entry; onPermissions?: () => void; onShowOriginal?: () => void }) {
  const who = [entry.owner, entry.group].filter(Boolean).join(" · ");
  return (
    <>
      {entry.link !== undefined && (
        <div className="prop">
          <dt>Link to</dt>
          <dd className="perm-dd">
            <span className="mono" title={entry.link}>{entry.link || "?"}</span>
            {onShowOriginal && (
              <button type="button" className="link-btn" onClick={onShowOriginal}>
                Show original
              </button>
            )}
          </dd>
        </div>
      )}
      {(entry.mode !== undefined || onPermissions) && (
        <div className="prop">
          <dt>Permissions</dt>
          <dd className="perm-dd">
            {entry.mode !== undefined ? (
              <span className="mono">
                {modeText(entry.mode)} <span className="faint">{modeOctal(entry.mode)}</span>
              </span>
            ) : (
              <span className="faint">Not listed</span>
            )}
            {onPermissions && (
              <button type="button" className="link-btn" onClick={onPermissions}>
                Change…
              </button>
            )}
          </dd>
        </div>
      )}
      {who && (
        <div className="prop">
          <dt>Owner</dt>
          <dd>{who}</dd>
        </div>
      )}
    </>
  );
}
