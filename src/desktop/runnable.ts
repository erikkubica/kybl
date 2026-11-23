/**
 * File types that run code when opened in their default app (programs, scripts, installers,
 * shortcuts, macro documents). A file of a connection is asked about before it opens this way:
 * double-clicking in a file manager usually means "show me", not "run it".
 */
const RUNNABLE = new Set(
  (
    "exe com scr pif cpl msi msp mst msc bat cmd ps1 psm1 psd1 vbs vbe js jse wsf wsh hta lnk url reg jar appref-ms application gadget " +
    "app pkg mpkg dmg command terminal tool workflow action scpt applescript osascript prefpane kext webloc inetloc fileloc " +
    "sh bash zsh csh ksh fish py pyw pl rb php desktop appimage run deb rpm flatpakref snap " +
    "docm dotm xlsm xltm xlam pptm potm ppam sldm iso img vhd vhdx"
  ).split(" "),
);

/** Whether a file called `name` runs code when opened (by its last extension). */
export function runsCode(name: string): boolean {
  const n = name.replace(/[\s.]+$/, "").toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot >= 0 && RUNNABLE.has(n.slice(dot + 1));
}
