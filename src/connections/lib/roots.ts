/**
 * What a root (the `bucket` every command takes) is called on screen. For S3 the id is the
 * bucket's name, but other kinds have ids that aren't: this computer's folders are paths, Google
 * Drive's are drive ids, and a server's one root is "" (shown as the connection's name, since the
 * sidebar and breadcrumbs skip the root level there). One registry for the whole app, so the
 * sidebar, breadcrumbs, favorites, the Move dialog and the phone's headers all agree.
 */
import { useSyncExternalStore } from "react";
import { LOCAL_ID, api, type Capabilities, type RootInfo } from "../../core/api";
import { peekCaps } from "../../core/useCaps";
import { fixedRootName, rootIdLeaf } from "./fixedRoots";
import type { IconName } from "../../ui/components/Icons";
import type { ConnKind, Profile } from "../../core/types";

const names = new Map<string, Record<string, string>>();
const connNames = new Map<string, string>();
const connKinds = new Map<string, ConnKind>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Remembers the names of a connection's roots, from `api.listRoots`. */
export function setRootNames(profileId: string, roots: RootInfo[]) {
  names.set(profileId, Object.fromEntries(roots.map((r) => [r.id, r.name])));
  changed();
}

/** Keeps the connections' own names, which their single root ("") is shown as. */
export function setConnectionNames(profiles: Pick<Profile, "id" | "name" | "kind">[]) {
  let diff = false;
  for (const p of profiles) connKinds.set(p.id, p.kind ?? "s3");
  for (const p of profiles)
    if (connNames.get(p.id) !== p.name) {
      connNames.set(p.id, p.name);
      diff = true;
    }
  if (diff) changed();
}

/** A connection's own name (null when it isn't known yet), for the Activity log. */
export function connectionName(profileId: string): string | null {
  return connNames.get(profileId) ?? null;
}

/** A root's name on screen; the bucket name itself for S3 (and anything not listed yet). */
export function rootName(profileId: string, root: string): string {
  // "" is only ever the one root of a server or single-container connection
  if (root === "") return connNames.get(profileId) || names.get(profileId)?.[""] || "Files";
  const kind = connKinds.get(profileId);
  return names.get(profileId)?.[root] ?? fixedRootName(kind, root) ?? root;
}

/**
 * A root's name in a one-line "where" (Settings › Drives, Synced folders, Mount as drive): its
 * name when known, else the last part of a path id, else the id.
 */
export function rootLabel(profileId: string, root: string): string {
  const n = rootName(profileId, root);
  if (n !== root || !root) return n;
  return rootIdLeaf(root);
}

const asked = new Set<string>();
/**
 * Lists the roots of these connections once per run, for screens that show places on many
 * connections without browsing them (a shared drive's id has no name until then). Quiet on failure.
 */
export function loadRootNames(profiles: Pick<Profile, "id" | "kind">[]) {
  for (const p of profiles) {
    if (!usesListRoots(p) || names.has(p.id) || asked.has(p.id)) continue;
    asked.add(p.id);
    api.listRoots(p.id).then(
      (roots) => setRootNames(p.id, roots),
      () => asked.delete(p.id),
    );
  }
}

/** Phones and tablets: "On this phone"; computers: "This Mac" (or this PC). */
const ON_PHONE = typeof navigator !== "undefined" && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** The icon of this device as a connection: a phone on phones, a laptop on computers. */
export const deviceIcon: IconName = ON_PHONE ? "phone" : "laptop";

const SERVER_KINDS: ConnKind[] = ["ftp", "sftp", "webdav"];
const CONTAINER_KINDS: ConnKind[] = ["azblob", "gcs"];

/**
 * A root's icon, the same in the sidebar, breadcrumbs, the phone's lists and every picker: a
 * bucket for S3 buckets and storage containers, a cloud for cloud drives (My Drive, Dropbox), a
 * folder for this device's folders, and a server for a server's one root.
 */
export function rootIcon(profileId: string, _root?: string): IconName {
  const caps = peekCaps(profileId);
  const kind = connKinds.get(profileId);
  if (profileId === LOCAL_ID || kind === "local" || caps?.localPaths) return "folder";
  const mode = caps?.roots ?? (kind ? (KIND_ROOTS[kind] ?? "buckets") : "buckets");
  if (mode === "buckets") return "bucket";
  if (mode === "drives") return "cloud";
  if (kind && SERVER_KINDS.includes(kind)) return "server";
  if (kind && CONTAINER_KINDS.includes(kind)) return "bucket";
  return "cloud";
}

/** `rootName`, re-rendering the caller whenever names arrive or change. */
export function useRootName(): (profileId: string, root: string) => string {
  // a new function per change, so memoized children that take it re-render too
  return useSyncExternalStore(subscribe, () => current);
}
let current = (p: string, r: string) => rootName(p, r);
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
listeners.add(() => {
  current = (p: string, r: string) => rootName(p, r);
});

/**
 * How a connection's roots are laid out, before its capabilities are known too: servers and
 * single containers have one ("single": no root level), drives a few named ones.
 */
export function rootsMode(p: Pick<Profile, "kind">, caps?: Capabilities | null): Capabilities["roots"] {
  if (caps) return caps.roots;
  return KIND_ROOTS[p.kind ?? "s3"] ?? "buckets";
}
const KIND_ROOTS: Partial<Record<ConnKind, Capabilities["roots"]>> = {
  s3: "buckets",
  local: "drives",
  gdrive: "drives",
  onedrive: "drives",
  ftp: "single",
  sftp: "single",
  webdav: "single",
  dropbox: "single",
  box: "single",
  azblob: "single",
  gcs: "single",
};

/** Connections whose roots come from `listRoots` (S3 keeps `listBuckets`, which may name a bucket by hand). */
export const usesListRoots = (p: Pick<Profile, "kind" | "id">) => !!p.kind && p.kind !== "s3";

/* ------------------------------------------------------------ this computer: roots inside roots */

/** this computer's roots are paths, and one can sit inside another (Documents in Home in the disk) */
function isLocal(profileId: string): boolean {
  return profileId === LOCAL_ID || connKinds.get(profileId) === "local" || !!peekCaps(profileId)?.localPaths;
}
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
/** `path` relative to `dir` when it's inside it (or is it: ""), else null */
function inside(dir: string, path: string): string | null {
  const d = norm(dir);
  const p = norm(path);
  if (p === d) return "";
  const base = d === "/" ? "/" : d + "/";
  return p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length) : null;
}

/**
 * One of this computer's roots opened at its top (Documents): the closest other root holding it
 * (Home) and where it sits there, so ".." and Up go on to its real parent folder. Null at the
 * top of the disk, and on every other kind of connection.
 */
export function localParent(profileId: string, root: string): { root: string; prefix: string } | null {
  if (!isLocal(profileId)) return null;
  let best: { root: string; rel: string } | null = null;
  for (const r of Object.keys(names.get(profileId) ?? {})) {
    if (r === root) continue;
    const rel = inside(r, root);
    if (rel && (!best || norm(r).length > norm(best.root).length)) best = { root: r, rel };
  }
  if (!best) return null;
  const parts = best.rel.split("/").filter(Boolean);
  parts.pop();
  return { root: best.root, prefix: parts.length ? parts.join("/") + "/" : "" };
}

/**
 * The sidebar folder to light up for a place on this computer: the closest root holding it, so
 * Home › Documents lights up Documents. The root itself on every other kind of connection.
 */
export function closestLocalRoot(profileId: string, root: string, prefix: string): string {
  if (!isLocal(profileId)) return root;
  const abs = norm(root) + (prefix ? (norm(root) === "/" ? "" : "/") + prefix.replace(/\/+$/, "") : "");
  let best = root;
  let bestLen = -1;
  for (const r of Object.keys(names.get(profileId) ?? {})) {
    if (inside(r, abs) != null && norm(r).length > bestLen) {
      best = r;
      bestLen = norm(r).length;
    }
  }
  return best;
}
