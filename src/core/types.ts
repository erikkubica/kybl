export type Profile = {
  id: string;
  name: string;
  /** What kind of storage this is; profiles from before other kinds existed come back as "s3". */
  kind?: ConnKind;
  /** The visual id (logo, presets): "aws", "hetzner", "kybl", later "sftp", "gdrive"... */
  provider: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  bucket?: string | null;
  pathStyle: boolean;
  /** FTP, SFTP, WebDAV */
  net?: NetConfig | null;
  /** The sign-in kinds (Google Drive, OneDrive, Dropbox, Box) */
  cloud?: CloudConfig | null;
  /** Azure Blob Storage, Google Cloud Storage */
  blob?: BlobConfig | null;
  /** The sidebar group it is filed under, slash-separated ("Clients/Acme"); none = the top level. */
  group?: string | null;
  /** Pinned connections are listed first wherever connections are listed. */
  pinned?: boolean;
};

// WP0: connection kinds beyond S3 (capabilities and roots are in api.ts)
/** "local" is this computer or phone (the reserved connection id `LOCAL_ID`); "unknown" is a kind saved by a newer Kybl. */
export type ConnKind =
  | "s3"
  | "local"
  | "ftp"
  | "sftp"
  | "webdav"
  | "gdrive"
  | "onedrive"
  | "dropbox"
  | "azblob"
  | "gcs"
  | "box"
  | "unknown";

/** Where and how a server connection signs in. The password is the connection's secret. */
export type NetConfig = {
  host: string;
  /** 0: the kind's usual port */
  port: number;
  user: string;
  /** The folder the connection starts in ("" for the server's own start). */
  basePath: string;
  /** "explicit": STARTTLS / AUTH TLS; "implicit": TLS from the first byte (FTPS on 990, HTTPS);
   *  "auto" (FTP only): AUTH TLS when the server offers it, plain FTP when it refuses. */
  tls: "none" | "explicit" | "implicit" | "auto";
  /** "key": a private key kept in the vault as `{id}#ssh`. */
  auth: "password" | "key" | "agent";
  /** SFTP: the server key's SHA-256 fingerprint, trusted on first use. */
  hostKey?: string | null;
  /** FTPS and WebDAV over https: the SHA-256 fingerprint ("AB:CD:…") of the server's own
   *  certificate, trusted although it doesn't check out. */
  certFingerprint?: string | null;
  /** WebDAV: the full address, when given instead of host and port. */
  url?: string | null;
  /** SFTP: SSH tunnels (local port forwards) through the server (src/tunnels). */
  tunnels?: TunnelDef[];
};

/** One SSH tunnel of an SFTP connection: 127.0.0.1:localPort → remoteHost:remotePort, as the server sees it. */
export type TunnelDef = {
  /** stable within the connection; "" for a new one (the backend gives it one) */
  id: string;
  /** optional: the place it goes stands in */
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  /** started when Kybl first opens the connection */
  autoStart: boolean;
};

/** The account behind a sign-in connection. Tokens live in the vault (`{id}#oauth`), never here. */
export type CloudConfig = {
  accountEmail: string;
  accountId: string;
  /** "Use your own OAuth app": its client id. */
  clientId?: string | null;
  /** Microsoft: the tenant ("common" when empty). */
  tenant?: string | null;
  scopes: string[];
};

/** Azure Blob Storage / Google Cloud Storage; the account key or service account JSON is the secret. */
export type BlobConfig = {
  /** Azure: the storage account name; GCS: the project id. */
  account: string;
  /** A custom endpoint (Azurite, a sovereign cloud); "" for the usual one. */
  endpoint: string;
  /** A single container / bucket to open, for keys limited to one. */
  container?: string | null;
};

export type ObjInfo = {
  key: string;
  size: number;
  modified: number | null;
  etag: string | null;
  storageClass: string | null;
  // WP0: only present when a provider fills them (never for S3)
  /** Providers that address files by id (Drive, Box); key rows by it when present. */
  id?: string;
  mime?: string;
  hashes?: { md5?: string; sha1?: string; sha256?: string; quickxor?: string; dropbox?: string };
  /** when it was made: only where the store keeps it (this computer's disk, Google Drive) */
  created?: number;
  /** Google Docs / Sheets / Slides: no bytes of their own, only exports. */
  native?: { exports: { mime: string; ext: string; label: string }[]; webUrl?: string };
} & ServerMeta;

/** What servers keeping Unix permissions (SFTP, most FTP) say about a file or folder. */
export type ServerMeta = {
  /** the permission bits, e.g. 0o644 (setuid, setgid and sticky included where the server says) */
  mode?: number;
  /** the owner and group as the server names them (a name, or a number) */
  owner?: string;
  group?: string;
  /** a symbolic link: what it points at, as stored (the rest describes what it points at) */
  link?: string;
};

export type ListResult = {
  folders: string[];
  objects: ObjInfo[];
  nextToken: string | null;
  /** what the server says about some of `folders` (permissions, link targets), keyed by `key` */
  folderInfo?: ObjInfo[];
};

export type SearchResult = {
  objects: ObjInfo[];
  scanned: number;
  truncated: boolean;
};

export type ObjectDetails = {
  key: string;
  size: number;
  contentType: string | null;
  modified: number | null;
  etag: string | null;
  storageClass: string | null;
  metadata: Record<string, string>;
  cacheControl?: string | null;
  contentDisposition?: string | null;
  contentEncoding?: string | null;
};

export type LocalFile = { path: string; rel: string; size: number };
export type RemoteFile = { key: string; size: number };

/** One row in the file table (a folder or an object). */
export type Entry = {
  kind: "folder" | "file";
  /** full key; folders end with "/" */
  key: string;
  name: string;
  size: number;
  modified: number | null;
  /** when it was made, where the store keeps it (this computer's disk, Google Drive) */
  created?: number | null;
  etag?: string | null;
  storageClass?: string | null;
  /** Google Docs / Sheets / Slides: downloads are exports (connections/native.ts) */
  native?: ObjInfo["native"];
  /** the provider's own type, when it gives one ("application/vnd.google-apps.document") */
  mime?: string;
  /** the provider's file id, for providers that address files by id (Drive: "Open in Google Drive") */
  id?: string;
} & ServerMeta;

/** "paused": stopped by the user (or the app quit), keeping what it did to carry on from. */
export type TransferState = "queued" | "running" | "paused" | "done" | "error" | "cancelled";

export type Transfer = {
  id: string;
  /** compress / extract: archive work run by the backend as one row (src/archive) */
  kind: "upload" | "download" | "compress" | "extract";
  name: string;
  state: TransferState;
  bytes: number;
  total: number;
  error?: string | null;
  /** bytes per second, smoothed */
  speed: number;
  profileId: string;
  bucket: string;
  key: string;
  local: string;
  /** done and checked after copying: what was compared ("size", "md5", "etag", "sha256", "quickxor", "dropbox") */
  verified?: string;
  /** done, but Cancel stopped the check after copying: the file is there, unverified */
  checkStopped?: boolean;
  /** paused with a download's whole file in place, only its check left (Resume checks it) */
  checkPending?: boolean;
  /** what a running task is doing now (TransferEvent.phase) */
  phase?: string;
};

export type TransferEvent = {
  id: string;
  state: TransferState;
  bytes: number;
  total: number;
  error: string | null;
  /** it carried on from this byte instead of starting over */
  resumedFrom?: number;
  /** it had got somewhere before but had to start over */
  restarted?: boolean;
  verified?: string;
  /** a download as it ends: the path it really is at ("x (1).jpg" when given a free name) */
  local?: string;
  /** done, but Cancel stopped its check */
  checkStopped?: boolean;
  /** paused with the whole file in place, only its check left */
  checkPending?: boolean;
  /** what a running task is doing now ("Finding files… 312 found"), compress and extract */
  phase?: string;
  /** it moved to `local` because a file turned up at its own name while it ran */
  moved?: boolean;
};
