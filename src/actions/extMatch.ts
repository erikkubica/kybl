/** Pure: a custom action's "Extensions" box and the names it takes (no imports, so `node --test` can load it). */

/** "jpg, .PNG, tar.gz" → ["jpg", "png", "tar.gz"] */
export const extList = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);

/**
 * Whether `name` ends in one of `exts` ("tar.gz" takes "backup.tar.gz", "gz" takes it too). A name
 * that is only the extension (".gz", a hidden file) has none.
 */
export function hasExt(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((x) => lower.length > x.length + 1 && lower.endsWith(`.${x}`));
}
