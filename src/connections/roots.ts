/**
 * What a root (the `bucket` every command takes) is called on screen. For S3 the id is the
 * bucket's name, but other kinds have ids that aren't: this computer's folders are paths, Google
 * Drive's are drive ids, and a server's one root is "" (shown as the connection's name, since the
 * sidebar and breadcrumbs skip the root level there). One registry for the whole app, so the
 * sidebar, breadcrumbs, favorites, the Move dialog and the phone's headers all agree.
 */
import { useSyncExternalStore } from "react";
import { LOCAL_ID, type Capabilities, type RootInfo } from "../api";
import { peekCaps } from "../useCaps";
import type { IconName } from "../Icons";
import type { ConnKind, Profile } from "../types";

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

/** A root's name on screen; the bucket name itself for S3 (and anything not listed yet). */
export function rootName(profileId: string, root: string): string {
  // "" is only ever the one root of a server or single-container connection
  if (root === "") return connNames.get(profileId) || names.get(profileId)?.[""] || "Files";
  return names.get(profileId)?.[root] ?? root;
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
