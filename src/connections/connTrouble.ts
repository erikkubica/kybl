/** Pure: what a connection error lets the user fix on the spot (ConnFix.tsx draws the button). */
import type { Profile } from "../types";
import { certTrouble, hostKeyChanged, hostKeyUnknown, plainFtpUnconfirmed, type CertTrouble } from "./kinds.ts";

export type HostKeyAsk = { kind: "unknown"; host: string; fp: string } | { kind: "changed"; host: string; now: string; saved: string };

/** The host-key question an SFTP error asks (unknown or changed key), or null. */
export function hostKeyAsk(error: string, host: string): HostKeyAsk | null {
  const fp = hostKeyUnknown(error);
  if (fp) return { kind: "unknown", host, fp };
  const changed = hostKeyChanged(error);
  return changed ? { kind: "changed", host, ...changed } : null;
}

export type ConnTrouble = { kind: "cert"; cert: CertTrouble; host: string } | { kind: "plain" } | { kind: "hostkey"; ask: HostKeyAsk };

/**
 * The fixable trouble in a connection's raw error (with its detail lines; errSummary drops
 * them), or null: a server's own certificate (FTPS, WebDAV), an FTP server that offered no
 * encryption, an SFTP server's key that is new or changed.
 */
export function connTrouble(p: Profile, error: string | null | undefined): ConnTrouble | null {
  if (!p.net || !error) return null;
  const host = (h: string | null) => h || p.net?.host || p.name;
  const cert = certTrouble(error);
  if (cert) return { kind: "cert", cert, host: host(cert.host) };
  if (plainFtpUnconfirmed(error)) return { kind: "plain" };
  const ask = hostKeyAsk(error, host(null));
  return ask ? { kind: "hostkey", ask } : null;
}
