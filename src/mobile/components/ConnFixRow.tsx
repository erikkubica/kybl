/**
 * The phone's way out of a connection error that needs the user's word: trust a server's own
 * certificate, connect to an FTP server without encryption, or trust an SFTP server's key. The
 * same buttons and sheets as the desktop (src/connections/components/ConnFix.tsx).
 */
import type { Profile } from "../../core/types";
import { ConnFixButton, connTrouble } from "../../connections/components/ConnFix";

/** Each fix saves what the user agreed to; the profile to connect with afterwards. */
export type ConnFixes = {
  trustCert: (p: Profile, fp: string) => Promise<Profile>;
  trustHostKey: (p: Profile, fp: string) => Promise<Profile>;
  allowPlain: (p: Profile) => Promise<Profile>;
};

/** The fix for `error` (raw, with its detail lines), or nothing; `then` tries again. */
export function ConnFixRow({
  profile,
  error,
  fixes,
  then,
  className = "btn btn-primary",
  bare,
}: {
  profile: Profile;
  error: string | null | undefined;
  fixes: ConnFixes;
  then: (p: Profile) => void;
  className?: string;
  /** just the button, for a row that lays it out itself */
  bare?: boolean;
}) {
  const trouble = connTrouble(profile, error);
  if (!trouble) return null;
  const button = (
    <ConnFixButton
      trouble={trouble}
      className={className}
      onTrustCert={async (fp) => then(await fixes.trustCert(profile, fp))}
      onTrustHostKey={async (fp) => then(await fixes.trustHostKey(profile, fp))}
      onAllowPlain={async () => then(await fixes.allowPlain(profile))}
    />
  );
  return bare ? button : <div className="cert-actions">{button}</div>;
}

/** Whether `error` has a fix ConnFixRow offers. */
export const hasConnFix = (profile: Profile, error: string | null | undefined) => !!connTrouble(profile, error);
