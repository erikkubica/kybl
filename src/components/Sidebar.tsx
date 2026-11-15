import { Icon } from "../Icons";
import { KyblLockup, KyblMark } from "./KyblMark";
import { providerMeta } from "../providers";
import type { Profile } from "../types";
import type { SyncState } from "../sync";

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
      {meta.id === "kybl" ? <KyblMark size={large ? 22 : 17} sun /> : meta.mono}
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
  onReconnect,
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
  onReconnect: (p: Profile) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-drag" data-tauri-drag-region>
        <KyblLockup size={20} />
      </div>
      <div className="sidebar-scroll">
        {profiles.length > 0 && (
          <div className="side-head">
            <span>Connections</span>
          </div>
        )}
        {profiles.map((p) => {
          const active = p.id === activeId;
          const open = expanded.has(p.id);
          const list = bucketsBy[p.id];
          return (
            <div key={p.id}>
              <div
                className={`side-item conn ${open ? "open" : ""} ${active ? "active" : ""}`}
                onClick={() => onToggleProfile(p)}
                onKeyDown={onActivate(() => onToggleProfile(p))}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                title={p.endpoint}
              >
                <ProviderBadge provider={p.provider} />
                <span className="side-label">{p.name}</span>
                <button
                  className="icon-btn side-edit"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditProfile(p);
                  }}
                  title="Edit connection"
                  aria-label={`Edit connection ${p.name}`}
                >
                  <Icon name="edit" size={14} />
                </button>
                <Icon name="chevron" size={13} className="side-caret" />
              </div>
              {open && (
                <div className="bucket-list">
                  {list?.names.map((b) => {
                    const here = active && b === bucket;
                    return (
                      <button key={b} className={`side-item sub ${here ? "selected" : ""}`} onClick={() => onSelectBucket(p, b)} aria-current={here}>
                        <Icon name="bucket" size={14} />
                        <span className="side-label">{b}</span>
                      </button>
                    );
                  })}
                  {list?.loading && !list.names.length && <p className="side-note">Loading buckets…</p>}
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
                  <button className="side-item sub link" onClick={() => onOpenBucketByName(p)}>
                    <Icon name="plus" size={14} />
                    <span className="side-label">Open bucket by name…</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
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
