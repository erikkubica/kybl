import { useState } from "react";
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

const onActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

export type BucketList = {
  names: string[];
  note: string | null;
  loading: boolean;
  /** a Kybl Storage key that no longer works: offer to connect again */
  reconnect?: boolean;
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
  onHide,
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
  /** folds the sidebar away (its button sits by the window controls) */
  onHide?: () => void;
}) {
  // connections whose hidden buckets are on show (to pick which to bring back)
  const [showHidden, setShowHidden] = useState<Set<string>>(new Set());
  return (
    // the web view's own menu (Reload, Inspect) means nothing here
    <aside className="sidebar" onContextMenu={(e) => e.preventDefault()}>
      <div className="sidebar-drag" data-tauri-drag-region>
        {onHide && <SidebarToggle open onToggle={onHide} />}
      </div>
      <div className="sidebar-scroll">
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
        {profiles.length > 0 && (
          <div className="side-head">
            <span>Connections</span>
          </div>
        )}
        {profiles.map((p) => (
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
          />
        ))}
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
        <button className="icon-btn" onClick={onOpenSettings} title="Settings (⌘,)" aria-label="Settings">
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
  const rootIco = rootIcon(p.id);
  return (
    <div>
      <div
        className={`side-item conn ${open && !single ? "open" : ""} ${active ? "active" : ""} ${here ? "selected" : ""} ${single ? "single" : ""}`}
        onClick={activate}
        onKeyDown={onActivate(activate)}
        role="button"
        tabIndex={0}
        aria-expanded={single ? undefined : open}
        aria-current={here || undefined}
        aria-label={p.name}
        title={own ? undefined : addressOf(p)}
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
        {own ? (
          <span className="pbadge local" aria-hidden="true">
            <Icon name={deviceIcon} size={12} />
          </span>
        ) : (
          <ProviderBadge provider={p.provider} />
        )}
        <span className="side-label" title={p.cloud?.accountEmail && p.cloud.accountEmail !== p.name ? `${p.name} · ${p.cloud.accountEmail}` : undefined}>
          {p.name}
        </span>
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
      {single && active && list?.note && !list.names.length && <p className="side-note">{list.note}</p>}
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

/** the sidebar's show/hide button, by the window controls (the same spot whether it's open or not) */
export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`icon-btn side-toggle ${open ? "" : "floating"}`}
      onClick={onToggle}
      title={`${open ? "Hide" : "Show"} sidebar (⌥⌘S)`}
      aria-label={open ? "Hide sidebar" : "Show sidebar"}
      aria-expanded={open}
    >
      <Icon name="sidebar" size={17} />
    </button>
  );
}
