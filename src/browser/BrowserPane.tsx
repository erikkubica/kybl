/**
 * One browser pane on screen: its toolbar (navigation, path, search, actions), banners, the list
 * or grid with its empty and error states, the status bar, Quick Look and the drag ghost. All
 * state lives in the pane object from usePane; this only draws it.
 */
import type { CSSProperties } from "react";
import { Icon } from "../Icons";
import { Toolbar } from "../components/Toolbar";
import { rootIcon } from "../connections/roots";
import { FileTable, type SortKey } from "../components/FileTable";
import { GridView } from "../components/GridView";
import { QuickLook } from "../desktop/QuickLook";
import type { Settings } from "../settings";
import { ChooseBucket, ListError, Welcome, type EmptyActions } from "./PaneEmpty";
import { PaneBanners, PaneStatusBar } from "./PaneParts";
import type { Pane } from "./usePane";
import { useImageModes } from "../imageMode";
import type { MenuItem } from "../components/Dialogs";

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
  /** several panes: the items for the other pane at the top of the toolbar's "…" (shell/SplitLayout dualMenuItems) */
  dualItems?: () => MenuItem[];
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  /** the panes button: split, or the panes menu */
  onPanes?: (x: number, y: number) => void;
  /** the panes menu's items, for "…" when a narrow pane has no room for the panes button */
  panesItems?: () => MenuItem[];
  /** the badge before the path: another connection or bucket in this pane */
  onSwitchConnection?: (x: number, y: number) => void;
  /** files dragged in from the computer would land here */
  dropUpload: boolean;
  /** the sidebar's note for a connection with no bucket open (and whether to offer to reconnect) */
  bucketNote: string | null;
  /** the whole error behind the note (a server certificate to trust, say) */
  bucketError?: string | null;
  bucketReconnect: boolean;
  empty: EmptyActions;
  /** the pane was clicked or focused: it becomes the active one */
  onActivate: () => void;
  /** the header's empty part was pressed: maybe the start of dragging this pane elsewhere (shell/usePaneDrag) */
  onGrip?: (e: React.PointerEvent<HTMLElement>) => void;
  /** this pane is being dragged: it dims while the drop overlay shows where it would go */
  lifted?: boolean;
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
  const here = !!profile && bucket != null;
  /** The toolbar's "…": refresh and Go to folder, the other pane's items, then the folder's own. */
  const moreMenu = (x: number, y: number, folded: MenuItem[]) =>
    actions.onMoreMenu(x, y, [
      { type: "item", label: search ? "Search again" : "Refresh", icon: "refresh", hint: "⌘R", disabled: !here, onClick: ent.refresh },
      here && { type: "item", label: "Go to folder…", icon: "edit", hint: "⇧⌘G", onClick: actions.askGoTo },
      ...folded,
      { type: "sep" },
      ...(p.dualItems?.() ?? []),
    ]);

  return (
    <section
      className={`browser-pane ${p.dual ? (active ? "is-active" : "is-inactive") : ""} ${p.lifted ? "lifted" : ""}`}
      data-pane={pane.id}
      // (items dragged from another workspace drop on a single pane's empty space too)
      data-drop-pane=""
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
        tile={pane.tile}
        onTile={pane.setTile}
        hidden={pane.caps?.localPaths ? pane.showHidden : undefined}
        onToggleHidden={actions.commands["toggle-hidden"]}
        onNavigate={pane.navigate}
        onUp={() => void pane.goUp()}
        onUpload={(folder) => void ops.pickAndUpload(folder)}
        onMoreMenu={moreMenu}
        onNewFolder={newFolder}
        onQuery={(q) => {
          ent.setQuery(q);
          // editing the text after a deep search goes back to filtering the folder
          if (search && q.trim() !== search.query) ent.sr.clear();
        }}
        onSearch={actions.doSearch}
        onStopSearch={ent.sr.stop}
        onClearSearch={actions.clearSearch}
        dual={p.dual}
        onPanes={p.onPanes}
        panesItems={p.panesItems}
        provider={pane.profile?.provider}
        connName={pane.profile?.name}
        onSwitchConnection={p.onSwitchConnection}
        onGoTo={here ? (t) => void actions.goToPath(t) : undefined}
        favorite={actions.isFavorite}
        onToggleFavorite={here ? () => actions.toggleFavorite(bucket!, prefix) : undefined}
        onGrip={p.onGrip}
      />

      <PaneBanners pane={pane} />

      <div className="content">
        <div className={`pane ${pane.compact ? "compact" : ""}`}>
          {!profile && <Welcome actions={p.empty} />}
          {profile && bucket == null && <ChooseBucket profile={profile} note={p.bucketNote} error={p.bucketError} reconnect={p.bucketReconnect} actions={p.empty} />}
          {profile && bucket != null && (
            <>
              {listError && entries.length === 0 && !search ? (
                <ListError profile={profile} error={listError} onRetry={ent.refresh} onReconnect={p.empty.onReconnect} onTrustCert={p.empty.onTrustCert} />
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
      </div>

      {pane.quick && pane.quickIndex >= 0 && profile && bucket != null && (
        <QuickLook
          profileId={profile.id}
          bucket={bucket}
          entry={entries[pane.quickIndex]}
          group={pane.quickEntries}
          index={pane.quickIndex}
          count={entries.length}
          startWithInfo={pane.quickInfo}
          infoPref={settings.quickInfo}
          onInfoPref={(on) => p.updateSettings({ quickInfo: on })}
          info={{
            defaultExpiry: settings.linkExpiry,
            onCopyLink: actions.copyLink,
            onCopyText: actions.copyText,
            onDownload: pane.caps?.localPaths ? undefined : (list) => void ops.downloadEntries(list, pane.relBase),
            onRename: (e) => ops.askRename(e),
            onMoveTo: (list) => actions.askMove(list),
            onDelete: pane.deleteFromQuick,
            onChanged: ent.refresh,
            folderSize: pane.folderSizes.view,
            onCalcSize: (k) => actions.calcSizes([k]),
            onPermissions: actions.askPermissions,
            onShowOriginal: actions.showOriginal && ((e) => (pane.closeQuick(), void actions.showOriginal!(e))),
          }}
          onStep={pane.stepQuick}
          onPick={pane.pickQuick}
          onClose={pane.closeQuick}
          onOpen={pane.openEntry}
          onDownload={pane.caps?.localPaths ? undefined : pane.downloadOne}
          onCopyFile={IS_MAC ? pane.copyFile : undefined}
          onOpenExternal={(e) => void ops.openInApp(e)}
        />
      )}
    </section>
  );
}
