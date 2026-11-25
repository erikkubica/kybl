import { LOCAL_ID } from "../../core/api";
import type { Profile } from "../../core/types";

const IPAD = /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** True for this device's own storage (on a phone: Kybl's own folder, where downloads land). */
export const isLocal = (p: Pick<Profile, "id" | "kind">) => p.id === LOCAL_ID || p.kind === "local";

/** A connection's name as the phone shows it: this device's own folder reads "On this phone". */
export function connName(p: Profile): string {
  if (isLocal(p)) return IPAD ? "On this iPad" : "On this phone";
  return p.name || p.endpoint;
}

/**
 * This device's own folders as a connection on the home screen (the desktop's "This Mac"). Never
 * saved, so `listProfiles` leaves it out; the phone adds it to the list it shows.
 */
export const ON_DEVICE: Profile = {
  id: LOCAL_ID,
  name: IPAD ? "On this iPad" : "On this phone",
  kind: "local",
  provider: "local",
  endpoint: "",
  region: "",
  accessKeyId: "",
  bucket: null,
  pathStyle: false,
};
