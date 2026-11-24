/** Small path helpers for the desktop file browser: local download paths and typed locations. */

export const joinPath = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;

/**
 * Makes an object key (or the part of it below a folder) safe to use as a path under a local
 * folder: no "..", ".", empty or drive-letter parts, so a key like `x/../../.zshrc` can't write
 * outside the folder the user picked. Returns "" when nothing usable is left.
 */
export function safeRelPath(rel: string): string {
  return rel
    .split(/[\\/]+/)
    .filter((p) => p && p !== "." && p !== ".." && !/^[a-zA-Z]:$/.test(p))
    .map((p) => p.replace(/[\0<>:"|?*]/g, "_"))
    .join("/");
}

/**
 * Whether a key's part below a folder already names a path under it as it is: no "..", ".",
 * empty or drive-letter parts, no "\" or NUL. Where Kybl reads an existing file (a synced copy)
 * instead of writing one, a key that isn't has no copy at all rather than a cleaned-up one.
 */
export function plainRelPath(rel: string): boolean {
  return !!rel && rel.split("/").every((p) => p && p !== "." && p !== ".." && !/[\\\0]/.test(p) && !/^[a-zA-Z]:$/.test(p));
}

/**
 * A remote file's name as one local file name, never a path: the last part `safeRelPath` leaves
 * (a `\` in a bucket, FTP or SFTP name is a separator on Windows and in `safeRelPath`, so
 * `Documents\evil.docx` must not become a `Documents/` folder, maybe a linked one). "" when
 * nothing usable is left.
 */
export function safeName(name: string): string {
  return safeRelPath(name).split("/").pop() ?? "";
}

/** "photo.jpg", 2 → "photo (2).jpg"; folders ("dir/") keep their trailing slash. */
export function numberedName(name: string, n: number): string {
  const folder = name.endsWith("/");
  const base = folder ? name.slice(0, -1) : name;
  const dot = folder ? -1 : base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})${folder ? "/" : ""}`;
}

/** Duplicate's names, like Finder: "photo copy.jpg", then "photo copy 2.jpg" (folders "Trip copy/"). */
export function copyName(name: string, n: number): string {
  const folder = name.endsWith("/");
  const base = folder ? name.slice(0, -1) : name;
  const dot = folder ? -1 : base.lastIndexOf(".");
  const tag = n === 1 ? " copy" : ` copy ${n}`;
  return dot > 0 ? `${base.slice(0, dot)}${tag}${base.slice(dot)}` : `${base}${tag}${folder ? "/" : ""}`;
}

/** Short stable hash, for per-object temp folders. */
export function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export type Location = { bucket: string | null; prefix: string };

/**
 * Reads what someone typed into Go to folder. Accepts `s3://bucket/path`, `/path` (from the
 * root of the bucket on screen), and `bucket/path` when the first part names a bucket of this
 * connection; anything else is a path from the root of the current bucket. A null bucket means
 * "stay in this bucket". The prefix has no leading slash and keeps a trailing one if typed.
 */
export function parseLocation(input: string, buckets: string[]): Location | null {
  let s = input.trim();
  if (!s) return null;
  const uri = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(s);
  if (uri) return { bucket: uri[1], prefix: tidy(uri[2]) };
  if (s.startsWith("/")) return { bucket: null, prefix: tidy(s) };
  s = tidy(s);
  const first = s.split("/")[0];
  if (buckets.includes(first)) return { bucket: first, prefix: s.slice(first.length + 1) };
  return { bucket: null, prefix: s };
}

function tidy(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}
