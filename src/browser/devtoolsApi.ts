/**
 * The backend's developer touches (src-tauri/src/devtools): git status of this computer's
 * folders, and searching inside files on this computer and SFTP servers.
 */
import { invoke } from "@tauri-apps/api/core";

export type GitKind = "modified" | "added" | "deleted" | "renamed" | "conflicted" | "untracked" | "ignored";

export type GitChange = {
  /** below the folder asked about, relative to it; folders end with "/" */
  path: string;
  kind: GitKind;
  staged: boolean;
  unstaged: boolean;
};

export type GitInfo = {
  /** null when detached (`commit` says where) */
  branch: string | null;
  commit: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  /** the folder sits inside an ignored or untracked folder: everything in it is that */
  inside: GitKind | null;
  /** statuses missing or partial: the repository is too big to check in time */
  partial: boolean;
};

/** One commit, as the info panel lists it. */
export type GitCommit = {
  /** abbreviated hash */
  hash: string;
  /** Unix seconds */
  time: number;
  author: string;
  subject: string;
};

/** What the info panel shows about a repository beyond its status. */
export type GitOverview = {
  /** the tracking branch ("origin/main"); null without one */
  upstream: string | null;
  /** when the repository last fetched (Unix seconds); null if never */
  fetchedAt: number | null;
  /** the remote's address without credentials ("github.com/owner/repo") */
  remote: string | null;
  /** newest first, up to 10 */
  commits: GitCommit[];
  tag: string | null;
  stashes: number;
  /** the last commit that touched the selected file, when one was asked about */
  file: GitCommit | null;
};

export type ContentHit = {
  key: string;
  size: number;
  modified: number | null;
  /** first matching line, 1-based */
  line: number;
  /** that line, trimmed around the match */
  text: string;
  /** the matches in `text` (UTF-16 offsets, start..end) */
  ranges: [number, number][];
  /** matching lines in the file */
  count: number;
};

export type ContentResult = {
  hits: ContentHit[];
  files: number;
  matches: number;
  truncated: boolean;
  /** "ripgrep", "grep" or "built-in" */
  engine: string;
  /** why this place can't be searched by content */
  unavailable: string | null;
};

export type ContentProgress = { opId: string; hits: ContentHit[]; files: number; matches: number };

export type ContentOpts = { caseSensitive: boolean; regex: boolean; hidden: boolean };

export const devtoolsApi = {
  /** null: not a git work tree, no git, or not this computer */
  gitStatus: (profileId: string, bucket: string, prefix: string, force = false) =>
    invoke<GitInfo | null>("git_status", { profileId, bucket, prefix, force }),
  /** Tracking branch, remote, recent commits, tag, stashes and (for `file`, a file of the folder) its last commit; null when not a repository. */
  gitOverview: (profileId: string, bucket: string, prefix: string, file?: string) => invoke<GitOverview | null>("git_overview", { profileId, bucket, prefix, file: file ?? null }),
  /** A cloud drive's used and total space (total null: unlimited or not said); null when it doesn't say. */
  storageQuota: (profileId: string) => invoke<{ used: number; total: number | null } | null>("storage_quota", { profileId }),
  /** Files found stream in as `content-search-progress`; `cancelTransfer(opId)` stops it. */
  contentSearch: (profileId: string, bucket: string, prefix: string, query: string, opts: ContentOpts, opId: string) =>
    invoke<ContentResult>("content_search", { profileId, bucket, prefix, query, ...opts, opId }),
};
