/**
 * What the phone does with files: download, share, open in another app, save to Photos, delete,
 * rename, move and copy (with name-clash choices and Undo), new folders, camera uploads.
 * MobileApp owns the state; these are the actions on it.
 */
import { useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMessage, errSummary } from "../api";
import { baseName, classify, parentPrefix } from "../format";
import { destKey, destLabel, entryParent } from "../moving";
import type { Settings } from "../settings";
import type { Toast } from "../components/Dialogs";
import type { TransferActions } from "../useTransfers";
import type { useJobs } from "../useJobs";
import type { Entry, ObjInfo } from "../types";
import type { SheetItem } from "./ActionSheet";
import { findClashes, resolveClashes, type ClashChoice, type Target } from "./clash";
import { localCopy } from "./localCopy";
import type { Loc } from "./useListing";
import type { SharedFile } from "./DestinationScreen";

export type ToastAction = NonNullable<Toast["action"]>;
export type ToastFn = (kind: Toast["kind"], text: string, action?: ToastAction) => void;
export type Busy = { text: string; frac: number | null; cancel?: () => void } | null;
type Confirm = { title: string; message: React.ReactNode; label: string; danger?: boolean; run: () => void };
type Prompt = { title: string; label: string; initial: string; confirmLabel: string; run: (v: string) => void };
type Sheet = { title?: string; message?: string; items: SheetItem[] };

export type FileOpsCtx = {
  loc: Loc | null;
  settings: Settings;
  transfers: TransferActions;
  jobs: ReturnType<typeof useJobs>;
  toast: ToastFn;
  setBusy: (b: Busy) => void;
  setConfirm: (c: Confirm | null) => void;
  setPrompt: (p: Prompt | null) => void;
  setSheet: (s: Sheet | null) => void;
  /** the bucket changed: refresh what is on screen and patch search results */
  changed: (profileId: string, bucket: string, patch?: (r: ObjInfo[]) => ObjInfo[]) => void;
  /** a downloaded batch should be watched; `done` runs once every transfer in it has finished */
  watchDownloads: (ids: string[], done: (ok: string[], failed: number) => void) => void;
  downloadDir: () => Promise<string>;
  savedWhere: string;
  openTransfers: () => void;
  go: (l: Loc) => void;
  clearSelection: () => void;
  closeDetail: () => void;
  /** the item in the detail screen was renamed */
  renamedDetail: (from: string, e: Entry) => void;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const what = (list: { name: string }[]) => (list.length === 1 ? `“${list[0].name}”` : plural(list.length, "item"));

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // older Android web views refuse the async clipboard: fall back to a selected textarea
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("Could not access the clipboard");
  }
}

/** A name for a photo or video just taken (the camera calls them all "image.jpg"). */
function cameraName(f: File): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")) : f.type.startsWith("video/") ? ".mov" : ".jpg";
  const generic = /^(image|video|photo|capture|blob)?\d*\.\w+$/i.test(f.name) || !f.name;
  return generic ? `${f.type.startsWith("video/") ? "Video" : "Photo"} ${stamp}${ext}` : f.name;
}

export function useFileOps(c: FileOpsCtx) {
  /** downloads being listed, so a second tap doesn't queue everything twice */
  const listing = useRef(new Set<string>());

  const toastErr = (e: unknown) => c.toast("error", errSummary(errMessage(e)));

  const copyText = async (text: string, label: string) => {
    try {
      await copyToClipboard(text);
      c.toast("success", `${label} copied`);
    } catch {
      c.toast("error", "Could not access the clipboard");
    }
  };

  const expiryWords = (secs: number) => {
    const n = secs >= 86400 ? Math.round(secs / 86400) : Math.round(secs / 3600);
    return `${n} ${secs >= 86400 ? "day" : "hour"}${n === 1 ? "" : "s"}`;
  };

  const copyLink = async (e: Entry, secs = c.settings.linkExpiry) => {
    if (!c.loc) return;
    try {
      const url = await api.presign(c.loc.profileId, c.loc.bucket, e.key, secs);
      await copyToClipboard(url);
      c.toast("success", `Link copied. It expires in ${expiryWords(secs)}`);
    } catch (err) {
      toastErr(err);
    }
  };

  /**
   * Fetches files into the app's temporary folder with a progress pill (Cancel stops it), for
   * handing them to another app. Resolves to the local paths, or null when cancelled/failed.
   */
  const fetchLocal = async (list: Entry[], doing: string): Promise<string[] | null> => {
    const l = c.loc;
    if (!l) return null;
    const files = list.filter((e) => e.kind === "file");
    if (!files.length) return null;
    const total = files.reduce((s, e) => s + e.size, 0) || 1;
    let before = 0;
    let stop = false;
    let cancelCur = () => {};
    const paths: string[] = [];
    const label = files.length === 1 ? `“${files[0].name}”` : plural(files.length, "file");
    try {
      for (const e of files) {
        const job = localCopy({ ...l, key: e.key, name: e.name, etag: e.etag, size: e.size }, (f) =>
          c.setBusy({ text: `${doing} ${label}`, frac: f == null ? null : (before + f * e.size) / total, cancel }),
        );
        cancelCur = job.cancel;
        c.setBusy({ text: `${doing} ${label}`, frac: before / total, cancel });
        paths.push(await job.path);
        before += e.size;
        if (stop) return null;
      }
      return paths;
    } catch (err) {
      if (!stop) toastErr(err);
      return null;
    } finally {
      c.setBusy(null);
    }
    function cancel() {
      stop = true;
      cancelCur();
      c.setBusy(null);
    }
  };

  /** "Open in…": the file in another app on the phone (an "Open with" chooser on Android). */
  const openIn = async (e: Entry) => {
    const paths = await fetchLocal([e], "Getting");
    if (!paths) return;
    api.openLocal(paths[0]).catch(toastErr);
  };

  const shareFiles = async (list: Entry[]) => {
    const paths = await fetchLocal(list, "Getting");
    if (!paths) return;
    api.shareFiles(paths).catch(toastErr);
  };

  const shareLink = async (e: Entry) => {
    if (!c.loc) return;
    try {
      const url = await api.presign(c.loc.profileId, c.loc.bucket, e.key, c.settings.linkExpiry);
      await api.shareText(url).catch(async () => {
        await copyToClipboard(url);
        c.toast("success", `Link copied. It expires in ${expiryWords(c.settings.linkExpiry)}`);
      });
    } catch (err) {
      toastErr(err);
    }
  };

  /** Share → a link (expires) or the file itself. */
  const shareSheet = (list: Entry[]) => {
    const files = list.filter((e) => e.kind === "file");
    if (!files.length) return;
    const items: SheetItem[] = [];
    if (files.length === 1) {
      items.push(
        { icon: "link", label: `Share link (expires in ${expiryWords(c.settings.linkExpiry)})`, run: () => shareLink(files[0]) },
        { icon: "share", label: "Share file", run: () => shareFiles(files) },
        { icon: "copy", label: "Copy link", run: () => copyLink(files[0]) },
      );
    } else items.push({ icon: "share", label: `Share ${plural(files.length, "file")}`, run: () => shareFiles(files) });
    c.setSheet({ title: files.length === 1 ? files[0].name : `Share ${plural(files.length, "file")}`, items });
  };

  const saveToPhotos = async (list: Entry[]) => {
    const media = list.filter((e) => e.kind === "file" && (classify(e.name) === "image" || classify(e.name) === "video"));
    if (!media.length) return;
    const paths = await fetchLocal(media, "Saving");
    if (!paths) return;
    try {
      for (const p of paths) await api.saveToPhotos(p);
      void api.haptic("success");
      c.toast("success", media.length === 1 ? "Saved to Photos" : `${plural(media.length, "item")} saved to Photos`);
    } catch (err) {
      toastErr(err);
    }
  };

  // ------------------------------------------------------------ download
  const download = async (list: Entry[]) => {
    const l = c.loc;
    if (!l || list.length === 0) return;
    const guard = `${l.profileId}|${l.bucket}|${list.map((e) => e.key).join("\n")}`;
    if (listing.current.has(guard)) return;
    listing.current.add(guard);
    const folders = list.filter((e) => e.kind === "folder");
    let stopped = false;
    try {
      // listing a big folder takes a while: say so at once, so nobody taps again
      if (folders.length)
        c.setBusy({
          text: `Finding files in ${folders.length === 1 ? `“${folders[0].name}”` : plural(folders.length, "folder")}…`,
          frac: null,
          cancel: () => {
            stopped = true;
            c.setBusy(null);
          },
        });
      const dir = await c.downloadDir();
      const join = (rel: string) => `${dir.replace(/[\\/]$/, "")}/${rel}`;
      const items: Parameters<TransferActions["add"]>[0] = [];
      for (const e of list) {
        if (e.kind === "file") {
          items.push({ kind: "download", name: e.name, profileId: l.profileId, bucket: l.bucket, key: e.key, local: join(e.name), total: e.size });
        } else {
          const base = parentPrefix(e.key);
          for (const rf of await api.listAllUnder(l.profileId, l.bucket, e.key)) {
            if (stopped) return;
            const rel = rf.key.slice(base.length);
            if (rel.endsWith("/")) continue;
            items.push({ kind: "download", name: rel, profileId: l.profileId, bucket: l.bucket, key: rf.key, local: join(rel), total: rf.size });
          }
        }
      }
      if (stopped) return;
      c.setBusy(null);
      if (items.length === 0) {
        c.toast("info", "Nothing to download");
        return;
      }
      const created = c.transfers.add(items);
      c.toast("info", `Saving ${items.length === 1 ? `“${items[0].name}”` : plural(items.length, "file")} to ${c.savedWhere}`, {
        label: "Show",
        run: c.openTransfers,
      });
      // say where it landed once it has: an existing file is kept and the download gets a free name
      c.watchDownloads(
        created.map((t) => t.id),
        (ok, failed) => {
          if (failed) c.toast("error", `${plural(failed, "download")} failed`, { label: "Retry", run: c.openTransfers });
          else if (ok.length === 1) c.toast("success", `Saved “${baseName(ok[0].replace(/\\/g, "/"))}”`, { label: "Open", run: () => api.openLocal(ok[0]).catch(toastErr) });
          else if (ok.length > 1) c.toast("success", `Saved ${plural(ok.length, "file")} to ${c.savedWhere}`);
        },
      );
    } catch (e) {
      c.setBusy(null);
      toastErr(e);
    } finally {
      listing.current.delete(guard);
    }
  };

  // ------------------------------------------------------------ delete
  const askDelete = (list: Entry[]) => {
    const l = c.loc;
    if (!l || list.length === 0) return;
    const { profileId: pid, bucket: b } = l;
    const folders = list.filter((e) => e.kind === "folder");
    const files = list.filter((e) => e.kind === "file");
    const label = what(list);
    const run = async () => {
      c.clearSelection();
      c.closeDetail();
      void api.haptic("warning");
      const id = c.jobs.start({ kind: "delete", title: `Deleting ${label}` });
      try {
        const r = await api.deleteObjects(pid, b, files.map((e) => e.key), folders.map((e) => e.key), id);
        c.jobs.finish(id, r);
        if (r.error && r.error !== "Cancelled") c.toast("error", `Deleting stopped after ${r.done} of ${r.total} objects. ${errSummary(r.error)}`);
        else c.toast("success", `Deleted ${label}`);
      } catch (e) {
        c.jobs.finish(id, { error: errMessage(e) });
        toastErr(e);
      }
      const gone = new Set(files.map((e) => e.key));
      c.changed(pid, b, (rs) => rs.filter((o) => !gone.has(o.key) && !folders.some((f) => o.key.startsWith(f.key))));
    };
    if (!c.settings.confirmDelete) return void run();
    c.setConfirm({
      title: `Delete ${label}?`,
      label: "Delete",
      danger: true,
      message: (
        <p>
          {folders.length > 0 ? "Folders are deleted with everything inside them. " : ""}
          This permanently removes {list.length === 1 ? "it" : "them"} from the bucket and <strong>cannot be undone</strong>.
        </p>
      ),
      run,
    });
  };

  // ------------------------------------------------------------ move, copy, rename
  /** Runs a move/copy; with `undo`, the toast offers to put things back. */
  const runMove = async (pid: string, b: string, items: Target[], mode: "move" | "copy", title: string, done: string, dest: string, undo: boolean) => {
    const id = c.jobs.start({ kind: mode, title, dest, profileId: pid, bucket: b });
    let ok = false;
    try {
      const r = await api.moveMany(pid, b, items, mode === "move", id);
      c.jobs.finish(id, r);
      if (r.error && r.error !== "Cancelled") c.toast("error", errSummary(r.error));
      else if (r.error !== "Cancelled") {
        ok = true;
        const back = items.map((t) => ({ from: t.to, to: t.from, isPrefix: t.isPrefix }));
        c.toast(
          "success",
          done,
          mode === "move" && undo
            ? { label: "Undo", run: () => runMove(pid, b, back, "move", `Putting back ${items.length === 1 ? `“${baseName(items[0].from)}”` : plural(items.length, "item")}`, "Put back", parentPrefix(items[0].from), false) }
            : { label: "Open", run: () => c.go({ profileId: pid, bucket: b, prefix: dest }) },
        );
      }
    } catch (err) {
      c.jobs.finish(id, { error: errMessage(err) });
      toastErr(err);
    }
    const scope = c.loc?.prefix ?? "";
    /** where a key went: moved itself, or inside a moved folder */
    const remap = (key: string): string | undefined => {
      for (const t of items) {
        if (key === t.from) return t.to;
        if (t.isPrefix && key.startsWith(t.from)) return t.to + key.slice(t.from.length);
      }
      return undefined;
    };
    c.changed(pid, b, (rs) =>
      mode !== "move" || !ok
        ? rs
        : // a moved match keeps showing if it is still inside the folder being searched
          rs.flatMap((o) => {
            const to = remap(o.key);
            if (to === undefined) return [o];
            return to.startsWith(scope) ? [{ ...o, key: to }] : [];
          }),
    );
    return ok;
  };

  /** Moves or copies into `dest`, asking first when names are already taken there. */
  const relocate = async (list: Entry[], dest: string, mode: "move" | "copy") => {
    const l = c.loc;
    if (!l) return;
    const { profileId: pid, bucket: b } = l;
    const todo = list.filter((e) => entryParent(e) !== dest && !(e.kind === "folder" && dest.startsWith(e.key)));
    if (todo.length === 0) return;
    c.clearSelection();
    if (mode === "move") c.closeDetail();
    const items: Target[] = todo.map((e) => ({ from: e.key, to: destKey(e, dest), isPrefix: e.kind === "folder" }));
    const where = destLabel(dest, b);
    const go = async (final: Target[]) => {
      if (!final.length) return;
      const label = final.length === 1 ? `“${baseName(final[0].from)}”` : plural(final.length, "item");
      await runMove(pid, b, final, mode, `${mode === "move" ? "Moving" : "Copying"} ${label} to ${where}`, `${mode === "move" ? "Moved" : "Copied"} ${label} to ${where}`, dest, true);
    };
    let clashing: Set<string>;
    try {
      clashing = await findClashes(pid, b, items);
    } catch {
      clashing = new Set();
    }
    if (!clashing.size) return go(items);
    const choose = (choice: ClashChoice) => () =>
      resolveClashes(pid, b, items, clashing, choice)
        .then(go)
        .catch(toastErr);
    const n = clashing.size;
    c.setSheet({
      title: n === 1 ? `“${baseName(items.find((t) => clashing.has(t.to))!.to)}” is already in ${where}` : `${plural(n, "item")} are already in ${where}`,
      message: n === 1 ? "Keep both, replace it, or leave it out?" : "Keep both, replace them, or leave them out?",
      items: [
        { icon: "copy", label: "Keep both", run: choose("keep") },
        { icon: "refresh", label: n === 1 ? "Replace it" : "Replace them", danger: true, run: choose("replace") },
        ...(n < items.length ? [{ icon: "x" as const, label: n === 1 ? "Skip this one" : "Skip these", run: choose("skip") }] : []),
      ],
    });
  };

  const askRename = (e: Entry) => {
    const l = c.loc;
    if (!l) return;
    const { profileId: pid, bucket: b } = l;
    c.setPrompt({
      title: e.kind === "folder" ? "Rename folder" : "Rename file",
      label: "New name",
      initial: e.name,
      confirmLabel: "Rename",
      run: async (raw) => {
        const name = raw.trim();
        if (name.includes("/")) return c.toast("error", "A name cannot contain “/”");
        if (!name || name === e.name) return;
        const isFolder = e.kind === "folder";
        const parent = entryParent(e);
        const to = isFolder ? `${parent}${name}/` : `${parent}${name}`;
        const item: Target = { from: e.key, to, isPrefix: isFolder };
        const run = async () => {
          const ok = await runMove(pid, b, [item], "move", `Renaming “${e.name}” to “${name}”`, `Renamed to “${name}”`, parent, true);
          if (ok) c.renamedDetail(e.key, { ...e, key: to, name });
        };
        // renaming onto an existing name would replace that file without a word
        const taken = await findClashes(pid, b, [item]).catch(() => new Set<string>());
        if (!taken.size) return run();
        c.setConfirm({
          title: `Replace “${name}”?`,
          label: "Replace",
          danger: true,
          message: <p>Something called “{name}” is already in this folder. Renaming replaces it.</p>,
          run,
        });
      },
    });
  };

  const newFolder = () => {
    const l = c.loc;
    if (!l) return;
    c.setPrompt({
      title: "New folder",
      label: "Folder name",
      initial: "",
      confirmLabel: "Create",
      run: async (name) => {
        const n = name.trim().replace(/^\/+|\/+$/g, "");
        if (!n) return;
        try {
          await api.createFolder(l.profileId, l.bucket, `${l.prefix}${n}/`);
          c.changed(l.profileId, l.bucket);
        } catch (e) {
          toastErr(e);
        }
      },
    });
  };

  // ------------------------------------------------------------ uploads
  const queueUploads = (to: Loc, files: SharedFile[]) => {
    c.transfers.add(files.map((f) => ({ kind: "upload" as const, name: f.name, profileId: to.profileId, bucket: to.bucket, key: to.prefix + f.name, local: f.path, total: f.size })));
    const here = c.loc && c.loc.profileId === to.profileId && c.loc.bucket === to.bucket && c.loc.prefix === to.prefix;
    c.toast("info", `Uploading ${files.length === 1 ? `“${files[0].name}”` : plural(files.length, "file")} to ${destLabel(to.prefix, to.bucket)}`, here ? { label: "Show", run: c.openTransfers } : { label: "Open", run: () => c.go(to) });
  };

  const upload = async (mode: "media" | "document") => {
    const l = c.loc;
    if (!l) return;
    try {
      const r = await openDialog({ multiple: true, pickerMode: mode, title: "Choose files to upload" });
      const picked = r == null ? [] : Array.isArray(r) ? r : [r];
      if (picked.length === 0) return;
      queueUploads(l, await api.pickedFiles(picked));
    } catch (e) {
      toastErr(e);
    }
  };

  /** Photos and videos from the camera (an `<input capture>`), written to a temporary file first. */
  const uploadCaptured = async (list: FileList | null) => {
    const l = c.loc;
    if (!l || !list?.length) return;
    try {
      const files: SharedFile[] = [];
      for (const f of Array.from(list)) {
        const name = cameraName(f);
        c.setBusy({ text: `Preparing “${name}”`, frac: null });
        const path = await api.writeTempFile(name, await f.arrayBuffer());
        files.push({ path, name, size: f.size });
      }
      queueUploads(l, files);
    } catch (e) {
      toastErr(e);
    } finally {
      c.setBusy(null);
    }
  };

  return { copyText, copyLink, openIn, shareSheet, shareFiles, saveToPhotos, download, askDelete, relocate, askRename, newFolder, upload, uploadCaptured, queueUploads };
}
