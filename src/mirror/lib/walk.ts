/**
 * Mirror's listing through the app's `list_objects` (the logic is in `./listing`, which the tests
 * run without the app).
 */
import { api } from "../../core/api";
import type { Capabilities } from "../../core/api";
import type { Matcher } from "./ignore";
import { walkWith, type Place } from "./listing";
import type { Listing } from "./plan";

export { Cancelled, folderMissing, listedMd5, type Lister, type Place } from "./listing";

/** The connection's own listing of `at`'s root, a page at a time. */
export const listerFor = (at: Place) => (prefix: string, token: string | null) => api.listObjects(at.profileId, at.root, prefix, token);

export function walk(at: Place, caps: Capabilities | null, excluded: Matcher, opts: { signal?: AbortSignal; onCount?: (files: number) => void } = {}): Promise<Listing> {
  return walkWith(listerFor(at), at, caps, excluded, opts);
}
