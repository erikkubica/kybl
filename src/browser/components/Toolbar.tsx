import { keys } from "../../ui/lib/osText";
import { bringInItems } from "../lib/bringIn";
import { useRef, type ReactNode, type RefObject } from "react";
import { Icon } from "../../ui/components/Icons";
import { PathBar } from "./PathBar";
import type { Crumb } from "../lib/crumbs";
import { ProviderBadge } from "../../sidebar/Sidebar";
import type { MenuItem } from "../../ui/components/Dialogs";
import type { Sort, SortKey } from "./list/FileTable";
import type { GroupBy } from "../../settings/settings";
import { useDialogs } from "../../shell/hooks/useDialogs";

export const TILE_MIN = 96;
export const TILE_MAX = 320;

/**
 * A desktop pane's header: one row, left to right
 *   [connection badge] connection › … › folder name   ……   [⋯] [+] [view] [search] [panes]
 * Creating things sits behind +, the pane's less frequent actions (favorites among them) behind ⋯
 * and how the list looks behind the eye, so a pane at its least width (340px) still fits on one
 * row: the folder's name gives way first. The right side's buttons never hide. The empty stretch
 * (……) is the pane's grip: dragging it moves the pane in the layout or to another workspace.
 */
export function Toolbar({
  crumbs,
  searchActive,
  searchRunning,
  query,
  searchInput,
  disabled,
  working,
  sort,
  onSortChange,
  groupBy = "none",
  onGroupBy,
  hidden,
  onToggleHidden,
  onUpload,
  onMoveHere,
  readOnly,
  onMoreMenu,
  onNewFolder,
  onNewFile,
  onQuery,
  onSearch,
  onStopSearch,
  onClearSearch,
  onLeaveDown,
  dual = false,
  onPanes,
  onTerminal,
  panesItems,
  provider,
  connName,
  switchLabel = "Switch connection or bucket",
  onSwitchConnection,
  onGoTo,
  goTo,
  favorite,
  onToggleFavorite,
  afterPath,
  searchExtras,
  searchPlaceholder,
  onGrip,
}: {
  /** the path on screen, as steps (lib/crumbs.ts); empty: no connection */
  crumbs: Crumb[];
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
  sort: Sort;
  onSortChange: (s: Sort) => void;
  /** rows in headed groups ("none": not grouped) */
  groupBy?: GroupBy;
  onGroupBy?: (g: GroupBy) => void;
  /** this computer's disk only: hidden files are showing (undefined: nothing to toggle) */
  hidden?: boolean;
  onToggleHidden?: () => void;
  onUpload: (folder: boolean) => void;
  /** this computer's pane: picked files or folders move into the folder (the + menu says Copy / Move here) */
  onMoveHere?: (folder: boolean) => void;
  /** an archive opened like a folder: nothing to upload or create */
  readOnly?: boolean;
  /** the "⋯" button; `folded` are the header's own items that had no room on the row */
  onMoreMenu: (x: number, y: number, folded: MenuItem[]) => void;
  onNewFolder: () => void;
  onNewFile?: () => void;
  onQuery: (q: string) => void;
  /** Enter: search this folder and everything below it */
  onSearch: (q: string) => void;
  onStopSearch: () => void;
  onClearSearch: () => void;
  /** ↓ in the search field moved the keyboard to the list */
  onLeaveDown?: () => void;
  /** more than one pane is on screen */
  dual?: boolean;
  /** the panes button (shows only with this): opens the panes menu (split four ways, size, close) */
  onPanes?: (x: number, y: number) => void;
  /** a terminal for this pane: in its folder, or on this computer where it can't have one */
  onTerminal?: () => void;
  /** the panes menu's items, for "⋯" when the panes button had to fold away */
  panesItems?: () => MenuItem[];
  /** the pane's connection kind, shown as the switcher's badge */
  provider?: string;
  /** the pane's connection, named after the badge so it's clear which server this is */
  connName?: string;
  /** what the badge does, in this connection's words ("Switch connection or bucket" on S3) */
  switchLabel?: string;
  /** the badge before the folder's name: pick another connection or bucket for this pane */
  onSwitchConnection?: (x: number, y: number) => void;
  /** typing a path into the bar (Go to folder) */
  onGoTo?: (path: string) => void;
  /** what typing a path starts with, and its example */
  goTo?: { initial: string; placeholder: string };
  /** the folder on screen is a favorite; the star toggles it */
  favorite?: boolean;
  onToggleFavorite?: () => void;
  /** right after the path, on the same row (the git branch chip) */
  afterPath?: ReactNode;
  /** inside the search field, before its clear button (Names / Contents) */
  searchExtras?: ReactNode;
  searchPlaceholder?: string;
  /**
   * a press on the header's empty part (not a button, the path or the badge): the start of
   * dragging the pane to another place in the layout (shell/usePaneDrag). Absent when there is
   * nowhere to move it.
   */
  onGrip?: (e: React.PointerEvent<HTMLElement>) => void;
}) {
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
      ...bringInItems(!!onMoveHere, { pickAndUpload: onUpload, pickAndMove: (d) => onMoveHere?.(d) }),
      { type: "sep" },
      { type: "item", label: "New folder…", icon: "folder-plus", hint: "⇧⌘N", onClick: onNewFolder },
      ...(onNewFile ? [{ type: "item", label: "New file…", icon: "file-plus", hint: "⌥⌘N", onClick: onNewFile } as const] : []),
    ]);

  const moreMenu = (e: React.MouseEvent) => moreMenuAt(...anchorOf(e));
  const moreMenuAt = (x: number, y: number) => {
    const extra: MenuItem[] = [];
    if (onToggleFavorite)
      extra.push({ type: "item", label: favorite ? "Remove from favorites" : "Add to favorites", icon: "star", onClick: onToggleFavorite });
    if (panesItems && folded(panes)) extra.push({ type: "submenu", label: "Panes", icon: "dual-pane", items: panesItems });
    onMoreMenu(x, y, extra);
  };

  /** How the list looks: list or grid, compact rows, the order, and hidden files where there are any. */
  const viewMenu = (e: React.MouseEvent) => {
    const keys: [SortKey, string][] = [
      ["name", "Name"],
      ["modified", "Date modified"],
      ["created", "Date created"],
      ["size", "Size"],
      ["kind", "Kind"],
      ["type", "Type"],
    ];
    const groupings: [GroupBy, string][] = [
      ["none", "None"],
      ["name", "Name"],
      ["kind", "Kind"],
      ["type", "Type"],
      ["size", "Size"],
      ["modified", "Date modified"],
      ["created", "Date created"],
    ];
    const items: (MenuItem | false)[] = [
      // list / grid, compact and the icon size are in the pane's footer (PaneStatusBar)
      { type: "label", label: "Sort by" },
      ...keys.map(([key, label]) => ({ type: "item" as const, label, checked: sort.key === key, onClick: () => onSortChange({ ...sort, key }) })),
      { type: "sep" },
      { type: "item", label: "Ascending", checked: sort.dir === "asc", onClick: () => onSortChange({ ...sort, dir: "asc" }) },
      { type: "item", label: "Descending", checked: sort.dir === "desc", onClick: () => onSortChange({ ...sort, dir: "desc" }) },
      !!onGroupBy && { type: "sep" },
      !!onGroupBy && {
        type: "submenu",
        label: groupBy === "none" ? "Group by" : `Group by: ${groupings.find(([g]) => g === groupBy)?.[1] ?? ""}`,
        icon: "list",
        items: () => groupings.map(([g, label]): MenuItem => ({ type: "item", label, checked: groupBy === g, onClick: () => onGroupBy(g) })),
      },
      hidden !== undefined && !!onToggleHidden && { type: "sep" },
      hidden !== undefined && !!onToggleHidden && { type: "item", label: "Show hidden files", icon: "eye", hint: "⇧⌘.", checked: hidden, onClick: onToggleHidden },
    ];
    dialogs.menu(...anchorOf(e), items.filter((x): x is MenuItem => !!x));
  };
  const sortName = { name: "name", modified: "date modified", created: "date created", size: "size", kind: "kind", type: "type" }[sort.key];
  const searchOpen = !!query || searchActive;

  return (
    <header
      className={`chrome ${onGrip ? "can-move" : ""}`}
      // a right-click on the header is its "…" menu, where the pointer is (the path's steps and the
      // search field keep their own)
      onContextMenu={(e) => {
        if ((e.target as Element).closest("input, textarea")) return;
        e.preventDefault();
        moreMenuAt(e.clientX, e.clientY);
      }}
      onPointerDown={
        onGrip &&
        ((e) => {
          // only the empty part: the header's own padding, the row between its items, the spacer
          const t = e.target as Element;
          if (t === e.currentTarget || t.matches(".toolbar, .toolbar > .spacer, .toolbar > .path-bar") || t.closest(".conn-sep")) onGrip(e);
        })
      }
    >
      <div className={`toolbar ${searchOpen ? "search-open" : ""}`}>
        {onSwitchConnection && (
          <>
            <button
              className="icon-btn conn-switch"
              onClick={(e) => onSwitchConnection(...anchorOf(e))}
              title={connName ? `${connName} · ${switchLabel[0].toLowerCase()}${switchLabel.slice(1)}` : switchLabel}
              aria-label={switchLabel}
              aria-haspopup="menu"
            >
              {/* no connection yet: a plain mark, not the S3 badge an unknown kind would fall back to */}
              {connName === undefined ? (
                <span className="pbadge none" aria-hidden="true">
                  <Icon name="link" size={12} />
                </span>
              ) : (
                <ProviderBadge provider={provider} />
              )}
            </button>
          </>
        )}
        <PathBar crumbs={crumbs.length ? crumbs : [{ label: "No connection", muted: true }]} onGoTo={onGoTo} goTo={goTo} after={afterPath} />

        <div className="spacer" />

        <button className="icon-btn tb-more" onClick={moreMenu} title="More actions" aria-label="More actions" aria-haspopup="menu">
          <Icon name="more" />
        </button>

        <button
          className="icon-btn tb-create"
          disabled={disabled || readOnly}
          onClick={createMenu}
          title={readOnly ? "Archives open read-only" : keys("Upload or create (⌘U, ⇧⌘N)")}
          aria-label="Upload or create"
          aria-haspopup="menu"
        >
          <Icon name="plus" />
        </button>


        <button
          className="icon-btn tb-view"
          onClick={viewMenu}
          title={`Sorted by ${sortName}, ${sort.dir === "asc" ? "ascending" : "descending"}${groupBy !== "none" ? ` · grouped` : ""}`}
          aria-label="Sort and group"
          aria-haspopup="menu"
        >
          <Icon name="sort" />
        </button>

        {/* the filter lives in its own row under this one (open while focused, or while a filter or
            search is on); here, only the way to it */}
        <button
          className={`icon-btn tb-search ${searchOpen ? "on" : ""}`}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const f = searchInput.current;
            if (!f) return;
            // open and empty: a second click puts it away
            if (document.activeElement === f && !query) f.blur();
            else f.focus();
          }}
          title={keys("Filter, or search subfolders (⌘F)")}
          aria-label="Filter or search"
          aria-pressed={searchOpen}
        >
          <Icon name="search" />
        </button>

        {onTerminal && (
          <button className="icon-btn tb-terminal" onClick={onTerminal} title={keys("Terminal (⌘J)")} aria-label="Terminal">
            <Icon name="terminal" />
          </button>
        )}

        {onPanes && (
          <button
            ref={panes}
            // a menu, not a toggle: no "on" look whatever the number of panes
            className="icon-btn tb-panes"
            onClick={(e) => onPanes(...anchorOf(e))}
            title={dual ? "Panes: split, size or close" : "Split: add a pane right, below, left or above"}
            aria-label="Panes"
            aria-haspopup="menu"
          >
            <Icon name="dual-pane" />
          </button>
        )}
      </div>
      {/* the filter row: folded to nothing until ⌘F or the magnifier focuses it, open while a
          filter or search is on, so it never squeezes the path and buttons above */}
      <div className={`search-row ${searchOpen ? "open" : ""}`}>
        <div
          className="search"
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
                // hand the keyboard to the list (a blur alone would leave it on the page)
                e.preventDefault();
                e.currentTarget.closest(".browser-pane")?.querySelector<HTMLElement>("[data-list-focus]")?.focus({ preventScroll: true });
                onLeaveDown?.();
              }
            }}
            placeholder={searchPlaceholder ?? "Filter, ↵ to search subfolders"}
            aria-label="Filter this folder, or press Return to search its subfolders"
            spellCheck={false}
          />
          {searchExtras}
          {searchRunning ? (
            <button className="icon-btn search-stop" onClick={onStopSearch} title="Stop searching" aria-label="Stop searching">
              <span className="spinner" />
            </button>
          ) : searchOpen ? (
            <button className="icon-btn" onClick={onClearSearch} aria-label="Clear search">
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </div>
      </div>
      {working && <div className="progress-line" />}
    </header>
  );
}
