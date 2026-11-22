/** The smaller pieces of a browser pane: banners above the list, the status bar and the drag ghost. */
import { formatBytes } from "../format";
import { rootName } from "../connections/roots";
import { destLabel } from "../moving";
import { Icon } from "../Icons";
import type { DragState } from "../useItemDrag";
import { MAX_SORT_ITEMS } from "./useEntries";
import type { Pane } from "./usePane";

/** Deep-search results, the filter's match count, and a failed reload above rows still shown. */
export function PaneBanners({ pane }: { pane: Pane }) {
  const { ent, actions } = pane;
  const { search, entries, filter, fresh, listError, moreOnServer } = ent;
  return (
    <>
      {search && (
        <div className="banner">
          {search.running && !search.stopped ? <span className="spinner" /> : <Icon name="search" size={14} />}
          <span>
            <strong>
              {entries.length.toLocaleString()} {entries.length === 1 ? "result" : "results"}
            </strong>{" "}
            for “{search.query}” in <code>/{search.loc.prefix}</code>
            {search.running && !search.stopped
              ? ` · searching, ${search.scanned.toLocaleString()} objects checked so far`
              : search.stopped
                ? " · stopped early"
                : search.truncated
                  ? " · showing the first matches only, refine your search"
                  : ` · ${search.scanned.toLocaleString()} objects checked`}
          </span>
          {search.running && !search.stopped ? (
            <button className="btn btn-sm" onClick={ent.sr.stop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={actions.clearSearch}>
              Clear search
            </button>
          )}
        </div>
      )}
      {!search && filter && fresh && (
        <div className="banner">
          <Icon name="search" size={14} />
          <span>
            <strong>
              {entries.length.toLocaleString()} of {ent.allEntries.length.toLocaleString()}
            </strong>{" "}
            {moreOnServer ? "loaded items" : "items"} in this folder match “{ent.query.trim()}”
          </span>
          <button className="btn btn-sm" onClick={() => actions.doSearch(ent.query.trim())}>
            Search subfolders too
          </button>
        </div>
      )}
      {listError && entries.length > 0 && (
        <div className="banner error">
          <Icon name="alert" size={14} />
          <span>{listError}</span>
          <button className="btn btn-sm" onClick={ent.refresh}>
            <Icon name="retry" size={13} /> Retry
          </button>
        </div>
      )}
    </>
  );
}

/** Item count and size, the selection, the whole folder's size and what is loading. */
export function PaneStatusBar({ pane }: { pane: Pane }) {
  const { ent, sel, busy, prefix } = pane;
  const { entries, search, stale, filter, moreOnServer, lst, needsAll, loadedCount, sortCapped, hasMore } = ent;
  const { selected, selectedEntries } = sel;
  const totalSize = entries.reduce((s, e) => s + (e.kind === "file" ? e.size : 0), 0);
  const hereSize = pane.folderSizes.get(prefix);
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
          {selectedEntries.some((e) => e.kind === "file") ? ` (${formatBytes(selectedEntries.reduce((s, e) => s + (e.kind === "file" ? e.size : 0), 0))})` : ""}
        </span>
      )}
      {hereSize && !search && !stale && (
        <span title={hereSize.error}>
          ·{" "}
          {hereSize.state === "done"
            ? `Whole folder: ${formatBytes(hereSize.bytes)} in ${hereSize.objects.toLocaleString()} objects`
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
      {busy && (
        <span className="busy">
          <span className="spinner" /> {busy}
        </span>
      )}
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
          {drag.dest != null
            ? drag.label != null
              ? // into the other pane: copies, like a drop into another bucket (⌘ moves)
                `${drag.copy ? "Copy" : "Move"} to ${drag.label}${drag.copy && !drag.copyOnly ? " · ⌘ to move" : ""}`
              : // Finder's rule: within a bucket a drop moves (⌥ copies), into another bucket it copies (⌘ moves)
                `${drag.copy ? "Copy" : "Move"} to ${drag.bucket != null ? rootName(profileId, drag.bucket) : destLabel(drag.dest, bucket ?? "", profileId)}${drag.bucket ? (drag.copy ? " · ⌘ to move" : "") : drag.copy ? "" : " · ⌥ to copy"}`
            : "Drop on a folder or a bucket"}
        </span>
      </span>
    </div>
  );
}
