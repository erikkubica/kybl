/**
 * Dual pane behaviour that spans both panes: switching the active pane, copy / move to the other
 * pane (F5 / F6 and drag), swapping them, opening the same folder in both, synchronized browsing
 * and Compare folders. Made once by the shell; it reads the current panes through `get`, so the
 * callbacks it hands to the panes never go stale.
 */
import { createElement } from "react";
import { parentPrefix } from "../format";
import { destLabel, isValidDest } from "../moving";
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
  left: Pane;
  right: Pane;
  dual: boolean;
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

const otherId = (id: PaneId): PaneId => (id === "left" ? "right" : "left");
const placeName = (p: Pane) => (p.prefix ? destLabel(p.prefix, p.bucket ?? "") : (p.bucketLabel ?? ""));

export function makeDualActions(get: () => DualContext) {
  const pane = (id: PaneId) => (id === "left" ? get().left : get().right);
  // a pane following the other must not make the other follow it back
  let following = false;

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

  /** Synchronized browsing: into a subfolder, or up a level, when the other pane can do the same. */
  const follow = (id: PaneId, from: Loc | null, to: Loc) => {
    const c = get();
    if (following || !c.dual || !c.settings.syncBrowsing || !from || from.profileId !== to.profileId || from.bucket !== to.bucket) return;
    const o = pane(otherId(id));
    if (!o.here || o.ent.search) return;
    if (to.prefix.startsWith(from.prefix) && to.prefix !== from.prefix) {
      const sub = to.prefix.slice(from.prefix.length);
      const target = o.prefix + sub;
      // only a direct subfolder that the other pane has listed
      if (sub.indexOf("/") === sub.length - 1 && o.ent.fresh && o.ent.listing.folders.includes(target)) quietly(() => o.navigate(target));
    } else if (from.prefix.startsWith(to.prefix) && from.prefix !== to.prefix) {
      const gone = from.prefix.slice(to.prefix.length);
      if (gone.indexOf("/") === gone.length - 1 && o.prefix.endsWith(gone)) quietly(() => o.navigate(parentPrefix(o.prefix)));
    }
  };

  /** F5 / F6: the selection (or the item under the cursor) to the other pane's folder, after a confirm. */
  const sendSelection = async (mode: "copy" | "move") => {
    const c = get();
    const src = pane(c.activeId);
    const dst = pane(otherId(c.activeId));
    let items = src.sel.selectedEntries;
    if (!items.length && src.sel.cursor.current) items = src.ent.entries.filter((e) => e.key === src.sel.cursor.current);
    if (!items.length) {
      c.dialogs.toast("info", `Select what to ${mode} first`);
      return;
    }
    if (!dst.here) {
      c.dialogs.toast("info", "Open a folder in the other pane first");
      return;
    }
    // between connections a background job copies: its own confirm shows the path to edit
    if (viaJob(src, dst)) return sendToPane(src, dst, items, mode, dst.prefix, c);
    const what = items.length === 1 ? `“${items[0].name}”` : `${items.length.toLocaleString()} items`;
    const where = `${dst.bucketLabel}/${dst.prefix}`.replace(/\/$/, "");
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

  const swap = () => {
    const c = get();
    const [a, b] = [c.left.here, c.right.here];
    quietly(() => {
      if (b) goTo(c.left, b);
      if (a) goTo(c.right, a);
    });
  };

  /** Opens the folder of pane `id` (the active one by default) in the other pane too. */
  const sameFolderInOther = (id: PaneId = get().activeId) => {
    const src = pane(id);
    if (src.here) quietly(() => goTo(pane(otherId(id)), src.here!));
  };

  const compare = () => {
    const c = get();
    const { left, right } = c;
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
    const partial = !!(left.ent.listing.next || right.ent.listing.next);
    c.dialogs.show((close) => createElement(CompareSummary, { diff, leftName: placeName(left), rightName: placeName(right), partial, onClose: close }));
  };

  const switchPane = () => {
    const c = get();
    if (!c.dual) return false;
    const id = otherId(c.activeId);
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
      if (!get().dual || !dst.here || !src.here) return null;
      const d = dest ?? dst.prefix;
      if (dst.here.profileId === src.here.profileId && dst.bucket === src.bucket && !isValidDest(items, d)) return null;
      return { dest: d, label: d ? destLabel(d, dst.bucket ?? "") : (dst.bucketLabel ?? ""), copyOnly: crossesDisk(src, dst) };
    },
    extraPlaceItems: (): MenuItem[] => {
      const c = get();
      if (!c.dual) return [];
      return [
        { type: "sep" },
        { type: "item", label: "Same folder in the other pane", icon: "dual-pane", onClick: () => sameFolderInOther(id) },
        { type: "item", label: "Compare with the other pane", icon: "columns", onClick: compare },
        { type: "item", label: "Swap panes", icon: "move", hint: "⇧⌘S", onClick: swap },
        { type: "item", label: "Synchronized browsing", icon: "sync", checked: c.settings.syncBrowsing, onClick: () => c.updateSettings({ syncBrowsing: !c.settings.syncBrowsing }) },
      ];
    },
    extraItemItems: (list: Entry[]): (MenuItem | false)[] => {
      const c = get();
      const dst = pane(otherId(id));
      if (!c.dual || !dst.here) return [];
      const where = placeName(dst) || "the other pane";
      const run = (mode: "copy" | "move") => void sendToPane(pane(id), dst, list, mode, dst.prefix, get());
      return [
        { type: "item", label: `Copy to “${where}”`, icon: "copy", hint: "F5", onClick: () => run("copy") },
        // this computer and the cloud only copy to each other
        !crossesDisk(pane(id), dst) && { type: "item", label: `Move to “${where}”`, icon: "move", hint: "F6", onClick: () => run("move") },
      ];
    },
  });

  /** Commands that work with or without a bucket on screen; false = not handled (single pane). */
  const commands: Record<string, () => boolean | void> = {
    "toggle-dual": () => {
      const c = get();
      c.updateSettings({ layout: c.dual ? "single" : "dual" });
    },
    "switch-pane": switchPane,
    "swap-panes": () => (get().dual ? swap() : false),
    "same-folder": () => (get().dual ? sameFolderInOther() : false),
    "compare-folders": () => (get().dual ? compare() : false),
    "pane-copy": () => (get().dual ? void sendSelection("copy") : false),
    "pane-move": () => (get().dual ? void sendSelection("move") : false),
  };

  return { envFor, commands };
}
