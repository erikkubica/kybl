/**
 * Behaviour that spans two panes: switching the active pane, copy / move to the other pane
 * (F5 / F6 and drag), swapping them, opening the same folder in both, synchronized browsing and
 * Compare folders. Made once by the shell; it reads the current panes through `get`, so the
 * callbacks it hands to the panes never go stale.
 *
 * "The other pane" is the one the shell pairs with each pane (`otherOf`): with two panes simply
 * the other one, with more the one used most recently before it. Dragging works between any two.
 * Synchronized browsing is not tied to "the other pane": it links the two panes either side of a
 * divider (the link button on it), so it reads the shell's links through `syncedWith`.
 */
import { createElement } from "react";
import { parentPrefix } from "../../core/format";
import { destLabel, isValidDest, placeLabel } from "../../transfers/lib/moving";
import type { MenuItem } from "../../ui/components/Dialogs";
import type { Settings } from "../../settings/settings";
import type { Entry, Profile } from "../../core/types";
import type { TransferActions } from "../../transfers/hooks/useTransfers";
import type { Pane, PaneEnv } from "../../browser/hooks/usePane";
import type { Loc, PaneId } from "../../browser/types";
import { compareFolders, diffSelection, etagsComparable } from "../../compare/compareFolders";
import { CompareSummary } from "../../compare/CompareSummary";
import { crossesDisk, crossesDiskAt, sendItems, sendToPane, viaJob, type CrossCtx, type DestPlace } from "../lib/crossPane";
import { menuPointFor } from "../../ui/components/Dialogs";
import { peekCaps } from "../../core/useCaps";
import { LOCAL_ID } from "../../core/api";
import { rootName } from "../../connections/lib/roots";
import type { Dialogs } from "../hooks/useDialogs";
import type { ConfirmMigration } from "../hooks/useMigrationHost";
import { ON_OS } from "../../core/osNames";

export type DualContext = {
  /** the panes on screen, in reading order */
  panes: Pane[];
  /** any pane slot, on screen or not */
  pane: (id: PaneId) => Pane;
  /** the pane `id` pairs with: F5 / F6 go there, swap and compare use it */
  otherOf: (id: PaneId) => PaneId | null;
  /** the panes synchronized browsing moves along with pane `id` (none when it isn't linked) */
  syncedWith: (id: PaneId) => PaneId[];
  /** ends synchronized browsing among these panes (the links between them) */
  stopSync: (ids: PaneId[]) => void;
  /** which way pane `b` is from pane `a` */
  relation: (a: PaneId, b: PaneId) => "left" | "right" | "up" | "down" | null;
  activeId: PaneId;
  setActive: (id: PaneId) => void;
  profiles: Profile[];
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  dialogs: Dialogs;
  transfers: TransferActions;
  autoShowActivity: () => void;
  focusPane: (id: PaneId) => void;
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  busyFor?: CrossCtx["busyFor"];
  /** F5 / F6 between connections: the job's quick confirm (destination editable) */
  confirmMigration?: ConfirmMigration;
};

const placeName = (p: Pane) => (p.prefix && p.profile ? destLabel(p.prefix, p.bucket ?? "", p.profile.id) : (p.bucketLabel ?? ""));

export const paneName = placeName;

// ---------------------------------------------------------------- Copy to / Move to
/** Where Copy to / Move to sent things last, newest first (kept on this device). */
const RECENT_KEY = "s3b.sendRecent";
const RECENT_MAX = 6;
const locKey = (l: Loc) => `${l.profileId}\n${l.bucket}\n${l.prefix}`;

function loadRecent(): Loc[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.profileId === "string" && typeof x.bucket === "string" && typeof x.prefix === "string") : [];
  } catch {
    return [];
  }
}

function rememberSent(l: Loc) {
  const next = [l, ...loadRecent().filter((x) => locKey(x) !== locKey(l))].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** A place Copy to / Move to offers: an open pane's folder, a recent one or a favorite. */
type Target = { loc: Loc; group: "Open panes" | "Recent" | "Favorites"; pane?: Pane };

export function makeDualActions(get: () => DualContext) {
  const pane = (id: PaneId) => get().pane(id);
  const multi = () => get().panes.length > 1;
  /** the other pane of `id`, while there is one on screen */
  const otherPane = (id: PaneId) => {
    const o = get().otherOf(id);
    return o ? pane(o) : null;
  };
  // a pane following the other must not make the other follow it back
  let following = false;
  /**
   * Linked panes that couldn't follow into a folder: the folder the leading pane was in when they
   * stayed behind. They wait there, out of step, until it comes back up to that folder.
   */
  const behind = new Map<PaneId, string>();

  /** Runs a move of a pane without it echoing back through synchronized browsing. */
  const quietly = (fn: () => void) => {
    following = true;
    try {
      fn();
    } finally {
      following = false;
    }
  };
  const goTo = (p: Pane, to: Loc) => {
    const prof = get().profiles.find((x) => x.id === to.profileId);
    if (prof) p.go(prof, to.bucket, to.prefix);
  };

  /** Synchronized browsing: into a subfolder, or up a level, in each linked pane that can do the same. */
  const follow = (id: PaneId, from: Loc | null, to: Loc) => {
    const c = get();
    if (following || !multi() || !from || from.profileId !== to.profileId || from.bucket !== to.bucket) return;
    const onScreen = new Set(c.panes.map((p) => p.id));
    const group = c.syncedWith(id);
    /** linked panes that have no such folder: they stay where they are, and the user hears of it */
    const stuck: Pane[] = [];
    for (const oid of group) {
      const o = onScreen.has(oid) ? pane(oid) : null;
      if (!o?.here || o.ent.search) continue;
      const waitAt = behind.get(oid);
      if (waitAt !== undefined) {
        // still down the path it couldn't follow: it waits; back where they parted: in step again
        if (to.prefix.startsWith(waitAt)) {
          if (to.prefix === waitAt) behind.delete(oid);
          continue;
        }
        behind.delete(oid);
      }
      if (to.prefix.startsWith(from.prefix) && to.prefix !== from.prefix) {
        const sub = to.prefix.slice(from.prefix.length);
        const target = o.prefix + sub;
        // only a direct subfolder that the other pane has listed
        if (sub.indexOf("/") !== sub.length - 1 || !o.ent.fresh) continue;
        if (o.ent.listing.folders.includes(target)) quietly(() => o.navigate(target));
        else {
          behind.set(oid, from.prefix);
          stuck.push(o);
        }
      } else if (from.prefix.startsWith(to.prefix) && from.prefix !== to.prefix) {
        const gone = from.prefix.slice(to.prefix.length);
        if (gone.indexOf("/") === gone.length - 1 && o.prefix.endsWith(gone)) quietly(() => o.navigate(parentPrefix(o.prefix)));
      }
    }
    if (stuck.length) {
      const name = to.prefix.split("/").filter(Boolean).pop() ?? "";
      const where = stuck.length === 1 ? placeName(stuck[0]) || "the other pane" : `${stuck.length} linked panes`;
      c.dialogs.toast("info", `There's no “${name}” in ${where}, so ${stuck.length === 1 ? "it stays" : "they stay"} where ${stuck.length === 1 ? "it is" : "they are"}. Synced browsing goes on when you come back up.`, {
        label: "Turn off synced browsing",
        run: () => {
          for (const x of [id, ...group]) behind.delete(x);
          c.stopSync([id, ...group]);
        },
      });
    }
  };

  /** Every place `list` from pane `id` can go, grouped: open panes, recent ones, favorites. */
  const targets = (id: PaneId, list: Entry[], mode: "copy" | "move"): Target[] => {
    const c = get();
    const src = pane(id);
    const from = src.here;
    const seen = new Set<string>();
    const out: Target[] = [];
    const add = (loc: Loc, group: Target["group"], p?: Pane) => {
      const k = locKey(loc);
      if (seen.has(k) || !c.profiles.some((x) => x.id === loc.profileId)) return;
      seen.add(k);
      // where it already is (or a folder into itself): nothing to do there
      if (from && loc.profileId === from.profileId && loc.bucket === from.bucket && !isValidDest(list, loc.prefix)) return;
      // this computer and the cloud only copy to each other
      if (mode === "move" && from && crossesDiskAt(from, loc)) return;
      out.push({ loc, group, pane: p });
    };
    for (const p of c.panes) if (p.id !== id && p.here) add(p.here, "Open panes", p);
    for (const l of loadRecent()) add(l, "Recent");
    for (const f of c.settings.favorites) add({ profileId: f.profileId, bucket: f.bucket, prefix: f.prefix }, "Favorites");
    return out;
  };

  const destPlace = (loc: Loc): DestPlace => ({
    profileId: loc.profileId,
    bucket: loc.bucket,
    connectionName: get().profiles.find((x) => x.id === loc.profileId)?.name ?? "",
    rootName: rootName(loc.profileId, loc.bucket),
    singleRoot: peekCaps(loc.profileId)?.roots === "single",
  });

  /** Sends `list` from pane `id` to a target, by whichever route the two places need. */
  const sendTo = (id: PaneId, list: Entry[], mode: "copy" | "move", t: Target) => {
    const src = pane(id);
    if (!src.here) return;
    void sendItems(src.ops, src.here, list, mode, destPlace(t.loc), t.loc.prefix, get(), () => rememberSent(t.loc));
  };

  /** The rows of Copy to ▸ / Move to ▸: the targets under small headings, then the folder picker. */
  const targetItems = (id: PaneId, list: Entry[], mode: "copy" | "move"): MenuItem[] => {
    const c = get();
    const out: MenuItem[] = [];
    let group: string | null = null;
    for (const t of targets(id, list, mode)) {
      if (t.group !== group) {
        if (group) out.push({ type: "sep" });
        out.push({ type: "label", label: t.group });
        group = t.group;
      }
      const name = t.loc.prefix ? destLabel(t.loc.prefix, t.loc.bucket, t.loc.profileId) : rootName(t.loc.profileId, t.loc.bucket);
      const conn = t.loc.profileId === LOCAL_ID ? ON_OS.device : (c.profiles.find((x) => x.id === t.loc.profileId)?.name ?? "");
      const inside = placeLabel(t.loc.profileId, t.loc.bucket, t.loc.prefix);
      out.push({
        type: "item",
        label: name,
        icon: t.pane ? "split" : t.group === "Favorites" ? "star" : "folder",
        detail: [conn, inside !== name ? inside : ""].filter(Boolean).join(" · "),
        onClick: () => sendTo(id, list, mode, t),
      });
    }
    if (out.length) out.push({ type: "sep" });
    out.push({ type: "item", label: "Choose folder…", icon: "folder", onClick: () => pane(id).actions.askMove(list, mode) });
    return out;
  };

  /** F5 / F6: the selection (or the item under the cursor) to the other pane's folder, after a confirm. */
  const sendSelection = async (mode: "copy" | "move") => {
    const c = get();
    const src = pane(c.activeId);
    let items = src.sel.selectedEntries;
    if (!items.length && src.sel.cursor.current) items = src.ent.entries.filter((e) => e.key === src.sel.cursor.current);
    if (!items.length) {
      c.dialogs.toast("info", `Select what to ${mode} first`);
      return;
    }
    // straight to the other pane only when there's exactly one other: otherwise it's picked from
    // the same list Copy to ▸ / Move to ▸ shows, opened at the selection
    if (c.panes.length !== 2) {
      const row = document.querySelector(`[data-pane="${src.id}"] .row.selected, [data-pane="${src.id}"] .tile.selected`);
      const at = menuPointFor(row);
      c.dialogs.menu(at.x, at.y, [{ type: "label", label: mode === "copy" ? "Copy to" : "Move to" }, ...targetItems(src.id, items, mode)]);
      return;
    }
    const dst = otherPane(c.activeId);
    if (!dst?.here) {
      c.dialogs.toast("info", "Open a folder in the other pane first");
      return;
    }
    // between connections a background job copies: its own confirm shows the path to edit
    if (viaJob(src, dst)) return sendToPane(src, dst, items, mode, dst.prefix, c);
    // both panes in one place (or a folder into itself): say so instead of confirming a no-op
    if (src.here && dst.here.profileId === src.here.profileId && dst.bucket === src.bucket && !isValidDest(items, dst.prefix)) {
      const intoItself = items.some((e) => e.kind === "folder" && dst.prefix.startsWith(e.key));
      c.dialogs.toast(
        "info",
        intoItself ? `A folder can’t be ${mode === "copy" ? "copied" : "moved"} into itself.` : `${items.length === 1 ? "It’s" : "They’re"} already in this folder.`,
      );
      return;
    }
    const what = items.length === 1 ? `“${items[0].name}”` : `${items.length.toLocaleString()} items`;
    const where = dst.profile ? placeLabel(dst.profile.id, dst.bucket ?? "", dst.prefix) : (dst.bucketLabel ?? "");
    // between this computer and the cloud the originals always stay: a move there is a copy
    const asCopy = mode === "move" && crossesDisk(src, dst);
    if (asCopy) mode = "copy";
    const verb = mode === "copy" ? "Copy" : "Move";
    const ok = await c.dialogs.confirm({
      title: `${verb} ${what}?`,
      label: verb,
      message: createElement(
        "p",
        null,
        `${verb} to `,
        createElement("strong", null, where),
        asCopy ? `. Between ${ON_OS.here} and the cloud files are copied: the originals stay where they are.` : ".",
      ),
    });
    if (ok) {
      rememberSent(dst.here);
      await sendToPane(src, dst, items, mode, dst.prefix, c);
    }
  };

  /** The active pane and its other pane trade places (with two panes: the two of them). */
  const swap = () => {
    const c = get();
    const p = pane(c.activeId);
    const o = otherPane(c.activeId);
    if (!o) return;
    const [a, b] = [p.here, o.here];
    quietly(() => {
      if (b) goTo(p, b);
      if (a) goTo(o, a);
    });
  };

  /** Opens the folder of pane `id` (the active one by default) in the other pane too. */
  const sameFolderInOther = (id: PaneId = get().activeId) => {
    const src = pane(id);
    const dst = otherPane(id);
    if (src.here && dst) quietly(() => goTo(dst, src.here!));
  };

  const compare = () => {
    const c = get();
    const o = c.otherOf(c.activeId);
    if (!o) return;
    // the two in reading order: with two panes side by side, left and right as always
    const order = c.panes.map((p) => p.id);
    const [left, right] = order.indexOf(c.activeId) < order.indexOf(o) ? [pane(c.activeId), pane(o)] : [pane(o), pane(c.activeId)];
    const across = c.relation(left.id, right.id) === "down";
    if (!left.here || !right.here) {
      c.dialogs.toast("info", "Open a folder in both panes to compare them");
      return;
    }
    if (left.ent.search || right.ent.search) {
      c.dialogs.toast("info", "Clear the search to compare the folders");
      return;
    }
    const diff = compareFolders(left.ent.allEntries, right.ent.allEntries, { etags: etagsComparable(left.profile, right.profile) });
    const sel = diffSelection(diff);
    // a filter would hide some of what gets selected
    left.ent.setQuery("");
    right.ent.setQuery("");
    left.sel.setSelected(new Set(sel.left));
    right.sel.setSelected(new Set(sel.right));
    // F5 copies from the active pane: when only one side has something selected, that's the one
    const only: PaneId | null = sel.left.length && !sel.right.length ? left.id : sel.right.length && !sel.left.length ? right.id : null;
    if (only && only !== c.activeId) c.setActive(only);
    const partial = !!(left.ent.listing.next || right.ent.listing.next);
    c.dialogs.show((close) =>
      createElement(CompareSummary, {
        diff,
        leftName: placeName(left),
        rightName: placeName(right),
        leftAt: left.here,
        rightAt: right.here,
        sides: across ? ["top", "bottom"] : ["left", "right"],
        partial,
        onClose: () => {
          close();
          c.focusPane(only ?? get().activeId);
        },
      }),
    );
  };

  /** Tab: the next pane in reading order (with two panes, the other one). */
  const switchPane = () => {
    const c = get();
    if (!multi()) return false;
    const ids = c.panes.map((p) => p.id);
    const id = ids[(ids.indexOf(c.activeId) + 1) % ids.length];
    c.setActive(id);
    c.focusPane(id);
    return true;
  };

  /** What a pane gets on top of the shell's own environment (all of it inert in single-pane mode). */
  const envFor = (id: PaneId): Partial<PaneEnv> => ({
    onNavigated: (from, to) => follow(id, from, to),
    // swap, compare, "this folder in the other pane" and synchronized browsing: in the toolbar's
    // "…" (the shell adds them there) and the link on the divider, not in the folder menus
    extraPlaceItems: (): MenuItem[] => [],
    // Copy to ▸ / Move to ▸: open panes, recent places, favorites, and the folder picker
    extraItemItems: (list: Entry[]): (MenuItem | false)[] => [
      { type: "submenu", label: "Copy to", icon: "copy", items: () => targetItems(id, list, "copy") },
      { type: "submenu", label: "Move to", icon: "move", items: () => targetItems(id, list, "move") },
    ],
  });

  /** Commands that work with or without a bucket on screen; false = not handled (single pane). */
  const commands: Record<string, () => boolean | void> = {
    "switch-pane": switchPane,
    "swap-panes": () => (multi() ? swap() : false),
    "same-folder": () => (multi() ? sameFolderInOther() : false),
    "compare-folders": () => (multi() ? compare() : false),
    "pane-copy": () => void sendSelection("copy"),
    "pane-move": () => void sendSelection("move"),
  };

  return {
    envFor,
    commands,
    sameFolderInOther,
    swap,
    compare,
    /** moves panes without synchronized browsing following (another workspace coming up) */
    quietly,
    /** forgets which linked panes wait out of step (the workspace they belong to went away) */
    forgetBehind: () => behind.clear(),
  };
}
