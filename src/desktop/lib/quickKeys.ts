/**
 * Pure (no imports, so `node --test` can load it): keys the file list would act on by itself
 * (move its cursor, clear or change the selection) that Quick Look holds back while it is up, so
 * the selection stays on the file being previewed. Shortcuts with ⌘/Ctrl still reach the app.
 */
export function listKeyHeldByPreview(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  if (e.metaKey || e.ctrlKey) return false;
  if (e.key === "Home" || e.key === "End" || e.key === "PageUp" || e.key === "PageDown") return true;
  // type-to-select: a letter, number or symbol jumps to a name
  return e.key.length === 1 && !e.altKey;
}
