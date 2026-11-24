/**
 * Dragging items out of the window into another app: Finder, Mail, a chat, an editor. The drag
 * starts as the page's own (useItemDrag.ts, so drops on folders and the other pane work as
 * before); when the pointer leaves the window it is handed to the system's drag
 * (platform/drag_out.rs) with:
 *
 * - items on this computer (this computer's folders, a folder kept by sync) as real files;
 * - small files of other connections as real files too: they start downloading to Kybl's
 *   temporary folder as soon as the pointer nears the window's edge (straight from the file cache
 *   when a preview or Open already fetched that version), and the hand-over waits for them a
 *   moment. Chat apps only take real files, so this is what makes dropping a photo into a chat work;
 * - anything else, on macOS, as a promise: the receiving app (Finder, Mail) says where it wants
 *   the item once it is dropped, and it downloads there like any download (it shows in Activity).
 *   Windows and Linux have no promises here: such items stay behind, and with nothing left the drag
 *   simply stays inside the window.
 */
import { plural } from "../format";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, errMessage } from "../api";
import { asExport } from "../connections/native";
import type { TransferActions } from "../useTransfers";
import type { Entry } from "../types";
import { syncedPath } from "./openWith";
import { joinPath, safeRelPath, shortHash } from "./paths";

export type DragOutContext = {
  profileId: string;
  bucket: string;
  /** the connection's files are this computer's own */
  localPaths: boolean;
  transfers: TransferActions;
  /** opens the Activity panel if Settings say so (a promised item started downloading) */
  autoShowActivity: () => void;
};

const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Files fetched ahead for a drag: each at most this big, and so many / so much in all. */
const FETCH_MAX = 64 * 1024 * 1024;
const FETCH_TOTAL = 256 * 1024 * 1024;
const FETCH_COUNT = 20;
/** How long the hand-over waits for those files once the pointer left the window. */
const WAIT_MS = 1500;
/** Drags whose promised items can still be asked for. */
const KEEP_DRAGS = 32;

type Item = { path: string | null; name: string; folder: boolean };
type TransferItem = Parameters<TransferActions["add"]>[0][number];

// ------------------------------------------------------------ copies fetched ahead

/** Local copies by connection, place, key and version; a failed one is forgotten and tried again. */
const fetched = new Map<string, Promise<string | null>>();
const fetchKey = (c: DragOutContext, e: Entry) => `${c.profileId}\n${c.bucket}\n${e.key}\n${e.etag ?? ""}\n${e.size}`;

/** Downloads a file to the same temporary place Open and Copy use (desktop/fileOps.tsx `localCopy`). */
async function fetchCopy(c: DragOutContext, e: Entry): Promise<string | null> {
  const x = asExport(e);
  if (!x) return null;
  const tmp = await api.tempFolder();
  const local = joinPath(tmp, `${shortHash(`${c.profileId}\n${c.bucket}\n${x.key}`)}/${safeRelPath(x.name) || "file"}`);
  const [t] = c.transfers.add([
    { kind: "download", name: x.name, profileId: c.profileId, bucket: c.bucket, key: x.key, local, total: x.size, overwrite: true, etag: e.native ? undefined : x.etag },
  ]);
  const done = await c.transfers.whenFinished(t.id);
  return done.state === "done" ? done.local : null;
}

// The app removed copies nobody used for long ("Clear cache", the weekly trim): a path remembered
// here may be gone, and handing it over would drop the item, so they are fetched again.
let watching = false;
function watchRemovals() {
  if (watching) return;
  watching = true;
  listen("open-copies-removed", () => fetched.clear()).catch(() => {
    watching = false;
  });
}

/** Starts fetching the small files of `items` that aren't on this computer anyway. */
function warm(c: DragOutContext, items: Entry[]) {
  if (c.localPaths) return;
  watchRemovals();
  let count = 0;
  let total = 0;
  for (const e of items) {
    if (e.kind !== "file" || e.size > FETCH_MAX || syncedPath(c.profileId, c.bucket, e.key)) continue;
    if (count >= FETCH_COUNT || total + e.size > FETCH_TOTAL) break;
    count++;
    total += e.size;
    const k = fetchKey(c, e);
    if (fetched.has(k)) continue;
    const p = fetchCopy(c, e).catch(() => null);
    fetched.set(k, p);
    void p.then((path) => {
      if (!path && fetched.get(k) === p) fetched.delete(k);
    });
  }
}

const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, ms)));

/** What to hand over, item by item, and the entries behind it (by the same index). */
async function plan(c: DragOutContext, items: Entry[], deadline: number): Promise<{ list: Item[]; entries: Entry[] }> {
  const rows = await Promise.all(
    items.map(async (e): Promise<[Item, Entry] | null> => {
      const folder = e.kind === "folder";
      if (c.localPaths) {
        const path = await api.localPath(c.profileId, c.bucket, e.key.replace(/\/+$/, "")).catch(() => null);
        return [{ path, name: e.name, folder }, e];
      }
      // a Google Doc goes as what it downloads as; one with no export can't go at all
      const x = folder ? e : asExport(e);
      if (!x) return null;
      // a synced copy may not be on disk yet: the backend checks, and promises it otherwise
      const synced = syncedPath(c.profileId, c.bucket, e.key);
      const ahead = folder || synced ? undefined : fetched.get(fetchKey(c, e));
      const path = synced ?? (ahead ? await Promise.race([ahead, sleep(deadline - Date.now())]) : null);
      return [{ path, name: x.name, folder }, e];
    }),
  );
  const ok = rows.filter((r): r is [Item, Entry] => r !== null);
  return { list: ok.map((r) => r[0]), entries: ok.map((r) => r[1]) };
}

// ------------------------------------------------------------ promises, written when an app asks

const pending = new Map<string, { c: DragOutContext; entries: Entry[] }>();
/** The system drag under way (its token), if any. */
let current: string | null = null;
let listening = false;

/** A drag of ours is out in the system: a drop back onto Kybl isn't an upload. */
export const isDraggingOut = () => current !== null;

/** Downloads a promised item to the place the receiving app picked. */
async function fulfil(c: DragOutContext, e: Entry, path: string) {
  const items: TransferItem[] = [];
  if (e.kind === "folder") {
    // the backend already made the folder, so an empty one arrives too
    for (const f of await api.listAllUnder(c.profileId, c.bucket, e.key)) {
      const rel = safeRelPath(f.key.slice(e.key.length));
      if (rel) items.push({ kind: "download", name: rel, profileId: c.profileId, bucket: c.bucket, key: f.key, local: joinPath(path, rel), total: f.size, overwrite: true, base: path });
    }
  } else {
    const x = asExport(e);
    if (!x) throw new Error("That item can’t be downloaded");
    // the receiving app chose this file: write exactly there
    items.push({ kind: "download", name: x.name, profileId: c.profileId, bucket: c.bucket, key: x.key, local: path, total: x.size, overwrite: true, etag: e.native ? undefined : x.etag });
  }
  if (!items.length) return;
  const started = c.transfers.add(items);
  c.autoShowActivity();
  const done = await Promise.all(started.map((t) => c.transfers.whenFinished(t.id)));
  const failed = done.filter((t) => t.state !== "done");
  if (failed.length === 1 && done.length === 1) throw new Error(failed[0].error ?? "The download didn’t finish");
  if (failed.length) throw new Error(`${failed.length} of ${plural(done.length, "file")} didn’t download`);
}

function listenOnce() {
  if (listening) return;
  listening = true;
  listen<{ token: string; index: number; path: string }>("drag-out-promise", ({ payload: p }) => {
    const answer = (error: string | null) => void api.dragOutDone(p.token, p.index, error).catch(() => {});
    const d = pending.get(p.token);
    const e = d?.entries[p.index];
    if (!d || !e) return answer("Kybl no longer knows that item");
    fulfil(d.c, e, p.path).then(
      () => answer(null),
      (err) => answer(errMessage(err)),
    );
  }).catch(() => {
    listening = false;
  });
  listen<{ token: string; dropped: boolean }>("drag-out-ended", ({ payload: p }) => {
    if (current === p.token) current = null;
    // dropped nowhere: no app will ask for its promised items
    if (!p.dropped) pending.delete(p.token);
  }).catch(() => {});
}

// ------------------------------------------------------------ the hand-over

export type DragOut = {
  /** the pointer nears the window's edge: start fetching what has to be ready */
  warm: (items: Entry[]) => void;
  /**
   * The pointer left the window with the button down: hands the drag to the system. True when it
   * took it (the page's own drag ends then). `stillOut` says whether the pointer is still outside
   * with the button down, checked again right before handing over.
   */
  start: (items: Entry[], stillOut: () => boolean) => Promise<boolean>;
};

export function makeDragOut(get: () => DragOutContext | null): DragOut {
  // the browser dev mock has no system drag (and shouldn't start downloads for one)
  if (!isTauri()) return { warm: () => {}, start: async () => false };
  return {
    warm: (items) => {
      const c = get();
      if (c) warm(c, items);
    },
    start: async (items, stillOut) => {
      const c = get();
      if (!c || !items.length) return false;
      listenOnce();
      warm(c, items);
      const { list, entries } = await plan(c, items, Date.now() + WAIT_MS);
      // without promises only what is on this computer can go
      if (!list.length || (!MAC && !list.some((x) => x.path)) || !stillOut()) return false;
      const image = await dragImage(items).catch(() => null);
      if (!stillOut()) return false;
      const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      pending.set(token, { c, entries });
      for (const k of pending.keys()) {
        if (pending.size <= KEEP_DRAGS) break;
        pending.delete(k);
      }
      current = token;
      try {
        await api.startDragOut(token, list, image);
        return true;
      } catch {
        // nothing could go, or the button was already up: the page's drag carries on
        pending.delete(token);
        if (current === token) current = null;
        return false;
      }
    },
  };
}

// ------------------------------------------------------------ the picture under the pointer

/** Size of the picture in points; it is drawn at twice that for Retina screens. */
const PT = 72;

/**
 * What the drag shows: the first item's thumbnail, else its icon as the list draws it, with a
 * count when there are several. A PNG data URL, or null (the system's icons are used then).
 */
export async function dragImage(items: Entry[]): Promise<string | null> {
  const first = items[0];
  if (!first) return null;
  const S = PT * 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const sel = `[data-key="${CSS.escape(first.key)}"]`;
  const el = document.querySelector<HTMLElement>(`.card${sel}, .row${sel}`);
  const img = el?.querySelector<HTMLImageElement>("img:not(.ph)") ?? el?.querySelector<HTMLImageElement>("img");
  const badge = items.length > 1;
  // leave the top-right corner to the count
  const box = badge ? { x: 6, y: 22, w: S - 28, h: S - 28 } : { x: 8, y: 8, w: S - 16, h: S - 16 };
  let drew = !!img?.currentSrc && (await drawPhoto(g, img.currentSrc, box));
  if (!drew && el) drew = await drawIcon(g, el, box);
  if (!drew) drawPlain(g, first, box);
  if (badge) drawCount(g, items.length, S);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    // a picture the canvas wasn't allowed to read back
    return null;
  }
}

type Box = { x: number; y: number; w: number; h: number };

function load(src: string, cors: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image();
    // thumbnails come from the app's own thumb:// scheme, which allows reading them back
    if (cors) im.crossOrigin = "anonymous";
    const t = setTimeout(() => resolve(null), 400);
    im.onload = () => {
      clearTimeout(t);
      resolve(im);
    };
    im.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
    im.src = src;
  });
}

function rounded(g: CanvasRenderingContext2D, b: Box, r: number) {
  g.beginPath();
  g.roundRect(b.x, b.y, b.w, b.h, r);
}

async function drawPhoto(g: CanvasRenderingContext2D, src: string, b: Box): Promise<boolean> {
  const im = await load(src, !src.startsWith("data:") && !src.startsWith("blob:"));
  if (!im || !im.naturalWidth) return false;
  // the whole photo, fitted, like Finder's drag picture
  const k = Math.min(b.w / im.naturalWidth, b.h / im.naturalHeight);
  const w = im.naturalWidth * k;
  const h = im.naturalHeight * k;
  const r: Box = { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
  g.save();
  g.shadowColor = "rgba(0,0,0,0.3)";
  g.shadowBlur = 8;
  g.shadowOffsetY = 2;
  rounded(g, r, 10);
  g.fillStyle = "#fff";
  g.fill();
  g.restore();
  g.save();
  rounded(g, { x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 }, 7);
  g.clip();
  g.drawImage(im, r.x + 3, r.y + 3, r.w - 6, r.h - 6);
  g.restore();
  return true;
}

const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "color", "display", "visibility"];

/** An SVG of the page as a standalone image: its look comes from the page's style sheets, so it is copied onto each element. */
function svgImage(svg: SVGSVGElement, w: number, h: number): Promise<HTMLImageElement | null> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const t = to[i] as SVGElement;
    t.removeAttribute("class");
    t.setAttribute("style", STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(w));
  copy.setAttribute("height", String(h));
  const xml = new XMLSerializer().serializeToString(copy);
  return load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, false);
}

/** The item's icon as drawn in the list (the page's SVGs and the extension label), scaled up. */
async function drawIcon(g: CanvasRenderingContext2D, el: HTMLElement, b: Box): Promise<boolean> {
  const ico = el.querySelector<HTMLElement>(".ico");
  if (!ico) return false;
  const r = ico.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const k = Math.min(b.w / r.width, b.h / r.height);
  const ox = b.x + (b.w - r.width * k) / 2;
  const oy = b.y + (b.h - r.height * k) / 2;
  const svgs = [...ico.querySelectorAll<SVGSVGElement>("svg")].filter((s) => !s.parentElement?.closest("svg"));
  let any = false;
  for (const s of svgs) {
    const sr = s.getBoundingClientRect();
    if (sr.width < 1 || sr.height < 1) continue;
    const im = await svgImage(s, sr.width * k, sr.height * k);
    if (!im) continue;
    g.drawImage(im, ox + (sr.left - r.left) * k, oy + (sr.top - r.top) * k, sr.width * k, sr.height * k);
    any = true;
  }
  // the extension label on big document icons is text, not part of the SVG
  for (const t of ico.querySelectorAll<HTMLElement>(".doc-ext")) {
    const tr = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    const x = ox + (tr.left - r.left) * k;
    const y = oy + (tr.top - r.top) * k;
    if (cs.backgroundColor && !/rgba\(.*,\s*0\)|transparent/.test(cs.backgroundColor)) {
      g.fillStyle = cs.backgroundColor;
      rounded(g, { x, y, w: tr.width * k, h: tr.height * k }, (parseFloat(cs.borderTopLeftRadius) || 0) * k);
      g.fill();
    }
    g.fillStyle = cs.color;
    g.font = `${cs.fontWeight} ${(parseFloat(cs.fontSize) || 9) * k}px ${cs.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(t.textContent ?? "", x + (tr.width * k) / 2, y + (tr.height * k) / 2);
  }
  return any;
}

/** A plain sheet or folder with the extension, when the item isn't on screen to copy its icon. */
function drawPlain(g: CanvasRenderingContext2D, e: Entry, b: Box) {
  const accent = getComputedStyle(document.body).getPropertyValue("--accent-solid").trim() || "#4f7cff";
  g.save();
  g.shadowColor = "rgba(0,0,0,0.25)";
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
  if (e.kind === "folder") {
    g.fillStyle = accent;
    rounded(g, { x: b.x, y: b.y + b.h * 0.18, w: b.w, h: b.h * 0.72 }, 12);
    g.fill();
  } else {
    const w = b.h * 0.78;
    rounded(g, { x: b.x + (b.w - w) / 2, y: b.y, w, h: b.h }, 10);
    g.fillStyle = "#fff";
    g.fill();
    g.restore();
    g.save();
    const dot = e.name.lastIndexOf(".");
    const ext = dot > 0 ? e.name.slice(dot + 1, dot + 6).toUpperCase() : "";
    if (ext) {
      g.fillStyle = accent;
      g.font = `600 ${b.h * 0.16}px -apple-system, system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(ext, b.x + b.w / 2, b.y + b.h * 0.62);
    }
  }
  g.restore();
}

/** The red count in the corner, like Finder's. */
function drawCount(g: CanvasRenderingContext2D, n: number, S: number) {
  const text = n > 999 ? "999+" : String(n);
  g.font = `700 26px -apple-system, system-ui, sans-serif`;
  const h = 40;
  const w = Math.max(h, g.measureText(text).width + 22);
  const x = S - w - 2;
  const y = 2;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.3)";
  g.shadowBlur = 4;
  rounded(g, { x, y, w, h }, h / 2);
  g.fillStyle = "#ff3b30";
  g.fill();
  g.restore();
  g.lineWidth = 3;
  g.strokeStyle = "#fff";
  rounded(g, { x, y, w, h }, h / 2);
  g.stroke();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, x + w / 2, y + h / 2 + 1);
}
