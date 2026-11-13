export type Profile = {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  bucket?: string | null;
  pathStyle: boolean;
};

export type ObjInfo = {
  key: string;
  size: number;
  modified: number | null;
  etag: string | null;
  storageClass: string | null;
};

export type ListResult = {
  folders: string[];
  objects: ObjInfo[];
  nextToken: string | null;
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
  etag?: string | null;
  storageClass?: string | null;
};

export type TransferState = "queued" | "running" | "done" | "error" | "cancelled";

export type Transfer = {
  id: string;
  kind: "upload" | "download";
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
};

export type TransferEvent = {
  id: string;
  state: TransferState;
  bytes: number;
  total: number;
  error: string | null;
};
