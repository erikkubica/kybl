import type { RefObject } from "react";
import { Icon, type IconName } from "../Icons";
import { Breadcrumbs } from "./Breadcrumbs";
import type { Sort, SortKey } from "./FileTable";

export const TILE_MIN = 96;
export const TILE_MAX = 320;

export function Toolbar({
  bucket,
  bucketLabel,
  bucketIcon,
  canShare = true,
  prefix,
  selectionCount,
  singleFileSelected,
  previewOpen,
  searchActive,
  searchRunning,
  query,
  searchInput,
  disabled,
  working,
  view,
  compact,
  sort,
  tileSize,
  onView,
  onCompact,
  onSortChange,
  onTileSize,
  onNavigate,
  onRefresh,
  onUploadMenu,
  onMoreMenu,
  onNewFolder,
  onDownload,
  onCopyLink,
  onRename,
  onMoveTo,
  onDelete,
  onQuery,
  onSearch,
  onStopSearch,
  onClearSearch,
  onTogglePreview,
  dual = false,
  onToggleDual,
  onGoTo,
  favorite,
  onToggleFavorite,
  dualTools,
}: {
  bucket: string | null;
  /** what the root is called on screen (defaults to `bucket`) */
  bucketLabel?: string | null;
  /** the root's icon in the breadcrumbs (a bucket, a drive, a folder, a server) */
  bucketIcon?: IconName;
  /** the connection can make share links (false hides "Copy link") */
  canShare?: boolean;
  prefix: string;
  selectionCount: number;
  singleFileSelected: boolean;
  previewOpen: boolean;
  /** showing deep search results */
  searchActive: boolean;
  /** a deep search is still scanning */
  searchRunning: boolean;
  /** text in the search field; filters the folder on screen as you type */
  query: string;
  /** the search field, so ⌘F (handled by App with the other shortcuts) can focus it */
  searchInput: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  /** something is loading: show the thin progress line */
  working: boolean;
  view: "list" | "grid";
  /** denser rows, applies to both views */
  compact: boolean;
  sort: Sort;
  /** grid tile width in px */
  tileSize: number;
  onView: (v: "list" | "grid") => void;
  onCompact: (c: boolean) => void;
  onSortChange: (s: Sort) => void;
  onTileSize: (px: number) => void;
  onNavigate: (prefix: string) => void;
  onRefresh: () => void;
  onUploadMenu: (x: number, y: number) => void;
  /** the "…" button: Go to folder, Sync this folder, Add to favorites… */
  onMoreMenu: (x: number, y: number) => void;
  onNewFolder: () => void;
  /** absent on this computer's own disk: there is nothing to download */
  onDownload?: () => void;
  onCopyLink: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
  onQuery: (q: string) => void;
  /** Enter: search this folder and everything below it */
  onSearch: (q: string) => void;
  onStopSearch: () => void;
  onClearSearch: () => void;
  onTogglePreview: () => void;
  /** two panes side by side are on screen */
  dual?: boolean;
  /** switches between one pane and two (the button shows only with this) */
  onToggleDual?: () => void;
  /** dual pane only: this folder into the other pane, swap, compare, synchronized browsing (DualTools) */
  dualTools?: React.ReactNode;
  /** typing a path into the bar (Go to folder) */
  onGoTo?: (path: string) => void;
  /** the folder on screen is a favorite; the star toggles it */
  favorite?: boolean;
  onToggleFavorite?: () => void;
}) {
  const parts = prefix.split("/").filter(Boolean);
  const hasSel = selectionCount > 0;
  const anchorOf = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [r.left, r.bottom + 4] as const;
  };

  return (
    <header className="chrome">
      <div className="toolbar" data-tauri-drag-region>
        {/* no ← → ↑ buttons: the path is one click per level, ".." and ⌘↑ go up, ⌘[ ⌘] and the mouse's side buttons go back and forward */}
        {bucket != null ? (
          <>
            <Breadcrumbs bucket={bucket} label={bucketLabel ?? bucket} icon={bucketIcon} parts={parts} onNavigate={onNavigate} onGoTo={onGoTo} />
            {onToggleFavorite && (
              <button
                className={`icon-btn fav-star ${favorite ? "on" : ""}`}
                onClick={onToggleFavorite}
                title={favorite ? "Remove from favorites" : "Add to favorites"}
                aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={!!favorite}
              >
                <Icon name="star" size={15} />
              </button>
            )}
          </>
        ) : (
          <nav className="crumbs" aria-label="Path" data-tauri-drag-region>
            <span className="crumb muted">No bucket selected</span>
          </nav>
        )}

        {/* folded to its icon until clicked (or ⌘F), and while a filter or search is on it stays open */}
        <div
          className={`search ${!query && !searchActive ? "folded" : ""}`}
          title={!query && !searchActive ? "Filter, or search subfolders (⌘F)" : undefined}
          onMouseDown={(e) => {
            if (disabled || (e.target as HTMLElement).closest("input, button")) return;
            e.preventDefault();
            searchInput.current?.focus();
          }}
        >
          <Icon name="search" size={14} />
          <input
            ref={searchInput}
            value={query}
            disabled={disabled}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter that confirms an input method's composition isn't a search
              if (e.key === "Enter" && !e.nativeEvent.isComposing && query.trim()) onSearch(query.trim());
              if (e.key === "Escape") {
                e.stopPropagation();
                onClearSearch();
                searchInput.current?.blur();
              }
              if (e.key === "ArrowDown") {
                // hand the keyboard to the list
                e.preventDefault();
                searchInput.current?.blur();
              }
            }}
            placeholder="Filter, ↵ to search subfolders"
            aria-label="Filter this folder, or press Return to search its subfolders"
            spellCheck={false}
          />
          {searchRunning ? (
            <button className="icon-btn search-stop" onClick={onStopSearch} title="Stop searching" aria-label="Stop searching">
              <span className="spinner" />
            </button>
          ) : query || searchActive ? (
            <button className="icon-btn" onClick={onClearSearch} aria-label="Clear search">
              <Icon name="x" size={12} />
            </button>
          ) : (
            <kbd>⌘F</kbd>
          )}
        </div>
      </div>

      <div className={`actionbar ${view === "grid" ? "is-grid" : ""}`}>
        <button className="btn btn-primary btn-sm btn-square" disabled={disabled} onClick={(e) => onUploadMenu(...anchorOf(e))} title="Upload files or a folder (⌘U)" aria-label="Upload">
          <Icon name="upload" size={15} />
        </button>
        <div className="tb-group">
          <button className="tool" disabled={disabled} onClick={onNewFolder} title="New folder (⇧⌘N)">
            <Icon name="folder-plus" />
            <span>New folder</span>
          </button>
          <button className="icon-btn" disabled={disabled} onClick={onRefresh} title="Refresh (⌘R)" aria-label="Refresh">
            <Icon name="refresh" />
          </button>
          {dualTools}
          <button className="icon-btn" disabled={disabled} onClick={(e) => onMoreMenu(...anchorOf(e))} title="More" aria-label="More actions">
            <Icon name="more" />
          </button>
        </div>

        {hasSel && (
          <>
            <div className="tb-sep" />
            <div className="sel-actions">
              {/* the count (and a ×) sits in the status line under the list */}
              {onDownload && (
                <button className="tool" onClick={onDownload} title="Download">
                  <Icon name="download" />
                  <span>Download</span>
                </button>
              )}
              {singleFileSelected && canShare && (
                <button className="tool" onClick={onCopyLink} title="Copy a share link">
                  <Icon name="link" />
                  <span>Copy link</span>
                </button>
              )}
              <button className="tool" onClick={onMoveTo} title="Move or copy to another folder or bucket">
                <Icon name="move" />
                <span>Move to…</span>
              </button>
              {selectionCount === 1 && (
                <button className="tool" onClick={onRename} title="Rename">
                  <Icon name="edit" />
                  <span>Rename</span>
                </button>
              )}
              <button className="tool danger" onClick={onDelete} title="Delete (⌘⌫)">
                <Icon name="trash" />
                <span>Delete</span>
              </button>
            </div>
          </>
        )}

        <div className="spacer" />
        {view === "grid" && (
          <>
            <label className="tile-slider" title="Thumbnail size">
              <Icon name="image" size={12} />
              <input
                type="range"
                min={TILE_MIN}
                max={TILE_MAX}
                step={8}
                value={tileSize}
                onChange={(e) => onTileSize(Number(e.target.value))}
                aria-label="Thumbnail size"
              />
              <Icon name="image" size={16} />
            </label>
            <div className="tb-group">
              <select className="sort-select" value={sort.key} onChange={(e) => onSortChange({ ...sort, key: e.target.value as SortKey })} aria-label="Sort by">
                <option value="name">Name</option>
                <option value="modified">Date</option>
                <option value="size">Size</option>
                <option value="kind">Kind</option>
              </select>
              <button
                className="icon-btn"
                onClick={() => onSortChange({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
                title={sort.dir === "asc" ? "Ascending" : "Descending"}
                aria-label="Toggle sort direction"
              >
                <Icon name="sort" size={15} />
              </button>
            </div>
          </>
        )}
        <button
          className={`icon-btn ${compact ? "on" : ""}`}
          onClick={() => onCompact(!compact)}
          title={compact ? "Compact layout: on" : "Compact layout: off"}
          aria-label="Compact layout"
          aria-pressed={compact}
        >
          <Icon name="density" />
        </button>
        <div className="seg" role="group" aria-label="View">
          <button className={view === "list" ? "on" : ""} onClick={() => onView("list")} title="List view" aria-label="List view" aria-pressed={view === "list"}>
            <Icon name="list" size={15} />
          </button>
          <button className={view === "grid" ? "on" : ""} onClick={() => onView("grid")} title="Grid view" aria-label="Grid view" aria-pressed={view === "grid"}>
            <Icon name="grid" size={15} />
          </button>
        </div>
        <button className={`icon-btn ${previewOpen ? "on" : ""}`} onClick={onTogglePreview} title="Toggle details panel (⌘I)" aria-label="Toggle details panel" aria-pressed={previewOpen}>
          <Icon name="panel" />
        </button>
        {onToggleDual && (
          <button
            className={`icon-btn ${dual ? "on" : ""}`}
            onClick={onToggleDual}
            title={dual ? "Back to one pane (⌘\\)" : "Two panes side by side (⌘\\)"}
            aria-label="Two panes"
            aria-pressed={dual}
          >
            <Icon name="dual-pane" />
          </button>
        )}
      </div>
      {working && <div className="progress-line" />}
    </header>
  );
}
