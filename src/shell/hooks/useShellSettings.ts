import { useState, useSyncExternalStore, useCallback, useEffect } from "react";
import { type Settings, loadSettings, watchSystemDark, systemIsDark, saveSettings, applySettings } from "../../settings/settings";
import { type SettingsPageId } from "../../settings/SettingsPage";
import { listen } from "@tauri-apps/api/event";

export interface UseShellSettingsDeps {

}

/** App settings (saved on change), the theme, the folded sidebar and the Settings page (which page, asked again from the tray). */
export function useShellSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const sysDark = useSyncExternalStore(watchSystemDark, systemIsDark);
  const dark = settings.theme === "dark" || (settings.theme === "system" && sysDark);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // a counter with the page, so asking again for the same page (tray "Sync settings…") goes back to it
  const [settingsPage, setSettingsPage] = useState<{ page?: SettingsPageId; n: number }>({ n: 0 });
  const openSettings = useCallback((page?: SettingsPageId) => {
    setSettingsPage((r) => ({ page, n: r.n + 1 }));
    setSettingsOpen(true);
  }, []);
  // the menu-bar icon's "Sync settings…": an event while the window exists, or a flag left by the
  // backend when it had to create the window for it
  useEffect(() => {
    const w = window as { __KYBL_OPEN_SETTINGS__?: SettingsPageId };
    if (w.__KYBL_OPEN_SETTINGS__) {
      openSettings(w.__KYBL_OPEN_SETTINGS__);
      delete w.__KYBL_OPEN_SETTINGS__;
    }
    let un: (() => void) | undefined;
    listen<SettingsPageId>("open-settings", (e) => openSettings(e.payload))
      .then((u) => (un = u))
      .catch(() => {});
    return () => un?.();
  }, [openSettings]);
  const updateSettings = useCallback(
    (patch: Partial<Settings>) =>
      setSettings((cur) => {
        const next = { ...cur, ...patch };
        saveSettings(next);
        applySettings(next);
        return next;
      }),
    [],
  );
  const sideHidden = settings.sidebarHidden;
  const toggleSidebar = useCallback(
    () =>
      setSettings((cur) => {
        const next = { ...cur, sidebarHidden: !cur.sidebarHidden };
        saveSettings(next);
        return next;
      }),
    [],
  );
  return { settings, sysDark, dark, settingsOpen, setSettingsOpen, settingsPage, openSettings, updateSettings, sideHidden, toggleSidebar };
}
