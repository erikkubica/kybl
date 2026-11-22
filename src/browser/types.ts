/**
 * What a browser pane shows. A pane's source is a connection (`profileId`), a root in it
 * (`bucket`: an S3 bucket today, a "root" once the storage abstraction lands) and a folder
 * (`prefix`, ending in "/" or empty). Panes never special-case the kind of storage: a Local
 * connection is just another profile, with the reserved id below.
 */
export type { Loc } from "./useListing";

export type PaneId = "left" | "right";

/**
 * The reserved profile id of this computer's own disk (the Local provider, WP0). Its roots are
 * folders on disk (Home, Desktop, volumes…) and its keys are paths below them. Nothing can open
 * a Local pane until `api.listRoots` exists; transfers to or from one are routed in
 * shell/crossPane.ts so the provider only has to plug in.
 */
export const LOCAL_PROFILE = "local";

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
