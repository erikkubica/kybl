import { plural } from "../format";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icons";
import { KYBL } from "../kybl";
import { useCaps } from "../useCaps";
import { deviceIcon, rootIcon, rootsMode } from "../connections/roots";
import { addressOf } from "../connections/kinds";
import { KyblMark } from "./KyblMark";
import { providerMeta } from "../providers";
import type { Profile } from "../types";
import type { SyncState } from "../sync";
import type { Favorite } from "../settings";
import type { MountInfo } from "../api";
import { findMount } from "../mount/useMounts";
import { driveBadgeTitle } from "../mount/driveMenu";
import { TunnelBadge } from "../tunnels/TunnelBadge";
import { keys } from "./osText";
import { useConnectionDrag } from "./useConnectionDrag";
import { TYPE_FALLBACK_MIN, TYPE_ORDER, isDevice, typeOf } from "../connections/organize";
import {
  FILTER_MIN,
  RECENT_MIN,
  RECENT_SHOWN,
  findConnections,
  groupLabel,
  groupName,
  groupOf,
  openKey,
  scopeOf,
  sidebarLayout,
  type Found,
  type GroupNode,
  type KindSection,
  type Range,
} from "../connections/groups";

const SYNC_LABEL: Record<SyncState, string> = {
  idle: "Synced folders are up to date",
  scanning: "Checking synced folders…",
  syncing: "Syncing…",
  error: "A synced folder has a problem",
  paused: "Syncing is paused",
};

/** Small coloured monogram that identifies a storage provider. */
export function ProviderBadge({ provider, large }: { provider: string | undefined; large?: boolean }) {
  const meta = providerMeta(provider);
  return (
    <span className={`pbadge ${large ? "lg" : ""} ${meta.id === "kybl" ? "kybl" : ""}`} style={{ "--pc": meta.color } as React.CSSProperties} aria-hidden="true">
      {meta.id === "kybl" ? <KyblMark size={large ? 22 : 17} sun /> : meta.id === "local" ? <Icon name={deviceIcon} size={large ? 15 : 12} /> : meta.mono}
    </span>
  );
}

const NO_PICKS = new Set<string>();

const onActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/**
 * A place that is mounted as a drive: a small eject mark at the row's end, like a disk in
 * Finder's sidebar (a warning while it can't mount). A click opens the drive's menu.
 */
function DriveBadge({ m, onMenu }: { m: MountInfo | undefined; onMenu?(m: MountInfo, x: number, y: number): void }) {
  const title = m && driveBadgeTitle(m);
  if (!m || !title) return null;
  return (
    <button
      className={`drive-badge ${m.state}`}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onMenu?.(m, Math.round(r.left), Math.round(r.bottom + 2));
      }}
      onKeyDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
    >
      {m.state === "mounting" ? <span className="spinner" /> : <Icon name={m.state === "error" ? "alert" : "eject"} size={11} />}
    </button>
  );
}

/** A connection's badge: its provider's, or this computer's. */
function ConnBadge({ p, own, large }: { p: Profile; own: boolean; large?: boolean }) {
  return own ? (
    <span className={`pbadge local ${large ? "lg" : ""}`} aria-hidden="true">
      <Icon name={deviceIcon} size={large ? 15 : 12} />
    </span>
  ) : (
    <ProviderBadge provider={p.provider} large={large} />
  );
}

/** `text` with the typed words marked. */
function Marked({ text, hits }: { text: string; hits: Range[] }) {
  if (!hits.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of hits) {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={a}>{text.slice(a, b)}</mark>);
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** What the filter field found: one row per connection, its group (or what matched) beneath. */
function FindResults({
  found,
  query,
  cursor,
  activeId,
  builtIn,
  onHover,
  onOpen,
  onConnectionMenu,
}: {
  found: Found[];
  query: string;
  cursor: number;
  activeId: string | null;
  builtIn: (p: Profile) => boolean;
  onHover: (i: number) => void;
  onOpen: (p: Profile) => void;
  onConnectionMenu?(p: Profile, x: number, y: number): void;
}) {
  if (!found.length)
    return (
      <p className="side-note find-none">
        No connection matches “{query.trim()}”. Names, servers, user names, kinds and groups are searched.
      </p>
    );
  return (
    <div id="side-find-results" role="listbox" aria-label="Connections found">
      <div className="side-head">
        <span>{found.length === 1 ? "1 connection" : `${found.length} connections`}</span>
        <span className="side-count">↩ opens</span>
      </div>
      {found.map((f, i) => (
        <div
          key={f.p.id}
          id={`side-find-${f.p.id}`}
          className={`side-item find-row ${i === cursor ? "cursor" : ""} ${f.p.id === activeId ? "active" : ""}`}
          role="option"
          aria-selected={i === cursor}
          // the field keeps the keyboard; a click opens without taking it
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => i !== cursor && onHover(i)}
          onClick={() => onOpen(f.p)}
          onContextMenu={
            onConnectionMenu &&
            ((e) => {
              e.preventDefault();
              onConnectionMenu(f.p, e.clientX, e.clientY);
            })
          }
          title={builtIn(f.p) ? f.p.name : `${f.p.name} · ${addressOf(f.p)}`}
        >
          <ConnBadge p={f.p} own={builtIn(f.p)} />
          <span className="find-text">
            <span className="find-name">
              <Marked text={f.p.name} hits={f.nameHits} />
            </span>
            {f.detail && (
              <span className="find-detail">
                <Marked text={f.detail} hits={f.detailHits} />
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

type GroupCtx = {
  open: Set<string>;
  /** "" at the top level, a kind section's key inside one: group keys and menus are per scope */
  scope: string;
  /** the group of the connection on screen, when it is in this scope ("" at its top; null: elsewhere) */
  activeGroup: string | null;
  onToggle: (key: string) => void;
  onMenu?: (path: string, scope: string, x: number, y: number) => void;
  /** the group a connection drag is over right now (null: not dragging, or over none) */
  dropOver: string | null;
};

/**
 * A level of a kind section or a group: its groups first (like folders in a folder), then its
 * connections, so a section of a hundred loose servers doesn't bury its folders at the bottom.
 */
function GroupBody({ node, depth, ctx, renderConnection }: { node: GroupNode; depth: number; ctx: GroupCtx; renderConnection: (p: Profile) => React.ReactNode }) {
  const groups = node.groups.map((g) => <GroupRow key={g.path} node={g} depth={depth} ctx={ctx} renderConnection={renderConnection} />);
  const items = node.items.map(renderConnection);
  return <>{[groups, items]}</>;
}

/** Arrow keys fold a row open and shut; Enter and Space toggle it. */
const foldKeys = (open: boolean, toggle: () => void) => (e: React.KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "ArrowRight" && !open) (e.preventDefault(), toggle());
  else if (e.key === "ArrowLeft" && open) (e.preventDefault(), toggle());
  else onActivate(toggle)(e);
};

/**
 * The servers of one kind ("FTP", "SFTP", "WebDAV"): a row like a connection's that folds open on
 * its connections instead of buckets, groups and all.
 */
function KindSectionRow({
  section,
  ctx,
  onMenu,
  renderConnection,
}: {
  section: KindSection;
  ctx: GroupCtx;
  onMenu?: (s: KindSection, x: number, y: number) => void;
  renderConnection: (p: Profile) => React.ReactNode;
}) {
  const open = ctx.open.has(section.key);
  const holdsActive = !open && ctx.activeGroup !== null;
  const toggle = () => ctx.onToggle(section.key);
  const n = section.tree.count;
  return (
    <div className="side-group kind-section" role="group" aria-label={section.label}>
      <div
        className={`side-item conn kind-row ${open ? "open" : ""} ${holdsActive ? "holds-active" : ""}`}
        onClick={toggle}
        onKeyDown={foldKeys(open, toggle)}
        onContextMenu={
          onMenu &&
          ((e) => {
            e.preventDefault();
            onMenu(section, e.clientX, e.clientY);
          })
        }
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${section.label}, ${plural(n, "connection")}`}
        title={holdsActive ? `${section.label}: the connection on screen is in here` : `${n} ${section.label} ${n === 1 ? "connection" : "connections"}`}
      >
        <ProviderBadge provider={section.kind} />
        <span className="side-label">{section.label}</span>
        <span className="side-count" aria-hidden="true">
          {n}
        </span>
        <Icon name="chevron" size={13} className="side-caret" />
      </div>
      {open && (
        <div className="kind-body">
          <GroupBody node={section.tree} depth={0} ctx={ctx} renderConnection={renderConnection} />
        </div>
      )}
    </div>
  );
}

function GroupRow({ node, depth, ctx, renderConnection }: { node: GroupNode; depth: number; ctx: GroupCtx; renderConnection: (p: Profile) => React.ReactNode }) {
  const key = openKey(ctx.scope, node.path);
  const open = ctx.open.has(key);
  // folded shut over the connection on screen: the folder says it's in there
  const holdsActive = !open && ctx.activeGroup !== null && (ctx.activeGroup === node.path || ctx.activeGroup.startsWith(`${node.path}/`));
  const toggle = () => ctx.onToggle(key);
  return (
    <div className="side-group" role="group" aria-label={node.name}>
      <div
        className={`side-item group-row ${open ? "open" : ""} ${holdsActive ? "holds-active" : ""} ${!node.virtual && ctx.dropOver === node.path ? "drop-over" : ""}`}
        // connections dragged here are filed in this group (useConnectionDrag)
        {...(node.virtual ? {} : { "data-conn-drop": node.path })}
        onClick={toggle}
        onKeyDown={foldKeys(open, toggle)}
        onContextMenu={
          ctx.onMenu && !node.virtual
            ? (e) => {
                e.preventDefault();
                ctx.onMenu!(node.path, ctx.scope, e.clientX, e.clientY);
              }
            : undefined
        }
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${node.name}, ${node.count} ${node.count === 1 ? "connection" : "connections"}`}
        title={holdsActive ? `${groupLabel(node.virtual ? node.name : node.path)}: the connection on screen is in here` : groupLabel(node.virtual ? node.name : node.path)}
      >
        <span className="group-ico" aria-hidden="true">
          <Icon name="folder" size={15} />
        </span>
        <span className="side-label">{node.name}</span>
        <span className="side-count" aria-hidden="true">
          {node.count}
        </span>
        <Icon name="chevron" size={13} className="side-caret" />
      </div>
      {open && (
        <div className="group-body">
          <GroupBody node={node} depth={depth + 1} ctx={ctx} renderConnection={renderConnection} />
        </div>
      )}
    </div>
  );
}

export type BucketList = {
  names: string[];
  note: string | null;
  loading: boolean;
  /** a Kybl Storage key that no longer works: offer to connect again */
  reconnect?: boolean;
  /** the whole error behind `note` (a server certificate to trust, say) */
  error?: string | null;
};

export function Sidebar({
  profiles,
  activeId,
  expanded,
  bucketsBy,
  bucket,
  onToggleProfile,
  onEditProfile,
  onNewProfile,
  onOpenSettings,
  syncState,
  onOpenSync,
  onSelectBucket,
  onOpenBucketByName,
  onNewBucket,
  hiddenBuckets,
  onHideBucket,
  onReconnect,
  favorites,
  onOpenFavorite,
  onRemoveFavorite,
  rootLabel = (_p, r) => r,
  builtIn = () => false,
  authNeeded,
  onSignInAgain,
  onConnectionMenu,
  onBucketMenu,
  mounts,
  onDriveMenu,
  onHide,
  peek,
  recent = [],
  openGroups,
  onToggleGroup,
  onGroupMenu,
  onSectionMenu,
  onOpenConnection,
  findSignal = 0,
  findOnMount,
  onFindDone,
  picked,
  onTogglePick,
  onClearPicks,
  onMoveToGroup,
  onMoveMenu,
  onTogglePin,
}: {
  profiles: Profile[];
  /** connection of the bucket on screen */
  activeId: string | null;
  /** connections folded open in the sidebar (any number of them) */
  expanded: Set<string>;
  bucketsBy: Record<string, BucketList>;
  bucket: string | null;
  onToggleProfile: (p: Profile) => void;
  onEditProfile: (p: Profile) => void;
  onNewProfile: () => void;
  onOpenSettings: () => void;
  syncState: SyncState | null;
  onOpenSync: () => void;
  onSelectBucket: (p: Profile, b: string) => void;
  onOpenBucketByName: (p: Profile) => void;
  /** Kybl Storage only: make a bucket in the account */
  onNewBucket: (p: Profile) => void;
  /** buckets left out of the list, per connection */
  hiddenBuckets: Record<string, string[]>;
  onHideBucket: (p: Profile, bucket: string, hide: boolean) => void;
  onReconnect: (p: Profile) => void;
  /** pinned places, listed above the connections */
  favorites?: Favorite[];
  onOpenFavorite?(f: Favorite): void;
  onRemoveFavorite?(f: Favorite): void;
  /** what to call a root on screen (this computer's folders: "Desktop" for its path) */
  rootLabel?: (profileId: string, root: string) => string;
  /** a connection that comes with the app (This Mac): no edit button, no "Open bucket by name" */
  builtIn?: (p: Profile) => boolean;
  /** sign-in connections whose access ended (connections/authNeeded) */
  authNeeded?: Set<string>;
  /** "Sign in again" on one of those */
  onSignInAgain?: (p: Profile) => void;
  /** right-click on a connection / a bucket (at the pointer) */
  onConnectionMenu?(p: Profile, x: number, y: number): void;
  onBucketMenu?(p: Profile, bucket: string, x: number, y: number): void;
  /** drives ("Mount as drive"): mounted connections and buckets get a badge that opens `onDriveMenu` */
  mounts?: MountInfo[];
  onDriveMenu?(m: MountInfo, x: number, y: number): void;
  /** folds the sidebar away (its button sits by the window controls) */
  onHide?: () => void;
  /** shown over the panes from the folded rail: its button opens it for good */
  peek?: boolean;
  /** connections opened last, newest first (ids): "Recent" once the list is long */
  recent?: string[];
  /** groups folded open (paths) */
  openGroups?: Set<string>;
  /** folds a group (or kind section) open or shut, by its key (`openKey`) */
  onToggleGroup?(key: string): void;
  /** right-click on a group's row (at the pointer); `scope` is its kind section's key, "" at the top level */
  onGroupMenu?(path: string, scope: string, x: number, y: number): void;
  /** right-click on a kind section's row */
  onSectionMenu?(s: KindSection, x: number, y: number): void;
  /** opens a connection in the pane in use (a found or recent connection) */
  onOpenConnection?(p: Profile): void;
  /** goes up by one each time ⌥⌘F asks for the filter field */
  findSignal?: number;
  /** the filter field takes the keyboard as soon as this sidebar shows */
  findOnMount?: boolean;
  /** finding is over (opened one, or Esc with nothing typed): the keyboard goes back to the pane */
  onFindDone?(): void;
  /** connections picked to organize together (⌘-click): Move to group… and Pin act on them */
  picked?: Set<string>;
  onTogglePick?(p: Profile): void;
  onClearPicks?(): void;
  /** connections were dropped on a group ("" = the top level) */
  onMoveToGroup?(ids: string[], group: string): void;
  /** "Move to group…" for these connections, its menu at the point */
  onMoveMenu?(ids: string[], x: number, y: number): void;
  /** pins these connections, or unpins them when all are pinned */
  onTogglePin?(ids: string[]): void;
}) {
  // connections whose hidden buckets are on show (to pick which to bring back)
  const [showHidden, setShowHidden] = useState<Set<string>>(new Set());

  // ---- finding a connection by typing
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // ⌥⌘F shows the field even for a short list, until it's left empty
  const [findAsked, setFindAsked] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const many = profiles.length > FILTER_MIN;
  const showFind = many || findAsked || !!query;
  const found = useMemo(() => findConnections(profiles, query), [profiles, query]);
  // a stray space alone doesn't swap the list for "no match"
  const searching = query.trim() !== "";
  // the overlay from the folded rail, brought up by ⌥⌘F or the rail's "All connections": it
  // takes the request that opened it
  // at once when the field is there (keys typed straight after ⌥⌘F land in it), else as soon as
  // it has rendered (a short list shows it only on request)
  const wantFocus = useRef(false);
  const focusFind = () => {
    const el = findRef.current;
    if (!wantFocus.current || !el) return;
    wantFocus.current = false;
    el.focus();
    el.select();
  };
  useLayoutEffect(focusFind);
  const seenSignal = useRef(findOnMount ? -1 : findSignal);
  useEffect(() => {
    if (findSignal === seenSignal.current) return;
    seenSignal.current = findSignal;
    setFindAsked(true);
    wantFocus.current = true;
    focusFind();
  }, [findSignal]);
  const openFound = (p: Profile) => {
    setQuery("");
    setFindAsked(false);
    findRef.current?.blur();
    onOpenConnection?.(p);
  };
  const onFindKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!found.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (c + d + found.length) % found.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = found[cursor];
      if (hit) openFound(hit.p);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery("");
      else {
        setFindAsked(false);
        findRef.current?.blur();
        onFindDone?.();
      }
    }
  };
  // the keyboard's row stays in view as it moves
  useEffect(() => {
    if (!searching) return;
    const hit = found[cursor];
    if (hit) document.getElementById(`side-find-${hit.p.id}`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, searching, found]);

  // ---- groups and recent
  const layout = useMemo(() => sidebarLayout(profiles), [profiles]);
  // where the connection on screen sits: its section ("" at the top level) and group
  const here = useMemo(() => {
    const p = profiles.find((x) => x.id === activeId);
    return p ? { scope: scopeOf(profiles, p), group: groupOf(p) } : null;
  }, [profiles, activeId]);
  const recentProfiles = useMemo(
    () =>
      recent
        .filter((id) => id !== activeId)
        .map((id) => profiles.find((p) => p.id === id))
        .filter((p): p is Profile => !!p)
        .slice(0, RECENT_SHOWN),
    [recent, profiles, activeId],
  );
  const showRecent = profiles.length > RECENT_MIN && recentProfiles.length > 0;
  // dragging connections onto groups; a connection in the picked set takes the others along
  const pickedSet = picked ?? NO_PICKS;
  const drag = useConnectionDrag((ids, group) => onMoveToGroup?.(ids, group));
  const dragProps = (p: Profile) => {
    const ids = pickedSet.has(p.id) ? [...pickedSet] : [p.id];
    return onMoveToGroup && !isDevice(p) ? drag.rowProps(ids, p.name) : {};
  };
  // a long list of connections in no group is sorted by type (Servers sections are already
  // by kind: what is left of them, drives and storage, folds the same way)
  const typed = useMemo(() => {
    const loose = layout.top.items.filter((p) => !isDevice(p));
    if (loose.length <= TYPE_FALLBACK_MIN) return null;
    const by = new Map<string, Profile[]>();
    for (const p of loose) by.set(typeOf(p).id, [...(by.get(typeOf(p).id) ?? []), p]);
    const nodes: GroupNode[] = TYPE_ORDER.filter((id) => by.has(id)).map((id) => {
      const items = by.get(id)!;
      return { path: `type:${id}`, name: typeOf(items[0]).label, groups: [], items, count: items.length, virtual: true };
    });
    return { nodes, device: layout.top.items.filter(isDevice) };
  }, [layout]);
  const ctxFor = (scope: string): GroupCtx => ({
    open: openGroups ?? new Set(),
    scope,
    activeGroup: here?.scope === scope ? here.group : null,
    onToggle: (key) => onToggleGroup?.(key),
    onMenu: onGroupMenu,
    dropOver: drag.over,
  });
  const topCtx = ctxFor("");
  // the by-type folders hold the connection on screen like any folder: keyed by its type
  const typeCtx: GroupCtx = { ...topCtx, activeGroup: activeId && here?.scope === "" ? (typed?.nodes.find((n) => n.items.some((p) => p.id === activeId))?.path ?? null) : null };
  const pinnedProfiles = useMemo(() => profiles.filter((p) => p.pinned && !isDevice(p)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })), [profiles]);
  const pickedProfiles = profiles.filter((p) => pickedSet.has(p.id));

  // ---- where am I: the connection on screen scrolls into view when it changes (and once its
  // group has folded open), without moving a list that already shows it
  const scrollRef = useRef<HTMLDivElement>(null);
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!activeId || searching) return;
    if (revealed.current === activeId) return;
    const row = scrollRef.current?.querySelector(`[data-conn-row="${CSS.escape(activeId)}"]`);
    if (!row) return;
    revealed.current = activeId;
    row.scrollIntoView({ block: "nearest" });
  });

  const renderConnection = (p: Profile) => (
    <SidebarConnection
      key={p.id}
      p={p}
      active={p.id === activeId}
      open={expanded.has(p.id)}
      list={bucketsBy[p.id]}
      bucket={bucket}
      hidden={hiddenBuckets[p.id]}
      revealing={showHidden.has(p.id)}
      onReveal={() =>
        setShowHidden((cur) => {
          const next = new Set(cur);
          if (next.has(p.id)) next.delete(p.id);
          else next.add(p.id);
          return next;
        })
      }
      own={builtIn(p)}
      authNeeded={!!authNeeded?.has(p.id)}
      rootLabel={rootLabel}
      onToggleProfile={onToggleProfile}
      onEditProfile={onEditProfile}
      onSelectBucket={onSelectBucket}
      onOpenBucketByName={onOpenBucketByName}
      onNewBucket={onNewBucket}
      onHideBucket={onHideBucket}
      onReconnect={onReconnect}
      onSignInAgain={onSignInAgain}
      onConnectionMenu={onConnectionMenu}
      onBucketMenu={onBucketMenu}
      mounts={mounts}
      onDriveMenu={onDriveMenu}
      picked={pickedSet.has(p.id)}
      pickMode={pickedSet.size > 0}
      onPick={onTogglePick}
      dragProps={dragProps(p)}
    />
  );

  return (
    // the web view's own menu (Reload, Inspect) means nothing here
    <aside
      className={`sidebar ${drag.active ? "dragging-conn" : ""}`}
      onContextMenu={(e) => e.preventDefault()}
      // Esc lets go of the picked connections (the find field has its own Esc)
      onKeyDown={(e) => {
        if (e.key === "Escape" && pickedSet.size && !(e.target instanceof HTMLInputElement)) {
          e.stopPropagation();
          onClearPicks?.();
        }
      }}
    >
      {drag.ghost}
      <div className="sidebar-drag" data-tauri-drag-region>
        {onHide && <SidebarToggle open={!peek} overlay={peek} onToggle={onHide} />}
      </div>
      {showFind && (
        <div className="side-find">
          <Icon name="search" size={13} />
          <input
            ref={findRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onFindKey}
            onBlur={() => !query && setFindAsked(false)}
            placeholder="Find connection"
            aria-label="Find a connection"
            role="combobox"
            aria-expanded={searching}
            aria-controls="side-find-results"
            aria-activedescendant={searching && found[cursor] ? `side-find-${found[cursor].p.id}` : undefined}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query ? (
            <button
              type="button"
              className="icon-btn side-find-clear"
              onClick={() => {
                setQuery("");
                findRef.current?.focus();
              }}
              title="Clear (Esc)"
              aria-label="Clear"
            >
              <Icon name="x" size={11} />
            </button>
          ) : (
            <kbd className="side-find-key" aria-hidden="true">
              {keys("⌥⌘F")}
            </kbd>
          )}
        </div>
      )}
      {pickedProfiles.length > 0 && (
        <div className="side-picked" role="toolbar" aria-label="Selected connections">
          <span className="side-picked-n">{pickedProfiles.length} selected</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMoveMenu?.(pickedProfiles.map((p) => p.id), Math.round(r.left), Math.round(r.bottom + 2));
            }}
          >
            Move to group…
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onTogglePin?.(pickedProfiles.map((p) => p.id))}>
            {pickedProfiles.every((p) => p.pinned) ? "Unpin" : "Pin"}
          </button>
          <button type="button" className="icon-btn" onClick={onClearPicks} title="Clear selection (Esc)" aria-label="Clear selection">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <div className="sidebar-scroll" ref={scrollRef}>
        {searching ? (
          <FindResults
            found={found}
            query={query}
            cursor={cursor}
            activeId={activeId}
            builtIn={builtIn}
            onHover={setCursor}
            onOpen={openFound}
            onConnectionMenu={onConnectionMenu}
          />
        ) : (
          <>
        {favorites && favorites.length > 0 && (
          <div className="fav-list">
            <div className="side-head">
              <span>Favorites</span>
            </div>
            {favorites.map((f) => {
              const p = profiles.find((x) => x.id === f.profileId);
              // a server's one root ("") is the connection itself: no second name for it
              const where = [p?.name ?? "Removed connection", ...(f.bucket === "" ? [] : [rootLabel(f.profileId, f.bucket)]), ...f.prefix.split("/").filter(Boolean)].join(" › ");
              const open = () => p && onOpenFavorite?.(f);
              return (
                <div
                  key={`${f.profileId}|${f.bucket}|${f.prefix}`}
                  className={`side-item fav-row ${p ? "" : "is-hidden"}`}
                  onClick={open}
                  onKeyDown={onActivate(open)}
                  role="button"
                  tabIndex={0}
                  aria-disabled={!p || undefined}
                  title={p ? where : `${where}. The connection for this favorite was removed.`}
                >
                  <Icon name={f.prefix ? "folder" : rootIcon(f.profileId, f.bucket)} size={14} />
                  <span className="side-label">{f.name}</span>
                  {onRemoveFavorite && (
                    <button
                      className="icon-btn side-hide"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveFavorite(f);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      title="Remove from favorites"
                      aria-label={`Remove ${f.name} from favorites`}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {pinnedProfiles.length > 0 && (
          <div className="pinned-list">
            <div className="side-head">
              <span>Pinned</span>
            </div>
            {pinnedProfiles.map(renderConnection)}
          </div>
        )}
        {showRecent && (
          <div className="recent-list">
            <div className="side-head">
              <span>Recent</span>
            </div>
            {recentProfiles.map((p) => (
              <div
                key={p.id}
                className="side-item recent-row"
                onClick={() => onOpenConnection?.(p)}
                onKeyDown={onActivate(() => onOpenConnection?.(p))}
                role="button"
                tabIndex={0}
                title={builtIn(p) ? p.name : `${p.name} · ${addressOf(p)}`}
                onContextMenu={
                  onConnectionMenu &&
                  ((e) => {
                    e.preventDefault();
                    onConnectionMenu(p, e.clientX, e.clientY);
                  })
                }
              >
                <ConnBadge p={p} own={builtIn(p)} />
                <span className="side-label">{p.name}</span>
                {groupOf(p) && <span className="side-aside">{groupName(groupOf(p))}</span>}
              </div>
            ))}
          </div>
        )}
        {profiles.length > 0 && (
          // dropping connections on this heading takes them out of their group
          <div className={`side-head ${drag.over === "" ? "drop-over" : ""}`} {...(onMoveToGroup ? { "data-conn-drop": "" } : {})}>
            <span>Connections</span>
            {many && <span className="side-count">{profiles.length}</span>}
          </div>
        )}
        {/* the connections with buckets and This Mac, then a section per server kind, then the groups */}
        {(typed ? typed.device : layout.top.items).map(renderConnection)}
        {layout.sections.map((s) => (
          <KindSectionRow key={s.key} section={s} ctx={ctxFor(s.key)} onMenu={onSectionMenu} renderConnection={renderConnection} />
        ))}
        {layout.top.groups.map((g) => (
          <GroupRow key={g.path} node={g} depth={0} ctx={topCtx} renderConnection={renderConnection} />
        ))}
        {typed?.nodes.map((g) => (
          <GroupRow key={g.path} node={g} depth={0} ctx={typeCtx} renderConnection={renderConnection} />
        ))}
          </>
        )}
      </div>
      <div className="side-foot">
        <button className="side-item" onClick={onNewProfile}>
          <Icon name="plus" size={15} />
          <span className="side-label">New connection</span>
        </button>
        <button
          className={`icon-btn sync-ind ${syncState ?? "none"}`}
          onClick={onOpenSync}
          title={syncState ? SYNC_LABEL[syncState] : "Folder sync"}
          aria-label={syncState ? SYNC_LABEL[syncState] : "Folder sync"}
        >
          <Icon name="sync" size={15} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title={keys("Settings (⌘,)")} aria-label="Settings">
          <Icon name="settings" size={16} />
        </button>
      </div>
    </aside>
  );
}

/**
 * One connection in the sidebar. Most fold open on their buckets (or drives, or this computer's
 * folders); a connection with a single root (a server, one container) has no level to fold: a
 * click opens it, and it is highlighted while it's on screen.
 */
function SidebarConnection({
  p,
  active,
  open,
  list,
  bucket,
  hidden: hiddenList,
  revealing: revealAsked,
  onReveal,
  own,
  authNeeded,
  rootLabel,
  onToggleProfile,
  onEditProfile,
  onSelectBucket,
  onOpenBucketByName,
  onNewBucket,
  onHideBucket,
  onReconnect,
  onSignInAgain,
  onConnectionMenu,
  onBucketMenu,
  mounts = [],
  onDriveMenu,
  picked = false,
  pickMode = false,
  onPick,
  dragProps,
}: {
  p: Profile;
  active: boolean;
  open: boolean;
  list: BucketList | undefined;
  bucket: string | null;
  hidden: string[] | undefined;
  revealing: boolean;
  onReveal: () => void;
  own: boolean;
  authNeeded: boolean;
  rootLabel: (profileId: string, root: string) => string;
  onToggleProfile: (p: Profile) => void;
  onEditProfile: (p: Profile) => void;
  onSelectBucket: (p: Profile, b: string) => void;
  onOpenBucketByName: (p: Profile) => void;
  onNewBucket: (p: Profile) => void;
  onHideBucket: (p: Profile, bucket: string, hide: boolean) => void;
  onReconnect: (p: Profile) => void;
  onSignInAgain?: (p: Profile) => void;
  onConnectionMenu?(p: Profile, x: number, y: number): void;
  onBucketMenu?(p: Profile, bucket: string, x: number, y: number): void;
  mounts?: MountInfo[];
  onDriveMenu?(m: MountInfo, x: number, y: number): void;
  /** picked to organize with others (⌘-click) */
  picked?: boolean;
  /** some connection is picked: a click picks this one too */
  pickMode?: boolean;
  onPick?(p: Profile): void;
  /** the row's drag handlers (useConnectionDrag) */
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const caps = useCaps(p.id);
  const mode = rootsMode(p, caps);
  const single = mode === "single";
  const hidden = new Set(hiddenList ?? []);
  const hiddenHere = (list?.names ?? []).filter((b) => hidden.has(b));
  const revealing = revealAsked && hiddenHere.length > 0;
  // making buckets is Kybl Storage's (and whatever else says so); opening one by name is S3's
  const canCreate = caps ? caps.createRoot : p.provider === KYBL;
  const canOpenByName = !own && mode === "buckets" && !canCreate;
  const here = active && single && bucket === "";
  const activate = () => (single ? onSelectBucket(p, "") : onToggleProfile(p));
  // ⌘/Ctrl-click (or any click while some are picked) picks the connection instead of opening it
  const click = (e: React.MouseEvent) => {
    if (onPick && !own && (e.metaKey || e.ctrlKey || e.shiftKey || pickMode)) return onPick(p);
    activate();
  };
  const rootIco = rootIcon(p.id);
  return (
    <div>
      <div
        className={`side-item conn ${open && !single ? "open" : ""} ${active ? "active" : ""} ${here ? "selected" : ""} ${single ? "single" : ""} ${picked ? "picked" : ""}`}
        {...dragProps}
        onClick={click}
        onKeyDown={onActivate(activate)}
        role="button"
        tabIndex={0}
        aria-expanded={single ? undefined : open}
        aria-current={here || undefined}
        aria-label={p.name}
        title={own ? undefined : addressOf(p)}
        data-conn-row={p.id}
        onContextMenu={
          onConnectionMenu &&
          ((e) => {
            e.preventDefault();
            onConnectionMenu(p, e.clientX, e.clientY);
          })
        }
        // a server's one root takes dropped items at its top level, like a bucket row
        {...(single ? { "data-drop-bucket": "", "data-drop-profile": p.id } : {})}
      >
        <ConnBadge p={p} own={own} />
        <span className="side-label" title={p.cloud?.accountEmail && p.cloud.accountEmail !== p.name ? `${p.name} · ${p.cloud.accountEmail}` : undefined}>
          {p.name}
        </span>
        {p.pinned && <Icon name="pin" size={11} className="pin-mark" />}
        <DriveBadge m={findMount(mounts, p.id, "", "")} onMenu={onDriveMenu} />
        {p.kind === "sftp" && <TunnelBadge p={p} />}
        {/* an icon, not a word: the sidebar is narrow and the name must stay readable */}
        {authNeeded && onSignInAgain && (
          <button
            className="auth-badge icon"
            onClick={(e) => {
              e.stopPropagation();
              onSignInAgain(p);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title="Kybl's access to this account ended. Sign in again"
            aria-label={`Sign in to ${p.name} again`}
          >
            <Icon name="alert" size={12} />
          </button>
        )}
        {!own && (
          <button
            className="icon-btn side-edit"
            onClick={(e) => {
              e.stopPropagation();
              onEditProfile(p);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title="Edit connection"
            aria-label={`Edit connection ${p.name}`}
          >
            <Icon name="edit" size={14} />
          </button>
        )}
        {!single && <Icon name="chevron" size={13} className="side-caret" />}
      </div>
      {/* the pane shows the whole message; here two lines are enough to say something's wrong */}
      {single && active && list?.note && !list.names.length && (
        <p className="side-note clamp" title={list.note}>
          {list.note}
        </p>
      )}
      {open && !single && (
        <div className="bucket-list">
          {list?.names.map((b) => {
            const here = active && b === bucket;
            const isHidden = hidden.has(b);
            // the bucket on screen stays listed even when hidden, so you can see where you are
            if (isHidden && !revealing && !here) return null;
            return (
              <div
                key={b}
                className={`side-item sub bucket-row ${here ? "selected" : ""} ${isHidden ? "is-hidden" : ""}`}
                onClick={() => onSelectBucket(p, b)}
                onKeyDown={onActivate(() => onSelectBucket(p, b))}
                role="button"
                tabIndex={0}
                aria-current={here}
                // the list's drag (useItemDrag) drops items here: at the bucket's top level
                data-drop-bucket={b}
                data-drop-profile={p.id}
                onContextMenu={
                  onBucketMenu &&
                  ((e) => {
                    e.preventDefault();
                    onBucketMenu(p, b, e.clientX, e.clientY);
                  })
                }
              >
                <Icon name={rootIco} size={14} />
                <span className="side-label" title={own ? b : undefined}>
                  {rootLabel(p.id, b)}
                </span>
                <DriveBadge m={findMount(mounts, p.id, b, "")} onMenu={onDriveMenu} />
                <button
                  className="icon-btn side-hide"
                  onClick={(e) => {
                    e.stopPropagation();
                    onHideBucket(p, b, !isHidden);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  title={isHidden ? "Show in the sidebar" : "Hide from the sidebar"}
                  aria-label={isHidden ? `Show ${rootLabel(p.id, b)} in the sidebar` : `Hide ${rootLabel(p.id, b)} from the sidebar`}
                >
                  <Icon name={isHidden ? "eye" : "eye-off"} size={13} />
                </button>
              </div>
            );
          })}
          {hiddenHere.length > 0 && (
            <button className="side-item sub link" onClick={onReveal}>
              <Icon name={revealing ? "eye-off" : "eye"} size={14} />
              <span className="side-label">{revealing ? "Done choosing" : `${hiddenHere.length} hidden`}</span>
            </button>
          )}
          {list?.loading && !list.names.length && <p className="side-note">{own || mode === "drives" ? "Loading…" : "Loading buckets…"}</p>}
          {list?.note && (
            <p className="side-note">
              {list.note}
              {list.reconnect && (
                <>
                  {" "}
                  <button className="link-btn" onClick={() => onReconnect(p)}>
                    Connect again
                  </button>
                </>
              )}
            </p>
          )}
          {canCreate ? (
            <button className="side-item sub link" onClick={() => onNewBucket(p)}>
              <Icon name="plus" size={14} />
              <span className="side-label">New bucket</span>
            </button>
          ) : (
            canOpenByName && (
              <button className="side-item sub link" onClick={() => onOpenBucketByName(p)}>
                <Icon name="plus" size={14} />
                <span className="side-label">Open bucket by name</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** the sidebar's show/hide button: by the window controls when it's open, atop the icon rail when not */
export function SidebarToggle({ open, overlay, onToggle }: { open: boolean; overlay?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`icon-btn side-toggle ${open || overlay ? "" : "in-rail"}`}
      onClick={onToggle}
      title={keys(`${open ? "Collapse" : "Expand"} sidebar (⌥⌘S)`)}
      aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
      aria-expanded={open}
    >
      <Icon name="sidebar" size={17} />
    </button>
  );
}

/**
 * The sidebar folded to an icon rail (like a code editor's activity bar): favorites and
 * connections as icons, a connection's buckets in a menu on click, and the footer's buttons.
 */
export function SidebarRail({
  profiles,
  activeId,
  favorites,
  syncState,
  authNeeded,
  builtIn = () => false,
  onExpand,
  onPick,
  onOpenFavorite,
  onNewProfile,
  onOpenSync,
  onOpenSettings,
  onConnectionMenu,
  onHover,
  recent = [],
  onMore,
  onSection,
}: {
  profiles: Profile[];
  activeId: string | null;
  /** a server kind's icon was clicked: its connections in a menu next to it */
  onSection?: (s: KindSection, x: number, y: number) => void;
  /** connections opened last, newest first (ids): what a long list keeps on the rail */
  recent?: string[];
  /** a long list's "All connections": the whole sidebar over the panes, its filter field ready */
  onMore?: () => void;
  favorites?: Favorite[];
  syncState: SyncState | null;
  authNeeded?: Set<string>;
  builtIn?: (p: Profile) => boolean;
  onExpand: () => void;
  /** a connection's icon was clicked: its buckets (or the connection itself) next to it */
  onPick: (p: Profile, x: number, y: number) => void;
  onOpenFavorite?(f: Favorite): void;
  onNewProfile: () => void;
  onOpenSync: () => void;
  onOpenSettings: () => void;
  onConnectionMenu?(p: Profile, x: number, y: number): void;
  /** the pointer rests on (or leaves) an icon: the whole sidebar comes in over the panes */
  onHover?: (on: boolean) => void;
}) {
  const favs = (favorites ?? []).filter((f) => profiles.some((p) => p.id === f.profileId));
  // a long list doesn't fit as icons: the one on screen and the recent ones stay, the rest is a
  // click (or ⌥⌘F) away in the full sidebar
  const long = profiles.length > RECENT_MIN && !!onMore;
  // a server kind with a section in the sidebar is one icon here too, its connections in a menu
  const layout = useMemo(() => sidebarLayout(profiles), [profiles]);
  const sections = onSection ? layout.sections : [];
  const inSection = new Set(profiles.filter((p) => sections.some((s) => s.kind === p.kind)).map((p) => p.id));
  const shown = long
    ? [activeId, ...recent.filter((id) => id !== activeId).slice(0, RECENT_SHOWN)].map((id) => profiles.find((p) => p.id === id)).filter((p): p is Profile => !!p)
    : profiles.filter((p) => !inSection.has(p.id));
  const shownIds = new Set(shown.map((p) => p.id));
  return (
    <aside className="sidebar rail" onContextMenu={(e) => e.preventDefault()}>
      <div className="sidebar-drag" data-tauri-drag-region />
      <SidebarToggle open={false} onToggle={onExpand} />
      <div className="rail-scroll" onMouseOver={(e) => onHover?.(!!(e.target as Element).closest(".rail-btn"))} onMouseLeave={() => onHover?.(false)}>
        {favs.map((f) => (
          <button
            key={`${f.profileId}|${f.bucket}|${f.prefix}`}
            type="button"
            className="rail-btn"
            onClick={() => onOpenFavorite?.(f)}
            title={f.name}
            aria-label={`Favorite: ${f.name}`}
          >
            <Icon name={f.prefix ? "folder" : rootIcon(f.profileId, f.bucket)} size={17} />
            <span className="rail-star" aria-hidden="true">
              <Icon name="star" size={8} />
            </span>
          </button>
        ))}
        {favs.length > 0 && <div className="rail-sep" />}
        {shown.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`rail-btn ${p.id === activeId ? "active" : ""}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onPick(p, r.right + 6, r.top);
            }}
            onContextMenu={
              onConnectionMenu &&
              ((e) => {
                e.preventDefault();
                onConnectionMenu(p, e.clientX, e.clientY);
              })
            }
            title={groupOf(p) ? `${p.name} · ${groupOf(p).split("/").join(" › ")}` : p.name}
            aria-label={p.name}
            aria-haspopup="menu"
          >
            <ConnBadge p={p} own={builtIn(p)} large />
            {authNeeded?.has(p.id) && <span className="rail-dot" title="Sign in again" />}
          </button>
        ))}
        {sections.length > 0 && shown.length > 0 && <div className="rail-sep" />}
        {sections.map((s) => {
          // the connection on screen is in here, and has no icon of its own above
          const holds = !!activeId && !shownIds.has(activeId) && profiles.some((p) => p.id === activeId && p.kind === s.kind);
          return (
            <button
              key={s.key}
              type="button"
              className={`rail-btn rail-kind ${holds ? "active" : ""}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onSection?.(s, r.right + 6, r.top);
              }}
              title={`${s.tree.count} ${s.label} ${s.tree.count === 1 ? "connection" : "connections"}`}
              aria-label={`${s.label}: ${plural(s.tree.count, "connection")}`}
              aria-haspopup="menu"
            >
              <ProviderBadge provider={s.kind} large />
              <span className="rail-kind-count" aria-hidden="true">
                {s.tree.count > 99 ? "99+" : s.tree.count}
              </span>
            </button>
          );
        })}
        {long && (
          <button type="button" className="rail-btn rail-more" onClick={onMore} title={keys(`All ${profiles.length} connections (⌥⌘F)`)} aria-label={`All ${profiles.length} connections`}>
            <Icon name="search" size={16} />
            <span className="rail-more-count" aria-hidden="true">
              {profiles.length > 999 ? "999+" : profiles.length}
            </span>
          </button>
        )}
      </div>
      <div className="rail-foot">
        <button type="button" className="icon-btn" onClick={onNewProfile} title="New connection" aria-label="New connection">
          <Icon name="plus" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn sync-ind ${syncState ?? "none"}`}
          onClick={onOpenSync}
          title={syncState ? SYNC_LABEL[syncState] : "Folder sync"}
          aria-label={syncState ? SYNC_LABEL[syncState] : "Folder sync"}
        >
          <Icon name="sync" size={15} />
        </button>
        <button type="button" className="icon-btn" onClick={onOpenSettings} title={keys("Settings (⌘,)")} aria-label="Settings">
          <Icon name="settings" size={16} />
        </button>
      </div>
    </aside>
  );
}
