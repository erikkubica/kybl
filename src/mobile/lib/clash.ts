/**
 * Name clashes on the phone (move, copy, rename, uploads): which targets exist, and free names for
 * "Keep both". The checks themselves are the desktop's (chunked `existing` calls, batched free-name
 * search); this only adapts them to the phone's move targets.
 */
import { findExisting, freeKeys } from "../../desktop/lib/conflicts";

/** `from` is a key (move/copy) or a local path (upload); `to` is the key it will be written to. */
export type Target = { from: string; to: string; isPrefix: boolean };
/** "replace" merges for a folder: files with the same names inside are replaced. */
export type ClashChoice = "replace" | "skip" | "keep";

/** The targets that already exist in the bucket. Throws when the storage couldn't be asked. */
export function findClashes(profileId: string, bucket: string, items: Target[]): Promise<Set<string>> {
  return findExisting(
    profileId,
    bucket,
    items.map((t) => ({ key: t.to, folder: t.isPrefix })),
  );
}

/**
 * The items that would replace something: the target exists in the bucket, or an earlier item
 * of the same batch writes it too (two shared files both called "image.jpg", or two search
 * results with the same name moved into one folder).
 */
export function clashIndices(items: Target[], existing: Set<string>): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  items.forEach((t, i) => {
    if (existing.has(t.to) || seen.has(t.to)) out.push(i);
    seen.add(t.to);
  });
  return out;
}

/** Applies the choice: drops clashing items ("skip") or gives them free names ("keep"). */
export async function resolveClashes<T extends Target>(profileId: string, bucket: string, items: T[], existing: Set<string>, choice: ClashChoice): Promise<T[]> {
  if (choice === "replace") return items;
  const needs = clashIndices(items, existing);
  if (choice === "skip") {
    const drop = new Set(needs);
    return items.filter((_, i) => !drop.has(i));
  }
  // names this batch writes are taken too, so two "Keep both" picks never land on the same name
  // (freeKeys adds each name it hands out to `reserved`)
  const reserved = new Set(items.map((t) => t.to));
  const out = items.slice();
  let pending = needs;
  while (pending.length) {
    // one free name per original key per round; repeats of the same key wait for the next round
    const firsts = new Map<string, number>();
    const rest: number[] = [];
    for (const i of pending) {
      if (firsts.has(items[i].to)) rest.push(i);
      else firsts.set(items[i].to, i);
    }
    const free = await freeKeys(profileId, bucket, [...firsts.keys()], reserved);
    for (const [k, i] of firsts) {
      const name = free.get(k);
      if (!name) throw new Error("Couldn't find a free name");
      out[i] = { ...items[i], to: name };
    }
    pending = rest;
  }
  return out;
}
