/**
 * "Show in Finder" and "Open with ▸" for an item: files and folders of this computer's own disk,
 * anything inside a folder kept on this device by sync (its copy on disk), and files of any other
 * connection (downloaded to a temporary copy first, like Open). Folders that only exist online
 * get neither: nobody wants a whole folder downloaded to look at it in an editor.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMessage, type AppChoice } from "../api";
import { appsFor } from "./appsFor";
import { asExport } from "../connections/native";
import { peekSyncMappings } from "../sync";
import type { MenuItem, Toast } from "../components/Dialogs";
import type { Entry } from "../types";
import type { FileOps } from "./fileOps";
import { joinPath } from "./paths";
import { openOwnFile } from "./openGuard";

const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
export const OS: "mac" | "win" | "linux" = /Mac/.test(UA) ? "mac" : /Win/.test(UA) ? "win" : "linux";

/** What the system's file manager is called here. */
export const SHOW_IN_FILES = OS === "mac" ? "Show in Finder" : OS === "win" ? "Show in Explorer" : "Show in Files";

// ------------------------------------------------------------ where the item is on this computer

/**
 * The copy of `key` in a folder kept on this device by sync (any direction: the folder on disk
 * holds it), from the deepest mapping that covers it. Null when no mapping does.
 */
export function syncedPath(profileId: string, bucket: string, key: string): string | null {
  const m = peekSyncMappings()
    .filter((m) => m.profileId === profileId && m.bucket === bucket && key.startsWith(m.prefix) && m.localPath)
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!m) return null;
  const rel = key.slice(m.prefix.length).replace(/\/+$/, "");
  return rel ? joinPath(m.localPath, rel) : m.localPath;
}

export type OpenInContext = {
  profileId: string;
  bucket: string;
  /** the connection is this computer's own disk (`localPaths`) */
  onDisk: boolean;
  ops: Pick<FileOps, "openWith" | "okToRun" | "openPath">;
  toast: (kind: Toast["kind"], text: string) => void;
};

/**
 * "Show in Finder" and "Open with ▸" for one item, or nothing when they don't apply. The app list
 * starts loading right away, so it is usually there by the time the submenu opens.
 */
export function openInItems(c: OpenInContext, e: Entry): MenuItem[] {
  const folder = e.kind === "folder";
  const synced = c.onDisk ? null : syncedPath(c.profileId, c.bucket, e.key);
  // a Google Doc opens as what it downloads as (PDF, DOCX…); one with no export can't open
  const typeName = folder ? e.name : asExport(e)?.name;
  if (folder && !c.onDisk && !synced) return [];
  if (!typeName) return [];

  /** The item's own path on this computer (disk connection or synced copy), else null. */
  const ownPath = async (): Promise<string | null> => {
    if (c.onDisk) return api.localPath(c.profileId, c.bucket, e.key.replace(/\/+$/, ""));
    return synced;
  };

  const run = async (app: string | null) => {
    try {
      // files of the disk connection: Open's own way finds them in place
      if (!folder && c.onDisk) return void (await c.ops.openWith(e, app));
      // a synced file came from the connection: a program in it is asked about, as on Open
      if (!folder && !(await c.ops.okToRun(e, app))) return;
      const path = await ownPath();
      if (path) {
        try {
          // a synced folder opens as a folder (exec bits aren't synced, so an `x.app` can't launch)
          if (folder) await openOwnFile(path, app);
          else await c.ops.openPath(path, app, e, true);
          return;
        } catch (err) {
          // a synced file not on disk yet (or ignored by the sync): fetch it like any other
          if (folder || c.onDisk) throw err;
        }
      }
      if (!folder) await c.ops.openWith(e, app, true);
    } catch (err) {
      c.toast("error", errMessage(err));
    }
  };

  /** macOS "Other…": any app, picked in a file dialog. */
  const pickApp = async () => {
    const app = await openDialog({ title: "Choose an app", defaultPath: "/Applications", filters: [{ name: "Applications", extensions: ["app"] }] }).catch(() => null);
    if (typeof app === "string") await run(app);
  };

  const build = (apps: AppChoice[]): MenuItem[] => {
    const toItem = (a: AppChoice): MenuItem => ({ type: "item", label: a.name, image: a.icon ?? undefined, icon: a.icon ? undefined : "external", hint: a.isDefault ? "default" : undefined, onClick: () => void run(a.path) });
    const def = apps.filter((a) => a.isDefault);
    const rest = apps.filter((a) => !a.isDefault);
    const other: MenuItem | false =
      OS === "mac" ? { type: "item", label: "Other…", icon: "more", onClick: () => void pickApp() } : OS === "win" && !folder && { type: "item", label: "Choose another app…", icon: "more", onClick: () => void run(null) };
    const out: (MenuItem | false)[] = [...def.map(toItem), def.length > 0 && rest.length > 0 && { type: "sep" }, ...rest.map(toItem), !!other && apps.length > 0 && { type: "sep" }, other];
    return out.filter((x): x is MenuItem => !!x);
  };

  // warm the list now; a failure shows as an empty submenu
  const first = appsFor(typeName, folder);
  if (!Array.isArray(first)) first.catch(() => {});

  const reveal = async () => {
    try {
      const path = await ownPath();
      if (path) await api.revealLocal(path);
      else c.toast("info", "That isn’t on this computer.");
    } catch (err) {
      c.toast("error", errMessage(err));
    }
  };

  const items: (MenuItem | false)[] = [
    (c.onDisk || !!synced) && { type: "item", label: SHOW_IN_FILES, icon: "reveal", onClick: () => void reveal() },
    {
      type: "submenu",
      label: "Open with",
      icon: "external",
      items: () => {
        const got = appsFor(typeName, folder);
        return Array.isArray(got) ? build(got) : got.then(build, () => build([]));
      },
    },
  ];
  return items.filter((x): x is MenuItem => !!x);
}
