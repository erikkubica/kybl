import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Icon, type IconName } from "../Icons";
import { SCHEMES, type Palette } from "../schemes";
import { ACCENTS, EXPIRIES, SCALES, isDark, resetSettings, type ColumnId, type FontChoice, type Settings, type Theme } from "../settings";
import { api, errMessage, type TransferPrefs } from "../api";
import { MBPS, TRANSFER_DEFAULTS, loadTransferPrefs, saveTransferPrefs, useTransferPrefsStore } from "../transferPrefs";
import { IMAGE_MODES } from "../imageMode";
import type { Profile } from "../types";
import { ProviderBadge } from "./Sidebar";
import { addressOf } from "../connections/kinds";
import { KyblLockup } from "./KyblMark";
import { SyncSection } from "./SyncSection";
// WP-E4: drives
import { MountsSection } from "../mount/MountsSection";
import { ActionsSection } from "../actions/ActionsSection";
import { syncApi, type AppPrefs } from "../sync";
import { openUrl } from "@tauri-apps/plugin-opener";
import { actionLabel, ago, installAndRestart, UpdateStepError, updatesApi, useUpdates } from "../updates";
import { formatBytes, mbpsToKbps } from "../format";
import { useTransfersActive } from "../useTransfers";
import { spellKeys } from "./shortcutKeys";
import { keys, THIS_COMPUTER, TRAY } from "./osText";

/** Shortcut keys show Mac glyphs on a Mac, Ctrl, Alt and Shift elsewhere. */
const MAC = /Mac/i.test(navigator.userAgent);

export type SettingsPageId = "general" | "appearance" | "browsing" | "transfers" | "actions" | "sync" | "drives" | "connections" | "storage" | "shortcuts";
type Page = SettingsPageId;

const NAV: { title: string; items: { id: Page; label: string; icon: IconName }[] }[] = [
  {
    title: "Settings",
    items: [
      { id: "general", label: "General", icon: "settings" },
      { id: "appearance", label: "Appearance", icon: "eye" },
      { id: "browsing", label: "Browsing", icon: "folder" },
      { id: "transfers", label: "Transfers and sharing", icon: "upload" },
      { id: "actions", label: "Actions", icon: "play" },
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

/** The file browser's shortcuts (desktop/useShortcuts.ts, the lists and the menu bar). */
const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Command palette: connections, folders, commands, files", keys: ["⌘", "K"] },
  { label: "Command palette: open in a new pane / complete a path", keys: ["⌘↵", "Tab"] },
  { label: "Search this folder", keys: ["⌘", "F"] },
  { label: "Find a connection in the sidebar", keys: ["⌥", "⌘", "F"] },
  { label: "Show or hide the sidebar", keys: ["⌥", "⌘", "S"] },
  { label: "Go to folder", keys: ["⇧⌘G", "⌘L"] },
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
  { label: "Edit a file (uploads it back when you save)", keys: ["⌘", "E"] },
  { label: "Quick Look", keys: ["Space"] },
  { label: "Get Info (Quick Look with details)", keys: ["⌘", "I"] },
  { label: "Actions menu for the selection", keys: ["⇧", "F10"] },
  { label: "Copy / cut / paste items", keys: ["⌘C", "⌘X", "⌘V"] },
  { label: "Duplicate", keys: ["⌘", "D"] },
  { label: "Undo the last move, copy or rename", keys: ["⌘", "Z"] },
  { label: "Copy instead of moving while dragging", keys: ["⌥"] },
  { label: "Rename", keys: ["F2"] },
  { label: "New folder", keys: ["⇧", "⌘", "N"] },
  { label: "Upload files", keys: ["⌘", "U"] },
  { label: "Upload a folder", keys: ["⇧", "⌘", "U"] },
  { label: "Download selection", keys: ["⇧", "⌘", "D"] },
  { label: "Delete selection", keys: ["⌘⌫", "⌦"] },
  { label: "Clear selection / close dialog", keys: ["Esc"] },
  { label: "Settings", keys: ["⌘", ","] },
  { label: `${THIS_COMPUTER}: show or hide hidden files`, keys: ["⇧", "⌘", "."] },
  { label: "Grid view: bigger / smaller tiles", keys: ["⌘+", "⌘−"] },
  { label: "Split the pane right / down", keys: ["⌘\\", "⇧⌘\\"] },
  { label: "Close the pane", keys: ["⌘", "W"] },
  { label: "Go to the pane on that side", keys: ["⌥", "⌘", "arrow"] },
  { label: "Terminal below the pane", keys: ["⌃", "`"] },
  { label: "Two panes: switch pane", keys: ["Tab"] },
  { label: "Two panes: copy / move to the other pane", keys: ["F5", "F6"] },
  { label: "Two panes: quick look, new folder, delete", keys: ["F3", "F7", "F8"] },
  { label: "Two panes: swap them", keys: ["⇧", "⌘", "S"] },
  { label: "Two panes: copy instead of moving while dragging across", keys: ["drop copies, ⌘ moves"] },
  { label: "New workspace", keys: ["⌘", "T"] },
  { label: "Next / previous workspace", keys: ["⌃Tab", "⌃⇧Tab"] },
  { label: "Next / previous workspace (also)", keys: ["⇧⌘]", "⇧⌘["] },
  { label: "Go to workspace 1–8 / the last one", keys: ["⌥⌘1…8", "⌥⌘9"] },
  { label: "Move the workspace left / right", keys: ["⌥⇧⌘[", "⌥⇧⌘]"] },
  { label: "Rename a workspace", keys: ["double-click its tab"] },
];

/** Automatic checks, "Check now", and installing what a check found. */
function UpdatesRows({ onToast }: { onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const st = useUpdates();
  // transfers are running: "Restart now" asks once more before it stops them
  const [busyAsk, setBusyAsk] = useState(false);
  // once the transfers end, the next click is a plain restart again (it asks anew if still busy)
  const transfersActive = useTransfersActive();
  useEffect(() => {
    if (!transfersActive) setBusyAsk(false);
  }, [transfersActive]);
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
          ? busyAsk
            ? "Transfers are still running. Restarting now stops them."
            : `Kybl ${rel?.version} is installed. Restart to use it.`
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
            <button
              className={`btn btn-sm ${busyAsk ? "btn-danger" : "btn-primary"}`}
              onClick={() =>
                updatesApi.restart(busyAsk).catch((e) => {
                  if (String(e) === "busy") setBusyAsk(true);
                  else onToast("error", String(e));
                })
              }
            >
              {busyAsk ? "Restart anyway" : "Restart now"}
            </button>
          ) : rel ? (
            <button
              className="btn btn-sm btn-primary"
              disabled={working}
              onClick={() =>
                rel.how === "install"
                  ? installAndRestart(() => setBusyAsk(true)).catch((e) =>
                      onToast("error", e instanceof UpdateStepError && e.step === "restart" ? `Kybl couldn't restart: ${e.message}` : `The update didn't install: ${errMessage(e)}`),
                    )
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
        {hint && <small>{keys(hint)}</small>}
      </div>
      {children}
    </div>
  );
}

/** Thumbnails and recently opened files, with what they take on disk; one button clears both. */
function CacheRow({ onToast }: { onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const [usage, setUsage] = useState<{ thumbnails: number; files: number; inUse?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .cacheUsage()
      .then((u) => (setUsage(u), u))
      .catch(() => (setUsage(null), null));
  useEffect(() => {
    void load();
  }, []);
  const clear = async () => {
    setBusy(true);
    try {
      const freed = await api.clearCaches();
      const kept = (await load())?.inUse ?? 0;
      const keptText = kept ? `${formatBytes(kept)} open in other apps is kept` : "";
      onToast(
        "success",
        freed ? `Cache cleared (${formatBytes(freed)} freed${kept ? `; ${keptText}` : ""})` : kept ? `Nothing to clear; ${keptText}` : "The cache was already empty",
      );
    } catch (e) {
      onToast("error", errMessage(e));
      void load();
    } finally {
      setBusy(false);
    }
  };
  const hint =
    "Thumbnails, photo placeholders and recently opened files are kept on this computer, so folders and documents reopen without downloading again. Clearing is safe; they are fetched again when needed. Files opened in other apps in the last hour are kept." +
    (usage ? ` Now: ${formatBytes(usage.thumbnails)} of thumbnails, ${formatBytes(usage.files)} of files${usage.inUse ? ` (${formatBytes(usage.inUse)} in use)` : ""}.` : "");
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

const LIMITS = [0, 1, 5, 10, 25, 50];
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) }));
const VERIFY: { value: TransferPrefs["verify"]; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "size", label: "Size" },
  { value: "checksum", label: "Checksum" },
];

/** One direction's speed limit: presets, or a number of MB/s of your own. */
function LimitPicker({ label, kbps, onSet }: { label: string; kbps: number; onSet: (kbps: number) => void }) {
  const mb = kbps / MBPS;
  const fits = LIMITS.some((l) => Math.abs(l - mb) < 0.05);
  const [custom, setCustom] = useState(!fits);
  const [customText, setCustomText] = useState(fits || kbps === 0 ? "" : String(Math.round(mb * 10) / 10));
  // changed elsewhere (the Activity panel's speed menu): follow it
  useEffect(() => {
    if (fits) setCustom(false);
    else {
      setCustom(true);
      setCustomText(String(Math.round(mb * 10) / 10));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbps]);
  const preset = custom ? "custom" : LIMITS.find((l) => Math.abs(l - mb) < 0.05) ?? "custom";
  const customValue = Number(customText.replace(",", "."));
  const customBad = custom && customText.trim() !== "" && !(customValue > 0 && customValue <= 10_000);
  const applyCustom = () => {
    if (customBad || !customText.trim()) return;
    // a tiny limit stays a limit (1 KB/s at least), never "Unlimited"
    onSet(mbpsToKbps(customValue));
  };
  return (
    <div className="set-limit">
      <Seg
        label={label}
        value={preset}
        options={[...LIMITS.map((l) => ({ value: l as number | "custom", label: l === 0 ? "Unlimited" : `${l} MB/s` })), { value: "custom" as const, label: "Custom" }]}
        onChange={(v) => {
          if (v === "custom") {
            setCustom(true);
            setCustomText(mb > 0 ? String(Math.round(mb * 10) / 10) : "");
          } else {
            setCustom(false);
            onSet(Math.round((v as number) * MBPS));
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
            aria-label={`${label} in MB/s`}
            aria-invalid={customBad}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onBlur={applyCustom}
            placeholder="e.g. 2.5"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
          <span>MB/s</span>
          {customBad && <em className="pe-err">Enter a number above 0.</em>}
        </form>
      )}
    </div>
  );
}

/** Transfer tuning (backend prefs) plus where downloads go (a desktop setting). */
function TransferRows({ settings, onChange, onToast }: { settings: Settings; onChange: (patch: Partial<Settings>) => void; onToast: (kind: "success" | "error" | "info", text: string) => void }) {
  const prefs = useTransferPrefsStore();
  const [failed, setFailed] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    loadTransferPrefs().catch((e) => setFailed(errMessage(e)));
    api
      .downloadFolder()
      .then(setFolder)
      .catch(() => {});
  }, []);

  const change = (p: Partial<TransferPrefs>) => {
    saveTransferPrefs(p).catch((e) => onToast("error", errMessage(e)));
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
            <Row label="Download limit" hint="Shared by every download at once, so Kybl leaves room for everything else on your network. Changes apply to running transfers." stack>
              <LimitPicker label="Download limit" kbps={prefs.downloadLimitKbps} onSet={(downloadLimitKbps) => change({ downloadLimitKbps })} />
            </Row>
            <Row label="Upload limit" hint="Shared by every upload at once." stack>
              <LimitPicker label="Upload limit" kbps={prefs.uploadLimitKbps} onSet={(uploadLimitKbps) => change({ uploadLimitKbps })} />
            </Row>
          </>
        )}
      </div>

      {prefs && (
        <>
          <h3 className="set-title">Checking</h3>
          <div className="set-card">
            <Row
              label="Verify files after copying"
              hint={
                prefs.verify === "checksum"
                  ? "Compares checksums where both sides have one (S3, Google Drive, Dropbox, OneDrive, SFTP), else the size. Reads each local file once more. Encrypted connections compare the size only."
                  : prefs.verify === "size"
                    ? "Compares the size of each file once it’s copied. A file that doesn’t match is marked failed, with Retry."
                    : "Trusts the server’s answer that the file arrived."
              }
            >
              <Seg label="Verify files after copying" value={prefs.verify} options={VERIFY} onChange={(verify) => change({ verify })} />
            </Row>
          </div>
        </>
      )}
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
  onImportProfiles,
  onClose,
  initialPage,
  pageRequest,
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
  /** "Import connections…" from FileZilla and other apps (computers only) */
  onImportProfiles?: () => void;
  onClose: () => void;
  initialPage?: SettingsPageId;
  /** changes on every request to open a page, even the same one again */
  pageRequest?: number;
  activeProfileId: string | null;
  onToast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  const [page, setPage] = useState<Page>(initialPage ?? "general");
  const [confirmReset, setConfirmReset] = useState(false);
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  useEffect(() => {
    if (initialPage) setPage(initialPage);
  }, [initialPage, pageRequest]);
  // the red "Reset all" asks again after another page was visited
  useEffect(() => setConfirmReset(false), [page]);
  const resetAll = () => {
    setConfirmReset(false);
    onChange(resetSettings(settings));
    onCompact(false);
    saveTransferPrefs(TRANSFER_DEFAULTS).catch((e) => onToast("error", errMessage(e)));
    if (prefs && !prefs.closeToTray) changePrefs({ closeToTray: true });
    updatesApi.settings({ auto: true }).catch(() => {});
    onToast("success", "Settings are back to the defaults");
  };
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
                    <h3 className="set-title">{MAC ? "Menu bar" : "System tray"}</h3>
                    <div className="set-card">
                      <Row label={`Keep running in the ${TRAY}`} hint={`Closing the window keeps the app (and folder sync) running behind the ${TRAY} icon. Quit from that icon${MAC ? " or with ⌘Q" : ""}.`}>
                        <Switch label={`Keep running in the ${TRAY}`} on={prefs.closeToTray} onChange={(closeToTray) => changePrefs({ closeToTray })} />
                      </Row>
                      <Row label="Open at login" hint={`Starts quietly in the ${TRAY} when you log in, so synced folders stay current.`}>
                        <Switch label="Open at login" on={prefs.launchAtLogin} onChange={(launchAtLogin) => changePrefs({ launchAtLogin })} />
                      </Row>
                    </div>
                  </>
                )}

                <h3 className="set-title">Safety</h3>
                <div className="set-card">
                  <Row label="Confirm before deleting" hint="On most connections a delete cannot be undone. Drives and the Trash keep what you delete.">
                    <Switch label="Confirm before deleting" on={settings.confirmDelete} onChange={(confirmDelete) => onChange({ confirmDelete })} />
                  </Row>
                  <Row label="Secret keys" hint="Saved encrypted, never in a settings file. The key is in the system keychain.">
                    <span className="set-value">Encrypted</span>
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
                  <Row label="Mode" hint="System follows your computer’s light or dark setting.">
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
                  <Row label="Share link lifetime" hint={keys("Used by the quick “Copy link” actions. Get Info (⌘I) can still pick another.")}>
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
            {page === "actions" && <ActionsSection onToast={onToast} />}

            {page === "connections" && (
              <>
                <h3 className="set-title">Connections</h3>
                <div className="set-card">
                  {profiles.length === 0 && <Row label="No connections yet" hint="Add one to start browsing." />}
                  {profiles.map((p) => (
                    <div key={p.id} className="conn-row">
                      <ProviderBadge provider={p.provider} large />
                      <div className="set-label">
                        {p.name}
                        <small className="selectable">
                          {/* servers and drives have no endpoint or region: their own address */}
                          {p.kind && p.kind !== "s3" ? (
                            addressOf(p)
                          ) : (
                            <>
                              {p.endpoint || "Amazon S3"} · {p.region}
                              {p.bucket ? ` · ${p.bucket}` : ""}
                            </>
                          )}
                        </small>
                      </div>
                      <button className="btn btn-sm" onClick={() => onEditProfile(p)}>
                        Edit
                      </button>
                    </div>
                  ))}
                </div>
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary btn-sm" onClick={onNewProfile}>
                    <Icon name="plus" size={14} /> New connection
                  </button>
                  {onImportProfiles && (
                    <button className="btn btn-sm" onClick={onImportProfiles}>
                      <Icon name="download" size={14} /> Import connections…
                    </button>
                  )}
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
                  <Row
                    label="Reset all settings"
                    hint="Back to the defaults, transfer settings included. Connections, favorites, sync, actions, layout and Open at login stay."
                  >
                    {confirmReset ? (
                      <div className="btn-row">
                        <button className="btn btn-sm" autoFocus onClick={() => setConfirmReset(false)}>
                          Cancel
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={resetAll}>
                          Reset all
                        </button>
                      </div>
                    ) : (
                      <button className="btn btn-sm btn-danger-ghost" onClick={() => setConfirmReset(true)}>
                        Reset
                      </button>
                    )}
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
                          {spellKeys(sc.keys, MAC).map((k) => (
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
