/**
 * Copying and moving between the two panes (F5 / F6, or dragging items onto the other pane).
 * The route depends on what the panes show:
 *
 * | from → to                     | route                                                     |
 * |-------------------------------|-----------------------------------------------------------|
 * | same connection (any bucket)  | move_many, with destBucket across buckets (clash + undo)   |
 * | this computer → cloud         | an upload of the files on disk (clash check)               |
 * | cloud → this computer         | a download into the pane's folder                          |
 * | cloud → another cloud         | the migration job (package B); "coming soon" until then    |
 *
 * Between this computer and the cloud nothing is moved: the originals stay, so F6 there copies.
 */
import { api, errMessage, LOCAL_ID } from "../api";
import { parentPrefix } from "../format";
import { joinPath, safeRelPath } from "../desktop/paths";
import type { Pane } from "../browser/usePane";
import type { Entry } from "../types";
import type { TransferActions } from "../useTransfers";
import type { Dialogs } from "./useDialogs";

/** Where a key of this computer's disk is (the root's own folder for ""). */
async function onDisk(root: string, key: string): Promise<string> {
  const p = await api.localPath(LOCAL_ID, root, key);
  if (!p) throw "That folder isn't on this computer any more.";
  return p;
}

/** One pane shows this computer's disk and the other a cloud: copies only (see above). */
export const crossesDisk = (a: Pane, b: Pane) => !!a.here && !!b.here && (a.here.profileId === LOCAL_ID) !== (b.here.profileId === LOCAL_ID);

type Ctx = {
  dialogs: Dialogs;
  transfers: TransferActions;
  autoShowActivity: () => void;
  /** refreshes the panes showing this place */
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
};

export async function sendToPane(src: Pane, dst: Pane, items: Entry[], mode: "copy" | "move", dest: string, c: Ctx) {
  const a = src.here;
  const b = dst.here;
  if (!a || !b || !items.length) return;
  const fromLocal = a.profileId === LOCAL_ID;
  const toLocal = b.profileId === LOCAL_ID;
  if (fromLocal && toLocal) {
    // both on this computer: the Local provider does it like any connection
  } else if (fromLocal) {
    // the originals stay on this computer: uploads of the files (folders with what is in them)
    let paths: string[];
    try {
      paths = await Promise.all(items.map((e) => onDisk(a.bucket, e.key.replace(/\/$/, ""))));
    } catch (e) {
      c.dialogs.toast("error", errMessage(e));
      return;
    }
    await dst.ops.uploadPaths(paths, dest);
    return;
  } else if (toLocal) {
    let dir: string;
    try {
      dir = await onDisk(b.bucket, dest);
    } catch (e) {
      c.dialogs.toast("error", errMessage(e));
      return;
    }
    await downloadInto(src, items, dir, c, () => c.reloadIfShowing(b.profileId, b.bucket));
    return;
  } else if (a.profileId !== b.profileId) {
    c.dialogs.toast("info", "Copying between connections is coming soon");
    return;
  }
  await src.ops.relocate(items, dest, mode, { destBucket: b.bucket });
}

/**
 * Cloud → this computer: every file (folders listed in full) into `dir`, keeping folder structure.
 * A file already there is kept and the copy gets a free name, like Finder. `done` runs once all ended.
 */
async function downloadInto(src: Pane, items: Entry[], dir: string, c: Ctx, done: () => void) {
  const { profile, bucket } = src;
  if (!profile || bucket == null) return;
  const out: Parameters<TransferActions["add"]>[0] = [];
  const add = (key: string, size: number, rel: string) => {
    const safe = safeRelPath(rel);
    if (safe) out.push({ kind: "download", name: safe, profileId: profile.id, bucket, key, local: joinPath(dir, safe), total: size });
  };
  try {
    for (const e of items) {
      if (e.kind === "file") add(e.key, e.size, e.name);
      else {
        const base = parentPrefix(e.key);
        for (const f of await api.listAllUnder(profile.id, bucket, e.key)) add(f.key, f.size, f.key.slice(base.length));
      }
    }
  } catch (e) {
    c.dialogs.toast("error", errMessage(e));
    return;
  }
  if (!out.length) {
    c.dialogs.toast("info", "Nothing to copy");
    return;
  }
  const started = c.transfers.add(out);
  c.autoShowActivity();
  void Promise.all(started.map((t) => c.transfers.whenFinished(t.id))).then(done);
}
