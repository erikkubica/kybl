import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api, errMessage, errSummary, type TransferPrefs } from "../api";
import { Icon } from "../Icons";
import { ProviderBadge } from "../components/Sidebar";
import { EXPIRIES, SCALES, type Settings, type Theme } from "../settings";
import type { Toast } from "../components/Dialogs";
import type { Profile } from "../types";
import { useEffect } from "react";
import { actionLabel, ago, updatesApi, type UpdateStatus } from "../updates";
import { formatBytes } from "../format";
import { LOCK_LABEL, LOCK_SUB } from "./AppLock";

export function SettingsScreen({
  onBack,
  settings,
  onChange,
  profiles,
  onEdit,
  onAdd,
  savedWhere,
  toast,
  updates,
  prefs,
  onPrefs,
  lockable,
  onBackup,
}: {
  onBack: () => void;
  settings: Settings;
  onChange: (s: Settings) => void;
  profiles: Profile[];
  onEdit: (p: Profile) => void;
  onAdd: () => void;
  savedWhere: string;
  toast: (kind: Toast["kind"], text: string) => void;
  updates: UpdateStatus | null;
  /** transfer settings from the backend; null while loading (or where it has none) */
  prefs: TransferPrefs | null;
  onPrefs: (p: Partial<TransferPrefs>) => Promise<void>;
  /** app lock is offered (phones) */
  lockable: boolean;
  /** WP-C: phone backup, where the phone has it */
  onBackup?: () => void;
}) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <section className="m-screen m-overlay">
      <header className="m-bar solid">
        <button className="m-icon" onClick={onBack} aria-label="Back">
          <Icon name="arrow-left" size={22} />
        </button>
        <div className="m-title">
          <h1>Settings</h1>
        </div>
      </header>
      <div className="m-scroll m-settings">
        <h2 className="m-section">Appearance</h2>
        <div className="m-group m-pad">
          <div className="m-seg" role="group" aria-label="Theme">
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <button key={t} className={settings.theme === t ? "on" : ""} aria-pressed={settings.theme === t} onClick={() => set("theme", t)}>
                {t === "system" ? "Automatic" : t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </div>

        <h2 className="m-section">Text size</h2>
        <div className="m-group m-pad">
          <div className="m-seg" role="group" aria-label="Text size">
            {SCALES.map((x) => (
              <button
                key={x.value}
                className={settings.scale === x.value ? "on" : ""}
                aria-pressed={settings.scale === x.value}
                onClick={() => set("scale", x.value)}
                style={{ fontSize: `${Math.round(14 * x.value)}px` }}
              >
                {x.label}
              </button>
            ))}
          </div>
          <p className="m-hint">Your phone's own text size setting is followed too.</p>
        </div>

        <h2 className="m-section">Browsing</h2>
        <ul className="m-group">
          <Toggle
            label="Photo previews"
            sub="Small pictures instead of icons in lists and grids"
            on={settings.listThumbs}
            set={(v) => set("listThumbs", v)}
          />
          <Toggle label="Reopen the last folder" on={settings.restoreLast} set={(v) => set("restoreLast", v)} />
          <Toggle label="Ask before deleting" on={settings.confirmDelete} set={(v) => set("confirmDelete", v)} />
          <Toggle label="Binary sizes (1 KiB = 1024 B)" on={settings.binaryUnits} set={(v) => set("binaryUnits", v)} />
          <Toggle label="Full dates" on={settings.absoluteDates} set={(v) => set("absoluteDates", v)} />
        </ul>

        {onBackup && (
          <>
            <h2 className="m-section">Backup</h2>
            <ul className="m-group">
              <li>
                <button className="m-setting-row" onClick={onBackup}>
                  <Icon name="image" size={16} />
                  <span className="m-grow">
                    Photo backup
                    <small className="m-sub">Back up photos, videos and folders to your storage</small>
                  </span>
                  <Icon name="chevron" size={13} className="m-chev" />
                </button>
              </li>
            </ul>
          </>
        )}

        {prefs && (
          <>
            <h2 className="m-section">Transfers</h2>
            <ul className="m-group">
              <Toggle
                label="Wi-Fi only"
                sub="Uploads, downloads and photo previews wait for Wi-Fi instead of using mobile data"
                on={prefs.wifiOnly}
                // the switch goes back by itself if this fails
                set={(v) => onPrefs({ wifiOnly: v }).catch((e) => toast("error", `Couldn't change Wi-Fi only. ${errSummary(errMessage(e))}`))}
              />
            </ul>
          </>
        )}

        {lockable && (
          <>
            <h2 className="m-section">Privacy</h2>
            <ul className="m-group">
              <Toggle
                label={LOCK_LABEL}
                sub={LOCK_SUB}
                on={settings.appLock}
                set={async (v) => {
                  if (!v) return set("appLock", false);
                  // unlock once now: it proves the phone can, and that it is really you turning it on
                  try {
                    if (await api.biometricUnlock("Turn on app lock")) set("appLock", true);
                  } catch (e) {
                    toast("error", `Set up a screen lock on your phone first. ${errSummary(errMessage(e))}`);
                  }
                }}
              />
            </ul>
          </>
        )}

        <h2 className="m-section">Share links expire after</h2>
        <div className="m-group m-pad">
          <div className="m-seg" role="group" aria-label="Link expiry">
            {EXPIRIES.map((x) => (
              <button key={x.secs} className={settings.linkExpiry === x.secs ? "on" : ""} aria-pressed={settings.linkExpiry === x.secs} onClick={() => set("linkExpiry", x.secs)}>
                {x.label}
              </button>
            ))}
          </div>
        </div>

        <h2 className="m-section">Connections</h2>
        <ul className="m-group">
          {profiles.map((p) => (
            <li key={p.id}>
              <button className="m-setting-row" onClick={() => onEdit(p)}>
                <ProviderBadge provider={p.provider} />
                <span className="m-grow">{p.name || p.endpoint}</span>
                <Icon name="chevron" size={13} className="m-chev" />
              </button>
            </li>
          ))}
          <li>
            <button className="m-setting-row accent" onClick={onAdd}>
              <Icon name="plus" size={16} />
              <span className="m-grow">Add a connection</span>
            </button>
          </li>
        </ul>

        <h2 className="m-section">Storage</h2>
        <ul className="m-group">
          <li>
            <button
              className="m-setting-row"
              onClick={async () => {
                try {
                  const freed = await api.clearThumbnailCache();
                  toast("success", freed ? "Thumbnail cache cleared" : "The thumbnail cache was already empty");
                } catch (e) {
                  toast("error", errMessage(e));
                }
              }}
            >
              <Icon name="trash" size={16} />
              <span className="m-grow">Clear thumbnail cache</span>
            </button>
          </li>
        </ul>
        {updates && (
          <>
            <h2 className="m-section">Updates</h2>
            <ul className="m-group">
              <Toggle label="Check for updates automatically" on={updates.auto} set={(auto) => updatesApi.settings({ auto }).catch(() => {})} />
              <li>
                <button
                  className="m-setting-row"
                  disabled={updates.checking}
                  onClick={() => {
                    if (updates.available) {
                      updatesApi.install().catch((e) => toast("error", errMessage(e)));
                      return;
                    }
                    updatesApi
                      .check()
                      .then((s) => !s.available && toast("success", "Kybl is up to date"))
                      .catch((e) => toast("error", errMessage(e)));
                  }}
                >
                  <Icon name={updates.available ? "download" : "refresh"} size={16} />
                  <span className="m-grow">
                    {updates.available ? `${actionLabel(updates.available)} Kybl ${updates.available.version}` : updates.checking ? "Checking…" : "Check for updates"}
                    <small className="m-sub">
                      {updates.available
                        ? `You have ${updates.current}${updates.available.asset ? ` · ${formatBytes(updates.available.asset.size)}` : ""}`
                        : updates.lastChecked
                          ? `Up to date · checked ${ago(updates.lastChecked)}`
                          : "From the Kybl releases on GitHub"}
                    </small>
                  </span>
                </button>
              </li>
            </ul>
          </>
        )}

        <p className="m-foot">
          Downloads are saved to {savedWhere}. Secret keys are kept on this device only.
          <br />
          Kybl {version}
        </p>
      </div>
    </section>
  );
}

function Toggle({ label, sub, on, set }: { label: string; sub?: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <li>
      <label className="m-setting-row">
        <span className="m-grow">
          {label}
          {sub && <small className="m-sub">{sub}</small>}
        </span>
        <input type="checkbox" className="m-switch" checked={on} onChange={(e) => set(e.target.checked)} />
      </label>
    </li>
  );
}
