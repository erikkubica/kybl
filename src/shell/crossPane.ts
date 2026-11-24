/**
 * Copying and moving between places: the two panes (F5 / F6, or dragging items onto the other
 * pane), ⌘V of items cut or copied in another connection, and drops on another connection's
 * bucket in the sidebar. The route depends on the two places:
 *
 * | from → to                     | route                                                     |
 * |-------------------------------|-----------------------------------------------------------|
 * | same connection (any bucket)  | move_many, with destBucket across buckets (clash + undo)   |
 * | this computer → cloud         | an upload of the files on disk (clash check)               |
 * | cloud → this computer         | a download into the destination folder                     |
 * | cloud → another cloud         | a background job (src/jobs), after a short confirm         |
 * | same connection, other root   | the same job when the connection can't copy across roots   |
 *
 * Between this computer and the cloud nothing is moved: the originals stay, so F6 there copies.
 */
import { api, errMessage, LOCAL_ID } from "../api";
import { busyOwner } from "../desktop/fileOps";
import { parentPrefix, plural } from "../format";
import { joinPath, safeRelPath } from "../desktop/paths";
import { eachFileUnder, ListingStopped } from "../streamFiles";
import { holdBatch } from "../transferLog";
import { downloadClashGate } from "../desktop/downloadClash";
import { findExistingLocal } from "../desktop/conflicts";
import type { Pane } from "../browser/usePane";
import type { FileOps } from "../desktop/fileOps";
import type { Entry } from "../types";
import type { TransferActions } from "../useTransfers";
import { peekCaps } from "../useCaps";
import type { Dialogs } from "./useDialogs";
import type { ConfirmMigration } from "./useMigrationHost";

/** Where a key of this computer's disk is (the root's own folder for ""). */
async function onDisk(root: string, key: string): Promise<string> {
  const p = await api.localPath(LOCAL_ID, root, key);
  if (!p) throw "That folder isn't on this computer any more.";
  return p;
}

/** Where items are or go: a connection and one of its roots. */
export type Place = { profileId: string; bucket: string };
/** A destination with the names to show for it (the confirm of a copy between connections). */
export type DestPlace = Place & { connectionName: string; rootName: string; singleRoot?: boolean };

/** One side is this computer's disk and the other a cloud: copies only (see above). */
export const crossesDiskAt = (a: Place, b: Place) => (a.profileId === LOCAL_ID) !== (b.profileId === LOCAL_ID);
/** One pane shows this computer's disk and the other a cloud: copies only (see above). */
export const crossesDisk = (a: Pane, b: Pane) => !!a.here && !!b.here && crossesDiskAt(a.here, b.here);

/**
 * Two clouds the server can't copy between: different connections, or roots of one connection
 * that only copies inside a root. These go through a background job (see above).
 */
export function viaJobAt(a: Place, b: Place): boolean {
  if (a.profileId === LOCAL_ID || b.profileId === LOCAL_ID) return false;
  if (a.profileId !== b.profileId) return true;
  // caps load with the pane; S3 (the default while they load) copies across buckets
  return a.bucket !== b.bucket && (peekCaps(a.profileId)?.serverCopy ?? "cross-root") !== "cross-root";
}
export const viaJob = (a: Pane, b: Pane) => !!a.here && !!b.here && viaJobAt(a.here, b.here);

export type CrossCtx = {
  dialogs: Dialogs;
  transfers: TransferActions;
  autoShowActivity: () => void;
  /** refreshes the panes showing this place */
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  /**
   * The busy-line writer of a pane showing this place, if one is on screen: a listing that runs
   * before any file is found says so there (as a download from the pane itself does).
   */
  busyFor?: (profileId: string, bucket: string) => Pane["setBusy"] | undefined;
  /** the quick confirm that starts a job between connections */
  confirmMigration?: ConfirmMigration;
};

export async function sendToPane(src: Pane, dst: Pane, items: Entry[], mode: "copy" | "move", dest: string, c: CrossCtx) {
  const a = src.here;
  const b = dst.here;
  if (!a || !b || !items.length) return;
  await sendItems(src.ops, a, items, mode, { ...b, connectionName: dst.profile?.name ?? "", rootName: dst.bucketLabel ?? b.bucket, singleRoot: peekCaps(b.profileId)?.roots === "single" }, dest, c);
}

/**
 * Copies or moves items from `a` into folder `dest` of `b`, by whichever route the two places
 * need (the table above). `srcOps` are the file actions of a pane showing `a`. `onStarted` runs
 * once the work was started (not when a confirm was cancelled): a cut is used up then.
 */
export async function sendItems(
  srcOps: FileOps,
  a: Place,
  items: Entry[],
  mode: "copy" | "move",
  b: DestPlace,
  dest: string,
  c: CrossCtx,
  onStarted?: () => void,
): Promise<void> {
  if (!items.length) return;
  const fromLocal = a.profileId === LOCAL_ID;
  const toLocal = b.profileId === LOCAL_ID;
  if (viaJobAt(a, b)) {
    if (!c.confirmMigration || !b.connectionName) {
      c.dialogs.toast("info", "Copying between these connections isn't available here");
      return;
    }
    c.confirmMigration(
      {
        profileId: a.profileId,
        root: a.bucket,
        items: items.map((e) => ({ path: e.key, isDir: e.kind === "folder", size: e.kind === "folder" ? undefined : e.size })),
      },
      mode,
      { profileId: b.profileId, root: b.bucket, dir: dest, connectionName: b.connectionName, rootName: b.rootName },
      b.singleRoot,
      onStarted,
    );
    return;
  }
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
    if (await srcOps.uploadPaths(paths, dest, b)) onStarted?.();
    return;
  } else if (toLocal) {
    let dir: string;
    try {
      dir = await onDisk(b.bucket, dest);
    } catch (e) {
      c.dialogs.toast("error", errMessage(e));
      return;
    }
    if (await downloadInto(a, items, dir, c, b, () => c.reloadIfShowing(b.profileId, b.bucket))) onStarted?.();
    return;
  }
  if (await srcOps.relocate(items, dest, mode, { srcBucket: a.bucket, destBucket: b.bucket })) onStarted?.();
}

/**
 * Cloud → this computer: every file (folders listed as they go) into `dir`, keeping folder
 * structure. Files start downloading as they are found, so a big folder on a slow server doesn't
 * sit silent while it is listed. A file already there is asked about (Replace, Keep both, Skip;
 * "all" covers the files found later). `done` runs once all ended. True when downloads were started.
 */
async function downloadInto(src: Place, items: Entry[], dir: string, c: CrossCtx, dest: Place, done: () => void): Promise<boolean> {
  const { profileId, bucket } = src;
  const ids: string[] = [];
  const item = (key: string, size: number, rel: string) => {
    const safe = safeRelPath(rel);
    return safe ? [{ kind: "download" as const, name: safe, profileId, bucket, key, local: joinPath(dir, safe), total: size, base: dir }] : [];
  };
  const begin = (batch: Parameters<TransferActions["add"]>[0]) => {
    if (!batch.length) return;
    if (!ids.length) c.autoShowActivity();
    for (const t of c.transfers.add(batch)) ids.push(t.id);
  };
  let stopped = false;
  let stopNow: (() => void) | null = null;
  // the listing shows on the busy line of the folder it lands in (the source pane if that isn't
  // on screen), where Stop sits next to the count; the toast only carries Stop without one
  const setBusy = c.busyFor?.(dest.profileId, dest.bucket) ?? c.busyFor?.(profileId, bucket);
  const mine = Symbol();
  let listing = true;
  // the line is ours to paint when we hold it or nobody does (another writer finished)
  const mayPaint = () => {
    if (!setBusy) return false;
    const o = busyOwner.get(setBusy);
    return listing && (o === mine || o === undefined);
  };
  const gate = downloadClashGate({
    ask: c.dialogs.resolveConflicts,
    exists: findExistingLocal,
    where: dir,
    start: begin,
    // closing the question calls the rest off
    onCancel: () => {
      stopped = true;
      stopNow?.();
    },
  });
  const start = (batch: Parameters<TransferActions["add"]>[0]) => gate.add(batch);
  const folders = items.filter((e) => e.kind !== "file");
  start(items.filter((e) => e.kind === "file").flatMap((e) => item(e.key, e.size, e.name)));
  if (folders.length) {
    const what = folders.length === 1 ? `Copying “${folders[0].name}”` : `Copying ${folders.length} folders`;
    c.dialogs.toast(
      "info",
      `${what} here. Files start as they're found.`,
      // always offered: a newer listing can take the busy line from this one, and then its Stop is gone
      {
        label: "Stop listing",
        run: () => {
          stopped = true;
          stopNow?.();
        },
      },
    );
  }
  let failed: string | null = null;
  let failures = 0;
  for (const [i, e] of folders.entries()) {
    if (stopped) break;
    const base = parentPrefix(e.key);
    let found = 0;
    const stop = () => {
      stopped = true;
      run.stop();
    };
    const run = eachFileUnder(profileId, bucket, e.key, (files) => {
      found += files.length;
      start(files.flatMap((f) => item(f.key, f.size, f.key.slice(base.length))));
      if (mayPaint()) setBusy!(`Listing ${e.name}… ${plural(found, "file")} found`, stop, mine);
    });
    stopNow = run.stop;
    if (setBusy && (i === 0 || mayPaint())) setBusy(`Listing ${e.name}…`, stop, mine);
    // the Activity log keeps this download as one while files are still being found
    const release = holdBatch(profileId, bucket, dir);
    try {
      await run.done;
    } catch (err) {
      if (err instanceof ListingStopped) {
        // by "Stop listing" or Cancel all: either way nothing to announce
        stopped = true;
        break;
      }
      // one folder that can't be listed doesn't stop the others; it is said once at the end
      failures++;
      failed = `Couldn't list “${e.name}”: ${errMessage(err)}`;
    } finally {
      release();
    }
  }
  gate.end();
  await gate.settled();
  stopNow = null;
  listing = false;
  if (setBusy && busyOwner.get(setBusy) === mine) setBusy(null);
  if (gate.cancelled) {
    if (ids.length) c.dialogs.toast("info", "Stopped. The files already started keep copying.");
    return ids.length > 0;
  }
  if (failed) {
    const more = failures > 1 ? ` (${failures} of ${folders.length} folders couldn't be listed)` : "";
    c.dialogs.toast("error", ids.length ? `${failed}${more}. The files found so far are copying.` : `${failed}${more}`);
  }
  if (!ids.length && failed) return false;
  if (!ids.length) {
    if (gate.skipped) c.dialogs.toast("info", `Skipped ${gate.skipped.toLocaleString()} ${gate.skipped === 1 ? "file" : "files"} that ${gate.skipped === 1 ? "was" : "were"} already there`);
    else if (!stopped) c.dialogs.toast("info", "Nothing to copy");
    return false;
  }
  void Promise.all(ids.map((id) => c.transfers.whenFinished(id))).then(done);
  return true;
}
