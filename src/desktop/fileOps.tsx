/**
 * What the desktop file browser does to objects: upload, download, open, delete, rename, new
 * folder, move/copy (also to other buckets of the connection) and paste. Every action that writes
 * names checks for clashes first, and moves, renames and copies that can be reversed safely leave
 * an Undo behind.
 */
import { keys } from "../components/osText";
import { NO_EXPORT, asExport, exportable } from "../connections/native";
import { peekCaps } from "../useCaps";
import type { ReactNode } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, errMessage } from "../api";
import { formatBytes, parentPrefix, sumSizes } from "../format";
import { destKey, entryParent, placeLabel } from "../moving";
import type { Settings } from "../settings";
import type { Entry, LocalFile, Profile } from "../types";
import type { Toast } from "../components/Dialogs";
import type { TransferActions } from "../useTransfers";
import type { useJobs } from "../useJobs";
import { applyChoices, findExisting, freeKeys, type Choice, type Clash } from "./conflicts";
import { copyName, joinPath, numberedName, safeRelPath, shortHash } from "./paths";
import { undoStack, type UndoEntry } from "./undo";
import { itemClipboard } from "./clipboard";
import { crossesDiskAt, viaJobAt, type Place } from "../shell/crossPane";
import { localCopies, type LocalCopyVerb } from "../localCopyProgress";
import { parentOf, renameRounds } from "../batchRename";
import { BatchRenameDialog } from "./BatchRenameDialog";
import { okToRun as askToRun, openIn } from "./openGuard";

export type ToastAction = NonNullable<Toast["action"]>;

export type OpsContext = {
  profile: Profile | null;
  bucket: string | null;
  prefix: string;
  /** names of the folders in the listing on screen (for a free "New folder" name) */
  folderKeys: Set<string>;
  settings: Settings;
  transfers: TransferActions;
  jobs: ReturnType<typeof useJobs>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  /** opens the Activity panel if Settings say so (a transfer or job just started) */
  autoShowActivity: () => void;
  /** opens the Activity panel */
  showActivity: () => void;
  showFailed?: () => void;
  setBusy: (text: string | null) => void;
  confirm: (o: { title: string; message: ReactNode; label: string; danger?: boolean }) => Promise<boolean>;
  prompt: (o: { title: string; label: string; initial: string; confirmLabel: string; note?: string; run: (v: string) => void }) => void;
  /** shows a dialog of its own (the Batch rename dialog) */
  show?: (render: (close: () => void) => ReactNode) => void;
  resolveConflicts: (clashes: Clash[], verb: string, where: string) => Promise<Map<string, Choice> | null>;
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  /** select this key once the listing on screen has reloaded (if it is still that place) */
  selectAfterReload: (profileId: string, bucket: string, key: string | null) => void;
  deselect: (keys: string[]) => void;
  clearSizes: () => void;
  /** a new item should show: leaves deep-search mode (which wouldn't list it) */
  leaveSearch?: () => void;
  /** folders were renamed, moved (to: the new prefix, maybe in `toBucket`) or deleted (to: null): favorites follow */
  foldersChanged?: (profileId: string, fromBucket: string, toBucket: string, moves: { from: string; to: string | null }[]) => void;
  /** the connection's files are this computer's own (open them in place, no temp download) */
  localPaths?: boolean;
  /**
   * Copies or moves items from another place into folder `dest` of `dst` by whichever route the
   * two need (shell/crossPane.ts: a job between connections, an upload, a download…). `onStarted`
   * runs once the work started.
   */
  sendItems?: (src: Place, items: Entry[], mode: "copy" | "move", dst: Place, dest: string, onStarted?: () => void) => void;
};

/** Undo of a copy deletes the copied objects; past this many it asks first. */
const UNDO_CONFIRM_OVER = 100;

import { plural } from "../format";
const whatOf = (list: { name: string }[]) => (list.length === 1 ? `“${list[0].name}”` : plural(list.length, "item"));

export function makeFileOps(c: OpsContext) {
  const { transfers, jobs, toast } = c;
  // only failures carry it: the panel opens on its Failed tab
  const showAction: ToastAction = { label: "Show", run: c.showFailed ?? c.showActivity };

  /**
   * Which targets already exist. If the check itself fails (keys that may write but not list),
   * the user decides whether to go ahead without it; null = stop.
   */
  const existing = async (pid: string, b: string, targets: { key: string; folder: boolean }[]): Promise<Set<string> | null> => {
    if (!targets.length) return new Set();
    c.setBusy("Checking for items with the same names…");
    try {
      return await findExisting(pid, b, targets);
    } catch (e) {
      c.setBusy(null);
      const go = await c.confirm({
        title: "Couldn’t check for existing items",
        message: (
          <>
            <p>Kybl couldn’t look for items with the same names, so anything that already exists may be replaced.</p>
            <p className="hint">{errMessage(e).split("\n\n")[0]}</p>
          </>
        ),
        label: "Continue anyway",
      });
      return go ? new Set() : null;
    } finally {
      c.setBusy(null);
    }
  };

  /** Turns clashes into a destination per key (null = skip), asking the user. null = cancelled. */
  const decide = async (
    pid: string,
    b: string,
    clashes: Clash[],
    verb: string,
    where: string,
    auto: Map<string, Choice> = new Map(),
    /** keys this batch writes anyway: "Keep both" must not pick one of them */
    reserved: Set<string> = new Set(),
  ) => {
    const ask = clashes.filter((x) => !auto.has(x.key));
    const choices = await c.resolveConflicts(ask, verb, where);
    if (!choices) return null;
    for (const [k, v] of auto) choices.set(k, v);
    c.setBusy(choices.size ? "Finding free names…" : null);
    try {
      for (const [k, v] of choices) if (v === "replace") reserved.add(k);
      return { dest: await applyChoices(pid, b, choices, reserved), replaced: [...choices.values()].includes("replace") };
    } finally {
      c.setBusy(null);
    }
  };

  // ---------------------------------------------------------------- upload
  /** Uploads files and folders into `dest` (of `at`, or the place on screen). True when uploads started. */
  const uploadPaths = async (paths: string[], dest = c.prefix, at?: { profileId: string; bucket: string }): Promise<boolean> => {
    const pid = at?.profileId ?? c.profile?.id;
    const bucket = at ? at.bucket : c.bucket;
    if (!pid || bucket == null || paths.length === 0) return false;
    try {
      c.setBusy("Reading the files…");
      let files: LocalFile[];
      try {
        files = await api.expandPaths(paths);
      } finally {
        c.setBusy(null);
      }
      if (files.length === 0) {
        toast("info", "Nothing to upload");
        return false;
      }
      // what lands directly in `dest`: single files, or the top folder of a dropped folder
      const groups = new Map<string, { folder: boolean; files: { f: LocalFile; rest: string }[] }>();
      // files from different places can share a name (Finder search results), and so can picked
      // folders: later ones get a number, as "Keep both" would, instead of overwriting each other
      const originOf = new Map<string, string>(); // top in the batch -> where on disk it came from
      for (const f of files) {
        const rel = safeRelPath(f.rel.replace(/\\/g, "/"));
        if (!rel) continue;
        const cut = rel.indexOf("/");
        let top = cut < 0 ? rel : rel.slice(0, cut + 1);
        const local = f.path.replace(/\\/g, "/");
        const origin = cut < 0 ? local : local.slice(0, local.length - rel.length + cut);
        for (let n = 1; originOf.has(top) && (cut < 0 || originOf.get(top) !== origin); n++) {
          const base = cut < 0 ? rel : rel.slice(0, cut + 1);
          top = numberedName(base, n);
        }
        originOf.set(top, origin);
        const g = groups.get(top) ?? { folder: cut >= 0, files: [] };
        g.files.push({ f, rest: cut < 0 ? "" : rel.slice(cut + 1) });
        groups.set(top, g);
      }
      const targets = [...groups].map(([top, g]) => ({ key: dest + top, folder: g.folder }));
      const found = await existing(pid, bucket, targets);
      if (!found) return false;
      const clashes = targets.filter((t) => found.has(t.key)).map((t) => ({ key: t.key, folder: t.folder, name: t.key.slice(dest.length).replace(/\/$/, "") }));
      const reserved = new Set(targets.filter((t) => !found.has(t.key)).map((t) => t.key));
      const d = await decide(pid, bucket, clashes, "Uploading", placeLabel(pid, bucket, dest), new Map(), reserved);
      if (!d) return false;
      const items: Parameters<TransferActions["add"]>[0] = [];
      for (const [top, g] of groups) {
        const key = dest + top;
        const to = d.dest.has(key) ? d.dest.get(key)! : key;
        if (to === null) continue;
        for (const { f, rest } of g.files) {
          const k = g.folder ? to + rest : to;
          items.push({ kind: "upload", name: k.slice(dest.length), profileId: pid, bucket, key: k, local: f.path, total: f.size });
        }
      }
      if (!items.length) {
        toast("info", "Nothing to upload: everything was skipped");
        return false;
      }
      transfers.add(items);
      c.autoShowActivity();
      return true;
    } catch (e) {
      toast("error", errMessage(e));
      return false;
    }
  };

  const pickAndUpload = async (directory: boolean) => {
    const r = await openDialog({ multiple: true, directory, title: directory ? "Choose folders to upload" : "Choose files to upload" });
    await uploadPaths(Array.isArray(r) ? r : r ? [r] : []);
  };

  // ---------------------------------------------------------------- download / open
  /**
   * Downloads files and folders. `relBase` (search results) keeps each file's folders below that
   * prefix, so two "report.pdf" from different folders never land on the same local file.
   */
  const downloadEntries = async (picked: Entry[], relBase: string | null = null) => {
    const { profile, bucket, settings } = c;
    if (!profile || bucket == null || picked.length === 0) return;
    // Google Docs and friends download as their export ("Budget.xlsx")
    const { list, skipped } = exportable(picked);
    if (skipped) toast("info", NO_EXPORT);
    if (!list.length) return;
    const pid = profile.id;
    try {
      if (list.length === 1 && list[0].kind === "file" && relBase === null) {
        const f = list[0];
        let local: string;
        let overwrite = false;
        if (settings.downloadAsk) {
          const picked = await saveDialog({ defaultPath: f.name, title: "Save as" });
          if (!picked) return;
          // the Save dialog already asked about replacing an existing file
          local = picked;
          overwrite = true;
        } else {
          local = joinPath(await api.downloadFolder(), safeRelPath(f.name) || "download");
        }
        transfers.add([{ kind: "download", name: f.name, profileId: pid, bucket, key: f.key, local, total: f.size, overwrite, etag: f.etag }]);
        c.autoShowActivity();
        if (!settings.downloadAsk) toast("info", `Downloading “${f.name}” to your Downloads folder`);
        return;
      }
      const dir = settings.downloadAsk
        ? ((r) => (Array.isArray(r) ? r[0] : r))(await openDialog({ directory: true, multiple: false, title: "Choose a download folder" }))
        : await api.downloadFolder();
      if (!dir) return;
      const items: Parameters<TransferActions["add"]>[0] = [];
      const add = (key: string, size: number, rel: string, etag?: string | null) => {
        const safe = safeRelPath(rel);
        if (safe) items.push({ kind: "download", name: safe, profileId: pid, bucket, key, local: joinPath(dir, safe), total: size, etag });
      };
      for (const e of list) {
        if (e.kind === "file") {
          add(e.key, e.size, relBase !== null && e.key.startsWith(relBase) ? e.key.slice(relBase.length) : e.name, e.etag);
        } else {
          c.setBusy(`Listing ${e.name}…`);
          const base = relBase !== null && e.key.startsWith(relBase) ? relBase : parentPrefix(e.key);
          for (const rf of await api.listAllUnder(pid, bucket, e.key)) add(rf.key, rf.size, rf.key.slice(base.length));
        }
      }
      c.setBusy(null);
      if (items.length === 0) {
        toast("info", "Nothing to download");
        return;
      }
      transfers.add(items);
      c.autoShowActivity();
      toast("info", `Downloading ${plural(items.length, "file")} to ${settings.downloadAsk ? dir : "your Downloads folder"}`);
    } catch (e) {
      c.setBusy(null);
      toast("error", errMessage(e));
    }
  };

  /**
   * A file of this computer: where it is. Anything else: a copy in Kybl's temporary folder, made
   * from the file cache when a preview, download or open already fetched this version (the
   * listing's ETag finds it without asking the server), else downloaded. Null when it failed
   * (already said so).
   */
  const localCopy = async (picked: Entry, verb: LocalCopyVerb): Promise<string | null> => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || picked.kind !== "file") return null;
    const e = asExport(picked);
    if (!e) {
      toast("info", NO_EXPORT);
      return null;
    }
    const pid = profile.id;
    try {
      if (c.localPaths) {
        const path = await api.localPath(pid, bucket, e.key);
        if (path) return path;
      }
      // the Copy / Open buttons show the progress (see localCopyProgress.ts)
      localCopies.start(pid, bucket, picked.key, verb);
      const tmp = await api.tempFolder();
      const local = joinPath(tmp, `${shortHash(`${pid}\n${bucket}\n${e.key}`)}/${safeRelPath(e.name) || "file"}`);
      const [t] = transfers.add([
        { kind: "download", name: e.name, profileId: pid, bucket, key: e.key, local, total: e.size, overwrite: true, etag: picked.native ? undefined : e.etag },
      ]);
      localCopies.transfer(pid, bucket, picked.key, t.id);
      const done = await transfers.whenFinished(t.id);
      if (done.state === "done") return done.local;
      if (done.state === "error") toast("error", `Couldn’t get “${e.name}”. ${done.error ?? ""}`, showAction);
    } catch (err) {
      toast("error", errMessage(err));
    } finally {
      localCopies.end(pid, bucket, picked.key);
    }
    return null;
  };

  /** A program, script or installer from a connection (not this computer) is asked about first. */
  const okToRun = (picked: Entry): Promise<boolean> => (c.localPaths ? Promise.resolve(true) : askToRun(picked.name, c.confirm));

  /** Opens a file in its default app (a local copy first, see `localCopy`). */
  const openInApp = async (picked: Entry) => {
    if (!(await okToRun(picked))) return;
    const path = await localCopy(picked, "open");
    if (path) await openIn(path, undefined).catch((err) => toast("error", errMessage(err)));
  };

  /**
   * "Open with ▸ app": like Open, with the app the person chose (an `AppChoice.path`). `app`
   * null: Windows' own "How do you want to open this file?" window. `asked`: the caller already
   * asked about running it.
   */
  const openWith = async (picked: Entry, app: string | null, asked = false) => {
    if (!asked && !(await okToRun(picked))) return;
    const path = await localCopy(picked, "open");
    if (path) await openIn(path, app).catch((err) => toast("error", errMessage(err)));
  };

  /** Puts the file itself on the clipboard, to paste into a chat, a mail or a Finder window. */
  const copyFile = async (picked: Entry) => {
    const path = await localCopy(picked, "copy");
    if (!path) return;
    try {
      await api.copyFileToClipboard(path);
      toast("success", `“${picked.name}” copied. Paste it into a chat, a mail or a folder.`);
    } catch (err) {
      toast("error", errMessage(err));
    }
  };

  // ---------------------------------------------------------------- delete
  const askDelete = (list: Entry[]) => {
    const { profile, bucket, settings } = c;
    if (!profile || bucket == null || list.length === 0) return;
    const folders = list.filter((e) => e.kind === "folder");
    const files = list.filter((e) => e.kind === "file");
    const what = whatOf(list);
    const pid = profile.id;
    const b = bucket;
    const run = async () => {
      const id = jobs.start({ kind: "delete", title: `Deleting ${what}` });
      c.autoShowActivity();
      c.deselect(list.map((e) => e.key));
      try {
        const r = await api.deleteObjects(pid, b, files.map((e) => e.key), folders.map((e) => e.key), id);
        jobs.finish(id, r, run);
        if (r.error && r.error !== "Cancelled")
          toast("error", `Deleting stopped after ${r.done.toLocaleString()} of ${plural(r.total, "object")}. ${r.error}`, showAction);
      } catch (e) {
        jobs.finish(id, { error: errMessage(e) }, run);
        toast("error", errMessage(e), showAction);
      }
      c.clearSizes();
      c.reloadIfShowing(pid, b);
      if (folders.length) c.foldersChanged?.(pid, b, b, folders.map((f) => ({ from: f.key, to: null })));
    };
    if (!settings.confirmDelete) {
      run();
      return;
    }
    c.confirm({
      title: `Delete ${what}?`,
      label: "Delete",
      danger: true,
      message: (
        <>
          <p>
            {folders.length > 0 ? "Folders are deleted together with everything inside them. " : ""}
            This permanently removes the {list.length === 1 ? "item" : "items"} from the bucket and <strong>cannot be undone</strong>.
          </p>
          {files.length > 0 && (
            <p>
              {plural(files.length, "file")}, {formatBytes(sumSizes(files))}
            </p>
          )}
        </>
      ),
    }).then((ok) => {
      if (ok) void run();
    });
  };

  // ---------------------------------------------------------------- undo
  const offerUndo = (entry: UndoEntry, text: string) => {
    undoStack.push(entry);
    toast("success", text, {
      label: "Undo",
      run: () => {
        if (undoStack.take(entry)) undoStack.runQueued(entry);
      },
    });
  };

  type MoveItem = { from: string; to: string; isPrefix: boolean };
  /**
   * Retry of a failed move, copy or rename: runs what is left of it as a new job. A move only
   * takes what is still in its old place (the rest got there already); a copy runs again in full
   * onto the names it picked the first time.
   */
  const runRest = (kind: "move" | "copy" | "rename", pid: string, srcB: string, dstB: string, items: MoveItem[], title: string, dest?: string) => {
    const again = async () => {
      let todo = items;
      if (kind !== "copy") {
        try {
          const left = await findExisting(pid, srcB, items.map((i) => ({ key: i.from, folder: i.isPrefix })));
          todo = items.filter((i) => left.has(i.from));
        } catch (e) {
          toast("error", `Couldn’t try again. ${errMessage(e).split("\n\n")[0]}`);
          return;
        }
        if (!todo.length) {
          toast("info", "Nothing left to move: everything is in its new place already.");
          c.reloadIfShowing(pid, srcB);
          return;
        }
      }
      const id = jobs.start({ kind, title, dest, profileId: pid, bucket: dstB });
      c.autoShowActivity();
      try {
        const r = await api.moveMany(pid, srcB, todo, kind !== "copy", id, dstB !== srcB ? dstB : null);
        jobs.finish(id, r, again);
        if (r.error && r.error !== "Cancelled") toast("error", `Stopped again after ${r.done.toLocaleString()} of ${plural(r.total, "object")}. ${r.error}`, showAction);
      } catch (e) {
        jobs.finish(id, { error: errMessage(e) }, again);
        toast("error", errMessage(e), showAction);
      }
      c.clearSizes();
      c.reloadIfShowing(pid, srcB);
      if (dstB !== srcB) c.reloadIfShowing(pid, dstB);
    };
    return () => void again();
  };

  /** Moves items back (`items` as they were moved: from → to, in `fromBucket` → `toBucket`). */
  const moveBack = (pid: string, fromBucket: string, toBucket: string, items: { from: string; to: string; isPrefix: boolean }[], label: string) => async () => {
    // something new may sit at the old names by now: never overwrite it
    let back: Set<string>;
    try {
      back = await findExisting(pid, fromBucket, items.map((i) => ({ key: i.from, folder: i.isPrefix })));
    } catch (e) {
      toast("error", `Couldn’t undo the ${label}. ${errMessage(e).split("\n\n")[0]}`);
      return;
    }
    if (back.size) {
      const first = [...back][0].replace(/\/$/, "").split("/").pop();
      toast("error", `Couldn’t undo the ${label}: “${first}” is in the old place again${back.size > 1 ? `, and ${back.size - 1} more` : ""}. Move it away and try again.`);
      return;
    }
    const id = jobs.start({ kind: "move", title: `Undoing: ${label}`, profileId: pid, bucket: fromBucket });
    const retry = runRest("move", pid, toBucket, fromBucket, items.map((i) => ({ from: i.to, to: i.from, isPrefix: i.isPrefix })), `Undoing: ${label}`);
    try {
      const r = await api.moveMany(pid, toBucket, items.map((i) => ({ from: i.to, to: i.from, isPrefix: i.isPrefix })), true, id, toBucket !== fromBucket ? fromBucket : null);
      jobs.finish(id, r, retry);
      if (r.error && r.error !== "Cancelled") toast("error", `Undo stopped after ${r.done.toLocaleString()} of ${plural(r.total, "object")}. ${r.error}`, showAction);
    } catch (e) {
      jobs.finish(id, { error: errMessage(e) }, retry);
      toast("error", errMessage(e), showAction);
    }
    c.clearSizes();
    c.reloadIfShowing(pid, fromBucket);
    if (toBucket !== fromBucket) c.reloadIfShowing(pid, toBucket);
    const folders = items.filter((i) => i.isPrefix);
    if (folders.length) c.foldersChanged?.(pid, toBucket, fromBucket, folders.map((i) => ({ from: i.to, to: i.from })));
  };

  // ---------------------------------------------------------------- rename
  /** Whether folder `parent` lists an item named exactly `key` (not just the same letters in another case). */
  const spelledSo = async (pid: string, b: string, parent: string, key: string) => {
    let token: string | null = null;
    try {
      do {
        const r = await api.listObjects(pid, b, parent, token);
        if (r.folders.includes(key) || r.objects.some((o) => o.key === key)) return true;
        token = r.nextToken;
      } while (token);
      return false;
    } catch {
      // can't tell: treat it as taken, so nothing is replaced unasked
      return true;
    }
  };
  const askRename = (e: Entry) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null) return;
    const pid = profile.id;
    const b = bucket;
    c.prompt({
      title: e.kind === "folder" ? "Rename folder" : "Rename file",
      label: "New name",
      initial: e.name,
      confirmLabel: "Rename",
      // folders that are key prefixes (S3, Azure, GCS) have no rename: every file is copied
      note: e.kind === "folder" && peekCaps(pid)?.rename === "copy-delete" ? "Renaming a folder here copies every file in it, so it can take a while." : undefined,
      run: async (name) => {
        if (name.includes("/")) {
          toast("error", "A name can’t contain “/”");
          return;
        }
        if (name === e.name) return;
        const isFolder = e.kind === "folder";
        const parent = entryParent(e);
        const to = isFolder ? `${parent}${name}/` : `${parent}${name}`;
        const found = await existing(pid, b, [{ key: to, folder: isFolder }]);
        if (!found) return;
        let replaced = false;
        // on this computer's case-blind disks a new spelling of the same name finds the item itself:
        // only a listed item spelled exactly so is another one (a case-sensitive disk)
        const caseOnly = !!c.localPaths && to.toLowerCase() === e.key.toLowerCase() && found.has(to) && !(await spelledSo(pid, b, parent, to));
        if (found.has(to) && !caseOnly) {
          if (isFolder) {
            toast("error", `There’s already a folder named “${name}” here. Pick another name.`);
            return;
          }
          const ok = await c.confirm({
            title: `Replace “${name}”?`,
            label: "Replace",
            danger: true,
            message: <p>A file with this name already exists here. Renaming “{e.name}” will overwrite it, and that can’t be undone.</p>,
          });
          if (!ok) return;
          replaced = true;
        }
        const id = jobs.start({ kind: "rename", title: `Renaming “${e.name}” to “${name}”`, dest: parent, profileId: pid, bucket: b });
        if (isFolder) c.autoShowActivity();
        let renamed = false;
        const items = [{ from: e.key, to, isPrefix: isFolder }];
        const retry = runRest("rename", pid, b, b, items, `Renaming “${e.name}” to “${name}”`, parent);
        try {
          const r = await api.moveMany(pid, b, items, true, id);
          jobs.finish(id, r, retry);
          if (r.error && r.error !== "Cancelled")
            toast("error", `Renaming stopped after ${r.done.toLocaleString()} of ${plural(r.total, "object")}. ${r.error}`, showAction);
          else renamed = !r.error;
        } catch (err) {
          jobs.finish(id, { error: errMessage(err) }, retry);
          toast("error", errMessage(err), showAction);
        }
        if (renamed) {
          c.selectAfterReload(pid, b, to);
          if (!replaced) {
            const label = `rename of “${e.name}”`;
            offerUndo({ label, run: moveBack(pid, b, b, items, label) }, `Renamed to “${name}”`);
          }
        }
        if (isFolder) c.clearSizes();
        c.reloadIfShowing(pid, b);
        if (renamed && isFolder) c.foldersChanged?.(pid, b, b, [{ from: e.key, to }]);
      },
    });
  };

  // ---------------------------------------------------------------- batch rename
  /**
   * Rename… with several items selected: the Batch rename dialog. `view` is the list in its order
   * on screen (the counter's "As shown"), `all` everything listed (names that are taken).
   */
  const askBatchRename = (list: Entry[], view: Entry[], all: Entry[]) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || list.length < 2 || !c.show) return;
    const pid = profile.id;
    const b = bucket;
    const picked = new Set(list.map((e) => e.key));
    const shown = view.filter((e) => picked.has(e.key));
    const inView = new Set(shown.map((e) => e.key));
    const items = [...shown, ...list.filter((e) => !inView.has(e.key))].map((e) => ({ key: e.key, name: e.name, folder: e.kind === "folder", modified: e.modified, size: e.size }));
    const others = all.filter((e) => !picked.has(e.key)).map((e) => e.key);
    // folders that are key prefixes (S3, Azure, GCS) have no rename: every file in them is copied
    const slow = list.some((e) => e.kind === "folder") && peekCaps(pid)?.rename === "copy-delete";
    c.show((close) => (
      <BatchRenameDialog
        items={items}
        others={others}
        rootName={b}
        foldCase={!!c.localPaths}
        note={slow ? "Renaming a folder here copies every file in it, so it can take a while." : undefined}
        onRun={(moves) => void runBatchRename(pid, b, moves)}
        onClose={close}
      />
    ));
  };

  /**
   * Renames many items as one job (one Activity row, one Stop, one Undo). Never overwrites: every
   * new name must be free, apart from names the batch itself frees. Swaps and chains (a→b, b→a)
   * go through temporary names first (batchRename.ts `renameRounds`). `resume` is a retry of
   * what a stopped batch left: its new names were checked free before, so anything there now is
   * half of a folder this batch was moving.
   */
  const runBatchRename = async (pid: string, b: string, moves: MoveItem[], opts: { undo?: boolean; resume?: boolean } = {}): Promise<void> => {
    if (!moves.length) return;
    const what = plural(moves.length, "item");
    const label = opts.undo ? `Undoing: rename of ${what}` : `Renaming ${what}`;
    const nameOf = (k: string) => k.replace(/\/$/, "").split("/").pop() ?? k;
    const fold = (k: string) => (c.localPaths ? k.toLowerCase() : k);
    if (!opts.resume) {
      const found = await existing(pid, b, moves.map((m) => ({ key: m.to, folder: m.isPrefix })));
      if (!found) return;
      const freed = new Set(moves.map((m) => fold(m.from)));
      const clash = moves.filter((m) => found.has(m.to) && !freed.has(fold(m.to)));
      if (clash.length) {
        const more = clash.length > 1 ? `, and ${(clash.length - 1).toLocaleString()} more` : "";
        toast(
          "error",
          opts.undo
            ? `Couldn’t undo the rename: “${nameOf(clash[0].to)}” is in the old place again${more}. Move it away and try again.`
            : `Nothing was renamed: “${nameOf(clash[0].to)}” already exists${more}.`,
        );
        return;
      }
    }
    const parents = new Set(moves.map((m) => parentOf(m.from)));
    const id = jobs.start({ kind: "rename", title: label, dest: parents.size === 1 ? [...parents][0] : undefined, profileId: pid, bucket: b, stoppable: true });
    c.autoShowActivity();
    c.deselect(moves.map((m) => m.from));
    const tag = Math.random().toString(36).slice(2, 8);
    const { first, second } = renameRounds(moves, (m, i) => `${parentOf(m.from)}.kybl-rename-${tag}-${i}${m.isPrefix ? "/" : ""}`, !!c.localPaths);
    let r: { done: number; total: number; error: string | null } = { done: 0, total: 0, error: null };
    try {
      if (first.length) r = await api.moveMany(pid, b, first, true, id);
      if (!r.error) r = await api.moveMany(pid, b, second, true, id);
    } catch (err) {
      r = { ...r, error: errMessage(err) };
    }

    // what didn't get to its new name, by looking at where things are now
    let left: MoveItem[] = [];
    let stranded = 0;
    if (r.error) {
      try {
        const temps = new Map(first.map((m) => [m.from, m.to]));
        const still = await findExisting(pid, b, [...moves, ...first.map((m) => ({ from: m.to, to: "", isPrefix: m.isPrefix }))].map((m) => ({ key: m.from, folder: m.isPrefix })));
        // the original names a stranded item can go back to: not taken by an item that moved there
        const arrived = (o: MoveItem) => !still.has(o.from) && !still.has(temps.get(o.from) ?? "");
        const restore: { m: MoveItem; tmp: string }[] = [];
        for (const m of moves) {
          const tmp = temps.get(m.from);
          if (still.has(m.from)) left.push(m);
          else if (tmp && still.has(tmp)) {
            if (moves.some((o) => o !== m && o.to === m.from && arrived(o))) {
              stranded++;
              left.push({ from: tmp, to: m.to, isPrefix: m.isPrefix });
            } else restore.push({ m, tmp });
          }
        }
        if (restore.length) {
          const back = await api.moveMany(pid, b, restore.map(({ m, tmp }) => ({ from: tmp, to: m.from, isPrefix: m.isPrefix })), true, `${id}-restore`).catch((e) => ({ error: errMessage(e) }));
          // couldn't put them back: the retry starts from the temporary names
          if (back.error) stranded += restore.length;
          for (const { m, tmp } of restore) left.push(back.error ? { from: tmp, to: m.to, isPrefix: m.isPrefix } : m);
        }
      } catch {
        // can't tell: offer everything again (a retry only moves what is still in its old place)
        left = moves;
      }
    }
    const retry = () => void runBatchRename(pid, b, left, { resume: true });
    jobs.finish(id, r, retry);

    const notDone = new Set(left.map((m) => m.to));
    const done = moves.filter((m) => !notDone.has(m.to));
    const doneWhat = plural(done.length, "item");
    const back = done.map((m) => ({ from: m.to, to: m.from, isPrefix: m.isPrefix }));
    const undoEntry = () => ({ label: `rename of ${doneWhat}`, run: () => runBatchRename(pid, b, back, { undo: true }) });
    if (!r.error) {
      if (opts.undo) toast("success", `Undid the rename of ${what}`);
      else offerUndo(undoEntry(), `Renamed ${what}`);
    } else if (r.error === "Cancelled") {
      const text = `Stopped. Renamed ${done.length.toLocaleString()} of ${what}.`;
      if (done.length && !opts.undo) offerUndo(undoEntry(), text);
      else toast("info", text);
    } else {
      const err = r.error;
      const showLeft = async () => {
        const go = await c.confirm({
          title: `${plural(left.length, "item")} not renamed`,
          label: "Try again",
          message: (
            <>
              <p className="hint error">{err.split("\n\n")[0]}</p>
              <ul className="br-failed">
                {left.slice(0, 200).map((m) => (
                  <li key={m.from}>
                    {nameOf(m.from)} <span>→ {nameOf(m.to)}</span>
                  </li>
                ))}
                {left.length > 200 && <li className="more">and {(left.length - 200).toLocaleString()} more</li>}
              </ul>
              {stranded > 0 && <p className="hint">{plural(stranded, "item")} kept a temporary name. Try again to finish.</p>}
            </>
          ),
        });
        // through the job list, so the failed row goes away as the retry starts
        if (go && !jobs.retry(id)) retry();
      };
      toast("error", `Renamed ${done.length.toLocaleString()}, ${left.length.toLocaleString()} not renamed.`, left.length ? { label: "Show", run: () => void showLeft() } : showAction);
      if (done.length && !opts.undo) undoStack.push(undoEntry());
    }
    const folders = done.filter((m) => m.isPrefix);
    if (folders.length) {
      c.clearSizes();
      c.foldersChanged?.(pid, b, b, folders.map((m) => ({ from: m.from, to: m.to })));
    }
    c.reloadIfShowing(pid, b);
  };

  // ---------------------------------------------------------------- new folder
  const askNewFolder = (dest = c.prefix) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null) return;
    const pid = profile.id;
    const b = bucket;
    let initial = "New folder";
    for (let n = 2; c.folderKeys.has(`${dest}${initial}/`); n++) initial = `New folder ${n}`;
    c.prompt({
      title: "New folder",
      label: "Folder name",
      initial,
      confirmLabel: "Create",
      run: async (name) => {
        if (name.includes("/")) {
          toast("error", "A name can’t contain “/”");
          return;
        }
        const key = `${dest}${name}/`;
        try {
          const found = await findExisting(pid, b, [{ key, folder: true }]).catch(() => new Set<string>());
          if (found.has(key)) {
            toast("error", `There’s already a folder named “${name}” here.`);
            return;
          }
          await api.createFolder(pid, b, key);
          c.selectAfterReload(pid, b, key);
          // in search results the new folder wouldn't show: back to the folder, with it selected
          c.leaveSearch?.();
          c.reloadIfShowing(pid, b);
        } catch (e) {
          toast("error", errMessage(e));
        }
      },
    });
  };

  // ---------------------------------------------------------------- move / copy / paste
  /**
   * Moves or copies entries into `dest`, in the same bucket or (`destBucket`) another bucket of
   * the same connection. Copying into the folder the items are already in duplicates them
   * ("photo (1).jpg") without asking.
   */
  /** Resolves true when everything asked for was moved or copied. */
  const relocate = async (list: Entry[], dest: string, mode: "move" | "copy", opts: { srcBucket?: string; destBucket?: string } = {}): Promise<boolean> => {
    const { profile } = c;
    const srcB = opts.srcBucket ?? c.bucket;
    if (!profile || !srcB) return false;
    const pid = profile.id;
    const dstB = opts.destBucket ?? srcB;
    const cross = dstB !== srcB;
    const dup = (e: Entry) => !cross && mode === "copy" && entryParent(e) === dest;
    const todo = list.filter((e) => cross || ((entryParent(e) !== dest || dup(e)) && !(e.kind === "folder" && dest.startsWith(e.key))));
    if (todo.length === 0) return false;
    const where = placeLabel(pid, dstB, dest);

    const targets = todo.map((e) => ({ key: destKey(e, dest), folder: e.kind === "folder", name: e.name }));
    const found = await existing(pid, dstB, targets.filter((t) => !todo.some((e) => dup(e) && destKey(e, dest) === t.key)));
    if (!found) return false;
    const auto = new Map<string, Choice>(todo.filter(dup).map((e) => [destKey(e, dest), "keep"]));
    const clashes = targets.filter((t) => found.has(t.key) || auto.has(t.key));
    // what lands under its own name: "Keep both" must not pick one of these for another item
    const reserved = new Set(targets.filter((t) => !found.has(t.key) && !auto.has(t.key)).map((t) => t.key));
    const d = await decide(pid, dstB, clashes, mode === "move" ? "Moving" : "Copying", where, auto, reserved);
    if (!d) return false;
    const items: { from: string; to: string; isPrefix: boolean }[] = [];
    for (const e of todo) {
      const key = destKey(e, dest);
      const to = d.dest.has(key) ? d.dest.get(key)! : key;
      if (to !== null) items.push({ from: e.key, to, isPrefix: e.kind === "folder" });
    }
    if (!items.length) return false;

    const what = items.length === 1 ? `“${todo.find((e) => e.key === items[0].from)?.name}”` : plural(items.length, "item");
    const verb = mode === "move" ? "Moving" : "Copying";
    const id = jobs.start({ kind: mode, title: `${verb} ${what} to ${where}`, dest, profileId: pid, bucket: dstB });
    c.autoShowActivity();
    if (mode === "move") c.deselect(items.map((i) => i.from));
    let ok = false;
    const retry = runRest(mode, pid, srcB, dstB, items, `${verb} ${what} to ${where}`, dest);
    try {
      const r = await api.moveMany(pid, srcB, items, mode === "move", id, cross ? dstB : null);
      jobs.finish(id, r, retry);
      if (r.error && r.error !== "Cancelled")
        toast(
          "error",
          `Stopped after ${r.done.toLocaleString()} of ${plural(r.total, "object")}. ${r.error}` +
            (mode === "move" ? " Everything not moved yet is still in its old place." : ""),
          showAction,
        );
      ok = !r.error;
    } catch (err) {
      jobs.finish(id, { error: errMessage(err) }, retry);
      toast("error", errMessage(err), showAction);
    }
    // Undo only when nothing was replaced or merged: moving a merged folder back, or deleting a
    // copy that landed in an existing folder, would also take what was there before.
    if (ok && !d.replaced) {
      const label = `${mode === "move" ? "move" : "copy"} of ${what}`;
      const done = `${mode === "move" ? "Moved" : "Copied"} ${what} to ${where}`;
      if (mode === "move") offerUndo({ label, run: moveBack(pid, srcB, dstB, items, label) }, done);
      else await offerCopyUndo(pid, dstB, items, label, done);
    }
    if (ok && mode === "move") {
      const folders = items.filter((i) => i.isPrefix);
      if (folders.length) c.foldersChanged?.(pid, srcB, dstB, folders.map((i) => ({ from: i.from, to: i.to })));
    }
    c.clearSizes();
    c.reloadIfShowing(pid, srcB);
    if (cross) c.reloadIfShowing(pid, dstB);
    return ok;
  };

  /** Says a copy is done, with an Undo that deletes exactly the objects it made (never anything added there later). */
  const offerCopyUndo = async (pid: string, b: string, items: MoveItem[], label: string, done: string) => {
    let made: string[] | null = items.filter((i) => !i.isPrefix).map((i) => i.to);
    try {
      for (const i of items.filter((x) => x.isPrefix)) made.push(...(await api.listAllUnder(pid, b, i.to)).map((o) => o.key));
    } catch {
      made = null;
    }
    if (made) offerUndo({ label, run: deleteCopies(pid, b, made, label) }, done);
    else toast("success", done);
  };

  // ---------------------------------------------------------------- duplicate
  /** ⌘D: copies each item next to itself as "name copy.ext" ("name copy 2.ext" when that is taken). */
  const duplicate = async (list: Entry[]) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || !list.length) return;
    const pid = profile.id;
    const b = bucket;
    let free: Map<string, string>;
    c.setBusy("Finding free names…");
    try {
      free = await freeKeys(pid, b, list.map((e) => e.key), new Set(), copyName);
    } catch (e) {
      toast("error", `Couldn’t duplicate. ${errMessage(e).split("\n\n")[0]}`);
      return;
    } finally {
      c.setBusy(null);
    }
    const items: MoveItem[] = list.flatMap((e) => (free.has(e.key) ? [{ from: e.key, to: free.get(e.key)!, isPrefix: e.kind === "folder" }] : []));
    if (!items.length) return void toast("error", "Couldn’t find a free name for the copy.");
    const what = whatOf(list);
    const title = `Duplicating ${what}`;
    const dest = entryParent(list[0]);
    const id = jobs.start({ kind: "copy", title, dest, profileId: pid, bucket: b });
    if (list.some((e) => e.kind === "folder")) c.autoShowActivity();
    const retry = runRest("copy", pid, b, b, items, title, dest);
    let ok = false;
    try {
      const r = await api.moveMany(pid, b, items, false, id);
      jobs.finish(id, r, retry);
      if (r.error && r.error !== "Cancelled") toast("error", `Stopped after ${r.done.toLocaleString()} of ${plural(r.total, "object")}. ${r.error}`, showAction);
      ok = !r.error;
    } catch (err) {
      jobs.finish(id, { error: errMessage(err) }, retry);
      toast("error", errMessage(err), showAction);
    }
    if (ok) {
      // the copy shows selected, as in Finder
      if (items.length === 1) c.selectAfterReload(pid, b, items[0].to);
      const name = items.length === 1 ? `“${items[0].to.replace(/\/$/, "").split("/").pop()}”` : plural(items.length, "copy", "copies");
      await offerCopyUndo(pid, b, items, `duplicate of ${what}`, `Made ${name}`);
    }
    c.clearSizes();
    c.reloadIfShowing(pid, b);
  };

  /** Undo of a copy: deletes exactly the objects it made (asks first when that's a lot). */
  const deleteCopies = (pid: string, b: string, keys: string[], label: string) => async () => {
    if (keys.length > UNDO_CONFIRM_OVER) {
      const go = await c.confirm({
        title: `Delete ${plural(keys.length, "copied object")}?`,
        label: "Delete copies",
        danger: true,
        message: <p>Undoing the {label} deletes the {plural(keys.length, "object")} it made. Anything added there since stays.</p>,
      });
      if (!go) return;
    }
    const uid = jobs.start({ kind: "delete", title: `Undoing: ${label}` });
    // deleting what is gone already is a no-op: a retry deletes the same list again
    const again = () => void deleteCopies(pid, b, keys, label)();
    try {
      const r = await api.deleteObjects(pid, b, keys, [], uid);
      jobs.finish(uid, r, again);
      if (r.error && r.error !== "Cancelled") toast("error", r.error, showAction);
    } catch (e) {
      jobs.finish(uid, { error: errMessage(e) }, again);
      toast("error", errMessage(e), showAction);
    }
    c.clearSizes();
    c.reloadIfShowing(pid, b);
  };

  /** ⌘C / ⌘X: remembers the items (and puts their S3 URIs on the clipboard as text). */
  const clip = (list: Entry[], mode: "copy" | "cut") => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || !list.length) return;
    itemClipboard.set({ mode, profileId: profile.id, bucket, items: list });
    navigator.clipboard?.writeText(list.map((e) => `s3://${bucket}/${e.key}`).join("\n")).catch(() => {});
    toast("info", keys(`${mode === "cut" ? "Cut" : "Copied"} ${whatOf(list)}. Paste with ⌘V in another folder.`));
  };

  /** ⌘V: copies or moves the clipped items into `dest` of the bucket on screen. */
  const paste = (dest = c.prefix) => {
    const cl = itemClipboard.get();
    const { profile, bucket } = c;
    if (!cl || !profile || bucket == null) return;
    const mode = cl.mode === "cut" ? "move" : "copy";
    const usedUp = () => {
      if (cl.mode === "cut" && itemClipboard.get() === cl) itemClipboard.clear();
    };
    // another connection (or a root this one can't copy into): the same route as F5 / F6 between panes
    if (cl.profileId !== profile.id || viaJobAt({ profileId: cl.profileId, bucket: cl.bucket }, { profileId: profile.id, bucket })) {
      if (!c.sendItems) return void toast("error", "Items can only be pasted within the same connection.");
      const src = { profileId: cl.profileId, bucket: cl.bucket };
      const dst = { profileId: profile.id, bucket };
      // between this computer and the cloud the originals stay (a copy): the cut stays on the clipboard
      c.sendItems(src, cl.items, mode, dst, dest, crossesDiskAt(src, dst) ? undefined : usedUp);
      return;
    }
    // a cut is used up only once the move went through (not when cancelled, or into the same folder)
    void relocate(cl.items, dest, mode, { srcBucket: cl.bucket, destBucket: bucket }).then((ok) => ok && usedUp());
  };

  return { uploadPaths, pickAndUpload, downloadEntries, localCopy, okToRun, openInApp, openWith, copyFile, askDelete, askRename, askBatchRename, askNewFolder, relocate, duplicate, clip, paste };
}

export type FileOps = ReturnType<typeof makeFileOps>;
