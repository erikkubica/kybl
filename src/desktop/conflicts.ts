/**
 * Name clashes: S3 overwrites an object silently and "merges" folders silently, so every action
 * that writes names (upload, move, copy, rename, new folder) checks the destination first and
 * asks. Checks go to the backend in chunks, so a 50,000-file upload costs a few calls, not one
 * request per file from here.
 */
import { api } from "../api";
import { numberedName } from "./paths";

/** One destination that already exists. `key` is the full destination key ("dir/" for folders). */
export type Clash = { key: string; name: string; folder: boolean };
/** "replace" means merge for a folder: files with the same names inside are replaced. */
export type Choice = "replace" | "skip" | "keep";

const CHUNK = 1000;

/** Which of `targets` already exist in the bucket (folders by prefix). */
export async function findExisting(profileId: string, bucket: string, targets: { key: string; folder: boolean }[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < targets.length; i += CHUNK) {
    const part = targets.slice(i, i + CHUNK);
    const r = await api.existing(
      profileId,
      bucket,
      part.filter((t) => !t.folder).map((t) => t.key),
      part.filter((t) => t.folder).map((t) => t.key),
    );
    for (const k of r.keys) found.add(k);
    for (const p of r.prefixes) found.add(p);
  }
  return found;
}

/**
 * Free "name (1).ext" style keys for each of `keys`, next to the original. `reserved` holds keys
 * already taken by this batch, so two "Keep both" picks never land on the same new name.
 */
export async function freeKeys(profileId: string, bucket: string, keys: string[], reserved: Set<string> = new Set()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const n = new Map(keys.map((k) => [k, 1]));
  let pending = [...new Set(keys)];
  for (let round = 0; pending.length && round < 40; round++) {
    const cand = new Map<string, string>(); // candidate -> original
    for (const k of pending) {
      let c = candidate(k, n.get(k)!);
      while (reserved.has(c) || cand.has(c)) {
        n.set(k, n.get(k)! + 1);
        c = candidate(k, n.get(k)!);
      }
      cand.set(c, k);
    }
    const taken = await findExisting(
      profileId,
      bucket,
      [...cand.keys()].map((c) => ({ key: c, folder: c.endsWith("/") })),
    );
    const next: string[] = [];
    for (const [c, k] of cand) {
      if (taken.has(c)) {
        n.set(k, n.get(k)! + 1);
        next.push(k);
      } else {
        out.set(k, c);
        reserved.add(c);
      }
    }
    pending = next;
  }
  return out;
}

function candidate(key: string, n: number): string {
  const folder = key.endsWith("/");
  const trimmed = folder ? key.slice(0, -1) : key;
  const cut = trimmed.lastIndexOf("/") + 1;
  return trimmed.slice(0, cut) + numberedName(trimmed.slice(cut) + (folder ? "/" : ""), n);
}

/**
 * Turns the user's choices into the final destination of each clashing key: null = skip it,
 * otherwise the key to write to (itself for replace/merge, a free name for keep both).
 */
export async function applyChoices(
  profileId: string,
  bucket: string,
  choices: Map<string, Choice>,
  reserved: Set<string> = new Set(),
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const keep: string[] = [];
  for (const [k, c] of choices) {
    if (c === "skip") out.set(k, null);
    else if (c === "replace") out.set(k, k);
    else keep.push(k);
  }
  if (keep.length) {
    const free = await freeKeys(profileId, bucket, keep, reserved);
    for (const k of keep) out.set(k, free.get(k) ?? null);
  }
  return out;
}
