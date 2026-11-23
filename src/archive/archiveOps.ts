/**
 * What a pane does with archives: open one like a folder, extract (here, or anywhere through
 * the copy dialog), compress a selection to a .zip. Extracting and compressing run as one row of
 * the transfers panel each; the backend does the work (src-tauri/src/archive).
 */
import { errMessage } from "../api";
import { baseName } from "../format";
import { destLabel, entryParent, placeLabel } from "../moving";
import { applyChoices, findExisting, freeKeys, type Choice, type Clash } from "../desktop/conflicts";
import type { FileOps } from "../desktop/fileOps";
import type { MenuItem, Toast } from "../components/Dialogs";
import type { TransferActions } from "../useTransfers";
import type { OpenMigration } from "../shell/useMigrationHost";
import type { Entry, Profile } from "../types";
import { archiveApi, archiveOrigin, archiveProfile, archiveStem, isArchiveId, isArchiveName, skippedNote, type ExtractJob } from "./archive";

export type ArchiveCtx = {
  profile: Profile | null;
  bucket: string | null;
  prefix: string;
  /** the pane is showing search results (items from several folders) */
  searching: boolean;
  profiles: Profile[];
  /** the stand-in for "This Mac" (it isn't in `profiles` everywhere) */
  local: Profile;
  ops: FileOps;
  transfers: TransferActions;
  toast: (kind: Toast["kind"], text: string, action?: NonNullable<Toast["action"]>) => void;
  setBusy: (text: string | null) => void;
  resolveConflicts: (clashes: Clash[], verb: string, where: string) => Promise<Map<string, Choice> | null>;
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
  selectAfterReload: (profileId: string, bucket: string, key: string | null) => void;
  autoShowActivity: () => void;
  showActivity: () => void;
  go: (p: Profile, bucket: string, prefix: string, opts?: { selectKey?: string }) => void;
  openMigration?: OpenMigration;
};

import { plural } from "../format";

export function makeArchiveOps(c: ArchiveCtx) {
  const inArchive = isArchiveId(c.profile?.id);
  const origin = archiveOrigin(c.profile?.id);
  const profileOf = (id: string) => (id === c.local.id ? c.local : c.profiles.find((p) => p.id === id) ?? archiveProfile(id, c.profiles, c.local));

  /** Opens an archive file of the pane's place like a folder. */
  const open = async (e: Entry) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || e.kind !== "file") return;
    // a remote archive is fetched first, with its progress on the Open button and in Activity
    const local = await c.ops.localCopy(e, "open");
    if (!local) return;
    c.setBusy(`Opening “${e.name}”…`);
    try {
      const info = await archiveApi.open(profile.id, bucket, e.key, local);
      const p = archiveProfile(info.id, c.profiles, c.local);
      if (!p) return;
      c.go(p, info.root, "");
      const note = skippedNote(info.skipped);
      if (note) c.toast("info", note);
    } catch (err) {
      c.toast("error", `Couldn’t open “${e.name}”. ${errMessage(err)}`);
    } finally {
      c.setBusy(null);
    }
  };

  /** One extraction as a row of the transfers panel; reloads the destination when it's done. */
  const runExtract = (label: string, job: ExtractJob, selectKey: string | null) => {
    const [t] = c.transfers.add([
      { kind: "extract", name: label, profileId: job.destProfileId, bucket: job.destRoot, key: selectKey ?? job.destDir, local: "", total: 0, run: (id) => archiveApi.extract(id, job) },
    ]);
    c.autoShowActivity();
    void c.transfers.whenFinished(t.id).then((done) => {
      if (done.state === "done") {
        if (selectKey) c.selectAfterReload(job.destProfileId, job.destRoot, selectKey);
        c.reloadIfShowing(job.destProfileId, job.destRoot);
      } else if (done.state === "error") c.toast("error", `Couldn’t extract “${label}”. ${(done.error ?? "").split("\n\n")[0]}`, { label: "Show", run: c.showActivity });
    });
  };

  /** Asks about names already at the destination: what to write where (null: cancelled). */
  const settle = async (pid: string, root: string, dir: string, names: { name: string; folder: boolean }[], verb: string) => {
    const targets = names.map((n) => ({ key: `${dir}${n.name}${n.folder ? "/" : ""}`, folder: n.folder }));
    c.setBusy("Checking for items with the same names…");
    let found: Set<string>;
    try {
      found = await findExisting(pid, root, targets);
    } catch {
      found = new Set();
    } finally {
      c.setBusy(null);
    }
    const clashes: Clash[] = targets.filter((t) => found.has(t.key)).map((t) => ({ key: t.key, name: baseName(t.key), folder: t.folder }));
    if (!clashes.length) return new Map<string, string | null>();
    const choices = await c.resolveConflicts(clashes, verb, placeLabel(pid, root, dir));
    if (!choices) return null;
    return applyChoices(pid, root, choices);
  };

  /** Archive files (outside one): each into a new folder named after it, next to it. */
  const extractFiles = async (list: Entry[]) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null) return;
    for (const e of list.filter((x) => x.kind === "file" && isArchiveName(x.name))) {
      const dir = entryParent(e);
      const stem = archiveStem(e.name);
      const decided = await settle(profile.id, bucket, dir, [{ name: stem, folder: true }], "Extracting");
      if (!decided) return;
      const target = `${dir}${stem}/`;
      const to = decided.has(target) ? decided.get(target) : target;
      if (to === null || to === undefined) continue;
      const folder = baseName(to);
      runExtract(e.name, { srcProfileId: profile.id, srcRoot: bucket, srcKey: e.key, destProfileId: profile.id, destRoot: bucket, destDir: dir, folder, overwrite: to === target && decided.has(target) }, `${dir}${folder}/`);
    }
  };

  /** Entries inside the archive on screen, into the folder the archive is in. */
  const extractEntries = async (list: Entry[]) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || !origin || !list.length) return;
    const dir = origin.key.slice(0, origin.key.lastIndexOf("/") + 1);
    // search results can come from several folders of the archive: one extraction per folder,
    // all into the same place, so two items with one name can't both go
    const groups = new Map<string, Entry[]>();
    for (const e of list) {
      const base = c.searching ? entryParent(e) : c.prefix;
      groups.set(base, [...(groups.get(base) ?? []), e]);
    }
    const names = list.map((e) => e.name);
    if (new Set(names).size < names.length) {
      c.toast("info", "Some of these have the same name. Extract them one folder at a time.");
      return;
    }
    const decided = await settle(origin.profileId, origin.root, dir, list.map((e) => ({ name: e.name, folder: e.kind === "folder" })), "Extracting");
    if (!decided) return;
    const archiveName = baseName(origin.key);
    for (const [base, picked] of groups) {
      const paths: string[] = [];
      const renames: Record<string, string> = {};
      let overwrite = false;
      for (const e of picked) {
        const target = `${dir}${e.name}${e.kind === "folder" ? "/" : ""}`;
        if (!decided.has(target)) paths.push(e.key);
        else {
          const to = decided.get(target);
          if (!to) continue;
          paths.push(e.key);
          if (to === target) overwrite = true;
          else renames[e.key] = baseName(to);
        }
      }
      if (!paths.length) continue;
      const label = paths.length === 1 ? baseName(paths[0]) : `${plural(paths.length, "item")} from ${archiveName}`;
      runExtract(label, { srcProfileId: profile.id, srcRoot: bucket, paths, base, renames, destProfileId: origin.profileId, destRoot: origin.root, destDir: dir, overwrite }, paths.length === 1 && groups.size === 1 ? `${dir}${renames[paths[0]] ?? baseName(paths[0])}${paths[0].endsWith("/") ? "/" : ""}` : null);
    }
  };

  /** "Extract to…": the copy dialog, with the archive's entries as what's copied. */
  const extractTo = async (list: Entry[]) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || !c.openMigration) return;
    if (inArchive) {
      c.openMigration({ profileId: profile.id, root: bucket, items: list.map((e) => ({ path: e.key, isDir: e.kind === "folder", size: e.kind === "folder" ? undefined : e.size })) }, "copy");
      return;
    }
    const e = list.find((x) => x.kind === "file" && isArchiveName(x.name));
    if (!e) return;
    const local = await c.ops.localCopy(e, "open");
    if (!local) return;
    c.setBusy(`Opening “${e.name}”…`);
    try {
      const info = await archiveApi.open(profile.id, bucket, e.key, local);
      c.openMigration({ profileId: info.id, root: info.root, items: [{ path: "", isDir: true }] }, "copy", { profileId: profile.id, root: bucket, dir: entryParent(e) });
    } catch (err) {
      c.toast("error", `Couldn’t open “${e.name}”. ${errMessage(err)}`);
    } finally {
      c.setBusy(null);
    }
  };

  /** "Compress": the selection into `name.zip` (one item) or `Archive.zip` next to it. */
  const compress = async (list: Entry[]) => {
    const { profile, bucket } = c;
    if (!profile || bucket == null || !list.length || inArchive) return;
    const dir = entryParent(list[0]);
    if (list.some((e) => entryParent(e) !== dir)) {
      c.toast("info", "Compress items from one folder at a time");
      return;
    }
    const want = `${dir}${list.length === 1 ? list[0].name : "Archive"}.zip`;
    let key = want;
    try {
      // taken: "Archive (1).zip" (freeKeys numbers from 1)
      if ((await findExisting(profile.id, bucket, [{ key: want, folder: false }])).has(want)) key = (await freeKeys(profile.id, bucket, [want])).get(want) ?? want;
    } catch {
      /* write it under the wanted name; the backend refuses to replace a file */
    }
    const name = baseName(key);
    const job = { profileId: profile.id, root: bucket, items: list.map((e) => e.key), destKey: key };
    const [t] = c.transfers.add([{ kind: "compress", name, profileId: profile.id, bucket, key, local: "", total: 0, run: (id) => archiveApi.compress(id, job) }]);
    c.autoShowActivity();
    const [pid, b] = [profile.id, bucket];
    void c.transfers.whenFinished(t.id).then((done) => {
      if (done.state === "done") {
        c.selectAfterReload(pid, b, key);
        c.reloadIfShowing(pid, b);
      } else if (done.state === "error") c.toast("error", `Couldn’t compress to “${name}”. ${(done.error ?? "").split("\n\n")[0]}`, { label: "Show", run: c.showActivity });
    });
  };

  /** Up from the top of an archive: the folder it's in, with the archive selected. */
  const upFromTop = (): boolean => {
    if (!origin || c.prefix) return false;
    const p = profileOf(origin.profileId);
    if (!p) return false;
    c.go(p, origin.root, origin.key.slice(0, origin.key.lastIndexOf("/") + 1), { selectKey: origin.key });
    return true;
  };

  /** The item menu's archive part. */
  const items = (list: Entry[]): (MenuItem | false)[] => {
    if (!c.profile || c.bucket == null || !list.length) return [];
    if (inArchive) {
      const where = origin ? destLabel(origin.key.slice(0, origin.key.lastIndexOf("/") + 1), origin.root, origin.profileId) : "";
      return [
        { type: "item", label: where ? `Extract to “${where}”` : "Extract here", icon: "archive", onClick: () => void extractEntries(list) },
        !!c.openMigration && { type: "item", label: "Extract to…", icon: "move", onClick: () => void extractTo(list) },
      ];
    }
    const archives = list.filter((e) => e.kind === "file" && isArchiveName(e.name));
    const all = archives.length === list.length;
    return [
      all && { type: "item", label: archives.length > 1 ? `Extract ${archives.length} archives here` : "Extract here", icon: "archive", onClick: () => void extractFiles(archives) },
      all && archives.length === 1 && !!c.openMigration && { type: "item", label: "Extract to…", icon: "move", onClick: () => void extractTo(archives) },
      !c.searching && { type: "item", label: list.length === 1 ? `Compress “${list[0].name}”` : `Compress ${list.length} items`, icon: "archive", onClick: () => void compress(list) },
    ];
  };

  return { inArchive, origin, open, extractFiles, extractEntries, extractTo, compress, upFromTop, items };
}

export type ArchiveOps = ReturnType<typeof makeArchiveOps>;

/** Menu items that change things: left out inside an archive, which opens read-only. */
const WRITES = /^(Cut|Duplicate|Rename|Delete|Move to|Paste|New folder|Upload|Sync this folder|Keep on this device|Kept on this device|Mount as drive|Copy or move to|Copy share link|Copy this folder to another|Copy everything to another)/;

export function readOnlyMenu<T>(items: T[]): T[] {
  return items.filter((i) => {
    const m = i as MenuItem | null;
    return !(m && typeof m === "object" && m.type === "item" && WRITES.test(m.label));
  });
}
