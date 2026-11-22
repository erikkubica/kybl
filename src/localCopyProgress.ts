/**
 * Which files are being fetched for "Copy" or "Open" right now, so their buttons can show it
 * ("Copying 42%") instead of looking idle while a big file downloads on a slow line.
 */
import { createStore, useStore } from "./store";
import { useTransferPercent } from "./useTransfers";

export type LocalCopyVerb = "copy" | "open";
type Busy = { verb: LocalCopyVerb; transfer: string | null };

const busy = createStore<Record<string, Busy>>({});
const keyOf = (profileId: string, bucket: string, key: string) => `${profileId}\n${bucket}\n${key}`;

export const localCopies = {
  start(profileId: string, bucket: string, key: string, verb: LocalCopyVerb) {
    busy.set((b) => ({ ...b, [keyOf(profileId, bucket, key)]: { verb, transfer: null } }));
  },
  transfer(profileId: string, bucket: string, key: string, transfer: string) {
    const k = keyOf(profileId, bucket, key);
    busy.set((b) => (b[k] ? { ...b, [k]: { ...b[k], transfer } } : b));
  },
  end(profileId: string, bucket: string, key: string) {
    const k = keyOf(profileId, bucket, key);
    busy.set((b) => {
      if (!b[k]) return b;
      const { [k]: _, ...rest } = b;
      return rest;
    });
  },
};

/** What is under way for this file, with its download progress (0 while it starts). */
export function useLocalCopy(profileId: string, bucket: string, key: string): { verb: LocalCopyVerb; percent: number } | null {
  const k = keyOf(profileId, bucket, key);
  const verb = useStore(busy, (b) => b[k]?.verb ?? null);
  const transfer = useStore(busy, (b) => b[k]?.transfer ?? null);
  const percent = useTransferPercent(transfer);
  return verb ? { verb, percent: percent ?? 0 } : null;
}
