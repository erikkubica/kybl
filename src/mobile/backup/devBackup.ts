/**
 * Phone backup in the browser mock (devMock.ts): sets kept in memory, runs that tick through
 * made-up photos and send `backup-status` like the phone's worker does.
 *
 * URL switches: `os=android|ios` (default from the user agent), `photos=granted|limited|denied`
 * (access before asking), `grant=limited|denied` (what asking gives), `backup=demo` (two sets
 * already there), `metered` (Wi-Fi only sets wait for Wi-Fi).
 */
import { emit } from "@tauri-apps/api/event";
import type { BackupFailure, BackupSet, BackupSetDraft, BackupSetStatus, BackupSource, PhotoAccess } from "../../api";
import { BACKUP_STATUS_EVENT } from "../../api";

const q = new URLSearchParams(location.search);
const platform: "android" | "ios" = q.get("os") === "android" || (!q.get("os") && /Android/i.test(navigator.userAgent)) ? "android" : "ios";
let photos: PhotoAccess = (q.get("photos") as PhotoAccess | null) ?? "notDetermined";
const now = Date.now();
const MIN = 60_000;

type Mock = { status: BackupSetStatus; failures: BackupFailure[]; timer?: number; runs: number };
const sets: Mock[] = [];

const blank = (s: BackupSet): BackupSetStatus => ({
  set: s,
  state: s.enabled ? "idle" : "paused",
  backedUp: 0,
  pending: 0,
  failed: 0,
  lastRun: null,
  lastError: null,
  current: null,
  runDone: 0,
  runTotal: 0,
});

function makeSet(d: BackupSetDraft): BackupSet {
  return {
    id: d.id || `set-${Math.random().toString(36).slice(2, 10)}`,
    source: d.source,
    profileId: d.profileId,
    root: d.root,
    destPrefix: d.destPrefix ? d.destPrefix.replace(/^\/+|\/+$/g, "") + "/" : "",
    destLabel: d.destLabel ?? d.root,
    template: d.template || "{yyyy}/{MM}/{name}",
    includeVideos: d.includeVideos ?? true,
    livePhotoVideo: d.livePhotoVideo ?? true,
    heic: d.heic ?? "keep",
    edited: d.edited ?? "current",
    wifiOnly: d.wifiOnly ?? true,
    chargingOnly: d.chargingOnly ?? false,
    since: d.since ?? null,
    enabled: d.enabled ?? true,
    created: d.created || Date.now(),
  };
}

if (q.get("backup") === "demo") {
  if (!q.get("photos")) photos = "granted";
  const roll = makeSet({ source: { type: "cameraRoll" }, profileId: "p1", root: "media-prod", destPrefix: "phone", destLabel: "Hetzner / media-prod / phone" });
  sets.push({
    runs: 1,
    status: { ...blank(roll), backedUp: 1284, failed: 2, lastRun: now - 42 * MIN },
    failures: [
      { sourceId: "a1", name: "IMG_3381.HEIC", error: "The connection dropped while sending this file.", at: now - 43 * MIN, attempts: 3 },
      { sourceId: "a2", name: "VID_0219.MOV", error: "This file is bigger than the bucket allows (5 GB).", at: now - 43 * MIN, attempts: 3 },
    ],
  });
  const tree: BackupSource =
    platform === "android" ? { type: "androidTree", uri: "content://tree/primary%3ADocuments%2FScans", label: "Documents/Scans" } : { type: "iosBookmark", bookmark: "Ym9va21hcms=", label: "Scans" };
  const folder = makeSet({ source: tree, profileId: "p1", root: "media-prod", destPrefix: "scans", destLabel: "Hetzner / media-prod / scans", template: "{path}", enabled: false });
  sets.push({ runs: 1, status: { ...blank(folder), backedUp: 96, pending: 4, lastRun: now - 3 * 24 * 60 * MIN }, failures: [] });
}

const copy = (s: BackupSetStatus): BackupSetStatus => JSON.parse(JSON.stringify(s));
const send = (m: Mock) => void emit(BACKUP_STATUS_EVENT, copy(m.status));
function find(id: string): Mock {
  const m = sets.find((x) => x.status.set.id === id);
  if (!m) throw "This backup isn't there any more.";
  return m;
}

function stop(m: Mock, state: BackupSetStatus["state"] = m.status.set.enabled ? "idle" : "paused") {
  if (m.timer) window.clearInterval(m.timer);
  m.timer = undefined;
  m.status.state = state;
  m.status.current = null;
}

function run(m: Mock) {
  const st = m.status;
  if (!st.set.enabled || m.timer) return;
  if (st.set.wifiOnly && q.has("metered")) {
    st.state = "waitingWifi";
    send(m);
    return;
  }
  if (st.set.source.type === "cameraRoll" && (photos === "denied" || photos === "notDetermined")) {
    st.lastError = "Kybl isn't allowed to see your photos.";
    send(m);
    return;
  }
  m.runs++;
  // the first run of a new set finds the whole library, later runs a few new photos
  if (!st.pending) st.pending = m.runs === 1 && st.backedUp === 0 ? (st.set.since ? 3 : 48) : 2 + Math.floor(Math.random() * 4);
  st.state = "running";
  st.lastError = null;
  st.runDone = 0;
  st.runTotal = st.pending;
  const failAt = m.runs === 1 ? new Set([7, 19]) : new Set<number>();
  let n = 4200 + Math.floor(Math.random() * 800);
  m.timer = window.setInterval(() => {
    if (st.runDone >= st.runTotal) {
      stop(m);
      st.lastRun = Date.now();
      st.runDone = st.runTotal = 0;
      send(m);
      return;
    }
    n++;
    const video = n % 9 === 0 && st.set.includeVideos;
    const name = st.set.source.type === "cameraRoll" ? `${video ? "VID" : "IMG"}_${n}.${video ? "MOV" : platform === "ios" ? "HEIC" : "jpg"}` : `scan-${n}.pdf`;
    st.runDone++;
    st.pending = Math.max(0, st.pending - 1);
    if (failAt.has(st.runDone)) {
      st.failed++;
      m.failures.push({ sourceId: `f${n}`, name, error: "The connection dropped while sending this file.", at: Date.now(), attempts: 3 });
    } else st.backedUp++;
    st.current = { name, done: 0, total: 0 };
    send(m);
  }, 380);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleBackup(cmd: string, a: any): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60));
  switch (cmd) {
    case "backup_overview":
      return { platform, sets: sets.map((m) => copy(m.status)) };
    case "backup_save": {
      const d = a.set as BackupSetDraft;
      const old = d.id ? sets.find((m) => m.status.set.id === d.id) : undefined;
      if (!d.profileId || !d.root) throw "Choose where the backup goes.";
      if (old) {
        old.status.set = makeSet({ ...old.status.set, ...d });
        if (!old.status.set.enabled) stop(old, "paused");
        else if (old.status.state === "paused") old.status.state = "idle";
        send(old);
        return copy(old.status);
      }
      const m: Mock = { status: blank(makeSet(d)), failures: [], runs: 0 };
      sets.push(m);
      send(m);
      return copy(m.status);
    }
    case "backup_delete": {
      const m = find(a.id);
      stop(m);
      sets.splice(sets.indexOf(m), 1);
      return null;
    }
    case "backup_set_paused": {
      const m = find(a.id);
      m.status.set.enabled = !a.paused;
      if (a.paused) stop(m, "paused");
      else m.status.state = "idle";
      send(m);
      return copy(m.status);
    }
    case "backup_run_now":
      for (const m of sets) if (!a.id || m.status.set.id === a.id) run(m);
      return null;
    case "backup_cancel":
      for (const m of sets)
        if ((!a.id || m.status.set.id === a.id) && m.timer) {
          stop(m);
          m.status.runDone = m.status.runTotal = 0;
          send(m);
        }
      return null;
    case "backup_failures":
      return find(a.id).failures.map((f) => ({ ...f }));
    case "backup_retry": {
      const m = find(a.id);
      const n = m.failures.length;
      m.failures = [];
      m.status.failed = 0;
      m.status.pending += n;
      send(m);
      run(m);
      return n;
    }
    case "backup_permission":
      return { photos, videos: photos, location: true, notifications: true };
    case "backup_request_permission":
      await new Promise((r) => setTimeout(r, 400));
      if (photos === "notDetermined") photos = (q.get("grant") as PhotoAccess | null) ?? "granted";
      return { photos, videos: photos, location: true, notifications: true };
    case "backup_manage_access":
      // the system picker / settings: pretend people allowed everything there
      await new Promise((r) => setTimeout(r, 400));
      photos = "granted";
      return null;
    case "backup_pick_folder":
      await new Promise((r) => setTimeout(r, 300));
      return platform === "android"
        ? { type: "androidTree", uri: "content://tree/primary%3ADownload", label: "Download" }
        : { type: "iosBookmark", bookmark: "Ym9va21hcms=", label: "Downloads" };
  }
  return undefined;
}
