/**
 * What is being copied, in words: the names of where it comes from, how much it is (folders are
 * counted in the background and the count stops when the caller goes away), and the phrases the
 * summary sentence and the job title are made of.
 */
import { useEffect, useState } from "react";
import { api, LOCAL_ID, type RootInfo } from "../api";
import { baseName, formatBytes, plural } from "../format";
import type { Profile } from "../types";
import { deviceName, locLabel } from "./LocationPicker";

export type MigrationItem = { path: string; isDir: boolean; size?: number };
export type MigrationSource = {
  profileId: string;
  root: string;
  /** a folder with path "" is everything in the root */
  items: MigrationItem[];
  /**
   * "Everything in this connection": one job per root, each into a folder of its own name at the
   * destination. When set, `root` and `items` are not used.
   */
  roots?: { id: string; name: string }[];
};

export const parentDir = (path: string) => path.replace(/\/$/, "").replace(/[^/]*$/, "");
const itemName = (i: MigrationItem, rootName: string) => (i.path === "" ? rootName : baseName(i.path));

export function useSourceSummary(source: MigrationSource, verb: "copy" | "move") {
  const [srcNames, setSrcNames] = useState<{ connection: string; root: string } | null>(null);
  // `uncounted`: folders too many to count up front, so the amount says "plus N folders"
  const [sizes, setSizes] = useState<{ bytes: number; files: number; counting: boolean; uncounted?: number }>({ bytes: 0, files: 0, counting: false });
  const multi = !!source.roots && source.roots.length > 0;

  // names of where the items come from
  useEffect(() => {
    let live = true;
    const conn: Promise<string> =
      source.profileId === LOCAL_ID
        ? Promise.resolve(deviceName())
        : api.listProfiles().then((ps: Profile[]) => ps.find((p) => p.id === source.profileId)?.name ?? "this connection");
    const root = multi
      ? Promise.resolve("")
      : api
          .listRoots(source.profileId)
          .then((rs: RootInfo[]) => rs.find((r) => r.id === source.root)?.name ?? source.root)
          .catch(() => source.root);
    Promise.all([conn, root]).then(([connection, root]) => live && setSrcNames({ connection, root }), () => {});
    return () => {
      live = false;
    };
  }, [source.profileId, source.root, multi]);

  // how much it is: file sizes as given, folders (or whole roots) counted
  useEffect(() => {
    const files = multi ? [] : source.items.filter((i) => !i.isDir);
    const folders: { root: string; path: string }[] = multi
      ? source.roots!.map((r) => ({ root: r.id, path: "" }))
      : source.items.filter((i) => i.isDir).map((i) => ({ root: source.root, path: i.path }));
    const base = { bytes: files.reduce((s, i) => s + (i.size ?? 0), 0), files: files.length };
    if (folders.length === 0 || folders.length > 20) {
      setSizes({ ...base, counting: false, uncounted: multi ? 0 : folders.length });
      return;
    }
    setSizes({ ...base, counting: true });
    let live = true;
    const ops = folders.map(() => `jobs-size-${Math.random().toString(36).slice(2)}`);
    Promise.all(folders.map((f, i) => api.folderSize(source.profileId, f.root, f.path, ops[i])))
      .then((rs) => live && setSizes({ bytes: base.bytes + rs.reduce((s, r) => s + r.bytes, 0), files: base.files + rs.reduce((s, r) => s + r.objects, 0), counting: false }))
      // the folders couldn't be counted: say so, rather than a total that leaves them out
      .catch(() => live && setSizes({ ...base, counting: false, uncounted: multi ? 0 : folders.length }));
    return () => {
      live = false;
      for (const op of ops) api.cancelTransfer(op).catch(() => {});
    };
  }, [source, multi]);

  const connectionName = srcNames?.connection ?? "";
  const rootName = srcNames?.root || source.root;
  const whole = !multi && source.items.length === 1 && source.items[0].path === "";
  /** "everything in media-prod", "“photos”", "3 items" */
  const what = multi
    ? `everything in ${connectionName || "this connection"}`
    : source.items.length === 1
      ? whole
        ? `everything in ${rootName}`
        : `“${itemName(source.items[0], rootName)}”`
      : plural(source.items.length, "item");
  const count = [
    multi ? `${source.roots!.length} ${source.roots!.length === 1 ? "bucket" : "buckets"}` : "",
    sizes.files > 0 ? `${sizes.files.toLocaleString()} ${sizes.files === 1 ? "file" : "files"}` : "",
    sizes.bytes > 0 || sizes.files > 0 ? `${formatBytes(sizes.bytes)}${sizes.counting ? " so far" : ""}` : "",
    sizes.uncounted ? `${sizes.files > 0 ? "plus " : ""}${plural(sizes.uncounted, "folder")}` : "",
  ].filter(Boolean);
  /** " (12 files, 40 MB)" or "" while nothing is known */
  const amount = count.length ? ` (${count.join(", ")})` : "";
  // the folder the items are in (they all come from one folder)
  const fromDir = !multi && source.items[0]?.path ? parentDir(source.items[0].path) : "";
  const from = !srcNames ? "" : multi ? connectionName : locLabel({ connectionName, rootName, dir: fromDir });
  const Verb = verb === "move" ? "Move" : "Copy";
  return { srcNames, sizes, multi, whole, what, amount, from, Verb, connectionName, rootName };
}

/** A job's title: "“photos” to AWS production", "Everything in media-prod to Backups". */
export const jobTitle = (what: string, to: string) => `${what.charAt(0).toUpperCase()}${what.slice(1)} to ${to}`;
