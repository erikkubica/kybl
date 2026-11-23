import { safeRelPath } from "./paths.ts";

/**
 * File types that run code when opened in their default app (programs, scripts, installers,
 * shortcuts, macro documents, settings that change the machine or connect it somewhere). A file of
 * a connection is asked about before it opens this way: double-clicking in a file manager usually
 * means "show me", not "run it". Legacy Office files (.doc, .xls, .ppt) can hold macros too, but
 * are left out: they are everyday documents, and Office's Protected View covers them.
 */
const RUNNABLE = new Set(
  (
    "exe com scr pif cpl msi msp mst msc msu bat cmd ps1 psm1 psd1 psc1 ps1xml vb vbs vbe js jse ws wsf wsh wsc sct hta lnk url reg jar " +
    "msh msh1 msh2 mshxml shs inf job " +
    "appref-ms application xbap vsto gadget appinstaller msix msixbundle appx appxbundle settingcontent-ms searchconnector-ms library-ms " +
    "chm scf website rdp ica jnlp theme themepack deskthemepack diagcab " +
    "app pkg mpkg dmg command terminal tool workflow action scpt applescript osascript prefpane kext webloc inetloc fileloc saver service " +
    "mobileconfig shortcut " +
    "sh bash zsh csh ksh fish py pyw pyz pyzw pyc pyo pl rb php jsx jsxbin desktop appimage run deb rpm flatpakref snap apk " +
    "docm dotm xlsm xltm xlam xla xll iqy dqy slk pptm potm ppam ppsm sldm mdb mde accdb accde " +
    "iso img vhd vhdx"
  ).split(" "),
);

/**
 * The runnable types that are plain text: opened in an editor the person picked, they are only
 * read. Programs, installers, macro documents and settings files are not in here: the app picked
 * for those is usually the one that runs, installs or applies them (Word, Installer, Settings).
 */
const SCRIPTS = new Set(
  (
    "sh bash zsh csh ksh fish py pyw pl rb php js jse jsx vb vbs vbe ws wsf wsh wsc sct bat cmd ps1 psm1 psd1 psc1 ps1xml " +
    "msh msh1 msh2 mshxml command tool applescript reg inf desktop url hta"
  ).split(" "),
);

/** `name`'s last extension, as the OS reads it (trailing dots and spaces dropped, lower case). */
function extOf(name: string): string {
  const n = name.replace(/[\s.]+$/, "").toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot >= 0 ? n.slice(dot + 1) : "";
}

/** Whether a file called `name` runs code when opened (by its last extension). */
export function runsCode(name: string): boolean {
  return RUNNABLE.has(extOf(name));
}

/**
 * The name a file called `name` gets in a local folder (`safeRelPath`'s last part: `\`, `.` and
 * `..` parts dropped), which can differ from the remote name: `payload.exe\` is saved as
 * `payload.exe`. The guard checks both, and the path that opens too (`openFromConnection`).
 */
export function localName(name: string): string {
  return safeRelPath(name).split("/").pop() ?? "";
}

/**
 * Who opens the file: the type's default app (also Windows' "Choose an app", and an app that is
 * the type's default anyway), an app that runs what it opens (a terminal, an interpreter, an
 * installer), or another app the person picked (an editor, most likely).
 */
export type Opener = "default" | "runner" | "picked";

const RUNNERS =
  /terminal|iterm|alacritty|wezterm|ghostty|konsole|xterm|tilix|terminator|tabby|^warp$|^kitty$|^hyper$|python|^pyw?$|^node(js)?$|^bun$|^deno$|^perl|^ruby|^php|^(ba|z|k|c|da|fi)?sh$|powershell|pwsh|^cmd$|wscript|cscript|mshta|^javaw?$|launcher|installer|^wine|regedit|msiexec|rundll32/;

/** `app` (an `AppChoice.path`: undefined or "" the default app, null Windows' chooser) as an `Opener`. */
export function openerOf(app: string | null | undefined, isDefault: boolean): Opener {
  if (app == null || app === "" || isDefault) return "default";
  const base = app.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? app;
  return RUNNERS.test(base.replace(/\.(app|exe|desktop)$/i, "").toLowerCase()) ? "runner" : "picked";
}

/**
 * Whether opening a file of a connection called `name` with `opener` is asked about first: it
 * runs code (by its remote name or its local one), unless it is a plain-text script going to an
 * app the person picked that is neither its default nor runs things (an editor only reads it).
 */
export function asksFirst(name: string, opener: Opener): boolean {
  return [name, localName(name)].some((n) => runsCode(n) && !(opener === "picked" && SCRIPTS.has(extOf(n))));
}
