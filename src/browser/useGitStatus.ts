/**
 * Git awareness for a pane on this computer: the branch of the work tree the folder is in, and a
 * status mark per item (modified, added, untracked, deleted, conflicted, ignored; a dot on
 * folders with changes inside). Asked of the user's own git (src-tauri/src/devtools/git.rs),
 * a moment after the folder opens or its listing reloads, and again when the window comes back to
 * the front. No git, or not a work tree: nothing shows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "../types";
import type { Loc } from "./useListing";
import { devtoolsApi, type GitChange, type GitInfo, type GitKind } from "./devtoolsApi";

/** what an item's mark says: a status of its own, or (folders) "changes inside" */
export type GitMark = { kind: GitKind | "inside"; title: string; letter: string };

const LETTER: Record<GitKind, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", conflicted: "C", untracked: "U", ignored: "" };

function describe(c: Pick<GitChange, "kind" | "staged" | "unstaged">, folder: boolean): string {
  switch (c.kind) {
    case "modified":
      return c.staged && c.unstaged ? "Modified · some changes staged" : c.staged ? "Modified · staged for commit" : "Modified · not staged";
    case "added":
      return c.unstaged ? "Added · changed again since staging" : "Added · staged for commit";
    case "deleted":
      return "Deleted · staged for removal";
    case "renamed":
      return "Renamed · staged for commit";
    case "conflicted":
      return "Conflict · the merge needs resolving";
    case "untracked":
      return folder ? "Untracked folder · not in git yet" : "Untracked · not in git yet";
    case "ignored":
      return folder ? "Ignored folder · matched by .gitignore" : "Ignored · matched by .gitignore";
  }
}

/** Looks a while after the last change, so a burst of reloads asks git once. */
const DEBOUNCE = 250;

export function useGitStatus(here: Loc | null, enabled: boolean, listingStamp: unknown) {
  const [state, setState] = useState<{ key: string; info: GitInfo } | null>(null);
  const key = here && enabled ? `${here.profileId}\n${here.bucket}\n${here.prefix}` : null;
  const ask = useRef<(force: boolean) => void>(() => {});
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  ask.current = (force: boolean) => {
    window.clearTimeout(timer.current);
    if (!here || !key) return;
    const n = ++seq.current;
    timer.current = window.setTimeout(() => {
      devtoolsApi
        .gitStatus(here.profileId, here.bucket, here.prefix, force)
        .then((info) => {
          if (n !== seq.current) return;
          setState(info ? { key, info } : null);
        })
        // git missing, a folder gone: the feature just stays off
        .catch(() => n === seq.current && setState(null));
    }, DEBOUNCE);
  };

  // the folder opened (or its listing reloaded after a change made here)
  useEffect(() => {
    if (!key) {
      seq.current++;
      setState(null);
      return;
    }
    ask.current(false);
  }, [key, listingStamp]);

  // back to the window: something may have changed in a terminal or an editor meanwhile
  useEffect(() => {
    if (!key) return;
    const again = () => document.visibilityState !== "hidden" && ask.current(true);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [key]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const info = state && state.key === key ? state.info : null;

  /** the marks, read once per answer: exact paths, folders ignored or untracked whole, and changes per folder */
  const index = useMemo(() => {
    if (!info) return null;
    const exact = new Map<string, GitChange>();
    const whole = new Map<string, GitKind>();
    const inside = new Map<string, number>();
    for (const c of info.changes) {
      exact.set(c.path, c);
      if (c.path.endsWith("/") && (c.kind === "ignored" || c.kind === "untracked")) whole.set(c.path, c.kind);
      if (c.kind === "ignored") continue;
      // every folder on the way to a change has changes inside
      let i = c.path.indexOf("/");
      while (i >= 0 && i < c.path.length - 1) {
        const dir = c.path.slice(0, i + 1);
        inside.set(dir, (inside.get(dir) ?? 0) + 1);
        i = c.path.indexOf("/", i + 1);
      }
    }
    return { exact, whole, inside };
  }, [info]);

  const prefix = here?.prefix ?? "";
  /** The mark for an item of this folder (or of a search below it). */
  const markFor = useCallback(
    (e: Entry): GitMark | undefined => {
      if (!info || !index) return undefined;
      const folder = e.kind === "folder";
      if (info.inside) return { kind: info.inside, letter: LETTER[info.inside], title: describe({ kind: info.inside, staged: false, unstaged: false }, folder) };
      if (!e.key.startsWith(prefix)) return undefined;
      const rel = e.key.slice(prefix.length);
      const own = index.exact.get(rel);
      if (own) return { kind: own.kind, letter: LETTER[own.kind], title: describe(own, folder) };
      // inside a folder that is ignored or untracked as a whole
      for (let i = rel.indexOf("/"); i >= 0 && i < rel.length - 1; i = rel.indexOf("/", i + 1)) {
        const k = index.whole.get(rel.slice(0, i + 1));
        if (k) return { kind: k, letter: LETTER[k], title: describe({ kind: k, staged: false, unstaged: false }, folder) };
      }
      const n = folder ? index.inside.get(rel) : undefined;
      if (n) return { kind: "inside", letter: "", title: n === 1 ? "1 change inside" : `${n.toLocaleString()} changes inside` };
      return undefined;
    },
    [info, index, prefix],
  );

  return { info, markFor };
}

export type PaneGit = ReturnType<typeof useGitStatus>;
