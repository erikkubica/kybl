/**
 * Browser-only stand-in for the Rust backend, so the UI can be designed with plain `pnpm dev`
 * (no Tauri window). Loaded from main.tsx only in dev and only when Tauri is absent; it is never
 * part of a release build.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { ObjInfo, Profile } from "./types";

const HOUR = 3600_000;
const now = Date.now();

const profiles: Profile[] = [
  { id: "p1", name: "Hetzner · media", provider: "hetzner", endpoint: "https://nbg1.your-objectstorage.com", region: "nbg1", accessKeyId: "DEMOKEY", bucket: "media-prod", pathStyle: false },
  { id: "p2", name: "AWS production", provider: "aws", endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1", accessKeyId: "DEMOKEY", bucket: null, pathStyle: false },
  { id: "p3", name: "Local MinIO", provider: "custom", endpoint: "http://localhost:9000", region: "us-east-1", accessKeyId: "minio", bucket: null, pathStyle: true },
];

const mockTags: Record<string, Record<string, string>> = {};
const transferPrefs = { concurrency: 3, partConcurrency: 4, bandwidthLimitKbps: 0, wifiOnly: false };

const buckets = ["media-prod", "backups", "static-assets", "logs-archive"];

const obj = (key: string, size: number, ageHours: number): ObjInfo => ({
  key,
  size,
  modified: now - ageHours * HOUR,
  etag: `"${Math.abs(hash(key)).toString(16).padStart(8, "0")}d41d8cd98f00b204e98"`,
  storageClass: "STANDARD",
});

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h;
}

const tree: Record<string, { folders: string[]; objects: ObjInfo[] }> = {
  "": {
    folders: ["photos/", "videos/", "documents/", "exports/", "website/"],
    objects: [
      obj("README.md", 2_140, 2),
      obj("inventory-2026.csv", 48_210, 30),
      obj("backup-2026-11-10.tar.gz", 1_840_000_000, 50),
      obj("hero-banner.jpg", 2_400_000, 4),
      obj("team-offsite.png", 5_100_000, 190),
      obj("promo-cut-final-v3.mp4", 248_000_000, 400),
      obj("podcast-episode-14.mp3", 38_400_000, 800),
      obj("invoice-0042.pdf", 184_000, 1200),
      obj("config.json", 812, 0.3),
      obj("pitch-deck.pptx", 12_800_000, 2600),
      obj("a-really-long-file-name-that-should-truncate-nicely-in-every-view-2026-final-final.zip", 96_000_000, 9000),
    ],
  },
  "photos/": {
    folders: ["photos/2025/", "photos/2026/"],
    objects: Array.from({ length: 64 }, (_, i) =>
      obj(`photos/IMG_${String(4100 + i).padStart(4, "0")}.${i % 9 === 0 ? "png" : "jpg"}`, 1_800_000 + ((i * 337_133) % 6_000_000), 5 + i * 7),
    ),
  },
  "photos/2026/": { folders: ["photos/2026/hanoi/"], objects: [obj("photos/2026/cover.jpg", 3_200_000, 20)] },
  "photos/2026/hanoi/": {
    folders: ["photos/2026/hanoi/street-food/"],
    objects: [obj("photos/2026/hanoi/old-quarter.jpg", 4_200_000, 20)],
  },
  "photos/2026/hanoi/street-food/": { folders: [], objects: [obj("photos/2026/hanoi/street-food/pho.jpg", 2_900_000, 21)] },
  // big folder: listed 1000 at a time, to exercise paging + sorting
  "videos/": {
    folders: [],
    objects: Array.from({ length: 4500 }, (_, i) =>
      obj(`videos/clip-${String(i).padStart(5, "0")}.mp4`, 1_000_000 + ((i * 7_919_333) % 900_000_000), 1 + ((i * 131) % 9000)),
    ),
  },
  "documents/": { folders: [], objects: [obj("documents/contract.pdf", 320_000, 70), obj("documents/notes.txt", 1_900, 12)] },
  "exports/": { folders: [], objects: [] },
};

const HUES = [212, 262, 162, 28, 340, 190, 48, 290];
function thumbFor(key: string): string {
  const h = Math.abs(hash(key));
  const a = HUES[h % HUES.length];
  const b = HUES[(h >> 3) % HUES.length];
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${a} 70% 62%)'/><stop offset='1' stop-color='hsl(${b} 65% 38%)'/></linearGradient></defs>` +
    `<rect width='320' height='320' fill='url(#g)'/>` +
    `<circle cx='${60 + (h % 200)}' cy='${70 + ((h >> 4) % 160)}' r='${40 + (h % 50)}' fill='hsl(${b} 80% 80% / .35)'/>` +
    `<path d='M0 250 L90 170 L160 230 L230 150 L320 240 V320 H0Z' fill='hsl(${a} 50% 20% / .45)'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cancelled = new Set<string>();

async function simulateTransfer(id: string, total: number, fail = false) {
  await sleep(200 + Math.random() * 600);
  const steps = 14 + Math.floor(Math.random() * 30);
  for (let i = 1; i <= steps; i++) {
    if (cancelled.has(id)) {
      await emit("transfer", { id, state: "cancelled", bytes: 0, total, error: null });
      return;
    }
    if (fail && i > steps / 2) {
      await emit("transfer", { id, state: "error", bytes: 0, total, error: "AccessDenied: the key does not allow s3:PutObject" });
      return;
    }
    await emit("transfer", { id, state: "running", bytes: Math.round((total * i) / steps), total, error: null });
    await sleep(260);
  }
  await emit("transfer", { id, state: "done", bytes: total, total, error: null });
}

let uploadCount = 0;

// ---- folder sync
type MockMapping = { id: string; profileId: string; bucket: string; prefix: string; localPath: string; direction: "upload" | "download"; ignore: string[]; mirrorDeletes: boolean; intervalMins: number; paused: boolean };
const syncMappings: MockMapping[] = [
  { id: "s1", profileId: "p1", bucket: "media-prod", prefix: "photos/", localPath: "/Users/demo/Pictures/Exports", direction: "upload", ignore: [".DS_Store", "*.tmp"], mirrorDeletes: false, intervalMins: 5, paused: false },
  { id: "s2", profileId: "p1", bucket: "static-assets", prefix: "", localPath: "/Users/demo/Sites/assets", direction: "download", ignore: [".DS_Store"], mirrorDeletes: true, intervalMins: 15, paused: false },
];
const syncStatus: Record<string, Record<string, unknown>> = {
  s1: { id: "s1", state: "idle", lastSync: now - 4 * 60_000, error: null, current: null, done: 0, total: 0, files: 1284, summary: "3 uploaded" },
  s2: { id: "s2", state: "error", lastSync: now - 3 * HOUR, error: "AccessDenied: this key cannot list objects in static-assets", current: null, done: 0, total: 0, files: 312, summary: null },
};
let syncPausedAll = false;
const prefs = { closeToTray: true, launchAtLogin: false };
// ?update in the URL pretends a new version is out, to design the update card
const updateRelease = {
  version: "0.4.0",
  page: "https://github.com/erikkubica/kybl/releases/tag/v0.4.0",
  notes: "",
  published: new Date().toISOString(),
  how: "install",
  asset: { name: "Kybl_aarch64.app.tar.gz", url: "https://example.invalid/Kybl.tar.gz", size: 4_903_400, sha256: null },
};
const updateState = {
  current: "0.3.2",
  auto: true,
  skipped: null as string | null,
  checking: false,
  lastChecked: null as number | null,
  error: null as string | null,
  available: (new URLSearchParams(location.search).has("update") ? updateRelease : null) as typeof updateRelease | null,
  phase: "",
  received: 0,
  total: 0,
};
const pushUpdate = (patch: Partial<typeof updateState>) => {
  Object.assign(updateState, patch);
  return emit("update-status", { ...updateState });
};
async function pushStatus(id: string, patch: Record<string, unknown>) {
  syncStatus[id] = { ...(syncStatus[id] ?? { id, state: "idle", lastSync: null, error: null, current: null, done: 0, total: 0, files: 0, summary: null }), ...patch };
  await emit("sync-status", syncStatus[id]);
}
async function simulateSync(id: string) {
  await pushStatus(id, { state: "scanning", error: null });
  await sleep(900);
  const total = 18;
  for (let i = 0; i <= total; i++) {
    await pushStatus(id, { state: "syncing", done: i, total, current: "Strata/Models/mmproj-Qwen3.8-Flash-Next-BF16.gguf", bytes: i * 48_000_000, totalBytes: 907_000_000 });
    await sleep(220);
  }
  const files = Number(syncStatus[id]?.files ?? 0) + total;
  await pushStatus(id, { state: "idle", done: 0, total: 0, current: null, files, lastSync: Date.now(), summary: `${total} uploaded` });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handle(cmd: string, a: any): Promise<unknown> {
  switch (cmd) {
    case "list_profiles":
      return profiles;
    case "save_profile": {
      const p = { ...a.profile, id: a.profile.id || `p${Date.now()}` };
      const i = profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) profiles[i] = p;
      else profiles.push(p);
      return p;
    }
    case "delete_profile":
      profiles.splice(profiles.findIndex((x) => x.id === a.id), 1);
      return null;
    case "kybl_default_app_url":
      return "http://127.0.0.1:8080";
    case "kybl_connect_cancel":
      cancelled.add(a.flowId);
      return null;
    case "kybl_device_start":
      await sleep(400);
      return {
        deviceCode: "dev",
        userCode: "BCDF-GHJK",
        verificationUri: "http://127.0.0.1:8080/link",
        verificationUriComplete: "http://127.0.0.1:8080/link?code=BCDF-GHJK",
        expiresIn: 600,
        interval: 5,
        qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="#fff"/><path d="M0 0h2v2H0zM2 2h2v2H2z" fill="#111"/></svg>',
      };
    case "kybl_connect_browser":
    case "kybl_device_wait": {
      for (let i = 0; i < (cmd === "kybl_device_wait" ? 40 : 15); i++) {
        await sleep(200);
        if (cancelled.has(a.flowId)) throw "Cancelled";
      }
      const p: Profile = { id: a.replaceId ?? `k${Date.now()}`, name: "Kybl Storage (demo@example.com)", provider: "kybl", endpoint: "http://127.0.0.1:9000", region: "eu-central", accessKeyId: "KYBLDEMO", bucket: null, pathStyle: true };
      const i = profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) profiles[i] = p;
      else profiles.push(p);
      return p;
    }
    case "test_connection":
      await sleep(700);
      if (!a.profile.endpoint) throw "Endpoint is required";
      return "Connected. 4 buckets visible.";
    case "create_bucket":
      await sleep(200);
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(a.bucket)) throw "Bucket names are 3-63 characters: lowercase letters, digits, dots and hyphens.";
      if (buckets.includes(a.bucket)) throw "You already have a bucket with that name.";
      buckets.push(a.bucket);
      return null;
    case "list_buckets":
      await sleep(150);
      if (a.profileId === "p3") throw "Access denied. This key isn't allowed to do that.\n\nservice error: unhandled error (AccessDenied): Access Denied (ServiceError { source: Unhandled(Unhandled { code: Some(\"AccessDenied\") }) })";
      return buckets.map((name) => ({ name, created: now - 400 * HOUR }));
    case "list_objects": {
      await sleep(350);
      // set window.__denyLists = n in the console to have the next n listings refused
      const w = window as unknown as { __denyLists?: number };
      if (w.__denyLists) {
        w.__denyLists--;
        throw "Access denied. This key isn't allowed to do that. If the key is brand new, give it a few minutes: some providers take a while to activate new keys.\n\nservice error: unhandled error (AccessDenied): (ServiceError { source: Unhandled(Unhandled { code: Some(\"AccessDenied\") }), raw: Response { status: StatusCode(403) } })";
      }
      if (a.bucket === "logs-archive") throw "Can't reach the storage server. Nothing is answering at that address: check the connection's endpoint, or that the server is running.\n\ndispatch failure: io error: client error (Connect): tcp connect error: Connection refused (os error 61) (DispatchFailure(DispatchFailure { source: ConnectorError { kind: Io, source: hyper_util::client::legacy::Error(Connect, ConnectError(\"tcp connect error\", 127.0.0.1:9099, Os { code: 61, kind: ConnectionRefused }))) } }))";
      const dir = a.bucket === "media-prod" ? tree[a.prefix] : undefined;
      const start = Number(a.token ?? 0);
      const all = dir?.objects ?? [];
      return {
        folders: start === 0 ? (dir?.folders ?? []) : [],
        objects: all.slice(start, start + 1000),
        nextToken: start + 1000 < all.length ? String(start + 1000) : null,
      };
    }
    case "search_objects": {
      const q = String(a.query).toLowerCase();
      const objects = Object.values(tree)
        .flatMap((d) => d.objects)
        .filter((o) => o.key.startsWith(a.prefix) && o.key.toLowerCase().includes(q));
      // pretend to page through 18k keys, matches turning up along the way
      const pages = 8;
      for (let i = 1; i <= pages; i++) {
        await sleep(450);
        const found = objects.slice(Math.floor(((i - 1) * objects.length) / pages), Math.floor((i * objects.length) / pages));
        if (a.opId) await emit("search-progress", { opId: a.opId, scanned: Math.round((18_422 * i) / pages), found });
      }
      return { objects, scanned: 18_422, truncated: false };
    }
    case "head_object": {
      await sleep(200);
      const o = Object.values(tree).flatMap((d) => d.objects).find((x) => x.key === a.key);
      if (!o) throw "NotFound";
      const ext = a.key.split(".").pop();
      const types: Record<string, string> = { jpg: "image/jpeg", png: "image/png", md: "text/markdown", json: "application/json", pdf: "application/pdf", mp4: "video/mp4", csv: "text/csv" };
      return { key: a.key, size: o?.size ?? 0, contentType: types[ext] ?? "application/octet-stream", modified: o?.modified ?? null, etag: o?.etag ?? null, storageClass: "STANDARD", metadata: ext === "jpg" ? { "uploaded-by": "demo", camera: "X100VI" } : {} };
    }
    case "get_text_preview":
      await sleep(250);
      return {
        text: a.key.endsWith(".json")
          ? JSON.stringify({ name: "media-prod", region: "nbg1", versioning: false, lifecycle: [{ prefix: "exports/", expireDays: 30 }] }, null, 2)
          : "# media-prod\n\nProduction media bucket.\n\n- photos/   original uploads\n- videos/   encoded masters\n- exports/  temporary, expires after 30 days\n",
        truncated: false,
      };
    case "get_object_bytes":
      await sleep(300);
      return demoPdf();
    case "presign_get":
      await sleep(200);
      return /\.(jpg|png)$/.test(a.key) ? thumbFor(a.key) : `https://media-prod.nbg1.your-objectstorage.com/${a.key}?X-Amz-Signature=demo`;
    case "create_folder":
      tree[""].folders.push(a.prefix);
      return null;
    case "delete_objects": {
      const total = (a.keys.length + a.prefixes.length) * 3000;
      for (let done = 0; done <= total; done += 1000) {
        if (cancelled.has(a.opId)) return { done, total, error: "Cancelled" };
        await emit("move-progress", { opId: a.opId, phase: "deleting", done, total, bytes: 0, totalBytes: 0 });
        await sleep(400);
      }
      for (const d of Object.values(tree)) {
        d.objects = d.objects.filter((o) => !a.keys.includes(o.key));
        d.folders = d.folders.filter((f) => !a.prefixes.includes(f));
      }
      return { done: total, total, error: null };
    }
    case "move_many": {
      // pretend each item is a big folder so progress/ETA can be seen
      const total = 600 * a.items.length;
      const totalBytes = total * 3_400_000;
      await emit("move-progress", { opId: a.opId, phase: "listing", done: 0, total: 0, bytes: 0, totalBytes: 0 });
      await sleep(700);
      for (let done = 0; done <= total; done += 12) {
        if (cancelled.has(a.opId)) return { done, total, error: "Cancelled" };
        await emit("move-progress", { opId: a.opId, phase: "copying", done, total, bytes: done * 3_400_000, totalBytes });
        await sleep(160);
      }
      for (const it of a.items) await handle("copy_or_move", { ...it, deleteSource: a.deleteSource });
      return { done: total, total, error: null };
    }
    case "copy_or_move": {
      await sleep(400);
      const dirOf = (k: string) => k.slice(0, k.replace(/\/$/, "").lastIndexOf("/") + 1);
      const ensure = (d: string) => (tree[d] ??= { folders: [], objects: [] });
      if (a.isPrefix) {
        if (a.to.startsWith(a.from)) throw "Cannot copy a folder into itself";
        let n = 0;
        for (const [k, d] of Object.entries({ ...tree })) {
          if (!k.startsWith(a.from)) continue;
          const nk = a.to + k.slice(a.from.length);
          const nd = ensure(nk);
          nd.folders = [...new Set([...nd.folders, ...d.folders.map((f) => a.to + f.slice(a.from.length))])];
          nd.objects = [...nd.objects.filter((o) => !d.objects.some((x) => a.to + x.key.slice(a.from.length) === o.key)), ...d.objects.map((o) => ({ ...o, key: a.to + o.key.slice(a.from.length) }))];
          n += d.objects.length;
          if (a.deleteSource) delete tree[k];
        }
        const parent = ensure(dirOf(a.to));
        if (!parent.folders.includes(a.to)) parent.folders.push(a.to);
        if (a.deleteSource) {
          const sp = tree[dirOf(a.from)];
          if (sp) sp.folders = sp.folders.filter((f) => f !== a.from);
        }
        return Math.max(n, 1);
      }
      const src = tree[dirOf(a.from)];
      const o = src?.objects.find((x) => x.key === a.from);
      if (!o) throw "NoSuchKey";
      const dst = ensure(dirOf(a.to));
      dst.objects = [...dst.objects.filter((x) => x.key !== a.to), { ...o, key: a.to, modified: Date.now() }];
      if (a.deleteSource) src.objects = src.objects.filter((x) => x.key !== a.from);
      const parent = ensure(dirOf(dirOf(a.to)));
      if (dirOf(a.to) && !parent.folders.includes(dirOf(a.to))) parent.folders.push(dirOf(a.to));
      return 1;
    }
    case "expand_paths":
      return (a.paths as string[]).map((p, i) => ({ path: p, rel: p.split("/").pop(), size: 4_000_000 * (i + 1) * 7 }));
    case "list_all_under":
      return (tree[a.prefix]?.objects ?? []).map((o) => ({ key: o.key, size: o.size }));
    case "start_upload":
      simulateTransfer(a.id, 28_000_000 + Math.random() * 90_000_000, ++uploadCount % 4 === 0);
      return null;
    case "start_download":
      simulateTransfer(a.id, 18_000_000 + Math.random() * 60_000_000);
      return a.destPath;
    case "existing_keys": {
      const all = new Set(Object.values(tree).flatMap((n) => n.objects.map((o) => o.key)));
      const dirs = new Set(Object.keys(tree).concat(Object.values(tree).flatMap((n) => n.folders)));
      return {
        keys: (a.keys as string[]).filter((k) => all.has(k)),
        prefixes: (a.prefixes as string[]).filter((p) => dirs.has(p)),
      };
    }
    case "update_object_props":
      return { key: a.key, size: 1000, contentType: a.props.contentType ?? "application/octet-stream", modified: Date.now(), etag: null, storageClass: a.props.storageClass ?? "STANDARD", metadata: a.props.metadata ?? {}, cacheControl: a.props.cacheControl ?? null, contentDisposition: a.props.contentDisposition ?? null, contentEncoding: a.props.contentEncoding ?? null };
    case "get_object_tags":
      return mockTags[a.key] ?? {};
    case "put_object_tags":
      mockTags[a.key] = a.tags;
      return null;
    case "folder_size": {
      const keys = Object.entries(tree).filter(([k]) => k.startsWith(a.prefix)).flatMap(([, n]) => n.objects);
      return { bytes: keys.reduce((s, o) => s + o.size, 0), objects: keys.length };
    }
    case "temp_folder":
      return "/tmp/kybl";
    case "open_local":
    case "reveal_local":
    case "share_files":
    case "share_text":
    case "save_to_photos":
    case "haptic":
    case "set_privacy_screen":
      console.info("[mock]", cmd, a);
      return null;
    case "biometric_unlock":
      console.info("[mock]", cmd, a);
      return true;
    case "take_shared_files":
      return [];
    case "get_transfer_prefs":
      return transferPrefs;
    case "set_transfer_prefs":
      Object.assign(transferPrefs, a.prefs);
      return transferPrefs;
    case "active_transfers":
      return [];
    case "cancel_transfer":
      cancelled.add(a.id);
      return null;
    case "sync_list":
      return { pausedAll: syncPausedAll, mappings: syncMappings, statuses: Object.values(syncStatus) };
    case "sync_save": {
      const m = { ...a.mapping, id: a.mapping.id || `s${Date.now()}` };
      if (!m.localPath) throw "Choose an existing local folder.";
      const i = syncMappings.findIndex((x) => x.id === m.id);
      if (i >= 0) syncMappings[i] = m;
      else syncMappings.push(m);
      setTimeout(() => simulateSync(m.id), 600);
      return m;
    }
    case "sync_delete":
      syncMappings.splice(syncMappings.findIndex((x) => x.id === a.id), 1);
      delete syncStatus[a.id];
      return null;
    case "sync_now":
      simulateSync(a.id);
      return null;
    case "sync_set_paused": {
      const m = syncMappings.find((x) => x.id === a.id);
      if (m) m.paused = a.paused;
      await pushStatus(a.id, { state: a.paused ? "paused" : "idle" });
      return null;
    }
    case "sync_pause_all":
      syncPausedAll = a.paused;
      return null;
    case "update_status":
      return { ...updateState };
    case "update_check":
      await pushUpdate({ checking: true, error: null });
      await new Promise((ok) => setTimeout(ok, 700));
      await pushUpdate({ checking: false, lastChecked: Date.now(), available: updateRelease });
      return { ...updateState };
    case "update_settings":
      if (a.auto != null) updateState.auto = a.auto;
      if (a.skip != null) updateState.skipped = a.skip || null;
      await pushUpdate({});
      return { ...updateState };
    case "update_install": {
      const total = updateRelease.asset.size;
      await pushUpdate({ phase: "downloading", received: 0, total, error: null });
      for (let got = 0; got < total; got += total / 12) {
        await new Promise((ok) => setTimeout(ok, 180));
        await pushUpdate({ received: Math.min(total, Math.round(got)) });
      }
      await pushUpdate({ phase: "installing", received: total });
      await new Promise((ok) => setTimeout(ok, 900));
      await pushUpdate({ phase: "ready" });
      return { ...updateState };
    }
    case "update_restart":
      if (!a.force) throw "busy";
      location.reload();
      return null;
    case "get_app_prefs":
      return prefs;
    case "set_app_prefs":
      if (a.closeToTray != null) prefs.closeToTray = a.closeToTray;
      if (a.launchAtLogin != null) prefs.launchAtLogin = a.launchAtLogin;
      return prefs;
    case "clear_thumbnail_cache":
      return 0;
    case "picked_files":
      return (a.uris as string[]).map((p, i) => ({ path: p, name: p.split("/").pop(), size: 3_000_000 * (i + 1) }));
    case "download_folder":
      return "/storage/emulated/0/Download/Kybl";
    case "plugin:dialog|open":
      return a?.options?.directory
        ? ["/Users/demo/Downloads"]
        : ["/Users/demo/shoot/DSC_0412.jpg", "/Users/demo/shoot/DSC_0413.jpg", "/Users/demo/shoot/DSC_0414.jpg", "/Users/demo/shoot/reel.mov", "/Users/demo/shoot/notes.txt"];
    case "plugin:dialog|save":
      return "/Users/demo/Downloads/file";
    default:
      return null;
  }
}

mockWindows("main");
mockIPC((cmd, args) => handle(cmd, args), { shouldMockEvents: true });

// thumbnails are plain image URLs on the `thumb:` scheme in the app; here they are made up
(window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string, protocol?: string) => string } }).__TAURI_INTERNALS__.convertFileSrc = (
  path: string,
) => thumbFor(path.split("\n").slice(4).join("\n"));


/** A tiny valid 3-page PDF, built by hand, for the PDF preview in browser dev mode. */
function demoPdf(): ArrayBuffer {
  const objs: string[] = [];
  const pages = [1, 2, 3];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((i) => `${3 + (i - 1) * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  for (const i of pages) {
    const pageId = 3 + (i - 1) * 2;
    const text = `BT /F1 28 Tf 60 740 Td (Joint photographs - page ${i}) Tj ET 0.85 0.22 0.12 rg 60 600 200 100 re f 0.2 g 60 560 470 6 re f`;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`;
    objs[pageId + 1] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out).buffer as ArrayBuffer;
}
