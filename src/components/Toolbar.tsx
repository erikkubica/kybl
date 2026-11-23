import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Icon, type IconName } from "../Icons";
import { Breadcrumbs } from "./Breadcrumbs";
import { ProviderBadge } from "./Sidebar";
import type { Sort, SortKey } from "./FileTable";
import { useDialogs } from "../shell/useDialogs";

export const TILE_MIN = 96;
export const TILE_MAX = 320;

export function Toolbar({
  bucket,
  bucketLabel,
  bucketIcon,
  prefix,
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
  onView,
  onCompact,
  onSortChange,
  onNavigate,
  onRefresh,
  onUploadMenu,
  onMoreMenu,
  onNewFolder,
  onQuery,
  onSearch,
  onStopSearch,
  onClearSearch,
  onTogglePreview,
  dual = false,
  onPanes,
  provider,
  onSwitchConnection,
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
  prefix: string;
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
  onView: (v: "list" | "grid") => void;
  onCompact: (c: boolean) => void;
  onSortChange: (s: Sort) => void;
  onNavigate: (prefix: string) => void;
  onRefresh: () => void;
  onUploadMenu: (x: number, y: number) => void;
  /** the "…" button: Go to folder, Sync this folder, Add to favorites… */
  onMoreMenu: (x: number, y: number) => void;
  onNewFolder: () => void;
  onQuery: (q: string) => void;
  /** Enter: search this folder and everything below it */
  onSearch: (q: string) => void;
  onStopSearch: () => void;
  onClearSearch: () => void;
  onTogglePreview: () => void;
  /** more than one pane is on screen */
  dual?: boolean;
  /** the panes button (shows only with this): one pane splits right, more open the panes menu */
  onPanes?: (x: number, y: number) => void;
  /** the pane's connection kind, shown as the switcher's badge */
  provider?: string;
  /** the badge before the path: pick another connection or bucket for this pane */
  onSwitchConnection?: (x: number, y: number) => void;
  /** several panes only: this folder into the other pane, swap, compare, synchronized browsing (DualTools) */
  dualTools?: React.ReactNode;
  /** typing a path into the bar (Go to folder) */
  onGoTo?: (path: string) => void;
  /** the folder on screen is a favorite; the star toggles it */
  favorite?: boolean;
  onToggleFavorite?: () => void;
}) {
  const parts = prefix.split("/").filter(Boolean);
  const dialogs = useDialogs();
  const bar = useRef<HTMLDivElement>(null);
  // dual pane: Upload and New folder are always icons (two bars side by side); one pane: labels
  // while they fit
  const labelsFit = useLabelsFit(bar, `${view}|${dualTools ? 1 : 0}|${dual ? 1 : 0}`);
  /** grid view: one icon for the sort, its choices in a menu (as Finder's Sort By) */
  const sortMenu = (e: React.MouseEvent) => {
    const [x, y] = anchorOf(e);
    const keys: [SortKey, string][] = [
      ["name", "Name"],
      ["modified", "Date modified"],
      ["size", "Size"],
      ["kind", "Kind"],
    ];
    dialogs.menu(x, y, [
      { type: "label", label: "Sort by" },
      ...keys.map(([key, label]) => ({ type: "item" as const, label, checked: sort.key === key, onClick: () => onSortChange({ ...sort, key }) })),
      { type: "sep" },
      { type: "item", label: "Ascending", checked: sort.dir === "asc", onClick: () => onSortChange({ ...sort, dir: "asc" }) },
      { type: "item", label: "Descending", checked: sort.dir === "desc", onClick: () => onSortChange({ ...sort, dir: "desc" }) },
    ]);
  };
  const anchorOf = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [r.left, r.bottom + 4] as const;
  };

  return (
    <header className="chrome">
      <div className="toolbar" data-tauri-drag-region>
        {onSwitchConnection && (
          <button className="icon-btn conn-switch" onClick={(e) => onSwitchConnection(...anchorOf(e))} title="Switch connection or bucket" aria-label="Switch connection or bucket" aria-haspopup="menu">
            <ProviderBadge provider={provider} />
          </button>
        )}
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

      <div className={`actionbar ${view === "grid" ? "is-grid" : ""} ${labelsFit && !dual ? "" : "tight"}`} ref={bar}>
        <button className="btn btn-primary btn-sm btn-upload" disabled={disabled} onClick={(e) => onUploadMenu(...anchorOf(e))} title="Upload files or a folder (⌘U)" aria-label="Upload">
          <Icon name="upload" size={15} />
          <span className="btn-label">Upload</span>
        </button>
        <div className="tb-group">
          <button className="tool" disabled={disabled} onClick={onNewFolder} title="New folder (⇧⌘N)">
            <Icon name="folder-plus" />
            <span className="btn-label">New folder</span>
          </button>
          <button className="icon-btn" disabled={disabled} onClick={onRefresh} title="Refresh (⌘R)" aria-label="Refresh">
            <Icon name="refresh" />
          </button>
          {dualTools}
          <button className="icon-btn" disabled={disabled} onClick={(e) => onMoreMenu(...anchorOf(e))} title="More" aria-label="More actions">
            <Icon name="more" />
          </button>
        </div>

        <div className="spacer" />
        {view === "grid" && (
          <>
            <button
              className="icon-btn"
              onClick={sortMenu}
              title={`Sort by ${{ name: "name", modified: "date modified", size: "size", kind: "kind" }[sort.key]}, ${sort.dir === "asc" ? "ascending" : "descending"}`}
              aria-label="Sort"
              aria-haspopup="menu"
            >
              <Icon name="sort" size={15} />
            </button>
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
        {onPanes && (
          <button
            className={`icon-btn ${dual ? "on" : ""}`}
            onClick={(e) => onPanes(...anchorOf(e))}
            title={dual ? "Panes: split or close" : "Split right: two panes side by side (⌘\\)"}
            aria-label={dual ? "Panes" : "Split right"}
            aria-haspopup={dual ? "menu" : undefined}
          >
            <Icon name="dual-pane" />
          </button>
        )}
      </div>
      {working && <div className="progress-line" />}
    </header>
  );
}

/**
 * Whether the action bar has room for its button labels (Upload, New folder). They go when its
 * contents overflow and come back once the bar is as wide as it was with them showing, so the
 * labels stay as long as they fit instead of at a guessed breakpoint.
 */
function useLabelsFit(bar: RefObject<HTMLDivElement | null>, contents: string): boolean {
  const [fit, setFit] = useState(true);
  // other buttons on the bar (grid's Sort, dual pane's): measure afresh with the labels showing
  const [lastContents, setLastContents] = useState(contents);
  if (contents !== lastContents) {
    setLastContents(contents);
    setFit(true);
  }
  const needed = useRef(0);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const check = () => {
      if (fitRef.current) {
        if (el.scrollWidth > el.clientWidth + 1) {
          needed.current = el.scrollWidth;
          setFit(false);
        }
      } else if (el.clientWidth >= needed.current) setFit(true);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bar]);
  // the contents can change too (grid adds Sort, dual pane its buttons): look again after each render
  useLayoutEffect(() => {
    const el = bar.current;
    if (el && fit && el.scrollWidth > el.clientWidth + 1) {
      needed.current = el.scrollWidth;
      setFit(false);
    }
  });
  return fit;
}
