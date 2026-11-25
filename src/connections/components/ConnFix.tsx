/**
 * What a connection error lets the user fix on the spot: trust a server's own certificate (FTPS,
 * WebDAV), connect to an FTP server without encryption, or trust an SFTP server's key (new or
 * changed). The desktop's empty pane and the phone's error screens both use it.
 */
import { api } from "../../core/api";
import type { Profile } from "../../core/types";
import type { ConnTrouble } from "../lib/connTrouble";
import { AllowPlainFtpButton, TrustCertButton } from "./CertTrustSheet";
import { TrustHostKeyButton } from "./HostKeySheet";

export { connTrouble, type ConnTrouble } from "../lib/connTrouble";

/** Saves a trusted certificate or SFTP host key on the connection; the saved profile. */
export function trustOnProfile(p: Profile, what: { certFingerprint: string } | { hostKey: string }): Promise<Profile> {
  if (!p.net) return Promise.resolve(p);
  return api.saveProfile({ ...p, net: { ...p.net, ...what } });
}

const trustListeners = new Set<(p: Profile) => void>();
/**
 * Hears a connection saved by a trust fix made away from the app's own screens (the destination
 * picker), so the app's copy of it picks up what was trusted. Returns the undo.
 */
export function onTrustSaved(fn: (p: Profile) => void): () => void {
  trustListeners.add(fn);
  return () => void trustListeners.delete(fn);
}
/** Tells the app a trust fix saved `p` (see onTrustSaved). */
export function trustSaved(p: Profile) {
  for (const fn of trustListeners) fn(p);
}

/** The one button for `trouble`; each handler does the fix and then tries again. */
export function ConnFixButton({
  trouble,
  onTrustCert,
  onAllowPlain,
  onTrustHostKey,
  className,
}: {
  trouble: ConnTrouble;
  onTrustCert: (fp: string) => Promise<void>;
  onAllowPlain: () => Promise<void>;
  onTrustHostKey: (fp: string) => Promise<void>;
  className?: string;
}) {
  if (trouble.kind === "cert") return <TrustCertButton cert={trouble.cert} host={trouble.host} className={className} onTrust={onTrustCert} />;
  if (trouble.kind === "plain") return <AllowPlainFtpButton className={className} onAllow={onAllowPlain} />;
  return <TrustHostKeyButton ask={trouble.ask} className={className} onTrust={onTrustHostKey} />;
}
