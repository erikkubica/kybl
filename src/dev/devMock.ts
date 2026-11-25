/**
 * Browser-only stand-in for the Rust backend, so the UI can be designed with plain `pnpm dev`
 * (no Tauri window). Loaded from main.tsx only in dev and only when Tauri is absent; it is never
 * part of a release build.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { ObjInfo, Profile } from "../core/types";
import type { Capabilities, JobSpec, RootInfo } from "../core/api";
import type { ImportSite } from "../connections/lib/importApi";
import { S3_CAPS } from "../core/useCaps";
import { mockContentSearch, mockDocOpen, mockGitFileCommit, mockGitOverview, mockGitStatus, repoTree } from "../browser/dev/devDevtools";
import { installArchiveMock } from "../archive/devArchive";

const HOUR = 3600_000;
const now = Date.now();

/** connections saved with (true) or without (false) a password; the seeded ones have one */
const mockSecrets = new Map<string, boolean>();
const profiles: Profile[] = [
  { id: "p1", name: "Hetzner · media", provider: "hetzner", endpoint: "https://nbg1.your-objectstorage.com", region: "nbg1", accessKeyId: "DEMOKEY", bucket: "media-prod", pathStyle: false },
  { id: "p2", name: "AWS production", provider: "aws", endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1", accessKeyId: "DEMOKEY", bucket: null, pathStyle: false },
  { id: "p3", name: "Local MinIO", provider: "custom", endpoint: "http://localhost:9000", region: "us-east-1", accessKeyId: "minio", bucket: null, pathStyle: true },
  // A3: a server (one root, no bucket level) and a cloud drive (a few named roots, from the WP-A2 block)
  { id: "n1", name: "Web server", kind: "sftp", provider: "sftp", endpoint: "", region: "", accessKeyId: "", bucket: null, pathStyle: false, group: "Servers", net: { host: "files.example.com", port: 0, user: "deploy", basePath: "/var/www", tls: "none", auth: "password", hostKey: "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8", url: null, tunnels: [{ id: "pg", name: "Postgres", localPort: 5433, remoteHost: "db.internal", remotePort: 5432, autoStart: true }, { id: "admin", name: "Admin panel (flaky)", localPort: 8080, remoteHost: "localhost", remotePort: 80, autoStart: false }, { id: "redis", name: "", localPort: 6380, remoteHost: "10.0.0.7", remotePort: 6379, autoStart: false }] } },
  // an SSH connection: a click opens its terminal, Folders opens its files
  { id: "s1", name: "Shop server", kind: "sftp", provider: "ssh", endpoint: "", region: "", accessKeyId: "", bucket: null, pathStyle: false, group: "Servers", net: { host: "web-01.example.com", port: 0, user: "deploy", basePath: "/var/www/shop", tls: "none", auth: "password", hostKey: "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8", url: null, tunnels: [] } },
  // an FTPS server with its own certificate (see OWN_CERT below): "Trust this certificate…"
  { id: "n2", name: "Office NAS", kind: "ftp", provider: "ftp", endpoint: "", region: "", accessKeyId: "", bucket: null, pathStyle: false, group: "Servers", net: { host: "nas.example.com", port: 0, user: "office", basePath: "", tls: "explicit", auth: "password", hostKey: null, certFingerprint: null, url: null } },
  // Mirror: the live site of the web project in ~/Sites/acme
  { id: "f1", name: "Acme live", kind: "ftp", provider: "ftp", endpoint: "", region: "", accessKeyId: "", bucket: null, pathStyle: false, group: "Servers", net: { host: "ftp.acme.test", port: 0, user: "acme", basePath: "/public_html", tls: "explicit", auth: "password", hostKey: null, certFingerprint: null, url: null } },
  { id: "g1", name: "Google Drive (demo@gmail.com)", kind: "gdrive", provider: "gdrive", endpoint: "", region: "", accessKeyId: "", bucket: null, pathStyle: false, cloud: { accountEmail: "demo@gmail.com", accountId: "1001", clientId: null, tenant: null, scopes: ["drive"] } },
  ...(new URLSearchParams(location.search).has("many") ? manyProfiles() : []),
];
// `?none`: a first run, nothing saved yet (the welcome, and the launcher in other panes)
if (new URLSearchParams(location.search).has("none")) profiles.length = 0;

/**
 * `?many`: about 150 more connections in a few groups, like a big FileZilla import (every name and
 * host is made up), to try the sidebar at scale.
 */
function manyProfiles(): Profile[] {
  const key = "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8";
  const net = (id: string, name: string, kind: "ftp" | "sftp", host: string, group: string | null, over: Partial<Profile["net"] & object> = {}): Profile => ({
    id,
    name,
    kind,
    provider: kind,
    endpoint: "",
    region: "",
    accessKeyId: "",
    bucket: null,
    pathStyle: false,
    group,
    net: { host, port: 0, user: "deploy", basePath: "", tls: kind === "ftp" ? "auto" : "none", auth: "password", hostKey: kind === "sftp" ? key : null, certFingerprint: null, url: null, ...over },
  });
  const clients = ["Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Pied Piper", "Soylent", "Tyrell", "Cyberdyne", "Wonka", "Oscorp", "Vandelay", "Aperture", "Massive Dynamic"];
  const out: Profile[] = [];
  clients.forEach((c, i) => {
    const d = `${c.toLowerCase().replace(/\s+/g, "")}.example`;
    const g = `Clients/${c}`;
    out.push(net(`mc${i}a`, "Live", "sftp", `www.${d}`, g, { basePath: "/var/www/html" }));
    out.push(net(`mc${i}b`, "Staging", "ftp", `staging.${d}`, g));
    if (i % 3 === 0) out.push(net(`mc${i}c`, "Backups", "ftp", `backup.${d}`, g, { tls: "implicit" }));
  });
  // the shared hosting accounts: one group a level down
  const words = ["amber", "birch", "cobalt", "dune", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kestrel", "lumen", "maple", "nimbus", "orchid", "pebble", "quartz", "raven", "sable", "tundra"];
  words.forEach((w, i) => {
    out.push(net(`mh${i}`, `FTP ${w}-shop.test`, "ftp", `ftp.${w}-shop.test`, i < 10 ? "Hosting/Shared EU" : "Hosting/Shared US", { user: `${w}_ftp` }));
  });
  out.push(net("mp1", "Home NAS", "sftp", "nas.home.test", "Personal", { user: "me" }));
  out.push(net("mp2", "Blog", "ftp", "ftp.myblog.test", "Personal", { user: "blog" }));
  // and the wall a first import left behind: no groups, names like "SSH host"
  const tlds = ["cz", "sk", "test", "example"];
  for (let i = 0; i < 83; i++) {
    const w = words[i % words.length];
    const host = `${w}${["", "-web", "-mail", "-dev", "-old"][Math.floor(i / words.length)]}.${tlds[i % tlds.length]}`;
    const ssh = i % 3 === 1;
    out.push(net(`mw${i}`, `${ssh ? "SSH" : "FTP"} ${host}`, ssh ? "sftp" : "ftp", host, null, { user: ssh ? "root" : `${w}${i}` }));
  }
  return out;
}

const FZ_HINT = "FileZilla's “FTP over TLS if available” sites keep that setting: encrypted when the server supports it, plain FTP when it doesn't. Turn the fallback off in a site's settings once you know its server supports FTPS.";

/** A made-up FileZilla site list for "Import connections" (every name and host is fictional). */
function mockImportSites(): ImportSite[] {
  const site = (i: number, over: Partial<ImportSite>): ImportSite => ({
    id: `fz-${i}`,
    name: `Site ${i}`,
    folder: [],
    kind: "ftp",
    protocol: "FTP (TLS if available)",
    host: `ftp${i}.example.com`,
    port: 21,
    user: `user${i}`,
    startDir: "",
    tls: "auto",
    auth: "password",
    notes: [],
    skip: null,
    hasPassword: true,
    needsSecret: false,
    duplicateOf: null,
    ...over,
  });
  const clients = ["Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Pied Piper"];
  const out: ImportSite[] = [
    site(0, { name: "Web server", kind: "sftp", protocol: "SFTP", host: "files.example.com", port: 22, user: "deploy", tls: "none", duplicateOf: "Web server" }),
    site(1, { name: "Public mirror", host: "mirror.example.org", user: "", auth: "anonymous", hasPassword: false, notes: ["Anonymous sign-in"] }),
    site(2, { name: "Old NAS", protocol: "FTP (plain)", tls: "none", host: "192.168.1.20", notes: ["Active mode isn't available: Kybl uses passive mode"] }),
  ];
  let i = 3;
  for (const c of clients) {
    out.push(site(i++, { folder: ["Clients", c], name: "Live", kind: "sftp", protocol: "SFTP", host: `${c.toLowerCase().replace(" ", "")}.example.net`, port: 22, tls: "none", startDir: "/var/www/html" }));
    out.push(site(i++, { folder: ["Clients", c], name: "Staging", host: `staging.${c.toLowerCase().replace(" ", "")}.example.net` }));
    out.push(site(i++, { folder: ["Clients", c], name: "Backups", protocol: "FTPS (implicit TLS)", tls: "implicit", port: 990, host: `backup.${c.toLowerCase().replace(" ", "")}.example.net` }));
  }
  out.push(site(i++, { folder: ["Clients", "Acme"], name: "Deploy key", kind: "sftp", protocol: "SFTP", tls: "none", port: 2222, auth: "keyFile", hasPassword: false, notes: ["Key file acme_deploy.ppk"] }));
  out.push(site(i++, { folder: ["Personal"], name: "Blog", auth: "encrypted", hasPassword: false, needsSecret: true, notes: ["Encrypted with a master password: enter the password after import"] }));
  out.push(site(i++, { folder: ["Personal"], name: "Ask every time", auth: "missing", hasPassword: false, needsSecret: true, notes: ["No password saved: add it after import"] }));
  out.push(site(i++, { folder: ["Personal"], name: "Photos drive", kind: null, protocol: "Google Drive", host: "drive.example", tls: "none", skip: "Not supported from FileZilla: Google Drive. Add it in Kybl and sign in instead" }));
  out.push(site(i++, { folder: ["Personal", "Cloud"], name: "Nextcloud", kind: "webdav", protocol: "WebDAV", host: "cloud.example.com", port: 443, tls: "implicit" }));
  // enough rows to feel a real list (the user's own lists run to a couple of hundred)
  for (let n = 0; n < 150; n++) out.push(site(i++, { folder: ["Archive", `Batch ${Math.floor(n / 25) + 1}`], name: `Old site ${n + 1}` }));
  return out;
}

/** A made-up ~/.ssh/config, as src-tauri/src/import/ssh_config.rs reads it (every host is fictional). */
function mockSshSites(): ImportSite[] {
  const site = (alias: string, over: Partial<ImportSite>): ImportSite => ({
    id: `ssh-${alias}`,
    name: alias,
    folder: ["SSH config"],
    kind: "sftp",
    protocol: "SFTP",
    host: alias,
    port: 0,
    user: "demo",
    startDir: "",
    tls: "none",
    auth: "keyFile",
    notes: ["Key file id_ed25519"],
    skip: null,
    hasPassword: false,
    needsSecret: false,
    duplicateOf: null,
    ...over,
  });
  return [
    site("web", { host: "files.example.com", user: "deploy", duplicateOf: "Web server", notes: ["Key file id_web"] }),
    site("web-alias", { host: "files.example.com", port: 2222, user: "deploy", notes: ["Key file id_web"] }),
    site("db", { host: "10.0.0.5", notes: ["Key file id_ed25519", "Goes through bastion.example.com (ProxyJump), which Kybl doesn't support: it connects directly", "2 SSH tunnels (LocalForward)"] }),
    site("nas", { host: "nas.home.test", user: "admin", auth: "agent", notes: ["Signs in with the SSH agent"] }),
    site("old-box", { host: "old.example.net", notes: ["Key file not found: choose the key after import"], needsSecret: true }),
    site("build", { host: "build.example.org", user: "ci", notes: ["Key file id_build has a passphrase: enter it after import"], needsSecret: true }),
  ];
}

const mockTags: Record<string, Record<string, string>> = {};
const transferPrefs = { concurrency: 3, partConcurrency: 4, downloadLimitKbps: 0, uploadLimitKbps: 0, wifiOnly: false, verify: "size" as "off" | "size" | "checksum" };

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

/** Buckets other than the demo ones start empty and keep what you create in them. */
const otherTrees: Record<string, Record<string, { folders: string[]; objects: ObjInfo[] }>> = {};
const SHARED_TREE: Record<string, { folders: string[]; objects: ObjInfo[] }> = { "": { folders: ["photos/"], objects: [] } };
/** The tree a bucket lists from: the demo tree for media-prod (and every root of the other kinds). */
/** Google Drive, OneDrive and Dropbox connections: their own made-up trees (set further down) */
let cloudTree: ((profileId: string, bucket: string) => Record<string, { folders: string[]; objects: ObjInfo[] }> | undefined) | null = null;
function remoteTree(profileId: string, bucket: string) {
  const cloud = cloudTree?.(profileId, bucket);
  if (cloud) return cloud;
  if (profileId === "f1") return acmeLive;
  if (bucket === "media-prod" || (isOther(profileId) && bucket !== "shared")) return tree;
  if (bucket === "shared") return new Proxy(SHARED_TREE, { get: (t, k: string) => t[k] ?? tree[k] });
  return (otherTrees[`${profileId}\u0000${bucket}`] ??= { "": { folders: [], objects: [] } });
}
function remoteDir(profileId: string, bucket: string, prefix: string) {
  return remoteTree(profileId, bucket)[prefix];
}
// a finished mock copy job (src/jobs/dev/devJobs.ts, files only): the files show up where they went
(window as unknown as { __kyblMockJobDone?: (s: JobSpec) => void }).__kyblMockJobDone = (spec) => {
  if (spec.mirror) return mirrorLanded(spec);
  const src = remoteTree(spec.src.profileId, spec.src.root);
  const dst = remoteTree(spec.dst.profileId, spec.dst.root);
  const into = (dst[spec.dst.dir] ??= { folders: [], objects: [] });
  for (const it of spec.src.items) {
    const parent = it.path.replace(/[^/]+$/, "");
    const from = src[parent];
    const o = from?.objects.find((x) => x.key === it.path);
    if (!o) continue;
    const key = spec.dst.dir + it.path.slice(parent.length);
    into.objects = into.objects.filter((x) => x.key !== key).concat({ ...o, key, modified: Date.now() });
    if (spec.mode === "move" && from && from !== into) from.objects = from.objects.filter((x) => x !== o);
  }
};

type MockTree = Record<string, { folders: string[]; objects: ObjInfo[] }>;
const mockTree = (profileId: string, root: string): MockTree => (profileId === LOCAL ? (localTree[root] ??= { "": { folders: [], objects: [] } }) : remoteTree(profileId, root));
const parentKey = (key: string) => key.replace(/[^/]+\/?$/, "");
function mockDir(t: MockTree, dir: string): MockTree[string] {
  if (dir && !t[dir]) {
    const up = mockDir(t, parentKey(dir));
    if (!up.folders.includes(dir)) up.folders.push(dir);
  }
  return (t[dir] ??= { folders: [], objects: [] });
}
/** A finished mock mirror job: its copies land (times kept on this device, upload time on servers) and its deletions go. */
function mirrorLanded(spec: JobSpec) {
  const src = mockTree(spec.src.profileId, spec.src.root);
  const dst = mockTree(spec.dst.profileId, spec.dst.root);
  const from = spec.src.items[0]?.path ?? "";
  const to = spec.dst.dir;
  for (const c of spec.mirror?.copy ?? []) {
    if (c.rel.endsWith("/")) {
      mockDir(dst, to + c.rel);
      continue;
    }
    const o = src[parentKey(from + c.rel)]?.objects.find((x) => x.key === from + c.rel);
    if (!o) continue;
    const node = mockDir(dst, parentKey(to + c.rel));
    const key = to + c.rel;
    node.objects = node.objects.filter((x) => x.key !== key).concat({ ...o, key, modified: spec.dst.profileId === LOCAL ? o.modified : Date.now(), etag: null });
  }
  for (const rel of spec.mirror?.delete ?? []) {
    const key = to + rel;
    const node = dst[parentKey(key)];
    if (!node) continue;
    if (rel.endsWith("/")) {
      const inside = dst[key];
      if (inside && (inside.folders.length || inside.objects.length)) continue;
      node.folders = node.folders.filter((f) => f !== key);
      delete dst[key];
    } else node.objects = node.objects.filter((x) => x.key !== key);
  }
}
/** what a mock mirror job copies, in bytes */
(window as unknown as { __kyblMockMirrorBytes?: (s: JobSpec) => number }).__kyblMockMirrorBytes = (spec) => (spec.mirror?.copy ?? []).reduce((n, c) => n + (c.size ?? 0), 0);

// the real size of the files a mock copy job takes (src/jobs/dev/devJobs.ts), so it reports what was picked
(window as unknown as { __kyblMockBytes?: (s: JobSpec) => number }).__kyblMockBytes = (spec) => {
  const src = remoteTree(spec.src.profileId, spec.src.root);
  return spec.src.items.reduce((n, it) => n + (src[it.path.replace(/[^/]+$/, "")]?.objects.find((x) => x.key === it.path)?.size ?? 0), 0);
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

/** Real ThumbHashes of gradients in the demo thumbnails' colours (by the same hue pick as thumbFor). */
const MOCK_HASHES = [
  "G+UJHYSKeIiPiIh0d6eId4dwDQd3",
  "m5YKJQR6eI+ISHeniHd4l3JwGLcH",
  "ntYJDYp5eIiPh4h0eKd4d36FDwh3",
  "HdkJHQiJeI+HSIeniHd3l42P99eo",
  "XScKFYp5eIiPh4dzeKd4d3+M+/eI",
  "nmUNFQaKiI+HSHeniHd4l3mAXge3",
  "3UoOHYJ6eHiPh4h0d6iId4mPE7cH",
  "X3gKJQh6eI+HSIeniHd4l4ByxvhY",
];
const mockThumbhash = (key: string) => MOCK_HASHES[Math.abs(hash(key)) % MOCK_HASHES.length];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cancelled = new Set<string>();

/** transfers asked to pause, the bytes each paused one kept (to carry on from), and the running ones */
const pausing = new Set<string>();
const keptAt = new Map<string, { bytes: number; total: number }>();
const runningIds = new Set<string>();

async function simulateTransfer(id: string, total: number, fail = false): Promise<boolean> {
  const kept = keptAt.get(id);
  if (kept) total = kept.total;
  keptAt.delete(id);
  runningIds.add(id);
  cancelled.delete(id);
  try {
    await sleep(200 + Math.random() * 600);
    const steps = 14 + Math.floor(Math.random() * 30);
    const from = kept ? Math.floor((kept.bytes / total) * steps) : 0;
    const resumedFrom = kept ? kept.bytes : undefined;
    for (let i = from + 1; i <= steps; i++) {
      if (pausing.delete(id)) {
        const bytes = Math.round((total * (i - 1)) / steps);
        keptAt.set(id, { bytes, total });
        await emit("transfer", { id, state: "paused", bytes, total, error: null, resumedFrom });
        return false;
      }
      if (cancelled.has(id)) {
        await emit("transfer", { id, state: "cancelled", bytes: 0, total, error: null });
        return false;
      }
      if (fail && !kept && i > steps / 2) {
        await emit("transfer", { id, state: "error", bytes: 0, total, error: "AccessDenied: the key does not allow s3:PutObject" });
        return false;
      }
      await emit("transfer", { id, state: "running", bytes: Math.round((total * i) / steps), total, error: null });
      await sleep(260);
    }
    const verified = transferPrefs.verify === "off" ? undefined : transferPrefs.verify === "checksum" ? "md5" : "size";
    await emit("transfer", { id, state: "done", bytes: total, total, error: null, resumedFrom, verified });
    return true;
  } finally {
    runningIds.delete(id);
  }
}

let uploadCount = 0;
/** sizes of the files "picked" from disk, so an upload reports its own size */
const localSizes = new Map<string, number>();

// ---- folder sync
type MockMapping = { id: string; profileId: string; bucket: string; prefix: string; localPath: string; direction: "upload" | "download" | "twoway"; ignore: string[]; mirrorDeletes: boolean; intervalMins: number; paused: boolean; remoteTrash?: boolean | null; deleteGuard?: boolean };
const syncMappings: MockMapping[] = [
  { id: "s1", profileId: "p1", bucket: "media-prod", prefix: "photos/", localPath: "/Users/demo/Pictures/Exports", direction: "upload", ignore: [".DS_Store", "*.tmp"], mirrorDeletes: false, intervalMins: 5, paused: false },
  { id: "s2", profileId: "p1", bucket: "static-assets", prefix: "", localPath: "/Users/demo/Sites/assets", direction: "download", ignore: [".DS_Store"], mirrorDeletes: true, intervalMins: 15, paused: false },
  // WP-E1: two-way over a single-root connection (no bucket), with conflicts and held deletions
  { id: "s3", profileId: "n1", bucket: "", prefix: "site/", localPath: "/Users/demo/Kybl/Web server/site", direction: "twoway", ignore: [".DS_Store"], mirrorDeletes: true, intervalMins: 5, paused: false, remoteTrash: null, deleteGuard: true },
];
const syncConflicts: Record<string, { path: string; copy: string; createdAt: number; localPath: string; copyLocalPath: string }[]> = {
  s3: [
    { path: "index.html", copy: "index (conflict Demo Mac 2026-11-22).html", createdAt: now - 20 * 60_000, localPath: "/Users/demo/Kybl/Web server/site/index.html", copyLocalPath: "/Users/demo/Kybl/Web server/site/index (conflict Demo Mac 2026-11-22).html" },
    { path: "css/main.css", copy: "css/main (conflict Demo Mac 2026-11-22).css", createdAt: now - 2 * HOUR, localPath: "/Users/demo/Kybl/Web server/site/css/main.css", copyLocalPath: "/Users/demo/Kybl/Web server/site/css/main (conflict Demo Mac 2026-11-22).css" },
  ],
};
const syncPending: Record<string, { path: string; side: "local" | "remote"; size: number }[]> = {
  s3: Array.from({ length: 64 }, (_, i) => ({ path: `img/gallery/photo-${String(i + 1).padStart(3, "0")}.jpg`, side: i < 60 ? ("remote" as const) : ("local" as const), size: 240_000 + i * 1000 })),
};
const syncStatus: Record<string, Record<string, unknown>> = {
  s1: { id: "s1", state: "idle", lastSync: now - 4 * 60_000, error: null, current: null, done: 0, total: 0, files: 1284, summary: "3 uploaded" },
  s2: { id: "s2", state: "error", lastSync: now - 3 * HOUR, error: "This key can't list the files in static-assets.\n\nAccessDenied: Access Denied (request 7F3A9C)", current: null, done: 0, total: 0, files: 312, summary: null },
  s3: { id: "s3", state: "error", lastSync: now - 20 * 60_000, error: "64 files would be deleted at once, so Kybl is waiting for you to confirm the deletions.", current: null, done: 0, total: 0, files: 418, summary: "2 uploaded · 5 downloaded · 2 conflicts kept as copies", conflicts: 2, pendingDeletes: 64 },
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

/** A fake app for "Open with ▸": a coloured tile with its initial stands in for the icon. */
function mockApp(name: string, isDefault: boolean) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="hsl(${h} 60% 50%)"/><text x="16" y="21.5" font-family="-apple-system,sans-serif" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${name[0]}</text></svg>`;
  return { name, path: `/Applications/${name}.app`, isDefault, icon: `data:image/svg+xml,${encodeURIComponent(svg)}` };
}

// ---- WP0: this computer ("local") and per-connection capabilities
const LOCAL = "local";
const HOME = "/Users/demo";
const localRoots: RootInfo[] = [
  { id: HOME, name: "Home", kind: "home", created: null, readOnly: false },
  { id: `${HOME}/Desktop`, name: "Desktop", kind: "desktop", created: null, readOnly: false },
  { id: `${HOME}/Documents`, name: "Documents", kind: "documents", created: null, readOnly: false },
  { id: `${HOME}/Downloads`, name: "Downloads", kind: "downloads", created: null, readOnly: false },
  { id: "/", name: "Macintosh HD", kind: "volume", created: null, readOnly: false },
];
const localObj = (key: string, size: number, ageHours: number): ObjInfo => ({ ...obj(key, size, ageHours), etag: `${size.toString(16)}-local`, storageClass: null });
/** ~/Sites/acme: a small web project, with .git, node_modules and a .gitignore to leave out. */
function acmeProject(): Record<string, { folders: string[]; objects: ObjInfo[] }> {
  const b = "Sites/acme/";
  const o = (rel: string, size: number, age: number) => localObj(b + rel, size, age);
  return {
    "Sites/": { folders: [b], objects: [] },
    [b]: {
      folders: [`${b}.git/`, `${b}node_modules/`, `${b}css/`, `${b}js/`, `${b}img/`, `${b}dist/`],
      objects: [o(".gitignore", 38, 400), o(".DS_Store", 6_148, 1), o(".env", 220, 300), o("index.html", 4_210, 1), o("about.html", 2_980, 0.5), o("contact.html", 1_900, 300), o("README.md", 2_000, 50), o("debug.log", 18_000, 0.1)],
    },
    [`${b}.git/`]: { folders: [`${b}.git/objects/`], objects: [o(".git/HEAD", 23, 1), o(".git/config", 310, 400)] },
    [`${b}.git/objects/`]: { folders: [], objects: [o(".git/objects/pack-1.pack", 1_400_000, 2), o(".git/objects/pack-1.idx", 40_000, 2)] },
    [`${b}node_modules/`]: { folders: [`${b}node_modules/react/`], objects: [] },
    [`${b}node_modules/react/`]: { folders: [], objects: [o("node_modules/react/index.js", 190, 600), o("node_modules/react/package.json", 1_200, 600)] },
    [`${b}css/`]: { folders: [], objects: [o("css/site.css", 18_400, 2), o("css/reset.css", 1_200, 900)] },
    [`${b}js/`]: { folders: [], objects: [o("js/app.js", 42_000, 0.2), o("js/vendor.js", 88_000, 900)] },
    [`${b}img/`]: { folders: [`${b}img/team/`], objects: [o("img/logo.svg", 3_100, 900), o("img/hero.jpg", 240_000, 3)] },
    [`${b}img/team/`]: { folders: [], objects: [o("img/team/alice.jpg", 120_000, 5), o("img/team/bob.jpg", 118_000, 5)] },
    [`${b}dist/`]: { folders: [], objects: [o("dist/bundle.js", 310_000, 0.2)] },
  };
}
const ACME_GITIGNORE = "# build output\ndist/\n*.log\n.env.local\n";

/** "Acme live": the FTP site the project deploys to (minute-precision times, as FTP lists them). */
const acmeLive: Record<string, { folders: string[]; objects: ObjInfo[] }> = (() => {
  const o = (key: string, size: number, age: number): ObjInfo => ({ key, size, modified: Math.floor((now - age * HOUR) / 60_000) * 60_000, etag: null, storageClass: null });
  return {
    "": {
      folders: ["css/", "js/", "img/", "uploads/", "legacy/"],
      objects: [o(".htaccess", 640, 4000), o(".env", 310, 4000), o("index.html", 4_210, 0.9), o("about.html", 2_870, 30), o("contact.html", 1_900, 200), o("old-page.html", 5_400, 3000)],
    },
    "css/": { folders: [], objects: [o("css/site.css", 18_400, 48), o("css/reset.css", 1_200, 800)] },
    "js/": { folders: [], objects: [o("js/app.js", 40_500, 30), o("js/vendor.js", 88_000, 800)] },
    "img/": { folders: [], objects: [o("img/logo.svg", 3_100, 800), o("img/old-banner.jpg", 310_000, 2000)] },
    "uploads/": { folders: ["uploads/2025/"], objects: [] },
    "uploads/2025/": { folders: [], objects: [o("uploads/2025/photo-1.jpg", 1_200_000, 900), o("uploads/2025/photo-2.jpg", 980_000, 880)] },
    "legacy/": { folders: [], objects: [] },
  };
})();

/** root id -> prefix -> listing */
const localTree: Record<string, Record<string, { folders: string[]; objects: ObjInfo[] }>> = {
  [HOME]: {
    // dotfiles: panes hide them unless "Show hidden files" is on
    "": { folders: [".config/", "Desktop/", "Documents/", "Downloads/", "Movies/", "Music/", "Pictures/", "Projects/", "Sites/"], objects: [localObj(".DS_Store", 6_148, 2), localObj(".zshrc", 900, 400), localObj("notes.txt", 1_200, 3)] },
    // a git work tree with a change of every kind (src/browser/dev/devDevtools.ts)
    ...repoTree(localObj),
    // Mirror: a web project to deploy to "Acme live" (FTP, below), with a few differences
    ...acmeProject(),
    "Pictures/": { folders: [], objects: [localObj("Pictures/beach.jpg", 3_400_000, 30), localObj("Pictures/hanoi.jpg", 2_800_000, 50)] },
    "Movies/": { folders: [], objects: [localObj("Movies/holiday.mp4", 84_000_000, 40)] },
    "Music/": { folders: [], objects: [localObj("Music/tone.wav", 88_244, 60)] },
  },
  [`${HOME}/Desktop`]: { "": { folders: ["Screenshots/"], objects: [localObj("todo.md", 640, 1), localObj("invoice-0042.pdf", 184_000, 26)] }, "Screenshots/": { folders: [], objects: [localObj("Screenshots/shot-1.png", 900_000, 2)] } },
  [`${HOME}/Documents`]: { "": { folders: ["Contracts/"], objects: [localObj("budget-2026.xlsx", 48_000, 70)] }, "Contracts/": { folders: [], objects: [localObj("Contracts/lease.pdf", 320_000, 900)] } },
  [`${HOME}/Downloads`]: { "": { folders: [], objects: [localObj("Kybl_0.3.2_aarch64.dmg", 9_800_000, 5), localObj("photo (1).jpg", 2_100_000, 8)] } },
  "/": { "": { folders: ["Applications/", "Users/"], objects: [] } },
};
const localCaps: Capabilities = {
  ...S3_CAPS,
  roots: "drives",
  createRoot: false,
  folders: "real",
  rename: "native",
  share: "none",
  shareExpiry: false,
  streaming: "proxy",
  metadata: "none",
  tags: false,
  storageClass: false,
  trash: true,
  multipart: false,
  maxObjectSize: null,
  backgroundUpload: false,
  localPaths: true,
};
function s3Caps(p: Profile | undefined): Capabilities {
  const provider = p?.provider ?? "custom";
  return {
    ...S3_CAPS,
    createRoot: provider === "kybl",
    conditionalWrite: ["aws", "r2", "minio"].includes(provider) ? "if-match" : "compare",
    hashes: provider === "kybl" ? [] : ["md5"],
  };
}

// ---- A3: servers and blob storage (cloud drives: the WP-A2 block at the end)
const kindOf = (id: string) => profiles.find((x) => x.id === id)?.kind ?? "s3";
const isOther = (id: string) => id !== LOCAL && kindOf(id) !== "s3";
/** One server folder per connection, named after the host (or container), like the backends do. */
function otherRoots(p: Profile): RootInfo[] {
  const r = (id: string, name: string, kind: RootInfo["kind"], readOnly = false): RootInfo => ({ id, name, kind, created: null, readOnly });
  switch (p.kind) {
    case "azblob":
    case "gcs":
      return [r("", p.blob?.container || "container", "bucket")];
    default:
      return [r("", `${p.net?.host || p.name}${p.net?.basePath ? ` ${p.net.basePath}` : ""}`, "folder")];
  }
}
function otherCaps(p: Profile): Capabilities {
  const k = p.kind;
  const server = k === "sftp" || k === "ftp" || k === "webdav";
  const drive = k === "gdrive" || k === "onedrive" || k === "dropbox";
  return {
    ...S3_CAPS,
    roots: k === "gdrive" || k === "onedrive" ? "drives" : "single",
    createRoot: false,
    folders: server || drive ? "real" : "prefix",
    rename: server || drive ? "native" : "copy-delete",
    serverCopy: k === "webdav" || drive || k === "azblob" || k === "gcs" ? "same-root" : "none",
    share: drive ? "link" : "none",
    shareExpiry: false,
    streaming: "proxy",
    conditionalWrite: k === "azblob" ? "if-match" : "compare",
    hashes: k === "dropbox" ? ["dropbox"] : k === "onedrive" ? ["quickxor"] : k === "azblob" || k === "gcs" || k === "gdrive" ? ["md5"] : [],
    thumbnails: drive ? "local+remote" : "local",
    metadata: "none",
    tags: false,
    storageClass: false,
    trash: drive,
    multipart: false,
    maxObjectSize: null,
    backgroundUpload: false,
    // src/perms: SFTP keeps Unix permissions and links; FTP permissions (SITE CHMOD)
    permissions: k === "sftp" || k === "ftp",
    links: k === "sftp",
  };
}

// ---- servers: Unix permissions and symbolic links (src-tauri/src/storage/perms.rs)
const serverKind = (id: string) => (kindOf(id) === "sftp" || kindOf(id) === "ftp" ? kindOf(id) : null);
const mockModes = new Map<string, number>();
function modeOf(pid: string, key: string): number {
  const m = mockModes.get(`${pid}\u0000${key}`);
  if (m !== undefined) return m;
  if (key.endsWith("/")) return key === "exports/" ? 0o775 : 0o755;
  if (/\.(sh|py)$/.test(key)) return 0o755;
  return /^backup-/.test(key) ? 0o600 : 0o644;
}
/** a link on the demo SFTP server: where it is, what it says, and the key it leads to (null: outside the connection's folder) */
type MockLink = { key: string; target: string; to: string | null };
const mockLinks: Record<string, MockLink[]> = {};
const linksOf = (pid: string): MockLink[] =>
  (mockLinks[pid] ??=
    kindOf(pid) === "sftp"
      ? [
          { key: "current/", target: "documents", to: "documents/" },
          { key: "notes-link.txt", target: "documents/notes.txt", to: "documents/notes.txt" },
          { key: "shared-logs/", target: "/var/log/shared", to: null },
          { key: "documents/latest.pdf", target: "contract.pdf", to: "documents/contract.pdf" },
          { key: "broken-link", target: "gone.txt", to: "gone.txt" },
          { key: "photos/latest.jpg", target: "2026/cover.jpg", to: "photos/2026/cover.jpg" },
        ]
      : []);
/** A key under a folder link, as the key it really is ("current/x" → "documents/x"). */
function realKey(pid: string, key: string): string {
  for (const l of linksOf(pid)) {
    if (l.to === null) continue;
    if (key === l.key) return l.to;
    if (l.key.endsWith("/") && key.startsWith(l.key)) return l.to + key.slice(l.key.length);
  }
  return key;
}
/** A server listing: modes, owner and group on everything, links where they are, and the inside of folder links. */
function serverListing(pid: string, bucket: string, prefix: string, token: string | null) {
  const real = realKey(pid, prefix);
  const outside = linksOf(pid).some((l) => l.key === prefix && l.to === null);
  const dir = outside ? undefined : remoteDir(pid, bucket, real);
  const move = (k: string) => (real === prefix ? k : prefix + k.slice(real.length));
  const start = Number(token ?? 0);
  const all = dir?.objects ?? [];
  const meta = (key: string) => ({ mode: modeOf(pid, realKey(pid, key)), owner: "deploy", group: "www-data" });
  const folders = start === 0 ? (dir?.folders ?? []).map(move) : [];
  const objects: ObjInfo[] = all.slice(start, start + 1000).map((o) => ({ ...o, key: move(o.key), ...meta(move(o.key)) }));
  const folderInfo: ObjInfo[] = folders.map((f) => ({ key: f, size: 0, modified: null, etag: null, storageClass: null, ...meta(f) }));
  if (start === 0) {
    for (const l of linksOf(pid).filter((l) => l.key.slice(0, l.key.replace(/\/$/, "").lastIndexOf("/") + 1) === prefix)) {
      if (l.key.endsWith("/")) {
        folders.push(l.key);
        folderInfo.push({ key: l.key, size: 0, modified: now - 30 * HOUR, etag: null, storageClass: null, ...meta(l.key), link: l.target });
      } else {
        const to = l.to && Object.values(tree).flatMap((d) => d.objects).find((x) => x.key === l.to);
        objects.push({ ...(to || obj(l.key, 0, 300)), key: l.key, ...(to ? meta(l.key) : {}), link: l.target });
      }
    }
  }
  return {
    folders,
    objects,
    nextToken: start + 1000 < all.length ? String(start + 1000) : null,
    folderInfo,
  };
}
/** Starts a trust error's detail, as the backend's per-run tag does (src-tauri/src/storage/mod.rs). */
const TRUST_TAG = "kybl:0123456789abcdef0123456789abcdef";
const HOST_KEY_UNKNOWN = `Kybl hasn't connected to this server before. Check that the server's fingerprint matches, then trust it to connect.\n\n${TRUST_TAG} host-key-unknown SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8`;
/**
 * A server with its own certificate: FTP and WebDAV hosts named "nas.…" (like Office NAS) answer
 * with it until it's trusted; hosts with "changed" in the name present another one than the
 * trusted one. Wording as src-tauri/src/storage/certtrust.rs.
 */
const OWN_CERT = { fp: "94:55:1B:95:48:5F:AF:F2:72:2A:C5:BA:1C:1C:6E:2E:CA:AD:A1:C4:BC:20:2E:10:23:52:03:58:07:3B:46:FD", name: "nas.local", issuer: "nas.local", from: "2026-11-23", until: "2036-11-20" };
function ownCertCheck(host: string, pin: string | null | undefined) {
  const norm = (s: string) => s.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (pin && norm(pin) === norm(OWN_CERT.fp)) return;
  const name = host.replace(/^\w+:\/\//, "").split(/[/:]/)[0];
  const detail = (first: string) =>
    `${TRUST_TAG} ${first}\nreason: self-signed, wrong-name\nhost: ${name}\nname: ${OWN_CERT.name}\nissuer: ${OWN_CERT.issuer}\nvalid-from: ${OWN_CERT.from}\nvalid-until: ${OWN_CERT.until}\ntls: invalid peer certificate: certificate refused`;
  if (!pin)
    throw `The server's security certificate isn't trusted. The server signed it itself. It's made out to ${OWN_CERT.name}, not ${name}. If you know this server, check its certificate and trust it to connect.\n\n${detail(`cert-untrusted ${OWN_CERT.fp}`)}`;
  throw `The server's certificate changed since you trusted it. Someone may be intercepting the connection, so Kybl didn't connect. If you know it was renewed or replaced, check the new one and trust it.\n\n${detail(`cert-changed ${OWN_CERT.fp} expected ${pin}`)}`;
}

/** What connecting to a non-S3 connection says: host keys, certificates, unknown hosts, wrong passwords. */
function otherConnect(p: Profile, secret: string | null) {
  const n = p.net;
  if ((p.kind === "ftp" || p.kind === "webdav") && n && /(^|\/\/)nas\./.test(n.host || n.url || "")) ownCertCheck(n.host || n.url || "", n.certFingerprint);
  if (p.kind === "sftp" && n) {
    // a host with "changed" in its name pretends to have been reinstalled since it was trusted
    if (/changed/.test(n.host) && n.hostKey && n.hostKey !== "SHA256:Zm9yZ2VkLWtleS1mb3ItdGhlLWNoYW5nZWQtc2VydmVy")
      throw `The server's identity changed. Someone may be intercepting the connection, so Kybl didn't connect. If the server was reinstalled or its key replaced, remove the saved fingerprint in the connection's settings and connect again.\n\n${TRUST_TAG} host-key-changed SHA256:Zm9yZ2VkLWtleS1mb3ItdGhlLWNoYW5nZWQtc2VydmVy expected ${n.hostKey}`;
    // (so trusting it there leads straight to the "identity changed" warning)
    if (!n.hostKey) throw HOST_KEY_UNKNOWN;
  }
  const host = n?.host || n?.url || "";
  if (/(^|\/\/)bad\b/.test(host)) throw `Couldn't find ${host.replace(/^\w+:\/\//, "")}. Check the address.\n\ndns error: failed to lookup address information: nodename nor servname provided`;
  if (secret === "wrong") throw "Wrong user name or password.\n\n530 Login incorrect.";
}

/** The local connection's commands; undefined for anything it doesn't answer specially. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleLocal(cmd: string, a: any): Promise<unknown> {
  const dirs = localTree[a.bucket] ?? {};
  switch (cmd) {
    case "list_buckets":
      return localRoots.map((r) => ({ name: r.id, created: null }));
    case "list_objects": {
      await sleep(80);
      if (a.bucket && !localTree[a.bucket]) throw "This folder or disk isn't available any more.";
      const d = dirs[a.prefix] ?? { folders: [], objects: [] };
      return { folders: d.folders, objects: d.objects, nextToken: null };
    }
    case "head_object": {
      const o = Object.values(dirs).flatMap((d) => d.objects).find((x) => x.key === a.key);
      if (!o) throw "This file or folder isn't there any more. It may have been moved or deleted.";
      return { key: a.key, size: o.size, contentType: null, modified: o.modified, etag: o.etag, storageClass: null, metadata: {} };
    }
    case "presign_get":
    case "update_object_props":
    case "get_object_tags":
    case "put_object_tags":
      throw "This connection doesn't support that.";
    case "get_text_preview": {
      const o = Object.values(dirs).flatMap((d) => d.objects).find((x) => x.key === a.key);
      if (!o) throw "This file or folder isn't there any more. It may have been moved or deleted.";
      return a.key.endsWith(".gitignore") ? { text: ACME_GITIGNORE, truncated: false } : undefined;
    }
    case "mirror_md5":
      // a made-up MD5 that stays the same for the same file
      return Math.abs(hash(`${a.key}`)).toString(16).padStart(8, "0").repeat(4);
    case "folder_size": {
      const keys = Object.entries(dirs).filter(([k]) => k.startsWith(a.prefix)).flatMap(([, n]) => n.objects);
      return { bytes: keys.reduce((s, o) => s + o.size, 0), objects: keys.length, children: [] };
    }
    case "create_folder":
      (dirs[""] ??= { folders: [], objects: [] }).folders.push(a.prefix.endsWith("/") ? a.prefix : `${a.prefix}/`);
      return null;
    case "git_status":
      await sleep(60);
      return mockGitStatus(HOME, a.bucket, a.prefix);
    case "git_overview":
      await sleep(60);
      return mockGitStatus(HOME, a.bucket, a.prefix) ? mockGitOverview() : null;
    case "git_file_commit":
      await sleep(40);
      return mockGitStatus(HOME, a.bucket, a.prefix) ? mockGitFileCommit(a.file) : null;
    case "content_search": {
      const files = Object.entries(dirs).filter(([k]) => k.startsWith(a.prefix)).flatMap(([, d]) => d.objects);
      return mockContentSearch(a, files, "ripgrep", () => cancelled.has(a.opId));
    }
    default:
      return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handle(cmd: string, a: any): Promise<unknown> {
  // WP-B1: copies between connections (src/jobs/dev/devJobs.ts)
  if (cmd.startsWith("job_")) return (await import("../jobs/dev/devJobs")).handleJob(cmd, a);
  // WP-C: phone backup (src/mobile/backup/devBackup.ts)
  if (cmd.startsWith("backup_")) return (await import("../mobile/backup/devBackup")).handleBackup(cmd, a);
  // custom actions (src/actions/dev/devActions.ts); Activity's Stop on one reaches it as cancel_transfer
  if (cmd.startsWith("custom_action_") || cmd === "cancel_transfer") {
    const r = await (await import("../actions/dev/devActions")).handleAction(cmd, a);
    if (cmd !== "cancel_transfer") return r;
  }
  // terminal panes: a fake shell (src/terminal/dev/devTerminal.ts)
  if (cmd.startsWith("terminal_")) return (await import("../terminal/dev/devTerminal")).handleTerminal(cmd, a, profiles);
  // SSH tunnels (src/tunnels/devTunnels.ts); opening a connection starts its auto-start ones
  if (cmd.startsWith("tunnel_")) return (await import("../tunnels/devTunnels")).handleTunnel(cmd, a, profiles);
  if (cmd === "list_roots") void import("../tunnels/devTunnels").then((m) => m.autostart(a.profileId, profiles));
  if (a?.profileId === LOCAL) {
    const r = await handleLocal(cmd, a);
    if (r !== undefined) return r;
  }
  switch (cmd) {
    case "list_roots": {
      await sleep(120);
      if (a.profileId === LOCAL) return localRoots;
      const p = profiles.find((x) => x.id === a.profileId);
      if (!p) throw "Connection not found";
      if (p.kind && p.kind !== "s3") {
        otherConnect(p, null);
        return otherRoots(p);
      }
      if (a.profileId === "p3" && !p.bucket) throw "Access denied. This key isn't allowed to do that.";
      const names = p.bucket && !buckets.includes(p.bucket) ? [p.bucket, ...buckets] : buckets;
      return names.map((name) => ({ id: name, name, kind: "bucket", created: now - 400 * HOUR, readOnly: false }) satisfies RootInfo);
    }
    case "connection_capabilities":
      await sleep(40);
      if (a.profileId === LOCAL) return localCaps;
      if (!profiles.some((x) => x.id === a.profileId)) throw "Connection not found";
      if (isOther(a.profileId)) return otherCaps(profiles.find((x) => x.id === a.profileId)!);
      return s3Caps(profiles.find((x) => x.id === a.profileId));
    case "local_path":
      return a.profileId === LOCAL ? `${a.bucket.replace(/\/$/, "")}/${a.key}` : null;
    // git marks: this computer only (handleLocal)
    case "git_status":
    case "git_overview":
    case "git_file_commit":
      return null;
    // searching inside files: this computer (handleLocal) and SFTP servers
    case "content_search": {
      if (kindOf(a.profileId) !== "sftp") return { hits: [], files: 0, matches: 0, truncated: false, engine: "", unavailable: "Searching inside files works on this computer and on SFTP servers." };
      await sleep(400);
      const files = Object.entries(remoteTree(a.profileId, a.bucket)).filter(([k]) => k.startsWith(a.prefix)).flatMap(([, d]) => d.objects);
      return mockContentSearch(a, files, "grep", () => cancelled.has(a.opId));
    }
    // WP-A4: media of connections without share links plays through the app's media: scheme
    case "media_base":
      return { scheme: "media", base: "" };
    case "list_profiles":
      return profiles;
    case "profile_has_secret":
      return mockSecrets.get(a.id) ?? true;
    case "save_profile": {
      const p = { ...a.profile, id: a.profile.id || `p${Date.now()}` };
      if (a.secret) mockSecrets.set(p.id, true);
      else if (a.clearSecret || !a.profile.id) mockSecrets.set(p.id, false);
      const i = profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) profiles[i] = p;
      else profiles.push(p);
      return p;
    }
    case "set_profile_groups":
      for (const p of profiles) {
        if (!(p.id in a.groups)) continue;
        const g = String(a.groups[p.id] ?? "")
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean)
          .join("/");
        p.group = g || null;
      }
      return profiles.map((p) => ({ ...p }));
    case "storage_quota":
      return { used: 6.4e9, total: 15e9 };
    case "set_profile_pins":
      for (const p of profiles) if (p.id in a.pins) p.pinned = !!a.pins[p.id] || undefined;
      return profiles.map((p) => ({ ...p }));
    case "delete_profile":
      profiles.splice(profiles.findIndex((x) => x.id === a.id), 1);
      return null;
    // "Import connections": a made-up FileZilla list, big enough to try search and folders
    case "import_sources":
      await sleep(80);
      return [
        { id: "filezilla", name: "FileZilla", detected: true, path: "/Users/demo/.config/filezilla/sitemanager.xml", filterName: "FileZilla site list", extensions: ["xml"] },
        { id: "ssh-config", name: "SSH config", detected: true, path: "/home/demo/.ssh/config", filterName: "SSH config", extensions: [] },
      ];
    case "import_preview":
      await sleep(250);
      if (a.source === "ssh-config")
        return { source: a.source, path: a.path ?? "/home/demo/.ssh/config", sites: mockSshSites(), hints: ["Match blocks aren't read: settings that only apply through Match don't carry over."] };
      return { source: a.source, path: a.path ?? "/Users/demo/.config/filezilla/sitemanager.xml", sites: mockImportSites(), hints: [FZ_HINT] };
    case "import_apply": {
      await sleep(600);
      const sites = a.source === "ssh-config" ? mockSshSites() : mockImportSites();
      const out = { imported: [] as Profile[], skipped: [] as { name: string; reason: string }[], needsSecret: [] as string[] };
      for (const id of a.ids as string[]) {
        const s = sites.find((x) => x.id === id);
        if (!s) continue;
        if (s.skip || !s.kind) {
          out.skipped.push({ name: s.name, reason: s.skip ?? "Not supported" });
          continue;
        }
        // the folders become the group (src-tauri/src/import/mod.rs); a name repeats only across groups
        const group = s.folder.map((f) => f.trim()).filter(Boolean).join("/") || null;
        let name = s.name;
        for (let n = 2; profiles.some((x) => (x.group ?? null) === group && x.name.toLowerCase() === name.toLowerCase()); n++) name = `${s.name} (${n})`;
        const p: Profile = {
          id: `imp${Date.now()}${out.imported.length}`,
          name,
          group,
          kind: s.kind,
          provider: s.kind,
          endpoint: "",
          region: "",
          accessKeyId: "",
          bucket: null,
          pathStyle: false,
          net: { host: s.host, port: s.port, user: s.user, basePath: s.startDir, tls: s.tls, auth: s.auth === "keyFile" ? "key" : "password", hostKey: null, url: null },
        };
        profiles.push(p);
        out.imported.push(p);
        if (s.needsSecret) out.needsSecret.push(name);
      }
      return out;
    }
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
      if (a.profile.kind && a.profile.kind !== "s3") {
        otherConnect(a.profile, a.secret);
        return "Connected.";
      }
      if (!a.profile.endpoint) throw "Endpoint is required";
      return "Connected. 4 buckets visible.";
    case "trust_tag":
      return TRUST_TAG;
    case "ftp_allow_plain":
      return null;
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
      if (isOther(a.profileId)) otherConnect(profiles.find((x) => x.id === a.profileId)!, null);
      if (serverKind(a.profileId)) return serverListing(a.profileId, a.bucket, a.prefix, a.token ?? null);
      // every root of the other kinds shows the demo tree (Shared with me: just the photos)
      const dir = remoteDir(a.profileId, a.bucket, a.prefix);
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
      const real = serverKind(a.profileId) ? realKey(a.profileId, a.key) : a.key;
      const o = Object.values(tree).flatMap((d) => d.objects).find((x) => x.key === real);
      if (!o) throw "NotFound";
      const ext = a.key.split(".").pop();
      const types: Record<string, string> = { jpg: "image/jpeg", png: "image/png", md: "text/markdown", json: "application/json", pdf: "application/pdf", mp4: "video/mp4", csv: "text/csv" };
      return { key: a.key, size: o?.size ?? 0, contentType: types[ext] ?? "application/octet-stream", modified: o?.modified ?? null, etag: o?.etag ?? null, storageClass: "STANDARD", metadata: ext === "jpg" ? { "uploaded-by": "demo", camera: "X100VI" } : {} };
    }
    case "set_permissions": {
      await sleep(300);
      const items = a.items as { key: string; isDir: boolean; mode: number | null }[];
      const keys: { key: string; isDir: boolean }[] = [];
      for (const it of items) {
        if (!a.recurse || (a.recurse === "files" ? !it.isDir : a.recurse === "folders" ? it.isDir : true)) keys.push(it);
        if (a.recurse && it.isDir) {
          // what is inside, links not followed (the demo tree's keys below the folder)
          const real = realKey(a.profileId, it.key);
          for (const [pre, d] of Object.entries(tree)) {
            if (!pre.startsWith(real)) continue;
            if (a.recurse !== "folders") keys.push(...d.objects.map((o) => ({ key: o.key, isDir: false })));
            if (a.recurse !== "files") keys.push(...d.folders.map((f) => ({ key: f, isDir: true })));
          }
        }
      }
      let done = 0;
      for (const k of keys) {
        const key = realKey(a.profileId, k.key);
        mockModes.set(`${a.profileId}\u0000${key}`, (modeOf(a.profileId, key) & ~a.clear) | a.set);
        done++;
        if (done % 400 === 0) {
          await emit("move-progress", { opId: a.opId, phase: "permissions", done, total: keys.length, bytes: 0, totalBytes: 0 });
          await sleep(60);
        }
      }
      // set window.__chmodRefused = true to have the server refuse (an FTP server without SITE CHMOD)
      if ((window as unknown as { __chmodRefused?: boolean }).__chmodRefused) return { done: 0, total: keys.length, error: "This FTP server doesn't let Kybl change permissions (it has no SITE CHMOD)." };
      return { done, total: keys.length, error: null };
    }
    case "resolve_link": {
      await sleep(120);
      const l = linksOf(a.profileId).find((x) => x.key === a.key);
      if (!l) throw "This connection doesn't support that.";
      if (l.to === null) throw `The original is outside this connection's folder: ${l.target}`;
      const isDir = l.to.endsWith("/");
      if (!isDir && !Object.values(tree).some((d) => d.objects.some((o) => o.key === l.to))) throw "The original isn't there any more: the link is broken.";
      return { key: l.to, size: 0, modified: null, etag: null, storageClass: null };
    }
    case "make_link": {
      await sleep(150);
      const links = linksOf(a.profileId);
      if (links.some((l) => l.key === a.key)) throw "Something with this name is already there.";
      const parent = a.key.slice(0, a.key.lastIndexOf("/") + 1);
      const to = realKey(a.profileId, parent + a.target);
      const isDir = Object.values(tree).some((d) => d.folders.includes(`${to}/`));
      links.push({ key: isDir ? `${a.key}/` : a.key, target: a.target, to: isDir ? `${to}/` : to });
      return null;
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
    case "create_folder": {
      // into its parent folder, in this bucket
      const t = remoteTree(a.profileId, a.bucket);
      const parent = a.prefix.replace(/[^/]+\/$/, "");
      const node = (t[parent] ??= { folders: [], objects: [] });
      if (!node.folders.includes(a.prefix)) node.folders.push(a.prefix);
      t[a.prefix] ??= { folders: [], objects: [] };
      return null;
    }
    case "delete_objects": {
      const t = remoteTree(a.profileId, a.bucket);
      const total = a.keys.length + Object.entries(t).reduce((n, [k, d]) => n + (a.prefixes.some((p: string) => k.startsWith(p)) ? d.objects.length : 0), 0);
      const step = Math.max(1, Math.ceil(total / 12));
      for (let done = 0; done <= total; done += step) {
        if (cancelled.has(a.opId)) return { done, total, error: "Cancelled" };
        await emit("move-progress", { opId: a.opId, phase: "deleting", done, total, bytes: 0, totalBytes: 0 });
        await sleep(250);
      }
      for (const [k, d] of Object.entries(t)) {
        if (a.prefixes.some((p: string) => k.startsWith(p))) delete t[k];
        else {
          d.objects = d.objects.filter((o) => !a.keys.includes(o.key));
          d.folders = d.folders.filter((f) => !a.prefixes.includes(f));
        }
      }
      return { done: total, total, error: null };
    }
    case "move_many": {
      // the real counts and sizes (files as they are, folders by what is in them), so a single
      // file reports one object and its own size; set window.__failMoves = n in the console to
      // have the next n moves or copies stop halfway (to try Retry)
      const src = remoteTree(a.profileId, a.bucket);
      const w = window as unknown as { __failMoves?: number };
      const fail = !!w.__failMoves;
      if (fail) w.__failMoves!--;
      let total = 0;
      let totalBytes = 0;
      for (const it of a.items) {
        if (it.isPrefix) {
          for (const [k, d] of Object.entries(src))
            if (k.startsWith(it.from)) {
              total += d.objects.length;
              totalBytes += d.objects.reduce((s, o) => s + o.size, 0);
            }
        } else {
          const o = src[it.from.slice(0, it.from.lastIndexOf("/") + 1)]?.objects.find((x) => x.key === it.from);
          total += 1;
          totalBytes += o?.size ?? 0;
        }
      }
      total = Math.max(total, 1);
      await emit("move-progress", { opId: a.opId, phase: "listing", done: 0, total: 0, bytes: 0, totalBytes: 0 });
      await sleep(500);
      const step = Math.max(1, Math.ceil(total / 30));
      const stopAt = fail ? Math.floor(total / 2) : total;
      for (let done = 0; done <= stopAt; done += step) {
        if (cancelled.has(a.opId)) return { done, total, error: "Cancelled" };
        await emit("move-progress", { opId: a.opId, phase: "copying", done, total, bytes: Math.round((totalBytes * done) / total), totalBytes });
        await sleep(160);
      }
      const items = fail ? a.items.slice(0, Math.floor(a.items.length / 2)) : a.items;
      for (const it of items) await handle("copy_or_move", { ...it, profileId: a.profileId, bucket: a.bucket, destBucket: a.destBucket, deleteSource: a.deleteSource });
      if (fail) return { done: stopAt, total, error: "The connection dropped (a made-up failure from the mock)." };
      return { done: total, total, error: null };
    }
    case "copy_or_move": {
      await sleep(150);
      // within the bucket, or into another bucket of the connection (move_many's destBucket)
      const tree = remoteTree(a.profileId, a.bucket);
      const into = remoteTree(a.profileId, a.destBucket ?? a.bucket);
      const dirOf = (k: string) => k.slice(0, k.replace(/\/$/, "").lastIndexOf("/") + 1);
      const ensure = (d: string) => (into[d] ??= { folders: [], objects: [] });
      if (a.isPrefix) {
        if (into === tree && a.to.startsWith(a.from)) throw "Cannot copy a folder into itself";
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
      return (a.paths as string[]).map((p, i) => {
        const size = 4_000_000 * (i + 1) * 7;
        localSizes.set(p, size);
        return { path: p, rel: p.split("/").pop(), size };
      });
    case "stream_files_under": {
      const t = remoteTree(a.profileId, a.bucket);
      const files = Object.entries(t).flatMap(([k, d]) => (k.startsWith(a.prefix) ? d.objects.map((o) => ({ key: o.key, size: o.size })) : []));
      // a slow server: the files come in a few batches
      for (let i = 0; i < files.length; i += 3) {
        await new Promise((ok) => setTimeout(ok, 150));
        if (cancelled.delete(a.opId)) throw "Cancelled";
        (a.onBatch as { onmessage: (f: unknown) => void }).onmessage(files.slice(i, i + 3));
      }
      return files.length;
    }
    case "list_all_under": {
      const t = remoteTree(a.profileId, a.bucket);
      return Object.entries(t).flatMap(([k, d]) => (k.startsWith(a.prefix) ? d.objects.map((o) => ({ key: o.key, size: o.size })) : []));
    }
    case "start_upload": {
      // the file's own size, and once it is up it shows in the folder it went to
      const size = localSizes.get(a.localPath) ?? 28_000_000 + Math.random() * 90_000_000;
      void simulateTransfer(a.id, size, ++uploadCount % 4 === 0).then((ok) => {
        if (!ok) return;
        const t = remoteTree(a.profileId, a.bucket);
        const dir = a.key.slice(0, a.key.lastIndexOf("/") + 1);
        const node = (t[dir] ??= { folders: [], objects: [] });
        node.objects = node.objects.filter((o) => o.key !== a.key).concat({ key: a.key, size: Math.round(size), modified: Date.now(), etag: null, storageClass: "STANDARD" });
        // the folders on the way there exist too
        for (let d = dir; d; ) {
          const up = d.slice(0, d.replace(/\/$/, "").lastIndexOf("/") + 1);
          const p = (t[up] ??= { folders: [], objects: [] });
          if (!p.folders.includes(d)) p.folders.push(d);
          d = up;
        }
      });
      return null;
    }
    case "start_download":
      simulateTransfer(a.id, 18_000_000 + Math.random() * 60_000_000);
      return a.destPath;
    case "existing_local_paths":
      // a few well-known names are "already there", so the clash dialog can be tried in the mock
      return (a.paths as string[]).filter((p) => /[/\\](report|photo)[^/\\]*$/.test(p));
    case "existing_keys": {
      // per bucket, like the real backend: media-prod's folders don't exist in an empty bucket
      const t = remoteTree(a.profileId, a.bucket);
      const all = new Set(Object.values(t).flatMap((n) => n.objects.map((o) => o.key)));
      const dirs = new Set(Object.values(t).flatMap((n) => n.folders));
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
    // "Open with ▸": a few apps per type, the default first
    case "apps_for": {
      await sleep(250);
      const ext = a.folder ? "/" : (/\.([^./]+)$/.exec(a.name)?.[1] ?? "").toLowerCase();
      const pick = (names: string[], def: string) => [def, ...names.filter((n) => n !== def).sort((x, y) => x.localeCompare(y))].map((n) => mockApp(n, n === def));
      if (ext === "/") return pick(["Visual Studio Code", "Cursor", "Zed", "Sublime Text", "Terminal", "iTerm"], "Finder");
      if (/^(jpe?g|png|gif|heic|webp|tiff?)$/.test(ext)) return pick(["Photos", "Pixelmator Pro", "Affinity Photo", "Google Chrome"], "Preview");
      if (/^(mov|mp4|m4v|mkv)$/.test(ext)) return pick(["VLC", "IINA", "DaVinci Resolve"], "QuickTime Player");
      if (ext === "pdf") return pick(["Google Chrome", "Safari", "PDF Expert"], "Preview");
      if (ext === "") return [];
      return pick(["Visual Studio Code", "Cursor", "Zed", "Sublime Text", "BBEdit"], "TextEdit");
    }
    case "open_with":
    case "open_with_chooser":
      console.info("[mock]", cmd, a);
      return null;
    case "temp_folder":
      return "/tmp/kybl";
    // no system drag in a browser: drags stay inside the page
    case "start_drag_out":
      throw "Dragging to other apps needs the app";
    case "drag_out_done":
      return null;
    case "write_temp_file":
      return `/tmp/kybl/capture-${Date.now()}.jpg`;
    case "open_local":
    case "reveal_local":
    case "share_files":
    case "share_text":
    case "save_to_photos":
    case "haptic":
    case "set_privacy_screen":
    case "set_unsaved_documents":
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
      keptAt.delete(a.id);
      return null;
    case "pause_transfer":
      if (runningIds.has(a.id)) pausing.add(a.id);
      return null;
    case "pause_all_transfers":
      for (const id of runningIds) pausing.add(id);
      return runningIds.size;
    case "move_transfer_to_top":
      return runningIds.has(a.id);
    case "kept_transfers":
      // ?kept: one download paused in an earlier run, to carry on
      if (!location.search.includes("kept")) return [];
      keptAt.set("kept-1", { bytes: 41_000_000, total: 96_000_000 });
      return [
        {
          id: "kept-1",
          kind: "download",
          name: "drone-footage-4k.mov",
          profileId: "p1",
          bucket: "media-prod",
          key: "video/drone-footage-4k.mov",
          local: "/Users/demo/Downloads/drone-footage-4k.mov",
          requested: "/Users/demo/Downloads/drone-footage-4k.mov",
          overwrite: false,
          bytes: 41_000_000,
          total: 96_000_000,
          state: "paused",
          error: null,
        },
      ];
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
    // WP-E1: two-way sync
    case "sync_conflicts":
      return syncConflicts[a.id] ?? [];
    case "sync_resolve_conflict": {
      syncConflicts[a.id] = (syncConflicts[a.id] ?? []).filter((c) => c.copy !== a.copy);
      await pushStatus(a.id, { conflicts: syncConflicts[a.id].length });
      return null;
    }
    case "sync_pending":
      return syncPending[a.id] ?? [];
    case "sync_confirm_deletes": {
      // like the backend: only the exact list the user saw is confirmed
      const key = (i: { path: string; side: string }) => `${i.side}:${i.path}`;
      const held = new Set((syncPending[a.id] ?? []).map(key));
      const seen = new Set(((a.items ?? []) as { path: string; side: string }[]).map(key));
      if (held.size === 0 || held.size !== seen.size || [...held].some((k) => !seen.has(k))) {
        throw "The list of files changed since you looked. Check it again, then confirm.";
      }
      const n = syncPending[a.id].length;
      syncPending[a.id] = [];
      await pushStatus(a.id, { pendingDeletes: 0, state: "idle", error: null, lastSync: Date.now(), summary: `${n} deleted` });
      return null;
    }
    case "sync_restore_deletes": {
      const n = syncPending[a.id]?.length ?? 0;
      syncPending[a.id] = [];
      await pushStatus(a.id, { pendingDeletes: 0, state: "idle", error: null, lastSync: Date.now(), summary: `${n} files kept` });
      return null;
    }
    case "sync_keep_offline": {
      const found = syncMappings.find((x) => x.profileId === a.profileId && x.bucket === a.bucket && x.prefix === a.prefix);
      if (found) return found;
      const name = profiles.find((x) => x.id === a.profileId)?.name ?? "Connection";
      const parts = [name, a.bucket, ...String(a.prefix).split("/")].filter(Boolean);
      const m: MockMapping = { id: `s${Date.now()}`, profileId: a.profileId, bucket: a.bucket, prefix: a.prefix, localPath: a.localPath ?? `/Users/demo/Kybl/${parts.join("/")}`, direction: "twoway", ignore: [".DS_Store"], mirrorDeletes: true, intervalMins: 5, paused: false, remoteTrash: true, deleteGuard: true };
      syncMappings.push(m);
      setTimeout(() => simulateSync(m.id), 600);
      return m;
    }
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
    case "cache_usage":
      return { thumbnails: 48_200_000, files: 312_500_000, inUse: 4_100_000 };
    case "clear_caches":
      return 360_700_000;
    // photo placeholders: two in three demo photos are known on this device, the rest come from
    // their metadata (a HEAD) after a moment, so both paths show
    case "placeholders_lookup":
      await sleep(30);
      return (a.items as { key: string }[]).map((it) => (/\.(jpe?g|png)$/i.test(it.key) && Math.abs(hash(it.key)) % 3 !== 0 ? mockThumbhash(it.key) : null));
    case "placeholder_head":
      await sleep(250 + Math.random() * 400);
      return /\.(jpe?g|png)$/i.test(a.key) ? mockThumbhash(a.key) : null;
    case "placeholders_folder":
      return {};
    case "placeholders_folder_save":
    case "placeholder_from_thumbnail":
      return null;
    case "picked_files":
      return (a.uris as string[]).map((p, i) => ({ path: p, name: p.split("/").pop(), size: 3_000_000 * (i + 1) }));
    case "download_folder":
      return "/storage/emulated/0/Download/Kybl";
    case "plugin:dialog|open":
      // "Open with ▸ Other…" picks an app
      if (a?.options?.filters?.[0]?.extensions?.includes("app")) return "/Applications/Xcode.app";
      // "Import connections ▸ Choose file…"
      if (a?.options?.filters?.[0]?.extensions?.includes("xml")) return "/Users/demo/Downloads/FileZilla export.xml";
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


/** A second of a soft tone as a WAV data URL, so audio on the media: scheme plays in the mock. */
let toneUrl: string | null = null;
function tone(): string {
  if (toneUrl) return toneUrl;
  const rate = 22050;
  const n = rate;
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  buf.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  str(36, "data");
  buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 440) * 6000 * (1 - i / n), true);
  toneUrl = URL.createObjectURL(new Blob([buf.buffer], { type: "audio/wav" }));
  return toneUrl;
}

// thumbnails (`thumb:`) and media of connections without share links (`media:`) are plain URLs
// in the app; here images are made up, audio is a short tone, and video has nothing to play (like
// the made-up presigned links of the S3 connections)
(window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string, protocol?: string) => string } }).__TAURI_INTERNALS__.convertFileSrc = (
  path: string,
  protocol?: string,
) => {
  const key = path.split("\n").slice(4).join("\n");
  if (protocol === "media" && /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(key)) return tone();
  if (protocol === "media" && !/\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(key)) return `media://localhost/${encodeURIComponent(path)}`;
  return thumbFor(key);
};


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

// ---------------------------------------------------------------- WP-D: documents (src/viewers)
// doc_save sends raw bytes plus headers, and mockIPC drops the headers, so these two commands are
// answered before the mock: sample files of every viewer kind, saves kept in memory.
{
  type Invoke = (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
  const mocked = internals.invoke;
  internals.invoke = async (cmd, args, options) => {
    if (cmd !== "doc_open" && cmd !== "doc_save") return mocked(cmd, args, options);
    // the made-up texts content search finds (src/browser/dev/devDevtools.ts)
    const own = cmd === "doc_open" ? mockDocOpen((args as { path: string }).path) : undefined;
    if (own) return own;
    const { handleDoc } = await import("../viewers/dev/devSamples");
    return handleDoc(cmd, args, options);
  };
}

// ---------------------------------------------------------------- editing in another app (src/edit)
// edit_* stand in for files/edit.rs; the console plays the other app (see src/edit/dev/devEditMock.ts)
{
  type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
  const next = internals.invoke;
  internals.invoke = async (cmd, args, options) => {
    if (!cmd.startsWith("edit_")) return next(cmd, args, options);
    const { handleEdit } = await import("../edit/dev/devEditMock");
    return handleEdit(cmd, (args ?? {}) as Record<string, unknown>);
  };
}

// ---------------------------------------------------------------- WP-A2: cloud drive sign-in
// oauth_start "signs in" after a moment and adds a connection with a made-up drive; Google
// Drive, OneDrive and Dropbox connections answer the browse commands from the trees below.
// In the console: __kyblExpire("<profile id>") sends `connection-auth` (Reconnect).
{
  type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  type Tree = Record<string, Record<string, { folders: string[]; objects: ObjInfo[] }>>;
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
  const next = internals.invoke;
  const cloudKinds = ["gdrive", "onedrive", "dropbox"];
  const accounts: Record<string, { label: string; email: string }> = {
    gdrive: { label: "Google Drive", email: "demo@gmail.com" },
    onedrive: { label: "OneDrive", email: "demo@outlook.com" },
    dropbox: { label: "Dropbox", email: "demo@example.com" },
  };
  const file = (key: string, size: number, ageHours: number, extra: Partial<ObjInfo> = {}): ObjInfo => ({
    ...obj(key, size, ageHours),
    storageClass: null,
    id: `id-${Math.abs(hash(key)).toString(36)}`,
    ...extra,
  });
  const gdoc = (key: string, kind: "document" | "spreadsheet" | "presentation"): ObjInfo => {
    const office = { document: ["docx", "Word document"], spreadsheet: ["xlsx", "Excel workbook"], presentation: ["pptx", "PowerPoint presentation"] }[kind];
    return file(key, 0, 20, {
      etag: "v12",
      mime: `application/vnd.google-apps.${kind}`,
      native: { exports: [{ mime: "application/octet-stream", ext: office[0], label: office[1] }, { mime: "application/pdf", ext: "pdf", label: "PDF" }] },
    });
  };
  const trees: Record<string, Tree> = {
    gdrive: {
      root: {
        "": {
          folders: ["Photos/", "Work/"],
          objects: [gdoc("Trip plan", "document"), gdoc("Budget 2026", "spreadsheet"), file("report.pdf", 820_000, 50), file("report (2).pdf", 790_000, 30), file("notes.txt", 1_400, 4)],
        },
        "Photos/": { folders: [], objects: [file("Photos/beach.jpg", 3_200_000, 70), file("Photos/hanoi.jpg", 2_600_000, 90)] },
        "Work/": { folders: [], objects: [gdoc("Work/Pitch", "presentation"), file("Work/contract.docx", 64_000, 300)] },
      },
      "0ATEAM": { "": { folders: ["Brand/"], objects: [file("logo.svg", 12_000, 400)] }, "Brand/": { folders: [], objects: [file("Brand/colors.pdf", 210_000, 500)] } },
      "shared-with-me": { "": { folders: ["From Sam/"], objects: [file("menu.pdf", 140_000, 12)] }, "From Sam/": { folders: [], objects: [file("From Sam/video.mp4", 48_000_000, 6)] } },
    },
    onedrive: {
      me: {
        "": { folders: ["Documents/", "Pictures/"], objects: [file("Book.xlsx", 22_000, 3)] },
        "Documents/": { folders: [], objects: [file("Documents/cv.docx", 40_000, 200)] },
        "Pictures/": { folders: [], objects: [file("Pictures/cat.jpg", 1_900_000, 30)] },
      },
      "shared-with-me": { "": { folders: [], objects: [file("Shared deck.pptx", 3_000_000, 40)] } },
    },
    dropbox: {
      "": {
        "": { folders: ["Camera Uploads/"], objects: [file("Getting Started.pdf", 1_100_000, 900)] },
        "Camera Uploads/": { folders: [], objects: [file("Camera Uploads/2026-11-20 09.12.44.jpg", 2_400_000, 48)] },
      },
    },
  };
  const roots: Record<string, RootInfo[]> = {
    gdrive: [
      { id: "root", name: "My Drive", kind: "drive", created: null, readOnly: false },
      { id: "0ATEAM", name: "Team", kind: "drive", created: null, readOnly: false },
      { id: "shared-with-me", name: "Shared with me", kind: "shared", created: null, readOnly: true },
    ],
    onedrive: [
      { id: "me", name: "OneDrive", kind: "drive", created: null, readOnly: false },
      { id: "shared-with-me", name: "Shared with me", kind: "shared", created: null, readOnly: true },
    ],
    dropbox: [{ id: "", name: "Dropbox", kind: "folder", created: null, readOnly: false }],
  };
  const cloudCaps = (kind: string): Capabilities => ({
    ...S3_CAPS,
    roots: kind === "dropbox" ? "single" : "drives",
    createRoot: false,
    folders: "real",
    rename: "native",
    serverCopy: kind === "gdrive" ? "cross-root" : "same-root",
    share: kind === "gdrive" ? "none" : "link",
    shareExpiry: kind !== "gdrive",
    streaming: kind === "gdrive" ? "proxy" : "presign",
    rangeRead: true,
    conditionalWrite: kind === "gdrive" ? "compare" : kind === "onedrive" ? "if-match" : "rev",
    hashes: [kind === "gdrive" ? "md5" : kind === "onedrive" ? "quickxor" : "dropbox"],
    thumbnails: "local+remote",
    metadata: "none",
    tags: false,
    storageClass: false,
    trash: true,
    changes: true,
    multipart: true,
    maxObjectSize: null,
    backgroundUpload: false,
    localPaths: false,
  });
  const kindOf = (profileId: unknown) => {
    const k = profiles.find((p) => p.id === profileId)?.kind;
    return k && cloudKinds.includes(k) ? k : null;
  };
  // moves, copies, uploads and finished jobs (the generic handlers) write into these trees too
  cloudTree = (profileId, bucket) => {
    const k = kindOf(profileId);
    return k ? (trees[k][bucket] ??= { "": { folders: [], objects: [] } }) : undefined;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCloud = async (cmd: string, a: any): Promise<unknown> => {
    switch (cmd) {
      case "oauth_builtin_clients":
        // Dropbox shows the "Needs your own client ID" state
        return { gdrive: true, onedrive: true, dropbox: false };
      case "oauth_cancel":
        cancelled.add(a.flowId);
        return null;
      case "oauth_start": {
        for (let i = 0; i < 12; i++) {
          await sleep(200);
          if (cancelled.has(a.flowId)) throw "Cancelled";
        }
        if (a.kind === "dropbox" && !a.client?.clientId) throw "This version of Kybl has no built-in Dropbox sign-in. Add your own OAuth client ID under Advanced.";
        const acct = accounts[a.kind];
        const old = profiles.find((p) => p.id === a.replaceId);
        const p: Profile = {
          id: a.replaceId ?? `c${Date.now()}`,
          name: old?.name ?? `${acct.label} (${acct.email})`,
          kind: a.kind,
          provider: a.kind,
          endpoint: "",
          region: "",
          accessKeyId: "",
          bucket: null,
          pathStyle: false,
          cloud: { accountEmail: acct.email, accountId: `acct-${a.kind}`, clientId: a.client?.clientId ?? null, tenant: a.client?.tenant ?? null, scopes: [] },
        };
        const i = profiles.findIndex((x) => x.id === p.id);
        if (i >= 0) profiles[i] = p;
        else profiles.push(p);
        return p;
      }
    }
    const kind = kindOf(a?.profileId);
    if (!kind) return undefined;
    const dirs = trees[kind][a.bucket] ?? {};
    switch (cmd) {
      case "list_roots":
        await sleep(150);
        return roots[kind];
      case "connection_capabilities":
        return cloudCaps(kind);
      case "list_buckets":
        return roots[kind].map((r) => ({ name: r.id, created: null }));
      case "list_objects": {
        await sleep(250);
        const d = dirs[a.prefix] ?? { folders: [], objects: [] };
        return { folders: d.folders, objects: d.objects, nextToken: null };
      }
      case "head_object": {
        const o = Object.values(dirs).flatMap((d) => d.objects).find((x) => x.key === a.key);
        if (!o) throw "This file or folder isn't there any more. It may have been moved or deleted.";
        return { key: a.key, size: o.size, contentType: o.mime ?? null, modified: o.modified, etag: o.etag, storageClass: null, metadata: {} };
      }
      case "presign_get":
        if (kind === "gdrive") throw "This connection doesn't support that.";
        return `https://example.com/${kind}/temporary/${encodeURIComponent(a.key)}`;
      case "update_object_props":
      case "get_object_tags":
      case "put_object_tags":
        throw "This connection doesn't support that.";
      case "create_folder":
        (dirs[""] ??= { folders: [], objects: [] }).folders.push(a.prefix.endsWith("/") ? a.prefix : `${a.prefix}/`);
        return null;
      case "folder_size": {
        const all = Object.entries(dirs).filter(([k]) => k.startsWith(a.prefix)).flatMap(([, n]) => n.objects);
        return { bytes: all.reduce((s, o) => s + o.size, 0), objects: all.length, children: [] };
      }
      default:
        return undefined;
    }
  };
  internals.invoke = async (cmd, args, options) => {
    const r = await handleCloud(cmd, args && typeof args === "object" && !(args instanceof Uint8Array) ? args : {});
    return r === undefined ? next(cmd, args, options) : r;
  };
  (window as unknown as { __kyblExpire: (id: string) => Promise<void> }).__kyblExpire = (profileId: string) => emit("connection-auth", { profileId });
}

// ---------------------------------------------------------------- WP-E4: drives
// Two made-up drives (one mounted, one uploading saves that finish in about half a minute); mounting
// "works" after a moment. `?nodrives` starts with none, for the empty state.
{
  type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  type Mount = import("../core/api").MountInfo;
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
  const next = internals.invoke;
  const base = (over: Partial<Mount>): Mount => ({
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    profileId: "p1",
    bucket: "media-prod",
    prefix: "",
    name: "media-prod",
    readOnly: false,
    state: "mounted",
    error: null,
    mountPoint: null,
    uploading: 0,
    uploadBytes: 0,
    uploadSent: 0,
    uploadError: null,
    notice: null,
    cacheBytes: 0,
    ...over,
  });
  const point = (name: string) => `/Users/demo/Library/Application Support/app.kybl.desktop/Mounts/${name}`;
  const mounts: Mount[] = new URLSearchParams(location.search).has("nodrives")
    ? []
    : [
        base({ id: "m-photos", prefix: "photos/", name: "photos", mountPoint: point("photos"), cacheBytes: 412_000_000 }),
        base({
          id: "m-backups",
          profileId: "p2",
          bucket: "backups",
          name: "backups",
          mountPoint: point("backups"),
          uploading: 2,
          uploadBytes: 48_000_000,
          uploadSent: 9_000_000,
          notice: "“budget.xlsx” changed on the server while you edited it, so your version was saved as “budget (conflict 2026-11-22 19.30).xlsx”.",
        }),
        // the sidebar's drive marks: a mounted bucket, a mounted one-root server, one that failed
        base({ id: "m-static", bucket: "static-assets", name: "static-assets", mountPoint: point("static-assets") }),
        base({ id: "m-site", profileId: "n1", bucket: "", name: "Web server", mountPoint: point("Web server") }),
        base({
          id: "m-minio",
          profileId: "p3",
          bucket: "",
          name: "Local MinIO",
          state: "error",
          error: "The system couldn't mount the drive.\n\nmount_webdav: exited with 1",
        }),
      ];
  const changed = (m: Mount) => emit("mount-status", m);
  // the uploading drive finishes in a few seconds
  const tick = setInterval(() => {
    const m = mounts.find((x) => x.uploading > 0);
    if (!m) return clearInterval(tick);
    m.uploadSent = Math.min(m.uploadBytes, m.uploadSent + 1_500_000);
    if (m.uploadSent >= m.uploadBytes) Object.assign(m, { uploading: 0, uploadBytes: 0, uploadSent: 0 });
    changed({ ...m });
  }, 1000);
  const find = (id: string) => {
    const m = mounts.find((x) => x.id === id);
    if (!m) throw "This drive isn't there any more.";
    return m;
  };
  const handle = async (cmd: string, a: Record<string, string>): Promise<unknown> => {
    switch (cmd) {
      case "mount_list":
        return mounts.map((m) => ({ ...m }));
      case "mount_add": {
        const prefix = a.prefix ? `${a.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
        if (mounts.some((m) => m.profileId === a.profileId && m.bucket === a.bucket && m.prefix === prefix)) throw "This is already a drive.";
        const name = a.name || prefix.replace(/\/$/, "").split("/").pop() || a.bucket || "Kybl";
        const m = base({ profileId: a.profileId, bucket: a.bucket, prefix, name, state: "mounting" });
        mounts.push(m);
        changed({ ...m });
        await new Promise((ok) => setTimeout(ok, 700));
        Object.assign(m, { state: "mounted", mountPoint: point(name) });
        changed({ ...m });
        return { ...m };
      }
      case "mount_remove": {
        const m = find(a.id);
        if (m.uploading > 0) throw `${m.uploading} files from this drive are still uploading. Remove the drive once they're done.`;
        mounts.splice(mounts.indexOf(m), 1);
        changed({ ...m, state: "removed" });
        return null;
      }
      case "mount_reveal":
        find(a.id);
        return null;
      case "mount_retry": {
        const m = Object.assign(find(a.id), { state: "mounted", error: null });
        m.mountPoint = point(m.name);
        changed({ ...m });
        return { ...m };
      }
      case "mount_eject": {
        const m = Object.assign(find(a.id), { state: "unmounted", mountPoint: null });
        changed({ ...m });
        return { ...m };
      }
      case "mount_dismiss": {
        const m = Object.assign(find(a.id), { notice: null });
        changed({ ...m });
        return null;
      }
      default:
        return undefined;
    }
  };
  internals.invoke = async (cmd, args, options) => {
    if (!cmd.startsWith("mount_")) return next(cmd, args, options);
    return handle(cmd, (args ?? {}) as Record<string, string>);
  };
}

// ---------------------------------------------------------------- archives and the text diff (src/archive)
installArchiveMock(localTree);
