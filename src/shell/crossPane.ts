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
 */
import { api, errMessage } from "../api";
import { parentPrefix } from "../format";
import { joinPath, safeRelPath } from "../desktop/paths";
import { LOCAL_PROFILE } from "../browser/types";
import type { Pane } from "../browser/usePane";
import type { Entry } from "../types";
import type { TransferActions } from "../useTransfers";
import type { Dialogs } from "./useDialogs";

/**
 * Local provider seam: where an item of a Local pane is on disk. Assumes the root id is the
 * absolute path of the root folder (as WP0's `list_roots` plans for "local") and keys are paths
 * below it with "/" separators.
 */
export const localPath = (root: string, key: string) => (key ? joinPath(root, key) : root);

type Ctx = { dialogs: Dialogs; transfers: TransferActions; autoShowActivity: () => void };

export async function sendToPane(src: Pane, dst: Pane, items: Entry[], mode: "copy" | "move", dest: string, c: Ctx) {
  const a = src.here;
  const b = dst.here;
  if (!a || !b || !items.length) return;
  const fromLocal = a.profileId === LOCAL_PROFILE;
  const toLocal = b.profileId === LOCAL_PROFILE;
  if (fromLocal && toLocal) {
    // both on this computer: the Local provider does it like any connection
  } else if (fromLocal) {
    // the originals stay on this computer: a move from disk uploads copies
    await dst.ops.uploadPaths(
      items.map((e) => localPath(a.bucket, e.key.replace(/\/$/, ""))),
      dest,
    );
    return;
  } else if (toLocal) {
    await downloadInto(src, items, localPath(b.bucket, dest), c);
    return;
  } else if (a.profileId !== b.profileId) {
    c.dialogs.toast("info", "Copying between connections is coming soon");
    return;
  }
  await src.ops.relocate(items, dest, mode, { destBucket: b.bucket });
}

/** Cloud → this computer: every file (folders listed in full) into `dir`, keeping folder structure. */
async function downloadInto(src: Pane, items: Entry[], dir: string, c: Ctx) {
  const { profile, bucket } = src;
  if (!profile || !bucket) return;
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
  c.transfers.add(out);
  c.autoShowActivity();
}
