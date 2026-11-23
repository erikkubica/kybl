/**
 * The small pieces git awareness and content search add to a pane: the branch chip after the
 * path, an item's status mark, the Names / Contents switch in the search field, and a content
 * hit's matching line.
 */
import type { MouseEvent, ReactNode } from "react";
import type { GitMark } from "../browser/useGitStatus";
import type { GitInfo, ContentHit } from "../browser/devtoolsApi";
import type { SearchMode } from "../browser/useSearch";
import "./devmarks.css";

/** "⎇ main" after the path: the branch checked out (or the commit, when detached). */
export function BranchChip({ info }: { info: GitInfo }) {
  const name = info.branch ?? (info.commit ? info.commit : "detached");
  const sync = [info.ahead ? `${info.ahead} ${info.ahead === 1 ? "commit" : "commits"} to push` : "", info.behind ? `${info.behind} to pull` : ""].filter(Boolean).join(", ");
  const dirty = info.changes.some((c) => c.kind !== "ignored");
  const title = [
    info.branch ? `Git branch ${info.branch}` : `Detached at ${info.commit ?? "an unknown commit"}`,
    sync,
    info.partial ? "The repository is too big to check every file in time: some marks may be missing" : dirty ? "Has uncommitted changes" : "No uncommitted changes",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`git-branch ${info.branch ? "" : "detached"}`} title={title} aria-label={title} data-tauri-drag-region>
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm9-6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM3.5 5v6M12.5 8c0 2.2-2.2 3-5 3.3-2 .2-4 .7-4 1.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="git-branch-name">{name}</span>
      {(info.ahead > 0 || info.behind > 0) && (
        <span className="git-branch-sync">
          {info.ahead > 0 && `↑${info.ahead}`}
          {info.behind > 0 && `↓${info.behind}`}
        </span>
      )}
    </span>
  );
}

/** An item's git status: a letter (M, A, U, D, R, C) or, on a folder with changes inside, a dot. */
export function GitBadge({ mark }: { mark: GitMark }) {
  if (mark.kind === "ignored") return null;
  return (
    <span className={`git-mark git-${mark.kind}`} title={mark.title} aria-label={mark.title}>
      {mark.letter || <i />}
    </span>
  );
}

/** characters kept before the first match */
const LEAD = 8;

/** A content hit: line number, the line with the matches marked, and how many lines match. */
export function HitLine({ hit, onOpen }: { hit: ContentHit; onOpen?: (ev: MouseEvent) => void }) {
  const parts: ReactNode[] = [];
  // the column is narrow: start a little before the match, so it is in view
  const lead = hit.ranges[0] && hit.ranges[0][0] > LEAD + 2 ? hit.ranges[0][0] - LEAD : 0;
  if (lead) parts.push("…");
  let at = lead;
  hit.ranges.forEach(([s, e], i) => {
    if (s < at) return;
    if (s > at) parts.push(hit.text.slice(at, s));
    parts.push(<mark key={i}>{hit.text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < hit.text.length) parts.push(hit.text.slice(at));
  const more = hit.count - 1;
  return (
    <span
      className="hit-line"
      title={`Line ${hit.line}: ${hit.text}\n${more > 0 ? `${hit.count} matching lines · ` : ""}Click to preview it there`}
      onClick={onOpen}
      // a double click previews too, rather than also opening the file in its app
      onDoubleClick={(ev) => onOpen && ev.stopPropagation()}
    >
      <span className="hit-no">{hit.line}</span>
      <span className="hit-text">{parts}</span>
      {more > 0 && <span className="hit-count">+{more}</span>}
    </span>
  );
}

/**
 * Inside the search field while it's open: what Enter searches (names, or what is inside files)
 * and, for contents, match case and regular expressions. Pressing keeps the field's focus.
 */
export function SearchModes({
  mode,
  caseSensitive,
  regex,
  contentsOff,
  onChange,
}: {
  mode: SearchMode;
  caseSensitive: boolean;
  regex: boolean;
  /** why this connection can't search inside files (the switch is off); null when it can */
  contentsOff: string | null;
  onChange: (patch: Partial<{ mode: SearchMode; caseSensitive: boolean; regex: boolean }>) => void;
}) {
  const keep = (e: MouseEvent) => e.preventDefault();
  return (
    <span className="search-modes" onMouseDown={keep}>
      {mode === "contents" && (
        <>
          <button
            type="button"
            className={`search-opt ${caseSensitive ? "on" : ""}`}
            aria-pressed={caseSensitive}
            title={caseSensitive ? "Match case: on" : "Match case: off (A finds a)"}
            onClick={() => onChange({ caseSensitive: !caseSensitive })}
          >
            Aa
          </button>
          <button
            type="button"
            className={`search-opt mono ${regex ? "on" : ""}`}
            aria-pressed={regex}
            title={regex ? "Regular expression: on" : "Regular expression: off (the text as typed)"}
            onClick={() => onChange({ regex: !regex })}
          >
            .*
          </button>
        </>
      )}
      <span className="search-seg" role="radiogroup" aria-label="Search in">
        <button type="button" role="radio" aria-checked={mode === "names"} className={mode === "names" ? "on" : ""} title="Filter and search by name" onClick={() => onChange({ mode: "names" })}>
          Names
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "contents"}
          // not `disabled`: its tooltip says why
          className={`${mode === "contents" ? "on" : ""} ${contentsOff ? "off" : ""}`}
          aria-disabled={!!contentsOff}
          title={contentsOff ?? "Search inside files (↵)"}
          onClick={() => !contentsOff && onChange({ mode: "contents" })}
        >
          Contents
        </button>
      </span>
    </span>
  );
}
