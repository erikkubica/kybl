/** Back / Forward through the places visited in this window, like a browser or Finder. */
import { useCallback, useRef, useState } from "react";
import { sameLoc, type Loc } from "./useListing";

const MAX = 100;

export type HistorySnap = { stack: Loc[]; index: number };

export function useHistory() {
  const stack = useRef<Loc[]>([]);
  const index = useRef(-1);
  // only for re-rendering the Back / Forward buttons
  const [, bump] = useState(0);

  /** Records a visit (not for moves made by Back / Forward themselves). */
  const push = useCallback((loc: Loc) => {
    if (sameLoc(stack.current[index.current] ?? null, loc)) return;
    stack.current = stack.current.slice(0, index.current + 1).concat(loc).slice(-MAX);
    index.current = stack.current.length - 1;
    bump((n) => n + 1);
  }, []);

  /** The place `delta` steps away (-1 back, +1 forward), which becomes current; null at the ends. */
  const step = useCallback((delta: number): Loc | null => {
    const i = index.current + delta;
    if (i < 0 || i >= stack.current.length) return null;
    index.current = i;
    bump((n) => n + 1);
    return stack.current[i];
  }, []);

  /** Drops every place of a connection that no longer exists. */
  const forget = useCallback((profileId: string) => {
    const cur = stack.current[index.current];
    stack.current = stack.current.filter((l) => l.profileId !== profileId);
    index.current = cur ? Math.max(-1, stack.current.indexOf(cur)) : stack.current.length - 1;
    if (index.current < 0) index.current = stack.current.length - 1;
    bump((n) => n + 1);
  }, []);

  /** The places as they are (a workspace keeps its panes' Back / Forward while another is on screen). */
  const save = useCallback((): HistorySnap => ({ stack: stack.current, index: index.current }), []);
  /** Takes saved places back (none: just `here`). */
  const load = useCallback((s: HistorySnap | null, here: Loc | null) => {
    if (s && s.stack.length && s.index >= 0 && s.index < s.stack.length) {
      stack.current = s.stack;
      index.current = s.index;
    } else {
      stack.current = here ? [here] : [];
      index.current = stack.current.length - 1;
    }
    bump((n) => n + 1);
  }, []);

  return {
    push,
    step,
    forget,
    save,
    load,
    canBack: index.current > 0,
    canForward: index.current < stack.current.length - 1,
  };
}
