/**
 * Mirror: deploy a folder to another place (or pull one down), with a dry run first. What the
 * hosts need: the sheet, menu items for a folder, and the small API a command palette can use
 * (`listMirrors`, `runMirror(id, { dryRun })`).
 */
import { errMessage, LOCAL_ID } from "../core/api";
import { deviceName } from "../jobs/components/LocationPicker";
import type { MenuItem } from "../ui/components/Dialogs";
import type { Dialogs } from "../shell/hooks/useDialogs";
import type { Profile } from "../core/types";
import { MirrorSheet, type MirrorSheetProps } from "./components/MirrorSheet";
import { planIsEmpty } from "./lib/plan";
import { previewMirror, startMirror } from "./lib/run";
import { markRun, mirrorsAt, type MirrorEnd, type SavedMirror } from "./lib/store";

export { listMirrors, getMirror, saveMirror, deleteMirror, useMirrors, type SavedMirror, type MirrorEnd, type MirrorConfig } from "./lib/store";
export { runMirror, previewMirror, startMirror, type MirrorPreview } from "./lib/run";
export { MirrorSheet } from "./components/MirrorSheet";

/** One end of a mirror from what a pane shows: its connection, root and folder. */
export function placeEnd(profile: Pick<Profile, "id" | "name"> | null | undefined, root: string | null | undefined, dir: string, rootName?: string | null): MirrorEnd | null {
  if (!profile || root == null) return null;
  return { profileId: profile.id, root, dir, connectionName: profile.id === LOCAL_ID ? deviceName() : profile.name, rootName: rootName ?? root };
}

/** Opens the Mirror sheet over everything (the shared dialogs host it). */
export function openMirror(dialogs: Pick<Dialogs, "show">, props: Omit<MirrorSheetProps, "onClose">) {
  dialogs.show((close) => <MirrorSheet {...props} onClose={close} />);
}

/**
 * A saved mirror in one click: its dry run, then straight to work when it only copies. One that
 * would delete something opens the sheet on that list to confirm first.
 */
export async function quickRun(m: SavedMirror, dialogs: Pick<Dialogs, "show" | "toast">, onStarted?: (jobId: string) => void) {
  dialogs.toast("info", `Checking “${m.name}”…`);
  try {
    const preview = await previewMirror(m);
    const p = preview.plan;
    if (planIsEmpty(p)) {
      markRun(m.id);
      return dialogs.toast("success", `“${m.name}” is up to date: nothing to copy.`);
    }
    if (p.remove.length || p.removeDirs.length || p.blocked.length) return openMirror(dialogs, { saved: m, preview, onStarted });
    const id = await startMirror(preview, m.name);
    markRun(m.id);
    const what = p.upload.length ? `${p.upload.length.toLocaleString()} ${p.upload.length === 1 ? "file" : "files"}` : "new folders";
    dialogs.toast("success", `“${m.name}”: copying ${what}.`);
    if (id) onStarted?.(id);
  } catch (e) {
    dialogs.toast("error", `“${m.name}”: ${errMessage(e)}`);
  }
}

/**
 * A folder's Mirror items: "Mirror to…", and each saved mirror from this folder (a submenu when
 * there are several).
 */
export function mirrorItems(at: MirrorEnd | null, dialogs: Pick<Dialogs, "show" | "toast">, onStarted?: (jobId: string) => void): MenuItem[] {
  if (!at) return [];
  const saved = mirrorsAt(at);
  const run = (m: SavedMirror): MenuItem => ({ type: "item", label: saved.length > 2 ? m.name : `Run “${m.name}”`, icon: "play", onClick: () => void quickRun(m, dialogs, onStarted) });
  return [
    { type: "item", label: "Mirror to…", icon: "upload", onClick: () => openMirror(dialogs, { src: at, onStarted }) },
    ...(saved.length > 2 ? [{ type: "submenu" as const, label: "Run a saved mirror", icon: "play" as const, items: () => saved.map(run) }] : saved.map(run)),
  ];
}

type PaneLike = { profile: Pick<Profile, "id" | "name"> | null; bucket: string | null; prefix: string; bucketLabel?: string | null };

/** "Mirror to the other pane…": this pane's folder to the other's (the sheet can swap them). */
export function mirrorToPane(from: PaneLike, to: PaneLike | null, dialogs: Pick<Dialogs, "show" | "toast">, onStarted?: (jobId: string) => void): MenuItem {
  const src = placeEnd(from.profile, from.bucket, from.prefix, from.bucketLabel);
  const dst = to ? placeEnd(to.profile, to.bucket, to.prefix, to.bucketLabel) : null;
  return { type: "item", label: "Mirror to the other pane…", icon: "upload", disabled: !src || !dst, onClick: () => openMirror(dialogs, { src, dst, onStarted }) };
}
