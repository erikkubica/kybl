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
    "appref-ms application xbap vsto gadget appinstaller msix msixbundle appx appxbundle settingcontent-ms searchconnector-ms library-ms " +
    "chm scf website rdp ica jnlp theme themepack deskthemepack diagcab " +
    "app pkg mpkg dmg command terminal tool workflow action scpt applescript osascript prefpane kext webloc inetloc fileloc " +
    "mobileconfig shortcut " +
    "sh bash zsh csh ksh fish py pyw pl rb php desktop appimage run deb rpm flatpakref snap apk " +
    "docm dotm xlsm xltm xlam xla xll iqy dqy slk pptm potm ppam ppsm sldm mdb mde accdb accde " +
    "iso img vhd vhdx"
  ).split(" "),
);

/** Whether a file called `name` runs code when opened (by its last extension). */
export function runsCode(name: string): boolean {
  const n = name.replace(/[\s.]+$/, "").toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot >= 0 && RUNNABLE.has(n.slice(dot + 1));
}
