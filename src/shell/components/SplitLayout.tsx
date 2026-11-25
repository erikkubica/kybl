/**
 * The browser panes laid out as a tree of splits (paneLayout.ts), with a draggable divider
 * between neighbours (double-click shares the room evenly, arrow keys nudge it).
 *
 * A window too small for every pane at its least size shows the active pane alone, and the
 * workspace bar offers the others (`onCramped`): squeezing several panes below the size their
 * header row needs would leave none of them usable, and scrolling a whole layout sideways is
 * worse. The layout comes back as soon as there is room again.
 *
 * Each divider carries a small round link button for every pair of panes facing each other across
 * it (paneLayout `facingPairs`), at the middle of the stretch the two share: it switches
 * synchronized browsing on or off for that pair, so a lit button shows at a glance which panes
 * move together. Between two single panes the whole line lights up too. A stretch too short for
 * its button gets none (the pane's "…" menu still has that pair).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PaneId } from "../../browser/types";
import { Icon, type IconName } from "../../ui/components/Icons";
import type { MenuItem } from "../../ui/components/Dialogs";
import { DIVIDER, dividerPairs, facingPairs, fit, minSize, sameLink, type PaneNode } from "../lib/paneLayout";

/** the least stretch of a divider a link button needs: its own 22 px and a little air, so two never touch */
const LINK_ROOM = 32;

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
  /** a pane's name (the link buttons' labels) */
  nameOf: (id: PaneId) => string;
  /**
   * whether the window is too small for every pane: then only the active one shows, and the shell
   * offers the others in the workspace bar (WorkspaceBar's pane switcher)
   */
  onCramped?: (cramped: boolean) => void;
  /** synchronized browsing links panes `a` and `b` */
  linked: (a: PaneId, b: PaneId) => boolean;
  /** the link button on a divider: switches synchronized browsing for that pair */
  onToggleLink: (a: PaneId, b: PaneId) => void;
  /** whether two panes can browse together at all (a terminal can't: no link button there) */
  canLink?: (a: PaneId, b: PaneId) => boolean;
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
  const known = useMemo(() => dividerPairs(p.tree), [p.tree]);
  const onCramped = useRef(p.onCramped);
  onCramped.current = p.onCramped;
  useLayoutEffect(() => onCramped.current?.(cramped), [cramped]);
  // gone (one pane left): nothing is squeezed any more
  useLayoutEffect(() => () => onCramped.current?.(false), []);

  return (
    <div className="splits" ref={box}>
      {cramped ? (
        <div className="split-cramped">{p.pane(p.activeId, { flex: "1 1 0px" })}</div>
      ) : (
        room && <Node node={fit(p.tree, room.w, room.h)} path={[]} style={{ flex: "1 1 0px" }} w={room.w} h={room.h} known={known} {...p} />
      )}
    </div>
  );
}

type NodeProps = SplitLayoutProps & {
  node: PaneNode;
  path: number[];
  style: CSSProperties;
  /** the (sub)tree's room as drawn, px */
  w: number;
  h: number;
  /** the pairs the shell can link (from the saved shares): squeezed to fit, the drawn ones may differ */
  known: [PaneId, PaneId][];
};

function Node({ node, path, style, w, h, known, ...p }: NodeProps) {
  const el = useRef<HTMLDivElement>(null);
  /** ends a divider drag under way (unmounted mid-drag: its listeners go too) */
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);
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
      // the button came up where no mouseup reached us (another app, outside the window)
      if ((e.buttons & 1) === 0) return up();
      const at = (row ? e.clientX - rect.left : e.clientY - rect.top) - before;
      p.onSizes(path, place(i, at / room, room));
    };
    const up = () => {
      document.body.classList.remove("resizing-col", "resizing-row");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
      endDrag.current = null;
    };
    endDrag.current?.();
    endDrag.current = up;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
  };

  // each child's room as drawn, the way `fit` shared it out
  const share = Math.max(0, (row ? w : h) - DIVIDER * (node.kids.length - 1));
  /** a divider's length: a row's dividers run its full height, a column's its full width */
  const lineLen = row ? h : w;
  const kids: ReactNode[] = [];
  node.kids.forEach((k, i) => {
    if (i > 0) {
      const j = i - 1;
      // placed by the shares as drawn; only pairs the shell can link, with room for their button
      const facing = facingPairs(node, j).filter(
        (f) => (f.to - f.from) * lineLen >= LINK_ROOM && known.some(([a, b]) => sameLink([a, b], f.pair[0], f.pair[1])) && (p.canLink?.(...f.pair) ?? true),
      );
      // the whole line lights up only when it runs along just those two panes; beside a split the
      // buttons alone say which pairs are linked
      const whole = node.kids[j].t === "pane" && k.t === "pane";
      const lit = whole && facing.length === 1 && p.linked(...facing[0].pair);
      kids.push(
        <div
          key={`d${i}`}
          className={`split-divider ${lit ? "linked" : ""}`}
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
          {facing.map(({ pair: [a, b], at }) => {
            const on = p.linked(a, b);
            const names = `“${p.nameOf(a)}” and “${p.nameOf(b)}”`;
            // the active pane's accent line runs along its top: under a horizontal divider it
            // thickens the line downwards, so the button centres on both together
            const onAccent = !row && b === p.activeId;
            return (
              <button
                key={`${a}-${b}`}
                type="button"
                className={`split-link ${on ? "on" : ""} ${onAccent ? "on-accent" : ""}`}
                style={row ? { top: `${at * 100}%` } : { left: `${at * 100}%` }}
                aria-pressed={on}
                aria-label={`Synchronized browsing between ${names}`}
                title={
                  on
                    ? `Synchronized browsing: on. ${names} follow each other into folders and back up. Click to stop`
                    : `Synchronized browsing: link ${names} so they follow each other`
                }
                // the divider under it drags and double-clicks; the button only clicks
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                // nor do arrow keys on it nudge the divider
                onKeyDown={(e) => e.key.startsWith("Arrow") && e.stopPropagation()}
                onClick={() => p.onToggleLink(a, b)}
              >
                <Icon name="link" size={12} />
              </button>
            );
          })}
        </div>,
      );
    }
    const kw = row ? node.sizes[i] * share : w;
    const kh = row ? h : node.sizes[i] * share;
    kids.push(
      <Node key={k.t === "pane" ? k.id : `s${i}`} {...p} node={k} path={[...path, i]} style={{ flex: `${node.sizes[i]} 1 0px` }} w={kw} h={kh} known={known} />,
    );
  });

  return (
    <div className={`split split-${node.dir}`} ref={el} style={style}>
      {kids}
    </div>
  );
}

type Toward = "left" | "right" | "up" | "down";
const towardName = (d: Toward) => ({ left: "the left pane", right: "the right pane", up: "the pane above", down: "the pane below" })[d];

/** Another file pane, as a pane's "…" names it. */
export type OtherPane = {
  id: PaneId;
  /** which way it is, when it shares a divider with this one */
  dir: Toward | null;
  /** its folder's name */
  name: string;
  /** its connection, and which way it is */
  where: string;
  /** synced browsing with it is on */
  linked: boolean;
};

/**
 * A pane's items for working with the other panes, at the top of its toolbar's "…": this folder
 * there, swap, compare and synced browsing. With one other pane they name it ("the right pane");
 * with several, each opens a list of them, by folder and connection, as Copy to ▸ does.
 */
/** Which way a pane is from this one, as its row's icon. */
const arrow = (o: OtherPane): IconName => (o.dir ? `arrow-${o.dir}` : "dual-pane");

export function dualMenuItems({
  others,
  onToOther,
  onSwap,
  onCompare,
  onToggleSync,
}: {
  others: OtherPane[];
  onToOther: (id: PaneId) => void;
  onSwap: (id: PaneId) => void;
  onCompare: (id: PaneId) => void;
  onToggleSync: (id: PaneId) => void;
}): MenuItem[] {
  if (!others.length) return [];
  if (others.length === 1) {
    const o = others[0];
    const w = o.dir ? towardName(o.dir) : `“${o.name}”`;
    return [
      { type: "item", label: `Same folder in ${w}`, icon: arrow(o), onClick: () => onToOther(o.id) },
      { type: "item", label: `Swap with ${w}`, icon: "swap", hint: "⇧⌘S", onClick: () => onSwap(o.id) },
      { type: "item", label: `Compare with ${w}`, icon: "compare", onClick: () => onCompare(o.id) },
      { type: "item", label: `Synced browsing with ${w}`, icon: "link", checked: o.linked, onClick: () => onToggleSync(o.id) },
    ];
  }
  const list = (run: (id: PaneId) => void, ticks = false) => (): MenuItem[] =>
    others.map((o) => ({ type: "item", label: o.name, icon: arrow(o), detail: o.where, checked: ticks && o.linked ? true : undefined, onClick: () => run(o.id) }));
  return [
    { type: "submenu", label: "Same folder in", icon: "folder", items: list(onToOther) },
    { type: "submenu", label: "Swap with", icon: "swap", items: list(onSwap) },
    { type: "submenu", label: "Compare with", icon: "compare", items: list(onCompare) },
    { type: "submenu", label: "Synced browsing with", icon: "link", items: list(onToggleSync, true) },
  ];
}
