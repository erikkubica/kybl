/**
 * Terminal panes: the small part that lives in the main bundle. A terminal is a pane like any
 * other (it splits, drags, docks and moves between workspaces); what makes it one is a `TermPlace`
 * on its slot, the folder it opened in. Everything that draws it (xterm.js, the session with the
 * backend) is the lazily loaded chunk (session.ts, TermView.tsx), loaded on the first terminal.
 *
 * Hooks for features built on terminals:
 *   openTerminal({ paneId, profileId, cwd, startup })  a terminal below pane `paneId`, at folder
 *                                                      `cwd` (a key) of the pane's root, typing
 *                                                      the `startup` lines once the shell is up
 *   writeToTerminal(paneId, text)                      types text into the terminal of pane `paneId`
 *
 * A terminal's shell lives as long as its pane is in some workspace: switching workspaces keeps it
 * running (and its scrollback), closing the pane or its workspace ends it, and a reload starts a
 * fresh shell in the same folder (`sid` is what ties a pane to its running session).
 */
import { LOCAL_PROFILE, type PaneId } from "../browser/types";
import type { Profile } from "../types";

/**
 * Where a terminal pane opened: a folder of a connection, and the session it shows; `from` is the
 * file pane it opened from, and `follow` has it `cd` wherever that pane goes (while the shell idles).
 */
export type TermPlace = { profileId: string; bucket: string; prefix: string; sid?: string; from?: PaneId; follow?: boolean };
/** A terminal pane on screen: always with its session id. */
export type TermSpec = TermPlace & { sid: string };

const IS_WINDOWS = /Win/i.test(navigator.platform || navigator.userAgent);

export const newSid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Whether a terminal can open on connection `p`: This Mac (not on Windows yet) and SFTP servers. */
export function canTerminal(p: Pick<Profile, "id" | "kind"> | null | undefined): boolean {
  if (!p) return false;
  return p.id === LOCAL_PROFILE ? !IS_WINDOWS : p.kind === "sftp";
}

export function parseTermPlace(v: unknown): TermPlace | undefined {
  const x = v as Record<string, unknown> | null;
  if (!x || typeof x !== "object" || typeof x.profileId !== "string" || typeof x.bucket !== "string" || typeof x.prefix !== "string") return undefined;
  return {
    profileId: x.profileId,
    bucket: x.bucket,
    prefix: x.prefix,
    ...(typeof x.sid === "string" && x.sid ? { sid: x.sid } : {}),
    ...(typeof x.from === "string" ? { from: x.from as PaneId } : {}),
    ...(x.follow === true ? { follow: true } : {}),
  };
}

export { remotePath, shellQuote, typeable } from "./quote";

// ---------------------------------------------------------------- hooks the shell and the chunk fill in

export type OpenTerminalArgs = { paneId: PaneId; profileId: string; cwd: string; bucket?: string; startup?: string[] };

/** The running sessions' side (session.ts, once loaded). */
export type TermImpl = {
  write: (sid: string, text: string) => boolean;
  /** ends every session not in `keep` */
  gc: (keep: Set<string>) => void;
  action: (sid: string, a: TermAction) => void;
  /** where the shell's connection folder is on the server (SFTP), once connected */
  remoteBase: (sid: string) => string | null | undefined;
  /** sends `text` to the shell as typed keys (no paste, the keyboard stays where it is) */
  type: (sid: string, text: string) => boolean;
  /** the shell sits at its prompt with nothing typed (see session.ts) */
  idle: (sid: string) => Promise<boolean>;
  /** a program runs in the foreground (This Mac); null when that can't be told */
  busy: (sid: string) => Promise<boolean | null>;
};
export type TermAction = "clear" | "restart" | "copy" | "paste" | "font+" | "font-" | "font0";

let impl: TermImpl | null = null;
let opener: ((a: OpenTerminalArgs) => PaneId | null) | null = null;
/** pane slot → its terminal's session, as on screen now */
let panes: Partial<Record<PaneId, TermSpec>> = {};
/** startup lines waiting for a session to start */
const startups = new Map<string, string[]>();

export function setTermImpl(i: TermImpl) {
  impl = i;
}
export function setTerminalOpener(fn: typeof opener) {
  opener = fn;
}
export function setTerminalPanes(p: Partial<Record<PaneId, TermSpec>>) {
  panes = p;
}
export function setStartup(sid: string, lines: string[] | undefined) {
  if (lines?.length) startups.set(sid, lines);
}
/** sessions just opened by the user: their terminal takes the keyboard once it's on screen */
const focusOnShow = new Set<string>();
export const focusWhenShown = (sid: string) => void focusOnShow.add(sid);
export const takeFocusWhenShown = (sid: string) => focusOnShow.delete(sid);
/** The startup lines for a session that just started (once). */
export function takeStartup(sid: string): string[] {
  const l = startups.get(sid) ?? [];
  startups.delete(sid);
  return l;
}

/** Opens a terminal below pane `paneId` (see the module's note); the new pane's slot, or null when it couldn't. */
export function openTerminal(a: OpenTerminalArgs): PaneId | null {
  return opener?.(a) ?? null;
}

/** Types `text` into the terminal shown in pane `paneId`; false when there is none (or it isn't running). */
export function writeToTerminal(paneId: PaneId, text: string): boolean {
  const t = panes[paneId];
  return !!(t && impl?.write(t.sid, text));
}

export function terminalAction(sid: string, a: TermAction) {
  impl?.action(sid, a);
}

/** Ends the sessions no workspace has a pane for any more (nothing to do before the first terminal). */
export function gcTerminals(keep: Set<string>) {
  impl?.gc(keep);
}

export function terminalRemoteBase(sid: string) {
  return impl?.remoteBase(sid);
}

/** Sends `text` to session `sid` as typed keys, without taking the keyboard; false when it isn't running. */
export function typeIntoTerminal(sid: string, text: string): boolean {
  return !!impl?.type(sid, text);
}

/** Whether session `sid` is at its prompt with nothing typed, so a line can go in safely. */
export async function terminalIdle(sid: string): Promise<boolean> {
  return (await impl?.idle(sid)) ?? false;
}

/** Whether a program runs in session `sid` (null: not known, as over SSH or before the first terminal). */
export async function terminalBusy(sid: string): Promise<boolean | null> {
  return (await impl?.busy(sid)) ?? null;
}
