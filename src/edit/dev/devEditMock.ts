/**
 * Browser dev mode only (loaded by devMock.ts): a pretend edit.rs. The "server" is the viewers'
 * pretend `doc_open` / `doc_save` (devSamples.ts), so Kybl's own editor and the other-app flow
 * see the same files. There is no other app in a browser, so the console stands in for it:
 *
 *   __kyblEditSave("notes.md")             the other app saves the file (adds a line)
 *   __kyblServerChange("notes.md")         someone changes it on the server meanwhile
 *   __kyblServerDelete("notes.md")         …or deletes it there
 *   __kyblEditFailNext()                   the next upload fails (a dropped connection)
 *   __kyblEditSessions()                   what is being edited
 */
import { emit } from "@tauri-apps/api/event";
import type { DocMeta } from "../../core/api";
import type { EditSession, SaveRule } from "../lib/editStore";

type Mock = { s: EditSession; known: DocMeta; synced: string; local: string };
const sessions = new Map<string, Mock>();
let failNext = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (t: string) => new TextEncoder().encode(t);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function doc(cmd: "doc_open" | "doc_save", args: unknown, headers?: Record<string, string>): Promise<unknown> {
  const { handleDoc } = await import("../../viewers/dev/devSamples");
  return handleDoc(cmd, args, headers ? { headers } : undefined);
}

async function serverRead(path: string): Promise<{ meta: DocMeta; text: string }> {
  const raw = (await doc("doc_open", { path, maxBytes: 100_000_000 })) as ArrayBuffer | Uint8Array;
  const body = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const len = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
  const meta = JSON.parse(dec(body.slice(4, 4 + len))) as DocMeta;
  return { meta, text: dec(body.slice(4 + len)) };
}

async function serverWrite(path: string, text: string, expect: object): Promise<DocMeta> {
  return (await doc("doc_save", enc(text), { "x-kybl-path": encodeURIComponent(path), "x-kybl-expect": encodeURIComponent(JSON.stringify(expect)) })) as DocMeta;
}

const tell = (m: Mock) => emit("edit", { id: m.s.id, session: { ...m.s } });
const set = (m: Mock, patch: Partial<EditSession>) => {
  m.s = { ...m.s, ...patch };
  return tell(m);
};

function find(nameOrId?: string): Mock | undefined {
  const all = [...sessions.values()];
  if (!nameOrId) return all[all.length - 1];
  return sessions.get(nameOrId) ?? all.find((m) => m.s.name === nameOrId || m.s.key === nameOrId);
}

const edited = (key: string, n: number) => {
  const slash = key.lastIndexOf("/") + 1;
  const name = key.slice(slash);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${key.slice(0, slash)}${stem} (edited${n > 1 ? ` ${n}` : ""})${ext}`;
};

/** One upload attempt, settling like edit.rs's `settle`. */
async function upload(m: Mock, expect: object, to?: string) {
  const text = m.local;
  await set(m, { phase: "uploading", pending: true, error: null, uploadId: crypto.randomUUID(), uploadSize: enc(text).length });
  await sleep(600);
  try {
    if (failNext) {
      failNext = false;
      throw "The connection dropped. Check your network and try again.\n\nio error: connection reset by peer";
    }
    const meta = await serverWrite(to ?? m.s.key, text, expect);
    m.known = meta;
    m.synced = text;
    const name = to ? to.slice(to.lastIndexOf("/") + 1) : m.s.name;
    await set(m, { phase: "uploaded", pending: false, server: null, error: null, lastUpload: Date.now(), key: to ?? m.s.key, name });
    return "ok";
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("CONFLICT\n\n")) {
      if (to) return "taken";
      await set(m, { phase: "conflict", pending: true, server: JSON.parse(msg.slice(10)) as DocMeta | null });
      return "conflict";
    }
    await set(m, { phase: "error", pending: true, error: msg });
    return "error";
  }
}

/** A settled save of the local copy (edit.rs `changed` + `decide`). */
async function changed(m: Mock) {
  if (m.local === m.synced) {
    if (m.s.pending) await set(m, { pending: false, ...(m.s.phase === "error" ? { phase: "watching", error: null } : {}) });
    return;
  }
  if (m.s.phase === "conflict") return set(m, { pending: true });
  const expect = m.s.rule === "auto" ? { kind: "any" } : { kind: "match", etag: m.known.etag, size: m.known.size, modified: m.known.modified, version: m.known.version };
  await upload(m, expect);
}

export async function handleEdit(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "edit_start": {
      const [profileId, root, path, rule] = [String(a.profileId), String(a.root), String(a.path), a.rule as SaveRule];
      const had = [...sessions.values()].find((m) => m.s.profileId === profileId && m.s.root === root && m.s.key === path);
      if (had) {
        await set(had, { rule });
        return { ...had.s };
      }
      await sleep(500);
      const { meta, text } = await serverRead(path);
      const id = crypto.randomUUID();
      const name = path.slice(path.lastIndexOf("/") + 1);
      const s: EditSession = {
        id,
        profileId,
        root,
        key: path,
        name,
        local: `/Users/demo/Library/Caches/app.kybl/edit/${profileId}/${id}/${name}`,
        rule,
        phase: "watching",
        error: null,
        server: null,
        lastUpload: null,
        uploadId: null,
        uploadSize: 0,
        pending: false,
      };
      const m: Mock = { s, known: meta, synced: text, local: text };
      sessions.set(id, m);
      await tell(m);
      return { ...s };
    }
    case "edit_list":
      return [...sessions.values()].map((m) => ({ ...m.s }));
    case "edit_stop": {
      const id = String(a.id);
      if (sessions.delete(id)) await emit("edit", { id, session: null });
      return null;
    }
    case "edit_retry": {
      const m = sessions.get(String(a.id));
      if (m) void changed(m);
      return null;
    }
    case "edit_local_text": {
      const m = sessions.get(String(a.id));
      if (!m) throw "That file isn't being edited any more.";
      return m.local;
    }
    case "edit_resolve": {
      const m = sessions.get(String(a.id));
      if (!m) throw "That file isn't being edited any more.";
      if (a.action === "overwrite") await upload(m, { kind: "any" });
      else if (a.action === "keepBoth") {
        for (let n = 1; n <= 50; n++) if ((await upload(m, { kind: "absent", headersFrom: m.s.key }, edited(m.s.key, n))) !== "taken") break;
      } else if (a.action === "reload") {
        const { meta, text } = await serverRead(m.s.key);
        m.known = meta;
        m.synced = text;
        m.local = text;
        await set(m, { phase: "watching", pending: false, server: null, error: null });
      }
      return { ...m.s };
    }
  }
  return undefined;
}

const w = window as unknown as Record<string, unknown>;
w.__kyblEditSave = async (nameOrId?: string, text?: string) => {
  const m = find(nameOrId);
  if (!m) return "nothing is being edited";
  m.local = text ?? `${m.local}\n// edited in another app at ${new Date().toLocaleTimeString()}`;
  await sleep(300); // the watcher's debounce
  await changed(m);
  return m.s.phase;
};
w.__kyblServerChange = async (nameOrId?: string) => {
  const m = find(nameOrId);
  if (!m) return "nothing is being edited";
  const { text } = await serverRead(m.s.key);
  await serverWrite(m.s.key, `${text}\n// changed on the server by someone else`, { kind: "any" });
  return "changed";
};
w.__kyblServerDelete = async (nameOrId?: string) => {
  const m = find(nameOrId);
  if (!m) return "nothing is being edited";
  (await import("../../viewers/dev/devSamples")).remove(m.s.key);
  return "deleted";
};
w.__kyblEditFailNext = () => {
  failNext = true;
  return "the next upload fails";
};
w.__kyblEditSessions = () => [...sessions.values()].map((m) => ({ ...m.s, local: m.local.length + " chars" }));
