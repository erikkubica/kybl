/**
 * What a connection error lets the user fix on the spot: trust a server's own certificate (FTPS,
 * WebDAV), connect to an FTP server without encryption, or trust an SFTP server's key (new or
 * changed). The desktop's empty pane and the phone's error screens both use it.
 */
import { api } from "../api";
import type { Profile } from "../types";
import type { ConnTrouble } from "./connTrouble";
import { AllowPlainFtpButton, TrustCertButton } from "./CertTrustSheet";
import { TrustHostKeyButton } from "./HostKeySheet";

export { connTrouble, type ConnTrouble } from "./connTrouble";

/** Saves a trusted certificate or SFTP host key on the connection; the saved profile. */
export function trustOnProfile(p: Profile, what: { certFingerprint: string } | { hostKey: string }): Promise<Profile> {
  if (!p.net) return Promise.resolve(p);
  return api.saveProfile({ ...p, net: { ...p.net, ...what } });
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
