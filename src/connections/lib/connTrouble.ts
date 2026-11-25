/** Pure: what a connection error lets the user fix on the spot (ConnFix.tsx draws the button). */
import type { Profile } from "../../core/types";
import { certTrouble, hostKeyChanged, hostKeyUnknown, plainFtpUnconfirmed, type CertTrouble } from "./kinds.ts";

export type HostKeyAsk = { kind: "unknown"; host: string; fp: string } | { kind: "changed"; host: string; now: string; saved: string };

/** The server a trust question is about, as the connection names it (never as an error says). */
export function trustHost(p: Profile): string {
  const n = p.net;
  if (n?.host?.trim()) return n.host.trim();
  if (n?.url) {
    try {
      return new URL(n.url.trim().replace(/^(web)?davs?:/i, "https:")).hostname || p.name;
    } catch {
      /* the name below */
    }
  }
  return p.name;
}

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
 * encryption, an SFTP server's key that is new or changed. Only questions Kybl itself raised
 * count (see `trustLines` in kinds.ts), and the host is always the connection's.
 */
export function connTrouble(p: Profile, error: string | null | undefined): ConnTrouble | null {
  if (!p.net || !error) return null;
  const host = trustHost(p);
  const cert = certTrouble(error);
  if (cert) return { kind: "cert", cert, host };
  if (plainFtpUnconfirmed(error)) return { kind: "plain" };
  const ask = hostKeyAsk(error, host);
  return ask ? { kind: "hostkey", ask } : null;
}
