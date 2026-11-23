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

/** One file's content search result. */
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
  /** Files found stream in as `content-search-progress`; `cancelTransfer(opId)` stops it. */
  contentSearch: (profileId: string, bucket: string, prefix: string, query: string, opts: ContentOpts, opId: string) =>
    invoke<ContentResult>("content_search", { profileId, bucket, prefix, query, ...opts, opId }),
};
