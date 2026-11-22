/** Name clashes when moving or copying on the phone: which targets exist, and free names for "Keep both". */
import { api } from "../api";

export type Target = { from: string; to: string; isPrefix: boolean };
export type ClashChoice = "replace" | "skip" | "keep";

/** The targets that already exist in the bucket. */
export async function findClashes(profileId: string, bucket: string, items: Target[]): Promise<Set<string>> {
  const keys = items.filter((t) => !t.isPrefix).map((t) => t.to);
  const prefixes = items.filter((t) => t.isPrefix).map((t) => t.to);
  const found = new Set<string>();
  // a few thousand per call at most
  for (let i = 0; i < Math.max(keys.length, prefixes.length); i += 2000) {
    const r = await api.existing(profileId, bucket, keys.slice(i, i + 2000), prefixes.slice(i, i + 2000));
    for (const k of r.keys) found.add(k);
    for (const p of r.prefixes) found.add(p);
  }
  return found;
}

/** "photo.jpg" → "photo (n).jpg"; "Trip/" → "Trip (n)/". */
function numbered(to: string, isPrefix: boolean, n: number): string {
  if (isPrefix) return `${to.replace(/\/$/, "")} (${n})/`;
  const slash = to.lastIndexOf("/") + 1;
  const name = to.slice(slash);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${to.slice(0, slash)}${stem} (${n})${ext}`;
}

/** A name next to `to` that is neither in the bucket nor already handed out in `taken`. */
export async function freeName(profileId: string, bucket: string, t: Target, taken: Set<string>): Promise<string> {
  for (let start = 1; start < 1000; start += 8) {
    const tries = Array.from({ length: 8 }, (_, i) => numbered(t.to, t.isPrefix, start + i)).filter((c) => !taken.has(c));
    const r = await api.existing(profileId, bucket, t.isPrefix ? [] : tries, t.isPrefix ? tries : []);
    const used = new Set([...r.keys, ...r.prefixes]);
    const free = tries.find((c) => !used.has(c));
    if (free) {
      taken.add(free);
      return free;
    }
  }
  throw new Error("Couldn't find a free name");
}

/** Applies the choice: drops clashing items ("skip") or renames them ("keep"). */
export async function resolveClashes(profileId: string, bucket: string, items: Target[], clashing: Set<string>, choice: ClashChoice): Promise<Target[]> {
  if (choice === "replace") return items;
  if (choice === "skip") return items.filter((t) => !clashing.has(t.to));
  const taken = new Set(items.map((t) => t.to));
  const out: Target[] = [];
  for (const t of items) out.push(clashing.has(t.to) ? { ...t, to: await freeName(profileId, bucket, t, taken) } : t);
  return out;
}
