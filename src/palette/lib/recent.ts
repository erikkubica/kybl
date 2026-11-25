/**
 * What the command palette remembers per device: the items picked in it (newest first, by key)
 * and the folders visited lately in the active pane, its "Recent folders".
 */
import { LS } from "../../browser/types";
import type { Loc } from "../../browser/hooks/useListing";

const PICKS = "kybl.palette.picks";
const PLACES = "kybl.palette.places";
const KEEP_PICKS = 30;
const KEEP_PLACES = 20;

function read<T>(key: string, ok: (v: unknown) => v is T): T[] {
  try {
    const v = JSON.parse(LS.get(key) ?? "[]");
    return Array.isArray(v) ? v.filter(ok) : [];
  } catch {
    return [];
  }
}

export const recentPicks = () => read(PICKS, (v): v is string => typeof v === "string");

export function notePick(key: string) {
  LS.set(PICKS, JSON.stringify([key, ...recentPicks().filter((k) => k !== key)].slice(0, KEEP_PICKS)));
}

const isLoc = (v: unknown): v is Loc =>
  !!v && typeof v === "object" && typeof (v as Loc).profileId === "string" && typeof (v as Loc).bucket === "string" && typeof (v as Loc).prefix === "string";

export const recentPlaces = () => read(PLACES, isLoc);

const same = (a: Loc, b: Loc) => a.profileId === b.profileId && a.bucket === b.bucket && a.prefix === b.prefix;

export function notePlace(loc: Loc) {
  const cur = recentPlaces();
  if (cur[0] && same(cur[0], loc)) return;
  const { profileId, bucket, prefix } = loc;
  LS.set(PLACES, JSON.stringify([{ profileId, bucket, prefix }, ...cur.filter((l) => !same(l, loc))].slice(0, KEEP_PLACES)));
}

/** A connection was deleted: its folders go too. */
export function forgetPlacesOf(profileId: string) {
  const cur = recentPlaces();
  if (cur.some((l) => l.profileId === profileId)) LS.set(PLACES, JSON.stringify(cur.filter((l) => l.profileId !== profileId)));
}
