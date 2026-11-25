/**
 * What a browser pane shows. A pane's source is a connection (`profileId`), a root in it
 * (`bucket`: an S3 bucket today, a "root" once the storage abstraction lands) and a folder
 * (`prefix`, ending in "/" or empty). Panes never special-case the kind of storage: a Local
 * connection is just another profile, with the reserved id below.
 */
import { LOCAL_ID } from "../core/api";
import type { Profile } from "../core/types";
import type { GroupBy, Settings } from "../settings/settings";
import { ON_OS } from "../core/osNames";

export type { Loc } from "./hooks/useListing";

/**
 * The pane slots. "left" and "right" are the two panes of the old dual pane (their saved places
 * and view choices keep those names); a split layout adds the others. A slot keeps its id
 * wherever it sits in the layout, so it is a name, not a position.
 */
export const PANE_IDS = ["left", "right", "p3", "p4", "p5", "p6"] as const;
export type PaneId = (typeof PANE_IDS)[number];

/**
 * Where a slot keeps its last place and its own view choices in localStorage. They always hold
 * what the slot shows in the workspace on screen (shell/workspaces.ts copies a workspace's in
 * when it comes up), so a launch reopens it from them.
 */
/** A pane's own view choices; null where it follows the app's setting. */
export type PaneView = {
  view: "list" | "grid";
  sort: Settings["sort"] | null;
  hidden: boolean | null;
  compact: boolean | null;
  tile: number | null;
  /** the pane's own grouping (null or absent: the app's) */
  group?: GroupBy | null;
  /** the info panel beside the list is open (absent or null: closed) */
  info?: boolean | null;
};

export function paneKeys(id: PaneId) {
  return {
    last: id === "left" ? "s3b.last" : `s3b.last.${id}`,
    view: id === "left" ? "s3b.view" : `s3b.view.${id}`,
    sort: `s3b.sort.${id}`,
    hidden: `s3b.hidden.${id}`,
    compact: `s3b.compact.${id}`,
    tile: `s3b.tile.${id}`,
    group: `s3b.group.${id}`,
    info: `s3b.info.${id}`,
  };
}

/**
 * The reserved profile id of this computer's own disk (the Local provider, WP0). Its roots are
 * folders on disk (Home, Desktop, volumes…: `api.listRoots`, with the absolute path as id) and
 * its keys are paths below them. Transfers to or from it are routed in shell/crossPane.ts.
 */
export const LOCAL_PROFILE = LOCAL_ID;

/** The sidebar's "This Mac" ("This PC", "This computer"): built in, never saved, edited or deleted. */
export const THIS_MAC: Profile = {
  id: LOCAL_ID,
  name: ON_OS.device,
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
