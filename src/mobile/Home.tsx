/**
 * The phone's home screen (favourites, recent places, connections with their buckets) and the
 * connection list the tablet sidebar shares with it.
 */
import { useState } from "react";
import { Icon } from "../Icons";
import { FileIcon } from "../components/FileIcon";
import { ProviderBadge } from "../components/Sidebar";
import { baseName } from "../format";
import { KYBL } from "../kybl";
import { PROVIDERS } from "../providers";
import type { Favorite } from "../settings";
import type { Profile } from "../types";
import { MIcon } from "./icons";
import { Lockup, Mascot } from "./Mascot";
import { SkeletonList, usePress } from "./rows";
import { TransfersButton } from "./TransfersScreen";
import { useCollapsed } from "./ui";
import type { Loc } from "./useListing";
import { connName, isLocal } from "./connName";
import { useCaps } from "../useCaps";
import { rootsMode, useRootName } from "../connections/roots";
import { addressOf } from "../connections/kinds";
import type { Capabilities } from "../api";

/** `revoked`: a Kybl Storage key the storage no longer knows (offer "Connect again") */
export type Buckets = {
  names: string[];
  note: string | null;
  loading: boolean;
  revoked?: boolean;
  /** names to show, where a root's id isn't one (this phone's folders are ids by path) */
  labels?: Record<string, string>;
  /** the "+" row: make a bucket, open one by name, or neither (what the connection can do) */
  add?: "new" | "open" | null;
};

/** What the "+" row under a connection does; until its capabilities are known, Kybl Storage makes buckets. */
export const addKind = (p: Profile, bl: Buckets | undefined) =>
  bl?.add !== undefined ? bl.add : p.provider === KYBL ? "new" : rootsMode(p) === "buckets" ? "open" : null;

/** One bucket in a connection's list: tap opens it, long-press offers to hide it (or show it). */
function BucketItem({
  label,
  icon = "bucket",
  here,
  hidden,
  compact,
  choosing,
  onOpen,
  onMenu,
  onToggle,
}: {
  label: string;
  /** buckets, drives, or this device's folders */
  icon?: "bucket" | "cloud" | "folder";
  here: boolean;
  hidden: boolean;
  compact: boolean;
  /** "Choose buckets" mode: an eye button shows or hides each one */
  choosing: boolean;
  onOpen: () => void;
  onMenu: () => void;
  onToggle: () => void;
}) {
  const press = usePress(onOpen, onMenu);
  if (choosing) {
    // the row is not a button here: the switch is the one control, so screen readers get a
    // switch with its state (a tap anywhere on the row still flips it)
    return (
      <li className="m-bucket-li">
        <div className={`m-bucket ${here ? "here" : ""} ${hidden ? "is-hidden" : ""}`} onClick={onToggle}>
          <span className="m-bucket-ico">
            <Icon name={icon} size={compact ? 16 : 18} />
          </span>
          <span className="m-bucket-name">{label}</span>
          <button
            type="button"
            className={`m-bucket-eye ${hidden ? "" : "on"}`}
            role="switch"
            aria-checked={!hidden}
            aria-label={`Show ${label} in the list`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <Icon name={hidden ? "eye-off" : "eye"} size={18} />
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="m-bucket-li">
      <button className={`m-bucket ${here ? "here" : ""} ${hidden ? "is-hidden" : ""}`} {...press}>
        <span className="m-bucket-ico">
          <Icon name={icon} size={compact ? 16 : 18} />
        </span>
        <span className="m-bucket-name">{label}</span>
        {!compact && <Icon name="chevron" size={13} className="m-chev" />}
      </button>
    </li>
  );
}

/** Connections with their buckets, as cards (phone home) or a sidebar list (tablets). */
export function Connections({
  profiles,
  error,
  buckets,
  current,
  compact,
  onRetry,
  onRetryProfiles,
  onOpen,
  onAdd,
  onConnMenu,
  onAddBucket,
  onReconnect,
  hidden,
  onBucketMenu,
  onBucketHidden,
  choosing,
  onChoose,
  authNeeded,
  onSignInAgain,
}: {
  profiles: Profile[] | null;
  /** loading the connections failed (keeps people from adding them twice) */
  error: string | null;
  buckets: Record<string, Buckets>;
  current: Loc | null;
  compact: boolean;
  onRetry: (p: Profile) => void;
  onRetryProfiles: () => void;
  onOpen: (p: Profile, bucket: string) => void;
  onAdd: () => void;
  /** the connection's "…" button: edit, choose buckets, open by name / new bucket */
  onConnMenu: (p: Profile) => void;
  /** Kybl Storage: make a bucket; others: open one by its name */
  onAddBucket: (p: Profile) => void;
  onReconnect: (p: Profile) => void;
  /** buckets left out of the list, per connection */
  hidden: Record<string, string[]>;
  /** long-press on a bucket: hide it, or show it again */
  onBucketMenu: (p: Profile, bucket: string, hidden: boolean) => void;
  onBucketHidden: (p: Profile, bucket: string, hide: boolean) => void;
  /** the connection whose buckets are being chosen, if any */
  choosing: string | null;
  onChoose: (profileId: string | null) => void;
  /** sign-in connections whose access ended: "Sign in again" on their card */
  authNeeded?: Set<string>;
  onSignInAgain?: (p: Profile) => void;
}) {
  const [all, setAll] = useState<Record<string, boolean>>({});
  if (error && !profiles?.length) {
    return (
      <div className="m-empty">
        <div className="m-empty-art warn">
          <Icon name="alert" size={30} />
        </div>
        <h3>Couldn't load your connections</h3>
        <p className="m-empty-err">{error}</p>
        <button className="btn" onClick={onRetryProfiles}>
          <Icon name="retry" size={14} /> Try again
        </button>
      </div>
    );
  }
  if (profiles === null) return <SkeletonList />;
  if (profiles.length === 0) return null;
  return (
    <div className={compact ? "m-conns compact" : "m-conns"}>
      {profiles.map((p) => (
        <ConnCard
          key={p.id}
          p={p}
          bl={buckets[p.id]}
          current={current}
          compact={compact}
          hidden={hidden[p.id]}
          picking={choosing === p.id}
          showAll={!!all[p.id]}
          onShowAll={() => setAll((a) => ({ ...a, [p.id]: true }))}
          authNeeded={!!authNeeded?.has(p.id)}
          onSignInAgain={onSignInAgain}
          onRetry={onRetry}
          onOpen={onOpen}
          onConnMenu={onConnMenu}
          onAddBucket={onAddBucket}
          onReconnect={onReconnect}
          onBucketMenu={onBucketMenu}
          onBucketHidden={onBucketHidden}
          onChoose={onChoose}
        />
      ))}
      {!compact && (
        <button className="m-add-row" onClick={onAdd}>
          <Icon name="plus" size={16} /> Add a connection
        </button>
      )}
    </div>
  );
}

/** What the roots of a connection are called in its card and menus. */
export function rootWord(p: Profile, caps: Capabilities | null | undefined, plural = false): string {
  const mode = rootsMode(p, caps);
  const w = mode === "buckets" ? "bucket" : isLocal(p) ? "folder" : "drive";
  return plural ? `${w}s` : w;
}

/**
 * One connection on the home screen (or the tablet's sidebar) with its buckets, drives or
 * folders. A connection with a single root (a server, one container) has no list: tapping it
 * opens it.
 */
function ConnCard({
  p,
  bl,
  current,
  compact,
  hidden,
  picking,
  showAll,
  onShowAll,
  authNeeded,
  onSignInAgain,
  onRetry,
  onOpen,
  onConnMenu,
  onAddBucket,
  onReconnect,
  onBucketMenu,
  onBucketHidden,
  onChoose,
}: {
  p: Profile;
  bl: Buckets | undefined;
  current: Loc | null;
  compact: boolean;
  hidden: string[] | undefined;
  picking: boolean;
  showAll: boolean;
  onShowAll: () => void;
  authNeeded: boolean;
  onSignInAgain?: (p: Profile) => void;
  onRetry: (p: Profile) => void;
  onOpen: (p: Profile, bucket: string) => void;
  onConnMenu: (p: Profile) => void;
  onAddBucket: (p: Profile) => void;
  onReconnect: (p: Profile) => void;
  onBucketMenu: (p: Profile, bucket: string, hidden: boolean) => void;
  onBucketHidden: (p: Profile, bucket: string, hide: boolean) => void;
  onChoose: (profileId: string | null) => void;
}) {
  const caps = useCaps(p.id);
  const label = useRootName();
  const single = rootsMode(p, caps) === "single";
  const word = rootWord(p, caps);
  const words = rootWord(p, caps, true);
  const hiddenSet = new Set(hidden ?? []);
  const hiddenHere = (bl?.names ?? []).filter((b) => hiddenSet.has(b));
  // the bucket on screen stays listed even when hidden
  const names = (bl?.names ?? []).filter((b) => picking || !hiddenSet.has(b) || (current?.profileId === p.id && current.bucket === b));
  const limit = compact || showAll || picking ? names.length : 5;
  const here = single && current?.profileId === p.id && current.bucket === "";
  const sub = !compact && !isLocal(p) ? addressOf(p).replace(/^https?:\/\//, "") : "";
  // on a line of its own under the name, which stays readable on a narrow phone
  const signIn = authNeeded && onSignInAgain && !bl?.note && (
    <div className="m-auth-row">
      <span>Kybl's access to this account ended.</span>
      <button className="auth-badge" onClick={() => onSignInAgain(p)} aria-label={`Sign in to ${connName(p)} again`}>
        Sign in again
      </button>
    </div>
  );
  const note = bl?.note && (
    <li className="m-bucket-note">
      <span>{bl.note}</span>
      {bl.revoked ? (
        <button className="btn btn-primary btn-sm" onClick={() => onReconnect(p)}>
          Connect again
        </button>
      ) : authNeeded && onSignInAgain ? (
        <button className="btn btn-primary btn-sm" onClick={() => onSignInAgain(p)}>
          Sign in again
        </button>
      ) : (
        <button className="btn btn-sm" onClick={() => onRetry(p)}>
          Retry
        </button>
      )}
    </li>
  );

  if (single) {
    return (
      <section className={`m-conn single ${here ? "here" : ""}`}>
        <header className="m-conn-head">
          <button className="m-conn-open" onClick={() => onOpen(p, "")} aria-current={here || undefined}>
            <ProviderBadge provider={p.provider} />
            <span className="m-conn-text">
              <strong>{connName(p)}</strong>
              {sub && <small>{sub}</small>}
            </span>
            {!compact && <Icon name="chevron" size={13} className="m-chev" />}
          </button>
          <button className="m-icon m-conn-edit" onClick={() => onConnMenu(p)} aria-label={`Options for ${connName(p)}`}>
            <Icon name="more" size={compact ? 16 : 18} />
          </button>
        </header>
        {signIn}
        {note && <ul className="m-buckets">{note}</ul>}
      </section>
    );
  }

  return (
    <section className="m-conn">
      <header className="m-conn-head">
        <ProviderBadge provider={p.provider} />
        <span className="m-conn-text">
          <strong>{connName(p)}</strong>
          {sub && <small>{sub}</small>}
        </span>
        <button className="m-icon m-conn-edit" onClick={() => onConnMenu(p)} aria-label={`Options for ${connName(p)}`}>
          <Icon name="more" size={compact ? 16 : 18} />
        </button>
      </header>
      {signIn}
      <ul className="m-buckets">
        {picking && <li className="m-bucket-note">Tap a {word} to show or hide it on this list.</li>}
        {bl?.loading && !names.length && (
          <li className="m-bucket-note">
            <span className="spinner" /> Loading {words}…
          </li>
        )}
        {note}
        {names.slice(0, limit).map((b) => (
          <BucketItem
            key={b}
            label={bl?.labels?.[b] ?? label(p.id, b)}
            icon={word === "bucket" ? "bucket" : word === "folder" ? "folder" : "cloud"}
            here={current?.profileId === p.id && current.bucket === b}
            hidden={hiddenSet.has(b)}
            compact={compact}
            choosing={picking}
            onOpen={() => onOpen(p, b)}
            onMenu={() => onBucketMenu(p, b, hiddenSet.has(b))}
            onToggle={() => onBucketHidden(p, b, !hiddenSet.has(b))}
          />
        ))}
        {names.length > limit && (
          <li>
            <button className="m-bucket m-bucket-all" onClick={onShowAll}>
              Show all {names.length} {words}
            </button>
          </li>
        )}
        {picking ? (
          <li>
            <button className="m-bucket m-bucket-all m-accent" onClick={() => onChoose(null)}>
              Done
            </button>
          </li>
        ) : (
          hiddenHere.length > 0 && (
            <li>
              <button className="m-bucket m-bucket-all" onClick={() => onChoose(p.id)}>
                {hiddenHere.length} hidden · Choose {words}
              </button>
            </li>
          )
        )}
        {!bl?.loading && !picking && addKind(p, bl) && (
          <li>
            <button className="m-bucket m-bucket-add" onClick={() => onAddBucket(p)}>
              <span className="m-bucket-ico">
                <Icon name="plus" size={compact ? 15 : 17} />
              </span>
              <span className="m-bucket-name">{addKind(p, bl) === "new" ? "New bucket" : "Open bucket by name"}</span>
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

/** A favourite or recent place: tap opens it, long-press offers to remove it. */
function Place({ loc, label, sub, star, onOpen, onMenu }: { loc: Loc; label: string; sub: string; star?: boolean; onOpen: () => void; onMenu: () => void }) {
  const press = usePress(onOpen, onMenu);
  return (
    <button className="m-place" {...press} aria-label={`${label}, ${sub}`}>
      <span className="m-place-art">
        {loc.prefix ? (
          <FileIcon entry={{ kind: "folder", key: loc.prefix, name: label, size: 0, modified: null }} big />
        ) : (
          <span className="m-place-bucket">
            <Icon name="bucket" size={26} />
          </span>
        )}
        {star && (
          <span className="m-place-star">
            <MIcon name="star-fill" size={12} />
          </span>
        )}
      </span>
      <strong>{label}</strong>
      <small>{sub}</small>
    </button>
  );
}

export function HomeScreen({
  profiles,
  recent,
  favorites,
  connections,
  onRecent,
  onPlaceMenu,
  onAdd,
  onKybl,
  onTransfers,
  onSettings,
  firstRun,
}: {
  profiles: Profile[] | null;
  /** nothing saved yet: the welcome instead of the lists */
  firstRun: boolean;
  recent: Loc[];
  favorites: Favorite[];
  connections: React.ReactNode;
  onRecent: (l: Loc) => void;
  /** long-press on a place: remove it from Favorites or Recent */
  onPlaceMenu: (kind: "favorite" | "recent", l: Loc, name: string) => void;
  onAdd: () => void;
  /** "Connect Kybl Storage" (not on iOS yet) */
  onKybl?: () => void;
  onTransfers: () => void;
  onSettings: () => void;
  /** loading connections failed: never show the first-run welcome then */
  error: string | null;
}) {
  const [heroRef, collapsed] = useCollapsed<HTMLDivElement>(profiles?.length);
  const known = (l: Loc) => profiles?.some((p) => p.id === l.profileId);
  const favs = favorites.filter(known);
  const isFav = (l: Loc) => favs.some((f) => f.profileId === l.profileId && f.bucket === l.bucket && f.prefix === l.prefix);
  const places = recent.filter((r) => known(r) && !isFav(r)).slice(0, 6);
  const label = useRootName();
  const conn = (l: Loc) => profiles?.find((x) => x.id === l.profileId);
  const sub = (l: Loc) => {
    const p = conn(l);
    // a server's one root is the connection itself: its folders say only the connection
    if (l.prefix) return l.bucket === "" && p ? connName(p) : label(l.profileId, l.bucket);
    return p ? connName(p) : "";
  };
  return (
    <section className="m-screen m-home">
      <header className={`m-bar ${collapsed ? "solid" : ""}`}>
        <h1 className="m-home-brand">
          <Lockup size={28} />
        </h1>
        <TransfersButton onClick={onTransfers} />
        <button className="m-icon" onClick={onSettings} aria-label="Settings">
          <Icon name="settings" size={20} />
        </button>
      </header>
      <div className="m-scroll">
        <div className="m-page from-left">
          {firstRun ? (
            <div className="m-welcome">
              <Mascot size={120} className="m-bob" />
              <h1>Your buckets, in your pocket</h1>
              <p>Browse, preview, upload and share files on Hetzner, AWS, Cloudflare R2, Backblaze, Wasabi, MinIO or any S3-compatible storage.</p>
              {onKybl && (
                <button className="btn btn-primary m-big-btn" onClick={onKybl}>
                  <Icon name="cloud" size={16} /> Connect Kybl Storage
                </button>
              )}
              <button className={`btn m-big-btn ${onKybl ? "btn-ghost m-alt-btn" : "btn-primary"}`} onClick={onAdd}>
                <Icon name="plus" size={16} /> {onKybl ? "Add another S3 connection" : "Add a connection"}
              </button>
              <div className="m-providers">
                {PROVIDERS.slice(0, 6).map((p) => (
                  <ProviderBadge key={p.id} provider={p.id} large />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* the brand sits in the bar; this marks the top so the bar turns solid on scroll */}
              <div className="m-sentinel" ref={heroRef} />
              {favs.length > 0 && (
                <>
                  <h2 className="m-section">Favorites</h2>
                  <div className="m-recent">
                    {favs.map((f) => (
                      <Place
                        key={`f|${f.profileId}|${f.bucket}|${f.prefix}`}
                        loc={f}
                        label={f.name}
                        sub={sub(f)}
                        star
                        onOpen={() => onRecent({ profileId: f.profileId, bucket: f.bucket, prefix: f.prefix })}
                        onMenu={() => onPlaceMenu("favorite", f, f.name)}
                      />
                    ))}
                  </div>
                </>
              )}
              {places.length > 0 && (
                <>
                  <h2 className="m-section">Recent</h2>
                  <div className="m-recent">
                    {places.map((r) => {
                      const name = r.prefix ? baseName(r.prefix) : label(r.profileId, r.bucket);
                      return (
                        <Place
                          key={`r|${r.profileId}|${r.bucket}|${r.prefix}`}
                          loc={r}
                          label={name}
                          sub={sub(r)}
                          onOpen={() => onRecent(r)}
                          onMenu={() => onPlaceMenu("recent", r, name)}
                        />
                      );
                    })}
                  </div>
                </>
              )}
              <h2 className="m-section">Connections</h2>
              {connections}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
