/** What a pane shows instead of a list: no connection yet, no bucket open, or a folder that failed to load. */
import { ErrorText } from "../components/ErrorText";
import { KyblMark } from "../components/KyblMark";
import { ProviderBadge } from "../components/Sidebar";
import { PROVIDERS } from "../providers";
import { KYBL, isRevokedKey, kyblError } from "../kybl";
import { Icon } from "../Icons";
import type { Profile } from "../types";
import { useCaps } from "../useCaps";
import { rootsMode } from "../connections/roots";
import { isCloudKind } from "../connections/kinds";

/** The shell's ways out of an empty pane. */
export type EmptyActions = {
  onConnectKybl: () => void;
  onAddConnection: () => void;
  onReconnect: (p: Profile) => void;
  onNewBucket: (p: Profile) => void;
  onOpenBucketByName: (p: Profile) => void;
};

export function Welcome({ actions }: { actions: EmptyActions }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <KyblMark size={76} className="welcome-mark" />
        <h1>Welcome to Kybl</h1>
        <p>Browse, upload, download and share files on any S3-compatible storage. Your secret keys stay in the system keychain.</p>
        <button className="btn btn-primary" onClick={actions.onConnectKybl}>
          <Icon name="cloud" size={15} /> Connect Kybl Storage
        </button>
        <button className="btn btn-ghost welcome-alt" onClick={actions.onAddConnection}>
          Add another S3 connection with keys
        </button>
        <div className="welcome-providers" aria-hidden="true">
          {PROVIDERS.map((p) => (
            <ProviderBadge key={p.id} provider={p.id} large />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChooseBucket({ profile, note, reconnect, actions }: { profile: Profile; note: string | null; reconnect: boolean; actions: EmptyActions }) {
  const caps = useCaps(profile.id);
  const mode = rootsMode(profile, caps);
  // making buckets is Kybl Storage's (or whatever says it can); naming one by hand is S3's
  const kybl = caps ? caps.createRoot : profile.provider === KYBL;
  const byName = !kybl && mode === "buckets";
  const what = mode === "drives" ? "place" : "bucket";
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo plain">
          <Icon name="bucket" size={30} />
        </div>
        <h1>Choose a {what}</h1>
        <p>{note || `Pick a ${what} from the sidebar.`}</p>
        {reconnect ? (
          <button className="btn btn-primary" onClick={() => actions.onReconnect(profile)}>
            <Icon name="refresh" size={14} /> Connect again
          </button>
        ) : (
          (kybl || byName) && (
            <button className="btn" onClick={() => (kybl ? actions.onNewBucket(profile) : actions.onOpenBucketByName(profile))}>
              {kybl ? "New bucket" : "Open bucket by name"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function ListError({ profile, error, onRetry, onReconnect }: { profile: Profile; error: string; onRetry: () => void; onReconnect: (p: Profile) => void }) {
  const revoked = profile.provider === KYBL && isRevokedKey(error);
  // a Google Drive / OneDrive / Dropbox sign-in that ended: sign in again, then it loads
  const signIn = isCloudKind(profile.kind) && /sign in again|no longer signed in|invalid_grant|expired or revoked/i.test(error);
  return (
    <div className="empty error-state">
      <div className="empty-art">
        <Icon name="alert" size={26} />
      </div>
      <h3>Couldn’t load this folder</h3>
      {/* a div: the error's folded details (<details>, <pre>) can't sit inside a <p> */}
      <div className="error-msg">
        <ErrorText message={revoked ? kyblError(error) : error} />
      </div>
      {revoked || signIn ? (
        <button className="btn btn-primary btn-sm kybl-reconnect" onClick={() => onReconnect(profile)}>
          <Icon name="refresh" size={13} /> {signIn ? "Sign in again" : "Connect again"}
        </button>
      ) : (
        <button className="btn btn-sm" onClick={onRetry}>
          <Icon name="retry" size={13} /> Try again
        </button>
      )}
    </div>
  );
}
