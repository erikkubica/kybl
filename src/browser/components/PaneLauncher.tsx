/**
 * What an empty pane offers (a split, a new workspace, a closed connection): pick what it shows.
 * The place the other pane shows comes first, so ↵ right away opens the same folder; then the
 * connections opened last, favorites and a terminal. Typing finds any connection or favorite.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "../../ui/components/Icons";
import { ProviderBadge } from "../../sidebar/Sidebar";

export type LaunchItem = {
  key: string;
  section: "same" | "recent" | "favorite" | "connection" | "terminal" | "new";
  label: string;
  /** a line under the label: the folder, the group, the connection */
  sub?: string;
  /** a connection's badge; else `icon` */
  provider?: string;
  icon?: IconName;
  run: () => void;
};

const TITLES: Record<LaunchItem["section"], string> = {
  same: "Same place",
  recent: "Recent connections",
  favorite: "Favorites",
  connection: "Connections",
  terminal: "Terminal",
  new: "",
};
/** without a query: this many connections opened last */
const RECENT_SHOWN = 6;
/** with a query: this many found at most */
const FOUND_MAX = 60;

export function PaneLauncher({ items }: { items: LaunchItem[] }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const connections = items.filter((x) => x.section === "connection").length;

  const shown = useMemo(() => {
    if (!q) {
      // the connections list itself waits for a query (it can be hundreds long)
      const recent = items.filter((x) => x.section === "recent").slice(0, RECENT_SHOWN);
      return [...items.filter((x) => x.section === "same"), ...recent, ...items.filter((x) => x.section === "favorite" || x.section === "terminal" || x.section === "new")];
    }
    const words = q.split(/\s+/);
    const hit = (x: LaunchItem) => {
      const text = `${x.label}\n${x.sub ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    };
    // a connection that is also among the recent ones shows once, under Connections
    return items.filter((x) => x.section !== "recent" && x.section !== "same" && x.section !== "new" && hit(x)).slice(0, FOUND_MAX);
  }, [items, q]);
  const cur = Math.min(at, Math.max(0, shown.length - 1));

  const move = (to: number) => {
    setAt(to);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-i="${to}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (shown.length) move((cur + 1) % shown.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) move((cur - 1 + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      shown[cur]?.run();
    } else if (e.key === "Escape" && query) {
      e.stopPropagation();
      setQuery("");
      setAt(0);
    }
  };

  let lastSection: string | null = null;
  return (
    <div className="launcher">
      <div className="launcher-card">
        <h2>What should this pane show?</h2>
        <label className="launcher-find">
          <Icon name="search" size={15} />
          <input
            data-list-focus
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAt(0);
            }}
            onKeyDown={onKey}
            placeholder={connections > 0 ? `Find a connection or favorite (${connections.toLocaleString()})` : "Find a favorite"}
            aria-label="Find a connection or favorite"
            spellCheck={false}
            autoComplete="off"
          />
          {!q && shown[0]?.section === "same" && <kbd className="launcher-enter">↵</kbd>}
        </label>
        <div className="launcher-list" ref={listRef} role="listbox" aria-label="Places">
          {shown.length === 0 && <div className="launcher-none">Nothing matches “{query.trim()}”</div>}
          {shown.map((x, i) => {
            const head = x.section !== lastSection && TITLES[x.section];
            lastSection = x.section;
            return (
              <div key={x.key} className="launcher-group">
                {head && <div className="launcher-head">{head}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === cur}
                  data-i={i}
                  className={`launcher-item${i === cur ? " on" : ""}${x.section === "same" ? " same" : ""}`}
                  onMouseMove={() => i !== cur && setAt(i)}
                  onClick={x.run}
                >
                  {x.provider ? <ProviderBadge provider={x.provider} /> : <span className="launcher-icon"><Icon name={x.icon ?? "folder"} size={15} /></span>}
                  <span className="launcher-text">
                    <span className="launcher-label">{x.label}</span>
                    {x.sub && <span className="launcher-sub">{x.sub}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {!q && connections > 0 && <p className="launcher-hint">Type to find any connection, or pick one in the sidebar.</p>}
      </div>
    </div>
  );
}
