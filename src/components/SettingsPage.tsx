import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Icon, type IconName } from "../Icons";
import { SCHEMES, type Palette } from "../schemes";
import { ACCENTS, DEFAULTS, EXPIRIES, SCALES, isDark, type ColumnId, type FontChoice, type Settings, type Theme } from "../settings";
import { api, errMessage, type TransferPrefs } from "../api";
import { IMAGE_MODES } from "../imageMode";
import type { Profile } from "../types";
import { ProviderBadge } from "./Sidebar";
import { KyblLockup } from "./KyblMark";
import { SyncSection } from "./SyncSection";
// WP-E4: drives
import { MountsSection } from "../mount/MountsSection";
import { syncApi, type AppPrefs } from "../sync";
import { openUrl } from "@tauri-apps/plugin-opener";
import { actionLabel, ago, installAndRestart, updatesApi, useUpdates } from "../updates";
import { formatBytes } from "../format";

export type SettingsPageId = "general" | "appearance" | "browsing" | "transfers" | "sync" | "drives" | "connections" | "storage" | "shortcuts";
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
      { id: "drives", label: "Drives", icon: "server" },
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

/** Every shortcut the file browser knows (desktop/useShortcuts.ts, the lists and the menu bar). */
const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Search this folder", keys: ["⌘", "F"] },
  { label: "Go to folder", keys: ["⇧", "⌘", "G"] },
  { label: "Back / forward", keys: ["⌘[", "⌘]"] },
  { label: "Up one level", keys: ["⌘", "↑"] },
  { label: "Refresh", keys: ["⌘", "R"] },
  { label: "Move selection", keys: ["↑", "↓", "←", "→"] },
  { label: "First / last item", keys: ["Home", "End"] },
  { label: "One screen up / down", keys: ["PgUp", "PgDn"] },
  { label: "Jump to a name", keys: ["type its first letters"] },
  { label: "Select all", keys: ["⌘", "A"] },
  { label: "Extend selection", keys: ["⇧", "click"] },
  { label: "Add to selection", keys: ["⌘", "click"] },
  { label: "Select an area", keys: ["drag on empty space"] },
  { label: "Open folder or file", keys: ["⌘", "O"] },
  { label: "Quick Look", keys: ["Space"] },
  { label: "Show or hide details", keys: ["⌘", "I"] },
  { label: "Actions menu for the selection", keys: ["⇧", "F10"] },
  { label: "Copy / cut / paste items", keys: ["⌘C", "⌘X", "⌘V"] },
  { label: "Undo the last move, copy or rename", keys: ["⌘", "Z"] },
  { label: "Copy instead of moving while dragging", keys: ["⌥"] },
  { label: "Rename", keys: ["F2"] },
  { label: "New folder", keys: ["⇧", "⌘", "N"] },
  { label: "Upload files", keys: ["⌘", "U"] },
  { label: "Upload a folder", keys: ["⇧", "⌘", "U"] },
  { label: "Download selection", keys: ["⇧", "⌘", "D"] },
  { label: "Delete selection", keys: ["⌘", "⌫"] },
  { label: "Clear selection / close dialog", keys: ["Esc"] },
  { label: "Settings", keys: ["⌘", ","] },
  { label: "This Mac: show or hide hidden files", keys: ["⇧", "⌘", "."] },
  { label: "Two panes side by side", keys: ["⌘", "\\"] },
  { label: "Two panes: switch pane", keys: ["Tab"] },
  { label: "Two panes: copy / move to the other pane", keys: ["F5", "F6"] },
  { label: "Two panes: quick look, new folder, delete", keys: ["F3", "F7", "F8"] },
  { label: "Two panes: swap them", keys: ["⇧", "⌘", "S"] },
  { label: "Two panes: copy instead of moving while dragging across", keys: ["drop copies, ⌘ moves"] },
];

/** Automatic checks, "Check now", and installing what a check found. */
function UpdatesRows({ onToast }: { onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const st = useUpdates();
  if (!st) return null;
  const rel = st.available;
  const working = st.phase === "downloading" || st.phase === "installing";
  const status = st.checking
    ? "Checking…"
    : st.phase === "downloading"
      ? `Downloading Kybl ${rel?.version}… ${formatBytes(st.received)}${st.total ? ` of ${formatBytes(st.total)}` : ""}`
      : st.phase === "installing"
        ? `Installing Kybl ${rel?.version}…`
        : st.phase === "ready"
          ? `Kybl ${rel?.version} is installed. Restart to use it.`
          : st.error
            ? st.error
            : rel
              ? `Kybl ${rel.version} is available (you have ${st.current}).`
              : st.lastChecked
                ? `You have the latest version. Checked ${ago(st.lastChecked)}.`
                : "Updates come from the Kybl releases on GitHub.";
  const check = () =>
    updatesApi
      .check()
      .then((s) => !s.available && onToast("success", "Kybl is up to date"))
      .catch(() => {});
  return (
    <>
      <Row label="Check for updates automatically" hint="Looks for a new version at start and every few hours. Nothing is installed without asking.">
        <Switch label="Check for updates automatically" on={st.auto} onChange={(auto) => updatesApi.settings({ auto }).catch((e) => onToast("error", String(e)))} />
      </Row>
      <Row label="Updates" hint={status}>
        <div className="set-actions">
          {rel && (
            <button className="btn btn-sm" onClick={() => openUrl(rel.page).catch(() => {})}>
              What's new
            </button>
          )}
          {st.phase === "ready" ? (
            <button className="btn btn-sm btn-primary" onClick={() => updatesApi.restart(true).catch((e) => onToast("error", String(e)))}>
              Restart now
            </button>
          ) : rel ? (
            <button
              className="btn btn-sm btn-primary"
              disabled={working}
              onClick={() =>
                rel.how === "install"
                  ? installAndRestart(() => onToast("info", "Kybl restarts when you click Restart now, after your transfers finish.")).catch(() => {})
                  : updatesApi.install().catch((e) => onToast("error", String(e)))
              }
            >
              {actionLabel(rel)}
            </button>
          ) : (
            <button className="btn btn-sm" disabled={st.checking} onClick={check}>
              Check now
            </button>
          )}
        </div>
      </Row>
    </>
  );
}

const PHOTOS_HINT =
  "Off: file icons only, nothing is downloaded. Placeholders: a blurry preview of each photo where one is known, no thumbnail downloads (good on a slow line). Thumbnails: the blurry preview at once, then the thumbnail, downloaded once and kept on disk. " +
  "Right-click a connection to give it its own setting, or to share placeholders: that writes a small hidden file into each photo folder you open, so your other devices show placeholders straight away.";

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

/** Thumbnails and recently opened files, with what they take on disk; one button clears both. */
function CacheRow({ onToast }: { onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const [usage, setUsage] = useState<{ thumbnails: number; files: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .cacheUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  useEffect(() => {
    void load();
  }, []);
  const clear = async () => {
    setBusy(true);
    try {
      const freed = await api.clearCaches();
      onToast("success", freed ? `Cache cleared (${formatBytes(freed)} freed)` : "The cache was already empty");
    } catch (e) {
      onToast("error", errMessage(e));
    } finally {
      setBusy(false);
      void load();
    }
  };
  const hint =
    "Thumbnails, photo placeholders and recently opened files are kept on this computer, so folders and documents reopen without downloading again. Clearing is safe; they are fetched again when needed." +
    (usage ? ` Now: ${formatBytes(usage.thumbnails)} of thumbnails, ${formatBytes(usage.files)} of files.` : "");
  return (
    <Row label="Cache" hint={hint}>
      <button className="btn btn-sm" onClick={clear} disabled={busy}>
        Clear cache
      </button>
    </Row>
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

const COLUMN_CHOICES: { id: ColumnId; label: string }[] = [
  { id: "size", label: "Size" },
  { id: "modified", label: "Modified" },
  { id: "kind", label: "Kind" },
  { id: "storageClass", label: "Storage class" },
  { id: "etag", label: "ETag" },
];

/** 1 MB/s in the KiB/s the backend counts in. */
const MBPS = 1_000_000 / 1024;
const LIMITS = [0, 1, 5, 10, 25, 50];
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) }));

/** Transfer tuning (backend prefs) plus where downloads go (a desktop setting). */
function TransferRows({ settings, onChange, onToast }: { settings: Settings; onChange: (patch: Partial<Settings>) => void; onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const [prefs, setPrefs] = useState<TransferPrefs | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [customText, setCustomText] = useState("");

  useEffect(() => {
    api
      .transferPrefs()
      .then((p) => {
        setPrefs(p);
        const mb = p.bandwidthLimitKbps / MBPS;
        if (p.bandwidthLimitKbps > 0 && !LIMITS.includes(Math.round(mb))) {
          setCustom(true);
          setCustomText(String(Math.round(mb * 10) / 10));
        }
      })
      .catch((e) => setFailed(errMessage(e)));
    api
      .downloadFolder()
      .then(setFolder)
      .catch(() => {});
  }, []);

  const change = (p: Partial<TransferPrefs>) => {
    if (prefs) setPrefs({ ...prefs, ...p });
    api
      .setTransferPrefs(p)
      .then(setPrefs)
      .catch((e) => {
        onToast("error", errMessage(e));
        api.transferPrefs().then(setPrefs).catch(() => {});
      });
  };

  const limitMb = prefs ? prefs.bandwidthLimitKbps / MBPS : 0;
  const preset = custom ? "custom" : LIMITS.find((l) => Math.abs(l - limitMb) < 0.05) ?? "custom";
  const customValue = Number(customText.replace(",", "."));
  const customBad = custom && customText.trim() !== "" && !(customValue > 0 && customValue <= 10_000);
  const applyCustom = () => {
    if (customBad || !customText.trim()) return;
    change({ bandwidthLimitKbps: Math.round(customValue * MBPS) });
  };

  return (
    <>
      <h3 className="set-title">Downloads</h3>
      <div className="set-card">
        <Row label="Ask where to save downloads" hint={settings.downloadAsk ? "Each download asks for a folder first." : `Downloads go straight to ${folder ?? "your Downloads folder"}. A file with the same name is kept and the new one gets a number.`}>
          <Switch label="Ask where to save downloads" on={settings.downloadAsk} onChange={(downloadAsk) => onChange({ downloadAsk })} />
        </Row>
        <Row label="Download folder" hint="Used when Kybl doesn’t ask, and as the starting folder when it does.">
          <span className="set-value selectable set-path" title={folder ?? undefined}>
            {folder ?? "Downloads"}
          </span>
        </Row>
      </div>

      <h3 className="set-title">Speed</h3>
      <div className="set-card">
        {failed && !prefs && (
          <Row label="Transfer settings" hint="These couldn’t be loaded.">
            <span className="set-value">{failed.split("\n")[0]}</span>
          </Row>
        )}
        {prefs && (
          <>
            <Row label="Files at the same time" hint="How many files each connection uploads or downloads at once. More is faster on a good line; fewer is kinder to slow connections.">
              <Seg label="Files at the same time" value={prefs.concurrency} options={COUNTS} onChange={(concurrency) => change({ concurrency })} />
            </Row>
            <Row label="Parts per file" hint="Big files move in parts. Sending several parts at once speeds up single large files.">
              <Seg label="Parts per file" value={prefs.partConcurrency} options={COUNTS} onChange={(partConcurrency) => change({ partConcurrency })} />
            </Row>
            <Row label="Speed limit" hint="Caps uploads and downloads together, so Kybl leaves room for everything else on your network." stack>
              <div className="set-limit">
                <Seg
                  label="Speed limit"
                  value={preset}
                  options={[...LIMITS.map((l) => ({ value: l as number | "custom", label: l === 0 ? "Unlimited" : `${l} MB/s` })), { value: "custom" as const, label: "Custom" }]}
                  onChange={(v) => {
                    if (v === "custom") {
                      setCustom(true);
                      setCustomText(limitMb > 0 ? String(Math.round(limitMb * 10) / 10) : "");
                    } else {
                      setCustom(false);
                      change({ bandwidthLimitKbps: Math.round((v as number) * MBPS) });
                    }
                  }}
                />
                {custom && (
                  <form
                    className="set-inline"
                    onSubmit={(e) => {
                      e.preventDefault();
                      applyCustom();
                    }}
                  >
                    <input
                      inputMode="decimal"
                      aria-label="Custom speed limit in MB/s"
                      aria-invalid={customBad}
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                      onBlur={applyCustom}
                      placeholder="e.g. 2.5"
                      autoFocus
                    />
                    <span>MB/s</span>
                    {customBad && <em className="pe-err">Enter a number above 0.</em>}
                  </form>
                )}
              </div>
            </Row>
          </>
        )}
      </div>
    </>
  );
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
                  <UpdatesRows onToast={onToast} />
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
                  <Row label="Photos" hint={PHOTOS_HINT}>
                    <Seg label="Photos" value={settings.imageMode} options={IMAGE_MODES.map((m) => ({ value: m.id, label: m.label }))} onChange={(imageMode) => onChange({ imageMode })} />
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
                  <Row label="List columns" hint="Shown after the name in the list. You can also right-click the column headers." stack>
                    <div className="set-checks" role="group" aria-label="List columns">
                      {COLUMN_CHOICES.map((c) => {
                        const on = settings.columns.includes(c.id);
                        return (
                          <button
                            key={c.id}
                            className={`chip-toggle ${on ? "on" : ""}`}
                            aria-pressed={on}
                            onClick={() =>
                              onChange({
                                columns: on ? settings.columns.filter((x) => x !== c.id) : COLUMN_CHOICES.map((x) => x.id).filter((x) => x === c.id || settings.columns.includes(x)),
                              })
                            }
                          >
                            {on && <Icon name="check" size={12} />}
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
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
                <TransferRows settings={settings} onChange={onChange} onToast={onToast} />
                <h3 className="set-title">Activity</h3>
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
            {page === "drives" && <MountsSection profiles={profiles} onToast={onToast} />}

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
                  <CacheRow onToast={onToast} />
                </div>

                <h3 className="set-title">Reset</h3>
                <div className="set-card">
                  <Row label="Reset all settings" hint="Back to the defaults. Connections, their keys and your favorites are not touched.">
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => onChange({ ...DEFAULTS, favorites: settings.favorites })}>
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
