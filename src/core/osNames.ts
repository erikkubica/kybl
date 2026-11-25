/**
 * What this system calls its own things: the computer, its file manager, its trash. Pure (no
 * imports), so `node --test` can load it; the constants at the bottom are for this system.
 */

export type Os = "mac" | "win" | "linux";

/** The desktop system a user agent (or `navigator.platform`) names. */
export const osOf = (ua: string): Os => (/Mac/.test(ua) ? "mac" : /Win/.test(ua) ? "win" : "linux");

export type OsNames = {
  /** the sidebar's name for this computer: "This Mac", "This PC", "This computer" */
  device: string;
  /** mid-sentence: "this Mac", "this PC", "this computer" */
  here: string;
  /** "Finder", "File Explorer", "Files" */
  fileManager: string;
  /** the reveal button: "Show in Finder", "Show in Explorer", "Show in Files" */
  showInFiles: string;
  /** where saved secrets' key is kept: "the Keychain", "Credential Manager", "the system keyring" */
  keychain: string;
  /** where deleted files of this computer go: "Trash", "Recycle Bin" */
  trash: string;
};

export function osNames(os: Os): OsNames {
  if (os === "mac") return { device: "This Mac", here: "this Mac", fileManager: "Finder", showInFiles: "Show in Finder", keychain: "the Keychain", trash: "Trash" };
  if (os === "win") return { device: "This PC", here: "this PC", fileManager: "File Explorer", showInFiles: "Show in Explorer", keychain: "Credential Manager", trash: "Recycle Bin" };
  return { device: "This computer", here: "this computer", fileManager: "Files", showInFiles: "Show in Files", keychain: "the system keyring", trash: "Trash" };
}

const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
/** This system. */
export const OS: Os = osOf(UA);
/** This system's names (see `osNames`). */
export const ON_OS: OsNames = osNames(OS);

/** Where a delete goes when it isn't for good: this computer's own bin for files on its disk, else the connection's "Trash". */
export const trashName = (onDisk: boolean, os: Os = OS) => (onDisk ? osNames(os).trash : "Trash");

/** What a Delete button or menu item says: "Move to Trash" ("Recycle Bin") where deleted items can be restored, else "Delete". */
export const deleteLabel = (trash: boolean, onDisk: boolean, os: Os = OS) => (trash ? `Move to ${trashName(onDisk, os)}` : "Delete");

/** Where terminals open, for a refusal: this computer and SSH / SFTP servers. */
export const terminalsWhere = (os: Os = OS) => `Terminals open on ${osNames(os).device} and on SSH and SFTP connections`;
