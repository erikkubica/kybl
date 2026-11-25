/**
 * Browser dev mode only (installed by devMock.ts): a pretend archive backend. "site-backup.zip"
 * in Downloads opens like a folder, Extract and Compress run as transfer rows and leave their
 * results in the mock's local tree, and two YAML files in Documents give the diff viewer
 * something to compare.
 */
import { emit } from "@tauri-apps/api/event";
import type { ObjInfo } from "../core/types";
import type { Capabilities } from "../core/api";
import { S3_CAPS } from "../core/useCaps";
import { archiveId, archiveOrigin, archiveStem, isArchiveId } from "./archive";

type Tree = Record<string, Record<string, { folders: string[]; objects: ObjInfo[] }>>;
type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;

const enc = (s: string) => new TextEncoder().encode(s);
const HOUR = 3600_000;

const CONFIG_OLD = `# site config
name: kybl-site
port: 8080
host: 0.0.0.0
log_level: info
features:
  search: true
  comments: false
  newsletter: true
cache:
  ttl: 300
  max_entries: 10000
database:
  url: postgres://db.internal:5432/site
  pool: 10
  timeout: 30s
mail:
  from: hello@example.com
  smtp: smtp.example.com
${Array.from({ length: 40 }, (_, i) => `route_${i}: /page/${i}`).join("\n")}
footer: "© 2025 Kybl"
`;
const CONFIG_NEW = CONFIG_OLD.replace("port: 8080", "port: 9090")
  .replace("log_level: info", "log_level: debug")
  .replace("  comments: false\n", "  comments: true\n  reactions: true\n")
  .replace("  pool: 10\n", "")
  .replace("route_17: /page/17", "route_17: /pages/seventeen")
  .replace('footer: "© 2025 Kybl"', 'footer: "© 2026 Kybl, all rights reserved"');

/** The files inside site-backup.zip (one top folder named like the archive). */
const ARCHIVE_FILES: Record<string, string> = {
  "site-backup/index.html": `<!doctype html>\n<html>\n  <head><title>Kybl</title><link rel="stylesheet" href="css/app.css"></head>\n  <body><h1>Hello from the archive</h1><script src="js/app.js"></script></body>\n</html>\n`,
  "site-backup/README.md": "# Site backup\n\nTaken before the **redesign**.\n\n- index.html\n- css/, js/\n",
  "site-backup/css/app.css": "body { font: 16px system-ui; margin: 0 auto; max-width: 42rem; }\nh1 { color: #2c6bf2; }\n",
  "site-backup/js/app.js": "document.querySelector('h1').addEventListener('click', () => alert('hi'));\n",
  "site-backup/config.yaml": CONFIG_OLD,
  "site-backup/data/export.csv": "id,name,visits\n1,home,1200\n2,about,340\n3,blog,2210\n",
};

function archiveTree(): Tree[string] {
  const t: Tree[string] = { "": { folders: [], objects: [] } };
  const mtime = Date.now() - 48 * HOUR;
  for (const [key, body] of Object.entries(ARCHIVE_FILES)) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i - 1).join("/") + (i > 1 ? "/" : "");
      const dir = parts.slice(0, i).join("/") + "/";
      const node = (t[parent] ??= { folders: [], objects: [] });
      if (!node.folders.includes(dir)) node.folders.push(dir);
      t[dir] ??= { folders: [], objects: [] };
    }
    const parent = key.slice(0, key.lastIndexOf("/") + 1);
    t[parent].objects.push({ key, size: enc(body).length, modified: mtime, etag: `crc-${key.length}`, storageClass: null } as ObjInfo);
  }
  return t;
}

const archiveCaps: Capabilities = {
  ...S3_CAPS,
  roots: "single",
  folders: "real",
  rename: "native",
  serverCopy: "none",
  share: "none",
  shareExpiry: false,
  streaming: "proxy",
  metadata: "none",
  tags: false,
  storageClass: false,
  multipart: false,
  maxObjectSize: null,
  backgroundUpload: false,
  localPaths: false,
};

function frame(bytes: Uint8Array, contentType: string): ArrayBuffer {
  const json = enc(JSON.stringify({ etag: `e${bytes.length}`, size: bytes.length, modified: Date.now() - 5 * HOUR, contentType, version: null }));
  const out = new Uint8Array(4 + json.length + bytes.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(bytes, 4 + json.length);
  return out.buffer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function progress(id: string, total: number, steps = 16) {
  for (let i = 1; i <= steps; i++) {
    await emit("transfer", { id, state: "running", bytes: Math.round((total * i) / steps), total, error: null });
    await sleep(150);
  }
  await emit("transfer", { id, state: "done", bytes: total, total, error: null });
}

export function installArchiveMock(localTree: Tree) {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
  const next = internals.invoke;
  const tree = archiveTree();
  const DOCS = "/Users/demo/Documents";
  const docs = localTree[DOCS][""];
  docs.objects.push(
    { key: "config-old.yaml", size: enc(CONFIG_OLD).length, modified: Date.now() - 30 * HOUR, etag: "c-old", storageClass: null } as ObjInfo,
    { key: "config-new.yaml", size: enc(CONFIG_NEW).length, modified: Date.now() - 2 * HOUR, etag: "c-new", storageClass: null } as ObjInfo,
  );
  localTree["/Users/demo/Downloads"][""].objects.push({ key: "site-backup.zip", size: 482_133, modified: Date.now() - 20 * HOUR, etag: "zip-1", storageClass: null } as ObjInfo);

  const addLocal = (root: string, dir: string, o: { key: string; size: number } | { folder: string }) => {
    const t = (localTree[root] ??= { "": { folders: [], objects: [] } });
    const node = (t[dir] ??= { folders: [], objects: [] });
    if ("folder" in o) {
      if (!node.folders.includes(o.folder)) node.folders.push(o.folder);
      t[o.folder] ??= { folders: [], objects: [] };
    } else node.objects = node.objects.filter((x) => x.key !== o.key).concat({ key: o.key, size: o.size, modified: Date.now(), etag: `n${Date.now()}`, storageClass: null } as ObjInfo);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals.invoke = async (cmd: string, args?: any, options?: unknown) => {
    const a = args ?? {};
    // the two sample files for the diff
    if (cmd === "doc_open" && a.profileId === "local" && (a.path === "config-old.yaml" || a.path === "config-new.yaml")) {
      await sleep(150);
      return frame(enc(a.path === "config-old.yaml" ? CONFIG_OLD : CONFIG_NEW), "text/yaml");
    }
    // names already there, so Extract and Compress meet the conflict dialog
    if (cmd === "existing_keys" && a.profileId === "local" && localTree[a.bucket]) {
      const t = localTree[a.bucket];
      const keys = new Set(Object.values(t).flatMap((n) => n.objects.map((o) => o.key)));
      const dirs = new Set(Object.values(t).flatMap((n) => n.folders));
      return { keys: (a.keys as string[]).filter((k) => keys.has(k)), prefixes: (a.prefixes as string[]).filter((p) => dirs.has(p)) };
    }
    if (cmd === "archive_open") {
      await sleep(300);
      if (!String(a.key).endsWith("site-backup.zip")) throw "This isn't a zip archive Kybl can read. invalid Zip archive: Could not find EOCD";
      const files = Object.keys(ARCHIVE_FILES).length;
      return { id: archiveId({ profileId: a.profileId, root: a.root, key: a.key }), root: "site-backup.zip", format: "zip", files, folders: 4, bytes: 4200, skipped: { unsafePaths: 1, links: 0, encrypted: 0, other: 0 } };
    }
    if (cmd === "archive_extract") {
      const j = a.job;
      void (async () => {
        await progress(a.id, 482_133);
        if (j.destProfileId !== "local") return;
        if (j.folder) addLocal(j.destRoot, j.destDir, { folder: `${j.destDir}${j.folder}/` });
        else for (const p of j.paths ?? []) {
          const name = (j.renames?.[p] ?? p.replace(/\/$/, "").split("/").pop()) as string;
          addLocal(j.destRoot, j.destDir, p.endsWith("/") ? { folder: `${j.destDir}${name}/` } : { key: `${j.destDir}${name}`, size: enc(ARCHIVE_FILES[p] ?? "").length });
        }
      })();
      return null;
    }
    if (cmd === "archive_compress") {
      const j = a.job;
      void (async () => {
        await progress(a.id, 2_400_000);
        if (j.profileId === "local") addLocal(j.root, j.destKey.slice(0, j.destKey.lastIndexOf("/") + 1), { key: j.destKey, size: 812_400 });
      })();
      return null;
    }
    if (!isArchiveId(a.profileId)) return next(cmd, args, options);
    const root = "site-backup.zip";
    switch (cmd) {
      case "connection_capabilities":
        return archiveCaps;
      case "list_roots":
        return [{ id: root, name: root, kind: "folder", created: null, readOnly: true }];
      case "list_buckets":
        return [{ name: root, created: null }];
      case "list_objects": {
        await sleep(60);
        const d = tree[a.prefix] ?? { folders: [], objects: [] };
        return { folders: d.folders, objects: d.objects, nextToken: null };
      }
      case "head_object": {
        const o = Object.values(tree).flatMap((d) => d.objects).find((x) => x.key === a.key);
        if (!o) throw "This file or folder isn't there any more. It may have been moved or deleted.";
        return { key: a.key, size: o.size, contentType: null, modified: o.modified, etag: o.etag, storageClass: null, metadata: {} };
      }
      case "doc_open": {
        const body = ARCHIVE_FILES[a.path];
        if (body === undefined) throw "This file or folder isn't there any more.";
        return frame(enc(body), "text/plain");
      }
      case "existing_keys":
        return { keys: [], prefixes: [] };
      case "folder_size":
      case "list_all_under": {
        const all = Object.entries(tree).filter(([k]) => k.startsWith(a.prefix)).flatMap(([, d]) => d.objects);
        return cmd === "folder_size" ? { bytes: all.reduce((s, o) => s + o.size, 0), objects: all.length, children: [] } : all.map((o) => ({ key: o.key, size: o.size }));
      }
      case "local_path":
        return null;
      case "start_download":
        void progress(a.id, 4000, 4);
        return a.destPath;
      case "create_folder":
      case "delete_objects":
      case "move_many":
      case "copy_or_move":
      case "start_upload":
        throw "Archives open read-only. Extract the files to change them.";
      default: {
        const o = archiveOrigin(a.profileId);
        console.info(`[devArchive] ${cmd} inside ${o?.key ?? "?"} (${archiveStem(root)}) passed on`);
        return next(cmd, args, options);
      }
    }
  };
}
