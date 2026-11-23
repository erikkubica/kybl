/**
 * The browser panes laid out as a tree of splits (paneLayout.ts), with a draggable divider
 * between neighbours (double-click shares the room evenly, arrow keys nudge it).
 *
 * A window too small for every pane at its least size shows the active pane alone, with a slim
 * strip above it to switch to the others: squeezing several panes below the size their header
 * row needs would leave none of them usable, and scrolling a whole layout sideways is worse.
 * The layout comes back as soon as there is room again.
 *
 * Each divider carries a small round link button at its middle: it switches synchronized browsing
 * on or off for the two panes facing each other there (paneLayout `dividerLink`), so a lit
 * divider shows at a glance which panes move together. Beside a split the button sits on the stretch
 * the two panes share.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PaneId } from "../browser/types";
import { Icon } from "../Icons";
import type { MenuItem } from "../components/Dialogs";
import { DIVIDER, dividerLink, fit, leaves, minSize, type PaneNode } from "./paneLayout";

export type SplitLayoutProps = {
  tree: PaneNode;
  activeId: PaneId;
  /** draws one pane; `style` sizes it in its split */
  pane: (id: PaneId, style: CSSProperties) => ReactNode;
  /** a divider moved: the new shares of the split at `path` */
  onSizes: (path: number[], sizes: number[]) => void;
  /** a divider was double-clicked: that split shares its room evenly */
  onEqualize: (path: number[]) => void;
  /** the room the layout has, whenever it changes (splitting checks there is space) */
  onRoom?: (w: number, h: number) => void;
  /** the narrow window's strip: a pane's name, and picking one */
  nameOf: (id: PaneId) => string;
  onPick: (id: PaneId) => void;
  /** synchronized browsing links panes `a` and `b` */
  linked: (a: PaneId, b: PaneId) => boolean;
  /** the link button on a divider: switches synchronized browsing for that pair */
  onToggleLink: (a: PaneId, b: PaneId) => void;
};

export function SplitLayout(p: SplitLayoutProps) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const onRoom = useRef(p.onRoom);
  onRoom.current = p.onRoom;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const look = () => {
      const r = { w: el.clientWidth, h: el.clientHeight };
      setRoom((cur) => (cur && cur.w === r.w && cur.h === r.h ? cur : r));
      onRoom.current?.(r.w, r.h);
    };
    const ro = new ResizeObserver(look);
    ro.observe(el);
    look();
    return () => ro.disconnect();
  }, []);

  const need = minSize(p.tree);
  const cramped = !!room && (room.w < need.w || room.h < need.h);
  const ids = leaves(p.tree);

  return (
    <div className="splits" ref={box}>
      {cramped ? (
        <div className="split-cramped">
          <div className="split-strip" role="tablist" aria-label="Panes">
            <span className="split-strip-note" title="The window is too small to show every pane. Make it bigger, or close a pane.">
              {ids.length} panes
            </span>
            {ids.map((id, i) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === p.activeId}
                className={`split-strip-tab ${id === p.activeId ? "on" : ""}`}
                onClick={() => p.onPick(id)}
                title={p.nameOf(id)}
              >
                {/* numbered: two panes often show folders of the same name */}
                <span className="split-strip-n">{i + 1}</span>
                {p.nameOf(id)}
              </button>
            ))}
          </div>
          {p.pane(p.activeId, { flex: "1 1 0px" })}
        </div>
      ) : (
        room && <Node node={fit(p.tree, room.w, room.h)} path={[]} style={{ flex: "1 1 0px" }} {...p} />
      )}
    </div>
  );
}

function Node({ node, path, style, ...p }: SplitLayoutProps & { node: PaneNode; path: number[]; style: CSSProperties }) {
  const el = useRef<HTMLDivElement>(null);
  if (node.t === "pane") return <>{p.pane(node.id, style)}</>;
  const row = node.dir === "row";
  const mins = node.kids.map((k) => (row ? minSize(k).w : minSize(k).h));

  /** The room the children share, in px (the split's size less its dividers). */
  const roomPx = () => {
    const r = el.current?.getBoundingClientRect();
    return r ? Math.max(1, (row ? r.width : r.height) - DIVIDER * (node.kids.length - 1)) : 1;
  };
  /** Moves the divider after child `i` so that child gets share `a` of the pair's room. */
  const place = (i: number, a: number, room: number) => {
    const pair = node.sizes[i] + node.sizes[i + 1];
    const lo = mins[i] / room;
    const hi = pair - mins[i + 1] / room;
    if (hi < lo) return node.sizes;
    const s = [...node.sizes];
    s[i] = Math.min(hi, Math.max(lo, a));
    s[i + 1] = pair - s[i];
    return s;
  };

  const startDrag = (i: number, ev: React.MouseEvent) => {
    const box = el.current;
    if (!box || ev.button !== 0) return;
    ev.preventDefault();
    const rect = box.getBoundingClientRect();
    const room = roomPx();
    // where the pair starts: the shares and dividers before child i
    const before = node.sizes.slice(0, i).reduce((a, b) => a + b, 0) * room + DIVIDER * i;
    document.body.classList.add(row ? "resizing-col" : "resizing-row");
    const move = (e: MouseEvent) => {
      const at = (row ? e.clientX - rect.left : e.clientY - rect.top) - before;
      p.onSizes(path, place(i, at / room, room));
    };
    const up = () => {
      document.body.classList.remove("resizing-col", "resizing-row");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // the pairs come from the saved shares, not the ones squeezed to fit: the shell knows the same pairs
  const saved = path.reduce<PaneNode>((n, i) => (n.t === "split" ? n.kids[i] : n), p.tree);
  const kids: ReactNode[] = [];
  node.kids.forEach((k, i) => {
    if (i > 0) {
      const j = i - 1;
      const {
        pair: [a, b],
        at,
      } = dividerLink(saved.t === "split" ? saved : node, j);
      const on = p.linked(a, b);
      const names = `“${p.nameOf(a)}” and “${p.nameOf(b)}”`;
      // the whole line lights up only when it runs along just those two panes; beside a split the
      // button alone says which pair it means
      const whole = node.kids[j].t === "pane" && k.t === "pane";
      kids.push(
        <div
          key={`d${i}`}
          className={`split-divider ${on && whole ? "linked" : ""}`}
          role="separator"
          aria-orientation={row ? "vertical" : "horizontal"}
          aria-label="Resize the panes"
          aria-valuenow={Math.round((node.sizes[j] / (node.sizes[j] + node.sizes[i])) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          title="Drag to resize · double-click to make them the same size"
          onMouseDown={(e) => startDrag(j, e)}
          onDoubleClick={() => p.onEqualize(path)}
          onKeyDown={(e) => {
            const back = row ? "ArrowLeft" : "ArrowUp";
            const fwd = row ? "ArrowRight" : "ArrowDown";
            if (e.key !== back && e.key !== fwd) return;
            e.preventDefault();
            e.stopPropagation();
            const room = roomPx();
            p.onSizes(path, place(j, node.sizes[j] + (e.key === back ? -40 : 40) / room, room));
          }}
        >
          <button
            type="button"
            className={`split-link ${on ? "on" : ""}`}
            style={row ? { top: `${at * 100}%` } : { left: `${at * 100}%` }}
            aria-pressed={on}
            aria-label={`Synchronized browsing between ${names}`}
            title={on ? `Synchronized browsing: on. ${names} follow each other into folders and back up. Click to stop` : `Synchronized browsing: link ${names} so they follow each other`}
            // the divider under it drags and double-clicks; the button only clicks
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={() => p.onToggleLink(a, b)}
          >
            <Icon name="link" size={12} />
          </button>
        </div>,
      );
    }
    kids.push(<Node key={k.t === "pane" ? k.id : `s${i}`} {...p} node={k} path={[...path, i]} style={{ flex: `${node.sizes[i]} 1 0px` }} />);
  });

  return (
    <div className={`split split-${node.dir}`} ref={el} style={style}>
      {kids}
    </div>
  );
}

type Toward = "left" | "right" | "up" | "down";
const towardName = (d: Toward) => ({ left: "the left pane", right: "the right pane", up: "the pane above", down: "the pane below" })[d];

/**
 * A pane's items for working with another pane, at the top of its toolbar's "…": this folder
 * there, swap, compare, and synchronized browsing with each pane it shares a divider with (the
 * same switch as the link on that divider).
 */
export function dualMenuItems({
  toOther,
  onToOther,
  onSwap,
  onCompare,
  syncWith,
  onToggleSync,
}: {
  /** which way "the other pane" is, and what it shows (with more than two panes, to tell them apart) */
  toOther: { dir: Toward; name: string };
  onToOther: () => void;
  onSwap: () => void;
  onCompare: () => void;
  /** the panes across a divider from this one, and whether each is linked */
  syncWith: { id: PaneId; dir: Toward | null; name: string; on: boolean }[];
  onToggleSync: (id: PaneId) => void;
}): MenuItem[] {
  const named = (name: string) => (name ? ` (“${name}”)` : "");
  const where = towardName(toOther.dir) + named(toOther.name);
  const sync: MenuItem[] =
    syncWith.length === 1
      ? [
          {
            type: "item",
            label: `Synced browsing with ${syncWith[0].dir ? towardName(syncWith[0].dir) : `“${syncWith[0].name}”`}`,
            icon: "link",
            checked: syncWith[0].on,
            onClick: () => onToggleSync(syncWith[0].id),
          },
        ]
      : syncWith.length > 1
        ? [
            {
              type: "submenu",
              label: "Synced browsing with",
              icon: "link",
              items: () =>
                syncWith.map((s) => {
                  const label = s.dir ? towardName(s.dir) + named(s.name) : `“${s.name}”`;
                  return { type: "item" as const, label: label[0].toUpperCase() + label.slice(1), checked: s.on, onClick: () => onToggleSync(s.id) };
                }),
            },
          ]
        : [];
  return [
    { type: "item", label: `Open this folder in ${where} too`, icon: `arrow-${toOther.dir}`, onClick: onToOther },
    { type: "item", label: `Swap with ${where}`, icon: "swap", hint: "⇧⌘S", onClick: onSwap },
    { type: "item", label: `Compare with ${where}`, icon: "compare", onClick: onCompare },
    ...sync,
  ];
}

