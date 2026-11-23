/**
 * One browser pane on screen: its toolbar (navigation, path, search, actions), banners, the list
 * or grid with its empty and error states, the status bar, Quick Look and the drag ghost. All
 * state lives in the pane object from usePane; this only draws it.
 */
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../Icons";
import { Toolbar } from "../components/Toolbar";
import { rootIcon } from "../connections/roots";
import { FileTable, type SortKey } from "../components/FileTable";
import { GridView } from "../components/GridView";
import { QuickLook } from "../desktop/QuickLook";
import type { Settings } from "../settings";
import { ChooseBucket, ListError, Welcome, type EmptyActions } from "./PaneEmpty";
import { DragGhost, PaneBanners, PaneStatusBar } from "./PaneParts";
import type { Pane } from "./usePane";
import { useImageModes } from "../imageMode";

/** the clipboard takes files on macOS only for now (see platform.rs) */
const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);

export type BrowserPaneProps = {
  pane: Pane;
  /** the pane the keyboard, menus and sidebar act on */
  active: boolean;
  /** several panes on screen (the active one is marked) */
  dual: boolean;
  /** what screen readers call this pane among several ("Pane 2 of 3") */
  label?: string;
  /** several panes: its buttons in the toolbar (shell/SplitLayout DualTools) */
  dualTools?: React.ReactNode;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  previewOpen: boolean;
  onTogglePreview: () => void;
  /** the panes button: split, or the panes menu */
  onPanes?: (x: number, y: number) => void;
  /** the badge before the path: another connection or bucket in this pane */
  onSwitchConnection?: (x: number, y: number) => void;
  /** files dragged in from the computer would land here */
  dropUpload: boolean;
  /** the sidebar's note for a connection with no bucket open (and whether to offer to reconnect) */
  bucketNote: string | null;
  bucketReconnect: boolean;
  empty: EmptyActions;
  /** drawn next to the list: the details pane in single-pane mode */
  aside?: ReactNode;
  contentStyle?: CSSProperties;
  /** the pane was clicked or focused: it becomes the active one */
  onActivate: () => void;
  style?: CSSProperties;
};

export function BrowserPane(p: BrowserPaneProps) {
  const { pane, settings, active } = p;
  const { profile, bucket, prefix, ent, sel, actions, ops } = pane;
  const { search, entries, listEntries, filter, fresh, stale, lst } = ent;
  const { selected } = sel;
  const working = lst.loading || !!pane.busy || !!search?.running;
  const sort = pane.sort;
  // this pane's own sort (and compact rows, tile size): the other pane keeps its own
  const setSort = pane.setSort;
  const onSort = (key: SortKey) => setSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  const listLoading = search ? search.running && !search.stopped && entries.length === 0 : lst.loading || !fresh;
  const listError = ent.listError;
  // tiles read the image mode when they mount: the grid starts over when a mode changes
  const imageModes = useImageModes();
  /** what this connection can't show: storage classes */
  const noClass = !!pane.caps && !pane.caps.storageClass;
  // a click on the empty background: nothing selected and no keyboard cursor left on a tile
  const clearSel = () => {
    sel.setSelected(new Set());
    sel.setCursor(null, true);
  };
  const uploadFiles = () => void ops.pickAndUpload(false);
  const newFolder = () => ops.askNewFolder();

  return (
    <section
      className={`browser-pane ${p.dual ? (active ? "is-active" : "is-inactive") : ""}`}
      data-pane={pane.id}
      data-drop-pane={p.dual ? "" : undefined}
      data-active-pane={active ? "" : undefined}
      aria-label={p.dual ? p.label : undefined}
      onMouseDownCapture={p.onActivate}
      onFocusCapture={p.onActivate}
      style={p.style}
    >
      <Toolbar
        bucket={bucket}
        bucketLabel={pane.bucketLabel}
        bucketIcon={pane.profile ? rootIcon(pane.profile.id, bucket ?? "") : undefined}
        prefix={prefix}
        previewOpen={p.previewOpen}
        searchActive={!!search}
        searchRunning={!!search?.running && !search.stopped}
        query={ent.query}
        searchInput={pane.searchInput}
        disabled={!profile || bucket == null}
        working={working}
        view={pane.view}
        compact={pane.compact}
        sort={sort}
        onView={pane.setView}
        onCompact={pane.setCompact}
        onSortChange={setSort}
        onNavigate={pane.navigate}
        onRefresh={ent.refresh}
        onUploadMenu={actions.onUploadMenu}
        onMoreMenu={actions.onMoreMenu}
        onNewFolder={newFolder}
        onQuery={(q) => {
          ent.setQuery(q);
          // editing the text after a deep search goes back to filtering the folder
          if (search && q.trim() !== search.query) ent.sr.clear();
        }}
        onSearch={actions.doSearch}
        onStopSearch={ent.sr.stop}
        onClearSearch={actions.clearSearch}
        onTogglePreview={p.onTogglePreview}
        dual={p.dual}
        onPanes={p.onPanes}
        provider={pane.profile?.provider}
        onSwitchConnection={p.onSwitchConnection}
        dualTools={profile && bucket != null ? p.dualTools : undefined}
        onGoTo={profile && bucket != null ? (t) => void actions.goToPath(t) : undefined}
        favorite={actions.isFavorite}
        onToggleFavorite={profile && bucket != null ? () => actions.toggleFavorite(bucket, prefix) : undefined}
      />

      <PaneBanners pane={pane} />

      <div className="content" style={p.contentStyle}>
        <div className={`pane ${pane.compact ? "compact" : ""}`}>
          {!profile && <Welcome actions={p.empty} />}
          {profile && bucket == null && <ChooseBucket profile={profile} note={p.bucketNote} reconnect={p.bucketReconnect} actions={p.empty} />}
          {profile && bucket != null && (
            <>
              {listError && entries.length === 0 && !search ? (
                <ListError profile={profile} error={listError} onRetry={ent.refresh} onReconnect={p.empty.onReconnect} />
              ) : pane.view === "grid" ? (
                <GridView
                  key={`${settings.binaryUnits}${settings.absoluteDates}${imageModes}`}
                  entries={listEntries}
                  selected={selected}
                  loading={listLoading}
                  stale={stale}
                  hasMore={ent.hasMore}
                  searchMode={!!search || !!filter}
                  prefix={search ? search.loc.prefix : prefix}
                  tileSize={pane.tile}
                  compact={pane.compact}
                  profileId={profile.id}
                  bucket={bucket}
                  autoFocus={active}
                  folderSize={pane.folderSizes.view}
                  onUpload={uploadFiles}
                  onNewFolder={newFolder}
                  activeKey={sel.cursorKey}
                  onSelectKeys={sel.selectKeys}
                  onPress={pane.onPress}
                  onOpen={pane.openEntry}
                  onContext={actions.onContext}
                  onLoadMore={ent.loadMore}
                  onClearSelection={clearSel}
                  onMove={sel.moveSelection}
                  onBackgroundContextMenu={actions.onBackgroundContext}
                />
              ) : (
                <FileTable
                  key={`${settings.binaryUnits}${settings.absoluteDates}`}
                  entries={listEntries}
                  selected={selected}
                  sort={sort}
                  loading={listLoading}
                  stale={stale}
                  hasMore={ent.hasMore}
                  searchMode={!!search || !!filter}
                  prefix={search ? search.loc.prefix : prefix}
                  // connections without storage classes (servers, drives, this computer) leave that column out;
                  // the setting keeps it for the connections that have them
                  columns={noClass ? settings.columns.filter((c) => c !== "storageClass") : settings.columns}
                  onColumnsChange={(columns) =>
                    p.updateSettings({ columns: noClass && settings.columns.includes("storageClass") && !columns.includes("storageClass") ? [...columns, "storageClass"] : columns })
                  }
                  autoFocus={active}
                  onUpload={uploadFiles}
                  onNewFolder={newFolder}
                  onGoUp={pane.canUp && !filter ? () => void pane.goUp() : undefined}
                  activeKey={sel.cursorKey}
                  onSelectKeys={sel.selectKeys}
                  onSort={onSort}
                  onPress={pane.onPress}
                  onOpen={pane.openEntry}
                  onContext={actions.onContext}
                  onLoadMore={ent.loadMore}
                  onClearSelection={clearSel}
                  onMove={sel.moveSelection}
                  onBackgroundContextMenu={actions.onBackgroundContext}
                  folderSize={pane.folderSizes.view}
                  onCalcSize={(k) => actions.calcSizes([k])}
                />
              )}
              <PaneStatusBar pane={pane} />
            </>
          )}
          {p.dropUpload && (
            <div className="drop-overlay">
              <div className="drop-card">
                <Icon name="upload" size={34} />
                <strong>Drop to upload</strong>
                <span>
                  to {bucket}/{prefix}
                </span>
              </div>
            </div>
          )}
        </div>
        {p.aside}
      </div>

      {pane.quick && pane.quickIndex >= 0 && profile && bucket != null && (
        <QuickLook
          profileId={profile.id}
          bucket={bucket}
          entry={entries[pane.quickIndex]}
          index={pane.quickIndex}
          count={entries.length}
          onStep={pane.stepQuick}
          onClose={pane.closeQuick}
          onOpen={pane.openEntry}
          onDownload={pane.caps?.localPaths ? undefined : pane.downloadOne}
          onCopyFile={IS_MAC ? pane.copyFile : undefined}
        />
      )}
      {pane.drag && !pane.drag.outside && profile && <DragGhost drag={pane.drag} bucket={bucket} profileId={profile.id} />}
    </section>
  );
}
