/**
 * One browser pane on screen: its toolbar (navigation, path, search, actions), banners, the list
 * or grid with its empty and error states, the status bar, Quick Look and the drag ghost. All
 * state lives in the pane object from usePane; this only draws it.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Icon } from "../ui/components/Icons";
import { Toolbar } from "./components/Toolbar";
import { rootIcon, rootsMode } from "../connections/lib/roots";
import { peekCaps } from "../core/useCaps";
import { FileTable, type SortKey } from "./components/list/FileTable";
import type { ColumnId } from "../settings/settings";
import { GridView } from "./components/list/GridView";
import { QuickLook } from "../desktop/components/QuickLook";
import type { Settings } from "../settings/settings";
import { ChooseBucket, ListError, Welcome, type EmptyActions } from "./components/PaneEmpty";
import { PaneLauncher } from "./components/PaneLauncher";
import { PaneBanners, PaneStatusBar } from "./components/PaneParts";
import type { Pane } from "./hooks/usePane";
import { useImageModes } from "../thumbs/imageMode";
import type { MenuItem } from "../ui/components/Dialogs";
import { BranchChip, SearchModes } from "./components/DevMarks";
import type { Entry } from "../core/types";
import { registerCommands } from "../palette/lib/commands";

// the info panel is code most panes never need: it loads when one is first opened
const InfoPanel = lazy(() => import("./components/InfoPanel"));

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
  /** the terminal button: this pane's terminal (a shell on this computer where it can't have one) */
  onTerminal?: () => void;
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
  const caps = pane.caps;
  const unavailableCols = useMemo((): ColumnId[] => {
    if (!caps) return [];
    const out: ColumnId[] = [];
    if (!caps.storageClass) out.push("storageClass");
    if (!caps.permissions) out.push("perms", "owner");
    if (!caps.localPaths && profile?.kind !== "gdrive") out.push("created");
    return out;
  }, [caps, profile?.kind]);
  // a click on the empty background: nothing selected and no keyboard cursor left on a tile
  const clearSel = () => {
    sel.setSelected(new Set());
    sel.setCursor(null, true);
  };
  // inside an archive (read-only) these go through the commands, which say so instead
  const uploadFiles = () => actions.commands["upload-files"]();
  const newFolder = () => actions.commands["new-folder"]();
  const readOnly = pane.archive.inArchive;
  const here = !!profile && bucket != null;
  const { sr } = ent;
  // ⌘K "Search Inside Files": the active pane's search field, set to look inside files
  const live = useRef({ pane, sr });
  live.current = { pane, sr };
  useEffect(() => {
    if (!active) return;
    return registerCommands("content-search", () => {
      const { pane: pn, sr: s } = live.current;
      return [
        {
          id: "content-search:open",
          title: "Search Inside Files",
          group: "View",
          icon: "search",
          keywords: "contents text ripgrep find in files",
          disabled: !pn.here ? "Open a folder first" : pn.contentsOff,
          run: () => {
            s.configure({ mode: "contents" });
            pn.searchInput.current?.focus();
            pn.searchInput.current?.select();
          },
        },
      ];
    });
  }, [active]);
  const gitMark = pane.git.info ? pane.git.markFor : undefined;
  const hits = search?.hits;
  const hitOf = hits ? (e: Entry) => hits[e.key] : undefined;
  /** a content hit's line clicked: that file, previewed at the line */
  const previewHit = (e: Entry) => {
    sel.setSelected(new Set([e.key]));
    sel.setCursor(e.key, true);
    pane.setQuick(e.key);
  };
  /** The toolbar's "…": refresh and Go to folder, the other pane's items, then the folder's own. */
  const moreMenu = (x: number, y: number, folded: MenuItem[]) =>
    actions.onMoreMenu(x, y, [
      { type: "item", label: search ? "Search again" : "Refresh", icon: "refresh", hint: "⌘R", disabled: !here, onClick: ent.refresh },
      here && { type: "item", label: "Go to folder…", icon: "edit", hint: "⇧⌘G", onClick: actions.askGoTo },
      ...folded,
      { type: "sep" },
      ...(p.dualItems?.() ?? []),
    ]);

  // the path while nothing is open: a server has no buckets, it's connecting or it couldn't
  const rootsKind = profile ? rootsMode(profile, peekCaps(profile.id)) : null;
  const emptyLabel = !profile
    ? "No connection"
    : rootsKind === "single"
      ? p.bucketNote || p.bucketError
        ? "Not connected"
        : "Connecting…"
      : // its roots are listed below (ChooseBucket), so the path names what they are
        rootsKind === "drives"
        ? "Places"
        : "Buckets";
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
        // the first match, not one step from the cursor a cleared selection left behind
        onLeaveDown={() => sel.selected.size === 0 && entries.length > 0 && sel.selectOnly(entries[0].key)}
        bucket={bucket}
        bucketLabel={pane.bucketLabel}
        bucketIcon={pane.profile ? rootIcon(pane.profile.id, bucket ?? "") : undefined}
        emptyLabel={emptyLabel}
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
        groupBy={pane.groupBy}
        onGroupBy={(g) => pane.setGroupBy(g)}
        tile={pane.tile}
        onTile={pane.setTile}
        hidden={pane.caps?.localPaths ? pane.showHidden : undefined}
        onToggleHidden={actions.commands["toggle-hidden"]}
        onNavigate={pane.navigate}
        onUp={() => void pane.goUp()}
        onUpload={(folder) => actions.commands[folder ? "upload-folder" : "upload-files"]()}
        readOnly={readOnly}
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
        onTerminal={p.onTerminal}
        panesItems={p.panesItems}
        provider={pane.profile?.provider}
        connName={pane.profile?.name}
        // at a root's top, the name goes on up to the connection's roots (one with a single root has none)
        onConnTop={profile && rootsKind && rootsKind !== "single" ? () => pane.showConnection(profile.id) : undefined}
        switchLabel={rootsKind === "single" ? "Switch connection" : rootsKind === "drives" ? "Switch connection or folder" : "Switch connection or bucket"}
        onSwitchConnection={p.onSwitchConnection}
        onGoTo={here ? (t) => void actions.goToPath(t) : undefined}
        goTo={actions.goTo}
        favorite={actions.isFavorite}
        onToggleFavorite={here ? () => actions.toggleFavorite(bucket!, prefix) : undefined}
        afterPath={pane.git.info && <BranchChip info={pane.git.info} />}
        searchExtras={
          here && <SearchModes mode={sr.mode} caseSensitive={sr.caseSensitive} regex={sr.regex} contentsOff={pane.contentsOff} onChange={sr.configure} />
        }
        searchPlaceholder={sr.mode === "contents" ? "Search inside files, ↵" : undefined}
        onGrip={p.onGrip}
      />

      <PaneBanners pane={pane} />

      <div className="content">
        <div className={`pane ${pane.compact ? "compact" : ""}`}>
          {!profile && (p.empty.launcher && !p.empty.missing ? <PaneLauncher items={p.empty.launcher()} /> : <Welcome actions={p.empty} />)}
          {profile && bucket == null && <ChooseBucket profile={profile} note={p.bucketNote} error={p.bucketError} reconnect={p.bucketReconnect} actions={p.empty} />}
          {profile && bucket != null && (
            <>
              {listError && entries.length === 0 && !search ? (
                <ListError profile={profile} error={listError} onRetry={ent.refresh} onReconnect={p.empty.onReconnect} onTrustCert={p.empty.onTrustCert} onAllowPlainFtp={p.empty.onAllowPlainFtp} onTrustHostKey={p.empty.onTrustHostKey} />
              ) : pane.view === "grid" ? (
                <GridView
                  key={`${settings.binaryUnits}${settings.dateFormat}${imageModes}`}
                  entries={listEntries}
                  groups={ent.groups}
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
                  gitMark={gitMark}
                  onUpload={readOnly ? undefined : uploadFiles}
                  onNewFolder={readOnly ? undefined : newFolder}
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
                  key={`${settings.binaryUnits}${settings.dateFormat}`}
                  entries={listEntries}
                  groups={ent.groups}
                  selected={selected}
                  sort={sort}
                  loading={listLoading}
                  stale={stale}
                  hasMore={ent.hasMore}
                  searchMode={!!search || !!filter}
                  prefix={search ? search.loc.prefix : prefix}
                  // columns this connection can't fill (storage classes off S3, permissions off the
                  // servers, created dates off this computer and Drive) are left out here; the
                  // setting keeps them for the connections that have them
                  columns={settings.columns}
                  unavailable={unavailableCols}
                  onColumnsChange={(columns) => p.updateSettings({ columns })}
                  autoFocus={active}
                  onUpload={readOnly ? undefined : uploadFiles}
                  onNewFolder={readOnly ? undefined : newFolder}
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
                  onCancelSize={pane.folderSizes.cancel}
                  gitMark={gitMark}
                  hitOf={hitOf}
                  onHitOpen={previewHit}
                />
              )}
              <PaneStatusBar pane={pane} />
            </>
          )}
          {p.dropUpload && !readOnly && (
            <div className="drop-overlay">
              <div className="drop-card">
                <Icon name="upload" size={34} />
                <strong>Drop to upload</strong>
                <span>
                  to {[pane.bucketLabel, ...(prefix ?? "").split("/").filter(Boolean)].join(" / ")}
                </span>
              </div>
            </div>
          )}
        </div>
        {pane.infoOpen && profile && bucket != null && (
          <Suspense fallback={<aside className="info-panel" aria-busy="true" />}>
            <InfoPanel pane={pane} />
          </Suspense>
        )}
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
          hit={hits?.[entries[pane.quickIndex]?.key]}
          infoPref={settings.quickInfo}
          onInfoPref={(on) => p.updateSettings({ quickInfo: on })}
          info={{
            defaultExpiry: settings.linkExpiry,
            onCopyLink: actions.copyLink,
            onCopyText: actions.copyText,
            onDownload: pane.caps?.localPaths ? undefined : (list) => void ops.downloadEntries(list, pane.relBase),
            // inside an archive (read-only) these say so, as the keyboard commands do
            onRename: (e) => (pane.archive.inArchive ? actions.commands.rename() : ops.askRename(e)),
            // inside an archive (read-only) the move button extracts instead
            onMoveTo: (list) => (pane.archive.inArchive ? void pane.archive.extractTo(list) : actions.askMove(list)),
            moveLabel: pane.archive.inArchive ? "Extract to…" : undefined,
            onDelete: pane.archive.inArchive ? () => actions.commands.delete() : pane.deleteFromQuick,
            onChanged: ent.refresh,
            folderSize: pane.folderSizes.view,
            onCalcSize: (k) => actions.calcSizes([k]),
            onCancelSize: pane.folderSizes.cancel,
            onPermissions: actions.askPermissions,
            onShowOriginal: actions.showOriginal && ((e) => (pane.closeQuick(), void actions.showOriginal!(e))),
            onEdit: actions.editMenuAt,
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
