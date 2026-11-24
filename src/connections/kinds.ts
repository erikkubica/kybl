/**
 * The kinds of connection people can add, as the "New connection" picker shows them, and the
 * helpers the forms share (field defaults, profile building, the host-key and certificate error
 * formats).
 */
import type { CloudKind } from "../api";
import { splitDavUrl } from "./serverHost.ts";
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
  { id: "s3", provider: "aws", label: "S3 Compatible", blurb: "Any S3 storage, with access keys", group: "storage" },
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

/**
 * Editing: whether an empty secret field may keep the saved secret. Only while the identity it
 * belongs to (S3 access key ID, Azure account) is unchanged; a new one needs its own secret.
 */
export const keepsSavedSecret = (saved: string | null | undefined, now: string) => saved != null && saved.trim() === now.trim();

/** "files.example.com" from what people type in Server ("ftp://user@files.example.com:21/x" too). */
function bareHost(host: string): string {
  let h = host.trim();
  const i = h.indexOf("://");
  if (i >= 0) h = h.slice(i + 3);
  h = h.split("/")[0];
  const at = h.lastIndexOf("@");
  if (at >= 0) h = h.slice(at + 1);
  if (h.startsWith("[")) h = h.slice(1).split("]")[0];
  else if ((h.match(/:/g) ?? []).length === 1) h = h.split(":")[0];
  return h.toLowerCase();
}

/** A port typed into the Server field ("example.com:2222"), as the app's `port_in_host` reads it. */
function portInHost(host: string): number | null {
  let h = host.trim();
  const i = h.indexOf("://");
  if (i >= 0) h = h.slice(i + 3);
  h = h.split("/")[0];
  let tail: string | undefined;
  if (h.startsWith("[")) tail = h.split("]:")[1];
  else if ((h.match(/:/g) ?? []).length === 1) tail = h.split(":")[1];
  return tail && /^\d{1,5}$/.test(tail) && Number(tail) < 65536 ? Number(tail) : null;
}

/** `scheme://host:port` with the default port spelled out, as the app's `url_origin` writes it. */
function originOf(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

/**
 * A WebDAV connection's server as the connection reaches it: scheme, host and port. `dav://` and
 * `webdav://` are plain http there, `davs://` and `webdavs://` are https, an address without a
 * scheme is https (the app's `dav_origin`).
 */
function davOrigin(n: NetConfig): string {
  const typed = n.url?.trim();
  const port = n.port || portInHost(n.host);
  const raw = typed ? (typed.includes("://") ? typed : `https://${typed}`) : `${n.tls === "none" ? "http" : "https"}://${bareHost(n.host)}${port ? `:${port}` : ""}/`;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  const secure = !!m && ["https", "davs", "webdavs"].includes(m[1].toLowerCase());
  return originOf(m ? `${secure ? "https" : "http"}://${m[2]}` : raw) ?? raw.toLowerCase();
}

/**
 * Where a server connection's saved password is sent: server, how it connects (TLS or plain)
 * and user name (null: nothing sent, as for SFTP keys, which only sign). Same rule as the app's
 * `password_target`: a saved password never follows a change of server, user name or transport.
 */
export function passwordTarget(kind: NetKind, n: NetConfig): string | null {
  const port = (d: number) => n.port || portInHost(n.host) || d;
  let place: string;
  if (kind === "ftp") {
    // "auto" falls back to plain FTP, so it counts as plain
    const secure = n.tls === "explicit" || n.tls === "implicit";
    place = `${secure ? "tls" : "plain"}:${bareHost(n.host)}:${port(n.tls === "implicit" ? 990 : 21)}`;
  } else if (kind === "sftp" && n.auth === "password") place = `${bareHost(n.host)}:${port(22)}`;
  else if (kind === "webdav") place = davOrigin(n);
  else return null;
  return `${place}|${n.user.trim()}`;
}

/**
 * Where an Azure or Google Cloud Storage connection's saved key goes: its endpoint (the
 * service's own address when empty) and, for Azure, the account. A SAS token or service
 * account key is the credential itself, so it never follows a new endpoint or account.
 */
export function blobTarget(kind: BlobKind, b: BlobConfig): string {
  const ep = b.endpoint.trim();
  const account = b.account.trim();
  const fallback = kind === "azblob" ? `https://${account}.blob.core.windows.net` : "https://storage.googleapis.com";
  const place = originOf(ep || fallback) ?? (ep || fallback).replace(/\/+$/, "").toLowerCase();
  return kind === "azblob" ? `${place}|${account.toLowerCase()}` : place;
}

export const emptyBlob =(): BlobConfig => ({ account: "", endpoint: "", container: "" });

/** A profile of a non-S3 kind: the S3 fields stay empty, `provider` is the kind (its badge). */
export function baseProfile(id: string, name: string, kind: ConnKind): Profile {
  return { id, name, kind, provider: kind, endpoint: "", region: "", accessKeyId: "", bucket: null, pathStyle: false };
}

/** What a net connection is called when the Name field is left empty: "alice@files.example.com". */
export function netTitle(kind: NetKind, n: NetConfig): string {
  if (kind === "webdav" && n.url?.trim()) {
    try {
      const u = new URL(n.url.trim().replace(/^(web)?davs?:/i, "https:"));
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
    // never with a user name or password that an older save left in the address
    if (p.kind === "webdav" && n.url) return splitDavUrl(n.url).href;
    const port = n.port ? `:${n.port}` : "";
    const scheme = p.kind === "ftp" ? (n.tls === "none" || n.tls === "auto" ? "ftp" : "ftps") : (p.kind ?? "");
    return `${scheme}://${n.host}${port}${n.basePath ? `/${n.basePath.replace(/^\//, "")}` : ""}`;
  }
  if (p.blob) return p.blob.container ? `${p.blob.account ? `${p.blob.account}/` : ""}${p.blob.container}` : p.blob.account;
  if (p.cloud) return p.cloud.accountEmail;
  return p.endpoint;
}

// ---------------------------------------------------------------- trust questions
/*
 * A trust error (a new or changed SSH host key, a server's own certificate, plain FTP) reads
 * "sentence\n\n<tag> <mark line>\n<key: value lines>…", where <tag> is a per-run secret only
 * the backend knows (`trust_tag`, see src-tauri/src/storage/mod.rs). Servers can put text into
 * errors (a reply, a status message, a file name), so only a detail that starts with the tag is
 * read, and only its first line and the `key: value` lines right after it.
 */
let tag: string | null = null;
/** The backend's per-run trust tag (read once at start-up); until it's set nothing is trusted. */
export function setTrustTag(t: string | null) {
  tag = t && /^kybl:[0-9a-f]{32}$/.test(t) ? t : null;
}

/** Kybl's own trust lines in an error: the mark line, then its `key: value` fields. */
function trustLines(msg: string): { mark: string; fields: Map<string, string> } | null {
  if (!tag) return null;
  const i = msg.indexOf("\n\n");
  if (i < 0 || !msg.startsWith(`${tag} `, i + 2)) return null;
  const [mark, ...rest] = msg.slice(i + 2 + tag.length + 1).split("\n");
  const fields = new Map<string, string>();
  for (const l of rest) {
    // the certificate's fields, in the order certtrust.rs writes them; its `tls:` line (with
    // the TLS library's own text) and anything after it don't count
    const m = l.match(/^(reason|host|name|issuer|valid-from|valid-until): (.*)$/);
    if (!m || fields.has(m[1])) break;
    fields.set(m[1], m[2].trim());
  }
  return { mark: mark.trim(), fields };
}

// ---------------------------------------------------------------- host keys (SFTP)
/** First connection to an SFTP server: its fingerprint, for "Trust this server?". */
export function hostKeyUnknown(msg: string): string | null {
  return trustLines(msg)?.mark.match(/^host-key-unknown (SHA256:\S+)$/)?.[1] ?? null;
}
/** The server's key changed since it was trusted: `{ now, saved }` fingerprints. */
export function hostKeyChanged(msg: string): { now: string; saved: string } | null {
  const m = trustLines(msg)?.mark.match(/^host-key-changed (SHA256:\S+) expected (SHA256:\S+)$/);
  return m ? { now: m[1], saved: m[2] } : null;
}

// ---------------------------------------------------------------- certificates (FTPS, WebDAV)
/** A server certificate that didn't check out, as the error's details describe it (see
 *  src-tauri/src/storage/BACKENDS.md). "changed": another certificate was trusted before. The
 *  host it was for comes from the connection, never from the error. */
export type CertTrouble = {
  kind: "untrusted" | "changed";
  /** the certificate's SHA-256 fingerprint, "AB:CD:…" */
  fp: string;
  /** the one trusted before ("changed") */
  saved: string | null;
  /** self-signed, unknown-issuer, wrong-name, expired, not-yet-valid, other */
  reasons: string[];
  /** who it's made out to, who signed it, "YYYY-MM-DD" dates */
  name: string | null;
  issuer: string | null;
  validFrom: string | null;
  validUntil: string | null;
};

/** FTP "encrypt if available": the server offered no encryption and the user hasn't agreed to
 *  plain FTP for it yet (nothing was sent in clear); see src-tauri/src/storage/BACKENDS.md. */
export function plainFtpUnconfirmed(msg: string): boolean {
  return trustLines(msg)?.mark === "ftp-plain-unconfirmed";
}

export function certTrouble(msg: string): CertTrouble | null {
  const t = trustLines(msg);
  const m = t?.mark.match(/^cert-(untrusted|changed) ([0-9A-Fa-f:]+)(?: expected (\S+))?$/);
  if (!t || !m) return null;
  const field = (k: string) => t.fields.get(k) || null;
  return {
    kind: m[1] as CertTrouble["kind"],
    fp: m[2],
    saved: m[3] ?? null,
    reasons: (field("reason") ?? "other").split(/,\s*/).filter(Boolean),
    name: field("name"),
    issuer: field("issuer"),
    validFrom: field("valid-from"),
    validUntil: field("valid-until"),
  };
}
