/**
 * What a browser pane shows. A pane's source is a connection (`profileId`), a root in it
 * (`bucket`: an S3 bucket today, a "root" once the storage abstraction lands) and a folder
 * (`prefix`, ending in "/" or empty). Panes never special-case the kind of storage: a Local
 * connection is just another profile, with the reserved id below.
 */
import { LOCAL_ID } from "../api";
import type { Profile } from "../types";

export type { Loc } from "./useListing";

export type PaneId = "left" | "right";

/**
 * The reserved profile id of this computer's own disk (the Local provider, WP0). Its roots are
 * folders on disk (Home, Desktop, volumes…: `api.listRoots`, with the absolute path as id) and
 * its keys are paths below them. Transfers to or from it are routed in shell/crossPane.ts.
 */
export const LOCAL_PROFILE = LOCAL_ID;

/** The sidebar's "This Mac": built in, never saved, edited or deleted. */
export const THIS_MAC: Profile = {
  id: LOCAL_ID,
  name: "This Mac",
  kind: "local",
  provider: "local",
  endpoint: "",
  region: "",
  accessKeyId: "",
  pathStyle: false,
};

/** localStorage that never throws (private windows, full disks, the browser mock). */
export const LS = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};
