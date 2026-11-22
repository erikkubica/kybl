/**
 * What the desktop file browser does to objects: upload, download, open, delete, rename, new
 * folder, move/copy (also to other buckets of the connection) and paste. Every action that writes
 * names checks for clashes first, and moves, renames and copies that can be reversed safely leave
 * an Undo behind.
 */
import type { ReactNode } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, errMessage } from "../api";
import { formatBytes, parentPrefix } from "../format";
import { destKey, entryParent } from "../moving";
import type { Settings } from "../settings";
import type { Entry, LocalFile, Profile } from "../types";
import type { Toast } from "../components/Dialogs";
import type { TransferActions } from "../useTransfers";
import type { useJobs } from "../useJobs";
import { applyChoices, findExisting, type Choice, type Clash } from "./conflicts";
import { joinPath, safeRelPath, shortHash } from "./paths";
import { undoStack, type UndoEntry } from "./undo";
import { itemClipboard } from "./clipboard";

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
  setBusy: (text: string | null) => void;
  confirm: (o: { title: string; message: ReactNode; label: string; danger?: boolean }) => Promise<boolean>;
  prompt: (o: { title: string; label: string; initial: string; confirmLabel: string; run: (v: string) => void }) => void;
  resolveConflicts: (clashes: Clash[], verb: string, where: string) => Promise<Map<string, Choice> | null>;
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  /** select this key once the listing on screen has reloaded (if it is still that place) */
  selectAfterReload: (profileId: string, bucket: string, key: string | null) => void;
  deselect: (keys: string[]) => void;
  clearSizes: () => void;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const whatOf = (list: { name: string }[]) => (list.length === 1 ? `“${list[0].name}”` : plural(list.length, "item"));
const placeLabel = (bucket: string, prefix: string) => `${bucket}/${prefix}`.replace(/\/$/, "");

export function makeFileOps(c: OpsContext) {
  const { transfers, jobs, toast } = c;
  const showAction: ToastAction = { label: "Show", run: c.showActivity };

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
  const decide = async (pid: string, b: string, clashes: Clash[], verb: string, where: string, auto: Map<string, Choice> = new Map()) => {
    const ask = clashes.filter((x) => !auto.has(x.key));
    const choices = await c.resolveConflicts(ask, verb, where);
    if (!choices) return null;
    for (const [k, v] of auto) choices.set(k, v);
    c.setBusy(choices.size ? "Finding free names…" : null);
    try {
      return { dest: await applyChoices(pid, b, choices), replaced: [...choices.values()].includes("replace") };
    } finally {
      c.setBusy(null);
    }
  };

  // ---------------------------------------------------------------- upload
  const uploadPaths = async (paths: string[], dest = c.prefix) => {
    const { profile, bucket } = c;
    if (!profile || !bucket || paths.length === 0) return;
    const pid = profile.id;
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
        return;
      }
      // what lands directly in `dest`: single files, or the top folder of a dropped folder
      const groups = new Map<string, { folder: boolean; files: { f: LocalFile; rest: string }[] }>();
      for (const f of files) {
        const rel = safeRelPath(f.rel.replace(/\\/g, "/"));
        if (!rel) continue;
        const cut = rel.indexOf("/");
        const top = cut < 0 ? rel : rel.slice(0, cut + 1);
        const g = groups.get(top) ?? { folder: cut >= 0, files: [] };
        g.files.push({ f, rest: cut < 0 ? "" : rel.slice(cut + 1) });
        groups.set(top, g);
      }
      const targets = [...groups].map(([top, g]) => ({ key: dest + top, folder: g.folder }));
      const found = await existing(pid, bucket, targets);
      if (!found) return;
      const clashes = targets.filter((t) => found.has(t.key)).map((t) => ({ key: t.key, folder: t.folder, name: t.key.slice(dest.length).replace(/\/$/, "") }));
      const d = await decide(pid, bucket, clashes, "Uploading", placeLabel(bucket, dest));
      if (!d) return;
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
        return;
      }
      transfers.add(items);
      c.autoShowActivity();
    } catch (e) {
      toast("error", errMessage(e));
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
  const downloadEntries = async (list: Entry[], relBase: string | null = null) => {
    const { profile, bucket, settings } = c;
    if (!profile || !bucket || list.length === 0) return;
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
        transfers.add([{ kind: "download", name: f.name, profileId: pid, bucket, key: f.key, local, total: f.size, overwrite }]);
        c.autoShowActivity();
        if (!settings.downloadAsk) toast("info", `Downloading “${f.name}” to your Downloads folder`);
        return;
      }
      const dir = settings.downloadAsk
        ? ((r) => (Array.isArray(r) ? r[0] : r))(await openDialog({ directory: true, multiple: false, title: "Choose a download folder" }))
        : await api.downloadFolder();
      if (!dir) return;
      const items: Parameters<TransferActions["add"]>[0] = [];
      const add = (key: string, size: number, rel: string) => {
        const safe = safeRelPath(rel);
        if (safe) items.push({ kind: "download", name: safe, profileId: pid, bucket, key, local: joinPath(dir, safe), total: size });
      };
      for (const e of list) {
        if (e.kind === "file") {
          add(e.key, e.size, relBase !== null && e.key.startsWith(relBase) ? e.key.slice(relBase.length) : e.name);
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

  /** Downloads a file to Kybl's temporary folder and opens it in its default app. */
  const openInApp = async (e: Entry) => {
    const { profile, bucket } = c;
    if (!profile || !bucket || e.kind !== "file") return;
    try {
      const tmp = await api.tempFolder();
      const local = joinPath(tmp, `${shortHash(`${profile.id}\n${bucket}\n${e.key}`)}/${safeRelPath(e.name) || "file"}`);
      const [t] = transfers.add([{ kind: "download", name: e.name, profileId: profile.id, bucket, key: e.key, local, total: e.size, overwrite: true }]);
      if (e.size > 20_000_000) toast("info", `Opening “${e.name}” once it has downloaded…`);
      const done = await transfers.whenFinished(t.id);
      if (done.state === "done") await api.openLocal(done.local);
      else if (done.state === "error") toast("error", `Couldn’t open “${e.name}”. ${done.error ?? ""}`, showAction);
    } catch (err) {
      toast("error", errMessage(err));
    }
  };

  // ---------------------------------------------------------------- delete
  const askDelete = (list: Entry[]) => {
    const { profile, bucket, settings } = c;
    if (!profile || !bucket || list.length === 0) return;
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
        jobs.finish(id, r);
        if (r.error && r.error !== "Cancelled")
          toast("error", `Deleting stopped after ${r.done.toLocaleString()} of ${r.total.toLocaleString()} objects. ${r.error}`, showAction);
      } catch (e) {
        jobs.finish(id, { error: errMessage(e) });
        toast("error", errMessage(e), showAction);
      }
      c.clearSizes();
      c.reloadIfShowing(pid, b);
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
              {plural(files.length, "file")}, {formatBytes(files.reduce((s, e) => s + e.size, 0))}
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
        if (undoStack.take(entry)) void entry.run();
      },
    });
  };

  /** Moves items back (`items` as they were moved: from → to, in `fromBucket` → `toBucket`). */
  const moveBack = (pid: string, fromBucket: string, toBucket: string, items: { from: string; to: string; isPrefix: boolean }[], label: string) => async () => {
    const id = jobs.start({ kind: "move", title: `Undoing: ${label}`, profileId: pid, bucket: fromBucket });
    try {
      const r = await api.moveMany(pid, toBucket, items.map((i) => ({ from: i.to, to: i.from, isPrefix: i.isPrefix })), true, id, toBucket !== fromBucket ? fromBucket : null);
      jobs.finish(id, r);
      if (r.error && r.error !== "Cancelled") toast("error", `Undo stopped after ${r.done.toLocaleString()} of ${r.total.toLocaleString()} objects. ${r.error}`, showAction);
    } catch (e) {
      jobs.finish(id, { error: errMessage(e) });
      toast("error", errMessage(e), showAction);
    }
    c.clearSizes();
    c.reloadIfShowing(pid, fromBucket);
    if (toBucket !== fromBucket) c.reloadIfShowing(pid, toBucket);
  };

  // ---------------------------------------------------------------- rename
  const askRename = (e: Entry) => {
    const { profile, bucket } = c;
    if (!profile || !bucket) return;
    const pid = profile.id;
    const b = bucket;
    c.prompt({
      title: e.kind === "folder" ? "Rename folder" : "Rename file",
      label: "New name",
      initial: e.name,
      confirmLabel: "Rename",
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
        if (found.has(to)) {
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
        try {
          const r = await api.moveMany(pid, b, items, true, id);
          jobs.finish(id, r);
          if (r.error && r.error !== "Cancelled")
            toast("error", `Renaming stopped after ${r.done.toLocaleString()} of ${r.total.toLocaleString()} objects. ${r.error}`, showAction);
          else renamed = !r.error;
        } catch (err) {
          jobs.finish(id, { error: errMessage(err) });
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
      },
    });
  };

  // ---------------------------------------------------------------- new folder
  const askNewFolder = (dest = c.prefix) => {
    const { profile, bucket } = c;
    if (!profile || !bucket) return;
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
  const relocate = async (list: Entry[], dest: string, mode: "move" | "copy", opts: { srcBucket?: string; destBucket?: string } = {}) => {
    const { profile } = c;
    const srcB = opts.srcBucket ?? c.bucket;
    if (!profile || !srcB) return;
    const pid = profile.id;
    const dstB = opts.destBucket ?? srcB;
    const cross = dstB !== srcB;
    const dup = (e: Entry) => !cross && mode === "copy" && entryParent(e) === dest;
    const todo = list.filter((e) => cross || ((entryParent(e) !== dest || dup(e)) && !(e.kind === "folder" && dest.startsWith(e.key))));
    if (todo.length === 0) return;
    const where = placeLabel(dstB, dest);

    const targets = todo.map((e) => ({ key: destKey(e, dest), folder: e.kind === "folder", name: e.name }));
    const found = await existing(pid, dstB, targets.filter((t) => !todo.some((e) => dup(e) && destKey(e, dest) === t.key)));
    if (!found) return;
    const auto = new Map<string, Choice>(todo.filter(dup).map((e) => [destKey(e, dest), "keep"]));
    const clashes = targets.filter((t) => found.has(t.key) || auto.has(t.key));
    const d = await decide(pid, dstB, clashes, mode === "move" ? "Moving" : "Copying", where, auto);
    if (!d) return;
    const items: { from: string; to: string; isPrefix: boolean }[] = [];
    for (const e of todo) {
      const key = destKey(e, dest);
      const to = d.dest.has(key) ? d.dest.get(key)! : key;
      if (to !== null) items.push({ from: e.key, to, isPrefix: e.kind === "folder" });
    }
    if (!items.length) return;

    const what = items.length === 1 ? `“${todo.find((e) => e.key === items[0].from)?.name}”` : plural(items.length, "item");
    const verb = mode === "move" ? "Moving" : "Copying";
    const id = jobs.start({ kind: mode, title: `${verb} ${what} to ${where}`, dest, profileId: pid, bucket: dstB });
    c.autoShowActivity();
    if (mode === "move") c.deselect(items.map((i) => i.from));
    let ok = false;
    try {
      const r = await api.moveMany(pid, srcB, items, mode === "move", id, cross ? dstB : null);
      jobs.finish(id, r);
      if (r.error && r.error !== "Cancelled")
        toast(
          "error",
          `Stopped after ${r.done.toLocaleString()} of ${r.total.toLocaleString()} objects. ${r.error}` +
            (mode === "move" ? " Everything not moved yet is still in its old place." : ""),
          showAction,
        );
      ok = !r.error;
    } catch (err) {
      jobs.finish(id, { error: errMessage(err) });
      toast("error", errMessage(err), showAction);
    }
    // Undo only when nothing was replaced or merged: moving a merged folder back, or deleting a
    // copy that landed in an existing folder, would also take what was there before.
    if (ok && !d.replaced) {
      const label = `${mode === "move" ? "move" : "copy"} of ${what}`;
      const done = `${mode === "move" ? "Moved" : "Copied"} ${what} to ${where}`;
      if (mode === "move") offerUndo({ label, run: moveBack(pid, srcB, dstB, items, label) }, done);
      else
        offerUndo(
          {
            label,
            run: async () => {
              const uid = jobs.start({ kind: "delete", title: `Undoing: ${label}` });
              try {
                const r = await api.deleteObjects(pid, dstB, items.filter((i) => !i.isPrefix).map((i) => i.to), items.filter((i) => i.isPrefix).map((i) => i.to), uid);
                jobs.finish(uid, r);
                if (r.error && r.error !== "Cancelled") toast("error", r.error, showAction);
              } catch (e) {
                jobs.finish(uid, { error: errMessage(e) });
                toast("error", errMessage(e), showAction);
              }
              c.clearSizes();
              c.reloadIfShowing(pid, dstB);
            },
          },
          done,
        );
    }
    c.clearSizes();
    c.reloadIfShowing(pid, srcB);
    if (cross) c.reloadIfShowing(pid, dstB);
  };

  /** ⌘C / ⌘X: remembers the items (and puts their S3 URIs on the clipboard as text). */
  const clip = (list: Entry[], mode: "copy" | "cut") => {
    const { profile, bucket } = c;
    if (!profile || !bucket || !list.length) return;
    itemClipboard.set({ mode, profileId: profile.id, bucket, items: list });
    navigator.clipboard?.writeText(list.map((e) => `s3://${bucket}/${e.key}`).join("\n")).catch(() => {});
    toast("info", `${mode === "cut" ? "Cut" : "Copied"} ${whatOf(list)}. Paste with ⌘V in another folder.`);
  };

  /** ⌘V: copies or moves the clipped items into `dest` of the bucket on screen. */
  const paste = (dest = c.prefix) => {
    const cl = itemClipboard.get();
    const { profile, bucket } = c;
    if (!cl || !profile || !bucket) return;
    if (cl.profileId !== profile.id) {
      toast("error", "Items can only be pasted within the same connection.");
      return;
    }
    if (cl.mode === "cut") itemClipboard.clear();
    void relocate(cl.items, dest, cl.mode === "cut" ? "move" : "copy", { srcBucket: cl.bucket, destBucket: bucket });
  };

  return { uploadPaths, pickAndUpload, downloadEntries, openInApp, askDelete, askRename, askNewFolder, relocate, clip, paste };
}

export type FileOps = ReturnType<typeof makeFileOps>;
