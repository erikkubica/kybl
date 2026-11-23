/**
 * The kinds of connection people can add, as the "New connection" picker shows them, and the
 * helpers the forms share (field defaults, profile building, the host-key and certificate error
 * formats).
 */
import type { CloudKind } from "../api";
import type { BlobConfig, ConnKind, NetConfig, Profile } from "../types";

/** What the picker offers: Kybl Storage has its own sign-in flow, S3 its presets. */
export type PickId = "kybl" | "s3" | CloudKind | "webdav" | "sftp" | "ftp" | "azblob" | "gcs";

export type KindInfo = {
  id: PickId;
  /** the badge (providers.ts) */
  provider: string;
  label: string;
  /** one short line under the name in the picker */
  blurb: string;
  group: "drives" | "storage" | "servers";
};

export const KINDS: KindInfo[] = [
  { id: "kybl", provider: "kybl", label: "Kybl Storage", blurb: "Sign in, no keys to copy", group: "storage" },
  { id: "s3", provider: "aws", label: "S3-compatible", blurb: "Hetzner, AWS, R2, MinIO…", group: "storage" },
  { id: "azblob", provider: "azblob", label: "Azure Blob Storage", blurb: "One container, with a key or SAS", group: "storage" },
  { id: "gcs", provider: "gcs", label: "Google Cloud Storage", blurb: "One bucket, with a service key", group: "storage" },
  { id: "gdrive", provider: "gdrive", label: "Google Drive", blurb: "My Drive and shared drives", group: "drives" },
  { id: "onedrive", provider: "onedrive", label: "OneDrive", blurb: "Personal or work account", group: "drives" },
  { id: "dropbox", provider: "dropbox", label: "Dropbox", blurb: "Your whole Dropbox", group: "drives" },
  { id: "webdav", provider: "webdav", label: "WebDAV", blurb: "Nextcloud, ownCloud, Synology", group: "servers" },
  { id: "sftp", provider: "sftp", label: "SFTP", blurb: "Any server you can SSH into", group: "servers" },
  { id: "ftp", provider: "ftp", label: "FTP / FTPS", blurb: "Web hosts and older servers", group: "servers" },
];

export const GROUPS: { id: KindInfo["group"]; label: string }[] = [
  { id: "drives", label: "Cloud drives" },
  { id: "storage", label: "Object storage" },
  { id: "servers", label: "Servers" },
];

export const OAUTH_KINDS: CloudKind[] = ["gdrive", "onedrive", "dropbox"];
export const isCloudKind = (k: string | undefined): k is CloudKind => !!k && (OAUTH_KINDS as string[]).includes(k);

/** Who you sign in with, for the button ("Sign in with Google"). */
export const SIGN_IN_WITH: Record<CloudKind, string> = { gdrive: "Google", onedrive: "Microsoft", dropbox: "Dropbox" };

export const kindInfo = (id: PickId) => KINDS.find((k) => k.id === id)!;

/** The picker entry a saved profile belongs to (Kybl Storage is an S3 profile with its own flow). */
export function pickOf(p: Profile): PickId {
  if (p.provider === "kybl") return "kybl";
  const k = p.kind ?? "s3";
  return (KINDS.some((x) => x.id === k) ? k : "s3") as PickId;
}

export type NetKind = "webdav" | "sftp" | "ftp";
export type BlobKind = "azblob" | "gcs";

/** The port a kind uses when the field says 0. */
export function defaultPort(kind: NetKind, tls: NetConfig["tls"]): number {
  if (kind === "sftp") return 22;
  if (kind === "ftp") return tls === "implicit" ? 990 : 21;
  return tls === "none" ? 80 : 443;
}

export const emptyNet = (kind: NetKind): NetConfig => ({
  host: "",
  port: 0,
  user: "",
  basePath: "",
  // FTP starts on explicit TLS (the usual "FTPS"): plain FTP must be chosen on purpose
  tls: kind === "webdav" ? "implicit" : kind === "ftp" ? "explicit" : "none",
  auth: "password",
  hostKey: null,
  certFingerprint: null,
  url: kind === "webdav" ? "" : null,
});

export const emptyBlob = (): BlobConfig => ({ account: "", endpoint: "", container: "" });

/** A profile of a non-S3 kind: the S3 fields stay empty, `provider` is the kind (its badge). */
export function baseProfile(id: string, name: string, kind: ConnKind): Profile {
  return { id, name, kind, provider: kind, endpoint: "", region: "", accessKeyId: "", bucket: null, pathStyle: false };
}

/** What a net connection is called when the Name field is left empty: "alice@files.example.com". */
export function netTitle(kind: NetKind, n: NetConfig): string {
  if (kind === "webdav" && n.url?.trim()) {
    try {
      const u = new URL(n.url.trim().replace(/^davs?:|^webdav:/i, "https:"));
      return n.user ? `${n.user}@${u.host}` : u.host;
    } catch {
      return n.url.trim();
    }
  }
  const host = n.host.trim() || kind.toUpperCase();
  return n.user.trim() ? `${n.user.trim()}@${host}` : host;
}

/** A short address for lists and tooltips ("sftp://files.example.com:2222/var/www"). */
export function addressOf(p: Profile): string {
  const n = p.net;
  if (n) {
    if (p.kind === "webdav" && n.url) return n.url;
    const port = n.port ? `:${n.port}` : "";
    const scheme = p.kind === "ftp" ? (n.tls === "none" || n.tls === "auto" ? "ftp" : "ftps") : (p.kind ?? "");
    return `${scheme}://${n.host}${port}${n.basePath ? `/${n.basePath.replace(/^\//, "")}` : ""}`;
  }
  if (p.blob) return p.blob.container ? `${p.blob.account ? `${p.blob.account}/` : ""}${p.blob.container}` : p.blob.account;
  if (p.cloud) return p.cloud.accountEmail;
  return p.endpoint;
}

// ---------------------------------------------------------------- host keys (SFTP)
/** First connection to an SFTP server: its fingerprint, for "Trust this server?". */
export function hostKeyUnknown(msg: string): string | null {
  return msg.match(/host-key-unknown (SHA256:\S+)/)?.[1] ?? null;
}
/** The server's key changed since it was trusted: `{ now, saved }` fingerprints. */
export function hostKeyChanged(msg: string): { now: string; saved: string } | null {
  const m = msg.match(/host-key-changed (SHA256:\S+) expected (SHA256:\S+)/);
  return m ? { now: m[1], saved: m[2] } : null;
}

// ---------------------------------------------------------------- certificates (FTPS, WebDAV)
/** A server certificate that didn't check out, as the error's details describe it (see
 *  src-tauri/src/storage/BACKENDS.md). "changed": another certificate was trusted before. */
export type CertTrouble = {
  kind: "untrusted" | "changed";
  /** the certificate's SHA-256 fingerprint, "AB:CD:…" */
  fp: string;
  /** the one trusted before ("changed") */
  saved: string | null;
  /** self-signed, unknown-issuer, wrong-name, expired, not-yet-valid, other */
  reasons: string[];
  /** the name Kybl connected to */
  host: string | null;
  /** who it's made out to, who signed it, "YYYY-MM-DD" dates */
  name: string | null;
  issuer: string | null;
  validFrom: string | null;
  validUntil: string | null;
};

export function certTrouble(msg: string): CertTrouble | null {
  const m = msg.match(/^cert-(untrusted|changed) ([0-9A-Fa-f:]+)(?: expected (\S+))?\s*$/m);
  if (!m) return null;
  const field = (k: string) => msg.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1].trim() || null;
  return {
    kind: m[1] as CertTrouble["kind"],
    fp: m[2],
    saved: m[3] ?? null,
    reasons: (field("reason") ?? "other").split(/,\s*/).filter(Boolean),
    host: field("host"),
    name: field("name"),
    issuer: field("issuer"),
    validFrom: field("valid-from"),
    validUntil: field("valid-until"),
  };
}
