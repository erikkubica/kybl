/**
 * The connections picked in the sidebar to organize several at once (⌘-click, or "Select" in a
 * connection's menu): Move to group… and Pin act on all of them. Ids of connections that were
 * deleted drop out by themselves.
 */
import { useCallback, useEffect, useState } from "react";
import type { Profile } from "../../core/types";

export function useConnPicks(profiles: Profile[]) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setPicked((cur) => {
      if (!cur.size) return cur;
      const live = new Set(profiles.map((p) => p.id));
      const next = new Set([...cur].filter((id) => live.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [profiles]);
  const toggle = useCallback(
    (id: string) =>
      setPicked((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const add = useCallback((id: string) => setPicked((cur) => (cur.has(id) ? cur : new Set(cur).add(id))), []);
  const clear = useCallback(() => setPicked((cur) => (cur.size ? new Set() : cur)), []);
  return { picked, toggle, add, clear };
}
export type ConnPicks = ReturnType<typeof useConnPicks>;
