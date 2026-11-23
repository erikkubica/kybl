/**
 * The "drive" part of a place's context menu (a connection, a root, a folder): "Mount as drive…"
 * while the place isn't one, and once it is, what you do with a drive (Show drive in Finder,
 * Eject) under a heading that says it's mounted. Shared by the sidebar and the file list so both
 * say the same thing. "Show drive in", not "Show in": a folder's menu has its own Show in Finder.
 */
import { errMessage, mountApi, type MountInfo } from "../api";
import type { MenuItem } from "../components/Dialogs";
import { fileManagerName, reloadMounts } from "./useMounts";
import "./mount.css";

type Toast = (kind: "success" | "error" | "info", text: string) => void;

/** Finder's word for taking a drive away, else the plain one. */
export function ejectLabel(): string {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent) ? "Eject" : "Unmount";
}

/** What the sidebar's drive badge says about a drive, or null when it shows none. */
export function driveBadgeTitle(m: MountInfo): string | null {
  if (m.state === "mounted") return `Mounted as the drive “${m.name}”`;
  if (m.state === "mounting") return `Mounting “${m.name}”…`;
  if (m.state === "error") return m.error?.startsWith("Another copy of Kybl") ? `Another copy of Kybl has the drive “${m.name}”` : `The drive “${m.name}” couldn't be mounted`;
  return null;
}

async function run(fn: () => Promise<unknown>, toast: Toast) {
  try {
    await fn();
  } catch (e) {
    toast("error", errMessage(e));
  } finally {
    void reloadMounts();
  }
}

export const showDrive = (m: MountInfo, toast: Toast) => run(() => mountApi.mountReveal(m.id), toast);

export const ejectDrive = (m: MountInfo, toast: Toast) =>
  run(async () => {
    const r = await mountApi.mountEject(m.id);
    if (r.state === "unmounted") toast("info", `“${m.name}” was ${ejectLabel() === "Eject" ? "ejected" : "unmounted"}`);
  }, toast);

/** Mount a drive that failed once more; a refusal (another Kybl copy has the drives, …) is toasted. */
export async function retryDrive(id: string, toast: Toast, reveal = false) {
  const r = await mountApi.mountRetry(id);
  if (r.state === "mounted") {
    if (!reveal) return;
    toast("success", `“${r.name}” is a drive in ${fileManagerName()} again`);
    mountApi.mountReveal(r.id).catch(() => {});
  } else if (r.error) toast("error", r.error.split("\n\n")[0]);
}

const mountAgain = (m: MountInfo, toast: Toast) => run(() => retryDrive(m.id, toast, true), toast);

/**
 * The menu items for a place's drive. `m` is the drive showing exactly this place (`findMount`);
 * `ask` opens "Mount as drive…". The mounted states come as their own group between separators
 * (the menus run through `tidyMenu`, which drops doubled ones).
 */
export function driveItems(m: MountInfo | undefined, o: { ask: () => void; toast: Toast; openSettings?: () => void }): MenuItem[] {
  const fm = fileManagerName();
  const settings: MenuItem[] = o.openSettings ? [{ type: "item", label: "Drive settings…", icon: "settings", onClick: o.openSettings }] : [];
  switch (m?.state) {
    case "mounted":
      return [
        { type: "sep" },
        { type: "label", label: m.name ? `Mounted as drive “${m.name}”` : "Mounted as drive" },
        { type: "item", label: `Show drive in ${fm}`, icon: "reveal", onClick: () => void showDrive(m, o.toast) },
        { type: "item", label: ejectLabel(), icon: "eject", onClick: () => void ejectDrive(m, o.toast) },
        { type: "sep" },
      ];
    case "mounting":
      return [{ type: "sep" }, { type: "label", label: "Mounting as drive…" }, ...settings, { type: "sep" }];
    case "error":
      return [
        { type: "sep" },
        { type: "label", label: "Drive couldn't be mounted" },
        { type: "item", label: "Try mounting again", icon: "retry", onClick: () => void mountAgain(m, o.toast) },
        ...settings,
        { type: "sep" },
      ];
    // kept in Settings › Drives but not mounted (ejected): mount the same drive again
    case "unmounted":
      return [{ type: "item", label: "Mount as drive", icon: "server", onClick: () => void mountAgain(m, o.toast) }];
    default:
      return [{ type: "item", label: "Mount as drive…", icon: "server", onClick: o.ask }];
  }
}
