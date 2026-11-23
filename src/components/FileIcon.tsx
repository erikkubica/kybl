import type { ReactNode } from "react";
import { Icon, type IconName } from "../Icons";
import { classify, extOf } from "../format";
import type { Entry } from "../types";
import "../perms/perms.css";

function iconFor(e: Entry): IconName {
  if (e.kind === "folder") return "folder";
  switch (classify(e.name)) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "archive":
      return "archive";
    case "text":
    case "pdf":
    case "doc":
      return "text";
    default:
      return "file";
  }
}

/** Type-coloured icon for a folder or file. `big` fills its container (grid tiles, previews). */
export function FileIcon({ entry, size = 17, big, children }: { entry: Entry; size?: number; big?: boolean; children?: ReactNode }) {
  const cls = entry.kind === "folder" ? "folder" : classify(entry.name);
  return (
    <span className={`ico ico-${cls} ${big ? "big" : ""}`}>
      {cls === "folder" && (big || size >= 40) ? (
        <FolderArt size={big ? undefined : size} />
      ) : big ? (
        <DocArt ext={extOf(entry.name)}>
          <Icon name={iconFor(entry)} size={size} />
        </DocArt>
      ) : (
        <Icon name={iconFor(entry)} size={size} />
      )}
      {entry.link !== undefined && (
        <span className="ico-link" title={entry.link ? `Link to ${entry.link}` : "Link"} aria-label="Link">
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 7.2 7.2 3M4.2 3H7.2V6" />
          </svg>
        </span>
      )}
      {children}
    </span>
  );
}

/** Solid two-tone folder for large sizes, where the thin outline glyph looks empty. */
function FolderArt({ size }: { size?: number }) {
  return (
    <svg className="folder-art" viewBox="0 0 64 52" width={size} height={size ? (size * 52) / 64 : undefined} aria-hidden="true">
      <path className="fa-back" d="M3 10a6 6 0 0 1 6-6h14.2a6 6 0 0 1 4.5 2l2.6 3H55a6 6 0 0 1 6 6v9H3z" />
      <rect className="fa-front" x="3" y="14" width="58" height="35" rx="6" />
      <path className="fa-shine" d="M3.5 20.5a6 6 0 0 1 6-6h45a6 6 0 0 1 6 6" />
    </svg>
  );
}

/** A sheet of paper with a folded corner; the type glyph and extension sit on it. */
function DocArt({ ext, children }: { ext: string; children: ReactNode }) {
  return (
    <span className={`doc-art ${ext ? "has-ext" : ""}`}>
      <svg className="doc-page" viewBox="0 0 52 64" aria-hidden="true">
        <path d="M8 2.5h25.5L48.5 17.5V57.5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V6.5a4 4 0 0 1 4-4z" />
        <path className="doc-fold" d="M33.5 2.5V13.5a4 4 0 0 0 4 4h11z" />
      </svg>
      {children}
      {ext && <span className="doc-ext">{ext.slice(0, 5)}</span>}
    </span>
  );
}

/** Shared "nothing here" block for the list and grid views. */
export function EmptyState({
  searchMode,
  action,
  onUpload,
  onNewFolder,
}: {
  searchMode: boolean;
  /** a custom button row; `onUpload` / `onNewFolder` draw the standard ones instead */
  action?: ReactNode;
  onUpload?: () => void;
  onNewFolder?: () => void;
}) {
  const standard = !!(onUpload || onNewFolder);
  return (
    <div className="empty">
      <div className="empty-art">
        <Icon name={searchMode ? "search" : "folder"} size={26} />
      </div>
      <h3>{searchMode ? "No matches" : "This folder is empty"}</h3>
      <p>
        {searchMode
          ? "Nothing in this folder matches your search. Try a shorter or different term."
          : standard
            ? "Drop files here to upload them, or start with one of these."
            : "Drop files here to upload them, or use the button below."}
      </p>
      {!searchMode &&
        (standard ? (
          <div className="empty-actions">
            {onUpload && (
              <button className="btn btn-sm btn-primary" onClick={onUpload}>
                <Icon name="upload" size={14} /> Upload files
              </button>
            )}
            {onNewFolder && (
              <button className="btn btn-sm" onClick={onNewFolder}>
                <Icon name="folder-plus" size={14} /> New folder
              </button>
            )}
          </div>
        ) : (
          action
        ))}
    </div>
  );
}

const WIDTHS = [46, 62, 38, 54, 70, 42, 58, 34, 50, 66];

const CELL_WIDTHS = [44, 96, 64, 60, 90];

/** Placeholder rows while a folder loads; `columns` is how many columns follow the name. */
export function SkeletonRows({ columns = 3 }: { columns?: number }) {
  return (
    <div aria-hidden="true" className="skel-rows">
      {WIDTHS.map((w, i) => (
        <div key={i} className="skel-row" style={{ opacity: 1 - i * 0.085 }}>
          <div className="skel-name">
            <div className="skel" style={{ width: `${w}%` }} />
          </div>
          {Array.from({ length: columns }, (_, c) => (
            <div key={c} className="skel" style={{ width: CELL_WIDTHS[c % CELL_WIDTHS.length], justifySelf: c === 0 ? "end" : undefined, maxWidth: "100%" }} />
          ))}
        </div>
      ))}
    </div>
  );
}
