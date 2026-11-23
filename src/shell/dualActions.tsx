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
import { parentPrefix } from "../format";
import { destLabel, isValidDest, placeLabel } from "../moving";
import type { MenuItem } from "../components/Dialogs";
import type { Settings } from "../settings";
import type { Entry, Profile } from "../types";
import type { TransferActions } from "../useTransfers";
import type { Pane, PaneEnv } from "../browser/usePane";
import type { Loc, PaneId } from "../browser/types";
import { compareFolders, diffSelection } from "../compare/compareFolders";
import { CompareSummary } from "../compare/CompareSummary";
import { crossesDisk, sendToPane, viaJob } from "./crossPane";
import type { Dialogs } from "./useDialogs";
import type { ConfirmMigration } from "./useMigrationHost";

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
  /** F5 / F6 between connections: the job's quick confirm (destination editable) */
  confirmMigration?: ConfirmMigration;
};

const placeName = (p: Pane) => (p.prefix && p.profile ? destLabel(p.prefix, p.bucket ?? "", p.profile.id) : (p.bucketLabel ?? ""));

export const paneName = placeName;

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

  /** F5 / F6: the selection (or the item under the cursor) to the other pane's folder, after a confirm. */
  const sendSelection = async (mode: "copy" | "move") => {
    const c = get();
    const src = pane(c.activeId);
    const dst = otherPane(c.activeId);
    let items = src.sel.selectedEntries;
    if (!items.length && src.sel.cursor.current) items = src.ent.entries.filter((e) => e.key === src.sel.cursor.current);
    if (!items.length) {
      c.dialogs.toast("info", `Select what to ${mode} first`);
      return;
    }
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
        asCopy ? ". Between this Mac and the cloud files are copied: the originals stay where they are." : ".",
      ),
    });
    if (ok) await sendToPane(src, dst, items, mode, dst.prefix, c);
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
    const diff = compareFolders(left.ent.allEntries, right.ent.allEntries);
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
    dropOnOtherPane: (items: Entry[], target: PaneId, dest: string, copy: boolean) => void sendToPane(pane(id), pane(target), items, copy ? "copy" : "move", dest, get()),
    otherPaneTarget: (target: PaneId, dest: string | null, items: Entry[]) => {
      const src = pane(id);
      const dst = pane(target);
      if (!multi() || !dst.here || !src.here) return null;
      const d = dest ?? dst.prefix;
      if (dst.here.profileId === src.here.profileId && dst.bucket === src.bucket && !isValidDest(items, d)) return null;
      return { dest: d, label: d && dst.profile ? destLabel(d, dst.bucket ?? "", dst.profile.id) : (dst.bucketLabel ?? ""), copyOnly: crossesDisk(src, dst) };
    },
    // swap, compare, "this folder in the other pane" and synchronized browsing: in the toolbar's
    // "…" (the shell adds them there) and the link on the divider, not in the folder menus
    extraPlaceItems: (): MenuItem[] => [],
    extraItemItems: (list: Entry[]): (MenuItem | false)[] => {
      const dst = otherPane(id);
      if (!multi() || !dst?.here) return [];
      const src = pane(id);
      const where = placeName(dst) || "the other pane";
      const run = (mode: "copy" | "move") => void sendToPane(src, dst, list, mode, dst.prefix, get());
      // both panes show the same folder (or a folder would go into itself): nothing to do there
      const noop = !!src.here && src.here.profileId === dst.here.profileId && src.bucket === dst.bucket && !isValidDest(list, dst.prefix);
      return [
        { type: "item", label: `Copy to “${where}”`, icon: "copy", hint: "F5", disabled: noop, onClick: () => run("copy") },
        // this computer and the cloud only copy to each other
        !crossesDisk(src, dst) && { type: "item", label: `Move to “${where}”`, icon: "move", hint: "F6", disabled: noop, onClick: () => run("move") },
      ];
    },
  });

  /** Commands that work with or without a bucket on screen; false = not handled (single pane). */
  const commands: Record<string, () => boolean | void> = {
    "switch-pane": switchPane,
    "swap-panes": () => (multi() ? swap() : false),
    "same-folder": () => (multi() ? sameFolderInOther() : false),
    "compare-folders": () => (multi() ? compare() : false),
    "pane-copy": () => (multi() ? void sendSelection("copy") : false),
    "pane-move": () => (multi() ? void sendSelection("move") : false),
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
