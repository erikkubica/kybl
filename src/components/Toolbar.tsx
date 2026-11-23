import { useRef, type RefObject } from "react";
import { Icon, type IconName } from "../Icons";
import { PathTitle } from "./PathTitle";
import { ProviderBadge } from "./Sidebar";
import type { MenuItem } from "./Dialogs";
import type { Sort, SortKey } from "./FileTable";
import { useDialogs } from "../shell/useDialogs";
import { parentPrefix } from "../format";

export const TILE_MIN = 96;
export const TILE_MAX = 320;

/**
 * A desktop pane's header: one row, left to right
 *   [connection badge] connection › … › folder name [⋯]   ……   [+] [view] [search] [panes]
 * Creating things sits behind +, the pane's less frequent actions (favorites among them) behind ⋯
 * and how the list looks behind the eye, so a pane at its least width (340px) still fits on one
 * row: the folder's name gives way first. The right side's buttons never hide.
 */
export function Toolbar({
  bucket,
  bucketLabel,
  bucketIcon,
  prefix,
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
  tile,
  onTile,
  hidden,
  onToggleHidden,
  onNavigate,
  onUp,
  onUpload,
  onMoreMenu,
  onNewFolder,
  onQuery,
  onSearch,
  onStopSearch,
  onClearSearch,
  dual = false,
  onPanes,
  panesItems,
  provider,
  connName,
  onSwitchConnection,
  onGoTo,
  favorite,
  onToggleFavorite,
}: {
  bucket: string | null;
  /** what the root is called on screen (defaults to `bucket`) */
  bucketLabel?: string | null;
  /** the root's icon (a bucket, a drive, a folder, a server), in the enclosing folders menu */
  bucketIcon?: IconName;
  prefix: string;
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
  /** grid view's tile size, for the view menu's Bigger / Smaller icons */
  tile: number;
  onTile: (px: number) => void;
  /** this computer's disk only: hidden files are showing (undefined: nothing to toggle) */
  hidden?: boolean;
  onToggleHidden?: () => void;
  onNavigate: (prefix: string) => void;
  /** up a level (the "…" crumb, ⌘↑) */
  onUp: () => void;
  onUpload: (folder: boolean) => void;
  /** the "⋯" button; `folded` are the header's own items that had no room on the row */
  onMoreMenu: (x: number, y: number, folded: MenuItem[]) => void;
  onNewFolder: () => void;
  onQuery: (q: string) => void;
  /** Enter: search this folder and everything below it */
  onSearch: (q: string) => void;
  onStopSearch: () => void;
  onClearSearch: () => void;
  /** more than one pane is on screen */
  dual?: boolean;
  /** the panes button (shows only with this): one pane splits right, more open the panes menu */
  onPanes?: (x: number, y: number) => void;
  /** the panes menu's items, for "⋯" when the panes button had to fold away */
  panesItems?: () => MenuItem[];
  /** the pane's connection kind, shown as the switcher's badge */
  provider?: string;
  /** the pane's connection, named after the badge so it's clear which server this is */
  connName?: string;
  /** the badge before the folder's name: pick another connection or bucket for this pane */
  onSwitchConnection?: (x: number, y: number) => void;
  /** typing a path into the bar (Go to folder) */
  onGoTo?: (path: string) => void;
  /** the folder on screen is a favorite; the star toggles it */
  favorite?: boolean;
  onToggleFavorite?: () => void;
}) {
  const parts = prefix.split("/").filter(Boolean);
  const dialogs = useDialogs();
  const panes = useRef<HTMLButtonElement>(null);
  const anchorOf = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [r.left, r.bottom + 4] as const;
  };
  /** a button the narrow pane's CSS folded away (it has no box then) */
  const folded = (b: RefObject<HTMLElement | null>) => !!b.current && b.current.offsetParent === null;

  const createMenu = (e: React.MouseEvent) =>
    dialogs.menu(...anchorOf(e), [
      { type: "item", label: "Upload files…", icon: "upload", hint: "⌘U", onClick: () => onUpload(false) },
      { type: "item", label: "Upload folder…", icon: "folder", hint: "⇧⌘U", onClick: () => onUpload(true) },
      { type: "sep" },
      { type: "item", label: "New folder…", icon: "folder-plus", hint: "⇧⌘N", onClick: onNewFolder },
    ]);

  const moreMenu = (e: React.MouseEvent) => {
    const extra: MenuItem[] = [];
    if (onToggleFavorite)
      extra.push({ type: "item", label: favorite ? "Remove from favorites" : "Add to favorites", icon: "star", onClick: onToggleFavorite });
    if (panesItems && folded(panes)) extra.push({ type: "submenu", label: "Panes", icon: "dual-pane", items: panesItems });
    onMoreMenu(...anchorOf(e), extra);
  };

  /** How the list looks: list or grid, compact rows, the order, and hidden files where there are any. */
  const viewMenu = (e: React.MouseEvent) => {
    const keys: [SortKey, string][] = [
      ["name", "Name"],
      ["modified", "Date modified"],
      ["size", "Size"],
      ["kind", "Kind"],
    ];
    const items: (MenuItem | false)[] = [
      { type: "item", label: "As list", icon: "list", checked: view === "list", onClick: () => onView("list") },
      { type: "item", label: "As grid", icon: "grid", checked: view === "grid", onClick: () => onView("grid") },
      { type: "item", label: "Compact layout", icon: "density", checked: compact, onClick: () => onCompact(!compact) },
      view === "grid" && { type: "item", label: "Bigger icons", hint: "⌘+", disabled: tile >= TILE_MAX, onClick: () => onTile(Math.min(TILE_MAX, tile + 24)) },
      view === "grid" && { type: "item", label: "Smaller icons", hint: "⌘−", disabled: tile <= TILE_MIN, onClick: () => onTile(Math.max(TILE_MIN, tile - 24)) },
      { type: "sep" },
      { type: "label", label: "Sort by" },
      ...keys.map(([key, label]) => ({ type: "item" as const, label, checked: sort.key === key, onClick: () => onSortChange({ ...sort, key }) })),
      { type: "sep" },
      { type: "item", label: "Ascending", checked: sort.dir === "asc", onClick: () => onSortChange({ ...sort, dir: "asc" }) },
      { type: "item", label: "Descending", checked: sort.dir === "desc", onClick: () => onSortChange({ ...sort, dir: "desc" }) },
      hidden !== undefined && !!onToggleHidden && { type: "sep" },
      hidden !== undefined && !!onToggleHidden && { type: "item", label: "Show hidden files", icon: "eye", hint: "⇧⌘.", checked: hidden, onClick: onToggleHidden },
    ];
    dialogs.menu(...anchorOf(e), items.filter((x): x is MenuItem => !!x));
  };
  const sortName = { name: "name", modified: "date modified", size: "size", kind: "kind" }[sort.key];
  const searchOpen = !!query || searchActive;

  return (
    <header className="chrome">
      <div className={`toolbar ${searchOpen ? "search-open" : ""}`} data-tauri-drag-region>
        {onSwitchConnection && (
          <>
            <button
              className="icon-btn conn-switch"
              onClick={(e) => onSwitchConnection(...anchorOf(e))}
              title={connName ? `${connName} · switch connection or bucket` : "Switch connection or bucket"}
              aria-label="Switch connection or bucket"
              aria-haspopup="menu"
            >
              <ProviderBadge provider={provider} />
            </button>
            {/* the connection's name reads as the first step of the path, and acts like one: it goes to
                the top. At the top the root's own name already says it when they match. */}
            {connName && !(parts.length === 0 && connName === (bucketLabel ?? bucket)) && (
              <>
                <button
                  type="button"
                  className="conn-name"
                  disabled={disabled || parts.length === 0}
                  onClick={() => onNavigate("")}
                  title={parts.length ? `Go to the top of ${bucketLabel ?? bucket ?? connName}` : connName}
                  // dropping items here moves them to the top, as on a breadcrumb
                  data-drop={!disabled && parts.length ? "" : undefined}
                >
                  {connName}
                </button>
                <span className="conn-sep" aria-hidden>
                  <Icon name="chevron" size={12} />
                </span>
              </>
            )}
          </>
        )}
        {/* the folders between the top and this one fold into "…": a click goes up one, and
            only shows when the parent is a folder of its own (not the top, which the name covers) */}
        {parts.length >= 2 && (
          <>
            <button
              type="button"
              className="crumb-up"
              disabled={disabled}
              onClick={onUp}
              // dropping items on it moves them up a level
              data-drop={!disabled ? parentPrefix(prefix) : undefined}
              title={`${parts[parts.length - 2]} (⌘↑)`}
              aria-label={`Enclosing folder, ${parts[parts.length - 2]}`}
            >
              …
            </button>
            <span className="conn-sep" aria-hidden>
              <Icon name="chevron" size={12} />
            </span>
          </>
        )}
        {bucket != null ? (
          <PathTitle label={bucketLabel ?? bucket} icon={bucketIcon} parts={parts} onNavigate={onNavigate} onGoTo={onGoTo} />
        ) : (
          <nav className="crumbs path-title" aria-label="Path" data-tauri-drag-region>
            <span className="crumb muted">No bucket selected</span>
          </nav>
        )}
        <button className="icon-btn tb-more" onClick={moreMenu} title="More actions" aria-label="More actions" aria-haspopup="menu">
          <Icon name="more" />
        </button>

        <div className="spacer" data-tauri-drag-region />

        <button className="icon-btn tb-create" disabled={disabled} onClick={createMenu} title="Upload or create (⌘U, ⇧⌘N)" aria-label="Upload or create" aria-haspopup="menu">
          <Icon name="plus" />
        </button>


        <button
          className="icon-btn tb-view"
          onClick={viewMenu}
          title={`View: ${view === "grid" ? "grid" : "list"}${compact ? ", compact" : ""}, sorted by ${sortName} ${sort.dir === "asc" ? "ascending" : "descending"}`}
          aria-label="View options"
          aria-haspopup="menu"
        >
          <Icon name="eye" />
        </button>

        {/* folded to its icon until clicked (or ⌘F), and while a filter or search is on it stays open */}
        <div
          className={`search ${!searchOpen ? "folded" : ""}`}
          title={!searchOpen ? "Filter, or search subfolders (⌘F)" : undefined}
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
          ) : searchOpen ? (
            <button className="icon-btn" onClick={onClearSearch} aria-label="Clear search">
              <Icon name="x" size={12} />
            </button>
          ) : (
            <kbd>⌘F</kbd>
          )}
        </div>

        {onPanes && (
          <button
            ref={panes}
            className={`icon-btn tb-panes ${dual ? "on" : ""}`}
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
