/** The smaller pieces of a browser pane: banners above the list, the status bar and the drag ghost. */
import { keys } from "../../ui/lib/osText";
import { formatBytes, sumSizes, hasSize, plural } from "../../core/format";
import { rootName } from "../../connections/lib/roots";
import { destLabel } from "../../transfers/lib/moving";
import { Icon } from "../../ui/components/Icons";
import { errDetail, errSummary } from "../../core/api";
import { errorHint, freshConnection } from "../../log/connLog";
import { classifyError } from "../../log/logText.ts";
import type { DragState } from "../hooks/useItemDrag";
import { MAX_SORT_ITEMS } from "../hooks/useEntries";
import { regexProblem } from "../lib/nameMatch";
import type { Pane } from "../hooks/usePane";

/** Deep-search results, the filter's match count, and a failed reload above rows still shown. */
export function PaneBanners({ pane }: { pane: Pane }) {
  const { ent, actions } = pane;
  const { search, entries, filter, fresh, listError, moreOnServer } = ent;
  return (
    <>
      {search && (
        <div className="banner">
          {search.running && !search.stopped ? <span className="spinner" /> : <Icon name={search.unavailable ? "alert" : "search"} size={14} />}
          {search.unavailable ? (
            <span>{search.unavailable}</span>
          ) : search.mode === "contents" ? (
            <span>
              <strong>
                {entries.length.toLocaleString()} {entries.length === 1 ? "file" : "files"}
              </strong>
              {search.matches ? ` · ${search.matches.toLocaleString()} matching ${search.matches === 1 ? "line" : "lines"}` : ""} for “{search.query}” in{" "}
              <code>/{search.loc.prefix}</code>
              {search.running && !search.stopped
                ? " · searching inside files…"
                : search.stopped
                  ? " · stopped early"
                  : search.truncated
                    ? " · showing the first files only, refine your search"
                    : search.engine
                      ? ` · searched with ${search.engine}`
                      : ""}
            </span>
          ) : (
            <span>
              <strong>
                {entries.length.toLocaleString()} {entries.length === 1 ? "result" : "results"}
              </strong>{" "}
              for “{search.query}” in <code>/{search.loc.prefix}</code>
              {search.running && !search.stopped
                ? ` · searching, ${plural(search.scanned, "object")} checked so far`
                : search.stopped
                  ? " · stopped early"
                  : search.truncated
                    ? " · showing the first matches only, refine your search"
                    : ` · ${plural(search.scanned, "object")} checked`}
            </span>
          )}
          {/* Stop keeps what was found; Clear (also while it runs) goes back to the folder */}
          {search.running && !search.stopped && (
            <button className="btn btn-sm" onClick={ent.sr.stop}>
              Stop
            </button>
          )}
          <button className="btn btn-sm" onClick={actions.clearSearch}>
            Clear
          </button>
        </div>
      )}
      {!search && filter && fresh && (
        <div className="banner">
          <Icon name={regexProblem(filter, ent.sr.regex) ? "alert" : "search"} size={14} />
          {regexProblem(filter, ent.sr.regex) ? (
            <span>Invalid expression: {regexProblem(filter, ent.sr.regex)}</span>
          ) : (
            <span>
              <strong>
                {entries.length.toLocaleString()} of {ent.allEntries.length.toLocaleString()}
              </strong>{" "}
              {moreOnServer ? "loaded items" : "items"} in this folder match {ent.sr.regex ? <code>/{filter}/</code> : `“${ent.query.trim()}”`}
              {ent.sr.caseSensitive ? " (match case)" : ""}
            </span>
          )}
          <button className="btn btn-sm" onClick={() => actions.doSearch(ent.query.trim())}>
            Include folders
          </button>
        </div>
      )}
      {listError && entries.length > 0 && (
        <div className="banner error" role="alert">
          <Icon name="alert" size={14} />
          <span title={errDetail(listError) ?? undefined}>
            {errSummary(listError)}
            {errorHint(listError) && ` ${errorHint(listError)}`}
          </span>
          <button
            className="btn btn-sm"
            onClick={async () => {
              // a timeout or a dropped network: a fresh connection, so it really reconnects
              if (classifyError(listError).network && pane.profile) await freshConnection(pane.profile.id);
              ent.refresh();
            }}
          >
            <Icon name="retry" size={13} /> Try again
          </button>
        </div>
      )}
    </>
  );
}

/** Item count and size, the selection, the whole folder's size and what is loading. */
export function PaneStatusBar({ pane }: { pane: Pane }) {
  const { ent, sel, busy, busyStop, prefix } = pane;
  const { entries, search, stale, filter, moreOnServer, lst, needsAll, loadedCount, sortCapped, hasMore } = ent;
  const { selected, selectedEntries } = sel;
  const totalSize = sumSizes(entries);
  const hereSize = pane.folderSizes.get(prefix);
  const folderOpen = !!pane.profile && pane.bucket != null;
  return (
    <footer className="statusbar">
      {stale ? (
        <span>Loading…</span>
      ) : (
        <span>
          {entries.length.toLocaleString()}
          {moreOnServer && !filter ? "+" : ""} {entries.length === 1 && !moreOnServer ? "item" : "items"}
          {totalSize > 0 ? ` · ${formatBytes(totalSize)}` : ""}
        </span>
      )}
      {selected.size > 0 && (
        <span className="sel">
          · {selected.size} selected
          {selectedEntries.some(hasSize) ? ` (${formatBytes(sumSizes(selectedEntries))})` : ""}
          <button className="sel-clear" onClick={() => sel.clear()} title="Clear selection (Esc)" aria-label="Clear selection">
            <Icon name="x" size={10} />
          </button>
        </span>
      )}
      {hereSize && !search && !stale && (
        <span title={hereSize.error}>
          ·{" "}
          {hereSize.state === "done"
            ? `Whole folder: ${formatBytes(hereSize.bytes)} in ${hereSize.objects.toLocaleString()} ${hereSize.objects === 1 ? "object" : "objects"}`
            : hereSize.state === "loading"
              ? `Adding up the folder… ${formatBytes(hereSize.bytes)} so far`
              : "Couldn’t work out the folder size"}
        </span>
      )}
      <span className="spacer" />
      {lst.pulling && !busy && !search && (
        <span className="busy">
          <span className="spinner" /> {needsAll ? "Loading the whole folder to sort it" : "Loading the rest of the folder"}… {loadedCount.toLocaleString()} so far
        </span>
      )}
      {sortCapped && !busy && <span>Sorted the first {MAX_SORT_ITEMS.toLocaleString()} items only</span>}
      {hasMore && !lst.loading && !busy && <span title="S3 lists big folders in pages">In order: the first {loadedCount.toLocaleString()} items. More load as you scroll</span>}
      {pane.folderSizes.loading > 0 && !busy && (
        <span className="busy">
          <span className="spinner" /> Adding up {pane.folderSizes.loading === 1 ? "a folder" : `${pane.folderSizes.loading.toLocaleString()} folders`}…
          <button type="button" className="btn btn-sm btn-ghost" onClick={pane.folderSizes.cancelAll}>
            Stop
          </button>
        </span>
      )}
      {busy && (
        <span className="busy">
          <span className="spinner" /> {busy}
          {busyStop && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={busyStop}>
              Stop
            </button>
          )}
        </span>
      )}
      {/* how the list looks: list or grid, and compact (the grid's icon size: ⌘+ / ⌘−, or a pinch) */}
      <span className="sb-view">
        <button type="button" className={`statusbar-btn ${pane.view === "list" ? "on" : ""}`} onClick={() => pane.setView("list")} aria-pressed={pane.view === "list"} title="As list" aria-label="As list">
          <Icon name="list" size={14} />
        </button>
        <button type="button" className={`statusbar-btn ${pane.view === "grid" ? "on" : ""}`} onClick={() => pane.setView("grid")} aria-pressed={pane.view === "grid"} title="As grid" aria-label="As grid">
          <Icon name="grid" size={14} />
        </button>
        <button type="button" className={`statusbar-btn ${pane.compact ? "on" : ""}`} onClick={() => pane.setCompact(!pane.compact)} aria-pressed={pane.compact} title="Compact layout" aria-label="Compact layout">
          <Icon name="density" size={14} />
        </button>
      </span>
      {/* the folder's info panel (connection, path, git), remembered for this pane */}
      <button
        type="button"
        className={`statusbar-btn ${pane.infoOpen && folderOpen ? "on" : ""}`}
        onClick={() => pane.setInfoOpen(!pane.infoOpen)}
        // the panel only shows inside a folder: a connection's bucket list has none
        disabled={!folderOpen}
        aria-pressed={pane.infoOpen && folderOpen}
        title={!folderOpen ? "Open a folder to see its info" : pane.infoOpen ? "Hide folder info" : "Show folder info"}
        aria-label="Folder info"
      >
        <Icon name="panel-right" size={14} />
      </button>
    </footer>
  );
}

/** What follows the pointer while items are dragged, and what a drop would do. */
export function DragGhost({ drag, bucket, profileId }: { drag: DragState; bucket: string | null; profileId: string }) {
  return (
    <div className="drag-ghost" style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 12}px)` }} aria-hidden="true">
      <span className="drag-stack">
        <Icon name={drag.items.length === 1 && drag.items[0].kind === "file" ? "file" : "folder"} size={14} />
        {drag.items.length > 1 && <span className="drag-count">{drag.items.length}</span>}
      </span>
      <span className="drag-text">
        <strong>{drag.items.length === 1 ? drag.items[0].name : `${drag.items.length} items`}</strong>
        <span>
          {drag.dest != null && drag.say
            ? drag.say
            : drag.dest != null
            ? drag.label != null
              ? // into the other pane: moves (⌥ copies), unless that place only takes copies
                `${drag.copy ? "Copy" : "Move"} to ${drag.label}${drag.copy || drag.copyOnly ? "" : keys(" · ⌥ to copy")}`
              : // a drop moves; ⌥ copies
                `${drag.copy ? "Copy" : "Move"} to ${drag.bucket != null ? rootName(profileId, drag.bucket) : destLabel(drag.dest, bucket ?? "", profileId)}${drag.copy ? "" : keys(" · ⌥ to copy")}`
            : (drag.note ?? "Drop on a folder")}
        </span>
      </span>
    </div>
  );
}
