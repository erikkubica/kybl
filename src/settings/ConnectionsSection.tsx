/**
 * Settings › Connections: every saved connection, filed under its group, so it shows at a glance
 * which are in a group and which aren't. A filter narrows it (name, address or group), "No group"
 * shows only those still to file, and several picked at once move to a group in one go.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "../core/types";
import { ProviderBadge } from "../sidebar/Sidebar";
import { addressOf } from "../connections/lib/kinds";
import { allGroups, byName, groupLabel, groupOf } from "../connections/lib/groups";
import { Icon } from "../ui/components/Icons";

/** what a row says under its name: a server's own address, or a bucket store's endpoint */
function whereOf(p: Profile): string {
  if (p.kind && p.kind !== "s3") return addressOf(p);
  return `${p.endpoint || "Amazon S3"} · ${p.region}${p.bucket ? ` · ${p.bucket}` : ""}`;
}

export function ConnectionsSection({
  profiles,
  onEditProfile,
  onNewProfile,
  onImportProfiles,
  onGroupMenu,
}: {
  profiles: Profile[];
  onEditProfile: (p: Profile) => void;
  onNewProfile: () => void;
  onImportProfiles?: () => void;
  /** "Move to group" for these connections, as a menu at x, y (the sidebar's own) */
  onGroupMenu?: (ps: Profile[], x: number, y: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "loose">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const lastPick = useRef<string | null>(null);

  const loose = profiles.filter((p) => !groupOf(p)).length;
  const q = query.trim().toLowerCase();
  const shown = profiles.filter((p) => (only === "loose" ? !groupOf(p) : true) && (!q || `${p.name}\n${whereOf(p)}\n${groupOf(p)}`.toLowerCase().includes(q)));
  // the groups in sidebar order, "No group" first: that's what is still to file
  const sections = useMemo(() => {
    const order = ["", ...allGroups(profiles)];
    const by = new Map<string, Profile[]>();
    for (const p of shown) {
      const g = groupOf(p);
      by.set(g, [...(by.get(g) ?? []), p]);
    }
    return order.filter((g) => by.has(g)).map((g) => ({ group: g, items: by.get(g)!.sort((a, b) => byName(a.name, b.name)) }));
  }, [profiles, shown]);
  const flat = sections.flatMap((s) => s.items);

  // moved (or deleted) ones leave the pick: what is ticked is always what a move would take
  const groupsBefore = useRef(new Map(profiles.map((p) => [p.id, groupOf(p)])));
  useEffect(() => {
    const before = groupsBefore.current;
    groupsBefore.current = new Map(profiles.map((p) => [p.id, groupOf(p)]));
    setPicked((cur) => {
      const next = new Set([...cur].filter((id) => groupsBefore.current.has(id) && groupsBefore.current.get(id) === before.get(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [profiles]);

  /** a tick; with Shift, everything between it and the last one ticked as well */
  const toggle = (id: string, range: boolean) => {
    setPicked((cur) => {
      const next = new Set(cur);
      const on = !cur.has(id);
      const ids = flat.map((p) => p.id);
      const a = lastPick.current ? ids.indexOf(lastPick.current) : -1;
      const b = ids.indexOf(id);
      const span = range && a >= 0 && b >= 0 ? ids.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
      for (const x of span) on ? next.add(x) : next.delete(x);
      return next;
    });
    lastPick.current = id;
  };
  /** a group's header tick: all of its rows on, or all off when they all are */
  const toggleSection = (items: Profile[]) =>
    setPicked((cur) => {
      const all = items.every((p) => cur.has(p.id));
      const next = new Set(cur);
      for (const p of items) all ? next.delete(p.id) : next.add(p.id);
      return next;
    });
  const pickedList = profiles.filter((p) => picked.has(p.id));
  const menuAt = (ps: Profile[], el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onGroupMenu?.(ps, r.left, r.bottom + 4);
  };

  return (
    <>
      <h3 className="set-title">Connections</h3>
      {profiles.length > 0 && (
        <div className="conn-tools">
          <label className="conn-filter">
            <Icon name="search" size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name, address or group" aria-label="Filter connections" spellCheck={false} />
            {query && (
              <button type="button" className="icon-btn" aria-label="Clear filter" onClick={() => setQuery("")}>
                <Icon name="x" size={12} />
              </button>
            )}
          </label>
          <div className="seg" role="group" aria-label="Show">
            <button type="button" className={only === "all" ? "on" : ""} aria-pressed={only === "all"} onClick={() => setOnly("all")}>
              All · {profiles.length}
            </button>
            <button type="button" className={only === "loose" ? "on" : ""} aria-pressed={only === "loose"} onClick={() => setOnly("loose")}>
              No group · {loose}
            </button>
          </div>
        </div>
      )}
      {pickedList.length > 0 && onGroupMenu && (
        <div className="conn-pickbar" role="toolbar" aria-label="Picked connections">
          <span>{pickedList.length === 1 ? "1 connection" : `${pickedList.length} connections`} picked</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={(e) => menuAt(pickedList, e.currentTarget)}>
            <Icon name="folder" size={14} /> Move to group…
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}
      <div className="set-card">
        {profiles.length === 0 && (
          <div className="conn-empty">
            <b>No connections yet</b>
            <small>Add one to start browsing.</small>
          </div>
        )}
        {profiles.length > 0 && !sections.length && (
          <div className="conn-empty">
            <b>{only === "loose" && !q ? "Every connection is in a group" : "Nothing matches"}</b>
          </div>
        )}
        {sections.map(({ group, items }) => {
          const all = items.every((p) => picked.has(p.id));
          const some = !all && items.some((p) => picked.has(p.id));
          return (
            <section key={group || "\u0000"} className="conn-section">
              <div className={`conn-group-head${group ? "" : " loose"}`}>
                {onGroupMenu && (
                  <input
                    type="checkbox"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some;
                    }}
                    onChange={() => toggleSection(items)}
                    aria-label={`Pick every connection ${group ? `in ${groupLabel(group)}` : "without a group"}`}
                  />
                )}
                <Icon name="folder" size={14} />
                <span className="conn-group-name">{group ? groupLabel(group) : "No group"}</span>
                <span className="conn-group-count">{items.length}</span>
              </div>
              {items.map((p) => (
                <div key={p.id} className={`conn-row${picked.has(p.id) ? " picked" : ""}`}>
                  {onGroupMenu && (
                    <input
                      type="checkbox"
                      checked={picked.has(p.id)}
                      onChange={() => {}}
                      onClick={(e) => toggle(p.id, e.shiftKey)}
                      aria-label={`Pick ${p.name}`}
                    />
                  )}
                  <ProviderBadge provider={p.provider} large />
                  <div className="set-label">
                    {p.name}
                    <small className="selectable">{whereOf(p)}</small>
                  </div>
                  {onGroupMenu && (
                    <button
                      type="button"
                      className={`conn-group-btn${groupOf(p) ? "" : " loose"}`}
                      title="Move to group"
                      onClick={(e) => menuAt(picked.has(p.id) && pickedList.length > 1 ? pickedList : [p], e.currentTarget)}
                    >
                      <Icon name="folder" size={13} />
                      <span>{groupOf(p) ? groupLabel(groupOf(p)) : "Add to group"}</span>
                      <Icon name="chevron-down" size={12} />
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => onEditProfile(p)}>
                    Edit
                  </button>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary btn-sm" onClick={onNewProfile}>
          <Icon name="plus" size={14} /> New connection
        </button>
        {onImportProfiles && (
          <button className="btn btn-sm" onClick={onImportProfiles}>
            <Icon name="download" size={14} /> Import connections…
          </button>
        )}
      </div>
    </>
  );
}
