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
import { ConnFixButton, connTrouble } from "../connections/ConnFix";

/** The shell's ways out of an empty pane. */
export type EmptyActions = {
  onConnectKybl: () => void;
  onAddConnection: () => void;
  onReconnect: (p: Profile) => void;
  onNewBucket: (p: Profile) => void;
  onOpenBucketByName: (p: Profile) => void;
  /** A server's own certificate the user chose to trust: save it on the connection; with
   *  `reopen`, connect again (else the caller retries what failed). */
  onTrustCert: (p: Profile, fp: string, reopen: boolean) => Promise<void>;
  /** "Connect without encryption" for an FTP server that offered none: let it use plain FTP;
   *  with `reopen`, connect again (else the caller retries what failed). */
  onAllowPlainFtp: (p: Profile, reopen: boolean) => Promise<void>;
  /** An SFTP server's key (new, or changed since it was trusted) the user chose to trust: save it
   *  on the connection; with `reopen`, connect again (else the caller retries what failed). */
  onTrustHostKey: (p: Profile, fp: string, reopen: boolean) => Promise<void>;
  /** a workspace recipe's pane whose connection isn't on this device: its name (it stays empty) */
  missing?: string;
};

export function Welcome({ actions }: { actions: EmptyActions }) {
  if (actions.missing)
    return (
      <div className="welcome">
        <div className="welcome-card welcome-missing">
          <Icon name="alert" size={22} />
          <h2>{actions.missing === "A connection" ? "A connection isn’t on this device" : `“${actions.missing}” isn’t on this device`}</h2>
          <p>This pane of the workspace recipe opened empty. Add the connection, or open another place from the sidebar.</p>
          <button className="btn btn-sm" onClick={actions.onAddConnection}>
            <Icon name="plus" size={13} /> Add connection
          </button>
        </div>
      </div>
    );
  return (
    <div className="welcome">
      <div className="welcome-card">
        <KyblMark size={76} className="welcome-mark" />
        <h1>Welcome to Kybl</h1>
        <p>Browse, upload, download and share files on any S3-compatible storage. Your secret keys are saved encrypted, with the key in the system keychain.</p>
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

export function ChooseBucket({
  profile,
  note,
  error,
  reconnect,
  actions,
}: {
  profile: Profile;
  note: string | null;
  /** the whole error behind `note`, when listing the roots failed */
  error?: string | null;
  reconnect: boolean;
  actions: EmptyActions;
}) {
  const caps = useCaps(profile.id);
  const mode = rootsMode(profile, caps);
  // making buckets is Kybl Storage's (or whatever says it can); naming one by hand is S3's
  const kybl = caps ? caps.createRoot : profile.provider === KYBL;
  const byName = !kybl && mode === "buckets";
  const what = mode === "drives" ? "place" : "bucket";
  // a server's own certificate, an FTP server without encryption, an SFTP key to trust: stopped
  // before its one root could be listed, and fixable here
  const fix = connTrouble(profile, error);
  // FTP, SFTP, WebDAV…: one root, nothing to choose; it's connecting, or it couldn't
  const single = mode === "single";
  const failed = !!(note || error);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo plain">
          {single && !failed ? <span className="spinner" /> : <Icon name={single ? "server" : "bucket"} size={30} />}
        </div>
        <h1>{single ? (failed ? `Couldn’t connect to ${profile.name}` : `Connecting to ${profile.name}…`) : `Choose a ${what}`}</h1>
        <p>{note || (single ? (failed ? "" : "Opening its files.") : `Pick a ${what} from the sidebar.`)}</p>
        {fix ? (
          <div className="cert-actions">
            <ConnFixButton
              trouble={fix}
              className={fix.kind === "plain" ? "btn" : "btn btn-primary"}
              onTrustCert={(fp) => actions.onTrustCert(profile, fp, true)}
              onAllowPlain={() => actions.onAllowPlainFtp(profile, true)}
              onTrustHostKey={(fp) => actions.onTrustHostKey(profile, fp, true)}
            />
          </div>
        ) : reconnect ? (
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

export function ListError({
  profile,
  error,
  onRetry,
  onReconnect,
  onTrustCert,
  onAllowPlainFtp,
  onTrustHostKey,
}: {
  profile: Profile;
  error: string;
  onRetry: () => void;
  onReconnect: (p: Profile) => void;
  onTrustCert: EmptyActions["onTrustCert"];
  onAllowPlainFtp: EmptyActions["onAllowPlainFtp"];
  onTrustHostKey: EmptyActions["onTrustHostKey"];
}) {
  const revoked = profile.provider === KYBL && isRevokedKey(error);
  // a Google Drive / OneDrive / Dropbox sign-in that ended: sign in again, then it loads
  const signIn = isCloudKind(profile.kind) && /sign in again|no longer signed in|invalid_grant|expired or revoked/i.test(error);
  // FTPS / WebDAV with the server's own certificate, an "encrypt if available" FTP server that
  // offered none, an SFTP key to trust: fix it, then list again
  const fix = connTrouble(profile, error);
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
      {fix ? (
        <div className="cert-actions">
          <ConnFixButton
            trouble={fix}
            className={fix.kind === "plain" ? "btn btn-sm" : "btn btn-primary btn-sm"}
            onTrustCert={async (fp) => {
              await onTrustCert(profile, fp, false);
              onRetry();
            }}
            onAllowPlain={async () => {
              await onAllowPlainFtp(profile, false);
              onRetry();
            }}
            onTrustHostKey={async (fp) => {
              await onTrustHostKey(profile, fp, false);
              onRetry();
            }}
          />
          <button className="btn btn-sm" onClick={onRetry}>
            <Icon name="retry" size={13} /> Try again
          </button>
        </div>
      ) : revoked || signIn ? (
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
