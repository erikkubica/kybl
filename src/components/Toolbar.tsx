import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icons";
import { Breadcrumbs } from "./Breadcrumbs";
import type { Sort, SortKey } from "./FileTable";

export function Toolbar({
  bucket,
  prefix,
  canUp,
  selectionCount,
  singleFileSelected,
  previewOpen,
  searchActive,
  disabled,
  working,
  view,
  compact,
  sort,
  onView,
  onCompact,
  onSortChange,
  onNavigate,
  onUp,
  onRefresh,
  onUploadMenu,
  onNewFolder,
  onDownload,
  onCopyLink,
  onRename,
  onMoveTo,
  onDelete,
  onSearch,
  onClearSearch,
  onTogglePreview,
  onClearSelection,
}: {
  bucket: string | null;
  prefix: string;
  canUp: boolean;
  selectionCount: number;
  singleFileSelected: boolean;
  previewOpen: boolean;
  searchActive: boolean;
  disabled: boolean;
  /** something is loading: show the thin progress line */
  working: boolean;
  view: "list" | "grid";
  /** denser rows / smaller tiles, applies to both views */
  compact: boolean;
  sort: Sort;
  onView: (v: "list" | "grid") => void;
  onCompact: (c: boolean) => void;
  onSortChange: (s: Sort) => void;
  onNavigate: (prefix: string) => void;
  onUp: () => void;
  onRefresh: () => void;
  onUploadMenu: (x: number, y: number) => void;
  onNewFolder: () => void;
  onDownload: () => void;
  onCopyLink: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
  onSearch: (q: string) => void;
  onClearSearch: () => void;
  onTogglePreview: () => void;
  onClearSelection: () => void;
}) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const parts = prefix.split("/").filter(Boolean);

  useEffect(() => {
    if (!searchActive) setQ("");
  }, [searchActive]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hasSel = selectionCount > 0;

  return (
    <header className="chrome">
      <div className="toolbar" data-tauri-drag-region>
        <button className="icon-btn" onClick={onUp} disabled={!canUp} title="Up one level (⌫)" aria-label="Up one level">
          <Icon name="arrow-up" />
        </button>
        {bucket ? (
          <Breadcrumbs bucket={bucket} parts={parts} onNavigate={onNavigate} />
        ) : (
          <nav className="crumbs" aria-label="Path" data-tauri-drag-region>
            <span className="crumb muted">No bucket selected</span>
          </nav>
        )}

        <div className="search">
          <Icon name="search" size={14} />
          <input
            ref={input}
            value={q}
            disabled={disabled}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim()) onSearch(q.trim());
              if (e.key === "Escape") {
                setQ("");
                onClearSearch();
                input.current?.blur();
              }
            }}
            placeholder="Search this folder"
            aria-label="Search this folder"
            spellCheck={false}
          />
          {q || searchActive ? (
            <button
              className="icon-btn"
              onClick={() => {
                setQ("");
                onClearSearch();
              }}
              aria-label="Clear search"
            >
              <Icon name="x" size={12} />
            </button>
          ) : (
            <kbd>⌘F</kbd>
          )}
        </div>
      </div>

      <div className={`actionbar ${view === "grid" ? "is-grid" : ""}`}>
        <button
          className="btn btn-primary btn-sm"
          disabled={disabled}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onUploadMenu(r.left, r.bottom + 4);
          }}
        >
          <Icon name="upload" size={14} />
          Upload
        </button>
        <div className="tb-group">
          <button className="tool" disabled={disabled} onClick={onNewFolder} title="New folder">
            <Icon name="folder-plus" />
            <span>New folder</span>
          </button>
          <button className="icon-btn" disabled={disabled} onClick={onRefresh} title="Refresh (⌘R)" aria-label="Refresh">
            <Icon name="refresh" />
          </button>
        </div>

        {hasSel && (
          <>
            <div className="tb-sep" />
            <div className="sel-actions">
              <span className="sel-chip">
                {selectionCount} selected
                <button onClick={onClearSelection} title="Clear selection (Esc)" aria-label="Clear selection">
                  <Icon name="x" size={11} />
                </button>
              </span>
              <button className="tool" onClick={onDownload} title="Download">
                <Icon name="download" />
                <span>Download</span>
              </button>
              {singleFileSelected && (
                <button className="tool" onClick={onCopyLink} title="Copy a share link">
                  <Icon name="link" />
                  <span>Copy link</span>
                </button>
              )}
              <button className="tool" onClick={onMoveTo} title="Move or copy to another folder">
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
            <div className="tb-group">
              <select className="sort-select" value={sort.key} onChange={(e) => onSortChange({ ...sort, key: e.target.value as SortKey })} aria-label="Sort by">
                <option value="name">Name</option>
                <option value="modified">Date</option>
                <option value="size">Size</option>
                <option value="kind">Kind</option>
              </select>
              <button
                className="icon-btn"
                onClick={() =>
                  onSortChange({
                    ...sort,
                    dir: sort.dir === "asc" ? "desc" : "asc",
                  })
                }
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
        <button className={`icon-btn ${previewOpen ? "on" : ""}`} onClick={onTogglePreview} title="Toggle details panel" aria-label="Toggle details panel" aria-pressed={previewOpen}>
          <Icon name="panel" />
        </button>
      </div>
      {working && <div className="progress-line" />}
    </header>
  );
}
