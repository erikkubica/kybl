import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Icon, type IconName } from "../Icons";
import { SCHEMES, type Palette } from "../schemes";
import { ACCENTS, DEFAULTS, EXPIRIES, SCALES, isDark, type FontChoice, type Settings, type Theme } from "../settings";
import type { Profile } from "../types";
import { ProviderBadge } from "./Sidebar";
import { KyblLockup } from "./KyblMark";
import { SyncSection } from "./SyncSection";
import { syncApi, type AppPrefs } from "../sync";

export type SettingsPageId = "general" | "appearance" | "browsing" | "transfers" | "sync" | "connections" | "storage" | "shortcuts";
type Page = SettingsPageId;

const NAV: { title: string; items: { id: Page; label: string; icon: IconName }[] }[] = [
  {
    title: "Settings",
    items: [
      { id: "general", label: "General", icon: "settings" },
      { id: "appearance", label: "Appearance", icon: "eye" },
      { id: "browsing", label: "Browsing", icon: "folder" },
      { id: "transfers", label: "Transfers and sharing", icon: "upload" },
    ],
  },
  {
    title: "Storage",
    items: [
      { id: "sync", label: "Folder sync", icon: "sync" },
      { id: "connections", label: "Connections", icon: "server" },
      { id: "storage", label: "Cache and data", icon: "bucket" },
    ],
  },
  {
    title: "Help",
    items: [{ id: "shortcuts", label: "Keyboard shortcuts", icon: "info" }],
  },
];

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const FONTS: { id: FontChoice; label: string; family: string }[] = [
  { id: "system", label: "System", family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { id: "rounded", label: "Rounded", family: 'ui-rounded, "SF Pro Rounded", sans-serif' },
  { id: "serif", label: "Serif", family: 'ui-serif, "New York", Georgia, serif' },
  { id: "mono", label: "Mono", family: 'ui-monospace, "SF Mono", Menlo, monospace' },
];

const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Search this folder", keys: ["⌘", "F"] },
  { label: "Refresh", keys: ["⌘", "R"] },
  { label: "Select all", keys: ["⌘", "A"] },
  { label: "Move selection", keys: ["↑", "↓", "←", "→"] },
  { label: "Extend selection", keys: ["⇧", "click"] },
  { label: "Add to selection", keys: ["⌘", "click"] },
  { label: "Open folder / show details", keys: ["↵"] },
  { label: "Up one level", keys: ["⌫"] },
  { label: "Delete selection", keys: ["⌘", "⌫"] },
  { label: "Clear selection / close dialog", keys: ["Esc"] },
  { label: "Settings", keys: ["⌘", ","] },
];

function Row({ label, hint, stack, children }: { label: ReactNode; hint?: string; stack?: boolean; children?: ReactNode }) {
  return (
    <div className={`set-row ${stack ? "stack" : ""}`}>
      <div className="set-label">
        {label}
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  );
}

function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? "on" : ""} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

/** Miniature of the app drawn with a scheme's own colours. */
function SchemeMini({ p }: { p: Palette }) {
  return (
    <span className="scheme-mini" style={{ background: p.bg }} aria-hidden="true">
      <span className="sm-side" style={{ background: p.sidebar, borderRight: `1px solid ${p.border}` }}>
        <i style={{ background: p.accent, width: "80%" }} />
        <i style={{ background: p.faint, width: "60%", opacity: 0.6 }} />
        <i style={{ background: p.faint, width: "70%", opacity: 0.6 }} />
      </span>
      <span className="sm-main">
        <i className="sm-btn" style={{ background: p.accentSolid }} />
        <i style={{ background: p.text, width: "72%", opacity: 0.85 }} />
        <i style={{ background: p.dim, width: "52%", opacity: 0.7 }} />
        <i style={{ background: p.panel, width: "100%", height: 14, boxShadow: `0 0 0 1px ${p.border}` }} />
      </span>
    </span>
  );
}

export function SettingsPage({
  settings,
  compact,
  profiles,
  onChange,
  onCompact,
  onEditProfile,
  onNewProfile,
  onClearThumbnails,
  onClose,
  initialPage,
  activeProfileId,
  onToast,
}: {
  settings: Settings;
  compact: boolean;
  profiles: Profile[];
  onChange: (patch: Partial<Settings>) => void;
  onCompact: (c: boolean) => void;
  onEditProfile: (p: Profile) => void;
  onNewProfile: () => void;
  onClearThumbnails: () => void;
  onClose: () => void;
  initialPage?: SettingsPageId;
  activeProfileId: string | null;
  onToast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  const [page, setPage] = useState<Page>(initialPage ?? "general");
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  useEffect(() => {
    if (initialPage) setPage(initialPage);
  }, [initialPage]);
  useEffect(() => {
    syncApi
      .getPrefs()
      .then(setPrefs)
      .catch(() => {});
  }, []);
  const changePrefs = (p: Partial<AppPrefs>) => {
    if (prefs) setPrefs({ ...prefs, ...p });
    syncApi
      .setPrefs(p)
      .then(setPrefs)
      .catch((e) => {
        onToast("error", String(e));
        syncApi.getPrefs().then(setPrefs).catch(() => {});
      });
  };
  const [version, setVersion] = useState<string | null>(null);
  const dark = isDark(settings);
  const title = NAV.flatMap((g) => g.items).find((i) => i.id === page)?.label ?? "";

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v || null))
      .catch(() => {});
  }, []);

  return (
    <div className="settings-view" role="dialog" aria-label="Settings">
      <aside className="settings-side">
        <div className="settings-side-top" data-tauri-drag-region>
          <button className="btn btn-sm" onClick={onClose} title="Back to app (Esc)">
            <Icon name="arrow-left" size={14} /> Back to app
          </button>
        </div>
        <nav className="settings-nav" aria-label="Settings sections">
          {NAV.map((group) => (
            <div key={group.title}>
              <div className="side-head">
                <span>{group.title}</span>
              </div>
              {group.items.map((it) => (
                <button key={it.id} className={`side-item ${page === it.id ? "on" : ""}`} aria-current={page === it.id} onClick={() => setPage(it.id)}>
                  <Icon name={it.icon} size={15} />
                  <span className="side-label">{it.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="settings-main">
        <header className="settings-head" data-tauri-drag-region>
          {title}
        </header>
        <div className="settings-scroll">
          <div className="settings-page" key={page}>
            {page === "general" && (
              <>
                <h3 className="set-title">Startup</h3>
                <div className="set-card">
                  <Row label="Reopen last location" hint="Start in the connection, bucket and folder you were in when you quit.">
                    <Switch label="Reopen last location" on={settings.restoreLast} onChange={(restoreLast) => onChange({ restoreLast })} />
                  </Row>
                </div>

                {prefs && (
                  <>
                    <h3 className="set-title">Menu bar</h3>
                    <div className="set-card">
                      <Row label="Keep running in the menu bar" hint="Closing the window keeps the app (and folder sync) running behind the menu bar icon. Quit from that icon or with ⌘Q.">
                        <Switch label="Keep running in the menu bar" on={prefs.closeToTray} onChange={(closeToTray) => changePrefs({ closeToTray })} />
                      </Row>
                      <Row label="Open at login" hint="Starts quietly in the menu bar when you log in, so synced folders stay current.">
                        <Switch label="Open at login" on={prefs.launchAtLogin} onChange={(launchAtLogin) => changePrefs({ launchAtLogin })} />
                      </Row>
                    </div>
                  </>
                )}

                <h3 className="set-title">Safety</h3>
                <div className="set-card">
                  <Row label="Confirm before deleting" hint="Deleting from a bucket cannot be undone.">
                    <Switch label="Confirm before deleting" on={settings.confirmDelete} onChange={(confirmDelete) => onChange({ confirmDelete })} />
                  </Row>
                  <Row label="Secret keys" hint="Stored in the system keychain, never in a settings file.">
                    <span className="set-value">Keychain</span>
                  </Row>
                </div>

                <h3 className="set-title">About</h3>
                <div className="set-card">
                  <Row label={<KyblLockup size={18} />} hint="Browse, upload, download and share files on any S3-compatible storage.">
                    <span className="chip">{version ? `v${version}` : "dev build"}</span>
                  </Row>
                </div>
              </>
            )}

            {page === "appearance" && (
              <>
                <h3 className="set-title">Theme</h3>
                <div className="set-card">
                  <Row label="Mode" hint="System follows your macOS appearance.">
                    <Seg label="Mode" value={settings.theme} options={THEMES.map((t) => ({ value: t.id, label: t.label }))} onChange={(theme) => onChange({ theme })} />
                  </Row>
                  <Row label="Colour scheme" hint={`Each scheme has a light and a dark palette. Showing the ${dark ? "dark" : "light"} one.`} stack>
                    <div className="scheme-grid" role="group" aria-label="Colour scheme">
                      {SCHEMES.map((sc) => (
                        <button
                          key={sc.id}
                          className={`scheme-card ${settings.scheme === sc.id ? "on" : ""}`}
                          aria-pressed={settings.scheme === sc.id}
                          onClick={() => onChange({ scheme: sc.id })}
                        >
                          <SchemeMini p={dark ? sc.dark : sc.light} />
                          {sc.label}
                        </button>
                      ))}
                    </div>
                  </Row>
                  <Row label="Accent colour" hint="“Scheme” uses the colour scheme’s own accent.">
                    <div className="swatches" role="group" aria-label="Accent colour">
                      <button
                        className={`swatch auto ${settings.accent === "scheme" ? "on" : ""}`}
                        style={{ "--sw": (dark ? SCHEMES.find((s) => s.id === settings.scheme)?.dark : SCHEMES.find((s) => s.id === settings.scheme)?.light)?.accentSolid ?? "#2c6bf2" } as React.CSSProperties}
                        title="Scheme"
                        aria-label="Scheme accent"
                        aria-pressed={settings.accent === "scheme"}
                        onClick={() => onChange({ accent: "scheme" })}
                      />
                      {ACCENTS.map((a) => (
                        <button
                          key={a.id}
                          className={`swatch ${settings.accent === a.id ? "on" : ""}`}
                          style={{ "--sw": a.color } as React.CSSProperties}
                          title={a.label}
                          aria-label={a.label}
                          aria-pressed={settings.accent === a.id}
                          onClick={() => onChange({ accent: a.id })}
                        />
                      ))}
                    </div>
                  </Row>
                </div>

                <h3 className="set-title">Text</h3>
                <div className="set-card">
                  <Row label="Font" stack>
                    <div className="font-grid" role="group" aria-label="Font">
                      {FONTS.map((f) => (
                        <button
                          key={f.id}
                          className={`font-tile ${settings.font === f.id ? "on" : ""}`}
                          style={{ fontFamily: f.family }}
                          aria-pressed={settings.font === f.id}
                          onClick={() => onChange({ font: f.id })}
                        >
                          <b>Ag</b>
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </Row>
                  <Row label="Size" hint="Scales the whole interface.">
                    <Seg label="Size" value={settings.scale} options={SCALES} onChange={(scale) => onChange({ scale })} />
                  </Row>
                </div>

                <h3 className="set-title">Density</h3>
                <div className="set-card">
                  <Row label="Compact layout" hint="Tighter rows in the list, smaller tiles in the grid.">
                    <Switch label="Compact layout" on={compact} onChange={onCompact} />
                  </Row>
                </div>
              </>
            )}

            {page === "browsing" && (
              <>
                <h3 className="set-title">Lists</h3>
                <div className="set-card">
                  <Row label="Thumbnails" hint="Show photo previews in the grid. Each one is downloaded once and kept on disk; off, the grid shows file icons and downloads nothing.">
                    <Switch label="Thumbnails" on={settings.listThumbs} onChange={(listThumbs) => onChange({ listThumbs })} />
                  </Row>
                  <Row label="Folders first" hint="Keep folders above files, whatever the sort order.">
                    <Switch label="Folders first" on={settings.foldersFirst} onChange={(foldersFirst) => onChange({ foldersFirst })} />
                  </Row>
                  <Row label="Dates" hint="Friendly: “Today, 14:32”. Full: always the complete date and time.">
                    <Seg
                      label="Dates"
                      value={settings.absoluteDates ? "full" : "friendly"}
                      options={[
                        { value: "friendly", label: "Friendly" },
                        { value: "full", label: "Full" },
                      ]}
                      onChange={(v) => onChange({ absoluteDates: v === "full" })}
                    />
                  </Row>
                  <Row label="File sizes" hint="Decimal: 1 MB = 1,000,000 bytes. Binary: 1 MiB = 1,048,576 bytes.">
                    <Seg
                      label="File sizes"
                      value={settings.binaryUnits ? "bin" : "dec"}
                      options={[
                        { value: "dec", label: "MB" },
                        { value: "bin", label: "MiB" },
                      ]}
                      onChange={(v) => onChange({ binaryUnits: v === "bin" })}
                    />
                  </Row>
                </div>
              </>
            )}

            {page === "transfers" && (
              <>
                <h3 className="set-title">Transfers</h3>
                <div className="set-card">
                  <Row label="Show activity automatically" hint="Open the activity panel when an upload, download, move or delete starts.">
                    <Switch label="Show activity automatically" on={settings.autoOpenTransfers} onChange={(autoOpenTransfers) => onChange({ autoOpenTransfers })} />
                  </Row>
                </div>

                <h3 className="set-title">Sharing</h3>
                <div className="set-card">
                  <Row label="Share link lifetime" hint="Used by the quick “Copy link” actions. The details panel can still pick another.">
                    <Seg
                      label="Share link lifetime"
                      value={settings.linkExpiry}
                      options={EXPIRIES.map((e) => ({ value: e.secs, label: e.label }))}
                      onChange={(linkExpiry) => onChange({ linkExpiry })}
                    />
                  </Row>
                </div>
              </>
            )}

            {page === "sync" && <SyncSection profiles={profiles} activeProfileId={activeProfileId} onToast={onToast} />}

            {page === "connections" && (
              <>
                <h3 className="set-title">Connections</h3>
                <div className="set-card">
                  {profiles.length === 0 && <Row label="No connections yet" hint="Add one to start browsing a bucket." />}
                  {profiles.map((p) => (
                    <div key={p.id} className="conn-row">
                      <ProviderBadge provider={p.provider} large />
                      <div className="set-label">
                        {p.name}
                        <small className="selectable">
                          {p.endpoint || "Amazon S3"} · {p.region}
                          {p.bucket ? ` · ${p.bucket}` : ""}
                        </small>
                      </div>
                      <button className="btn btn-sm" onClick={() => onEditProfile(p)}>
                        Edit
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn-primary btn-sm" onClick={onNewProfile}>
                    <Icon name="plus" size={14} /> New connection
                  </button>
                </div>
              </>
            )}

            {page === "storage" && (
              <>
                <h3 className="set-title">Cache</h3>
                <div className="set-card">
                  <Row label="Thumbnail cache" hint="Thumbnails are kept on disk so folders reopen instantly. Clearing is safe; they are rebuilt on demand.">
                    <button className="btn btn-sm" onClick={onClearThumbnails}>
                      Clear cache
                    </button>
                  </Row>
                </div>

                <h3 className="set-title">Reset</h3>
                <div className="set-card">
                  <Row label="Reset all settings" hint="Back to the defaults. Connections and their keys are not touched.">
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => onChange({ ...DEFAULTS })}>
                      Reset
                    </button>
                  </Row>
                </div>
              </>
            )}

            {page === "shortcuts" && (
              <>
                <h3 className="set-title">Keyboard shortcuts</h3>
                <div className="set-card">
                  <div className="kbd-list">
                    {SHORTCUTS.map((sc) => (
                      <div key={sc.label}>
                        <span>{sc.label}</span>
                        <b>
                          {sc.keys.map((k) => (
                            <kbd key={k}>{k}</kbd>
                          ))}
                        </b>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
