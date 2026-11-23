/**
 * Pure: how items are written for people, per kind of connection, so the desktop and the phone
 * say the same thing (no imports, so `node --test` can load it).
 */

/** What kind of address a connection's items have. */
export type AddressKind = "s3" | "local" | "other";

/**
 * `s3`: S3 buckets (an s3:// URI means something elsewhere). `local`: this computer's folders
 * (roots are absolute paths). `other`: servers, drives and containers (a path inside the root).
 */
export function addressKind(o: { roots?: string | null; localPaths?: boolean | null; kind?: string | null }): AddressKind {
  if (o.localPaths || o.kind === "local") return "local";
  if (o.roots ? o.roots === "buckets" : !o.kind || o.kind === "s3") return "s3";
  return "other";
}

/** `rel` inside the folder `root`, with the root's own separator (a Windows root keeps "\"). */
export function joinLocal(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const r = rel.replace(/\/+$/, "").replace(/^\/+/, "");
  if (!r) return root;
  const base = root.endsWith("/") || root.endsWith("\\") ? root : root + sep;
  return base + (sep === "\\" ? r.replace(/\//g, "\\") : r);
}

/**
 * One item's address as text, for the clipboard: `s3://bucket/key` on S3, the absolute path on
 * this computer, and the path inside the root elsewhere (`/folder/file`, or `Root/folder/file`
 * on a connection with named roots).
 */
export function itemAddress(kind: AddressKind, root: string, key: string, rootLabel?: string): string {
  if (kind === "s3") return `s3://${root}/${key}`;
  if (kind === "local") return joinLocal(root, key);
  const path = key.replace(/\/+$/, "");
  return root && rootLabel ? `${rootLabel}/${path}` : `/${path}`;
}

/**
 * The words of a Delete confirmation. `trash`: the connection keeps deleted items where they
 * can be restored (Drive, OneDrive, Dropbox, this computer with "Move to Trash" on). A permanent
 * delete's `text` goes on with "and cannot be undone".
 */
export function deleteWording(o: { what: string; count: number; folders: boolean; trash: boolean; local: boolean; windows?: boolean }) {
  const them = o.count === 1 ? "it" : "them";
  if (o.trash) {
    const bin = o.local && o.windows ? "Recycle Bin" : "Trash";
    return {
      title: `Move ${o.what} to the ${bin}?`,
      label: `Move to ${bin}`,
      danger: false,
      text: `${o.folders ? "Folders go with everything inside them. " : ""}You can restore ${them} from the ${o.local ? bin : "trash of this drive"}.`,
    };
  }
  return {
    title: `Delete ${o.what}?`,
    label: "Delete",
    danger: true,
    text: `${o.folders ? "Folders are deleted with everything inside them. " : ""}This permanently removes ${them}`,
  };
}

/** What Go to folder shows: the path it starts with, an example, and a line on what it takes. */
export function goToText(kind: AddressKind, root: string, prefix: string, rootLabel: string) {
  if (kind === "local")
    return {
      initial: joinLocal(root, prefix),
      placeholder: root.includes("\\") && !root.includes("/") ? "C:\\Users\\you\\Pictures" : "/Users/you/Pictures",
      hint: "Type a full path on this computer.",
    };
  if (kind === "s3")
    return {
      initial: `/${prefix}`,
      placeholder: "/photos/2026 or s3://bucket/photos",
      hint: `Start with “/” for a path in ${rootLabel}, or paste an address like s3://bucket/folder. A bucket name at the start opens that bucket.`,
    };
  return { initial: `/${prefix}`, placeholder: "/photos/2026", hint: `A path in ${rootLabel}, starting with “/”.` };
}

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";

/** An absolute path on this computer ("/Users/…", "C:\…", "\\server\…"). */
export const isAbsolutePath = (s: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(s.trim());

/**
 * An absolute path typed on this computer, as the closest of `roots` (folder paths) holding it
 * and the path inside that root (no trailing "/"). Null when no root holds it.
 */
export function resolveLocalPath(input: string, roots: string[]): { root: string; prefix: string } | null {
  const p = slashes(input.trim());
  let best: { root: string; prefix: string; len: number } | null = null;
  for (const r of roots) {
    const d = slashes(r);
    const base = d === "/" ? "/" : d + "/";
    const rel = p.toLowerCase() === d.toLowerCase() ? "" : p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length) : null;
    if (rel != null && (!best || d.length > best.len)) best = { root: r, prefix: rel, len: d.length };
  }
  return best && { root: best.root, prefix: best.prefix };
}
